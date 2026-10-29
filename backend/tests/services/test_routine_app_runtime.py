"""Routine connected-app grants stay limited to selected read tools/accounts."""
from types import SimpleNamespace

import pytest
from sqlalchemy import delete

from app.core.config import settings
from app.db.models import Agent, Turn
from app.db.models.routine import Routine, RoutineRun, RoutineAppAction
from app.services import agent_store, composio_bridge, composio_service, tool_policy
from app.composio_mcp_server import Server
from app.services.composio_client import ComposioClient
from tests.services.test_composio_bridge import KEY, FakeComposio, fake, world as composio_world  # noqa: F401
from tests.services.thread_harness import owner, sessions  # noqa: F401


def test_exact_tool_filter_offers_only_the_granted_read_tool(tmp_path):
    server = Server(tmp_path, {"github": "read"}, {"github_get_authenticated_user"})
    assert [tool["name"] for tool in server.tools] == ["github_get_authenticated_user"]
    assert server.call("github_list_my_repositories", {})["error"]


@pytest.mark.parametrize("name", ["github_create_issue", "not_a_real_tool"])
def test_routine_policy_denies_ungranted_writes_and_unknown_tools(name):
    run = SimpleNamespace(routine_grants={"github_get_authenticated_user": "ca_1"},
                          ctx=SimpleNamespace(composio_apps={"github": "read"}, team=None))
    assert tool_policy.automatic(composio_bridge.PREFIX + name, "ask", run, {}) == (
        "denied", "routine_action_not_granted"
    )


class _Runtime:
    def __init__(self, sessions):
        self.session = sessions
        self.owner_id = None


@pytest.fixture
async def grant_world(sessions, owner, monkeypatch):
    fake = FakeComposio()
    monkeypatch.setattr(settings, "ROUTINE_CONNECTED_APPS_ENABLED", True)
    monkeypatch.setattr(composio_bridge, "make_client", lambda key: ComposioClient(key, transport=__import__("httpx").MockTransport(fake.handler)))
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=owner, name="Routine reader")
        await agent_store.update_agent(db, agent.id, connector_scopes={"github": "read"})
        await composio_service._save(db, owner, {"api_key": KEY, "user_id": "u1", "session_id": "sess_1"})
        routine = Routine(owner_id=owner, agent_id=agent.id, name="R", prompt="Read", schedule_kind="manual",
                          schedule_spec={}, timezone="UTC", paused=False, run_limit_minutes=30,
                          approval_mode="ask", approval_timeout_minutes=30, catch_up_minutes=60,
                          retry_limit=0, retry_delay_minutes=5,
                          connected_app_grants=[{"tool": "github_get_authenticated_user", "account_id": "ca_1"}])
        db.add(routine)
        await db.commit()
        await db.refresh(routine)
        routine_run = RoutineRun(routine_id=routine.id, trigger="manual", state="running",
                                prompt="Read", thread_id=711)
        db.add(routine_run)
        await db.commit()
        await db.refresh(routine_run)
    runtime = _Runtime(sessions)
    runtime.owner_id = owner
    run = SimpleNamespace(
        ctx=SimpleNamespace(aborted=False, computer=None), routine_grants={"github_get_authenticated_user": "ca_1"},
        routine_id=routine.id, routine_run_id=routine_run.id, thread_id=711,
        agent_id=agent.id, turn_id=1, owner_token="routine-owner",
    )
    run.ctx.approval_mode = "ask"
    # The approval gate is covered elsewhere; keep these focused tests on the
    # additional routine-specific authorization after the one-use approval.
    async def approved(*_args):
        return True
    monkeypatch.setattr("app.team.bridge.consume_allowed_approval", approved)
    bridge = composio_bridge.ComposioBridge(runtime, run, {"github": "read"})
    yield runtime, run, routine, fake, bridge
    await bridge.close()
    async with sessions() as db:
        await db.execute(delete(RoutineAppAction).where(RoutineAppAction.run_id == routine_run.id))
        await db.delete(await db.get(RoutineRun, routine_run.id))
        await db.delete(await db.get(Routine, routine.id))
        await db.delete(await db.get(Agent, agent.id))
        await db.commit()


