"""The browser on this machine, as the turn sees it: the setting, the health flag, the per-turn attach and release,
and how the two engines pass its MCP server on beside the host tools."""

import json
import sys
from types import SimpleNamespace

import pytest

from app.computers import grants, local_browser_server
from app.computers.service import ComputerService, HOSTED_BROWSER_REASON, HOSTED_REASON, local_browser_enabled
from app.core.config import settings
from app.services import claude_adapter, codex_adapter, local_claude_runner


@pytest.fixture
def service(tmp_path):
    return ComputerService(providers={}, owner_id=1, root=tmp_path / "computers")


def test_the_setting_is_off_by_default_and_never_on_a_control_plane(monkeypatch):
    assert settings.LOCAL_BROWSER_ENABLED is False and not local_browser_enabled()
    monkeypatch.setattr(settings, "LOCAL_BROWSER_ENABLED", True)
    assert local_browser_enabled()
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", True)
    assert not local_browser_enabled()


async def test_no_browser_is_attached_while_the_setting_is_off(service):
    assert await service.attach_browser(7, 1) is None


async def test_a_turn_gets_the_browser_server_and_release_removes_its_permits(service, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_BROWSER_ENABLED", True)
    binding = await service.attach_browser(7, 11)
    assert binding.provider == "local-browser" and binding.kind == "browser" and binding.computer_id == -7
    args = binding.launch.args
    assert args[:2] == ["-m", "app.computers.local_browser_server"]
    assert args[args.index("--grants") + 1] == str(binding.grants_dir) and binding.grants_dir.is_dir()
    assert args[args.index("--agent") + 1] == "agent-7"
    assert "--turn-id" not in args  # the server names the turn by its grants folder, as release_turn expects
    assert "headless Chromium" in binding.prompt_note() and "Your own shell and file tools are unchanged" in binding.prompt_note()
    state = service.state_dir() / "browser-7"
    (state / "screen-owner.json").write_text(json.dumps({"turn_id": str(binding.grants_dir), "until": 9e12}))
    await service.release_turn(binding, 11)
    assert not binding.grants_dir.exists() and not (state / "screen-owner.json").exists()


async def test_a_control_plane_never_attaches_a_browser(service, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_BROWSER_ENABLED", True)
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", True)
    assert await service.attach_browser(7, 1) is None


@pytest.mark.parametrize("enabled", [False, True])
async def test_hosted_health_keeps_docker_blocked_and_reports_the_browser(service, monkeypatch, enabled):
    monkeypatch.setattr(settings, "HOSTED_SANDBOX", True)
    monkeypatch.setattr(settings, "LOCAL_BROWSER_ENABLED", enabled)
    health = await service.health()
    assert health.hosted and not health.available and health.browser_local is enabled
    assert health.error == (HOSTED_BROWSER_REASON if enabled else HOSTED_REASON)


def test_the_browser_server_is_what_the_launch_names():
    assert callable(local_browser_server.main)


def test_the_browser_permit_is_issued_into_the_browsers_grants(tmp_path):
    ctx = SimpleNamespace(computer=None, browser=SimpleNamespace(grants_dir=grants.private_dir(tmp_path / "g"), provider="local-browser"), thread_id=1)
    handle = SimpleNamespace(tool="mcp__computer__browser_click")
    assert claude_adapter._issue_permit(ctx, handle, {"ref": "e1"}) is True
    assert any((tmp_path / "g").iterdir())
    plain = SimpleNamespace(computer=None, browser=None, thread_id=1)
    assert claude_adapter._issue_permit(plain, handle, {"ref": "e1"}) is True and len(list((tmp_path / "g").iterdir())) == 1


def test_claude_keeps_strict_mcp_config_and_the_browser_server_is_mounted():
    launch = SimpleNamespace(command=sys.executable, args=["-m", "app.computers.local_browser_server"], env={})
    argv = local_claude_runner.build_args(
        local_claude_runner.Path("claude"), "sid", tools=True, mcp_servers={local_claude_runner.COMPUTER_SERVER: launch}
    )
    assert "--strict-mcp-config" in argv
    config = json.loads(argv[argv.index("--mcp-config") + 1])
    assert list(config["mcpServers"]) == ["computer"]
    assert argv[argv.index("--tools") + 1] == local_claude_runner.TOOL_NAMES  # the host tools stay on


def test_codex_asks_about_exactly_the_browser_tools():
    assert "browser_open" in codex_adapter._BROWSER_TOOLS and "exec" not in codex_adapter._BROWSER_TOOLS
