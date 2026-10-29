"""/api/v1/integrations/composio through the real auth middleware and routes,
with a fake Composio behind httpx.MockTransport (no network)."""
import json
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import delete, select

from app.core.config import settings
from app.db.models.user_credential import UserCredential
from app.routers import integrations
from app.services.composio_client import ComposioClient
from tests.auth.test_auth_api import (  # noqa: F401
    app, factory, auth_settings, client, login, pairing_code, set_owner,
)

KEY = "ak_TESTKEY_abcdef123456"
OTHER_KEY = "ak_OTHERKEY_abcdef654321"
TOKEN = "gho_SECRET_OAUTH_TOKEN"
PATH = "/api/v1/integrations/composio"


class FakeComposio:
    """Just enough of Composio v3.1: sessions, links, accounts, delete."""

    def __init__(self):
        self.calls: list[tuple[str, str, str | None]] = []
        self.accepted_keys = {KEY, OTHER_KEY}
        self.accounts: list[dict] = []
        self.sessions = 0
        self.known_sessions: set[str] = set()
        self.session_users: dict[str, str] = {}
        self.link_url = "https://connect.composio.dev/link/lk_fake"
        self.fail_next: dict[str, int] = {}
        self.deleted: list[str] = []
        self.toolkits = {slug: {"slug": slug, "name": slug.title(), "type": "native", "no_auth": False, "is_local_toolkit": False,
                                "deprecated": {"toolkitId": slug}, "composio_managed_auth_schemes": ["oauth2"],
                                "meta": {"description": f"About {slug}.", "logo": "https://logos.composio.dev/api/x.png",
                                         "categories": [{"id": "c", "name": "Communication"}], "tools_count": 3}}
                         for slug in ("github", "gmail", "googlecalendar", "slack", "notion", "composio")}

    def handler(self, request: httpx.Request) -> httpx.Response:
        key = request.headers.get("x-api-key")
        route = f"{request.method} {request.url.path.removeprefix('/api/v3.1')}"
        self.calls.append((route, key, request.url.query.decode() or None))
        if key not in self.accepted_keys:
            return httpx.Response(401, json={"error": {"message": "Invalid API key"}})
        for pattern, status in list(self.fail_next.items()):
            if route.startswith(pattern):
                del self.fail_next[pattern]
                return httpx.Response(status, json={"error": {"message": "boom " + key}})
        if route == "POST /tool_router/session":
            self.sessions += 1
            session_id = f"sess_{self.sessions}"
            self.known_sessions.add(session_id)
            self.session_users[session_id] = json.loads(request.content)["user_id"]
            return httpx.Response(201, json={"session_id": session_id, "mcp": {"url": "https://secret.example/mcp"}})
        if route.startswith("POST /tool_router/session/") and route.endswith("/link"):
            session_id = route.split("/")[3]
            if session_id not in self.known_sessions:
                return httpx.Response(404, json={"error": {"message": "no such session"}})
            body = json.loads(request.content)
            account = {
                "id": f"ca_{len(self.accounts) + 1}", "toolkit": {"slug": body["toolkit"]}, "alias": body["alias"],
                "status": "INITIATED", "user_id": self.session_users[session_id],
                "created_at": "2026-10-26T10:00:00Z", "updated_at": "2026-10-26T10:00:00Z",
                "data": {"access_token": TOKEN, "scope": "repo"}, "state": {"val": {"access_token": TOKEN}},
            }
            self.accounts.append(account)
            return httpx.Response(201, json={
                "link_token": "lk", "redirect_url": self.link_url, "connected_account_id": account["id"],
            })
        if route == "GET /toolkits":
            return httpx.Response(200, json={"items": list(self.toolkits.values()), "next_cursor": None, "current_page": 1,
                                             "total_pages": 1, "total_items": len(self.toolkits)})
        if route.startswith("GET /toolkits/"):
            found = self.toolkits.get(route.rsplit("/", 1)[1])
            return httpx.Response(200, json=found) if found else httpx.Response(404, json={"error": {"message": "no such app"}})
        if route == "GET /connected_accounts":
            wanted = request.url.params.get("toolkit_slugs")
            items = [a for a in self.accounts if not wanted or a["toolkit"]["slug"] == wanted]
            return httpx.Response(200, json={"items": items, "next_cursor": None})
        if route.startswith("DELETE /connected_accounts/"):
            account_id = route.rsplit("/", 1)[1]
            self.deleted.append(account_id)
            self.accounts = [a for a in self.accounts if a["id"] != account_id]
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404, json={"error": {"message": "unexpected " + route}})

    def activate(self, account_id: str) -> None:
        for account in self.accounts:
            if account["id"] == account_id:
                account["status"] = "ACTIVE"


