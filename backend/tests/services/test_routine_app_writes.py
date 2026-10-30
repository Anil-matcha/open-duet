"""At-most-once routine writes and their durable action receipts."""
import asyncio
import base64
import json
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import delete, select

from app.core.config import settings
from app.db.models import Agent, RoutineAppAction, Routine, RoutineRun, UserCredential
from app.services import agent_store, composio_bridge, composio_service, tool_policy
from app.services.composio_client import ComposioClient
from tests.services.test_composio_bridge import KEY, FakeComposio, PREFIX
from tests.services.thread_harness import owner, sessions  # noqa: F401

SEND = {"recipient_email": "person@example.com", "subject": "Daily update", "body": "Plain text only"}
BRANCH = {"owner": "octocat", "repo": "demo", "branch": "campaign/run-42", "from_sha": "a" * 40}
COMMIT = {"owner": "octocat", "repo": "demo", "path": "reports/status.txt", "branch": "campaign/run-42",
          "message": "Add status report", "content": "Report body"}


@pytest.fixture
async def write_world(sessions, owner, monkeypatch):
    fake = FakeComposio()
    fake.accounts.append({"id": "ca_mail", "toolkit": {"slug": "gmail"}, "alias": "mail", "status": "ACTIVE",
                          "user_id": "u1", "data": {}})
    monkeypatch.setattr(settings, "ROUTINE_CONNECTED_APPS_ENABLED", True)
    monkeypatch.setattr(composio_bridge, "make_client", lambda key: ComposioClient(key, transport=httpx.MockTransport(fake.handler)))
    grants = [
        {"tool": "gmail_send_email", "account_id": "ca_mail"},
        {"tool": "github_create_branch", "account_id": "ca_1"},
        {"tool": "github_commit_file", "account_id": "ca_1"},
        {"tool": "github_get_authenticated_user", "account_id": "ca_1"},
    ]
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=owner, name="Routine publisher")
        await agent_store.update_agent(db, agent.id, connector_scopes={"gmail": "write", "github": "write"},
                                       connector_account_scopes={"gmail": ["ca_mail"], "github": ["ca_1"]})
        await composio_service._save(db, owner, {"api_key": KEY, "user_id": "u1", "session_id": "sess_1"})
        routine = Routine(owner_id=owner, agent_id=agent.id, name="Publisher", prompt="Publish",
                          schedule_kind="manual", schedule_spec={}, timezone="UTC", paused=False,
                          run_limit_minutes=30, approval_mode="ask", approval_timeout_minutes=30,
                          catch_up_minutes=60, retry_limit=0, retry_delay_minutes=5,
                          connected_app_grants=grants)
        db.add(routine)
        await db.flush()
        rr = RoutineRun(routine_id=routine.id, trigger="manual", state="running", prompt="Publish",
                        thread_id=8831, connected_app_grants=grants)
        db.add(rr)
        await db.commit()
        await db.refresh(routine)
        await db.refresh(rr)
    runtime = SimpleNamespace(session=sessions, owner_id=owner)
    run = SimpleNamespace(
        ctx=SimpleNamespace(aborted=False, computer=None, approval_mode="ask", composio_apps={"github": "write", "gmail": "write"},
                            composio_account_scopes={"github": ["ca_1"], "gmail": ["ca_mail"]}),
        routine_grants={grant["tool"]: grant["account_id"] for grant in grants}, routine_id=routine.id,
        routine_run_id=rr.id, thread_id=rr.thread_id, agent_id=agent.id, turn_id=997,
        owner_token="routine-write-owner",
    )

    async def approved(*_args):
        return True

    monkeypatch.setattr("app.team.bridge.consume_allowed_approval", approved)
    bridge = composio_bridge.ComposioBridge(runtime, run, {"github": "write", "gmail": "write"},
        account_scopes={"github": ["ca_1"], "gmail": ["ca_mail"]})
    yield runtime, run, routine, rr, agent, fake, bridge
    await bridge.close()
    async with sessions() as db:
        await db.execute(delete(RoutineAppAction).where(RoutineAppAction.run_id == rr.id))
        await db.delete(await db.get(RoutineRun, rr.id))
        await db.delete(await db.get(Routine, routine.id))
        await db.execute(delete(UserCredential).where(UserCredential.user_id == owner))
        await db.delete(await db.get(Agent, agent.id))
        await db.commit()