async def test_routine_read_is_bound_to_the_selected_stable_account_id(grant_world):
    _, _, _, fake, bridge = grant_world
    fake.answer = {"result_type": "completed", "data": {"login": "octo", "name": "Octo"}, "error": None}
    result = await bridge.execute("github_get_authenticated_user", {})
    assert result["result"]["login"] == "octo"
    assert fake.executes[0]["account"] == "ca_1"


@pytest.mark.parametrize("name", ["github_create_issue", "not_a_real_tool"])
async def test_bridge_denies_routine_write_and_unknown_tools_even_if_requested(grant_world, name):
    _, _, _, fake, bridge = grant_world
    result = await bridge.execute(name, {})
    assert result["code"] == "not_allowed"
    assert fake.executes == []


async def test_disconnecting_a_granted_account_does_not_fall_back_to_another_account(grant_world):
    _, _, _, fake, bridge = grant_world
    fake.accounts.append({"id": "ca_2", "toolkit": {"slug": "github"}, "alias": "other",
                          "status": "ACTIVE", "user_id": "u1", "data": {}})
    fake.accounts = [account for account in fake.accounts if account["id"] != "ca_1"]
    result = await bridge.execute("github_get_authenticated_user", {})
    assert result["code"] == "not_connected"
    assert fake.executes == []


async def test_revocation_in_current_definition_overrides_the_run_grant_snapshot(grant_world, sessions):
    _, _, routine, fake, bridge = grant_world
    async with sessions() as db:
        row = await db.get(Routine, routine.id)
        row.connected_app_grants = []
        await db.commit()
    result = await bridge.execute("github_get_authenticated_user", {})
    assert result["code"] == "not_allowed"
    assert fake.executes == []


async def _runtime_mount_context(world, sessions, owner, monkeypatch, *, trigger="manual",
                                 enabled=True, computer=None, scopes=None, grants=None):
    runtime, engine, agent = world
    monkeypatch.setattr(settings, "ROUTINE_CONNECTED_APPS_ENABLED", enabled)
    if scopes is not None:
        async with sessions() as db:
            await agent_store.update_agent(db, agent.id, connector_scopes=scopes)
    thread = await runtime.create_thread(agent_id=agent.id)
    snapshot = grants if grants is not None else [
        {"tool": "github_get_authenticated_user", "account_id": "ca_1"}
    ]
    async with sessions() as db:
        routine = Routine(owner_id=owner, agent_id=agent.id, name="Scheduled reader", prompt="Read",
                          schedule_kind="manual", schedule_spec={}, timezone="UTC", paused=False,
                          run_limit_minutes=30, approval_mode="ask", approval_timeout_minutes=30,
                          catch_up_minutes=60, retry_limit=0, retry_delay_minutes=5,
                          connected_app_grants=snapshot)
        db.add(routine)
        await db.flush()
        rr = RoutineRun(routine_id=routine.id, trigger=trigger, state="running", prompt="Read",
                        thread_id=thread.id, connected_app_grants=snapshot)
        db.add(rr)
        turn = Turn(thread_id=thread.id, seq=1, prompt_text="Read", status="running", origin="routine")
        db.add(turn)
        await db.commit()
        await db.refresh(routine)
        await db.refresh(rr)
        await db.refresh(turn)
    run = SimpleNamespace(
        ctx=SimpleNamespace(computer=computer), agent_id=agent.id, turn_id=turn.id,
        thread_id=thread.id, routine_run_id=rr.id, routine_id=None, routine_grants=None,
    )
    return runtime, engine, agent, routine, rr, turn, run


async def _remove_runtime_routine(sessions, routine_id):
    from sqlalchemy import select

    async with sessions() as db:
        runs = await db.scalars(select(RoutineRun).where(RoutineRun.routine_id == routine_id))
        for row in runs:
            await db.delete(row)
        await db.delete(await db.get(Routine, routine_id))
        await db.commit()


