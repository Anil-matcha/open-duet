import base64
from dataclasses import replace

import pytest

from app.computers.boat_provider import BoatProvider, _screenshot_command
from app.computers.docker_cli import Spec
from app.computers.provider import ComputerError


PNG = b"\x89PNG\r\n\x1a\nsmall-test-image"


def make_spec():
    return Spec(7, "a" * 32, "boat/default", "/tmp/workspace", kind="desktop", container_id="bx_test")


def test_boat_screenshot_fetches_image_from_files_api(monkeypatch):
    provider = BoatProvider()
    requests = []
    commands = []

    def request(method, path, *, body=None, **kwargs):
        requests.append((method, path, body))
        if method == "GET":
            return {"content": base64.b64encode(PNG).decode("ascii")}
        return {}

    def command(sandbox_id, command, timeout, **kwargs):
        commands.append(command)
        return {"exitCode": 0, "stdout": "captured\n", "stderr": ""}

    monkeypatch.setattr(provider, "_request", request)
    monkeypatch.setattr(provider, "_command", command)

    assert provider.screenshot(make_spec()) == PNG
    assert requests[0] == ("POST", "/sandboxes/bx_test/desktop?vnc=1", {"publicAccess": False})
    assert requests[1][0] == "GET"
    assert "path=%2Ftmp%2Fopen-dots-screen.png&encoding=base64" in requests[1][1]
    assert "base64" not in commands[0]
    assert '"${DISPLAY:-}" :0 :1' in commands[0]
    assert "import -window root" in commands[0]
    assert '"$DISPLAY" > /tmp/open-dots-display' in commands[0]


def test_boat_mcp_screenshot_uses_same_capture_and_preserves_crop(monkeypatch):
    provider = BoatProvider()
    requests = []
    commands = []

    def request(method, path, *, body=None, **kwargs):
        requests.append((method, path))
        return {"content": base64.b64encode(PNG).decode("ascii")} if method == "GET" else {}

    def command(sandbox_id, command, timeout, **kwargs):
        commands.append(command)
        return {"exitCode": 0, "stdout": "captured\n", "stderr": ""}

    monkeypatch.setattr(provider, "_request", request)
    monkeypatch.setattr(provider, "_command", command)

    result = provider._screen("bx_test", "screenshot", {"x": 2, "y": 3, "width": 100, "height": 80})
    assert result["content"][1]["mimeType"] == "image/png"
    assert result["content"][1]["data"] == base64.b64encode(PNG).decode("ascii")
    assert "scrot -a 2,3,100,80" in commands[0]
    assert "import -window root" not in commands[0]
    assert [method for method, _ in requests] == ["POST", "GET"]


def test_boat_screenshot_fails_closed_when_capture_command_fails(monkeypatch):
    provider = BoatProvider()
    requests = []

    def request(method, path, *, body=None, **kwargs):
        requests.append((method, path))
        return {}

    monkeypatch.setattr(provider, "_request", request)
    monkeypatch.setattr(provider, "_command", lambda *args, **kwargs: {"exitCode": 1, "stdout": "", "stderr": "no display"})

    with pytest.raises(ComputerError) as error:
        provider.screenshot(make_spec())
    assert error.value.code == "desktop_not_ready"
    assert [method for method, _ in requests] == ["POST"]


def test_screenshot_command_tries_environment_display_then_common_defaults():
    command = _screenshot_command()
    assert 'for display in "${DISPLAY:-}" :0 :1' in command
    assert 'scrot -o "$f"' in command
    assert 'import -window root "$f"' in command
    assert "x11grab" in command


def test_screenshot_command_uses_only_scrot_for_cropped_capture():
    command = _screenshot_command((2, 3, 100, 80))
    assert "scrot -a 2,3,100,80" in command
    assert "import -window root" not in command
    assert "x11grab" not in command


def test_delete_finishes_when_operation_and_sandbox_are_gone(monkeypatch):
    provider = BoatProvider()
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path))
        raise ComputerError("missing", "boat_computer_missing")

    monkeypatch.setattr(provider, "_request", request)

    def get(sandbox_id):
        calls.append(("GET_SANDBOX", sandbox_id))
        raise ComputerError("missing", "boat_computer_missing")

    monkeypatch.setattr(provider, "_get", get)

    spec = replace(make_spec(), provider_delete_id="bdop_" + "a" * 32)
    assert provider.delete(spec) is None
    assert calls == [
        ("GET", f"/deletion-operations/{spec.provider_delete_id}"),
        ("GET_SANDBOX", "bx_test"),
    ]


def test_delete_restarts_tracking_when_operation_is_gone_but_sandbox_remains(monkeypatch):
    provider = BoatProvider()
    requests = []

    def request(method, path, **kwargs):
        requests.append((method, path, kwargs))
        if method == "GET":
            raise ComputerError("missing", "boat_computer_missing")
        return {"operation": {"id": "bdop_" + "b" * 32, "status": "pending"}}

    monkeypatch.setattr(provider, "_request", request)
    monkeypatch.setattr(provider, "_get", lambda sandbox_id: {"id": sandbox_id, "state": "stopped"})

    spec = replace(make_spec(), provider_delete_id="bdop_" + "a" * 32)
    assert provider.delete(spec) == "bdop_" + "b" * 32
    assert [method for method, _, _ in requests] == ["GET", "DELETE"]
    assert requests[1][1] == "/sandboxes/bx_test"
    assert requests[1][2]["headers"] == {"X-Ascii-Confirm-Delete": "bx_test"}
