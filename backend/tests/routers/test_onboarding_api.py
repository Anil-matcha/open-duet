"""Onboarding state is owner scoped, versioned, and replay safe."""

import asyncio
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete, select

from app.auth.routes import require_admin
from app.db.models import Agent, AppSetting, Event, Thread, Turn
from app.routers.agents import get_runtime
from app.routers import onboarding as onboarding_router
from app.routers.onboarding import router
from app.services.local_access_policy import require_local_access
from app.services import onboarding as state_store
from app.services.onboarding import setting_key
from tests.services.thread_harness import owner, rt, sessions  # noqa: F401


def app_for(runtime):
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_runtime] = lambda: runtime
    app.dependency_overrides[require_admin] = lambda: object()
    app.dependency_overrides[require_local_access] = lambda: None
    return app


@pytest.fixture
async def api(rt, sessions, owner):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app_for(rt)), base_url="http://localhost") as client:
        yield client
    async with sessions() as db:
        thread_ids = select(Thread.id).where(Thread.owner_id == owner)
        turn_ids = select(Turn.id).where(Turn.thread_id.in_(thread_ids))
        await db.execute(delete(Event).where(Event.thread_id.in_(thread_ids)))
        await db.execute(delete(Turn).where(Turn.id.in_(turn_ids)))
        await db.execute(delete(Thread).where(Thread.owner_id == owner))
        await db.execute(delete(AppSetting).where(AppSetting.key == setting_key(owner)))
        await db.execute(delete(Agent).where(Agent.owner_id == owner))
        await db.commit()


def draft(**changes):
    value = {
        "step": 2,
        "provider": "claude",
        "model": None,
        "name": "First agent",
        "purpose": "Help me plan",
        "first_request": "Draft a short plan",
        "create_agent": True,
        "make_lead": False,
    }
    value.update(changes)
    return value


@pytest.mark.asyncio
async def test_draft_complete_and_lost_response_replay(api, sessions, owner):
    before = await api.get("/api/v1/onboarding")
    assert before.status_code == 200
    assert before.json()["status"] == "pending"
    saved = draft()
    response = await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": saved})
    assert response.status_code == 200, response.text
    assert response.json()["version"] == 2

    payload = {"expected_version": 2, "draft": saved}
    first = await api.post("/api/v1/onboarding/complete", json=payload)
    replay = await api.post("/api/v1/onboarding/complete", json=payload)
    assert first.status_code == replay.status_code == 200
    assert first.json()["agent_id"] == replay.json()["agent_id"]
    assert first.json()["first_reply_at"] is None
    assert replay.json()["status"] == "configured"
    restarted = await api.post("/api/v1/onboarding/restart", json={"expected_version": replay.json()["version"]})
    assert restarted.json()["draft"]["create_agent"] is False
    reopened_draft = restarted.json()["draft"]
    again = await api.post("/api/v1/onboarding/complete", json={"expected_version": restarted.json()["version"], "draft": reopened_draft})
    assert again.status_code == 200
    assert again.json()["agent_id"] == first.json()["agent_id"]
    async with sessions() as db:
        agents = list((await db.execute(select(Agent).where(Agent.owner_id == owner))).scalars())
        assert len(agents) == 1
        assert agents[0].instructions == saved["purpose"]
        assert agents[0].approval_mode == "ask"


@pytest.mark.asyncio
async def test_first_reply_requires_owned_successful_turn_and_records_once(api, sessions, owner, rt):
    saved = draft()
    await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": saved})
    await api.post("/api/v1/onboarding/complete", json={"expected_version": 2, "draft": saved})
    async with sessions() as db:
        thread = Thread(owner_id=owner, provider="claude")
        db.add(thread)
        await db.flush()
        turn = Turn(thread_id=thread.id, seq=1, prompt_text="hello", status="succeeded", result="Hi there.")
        db.add(turn)
        await db.flush()
        db.add(Event(thread_id=thread.id, turn_id=turn.id, seq=1, type="turn.completed", data={"status": "succeeded", "result": "Hi there."}))
        unfinished = Thread(owner_id=owner, provider="claude")
        db.add(unfinished)
        await db.flush()
        db.add(Turn(thread_id=unfinished.id, seq=1, prompt_text="still working", status="running"))
        await db.commit()
        thread_id = thread.id
        unfinished_id = unfinished.id

    pending = await api.post("/api/v1/onboarding/first-reply", json={"thread_id": unfinished_id})
    assert pending.status_code == 409

    # A foreign identifier is not accepted, even if it refers to a completed turn.
    other = rt.__class__(hub=rt.hub, adapters=rt.adapters, _session_factory=rt._session_factory, owner_id="other-" + uuid4().hex)
    app = app_for(other)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost") as foreign:
        assert (await foreign.post("/api/v1/onboarding/first-reply", json={"thread_id": thread_id})).status_code == 404

    first = await api.post("/api/v1/onboarding/first-reply", json={"thread_id": thread_id})
    again = await api.post("/api/v1/onboarding/first-reply", json={"thread_id": thread_id})
    assert first.status_code == again.status_code == 200
    assert first.json()["first_reply_at"]
    assert first.json()["first_reply_at"] == again.json()["first_reply_at"]


@pytest.mark.asyncio
async def test_stale_draft_conflicts_and_extra_fields_rejected(api):
    valid = await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": draft()})
    assert valid.status_code == 200
    stale = await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": draft(name="Changed")})
    assert stale.status_code == 409
    secret = draft(api_key="should be rejected")
    bad = await api.put("/api/v1/onboarding", json={"expected_version": 2, "draft": secret})
    assert bad.status_code == 422


