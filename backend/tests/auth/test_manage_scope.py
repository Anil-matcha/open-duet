"""The `manage` scope: a paired phone that may create and edit agents, and nothing else beyond chat
(docs/AUTH.md). The field guards in the agents router are tested in tests/routers/test_agents_manage_api.py."""

import pytest

from app.auth import store
from app.auth.policy import MANAGE_ROUTES, allows, is_public, required_scope
from app.core.config import settings
from tests.auth.test_auth_api import (  # noqa: F401
    REMOTE,
    app,
    auth_settings,
    client,
    error_code,
    factory,
    login,
    pairing_code,
    set_owner,
)


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/api/v1/agents"),
        ("PATCH", "/api/v1/agents/3"),
        ("POST", "/api/v1/agents/3/duplicate"),
        ("POST", "/api/v1/rooms"),
        ("PATCH", "/api/v1/rooms/3"),
        ("DELETE", "/api/v1/rooms/3"),
        ("PATCH", "/api/v1/rooms/3/members/4"),
    ],
)
def test_creating_and_editing_agents_and_rooms_need_the_manage_scope(method, path):
    assert required_scope(method, path) == "manage"
    assert not is_public(method, path)


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/api/v1/agents"),
        ("GET", "/api/v1/agents/3"),
        ("GET", "/api/v1/engines"),
    ],
)
def test_reading_agents_and_engines_stays_in_the_chat_scope(method, path):
    assert required_scope(method, path) == "chat"


@pytest.mark.parametrize(
    "method,path",
    [
        ("DELETE", "/api/v1/agents/3"),
        ("POST", "/api/v1/agents/import"),
        ("POST", "/api/v1/agents/import/openbot/preview"),
        ("GET", "/api/v1/agents/3/export"),
        ("PUT", "/api/v1/agents/3/memory"),
        ("PUT", "/api/v1/agents/3/skills/x"),
        ("POST", "/api/v1/agents/3/computer"),
        ("POST", "/api/v1/agents/3/duplicate/x"),
        ("POST", "/api/v1/agents/3/../threads"),
        ("PATCH", "/api/v1/agents/3/extra"),
        ("POST", "/api/v1/team/lead"),
        ("PATCH", "/api/v1/rooms/3/members"),
        ("POST", "/api/v1/rooms/3/dispatches/5/retry"),
        ("GET", "/api/v1/rooms/3/export.json"),
        ("DELETE", "/api/v1/rooms/3/messages"),
        ("POST", "/api/v1/rooms/3"),
        ("POST", "/api/v1/approval-rules"),
    ],
)
def test_everything_else_about_agents_stays_admin_only(method, path):
    assert required_scope(method, path) == "admin"


def test_every_manage_route_is_a_write():
    assert all("GET" not in methods for methods, _ in MANAGE_ROUTES)


def test_the_only_manage_delete_is_a_room():
    deleting = [pattern.pattern for methods, pattern in MANAGE_ROUTES if "DELETE" in methods]
    assert len(deleting) == 1 and "/rooms/" in deleting[0]


def test_files_does_not_reach_manage():
    assert not allows(("chat", "files"), "manage")
    assert not allows(("chat",), "manage")
    assert allows(("chat", "manage"), "manage")
    assert allows(("admin", "chat"), "manage")


def test_a_manage_code_carries_chat_files_and_manage():
    assert store.parse_scopes(store.scopes_for("manage")) == ("chat", "files", "manage")
    assert store.parse_scopes(store.scopes_for("chat")) == ("chat",)
    assert store.parse_scopes(store.scopes_for("files")) == ("chat", "files")
    assert "manage" not in store.scopes_for("admin")


async def paired(owner, phone, scope):
    code = await pairing_code(owner, (await login(owner))["csrf_token"], scope=scope)
    reply = await phone.post("/api/v1/auth/pair", json={"code": code})
    assert reply.status_code == 200, reply.text
    body = reply.json()
    return sorted(body["session"]["scopes"]), {"Authorization": f"Bearer {body['token']}"}


async def test_a_manage_device_reaches_the_agent_write_routes_and_files_but_not_delete_or_admin_routes(app, factory, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    await set_owner(factory)
    async with client(app) as owner, client(app, peer=("198.51.100.40", 1)) as phone:
        scopes, bearer = await paired(owner, phone, "manage")
        assert scopes == ["chat", "files", "manage"]
        # Past the scope check: whatever else the route answers, it is not `scope_denied`.
        for method, path in (
            ("POST", "/api/v1/agents"),
            ("PATCH", "/api/v1/agents/1"),
            ("POST", "/api/v1/agents/1/duplicate"),
            ("GET", "/api/v1/threads/1/files"),
            ("POST", "/api/v1/rooms"),
            ("PATCH", "/api/v1/rooms/1"),
            ("DELETE", "/api/v1/rooms/1"),
            ("PATCH", "/api/v1/rooms/1/members/1"),
        ):
            reply = await phone.request(method, path, headers=bearer, json={"name": "x"} if method != "GET" else None)
            detail = reply.json().get("detail") if reply.status_code == 403 else None
            assert not (isinstance(detail, dict) and detail.get("error_code") == "scope_denied"), (method, path)
        for method, path in (
            ("DELETE", "/api/v1/agents/1"),
            ("GET", "/api/v1/threads/1/files/zip"),
            ("POST", "/api/v1/agents/import"),
            ("GET", "/api/v1/usage"),
        ):
            denied = await phone.request(method, path, headers=bearer)
            assert denied.status_code == 403 and error_code(denied) == "scope_denied", (method, path)


@pytest.mark.parametrize("scope", ["chat", "files"])
async def test_a_chat_or_files_device_cannot_create_or_edit_agents_or_rooms(app, factory, monkeypatch, scope):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    await set_owner(factory)
    async with client(app) as owner, client(app, peer=("198.51.100.40", 1)) as phone:
        _, bearer = await paired(owner, phone, scope)
        for method, path in (
            ("POST", "/api/v1/agents"),
            ("PATCH", "/api/v1/agents/1"),
            ("POST", "/api/v1/agents/1/duplicate"),
            ("POST", "/api/v1/rooms"),
            ("PATCH", "/api/v1/rooms/1"),
            ("DELETE", "/api/v1/rooms/1"),
            ("PATCH", "/api/v1/rooms/1/members/1"),
        ):
            denied = await phone.request(method, path, headers=bearer, json={"name": "x"})
            assert denied.status_code == 403 and error_code(denied) == "scope_denied", (method, path)


async def test_an_unknown_pairing_scope_is_refused(app, factory):
    await set_owner(factory)
    async with client(app) as owner:
        csrf = (await login(owner))["csrf_token"]
        reply = await owner.post("/api/v1/auth/pairing-codes", json={"scope": "root"}, headers={"X-CSRF-Token": csrf})
        assert reply.status_code == 422