@pytest.mark.parametrize("trigger,enabled,computer,expected", [
    ("manual", True, None, {"github": "read"}),
    ("schedule", True, None, {"github": "read"}),
    ("webhook", True, None, {}),
    ("manual", False, None, {}),
    ("manual", True, object(), {}),
])
async def test_runtime_mounts_only_enabled_scheduled_or_manual_grants(
    composio_world, sessions, owner, monkeypatch, trigger, enabled, computer, expected
):
    runtime, engine, _ = composio_world
    context = await _runtime_mount_context(composio_world, sessions, owner, monkeypatch,
                                           trigger=trigger, enabled=enabled, computer=computer,
                                           grants=[
                                               {"tool": "github_get_authenticated_user", "account_id": "ca_1"},
                                               {"tool": "github_create_issue", "account_id": "ca_1"},
                                               {"tool": "invented_tool", "account_id": "ca_1"},
                                               {"tool": "gmail_list_messages", "account_id": "ca_9"},
                                           ])
    runtime, engine, agent, routine, rr, turn, run = context
    try:
        mounted = await runtime._composio_apps(run, engine)
        assert mounted == expected
        if expected:
            assert run.routine_grants == {"github_get_authenticated_user": "ca_1"}
            bridge = composio_bridge.ComposioBridge(runtime, run, mounted)
            try:
                args = bridge.launch.args
                assert "--exact-tools" in args
                assert args[args.index("--exact-tools") + 1] == "github_get_authenticated_user"
            finally:
                await bridge.close()
    finally:
        await _remove_runtime_routine(sessions, routine.id)


async def test_run_snapshot_does_not_mount_a_tool_added_to_the_live_routine(composio_world, sessions, owner, monkeypatch):
    runtime, engine, _ = composio_world
    context = await _runtime_mount_context(composio_world, sessions, owner, monkeypatch)
    runtime, engine, agent, routine, rr, turn, run = context
    try:
        assert await runtime._composio_apps(run, engine) == {"github": "read"}
        async with sessions() as db:
            row = await db.get(Routine, routine.id)
            row.connected_app_grants = [
                {"tool": "github_get_authenticated_user", "account_id": "ca_1"},
                {"tool": "github_list_my_repositories", "account_id": "ca_1"},
            ]
            await db.commit()
        assert run.routine_grants == {"github_get_authenticated_user": "ca_1"}
        assert tool_policy.automatic(composio_bridge.PREFIX + "github_list_my_repositories", "ask", run, {}) == (
            "denied", "routine_action_not_granted"
        )
    finally:
        await _remove_runtime_routine(sessions, routine.id)


@pytest.mark.parametrize("gmail_scope,expected_apps,expected_tools", [
    ("read", {}, []),
    ("write", {"gmail": "write"}, ["gmail_send_email"]),
])
async def test_runtime_mounts_only_granted_routine_writes_at_the_agent_scope(
    composio_world, sessions, owner, monkeypatch, gmail_scope, expected_apps, expected_tools
):
    context = await _runtime_mount_context(
        composio_world, sessions, owner, monkeypatch,
        scopes={"gmail": gmail_scope},
        grants=[
            {"tool": "gmail_send_email", "account_id": "ca_mail"},
            {"tool": "gmail_create_draft_reply", "account_id": "ca_mail"},
            {"tool": "github_create_branch", "account_id": "ca_1"},
        ],
    )
    runtime, engine, _, routine, _, _, run = context
    try:
        mounted = await runtime._composio_apps(run, engine)
        assert mounted == expected_apps
        if expected_tools:
            assert run.routine_grants == {"gmail_send_email": "ca_mail"}
            bridge = composio_bridge.ComposioBridge(runtime, run, mounted)
            try:
                args = bridge.launch.args
                assert args[args.index("--apps") + 1] == "gmail=write"
                exact = args[args.index("--exact-tools") + 1].split(",")
                assert exact == expected_tools
                server = Server(bridge.folder, mounted, set(exact))
                assert [tool["name"] for tool in server.tools] == expected_tools
            finally:
                await bridge.close()
        else:
            assert run.routine_grants == {}
    finally:
        await _remove_runtime_routine(sessions, routine.id)
