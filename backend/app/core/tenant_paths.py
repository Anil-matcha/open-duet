"""Where an account's files live on disk, for a hosted deployment (TENANT_SCHEMAS_ENABLED).

Everything an account owns outside the database (its workspace, agents' memory, attachments,
the decision log, computer state) sits under one folder per account, so it is separated from
other accounts and removed with a single delete. With no account in context (the single-owner
server) `root()` is None and every caller keeps its usual location.
"""

import shutil
from pathlib import Path

from app.core.config import settings
from app.db import tenant_schema


def base() -> Path:
    configured = settings.TENANT_DATA_DIR.strip()
    return (Path(configured).expanduser() if configured else Path.home() / ".open-dots" / "tenants").resolve()


def root_of(tenant_id: str) -> Path:
    """The folder of one account. The name is checked, so it can never be a path."""
    return base() / tenant_schema.schema_for(tenant_id)[2:]


def root() -> Path | None:
    """The current account's folder, or None outside any account."""
    tenant = tenant_schema.current_tenant()
    return None if tenant is None else root_of(tenant)


def contains(path: str | Path) -> bool:
    """Whether a real path is inside the current account's folder (always true outside accounts)."""
    mine = root()
    if mine is None:
        return True
    target = Path(path).resolve()
    return target == mine or mine in target.parents


def remove(tenant_id: str) -> None:
    """Delete everything the account stored on disk."""
    shutil.rmtree(root_of(tenant_id), ignore_errors=True)
