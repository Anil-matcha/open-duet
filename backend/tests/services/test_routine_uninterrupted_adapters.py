from types import SimpleNamespace

from tests.services.test_codex_adapter import (  # noqa: F401
    crt, codex, sessions, owner, cleanup, finished,
)


async def test_codex_requires_full_mode_app_server_and_gets_direct_tool_instructions(crt, sessions, codex, monkeypatch):
    thread = await crt.create_thread(provider="codex")
    adapter = crt.adapters["codex"]
    original = adapter.run_turn
    async def full_context(ctx, sink, gate):
        ctx.routine_uninterrupted = True
        ctx.composio_launch = SimpleNamespace(command="composio-mcp", args=["--uninterrupted"], env={})
        ctx.composio_apps = {"notion": "write"}
        return await original(ctx, sink, gate)
    monkeypatch.setattr(adapter, "run_turn", full_context)
    await crt.send_turn(thread.id, "Do the authorized routine")
    await finished(sessions, thread.id)
    started = codex.received("thread/start")[0]["params"]
    server = started["config"]["mcp_servers"]["open_dots_composio"]
    assert server["required"] is True and server["startup_timeout_sec"] == 10
    assert {"app_search_actions", "app_run_action"} <= set(server["enabled_tools"])
    assert "Call matching tools directly without asking for approval in chat text" in started["developerInstructions"]
    assert "person approves every call" not in started["developerInstructions"]
