from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from app.composio_tools import TOOLS
from app.routers.routines import _validated_grants
from app.schemas.routine import ConnectedAppGrant, RoutineCreateRequest
READ = next(t for t in TOOLS if t.kind == "read")
WRITE = next(t for t in TOOLS if t.kind == "write")


def test_grants_default_off_and_only_exact_actions():
    assert RoutineCreateRequest(agent_id=1, name="a", prompt="b").connected_app_grants == []
    for tool in (WRITE.name, "gmail_create_draft_reply", "unknown", "*"):
        with pytest.raises(ValidationError):
            ConnectedAppGrant(tool=tool, account_id="ca_test")


async def test_validate_exact_account_and_agent_scope(monkeypatch):
    from app.services import composio_service
    agent = SimpleNamespace(owner_id="owner", archived_at=None, connector_scopes={READ.app: "read"},
                            connector_account_scopes={READ.app: ["ca_test"]})
    class DB:
        async def get(self, *args):
            return agent
    async def accounts(*args):
        return [SimpleNamespace(id="ca_test", toolkit=READ.app, status="ACTIVE")]
    monkeypatch.setattr(composio_service, "accounts", accounts)
    grant = ConnectedAppGrant(tool=READ.name, account_id="ca_test")
    assert await _validated_grants(DB(), "owner", 1, [grant]) == [grant.model_dump()]
    for grants in ([grant, grant], [grant.model_copy(update={"account_id": "ca_other"})], None):
        with pytest.raises(HTTPException):
            await _validated_grants(DB(), "owner", 1, grants)
    agent.connector_scopes = {}
    with pytest.raises(HTTPException):
        await _validated_grants(DB(), "owner", 1, [grant])

from tests.routers.test_routines_api import (  # noqa: E402,F401
    api, agent, scheduler, local_enabled, agent_args, routine_cleanup, make,
    sessions, owner, rt, cleanup, cli,
)


async def test_person_grant_round_trip_and_import_off(api, agent, sessions, monkeypatch):
    from app.db.models import Agent
    from app.services import composio_service
    async with sessions() as db:
        stored = await db.get(Agent, agent.id)
        stored.connector_scopes = {READ.app: "read"}
        stored.connector_account_scopes = {READ.app: ["ca_test"]}
        await db.commit()
    async def accounts(*args):
        return [SimpleNamespace(id="ca_test", toolkit=READ.app, status="ACTIVE")]
    monkeypatch.setattr(composio_service, "accounts", accounts)
    grants = [{"tool": READ.name, "account_id": "ca_test"}]
    created = await make(api, agent, connected_app_grants=grants)
    assert created["connected_app_grants"] == grants
    path = f"/api/v1/routines/{created['id']}"
    assert (await api.get(path)).json()["connected_app_grants"] == grants
    document = (await api.get(path + "/export")).json()
    assert "connected_app_grants" not in document
    document["connected_app_grants"] = grants
    imported = await api.post("/api/v1/routines/import", json={"agent_id": agent.id, "documents": [document]})
    assert imported.status_code == 201, imported.text
    assert imported.json()[0]["connected_app_grants"] == []
    changed = await api.patch(path, json={"connected_app_grants": []})
    assert changed.status_code == 200, changed.text
    assert changed.json()["connected_app_grants"] == []


async def test_send_email_requires_agent_write_scope(api, agent, sessions, monkeypatch):
    from app.db.models import Agent
    from app.services import composio_service
    async def accounts(*args):
        return [SimpleNamespace(id="ca_mail", toolkit="gmail", status="ACTIVE")]
    monkeypatch.setattr(composio_service, "accounts", accounts)
    async def scope(level):
        async with sessions() as db:
            stored = await db.get(Agent, agent.id)
            stored.connector_scopes = {"gmail": level}
            stored.connector_account_scopes = {"gmail": ["ca_mail"]}
            await db.commit()
    send = {"tool": "gmail_send_email", "account_id": "ca_mail"}
    body = {"agent_id": agent.id, "name": "Send mail", "prompt": "Review mail", "connected_app_grants": [send]}
    await scope("read")
    assert (await api.post("/api/v1/routines", json=body)).status_code == 422
    await scope("write")
    result = await api.post("/api/v1/routines", json=body)
    assert result.status_code == 201, result.text
    assert result.json()["connected_app_grants"] == [send]


async def test_action_receipts_are_run_and_owner_scoped(api, agent, sessions, owner):
    from app.db.models import Routine, RoutineRun, RoutineAppAction
    created = await make(api, agent)
    other = await make(api, agent, name="Other routine")
    async with sessions() as db:
        run = RoutineRun(routine_id=created["id"], trigger="manual", state="completed")
        db.add(run)
        await db.flush()
        for index in range(105):
            db.add(RoutineAppAction(run_id=run.id, tool="gmail_send_email", account_id="ca_mail", status="completed", result={"message_id": str(index)}))
        await db.commit()
        run_id = run.id
    path = f"/api/v1/routines/{created['id']}/runs/{run_id}/app-actions"
    result = await api.get(path)
    assert result.status_code == 200, result.text
    receipts = result.json()
    assert len(receipts) == 100
    assert receipts[0]["result"] == {"message_id": "104"}
    assert "request_key" not in receipts[0]
    assert (await api.get(f"/api/v1/routines/{other['id']}/runs/{run_id}/app-actions")).status_code == 404
    async with sessions() as db:
        routine = await db.get(Routine, created["id"])
        routine.owner_id = "another-owner"
        await db.commit()
    assert (await api.get(path)).status_code == 404
    async with sessions() as db:
        routine = await db.get(Routine, created["id"])
        routine.owner_id = owner
        await db.commit()