async def action_rows(sessions, run_id):
    async with sessions() as db:
        return list((await db.scalars(select(RoutineAppAction).where(RoutineAppAction.run_id == run_id))).all())


async def test_send_email_is_one_plain_text_recipient_and_persists_only_safe_result(write_world, sessions):
    _, _, _, rr, _, fake, bridge = write_world
    fake.answer = {"result_type": "completed", "error": None,
                   "data": {"id": "msg_1", "messageId": "msg_1", "threadId": "thr_1"}}
    result = await bridge.execute("gmail_send_email", SEND)
    assert result["result"]["messageId"] == "msg_1"
    request = fake.executes[0]
    assert request["tool_slug"] == "GMAIL_SEND_EMAIL"
    assert request["account"] == "ca_mail"
    assert request["arguments"] == {"user_id": "me", "is_html": False, **SEND}
    assert "recipients" not in request["arguments"]
    (receipt,) = await action_rows(sessions, rr.id)
    assert receipt.status == "completed" and receipt.request_key and receipt.account_id == "ca_mail"
    assert "Plain text only" not in json.dumps(receipt.result)


async def test_writes_need_both_agent_write_scope_and_an_exact_routine_grant(write_world, sessions):
    runtime, run, routine, rr, agent, fake, bridge = write_world
    assert tool_policy.automatic(PREFIX + "gmail_send_email", "ask", run, SEND) == (
        "allowed", "routine_write_grant"
    )
    async with sessions() as db:
        await agent_store.update_agent(db, agent.id, connector_scopes={"gmail": "read", "github": "write"},
                                       connector_account_scopes={"gmail": ["ca_mail"], "github": ["ca_1"]})
    result = await bridge.execute("gmail_send_email", SEND)
    assert result["code"] == "not_allowed" and fake.executes == []
    rows = await action_rows(sessions, rr.id)
    assert [(row.tool, row.status, row.code) for row in rows] == [
        ("gmail_send_email", "refused", "not_allowed")
    ]
    run.routine_grants.pop("gmail_send_email")
    assert tool_policy.automatic(PREFIX + "gmail_send_email", "ask", run, SEND) == (
        "denied", "routine_action_not_granted"
    )


async def test_plan_mode_denies_granted_routine_writes_without_a_card(write_world):
    _, run, _, _, _, fake, bridge = write_world
    run.ctx.approval_mode = "plan"
    assert tool_policy.automatic(PREFIX + "gmail_send_email", "plan", run, SEND) == ("denied", "plan_mode")
    result = await bridge.execute("gmail_send_email", SEND)
    assert result["code"] == "not_allowed" and fake.executes == []


async def test_concurrent_exact_duplicate_write_reaches_provider_once(write_world, sessions):
    _, _, _, rr, _, fake, bridge = write_world
    fake.answer = {"result_type": "completed", "error": None, "data": {"id": "msg_1", "messageId": "msg_1"}}
    first, second = await asyncio.gather(bridge.execute("gmail_send_email", SEND),
                                         bridge.execute("gmail_send_email", SEND))
    assert sorted([first.get("code", "completed"), second.get("code", "completed")]) == [
        "already_attempted", "completed"
    ]
    assert fake.execute_attempts == 1
    rows = await action_rows(sessions, rr.id)
    assert sorted(row.status for row in rows) == ["completed", "refused"]


async def test_unknown_write_outcome_is_recorded_and_never_repeated(write_world, sessions):
    _, _, _, rr, _, fake, bridge = write_world
    fake.execute_fault = "down"
    first = await bridge.execute("gmail_send_email", SEND)
    second = await bridge.execute("gmail_send_email", SEND)
    assert first["code"] == "outcome_unknown" and second["code"] == "already_attempted"
    assert fake.execute_attempts == 1
    rows = await action_rows(sessions, rr.id)
    assert sorted((row.status, row.code) for row in rows) == [
        ("outcome_unknown", "outcome_unknown"), ("refused", "already_attempted")
    ]


