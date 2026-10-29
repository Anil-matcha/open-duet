"""Erase the local app data of a desktop profile (agents, conversations, memory,
routines, settings, workspace files and encrypted provider credentials).

Only the account reset and account deletion paths call this; signing out never
does. The app's own sign-in rows (`auth_*`) are kept so the local window stays
usable. Engine CLIs keep their own credentials outside this profile.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from sqlalchemy import delete, text
from sqlalchemy.ext.asyncio import AsyncSession

import app.db.models  # noqa: F401  (registers every table)
from app.db.base import Base
from app.db.transactions import begin_write
from app.desktop import boat_credentials, profile

KEPT_TABLES = frozenset({"auth_owner", "auth_session", "auth_pairing_code"})


async def wipe_database(db: AsyncSession) -> None:
    """Delete every row of every app table in one transaction (all or nothing)."""
    await begin_write(db)
    try:
        if db.get_bind().dialect.name == "sqlite":
            await db.execute(text("PRAGMA defer_foreign_keys = ON"))
        for table in reversed(Base.metadata.sorted_tables):
            if table.name not in KEPT_TABLES:
                await db.execute(delete(table))
        await db.commit()
    except Exception:
        await db.rollback()
        raise


def _clear_directory(path: Path) -> None:
    if not path.is_dir() or path.is_symlink():
        return
    for child in path.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()


def wipe_files() -> None:
    """Remove workspace files, backups and saved provider keys; folders stay."""
    current = profile.current()
    if current is None:
        raise RuntimeError("Desktop profile is not active.")
    _clear_directory(current.data_dir / profile.WORKSPACE_DIR_NAME)
    _clear_directory(current.backup_dir)
    boat_credentials.BoatCredentials(
        data_dir=current.data_dir, encryption_key=current.encryption_key
    ).delete()


async def wipe_local_data(db: AsyncSession) -> None:
    await wipe_database(db)
    wipe_files()
