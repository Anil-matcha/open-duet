"""Run a periodic background job once for every account's schema (hosted deployments).

With TENANT_SCHEMAS_ENABLED off, `per_tenant(job)` is `job` itself, so the single-owner server is
unchanged. With it on, each tick first runs the job for the default schema, then for every account
schema that exists at that moment (the list is read again each tick, so a new account is picked up
without a restart). One account's failure is logged and never stops the others.
"""

import asyncio
from collections.abc import Awaitable, Callable

from app.core.config import settings
from app.core.logging import get_logger
from app.db import tenant_schema
from app.db.engine import create_app_sync_engine

logger = get_logger(__name__)

_engine = None


def enabled() -> bool:
    return settings.TENANT_SCHEMAS_ENABLED and settings.DATABASE_KIND == "postgres"


def _list() -> list[str]:
    global _engine
    if _engine is None:
        _engine = create_app_sync_engine()
    return tenant_schema.list_schemas(_engine)


async def tenants() -> list[str]:
    """Tenant ids of every existing account schema."""
    if not enabled():
        return []
    return ["u_" + schema[2:] for schema in await asyncio.to_thread(_list)]


async def for_each(job: Callable[[], Awaitable[None]]) -> None:
    """Run `job` for the default schema and then for each account, isolating failures."""
    name = getattr(job, "__name__", "job")
    try:
        await job()
    except Exception:  # noqa: BLE001
        logger.exception("background job failed for the default schema", job=name)
    for tenant in await tenants():
        try:
            with tenant_schema.use_tenant(tenant):
                await job()
        except Exception:  # noqa: BLE001
            logger.exception("background job failed for an account", job=name, tenant=tenant)


def per_tenant(job: Callable[[], Awaitable[None]]) -> Callable[[], Awaitable[None]]:
    if not enabled():
        return job

    async def wrapped() -> None:
        await for_each(job)

    wrapped.__name__ = getattr(job, "__name__", "job")
    return wrapped