@pytest.mark.asyncio
async def test_skip_restart_and_draft_retained(api):
    saved = draft()
    assert (await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": saved})).status_code == 200
    skipped = await api.post("/api/v1/onboarding/skip", json={"expected_version": 2})
    assert skipped.status_code == 200 and skipped.json()["status"] == "skipped"
    restarted = await api.post("/api/v1/onboarding/restart", json={"expected_version": 3})
    assert restarted.status_code == 200
    assert restarted.json()["status"] == "pending"
    assert restarted.json()["draft"] == saved


@pytest.mark.asyncio
async def test_state_and_agents_are_scoped_to_runtime_owner(rt, sessions, owner):
    app = app_for(rt)
    other_owner = "other-" + uuid4().hex
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost") as client:
        await client.put("/api/v1/onboarding", json={"expected_version": 1, "draft": draft(name="Owner A")})
        other = rt.__class__(hub=rt.hub, adapters=rt.adapters, _session_factory=rt._session_factory, owner_id=other_owner)
        app.dependency_overrides[get_runtime] = lambda: other
        other_view = await client.get("/api/v1/onboarding")
        assert other_view.json()["draft"]["name"] == "Assistant"
        assert other_view.json()["status"] == "pending"
    async with sessions() as db:
        assert await db.get(AppSetting, setting_key(owner))
        await db.execute(delete(AppSetting).where(AppSetting.key == setting_key(other_owner)))
        await db.commit()


@pytest.mark.asyncio
async def test_make_lead_requires_supported_team_engine(api):
    invalid = draft(provider="unknown", make_lead=True)
    await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": invalid})
    response = await api.post("/api/v1/onboarding/complete", json={"expected_version": 2, "draft": invalid})
    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "lead_engine"


@pytest.mark.asyncio
async def test_desktop_legacy_completion_is_reported_configured(api, monkeypatch):
    from app.core import app_settings

    monkeypatch.setattr(onboarding_router.profile, "active", lambda: True)
    monkeypatch.setattr(app_settings, "get", lambda key, live=False: True)
    response = await api.get("/api/v1/onboarding")
    assert response.status_code == 200
    assert response.json()["status"] == "configured"
    assert response.json()["execution_host"] == "desktop"
    put = await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": draft()})
    assert put.status_code == 200 and put.json()["status"] == "configured"
    skipped = await api.post("/api/v1/onboarding/skip", json={"expected_version": 1})
    assert skipped.status_code == 409


@pytest.mark.asyncio
async def test_concurrent_first_completion_creates_one_agent(api, sessions, owner):
    saved = draft()
    await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": saved})
    payload = {"expected_version": 2, "draft": saved}
    left, right = await asyncio.gather(
        api.post("/api/v1/onboarding/complete", json=payload),
        api.post("/api/v1/onboarding/complete", json=payload),
    )
    assert left.status_code == right.status_code == 200
    assert left.json()["agent_id"] == right.json()["agent_id"]
    async with sessions() as db:
        assert len(list((await db.execute(select(Agent).where(Agent.owner_id == owner))).scalars())) == 1


@pytest.mark.asyncio
async def test_agent_flush_failure_rolls_back_without_orphan(api, sessions, owner):
    saved = draft()
    await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": saved})

    async def fail_after_flush(db):
        agent = Agent(owner_id=owner, name="Orphan", instructions="purpose", provider="claude", approval_mode="ask")
        db.add(agent)
        await db.flush()
        raise RuntimeError("injected between agent and receipt")

    with pytest.raises(RuntimeError, match="injected"):
        async with sessions() as db:
            await state_store.complete(db, owner, 2, saved, fail_after_flush)
    async with sessions() as db:
        assert await db.scalar(select(Agent.id).where(Agent.owner_id == owner)) is None
        row = await db.get(AppSetting, setting_key(owner))
        assert row.value_json["status"] == "pending"


@pytest.mark.asyncio
async def test_create_agent_requires_purpose_and_engine_even_without_agent(api):
    blank_purpose = draft(purpose="  ")
    await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": blank_purpose})
    missing = await api.post("/api/v1/onboarding/complete", json={"expected_version": 2, "draft": blank_purpose})
    assert missing.status_code == 422
    assert missing.json()["detail"]["error_code"] == "invalid_agent_purpose"

    no_agent = draft(create_agent=False, purpose="", name="")
    await api.put("/api/v1/onboarding", json={"expected_version": 2, "draft": no_agent})
    unknown_engine = draft(create_agent=False, provider="unknown", purpose="", name="")
    await api.put("/api/v1/onboarding", json={"expected_version": 3, "draft": unknown_engine})
    invalid = await api.post("/api/v1/onboarding/complete", json={"expected_version": 4, "draft": unknown_engine})
    assert invalid.status_code == 422

    # A valid engine with creation disabled completes setup without creating an agent.
    valid = draft(create_agent=False, purpose="", name="")
    await api.put("/api/v1/onboarding", json={"expected_version": 4, "draft": valid})
    response = await api.post("/api/v1/onboarding/complete", json={"expected_version": 5, "draft": valid})
    assert response.status_code == 200
    assert response.json()["agent_id"] is None


@pytest.mark.asyncio
async def test_engine_unavailability_blocks_setup_when_agent_creation_is_disabled(api, rt, monkeypatch):
    saved = draft(create_agent=False, purpose="", name="")
    await api.put("/api/v1/onboarding", json={"expected_version": 1, "draft": saved})

    async def unavailable(*, only=None, refresh=False):
        return [{"available": False, "reason": "not ready"}]

    monkeypatch.setattr(rt.engines, "describe", unavailable)
    response = await api.post("/api/v1/onboarding/complete", json={"expected_version": 2, "draft": saved})
    assert response.status_code == 409
    assert response.json()["detail"]["error_code"] == "engine_not_ready"
