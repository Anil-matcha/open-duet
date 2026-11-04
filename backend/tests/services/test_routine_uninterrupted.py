from contextlib import asynccontextmanager
from types import SimpleNamespace as NS

import pytest

from app.db.models import Agent, Computer, Thread, Turn, CommunityMcpConnection, CommunityMcpToolGrant
from app.db.models.routine import Routine, RoutineRun
from app.services import routine_uninterrupted as access
from app.services.community_mcp_bridge import _alias


@pytest.fixture
def world():
    ceiling = {"computer_id": 7, "apps": {"gmail": "write", "slack": "write"},
               "accounts": {"gmail": ["mail_1"], "slack": ["slack_1"]},
               "composio_tools": ["gmail_fetch_emails", "gmail_send_email", "app_search_actions", "app_run_action"],
               "community": [{"connection_id": "c1", "connection_revision": 1,
                              "manifest_digest": "m1", "tool_name": "read", "schema_digest": "s1"}]}
    rows = {
        Routine: NS(id=2, owner_id="owner", agent_id=3, uninterrupted_access=True),
        RoutineRun: NS(id=4, routine_id=2, uninterrupted_access=True, capability_snapshot=ceiling,
                       trigger="manual", state="running", thread_id=5, turn_id=6),
        Agent: NS(id=3, owner_id="owner", archived_at=None, connector_scopes={"gmail": "write", "slack": "write"},
                  connector_account_scopes={"gmail": ["mail_1"], "slack": ["slack_1"]}),
        Computer: NS(id=7, owner_id="owner", agent_id=3, provider="boat", state="running"),
        Thread: NS(id=5, owner_id="owner", agent_id=3),
        Turn: NS(id=6, thread_id=5, origin="routine", status="running", owner_token="token"),
        CommunityMcpConnection: NS(owner_id="owner", revision=1, manifest_digest="m1"),
        CommunityMcpToolGrant: NS(schema_digest="s1"),
    }
    class DB:
        async def get(self, model, key, **kwargs):
            return rows.get(model)
    @asynccontextmanager
    async def session():
        yield DB()
    runtime = NS(owner_id="owner", session=session)
    run = NS(routine_run_id=4, agent_id=3, thread_id=5, turn_id=6, owner_token="token", uninterrupted_access=True,
             ctx=NS(approval_mode="ask", computer=NS(computer_id=7, provider="boat"),
                    community_tools=[_alias("c1", "read", "s1")]))
    return runtime, run, rows


@pytest.mark.parametrize("name,args", [("key", {"keys": "CTRL+L"}), ("type", {"text": "https://appsumo.com"}),
                                      ("exec", {"command": "python3 script.py"}), ("write_file", {"path": "notes.txt"}),
                                      ("browser_open", {"url": "https://appsumo.com"})])
async def test_saved_routine_access_allows_attached_computer_without_prompt(world, name, args):
    runtime, run, _ = world
    assert await access.automatic(runtime, run, "mcp__computer__" + name, args) == ("allowed", "routine_uninterrupted_grant")


@pytest.mark.parametrize("mutation", ["revoked", "owner", "agent", "archived", "webhook", "retry", "thread", "computer"])
async def test_current_state_and_run_start_ceilings_are_rechecked(world, mutation):
    runtime, run, rows = world
    if mutation == "revoked": rows[Routine].uninterrupted_access = False
    if mutation == "owner": rows[Routine].owner_id = "other"
    if mutation == "agent": rows[Routine].agent_id = 8
    if mutation == "archived": rows[Agent].archived_at = "now"
    if mutation in ("webhook", "retry"): rows[RoutineRun].trigger = mutation
    if mutation == "thread": rows[RoutineRun].thread_id = 9
    if mutation == "computer": run.ctx.computer.computer_id = 9
    assert (await access.automatic(runtime, run, "mcp__computer__key", {}))[0] == "denied"


async def test_no_grant_at_start_does_not_elevate_an_existing_run(world):
    runtime, run, rows = world
    run.uninterrupted_access = False
    rows[RoutineRun].uninterrupted_access = False
    assert await access.automatic(runtime, run, "mcp__computer__key", {}) is None


@pytest.mark.parametrize("tool,args", [("mcp__computer__native_click", {}),
                                      ("mcp__computer__exec", {"command": "rm -rf /"}),
                                      ("mcp__computer__exec", {"command": "eval $UNTRUSTED"}),
                                      ("mcp__computer__unknown", {})])
async def test_host_tools_unknown_tools_and_safety_floor_stay_blocked(world, tool, args):
    runtime, run, _ = world
    assert (await access.automatic(runtime, run, tool, args))[0] == "denied"


@pytest.mark.parametrize("tool,args", [("mcp__computer__key", {}), ("mcp__computer__exec", {"command": "ls"}),
                                      ("mcp__composio__gmail_send_email", {}),
                                      ("mcp__composio__app_run_action", {"app": "slack", "action": "SLACK_SEND"})])
async def test_plan_mode_still_blocks_actions(world, tool, args):
    runtime, run, _ = world
    run.ctx.approval_mode = "plan"
    assert await access.automatic(runtime, run, tool, args) == ("denied", "plan_mode")


async def test_app_scope_and_exact_accounts_intersect_snapshot_and_current(world):
    runtime, run, rows = world
    assert (await access.automatic(runtime, run, "mcp__composio__gmail_send_email", {}))[0] == "allowed"
    rows[Agent].connector_account_scopes = {"gmail": ["new_mail"]}
    assert (await access.automatic(runtime, run, "mcp__composio__gmail_send_email", {}))[0] == "denied"


async def test_generic_actions_require_granted_app_and_current_write_scope(world):
    runtime, run, rows = world
    tool = "mcp__composio__app_run_action"
    assert (await access.automatic(runtime, run, tool, {"app": "slack", "action": "SLACK_SEND"}))[0] == "allowed"
    assert (await access.automatic(runtime, run, tool, {"app": "shell", "action": "RUN_SHELL"}))[0] == "denied"
    rows[Agent].connector_scopes["slack"] = "read"
    assert (await access.automatic(runtime, run, tool, {"app": "slack", "action": "SLACK_SEND"}))[0] == "denied"


async def test_community_grants_are_pinned_to_connection_revision_and_schema(world):
    runtime, run, rows = world
    tool = "mcp__community__" + _alias("c1", "read", "s1")
    assert (await access.automatic(runtime, run, tool, {}))[0] == "allowed"
    rows[CommunityMcpConnection].revision = 2
    assert (await access.automatic(runtime, run, tool, {}))[0] == "denied"


def test_full_mode_tool_catalog_does_not_tell_the_agent_to_wait_for_approval(tmp_path):
    from app.composio_mcp_server import Server
    server = Server(tmp_path, {"slack": "write"}, uninterrupted=True)
    run_tool = next(tool for tool in server.tools if tool["name"] == "app_run_action")
    assert "Every call asks" not in run_tool["description"]
    assert "owner has authorized" in run_tool["description"]
