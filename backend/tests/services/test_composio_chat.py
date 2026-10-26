"""A chat turn that reads a connected app, through the real Claude adapter: the fake
CLI (a real child process) asks about the tool, the gate records the decision, and
the CLI calls the real MCP shim named in the --mcp-config the app gave it, which goes
through the bridge to a fake Composio."""
import json
import sys

import httpx
import pytest
from sqlalchemy import delete

from app.core.config import settings
from app.db.models import Agent
from app.db.models.user_credential import UserCredential
from app.services import agent_store, composio_bridge, composio_service, local_claude_runner, thread_runtime
from app.services.composio_client import ComposioClient
from app.services.thread_hub import ThreadHub
from app.services.thread_runtime import ThreadRuntime
from tests.services.test_composio_bridge import KEY, TOKEN, FakeComposio
from tests.services.thread_harness import (  # noqa: F401
    FAKE_CLI, Cli, ReadyClaude, cleanup, events_of, finished, owner, pending_approval, sessions,
)


@pytest.fixture
def cli(monkeypatch, tmp_path):
    fake = Cli(tmp_path / "plan.json")
    launches: list[dict] = []
    monkeypatch.setattr(local_claude_runner, "resolve_claude_executable", lambda: tmp_path / "claude")
    monkeypatch.setattr(local_claude_runner, "workspace_dir", lambda: tmp_path)
    original = local_claude_runner.build_args

    def fake_build_args(executable, session_id, tools=False, resume=False, approval_mode=None, model=None,
                        system_prompt=None, computer=None, **extra):
        real = original(executable, session_id, tools=tools, resume=resume, approval_mode=approval_mode, model=model,
                        system_prompt=system_prompt, computer=computer, **extra)
        launches.append({"args": real, "system_prompt": system_prompt})
        mcp = fake.plan.parent / "mcp.json"
        if "--mcp-config" in real:
            mcp.write_text(real[real.index("--mcp-config") + 1])
        elif mcp.exists():
            mcp.unlink()
        args = [sys.executable, str(FAKE_CLI), str(fake.plan), "resume" if resume else "new", session_id, "1" if tools else "0"]
        return args + [approval_mode] if approval_mode else args

    monkeypatch.setattr(local_claude_runner, "build_args", fake_build_args)
    fake.launches = launches
    return fake


@pytest.fixture
def composio(monkeypatch):
    fake = FakeComposio()
    monkeypatch.setattr(composio_bridge, "make_client", lambda key: ComposioClient(key, transport=httpx.MockTransport(fake.handler)))
    return fake


@pytest.fixture
async def rt(sessions, owner, monkeypatch):  # noqa: F811
    monkeypatch.setattr(settings, "LOCAL_TOOLS_ENABLED", False)
    monkeypatch.setattr(settings, "THREAD_HEARTBEAT_SECONDS", 0.2)
    monkeypatch.setattr(thread_runtime, "APPROVAL_POLL_SECONDS", 0.1)
    runtime = ThreadRuntime(hub=ThreadHub(), adapters={"claude": ReadyClaude()}, status_ttl=0, _session_factory=sessions, owner_id=owner)
    yield runtime
    await runtime.shutdown()
    async with sessions() as db:
        await db.execute(delete(UserCredential).where(UserCredential.user_id == owner))
        await db.execute(delete(Agent).where(Agent.owner_id == owner))
        await db.commit()


async def agent_with(rt, sessions, scopes):  # noqa: F811
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=rt.owner_id, name="Reader")
        if scopes is not None:
            await agent_store.update_agent(db, agent.id, connector_scopes=scopes)
        await composio_service._save(db, rt.owner_id, {"api_key": KEY, "user_id": "u1", "session_id": "sess_1"})
    return agent


def tool_step(name, tool_input):
    return {"type": "tool", "tool_name": "mcp__composio__" + name, "tool_input": tool_input}


async def test_an_allowed_agent_reads_github_in_chat_without_a_card(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"github": "read"})
    composio.answer = {"result_type": "completed", "data": {"login": "octo", "name": "Octo", "plan": {"name": "pro"}, "email": "x@y"}, "error": None}
    cli.script(tool_step("github_get_authenticated_user", {}))
    thread = await rt.create_thread(agent_id=agent.id)
    await rt.send_turn(thread.id, "who am I on github?")
    await finished(sessions, thread.id)

    launch = cli.launches[-1]
    args = launch["args"]
    config = json.loads(args[args.index("--mcp-config") + 1])
    assert "composio" in config["mcpServers"] and "--strict-mcp-config" in args
    assert args[args.index("--tools") + 1] == ""  # the host's own tools stay off
    assert "connected apps (github)" in launch["system_prompt"]
    server = config["mcpServers"]["composio"]
    assert server["args"][-2:] == ["--apps", "github=read"] and KEY not in json.dumps(config)

    result = cli.log("mcp_result")[0]
    assert not result["is_error"]
    body = json.loads(result["content"])
    assert body["result"]["login"] == "octo"
    assert "plan" not in result["content"] and "x@y" not in result["content"] and TOKEN not in result["content"]
    assert [e["tool_slug"] for e in composio.executes] == ["GITHUB_GET_THE_AUTHENTICATED_USER"]
    events = await events_of(sessions, thread.id)
    resolved = [e for e in events if e.type == "approval.resolved"]
    assert [(e.data["status"], e.data.get("by")) for e in resolved] == [("allowed", "composio_read")]