async def test_cancelled_write_keeps_reserved_receipt_and_cannot_retry(write_world, sessions, monkeypatch):
    _, _, _, rr, _, fake, bridge = write_world
    entered_io, wait_io = asyncio.Event(), asyncio.Event()
    calls = 0

    async def blocked(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        entered_io.set()
        await wait_io.wait()
        return {"result": "done"}

    monkeypatch.setattr(composio_service, "run_tool", blocked)
    task = asyncio.create_task(bridge.execute("gmail_send_email", SEND))
    await asyncio.wait_for(entered_io.wait(), timeout=3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await bridge.execute("gmail_send_email", SEND)
    assert result["code"] == "already_attempted" and calls == 1 and fake.executes == []
    rows = await action_rows(sessions, rr.id)
    assert sorted(row.status for row in rows) == ["refused", "reserved"]


async def test_branch_and_file_writes_keep_campaign_and_encoding_constraints(write_world, sessions):
    _, _, _, rr, _, fake, bridge = write_world
    fake.answer = {"result_type": "completed", "error": None,
                   "data": {"ref": "refs/heads/campaign/run-42", "url": "https://github.test/ref"}}
    created = await bridge.execute("github_create_branch", BRANCH)
    assert created["result"]["ref"] == "refs/heads/campaign/run-42"
    assert fake.executes[-1]["arguments"]["ref"] == "refs/heads/campaign/run-42"
    assert fake.executes[-1]["arguments"]["sha"] == "a" * 40

    fake.answer = {"result_type": "completed", "error": None,
                   "data": {"content": {"path": COMMIT["path"], "html_url": "https://github.test/file"},
                            "commit": {"sha": "b" * 40, "html_url": "https://github.test/commit"}}}
    committed = await bridge.execute("github_commit_file", COMMIT)
    assert committed["result"]["commit_sha"] == "b" * 40
    sent = fake.executes[-1]["arguments"]
    assert sent["branch"] == "campaign/run-42"
    assert sent["content"] == base64.b64encode(b"Report body").decode()
    assert sent["content"] != COMMIT["content"]

    invalid = await bridge.execute("github_commit_file", {**COMMIT, "branch": "main"})
    assert invalid["code"] == "bad_arguments"
    assert fake.execute_attempts == 2
    rows = await action_rows(sessions, rr.id)
    assert sorted(row.status for row in rows) == ["completed", "completed", "refused"]


async def test_live_grant_revocation_stops_a_snapshotted_write(write_world, sessions):
    _, _, routine, rr, _, fake, bridge = write_world
    async with sessions() as db:
        current = await db.get(Routine, routine.id)
        current.connected_app_grants = [g for g in current.connected_app_grants if g["tool"] != "gmail_send_email"]
        await db.commit()
    result = await bridge.execute("gmail_send_email", SEND)
    assert result["code"] == "not_allowed" and fake.executes == []
    rows = await action_rows(sessions, rr.id)
    assert [(row.tool, row.status, row.code) for row in rows] == [
        ("gmail_send_email", "refused", "not_allowed")
    ]


def test_interactive_write_has_no_automatic_allow_and_still_needs_a_person():
    interactive = SimpleNamespace(ctx=SimpleNamespace(composio_apps={"github": "write"}, team=None),
                                  routine_grants=None)
    assert tool_policy.automatic(PREFIX + "github_create_branch", "ask", interactive, BRANCH) is None


async def test_reads_also_leave_a_receipt_but_do_not_use_write_deduplication(write_world, sessions):
    _, _, _, rr, _, fake, bridge = write_world
    fake.answer = {"result_type": "completed", "error": None, "data": {"login": "octo", "name": "Octo"}}
    first = await bridge.execute("github_get_authenticated_user", {})
    second = await bridge.execute("github_get_authenticated_user", {})
    assert first["result"]["login"] == second["result"]["login"] == "octo"
    assert fake.execute_attempts == 2
    receipts = await action_rows(sessions, rr.id)
    assert len(receipts) == 2 and all(row.status == "completed" and row.request_key is None for row in receipts)
