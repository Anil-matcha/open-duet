import httpx
import pytest

from app.computers import muapi_provider
from app.computers.docker_cli import Spec
from app.computers.muapi_provider import MuapiProvider, _muapi_refusal
from app.computers.provider import CLOUD_PROVIDERS, ComputerError

SID = "3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b"


def spec(container_id=SID, kind="shell"):
    return Spec(7, "a" * 32, "muapi/default", "/tmp/workspace", kind=kind, container_id=container_id)


def provider_with(monkeypatch, handler):
    """MuapiProvider whose HTTP goes to `handler(request) -> httpx.Response`; records requests."""
    p = MuapiProvider(base_url="https://api.example.test/api/v1")
    monkeypatch.setattr(p, "_key", lambda: "mu_test_key")
    seen = []
    real_client = httpx.Client

    def client(*a, **kw):
        kw["transport"] = httpx.MockTransport(lambda r: (seen.append(r), handler(r))[1])
        return real_client(*a, **kw)

    monkeypatch.setattr(muapi_provider.httpx, "Client", client)
    return p, seen


def test_muapi_is_a_cloud_provider():
    assert {"boat", "muapi"} <= CLOUD_PROVIDERS


def test_create_sends_api_key_and_returns_running(monkeypatch):
    def handler(r):
        if r.url.path.endswith("/sandboxes") and r.method == "POST":
            return httpx.Response(200, json={"id": SID, "state": "running"})
        return httpx.Response(200, json={"exitCode": 0, "stdout": "", "stderr": ""})

    p, seen = provider_with(monkeypatch, handler)
    status = p.create(spec(container_id=None))
    assert status.state == "running" and status.container_id == SID
    assert seen[0].headers["x-api-key"] == "mu_test_key"
    assert "authorization" not in seen[0].headers
    assert seen[1].url.path.endswith(f"/sandboxes/{SID}/commands")


def test_create_refuses_desktop_kind(monkeypatch):
    p, _ = provider_with(monkeypatch, lambda r: httpx.Response(200, json={}))
    with pytest.raises(ComputerError) as exc:
        p.create(spec(container_id=None, kind="desktop"))
    assert exc.value.code == "muapi_shell_only"


@pytest.mark.parametrize("state,expected", [("running", "running"), ("stopped", "stopped"), ("creating", "creating"),
                                            ("deleted", "missing"), ("failed", "unavailable")])
def test_status_maps_states(monkeypatch, state, expected):
    p, _ = provider_with(monkeypatch, lambda r: httpx.Response(200, json={"id": SID, "state": state}))
    assert p.status(spec()).state == expected


def test_status_ignores_foreign_ids(monkeypatch):
    p, seen = provider_with(monkeypatch, lambda r: httpx.Response(200, json={}))
    assert p.status(spec(container_id="bx_boat_id")).state == "missing"
    assert seen == []


def test_stop_and_delete(monkeypatch):
    def handler(r):
        if r.method == "GET":
            return httpx.Response(200, json={"id": SID, "state": "running"})
        return httpx.Response(200, json={"id": SID, "state": "stopped"})

    p, seen = provider_with(monkeypatch, handler)
    assert p.stop(spec()).state == "stopped"
    assert [r.method for r in seen] == ["GET", "POST"]
    assert p.delete(spec()) is None  # synchronous: nothing to track


def test_delete_tolerates_already_gone(monkeypatch):
    p, _ = provider_with(monkeypatch, lambda r: httpx.Response(404, json={}))
    assert p.delete(spec()) is None


def test_insufficient_credits_is_actionable(monkeypatch):
    p, _ = provider_with(monkeypatch, lambda r: httpx.Response(402, json={}))
    with pytest.raises(ComputerError) as exc:
        p.create(spec(container_id=None))
    assert exc.value.code == "muapi_insufficient_credits"
    assert "credits" in str(exc.value)


def test_exec_file_tools_use_muapi_wire_format(monkeypatch):
    bodies = {}

    def handler(r):
        bodies[(r.method, r.url.path)] = r.content
        if r.url.path.endswith("/commands"):
            return httpx.Response(200, json={"exitCode": 0, "stdout": "hi\n", "stderr": ""})
        if r.method == "GET":
            return httpx.Response(200, json={"path": "p", "content": "hello"})
        return httpx.Response(200, json={"path": "p"})

    p, seen = provider_with(monkeypatch, handler)
    out = p.tool(spec(), "exec", {"command": "echo hi"})
    assert "hi" in out["content"][0]["text"] and not out.get("isError")
    assert b'"timeout_seconds"' in bodies[("POST", f"/api/v1/sandboxes/{SID}/commands")]
    assert p.tool(spec(), "read_file", {"path": "/workspace/a.txt"})["content"][0]["text"] == "hello"
    p.tool(spec(), "write_file", {"path": "/workspace/a.txt", "content": "x"})
    put = bodies[("PUT", f"/api/v1/sandboxes/{SID}/files")]
    assert b'"/home/user/workspace/a.txt"' in put and b"encoding" not in put
    listed = p.tool(spec(), "list_files", {"path": "/workspace"})
    assert not listed.get("isError")


def test_refusal_codes_do_not_name_boat():
    for status in (401, 402, 403, 404, 429, 500, 503):
        code, message = _muapi_refusal(status)
        assert "boat" not in message.lower()
