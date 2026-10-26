"""One PostgreSQL schema per account, for a hosted deployment (off by default).

The open server has one owner and one set of tables. A hosted deployment gives each account
its own schema holding a full copy of those tables. A ContextVar names the schema of the
request's account, and every database connection sets `search_path` to it as it is taken
from the pool, so every query, raw SQL included, can only see that account's tables. With
no account in context (the single-owner server, the migration tool) the default schema is used.

Nothing here runs unless TENANT_SCHEMAS_ENABLED is set; SQLite is never tenant-aware.
"""

import re
from contextlib import contextmanager
from contextvars import ContextVar

from sqlalchemy import event, text
from sqlalchemy.engine import Engine

_SCHEMA = re.compile(r"^t_[0-9a-f]{32}$")

_current: ContextVar[str | None] = ContextVar("open_dots_tenant_schema", default=None)


def schema_for(tenant_id: str) -> str:
    """`u_<hex>` (an account's tenant id) becomes its schema name. Anything else is refused,
    so a name can never carry SQL."""
    hex_part = tenant_id.removeprefix("u_")
    name = f"t_{hex_part}"
    if not _SCHEMA.fullmatch(name):
        raise ValueError("not a valid tenant id")
    return name


def current_schema() -> str | None:
    return _current.get()


def current_tenant_id() -> str | None:
    """The tenant id (`u_<hex>`) whose schema is in context, or None."""
    schema = _current.get()
    return f"u_{schema[2:]}" if schema else None


@contextmanager
def use_tenant(tenant_id: str | None):
    """Run the enclosed code (and tasks it starts) against one account's schema."""
    token = _current.set(schema_for(tenant_id) if tenant_id else None)
    try:
        yield
    finally:
        _current.reset(token)


def install(engine: Engine) -> None:
    """Make connections taken from this (synchronous side of an) engine follow the context."""

    @event.listens_for(engine, "checkout")
    def _set_search_path(dbapi_connection, _record, _proxy):
        schema = _current.get()
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute(f'SET search_path TO "{schema}"' if schema else "SET search_path TO DEFAULT")
        finally:
            cursor.close()


def create_schema(sync_engine: Engine, tenant_id: str) -> str:
    """Create the account's empty schema (idempotent) and return its name."""
    schema = schema_for(tenant_id)
    with sync_engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS "{schema}"'))
    return schema


def drop_schema(sync_engine: Engine, tenant_id: str) -> None:
    """Delete everything the account owns in the database."""
    schema = schema_for(tenant_id)
    with sync_engine.begin() as connection:
        connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))


def list_schemas(sync_engine: Engine) -> list[str]:
    with sync_engine.connect() as connection:
        rows = connection.execute(text("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't\\_%'"))
        return sorted(name for (name,) in rows if _SCHEMA.fullmatch(name))


def migrate_schema(tenant_id: str) -> None:
    """Bring one account's schema to the newest revision, creating the tables on first use.
    Runs the core's own Alembic chain with the account's schema as the search path."""
    import os
    import subprocess
    import sys
    from pathlib import Path

    backend = Path(__file__).resolve().parents[2]
    env = {**os.environ, "OPEN_DOTS_MIGRATE_TENANT": tenant_id}
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=backend, env=env, check=True)
