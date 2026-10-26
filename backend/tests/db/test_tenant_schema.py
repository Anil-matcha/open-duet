"""Hosted isolation: one PostgreSQL schema per account, chosen per connection.

PostgreSQL only, and only with TENANT_SCHEMAS_ENABLED=true (the hosted setting)."""

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import settings
from app.db import tenant_schema
from app.db.engine import create_app_async_engine, create_app_sync_engine
from app.db.models.agent import Agent

pytestmark = pytest.mark.skipif(
    settings.DATABASE_KIND != "postgres" or not settings.TENANT_SCHEMAS_ENABLED,
    reason="needs PostgreSQL with TENANT_SCHEMAS_ENABLED=true",
)


def new_tenant() -> str:
    return f"u_{uuid.uuid4().hex}"


@pytest.fixture
def tenants():
    sync = create_app_sync_engine()
    a, b = new_tenant(), new_tenant()
    for tenant in (a, b):
        tenant_schema.create_schema(sync, tenant)
        tenant_schema.migrate_schema(tenant)
    yield a, b
    for tenant in (a, b):
        tenant_schema.drop_schema(sync, tenant)
    sync.dispose()


def test_schema_names_cannot_carry_sql():
    for bad in ("u_x", 'u_" ; drop schema public', "", "t_" + "a" * 31):
        with pytest.raises(ValueError):
            tenant_schema.schema_for(bad)


@pytest.mark.asyncio
async def test_one_account_never_sees_anothers_rows_orm_or_raw(tenants):
    a, b = tenants
    engine = create_app_async_engine()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        with tenant_schema.use_tenant(a):
            async with sessions() as db:
                db.add(Agent(owner_id="owner", name="only-in-a"))
                await db.commit()
        with tenant_schema.use_tenant(a):
            async with sessions() as db:
                assert (await db.execute(text("select count(*) from agent"))).scalar() == 1
        with tenant_schema.use_tenant(b):
            async with sessions() as db:
                assert (await db.execute(text("select count(*) from agent"))).scalar() == 0
                from sqlalchemy import select

                assert (await db.execute(select(Agent))).scalars().all() == []
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_a_pooled_connection_never_keeps_the_previous_accounts_path(tenants):
    a, _ = tenants
    engine = create_app_async_engine(pool_size=1, max_overflow=0)
    try:
        with tenant_schema.use_tenant(a):
            async with engine.connect() as connection:
                assert (await connection.execute(text("show search_path"))).scalar() == f"t_{a[2:]}"
        async with engine.connect() as connection:  # same pooled connection, no account in context
            assert (await connection.execute(text("show search_path"))).scalar() != f"t_{a[2:]}"
    finally:
        await engine.dispose()


def test_dropping_the_schema_removes_the_accounts_data():
    sync = create_app_sync_engine()
    tenant = new_tenant()
    tenant_schema.create_schema(sync, tenant)
    assert f"t_{tenant[2:]}" in tenant_schema.list_schemas(sync)
    tenant_schema.drop_schema(sync, tenant)
    assert f"t_{tenant[2:]}" not in tenant_schema.list_schemas(sync)
    sync.dispose()
