from app.db.models import Routine, RoutineRun
from app.schemas.routine import RoutineCreateRequest
from app.services import routine_service
from types import SimpleNamespace
from tests.routers.test_routines_api import (  # noqa: F401
    api, agent, scheduler, local_enabled, agent_args, routine_cleanup, make,
    sessions, owner, rt, cleanup, cli,
)


def test_new_routines_require_owner_selection():
    assert RoutineCreateRequest(agent_id=1, name="R", prompt="P").uninterrupted_access is False


async def test_person_can_enable_revoke_and_import_cannot_authorize(api, agent):
    created = await make(api, agent, uninterrupted_access=True)
    assert created["uninterrupted_access"] is True
    path = f"/api/v1/routines/{created['id']}"
    assert (await api.patch(path, json={"name": "Renamed"})).json()["uninterrupted_access"] is True
    document = (await api.get(path + "/export")).json()
    assert "uninterrupted_access" not in document
    document["uninterrupted_access"] = True
    imported = await api.post("/api/v1/routines/import", json={"agent_id": agent.id, "documents": [document]})
    assert imported.status_code == 201
    assert imported.json()[0]["uninterrupted_access"] is False
    revoked = await api.patch(path, json={"uninterrupted_access": False})
    assert revoked.status_code == 200 and revoked.json()["uninterrupted_access"] is False


async def test_internal_create_cannot_assign_uninterrupted_access(sessions, owner, agent):
    async with sessions() as db:
        routine = await routine_service.create_routine(db, owner, {"agent_id": agent.id, "name": "R", "prompt": "P",
                                                                 "uninterrupted_access": True})
        assert routine.uninterrupted_access is False
        assert (await db.get(Routine, routine.id)).uninterrupted_access is False


async def test_run_api_omits_the_internal_capability_snapshot(api, agent, sessions):
    created = await make(api, agent, uninterrupted_access=True)
    async with sessions() as db:
        occurrence = RoutineRun(routine_id=created["id"], trigger="manual", state="completed", uninterrupted_access=True,
                                capability_snapshot={"accounts": {"gmail": ["internal-account"]}})
        db.add(occurrence)
        await db.commit()
    response = await api.get("/api/v1/routines/runs")
    assert response.status_code == 200
    [run] = response.json()
    assert run["uninterrupted_access"] is True
    assert "capability_snapshot" not in run
    assert "internal-account" not in response.text


async def test_inactive_stale_narrow_grants_do_not_block_full_mode_and_are_revalidated_when_needed(api, agent, sessions, monkeypatch):
    from app.services import agent_store, composio_service
    grant = {"tool": "github_get_authenticated_user", "account_id": "ca_stale"}
    async with sessions() as db:
        await agent_store.update_agent(db, agent.id, connector_scopes={"github": "read"},
                                       connector_account_scopes={"github": ["ca_stale"]})
        other = await agent_store.create_agent(db, owner_id=agent.owner_id, name="Other")
    async def accounts(*args):
        return [SimpleNamespace(id="ca_stale", toolkit="github", status="ACTIVE")]
    monkeypatch.setattr(composio_service, "accounts", accounts)
    created = await make(api, agent, connected_app_grants=[grant])
    path = f"/api/v1/routines/{created['id']}"
    async def disconnected(*args):
        return []
    monkeypatch.setattr(composio_service, "accounts", disconnected)
    enabled = await api.patch(path, json={"agent_id": agent.id, "uninterrupted_access": True, "connected_app_grants": [grant]})
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["connected_app_grants"] == [grant]
    assert (await api.patch(path, json={"name": "Still full"})).status_code == 200
    disabled = await api.patch(path, json={"uninterrupted_access": False})
    assert disabled.status_code == 422 and disabled.json()["detail"]["error_code"] == "invalid_app_grant"
    changed_agent = await api.patch(path, json={"agent_id": other.id, "uninterrupted_access": True})
    assert changed_agent.status_code == 422
    cleared = await api.patch(path, json={"uninterrupted_access": False, "connected_app_grants": []})
    assert cleared.status_code == 200 and cleared.json()["uninterrupted_access"] is False
