"""Hosted background jobs and webhooks, per account. PostgreSQL with TENANT_SCHEMAS_ENABLED only."""

import uuid

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core import tenant_jobs
from app.core.config import settings
from app.db import tenant_schema
from app.db.engine import create_app_async_engine, create_app_sync_engine
from app.db.models import Agent, Routine
from app.routers.hooks import router as hooks_router
from app.services import routine_service as service

pytestmark = pytest.mark.skipif(
    settings.DATABASE_KIND != "postgres" or not settings.TENANT_SCHEMAS_ENABLED,
    reason="needs PostgreSQL with TENANT_SCHEMAS_ENABLED=true",
)


def new_tenant() -> str:
    return f"u_{uuid.uuid4().hex}"


@pytest.fixture
def tenants():
    sync = create_app_sync_engine()
    made = []

    def make() -> str:
        tenant = new_tenant()
        tenant_schema.create_schema(sync, tenant)
        tenant_schema.migrate_schema(tenant)
        made.append(tenant)
        return tenant

    yield make
    for tenant in made:
        tenant_schema.drop_schema(sync, tenant)
    sync.dispose()


@pytest.mark.asyncio
async def test_a_job_runs_for_the_default_schema_and_every_account_even_a_new_one(tenants):
    first = tenants()
    seen: list[str | None] = []

    async def job():
        seen.append(tenant_schema.current_tenant())

    await tenant_jobs.for_each(job)
    assert None in seen and first in seen
    second = tenants()  # created after the first tick
    seen.clear()
    await tenant_jobs.for_each(job)
    assert {first, second} <= set(seen)


@pytest.mark.asyncio
async def test_one_accounts_failure_never_stops_the_others(tenants):
    a, b = tenants(), tenants()
    ran: list[str | None] = []

    async def job():
        who = tenant_schema.current_tenant()
        if who == a:
            raise RuntimeError("boom")
        ran.append(who)

    await tenant_jobs.for_each(job)
    assert b in ran and a not in ran


def test_the_wrapper_is_the_job_itself_when_hosting_is_off(monkeypatch):
    monkeypatch.setattr(settings, "TENANT_SCHEMAS_ENABLED", False)

    async def job():
        pass

    assert tenant_jobs.per_tenant(job) is job


@pytest.mark.asyncio
async def test_a_webhook_reaches_only_the_account_named_in_its_address(tenants):
    a, b = tenants(), tenants()
    engine = create_app_async_engine()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        with tenant_schema.use_tenant(a):
            async with sessions() as db:
                agent = Agent(owner_id="owner", name="hook agent")
                db.add(agent)
                await db.commit()
                routine = await service.create_routine(
                    db, "owner", {"agent_id": agent.id, "name": "r", "prompt": "hi",
                                  "schedule_kind": "manual", "schedule_spec": {}},
                )
                _, secret = await service.enable_webhook(db, "owner", routine.id)
        app = FastAPI()
        app.include_router(hooks_router)
        good = {"Authorization": f"Bearer {secret}"}
        hex_a, hex_b = a[2:], b[2:]
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://hooks.test") as api:
            accepted = await api.post(f"/hooks/t/{hex_a}/{routine.id}", headers=good, content="ping")
            assert accepted.status_code == 202, accepted.text
            wrong_account = await api.post(f"/hooks/t/{hex_b}/{routine.id}", headers=good, content="ping")
            bad_secret = await api.post(f"/hooks/t/{hex_a}/{routine.id}",
                                        headers={"Authorization": "Bearer nope"}, content="ping")
            unknown = await api.post(f"/hooks/t/{'0' * 32}/{routine.id}", headers=good, content="ping")
            malformed = await api.post(f"/hooks/t/not-hex/{routine.id}", headers=good, content="ping")
            plain = await api.post(f"/hooks/{routine.id}", headers=good, content="ping")
        # Every refusal looks the same, whatever was wrong.
        for refused in (wrong_account, bad_secret, unknown, malformed):
            assert refused.status_code == 401 and refused.json() == bad_secret.json()
        # The old address names no account, so it only ever reaches the default schema.
        assert plain.status_code == 401
        with tenant_schema.use_tenant(a):
            async with sessions() as db:
                assert len((await db.execute(select(Routine))).scalars().all()) == 1
        with tenant_schema.use_tenant(b):
            async with sessions() as db:
                assert (await db.execute(select(Routine))).scalars().all() == []
    finally:
        await engine.dispose()
        from app.db.session import engine as shared

        await shared.dispose()