async def test_an_agent_without_the_app_has_no_server_and_the_call_is_denied(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, None)
    cli.script(tool_step("github_get_authenticated_user", {}))
    thread = await rt.create_thread(agent_id=agent.id)
    await rt.send_turn(thread.id, "who am I on github?")
    await finished(sessions, thread.id)
    args = cli.launches[-1]["args"]
    mounted = json.loads(args[args.index("--mcp-config") + 1])["mcpServers"] if "--mcp-config" in args else {}
    assert "composio" not in mounted
    assert cli.log("mcp_result") == [] and composio.executes == []
    resolved = [e for e in await events_of(sessions, thread.id) if e.type == "approval.resolved"]
    assert [(e.data["status"], e.data.get("by")) for e in resolved] == [("denied", "no_connected_apps")]


async def test_a_tool_the_agent_invents_is_denied_even_with_the_app_allowed(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"github": "read"})
    cli.script(tool_step("github_delete_repository", {"owner": "o", "repo": "r"}))
    thread = await rt.create_thread(agent_id=agent.id)
    await rt.send_turn(thread.id, "delete it")
    await finished(sessions, thread.id)
    assert cli.log("mcp_result") == [] and composio.executes == []
    resolved = [e for e in await events_of(sessions, thread.id) if e.type == "approval.resolved"]
    assert [(e.data["status"], e.data.get("by")) for e in resolved] == [("denied", "unknown_composio_tool")]


async def test_a_change_shows_a_card_and_runs_only_on_allow(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"github": "write"})
    composio.answer = {"result_type": "completed", "error": None,
                       "data": {"number": 5, "title": "Crash", "state": "open", "html_url": "https://github.com/o/r/issues/5"}}
    cli.script(tool_step("github_create_issue", {"owner": "o", "repo": "r", "title": "Crash", "body": "It fails."}))
    thread = await rt.create_thread(agent_id=agent.id)
    await rt.send_turn(thread.id, "file an issue")
    approval = await pending_approval(sessions, thread.id)
    assert approval.tool == "mcp__composio__github_create_issue"
    assert approval.input == {"owner": "o", "repo": "r", "title": "Crash", "body": "It fails."}
    assert approval.summary.startswith("github create issue o/r: Crash")
    assert composio.executes == []  # nothing happened before the Allow
    assert await rt.answer_approval(approval.id, "allow")
    await finished(sessions, thread.id)

    result = cli.log("mcp_result")[0]
    assert not result["is_error"] and json.loads(result["content"])["result"]["number"] == 5
    assert [e["tool_slug"] for e in composio.executes] == ["GITHUB_CREATE_AN_ISSUE"]
    args = cli.launches[-1]["args"]
    server = json.loads(args[args.index("--mcp-config") + 1])["mcpServers"]["composio"]
    assert server["args"][-2:] == ["--apps", "github=write"]
    assert "ask the person first" in cli.launches[-1]["system_prompt"]


async def test_a_denied_change_does_nothing(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"github": "write"})
    cli.script(tool_step("github_comment_on_issue", {"owner": "o", "repo": "r", "issue_number": 2, "body": "hello"}))
    thread = await rt.create_thread(agent_id=agent.id)
    await rt.send_turn(thread.id, "comment")
    approval = await pending_approval(sessions, thread.id)
    assert await rt.answer_approval(approval.id, "deny")
    await finished(sessions, thread.id)
    assert cli.log("mcp_result") == [] and composio.executes == []


async def test_a_read_level_agent_cannot_change_anything_in_chat(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"github": "read"})
    cli.script(tool_step("github_create_issue", {"owner": "o", "repo": "r", "title": "x"}))
    thread = await rt.create_thread(agent_id=agent.id)
    await rt.send_turn(thread.id, "file an issue")
    await finished(sessions, thread.id)
    assert cli.log("mcp_result") == [] and composio.executes == []
    resolved = [e for e in await events_of(sessions, thread.id) if e.type == "approval.resolved"]
    assert [(e.data["status"], e.data.get("by")) for e in resolved] == [("denied", "write_not_allowed")]