@pytest.fixture
def composio(app, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    fake = FakeComposio()
    app.dependency_overrides[integrations.get_client_factory] = lambda: (
        lambda key: ComposioClient(key, transport=httpx.MockTransport(fake.handler))
    )
    return fake


@pytest.fixture
async def owner_id(factory, monkeypatch):
    owner = "od_composio_" + uuid4().hex
    monkeypatch.setattr(integrations, "LOCAL_OWNER_ID", owner)
    yield owner
    async with factory() as db:
        await db.execute(delete(UserCredential).where(UserCredential.user_id == owner))
        await db.commit()


@pytest.fixture
async def admin(app, factory, composio, owner_id):
    await set_owner(factory)
    async with client(app) as api:
        session = await login(api)
        api.headers["X-CSRF-Token"] = session["csrf_token"]
        yield api


def code_of(response) -> str:
    return response.json()["detail"]["error_code"]


async def stored(factory, owner):
    async with factory() as db:
        return (await db.execute(select(UserCredential).where(UserCredential.user_id == owner))).scalars().all()


async def test_key_is_checked_stored_encrypted_and_never_returned(admin, factory, owner_id, composio):
    assert (await admin.get(PATH)).json()["configured"] is False
    saved = await admin.put(f"{PATH}/key", json={"api_key": KEY})
    assert saved.status_code == 200, saved.text
    assert saved.json()["configured"] is True
    assert saved.headers["cache-control"] == "no-store"
    assert KEY not in saved.text and KEY not in (await admin.get(PATH)).text
    (row,) = await stored(factory, owner_id)
    assert row.provider == "integration:composio" and KEY not in row.ciphertext
    assert composio.calls[0][1] == KEY  # checked with Composio before saving
    assert (await admin.delete(f"{PATH}/key")).status_code == 204
    assert (await admin.get(PATH)).json()["configured"] is False
    assert await stored(factory, owner_id) == []


@pytest.mark.parametrize("body", [
    {"api_key": "sk-not-composio-12345"}, {"api_key": "ak_short"}, {"api_key": "ak_has space 12345678"},
    {"api_key": 12345}, {"api_key": KEY, "extra": 1}, {}, ["ak_x"], "ak_x",
])
async def test_a_malformed_key_is_refused_without_echoing_it(admin, body, composio):
    response = await admin.put(f"{PATH}/key", json=body)
    assert response.status_code == 422
    assert code_of(response) == "invalid_composio_key"
    assert "sk-not-composio" not in response.text and "has space" not in response.text
    assert composio.calls == []


async def test_a_body_that_is_not_json_or_too_large_is_refused(admin, composio):
    assert (await admin.put(f"{PATH}/key", content=b"not json")).status_code == 422
    big = json.dumps({"api_key": "ak_" + "a" * 5000}).encode()
    response = await admin.put(f"{PATH}/key", content=big, headers={"content-type": "application/json"})
    assert response.status_code == 422 and "aaaa" not in response.text
    assert composio.calls == []


async def test_a_key_composio_rejects_is_not_saved(admin, factory, owner_id, composio):
    composio.accepted_keys = set()
    response = await admin.put(f"{PATH}/key", json={"api_key": KEY})
    assert response.status_code == 422 and code_of(response) == "composio_key_rejected"
    assert KEY not in response.text
    assert await stored(factory, owner_id) == []


async def test_replacing_the_key_keeps_the_user_and_drops_the_session(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    await admin.post(f"{PATH}/connect", json={"toolkit": "github"})
    assert composio.sessions == 1
    await admin.put(f"{PATH}/key", json={"api_key": OTHER_KEY})
    await admin.post(f"{PATH}/connect", json={"toolkit": "gmail"})
    assert composio.sessions == 2  # the old session belonged to the old project
    users = {query.split("user_ids=")[1].split("&")[0] for route, _key, query in composio.calls if query and "user_ids=" in query}
    assert len(users) == 1


async def test_nothing_works_without_a_key(admin):
    for call in (admin.get(f"{PATH}/accounts"), admin.post(f"{PATH}/connect", json={"toolkit": "github"}),
                 admin.delete(f"{PATH}/accounts/ca_1")):
        response = await call
        assert response.status_code == 409 and code_of(response) == "composio_not_configured"


async def test_connect_list_and_disconnect(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    link = await admin.post(f"{PATH}/connect", json={"toolkit": "github", "alias": "work"})
    assert link.status_code == 201, link.text
    assert link.headers["cache-control"] == "no-store"
    assert link.json() == {"redirect_url": composio.link_url, "account_id": "ca_1", "expires_in_seconds": 600}

    pending = (await admin.get(f"{PATH}/accounts")).json()
    assert [(a["toolkit"], a["alias"], a["status"]) for a in pending] == [("github", "work", "INITIATED")]
    composio.activate("ca_1")
    listed = await admin.get(f"{PATH}/accounts")
    assert listed.json()[0]["status"] == "ACTIVE"
    # The raw OAuth token is in Composio's answer and must never reach the browser.
    assert TOKEN not in listed.text and "access_token" not in listed.text and "scope" not in listed.text
    assert set(listed.json()[0]) == {"id", "toolkit", "alias", "status", "created_at", "updated_at"}

    assert (await admin.delete(f"{PATH}/accounts/ca_1")).status_code == 204
    assert composio.deleted == ["ca_1"]
    assert (await admin.get(f"{PATH}/accounts")).json() == []


async def test_connect_reuses_one_session_and_generates_a_name(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    await admin.post(f"{PATH}/connect", json={"toolkit": "github"})
    await admin.post(f"{PATH}/connect", json={"toolkit": "gmail"})
    assert composio.sessions == 1
    assert all(a["alias"].startswith("od-") for a in composio.accounts)


async def test_a_session_composio_forgot_is_replaced_once(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    await admin.post(f"{PATH}/connect", json={"toolkit": "github"})
    composio.known_sessions.clear()
    response = await admin.post(f"{PATH}/connect", json={"toolkit": "gmail"})
    assert response.status_code == 201 and composio.sessions == 2


@pytest.mark.parametrize("body, code", [
    ({"toolkit": "twitter"}, "unsupported_app"),
    ({"toolkit": "github", "alias": "bad/alias"}, "invalid_alias"),
    ({"toolkit": "github", "alias": " lead"}, "invalid_alias"),
])
async def test_connect_validates_the_app_and_name(admin, composio, body, code):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    response = await admin.post(f"{PATH}/connect", json=body)
    assert response.status_code == 422 and code_of(response) == code
    assert composio.sessions == 0


async def test_a_name_in_use_and_the_per_app_limit_are_refused(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    assert (await admin.post(f"{PATH}/connect", json={"toolkit": "github", "alias": "Work"})).status_code == 201
    again = await admin.post(f"{PATH}/connect", json={"toolkit": "github", "alias": "work"})
    assert again.status_code == 409 and code_of(again) == "alias_in_use"
    for name in ("a", "b", "c", "d"):
        assert (await admin.post(f"{PATH}/connect", json={"toolkit": "github", "alias": name})).status_code == 201
    full = await admin.post(f"{PATH}/connect", json={"toolkit": "github", "alias": "e"})
    assert full.status_code == 409 and code_of(full) == "too_many_accounts"


@pytest.mark.parametrize("url", [
    "https://evil.example/link", "http://connect.composio.dev/link", "https://composio.dev.evil.example/x",
    "https://user:pw@connect.composio.dev/x", "https://connect.composio.dev:8443/x", "javascript:alert(1)", "",
])
async def test_a_connect_link_off_composio_is_never_returned(admin, composio, url):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    composio.link_url = url
    response = await admin.post(f"{PATH}/connect", json={"toolkit": "github"})
    assert response.status_code == 502 and code_of(response) == "composio_bad_response"
    assert url not in response.text or url == ""


async def test_disconnect_only_touches_accounts_of_this_installation(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    response = await admin.delete(f"{PATH}/accounts/ca_999")
    assert response.status_code == 404 and code_of(response) == "account_not_found"
    assert composio.deleted == []
    assert (await admin.delete(f"{PATH}/accounts/not%20an%20id")).status_code == 404
    assert composio.deleted == []


async def test_a_failed_removal_is_not_reported_as_done(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    await admin.post(f"{PATH}/connect", json={"toolkit": "github"})
    composio.fail_next["DELETE /connected_accounts/"] = 503
    response = await admin.delete(f"{PATH}/accounts/ca_1")
    assert response.status_code == 502 and code_of(response) == "composio_unavailable"
    assert "not removed" in response.json()["detail"]["message"]
    assert [a["id"] for a in composio.accounts] == ["ca_1"]
    assert (await admin.delete(f"{PATH}/accounts/ca_1")).status_code == 204  # retry works


async def test_a_key_composio_stops_accepting_is_reported(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    composio.accepted_keys = set()
    response = await admin.get(f"{PATH}/accounts")
    assert response.status_code == 409 and code_of(response) == "composio_key_rejected"
    assert KEY not in response.text


async def test_composio_errors_never_echo_the_key(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    composio.fail_next["GET /connected_accounts"] = 400  # the fake's message contains the key
    response = await admin.get(f"{PATH}/accounts")
    assert response.status_code == 422
    # Composio's own short message is shown, so a message that contained the key is the one case to guard.
    assert KEY not in response.text


async def test_a_paired_chat_device_and_signed_out_callers_are_refused(app, factory, composio, owner_id):
    await set_owner(factory)
    async with client(app) as anonymous:
        assert (await anonymous.get(PATH)).status_code == 401
    async with client(app) as owner_client, client(app) as phone:
        session = await login(owner_client)
        code = await pairing_code(owner_client, session["csrf_token"], scope="chat")
        token = (await phone.post("/api/v1/auth/pair", json={"code": code})).json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        for method, path, body in (
            ("GET", PATH, None), ("PUT", f"{PATH}/key", {"api_key": KEY}), ("DELETE", f"{PATH}/key", None),
            ("GET", f"{PATH}/accounts", None), ("POST", f"{PATH}/connect", {"toolkit": "github"}),
            ("DELETE", f"{PATH}/accounts/ca_1", None),
        ):
            response = await phone.request(method, path, headers=headers, json=body)
            assert response.status_code == 403, (method, path, response.text)
    assert composio.calls == []


async def test_changes_need_the_csrf_token(app, factory, composio, owner_id):
    await set_owner(factory)
    async with client(app) as api:
        await login(api)
        assert (await api.put(f"{PATH}/key", json={"api_key": KEY})).status_code == 403
        assert (await api.delete(f"{PATH}/key")).status_code == 403
    assert composio.calls == []


async def test_without_a_key_the_catalog_is_a_starter_list_and_never_calls_composio(admin, composio):
    response = await admin.get(f"{PATH}/catalog")
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["source"] == "starter" and body["complete"] is False and body["next_cursor"] is None
    apps = {entry["app"]: entry for entry in body["apps"]}
    assert {"github", "gmail", "googlecalendar", "slack", "notion"} <= set(apps)
    assert any(tool["kind"] == "write" for tool in apps["github"]["curated_tools"])
    assert [tool["name"] for tool in apps["googlecalendar"]["curated_tools"] if tool["kind"] == "write"] == ["googlecalendar_create_event"]
    assert apps["slack"]["agent_actions"] == "generic" and apps["slack"]["curated_tools"] == []
    assert composio.calls == []


async def test_with_a_key_the_catalog_is_composios_and_search_and_paging_pass_through(admin, composio):
    from app import composio_catalog
    composio_catalog.invalidate()
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    body = (await admin.get(f"{PATH}/catalog")).json()
    assert body["source"] == "composio" and body["complete"] is True and body["error"] is None
    assert [a["app"] for a in body["apps"]] == ["github", "gmail", "googlecalendar", "slack", "notion", "composio"]
    assert {a["app"]: a["agent_actions"] for a in body["apps"]}["composio"] == "unavailable"
    assert [a["app"] for a in (await admin.get(f"{PATH}/catalog", params={"search": "notion"})).json()["apps"]] == ["notion"]
    paged = (await admin.get(f"{PATH}/catalog", params={"limit": 2})).json()
    assert len(paged["apps"]) == 2 and paged["next_cursor"] == "o2" and paged["total"] == 6
    assert (await admin.get(f"{PATH}/catalog", params={"limit": 0})).status_code == 422
    # The key never comes back, and the catalog is cached: this second page did not ask Composio again.
    assert KEY not in (await admin.get(f"{PATH}/catalog")).text
    assert len([c for c in composio.calls if c[0] == "GET /toolkits"]) == 1


async def test_removing_the_key_drops_the_cached_catalog(admin, composio):
    from app import composio_catalog
    composio_catalog.invalidate()
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    await admin.get(f"{PATH}/catalog")
    assert (await admin.delete(f"{PATH}/key")).status_code == 204
    assert (await admin.get(f"{PATH}/catalog")).json()["source"] == "starter"


async def test_a_catalog_failure_is_a_labelled_fallback_not_an_error_page(admin, composio):
    from app import composio_catalog
    composio_catalog.invalidate()
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    composio_catalog.invalidate()
    composio.fail_next["GET /toolkits"] = 503
    body = (await admin.get(f"{PATH}/catalog")).json()
    assert body["source"] == "starter" and body["error"] == "unavailable" and body["apps"]


async def test_any_app_composio_lists_can_be_connected(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    link = await admin.post(f"{PATH}/connect", json={"toolkit": "slack", "alias": "team"})
    assert link.status_code == 201, link.text
    assert [(a["toolkit"], a["alias"]) for a in (await admin.get(f"{PATH}/accounts")).json()] == [("slack", "team")]


@pytest.mark.parametrize("toolkit", ["made_up_app", "Slack", "../x", "a b", "", "x" * 65, "composio", "codeinterpreter"])
async def test_an_app_composio_does_not_list_or_a_blocked_one_is_refused(admin, composio, toolkit):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    response = await admin.post(f"{PATH}/connect", json={"toolkit": toolkit})
    assert response.status_code == 422
    assert composio.accounts == []


async def test_connecting_an_app_does_not_give_any_agent_access(admin, composio):
    await admin.put(f"{PATH}/key", json={"api_key": KEY})
    await admin.post(f"{PATH}/connect", json={"toolkit": "notion"})
    agents = (await admin.get("/api/v1/agents")).json()
    assert all(not agent.get("connector_scopes") for agent in agents)


async def test_the_catalog_is_owner_only(app, factory, composio, owner_id):
    async with client(app) as anonymous:
        assert (await anonymous.get(f"{PATH}/catalog")).status_code in (401, 403)
