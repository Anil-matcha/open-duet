from datetime import datetime, timedelta, timezone

from boat_sdk.exceptions import ApiException
from boat_sdk.models.sandbox import Sandbox
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.user_sandbox import UserSandbox
from app.db.transactions import begin_write, release_snapshot
from app.core.logging import get_logger
from app.services.box_operations import ascii_box_service

logger = get_logger(__name__)


async def create(
    db: AsyncSession,
    *,
    user_id: str,
    box_id: str,
    state: str | None,
    machine_type: str | None,
    ttl_seconds: int,
) -> UserSandbox:
    record = UserSandbox(
        user_id=user_id,
        box_id=box_id,
        state=state,
        machine_type=machine_type,
        ttl_seconds=ttl_seconds,
        expires_at=datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds),
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return record


async def get_by_box_id(db: AsyncSession, box_id: str) -> UserSandbox | None:
    result = await db.execute(
        select(UserSandbox).where(UserSandbox.box_id == box_id)
    )
    return result.scalar_one_or_none()


def _is_expired(record: UserSandbox) -> bool:
    """True when the row's TTL has passed (a row with no TTL never expires)."""
    return record.expires_at is not None and record.expires_at < datetime.now(timezone.utc)


async def get_active_by_user_id(db: AsyncSession, user_id: str) -> UserSandbox | None:
    result = await db.execute(
        select(UserSandbox)
        .where(UserSandbox.user_id == user_id, UserSandbox.is_active.is_(True))
        .order_by(UserSandbox.created_at.desc())
    )
    return result.scalars().first()


async def update_state(
    db: AsyncSession, box_id: str, *, state: str | None
) -> UserSandbox | None:
    await begin_write(db)
    record = await get_by_box_id(db, box_id)
    if record is None:
        return None

    record.state = state
    await db.commit()
    await db.refresh(record)
    return record


async def deactivate(db: AsyncSession, box_id: str) -> UserSandbox | None:
    await begin_write(db)
    record = await get_by_box_id(db, box_id)
    if record is None:
        return None

    record.is_active = False
    await db.commit()
    await db.refresh(record)
    return record


async def expire(db: AsyncSession) -> list[str]:
    """Background job: honour the TTL recorded when each sandbox was made.

    The remote box is deleted first; a row is only deactivated once its box is
    gone (or was already gone). A remote failure leaves the row active, so the
    next sweep retries it instead of orphaning a box nobody will ever delete.
    Returns the box ids whose boxes were deleted and rows deactivated.
    """
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(UserSandbox).where(
            UserSandbox.is_active.is_(True),
            UserSandbox.expires_at.is_not(None),
            UserSandbox.expires_at < now,
        )
    )
    expired = list(result.scalars())
    if not expired:
        return []
    # The remote calls take seconds; hold no write lock while they run.
    gone: list[UserSandbox] = []
    for row in expired:
        try:
            await run_in_threadpool(ascii_box_service.delete_box, row.box_id)
        except ApiException as exc:
            if exc.status == 404:
                gone.append(row)  # already gone remotely; safe to deactivate
                continue
            logger.warning("could not delete an expired sandbox", box_id=row.box_id, status=exc.status)
            continue
        except Exception:  # noqa: BLE001
            logger.exception("could not delete an expired sandbox", box_id=row.box_id)
            continue
        gone.append(row)
    if not gone:
        return []
    await begin_write(db)
    await db.execute(
        update(UserSandbox)
        .where(UserSandbox.id.in_([row.id for row in gone]))
        .values(is_active=False)
    )
    await db.commit()
    return [row.box_id for row in gone]


async def run_expiry() -> list[str]:
    """Background job entry point: open a session and expire due sandboxes."""
    from app.db.session import AsyncSessionLocal

    async with AsyncSessionLocal() as db:
        return await expire(db)


async def ensure(
    db: AsyncSession, *, user_id: str, ttl_seconds: int
) -> tuple[UserSandbox | None, Sandbox]:
    """Reuse an existing, unexpired sandbox; replace a stale row on remote 404
    or on an expired TTL."""
    existing = await get_active_by_user_id(db, user_id)
    # The box calls below take seconds; hold no snapshot while they run.
    await release_snapshot(db)
    if existing is not None and _is_expired(existing):
        # Its TTL has passed: never hand it back. Ask the remote to delete it
        # (best effort: a failure here does not block a fresh sandbox), then
        # deactivate the row and fall through to create a new one.
        try:
            await run_in_threadpool(ascii_box_service.delete_box, existing.box_id)
        except Exception:  # noqa: BLE001
            logger.warning("could not delete an expired sandbox on reuse", box_id=existing.box_id)
        existing.is_active = False
        await db.commit()
        existing = None
    if existing is not None:
        try:
            response = await run_in_threadpool(
                ascii_box_service.get_box, existing.box_id
            )
        except ApiException as exc:
            if exc.status != 404:
                raise
            existing.is_active = False
        else:
            record = await update_state(
                db, existing.box_id, state=response.sandbox.state
            )
            return record, response.sandbox

    try:
        box = await run_in_threadpool(ascii_box_service.create_box, ttl_seconds)
        # Deactivation and the replacement row commit together. A failed
        # create leaves the old row unchanged so the next request can retry.
        record = await create(
            db,
            user_id=user_id,
            box_id=box.id,
            state=box.state,
            machine_type=box.type,
            ttl_seconds=ttl_seconds,
        )
    except Exception:
        await db.rollback()
        raise
    return record, box
