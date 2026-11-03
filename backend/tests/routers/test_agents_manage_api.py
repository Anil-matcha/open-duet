"""What a paired `manage` phone may and may not set when it creates, edits or duplicates an agent. The
scope itself (which routes it reaches) is tested in tests/auth/test_manage_scope.py; here the handlers run
for a principal without admin access, and for admin and the loopback owner, which are unrestricted."""

from uuid import uuid4

import pytest
from fastapi import FastAPI

from app.auth.policy import Principal
from app.routers.agents import get_runtime as agents_runtime
from app.routers.agents import router as agents_router
from tests.routers.test_agents_api import agent_cleanup, client_for, code_of, local_enabled  # noqa: F401
from tests.services.thread_harness import cleanup, cli, owner, rt, sessions  # noqa: F401

PHONE = Principal(kind="device", scopes=("chat", "manage"), session_id=1, label="Phone")
ADMIN = Principal(kind="browser", scopes=("admin", "chat", "files"), session_id=2)


class AsPrincipal:
    """Plays the auth middleware: puts the principal where `principal_of` looks."""

    def __init__(self, app, principal):
        self.app, self.principal = app, principal

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and self.principal is not None:
            scope.setdefault("state", {})["auth"] = self.principal
        await self.app(scope, receive, send)


def app_as(rt, principal) -> FastAPI:
    app = FastAPI()
    app.include_router(agents_router, prefix="/api/v1")
    app.dependency_overrides[agents_runtime] = lambda: rt
    app.add_middleware(AsPrincipal, principal=principal)
    return app


@pytest.fixture
async def phone(rt, cli):  # `cli` keeps every folder an agent gets under tmp_path
    async with client_for(app_as(rt, PHONE)) as client:
        yield client


@pytest.fixture
async def admin(rt, cli):
    async with client_for(app_as(rt, ADMIN)) as client:
        yield client


def named(**body):
    body.setdefault("name", "Agent " + uuid4().hex[:6])
    return body


async def made(client, **body):
    response = await client.post("/api/v1/agents", json=named(**body))
    assert response.status_code == 201, response.text
    return response.json()


# --- create ---------------------------------------------------------------------------------------


async def test_a_phone_creates_an_agent_that_asks_first_in_its_own_folder(phone):
    agent = await made(phone, title="Reviewer", instructions="Be brief.", starter_notes="- Uses pnpm")
    assert agent["approval_mode"] == "ask"
    assert agent["workspace_path"] is None  # the agent's own folder (made when it first runs), not one the phone chose
    assert agent["instructions"] == "Be brief."


async def test_a_phone_may_make_an_agent_that_only_plans(phone):
    assert (await made(phone, approval_mode="plan"))["approval_mode"] == "plan"


@pytest.mark.parametrize(
    "body",
    [
        {"approval_mode": "accept_edits"},
        {"workspace_path": "/"},
        {"workspace_path": "~"},
        {"make_lead": True},
    ],
)
async def test_a_phone_cannot_create_an_agent_with_a_loosened_or_chosen_setting(phone, body):
    response = await phone.post("/api/v1/agents", json=named(**body))
    assert response.status_code == 403 and code_of(response) == "field_requires_admin"
    assert (await phone.get("/api/v1/agents")).json() == []


async def test_the_guard_runs_before_any_other_check(phone):
    # A bad engine and a refused field together: the refusal is about the field, so a phone learns nothing else.
    response = await phone.post("/api/v1/agents", json=named(provider="nope", approval_mode="accept_edits"))
    assert response.status_code == 403 and code_of(response) == "field_requires_admin"


async def test_admin_still_sets_everything(admin, tmp_path):
    agent = await made(admin, approval_mode="accept_edits", workspace_path=str(tmp_path))
    assert agent["approval_mode"] == "accept_edits"
    assert agent["workspace_path"] == str(tmp_path)


# --- edit -----------------------------------------------------------------------------------------


