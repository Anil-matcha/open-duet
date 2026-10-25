"""The read-only explain and rule-preview HTTP routes.

`explain` is a projection of what enforcement will do, so its tests drive a real
pending approval through the runtime (the same harness the approval routes use),
then assert the contract: the documented keys, idempotence, non-owner 404, and
that explaining twice never spends the approval.
"""

import httpx
import pytest
from fastapi import FastAPI

from app.core.config import settings
from app.routers.approval_rules import router as rules_router
from app.routers.explain import router as explain_router
from app.routers.threads import get_runtime
from app.routers.threads import router as threads_router
from tests.services.thread_harness import (  # noqa: F401
    cleanup,
    cli,
    finished,
    new_thread,
    owner,
    pending_approval,
    rt,
    sessions,
    tools_on,
)

BASH = {"type": "tool", "tool_name": "Bash", "tool_input": {"command": "env -S 'rm -rf ~'"}}


@pytest.fixture(autouse=True)
def local_enabled(monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    monkeypatch.setattr(settings, "FRONTEND_ORIGINS", "http://localhost:3000")
    monkeypatch.setattr(settings, "LOCAL_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")


def app_for(rt) -> FastAPI:
    app = FastAPI()
    for router in (threads_router, rules_router, explain_router):
        app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_runtime] = lambda: rt
    return app


def client_for(app, *, client=("127.0.0.1", 50000), base_url="http://localhost"):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app, client=client), base_url=base_url)


@pytest.fixture
async def api(rt):
    async with client_for(app_for(rt)) as client:
        yield client


async def test_explain_returns_every_documented_key(api, rt, sessions, cli, tools_on, owner):
    thread = await new_thread(sessions, owner)
    cli.script(BASH)
    await rt.send_turn(thread.id, "clean up")
    approval = await pending_approval(sessions, thread.id)

    body = (await api.post(f"/api/v1/approvals/{approval.id}/explain")).json()
    assert set(body) == {
        "command",
        "resolved_argv",
        "wrapper_chain",
        "value_options_resolved",
        "matched_rule",
        "floor_verdict",
        "also_allows",
    }
    assert body["command"] == "env -S 'rm -rf ~'"
    assert body["resolved_argv"] == ["env", "-S", "rm -rf ~"]
    assert body["wrapper_chain"] == ["env"]
    assert body["value_options_resolved"] == [["-S", "rm -rf ~"]]
    # `env -S 'rm -rf ~'` is a home delete: the floor does not clear it.
    assert body["floor_verdict"]["clear"] is False
    assert body["floor_verdict"]["tripped_check"] == "delete-home"
    assert body["matched_rule"] is None


async def test_explain_names_the_matched_rule(api, rt, sessions, cli, tools_on, owner):
    thread = await new_thread(sessions, owner)
    cli.script({"type": "tool", "tool_name": "Bash", "tool_input": {"command": "ls -la"}})
    await rt.send_turn(thread.id, "list")
    approval = await pending_approval(sessions, thread.id)
    # Save a prefix rule that would match, then explain.
    await api.post("/api/v1/approval-rules", json={"match": "prefix", "command": "ls"})
    body = (await api.post(f"/api/v1/approvals/{approval.id}/explain")).json()
    assert body["matched_rule"]["kind"] == "prefix"
    assert body["matched_rule"]["command"] == "ls"
    assert body["floor_verdict"]["clear"] is True
    assert "ls -la" in body["also_allows"]


async def test_explain_is_idempotent(api, rt, sessions, cli, tools_on, owner):
    thread = await new_thread(sessions, owner)
    cli.script({"type": "tool", "tool_name": "Bash", "tool_input": {"command": "ls -la"}})
    await rt.send_turn(thread.id, "list")
    approval = await pending_approval(sessions, thread.id)
    first = (await api.post(f"/api/v1/approvals/{approval.id}/explain")).json()
    second = (await api.post(f"/api/v1/approvals/{approval.id}/explain")).json()
    assert first == second


async def test_explain_twice_does_not_consume_the_approval(api, rt, sessions, cli, tools_on, owner):
    """AC4: explain is read-only — the approval can still be accepted after."""
    thread = await new_thread(sessions, owner)
    cli.script(BASH)
    await rt.send_turn(thread.id, "clean up")
    approval = await pending_approval(sessions, thread.id)
    for _ in range(2):
        assert (await api.post(f"/api/v1/approvals/{approval.id}/explain")).status_code == 200
    # The approval is still pending, and answering it still works.
    answered = await api.post(
        f"/api/v1/threads/{thread.id}/approvals/{approval.id}", json={"decision": "deny"}
    )
    assert answered.status_code == 200
    await finished(sessions, thread.id)


async def test_explain_unknown_id_is_404(api):
    assert (await api.post("/api/v1/approvals/nope/explain")).status_code == 404


async def test_explain_of_another_owners_approval_is_404(rt, sessions, cli, tools_on, owner):
    """AC7: a foreign owner's approval is not visible — 404, not 200."""
    thread = await new_thread(sessions, owner)
    cli.script({"type": "tool", "tool_name": "Bash", "tool_input": {"command": "ls"}})
    await rt.send_turn(thread.id, "list")
    approval = await pending_approval(sessions, thread.id)
    # A different runtime identity over the same app.
    other = rt.__class__(
        hub=rt.hub, adapters=rt.adapters, status_ttl=0, _session_factory=sessions, owner_id="od_other_" + owner
    )
    app = app_for(other)
    async with client_for(app) as foreign:
        assert (await foreign.post(f"/api/v1/approvals/{approval.id}/explain")).status_code == 404


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("POST", "/api/v1/approvals/x/explain", None),
        ("POST", "/api/v1/approval-rules/preview", {"match": "exact", "command": "ls"}),
    ],
)
async def test_explain_and_preview_refuse_remotely(rt, method, path, body):
    app = app_for(rt)
    for kwargs in (dict(client=("203.0.113.9", 50000)), dict(base_url="http://evil.example")):
        async with client_for(app, **kwargs) as remote:
            assert (await remote.request(method, path, json=body)).status_code == 403


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("POST", "/api/v1/approvals/x/explain", None),
        ("POST", "/api/v1/approval-rules/preview", {"match": "exact", "command": "ls"}),
    ],
)
async def test_explain_and_preview_refuse_when_local_is_off(rt, monkeypatch, method, path, body):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", False)
    async with client_for(app_for(rt)) as client:
        assert (await client.request(method, path, json=body)).status_code == 403
