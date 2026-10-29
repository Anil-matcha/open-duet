"""The generic connected-app tools through the Codex engine (a real child process playing `codex`): the same policy,
the same card, the same checks at dispatch as for Claude. Fake Composio as in test_composio_generic_chat.py."""
import json
import stat
import sys

import httpx
import pytest
from sqlalchemy import delete

from app.db.models.user_credential import UserCredential
from app.services import agent_store, composio_bridge, composio_service
from app.services.composio_client import ComposioClient
from tests.services import test_codex_adapter
from tests.services.test_codex_adapter import FAKE, FakeCodex, crt  # noqa: F401
from tests.services.test_composio_bridge import KEY
from tests.services.test_composio_generic_chat import GenericComposio, revision
from tests.services.thread_harness import events_of, finished, owner, pending_approval, sessions  # noqa: F401


@pytest.fixture
def codex(monkeypatch, tmp_path):
    """The fake Codex of test_codex_adapter.py, started through a .cmd wrapper on Windows (a shell script cannot be run there)."""
    folder = tmp_path / "codex"
    folder.mkdir()
    if sys.platform == "win32":
        exe = tmp_path / "codex-bin.cmd"
        exe.write_text(f'@"{sys.executable}" "{FAKE}" %*' + chr(13) + chr(10))
    else:
        exe = tmp_path / "codex-bin"
        exe.write_text(f'#!/bin/sh{chr(10)}exec {sys.executable} {FAKE} "$@"{chr(10)}')
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("FAKE_CODEX_DIR", str(folder))
    monkeypatch.setattr(test_codex_adapter.codex_adapter, "resolve_codex_executable", lambda: exe)
    workspace = tmp_path / "ws"
    workspace.mkdir()
    monkeypatch.setattr(test_codex_adapter.local_claude_runner, "workspace_dir", lambda: workspace)
    fake = FakeCodex(folder)
    fake.workspace = workspace
    return fake


@pytest.fixture
def composio(monkeypatch):
    fake = GenericComposio()
    monkeypatch.setattr(composio_bridge, "make_client", lambda key: ComposioClient(key, transport=httpx.MockTransport(fake.handler)))
    return fake


@pytest.fixture
async def codex_agent(crt, sessions, owner, composio):  # noqa: F811
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=owner, name="Notion helper", provider="codex")
        await agent_store.update_agent(db, agent.id, connector_scopes={"notion": "write"},
                                       connector_account_scopes={"notion": ["ca_n"]})
        await composio_service._save(db, owner, {"api_key": KEY, "user_id": "u1", "session_id": "sess_1"})
    yield agent
    async with sessions() as db:
        await db.execute(delete(UserCredential).where(UserCredential.user_id == owner))
        await db.commit()


def call(tool, arguments):
    return {"type": "team", "server": "open_dots_composio", "tool": tool, "arguments": arguments}


def run_args(composio, **more):
    return {"app": "notion", "action": "NOTION_CREATE_PAGE", "revision": revision(composio), "arguments": {"title": "Plan"}, **more}


async def test_codex_gets_the_generic_tools_and_a_run_waits_on_a_card_with_the_exact_arguments(crt, sessions, codex, composio, codex_agent):  # noqa: F811
    args = run_args(composio)
    codex.plan(call("app_run_action", args))
    thread = await crt.create_thread(provider="codex", agent_id=codex_agent.id)
    await crt.send_turn(thread.id, "make a page")
    approval = await pending_approval(sessions, thread.id)
    assert approval.tool == "mcp__composio__app_run_action" and approval.input == args
    assert composio.executes == []
    assert await crt.answer_approval(approval.id, "allow")
    await finished(sessions, thread.id)

    server = codex.received("thread/start")[0]["params"]["config"]["mcp_servers"]["open_dots_composio"]
    assert {"app_search_actions", "app_run_action"} <= set(server["enabled_tools"]) and server["default_tools_approval_mode"] == "prompt"
    assert server["args"][-2:] == ["--apps", "notion=write"] and KEY not in json.dumps(server)
    assert [(e["tool_slug"], e["arguments"], e["account"]) for e in composio.executes] == [("NOTION_CREATE_PAGE", {"title": "Plan"}, "ca_n")]
    (_, result), = [(e, json.loads(e["content"])) for e in codex.log() if e.get("event") == "mcp_result"]
    assert "Data from notion" in result["notice"]


async def test_codex_search_needs_no_card(crt, sessions, codex, composio, codex_agent):  # noqa: F811
    codex.plan(call("app_search_actions", {"app": "notion", "query": "page"}))
    thread = await crt.create_thread(provider="codex", agent_id=codex_agent.id)
    await crt.send_turn(thread.id, "look")
    await finished(sessions, thread.id)
    (found,) = [json.loads(e["content"]) for e in codex.log() if e.get("event") == "mcp_result"]
    assert found["actions"][0]["revision"] == revision(composio)
    approvals = [e for e in await events_of(sessions, thread.id) if e.type == "approval.resolved"]
    assert [(e.data["status"], e.data.get("by")) for e in approvals] == [("allowed", "composio_search")]


@pytest.mark.parametrize("app,action", [("github", "GITHUB_DELETE_A_REPOSITORY"), ("notion", "COMPOSIO_REMOTE_BASH_TOOL"), ("notion", "NOTION_PROXY_EXECUTE")])
async def test_codex_cannot_reach_a_curated_apps_other_actions_or_a_code_tool(crt, sessions, codex, composio, codex_agent, app, action):  # noqa: F811
    codex.plan(call("app_run_action", {"app": app, "action": action, "revision": "0" * 16, "arguments": {}}))
    thread = await crt.create_thread(provider="codex", agent_id=codex_agent.id)
    await crt.send_turn(thread.id, "do it")
    await finished(sessions, thread.id)
    assert codex.answers()[0]["result"]["action"] == "decline"
    assert composio.executes == [] and not [e for e in codex.log() if e.get("event") == "mcp_result"]


async def test_codex_denied_card_runs_nothing(crt, sessions, codex, composio, codex_agent):  # noqa: F811
    codex.plan(call("app_run_action", run_args(composio)))
    thread = await crt.create_thread(provider="codex", agent_id=codex_agent.id)
    await crt.send_turn(thread.id, "make a page")
    assert await crt.answer_approval((await pending_approval(sessions, thread.id)).id, "deny")
    await finished(sessions, thread.id)
    assert composio.executes == []


async def test_codex_call_is_cancelled_when_the_schema_changes_while_the_card_waits(crt, sessions, codex, composio, codex_agent):  # noqa: F811
    codex.plan(call("app_run_action", run_args(composio)))
    thread = await crt.create_thread(provider="codex", agent_id=codex_agent.id)
    await crt.send_turn(thread.id, "make a page")
    approval = await pending_approval(sessions, thread.id)
    composio.tools["NOTION_CREATE_PAGE"]["version"] = "20261201_00"
    assert await crt.answer_approval(approval.id, "allow")
    await finished(sessions, thread.id)
    (result,) = [json.loads(e["content"]) for e in codex.log() if e.get("event") == "mcp_result"]
    assert result["code"] == "schema_changed" and composio.executes == []