async def test_a_phone_edits_the_text_the_model_and_the_archive_state(phone):
    agent = await made(phone)
    path = f"/api/v1/agents/{agent['id']}"
    changed = await phone.patch(
        path, json={"name": "Renamed " + uuid4().hex[:4], "title": "T", "description": "D", "instructions": "New.", "pinned": True}
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["instructions"] == "New." and changed.json()["pinned"] is True
    assert (await phone.patch(path, json={"approval_mode": "plan"})).json()["approval_mode"] == "plan"
    assert (await phone.patch(path, json={"archived": True})).json()["archived_at"] is not None
    assert (await phone.patch(path, json={"archived": False})).json()["archived_at"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"approval_mode": "accept_edits"},
        {"workspace_path": "/"},
        {"workspace_path": None},
        {"connector_scopes": {"github": "read"}},
        {"connector_scopes": {}},
        {"connector_account_scopes": {}},
        {"make_lead": True},
        {"make_lead": False},
    ],
)
async def test_a_phone_cannot_change_what_stays_on_the_web(phone, body):
    agent = await made(phone)
    response = await phone.patch(f"/api/v1/agents/{agent['id']}", json=body)
    assert response.status_code == 403 and code_of(response) == "field_requires_admin"


async def test_a_phone_may_tighten_an_agent_set_to_accept_edits_but_not_set_it_again(phone, admin):
    agent = await made(admin, approval_mode="accept_edits")
    path = f"/api/v1/agents/{agent['id']}"
    # Editing other fields of such an agent is fine, and so is sending the mode it already has.
    assert (await phone.patch(path, json={"title": "Edited"})).status_code == 200
    assert (await phone.patch(path, json={"approval_mode": "accept_edits"})).status_code == 200
    assert (await phone.patch(path, json={"approval_mode": "ask"})).json()["approval_mode"] == "ask"
    again = await phone.patch(path, json={"approval_mode": "accept_edits"})
    assert again.status_code == 403 and code_of(again) == "field_requires_admin"


async def test_admin_still_edits_everything(admin, tmp_path):
    agent = await made(admin)
    changed = await admin.patch(
        f"/api/v1/agents/{agent['id']}", json={"approval_mode": "accept_edits", "workspace_path": str(tmp_path)}
    )
    assert changed.status_code == 200
    assert changed.json()["approval_mode"] == "accept_edits" and changed.json()["workspace_path"] == str(tmp_path)


# --- duplicate ------------------------------------------------------------------------------------


async def test_a_phone_duplicate_of_a_loosened_agent_is_not_loosened(phone, admin, tmp_path):
    source = await made(admin, approval_mode="accept_edits", workspace_path=str(tmp_path), title="Source", instructions="Keep.")
    copy = (await phone.post(f"/api/v1/agents/{source['id']}/duplicate")).json()
    assert copy["id"] != source["id"]
    assert copy["approval_mode"] == "ask"
    assert copy["workspace_path"] is None  # its own folder, never the source's
    # The rest is copied as it is.
    assert copy["title"] == "Source" and copy["instructions"] == "Keep."


@pytest.mark.parametrize("mode", ["ask", "plan"])
async def test_a_phone_duplicate_keeps_a_mode_that_is_already_safe(phone, admin, mode):
    source = await made(admin, approval_mode=mode)
    assert (await phone.post(f"/api/v1/agents/{source['id']}/duplicate")).json()["approval_mode"] == mode


async def test_an_admin_duplicate_is_an_exact_copy(admin, tmp_path):
    source = await made(admin, approval_mode="accept_edits", workspace_path=str(tmp_path))
    copy = (await admin.post(f"/api/v1/agents/{source['id']}/duplicate")).json()
    assert copy["approval_mode"] == "accept_edits" and copy["workspace_path"] == str(tmp_path)


async def test_a_phone_gets_not_found_for_an_agent_that_does_not_exist(phone):
    response = await phone.patch("/api/v1/agents/999999", json={"title": "x"})
    assert response.status_code == 404
    assert (await phone.post("/api/v1/agents/999999/duplicate")).status_code == 404
