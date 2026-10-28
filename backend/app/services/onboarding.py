"""Durable, owner-scoped onboarding state."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Agent, AppSetting, Event, Thread, Turn
from app.db.transactions import begin_write

DEFAULT_DRAFT = {
    "step": 0,
    "provider": "",
    "model": None,
    "name": "Assistant",
    "purpose": "",
    "first_request": "",
    "create_agent": True,
    "make_lead": False,
}


def setting_key(owner_id: str) -> str:
    digest = hashlib.sha256(owner_id.encode("utf-8")).hexdigest()
    return f"onboarding.v1.{digest}"


def response(state: dict, *, execution_host: str, existing_agents: bool) -> dict:
    return {
        "version": state["version"],
        "status": state["status"],
        "draft": dict(state["draft"]),
        "agent_id": state.get("agent_id"),
        "first_reply_at": state.get("first_reply_at"),
        "execution_host": execution_host,
        "existing_agents": existing_agents,
    }


async def load(db: AsyncSession, owner_id: str) -> tuple[dict | None, bool]:
    row = await db.get(AppSetting, setting_key(owner_id))
    existing = await db.scalar(select(Agent.id).where(Agent.owner_id == owner_id).limit(1))
    return (dict(row.value_json) if row and isinstance(row.value_json, dict) else None, existing is not None)


async def locked_row(db: AsyncSession, owner_id: str) -> AppSetting | None:
    query = select(AppSetting).where(AppSetting.key == setting_key(owner_id)).with_for_update()
    return (await db.execute(query)).scalar_one_or_none()


def fresh_state(*, existing_agents: bool = False) -> dict:
    return {
        "version": 1,
        "status": "configured" if existing_agents else "pending",
        "draft": dict(DEFAULT_DRAFT),
        "agent_id": None,
        "receipt_draft": None,
        "first_reply_at": None,
    }


def persist(row: AppSetting | None, owner_id: str, state: dict) -> AppSetting:
    now = datetime.now(UTC)
    if row is None:
        row = AppSetting(key=setting_key(owner_id), value_json=state, version=state["version"], updated_at=now, updated_by=owner_id)
    else:
        row.value_json = state
        row.version = state["version"]
        row.updated_at = now
        row.updated_by = owner_id
    return row


async def put(db: AsyncSession, owner_id: str, expected_version: int, draft: dict, *, legacy_completed: bool = False) -> dict:
    await begin_write(db)
    row = await locked_row(db, owner_id)
    if row is None:
        existing = await db.scalar(select(Agent.id).where(Agent.owner_id == owner_id).limit(1))
        state = fresh_state(existing_agents=existing is not None or legacy_completed)
        if state["status"] == "configured":
            if expected_version == state["version"]:
                return state
            raise VersionConflict
    else:
        state = dict(row.value_json)
    if expected_version != state["version"] or state["status"] != "pending":
        raise VersionConflict
    state.update(version=state["version"] + 1, draft=draft)
    db.add(persist(row, owner_id, state))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise VersionConflict from None
    return state


class VersionConflict(Exception):
    pass


async def preflight_complete(
    db: AsyncSession, owner_id: str, expected_version: int, draft: dict, *, legacy_completed: bool = False
) -> tuple[dict, bool]:
    """Check an idempotent receipt before engine probing or a write transaction."""
    row = await db.get(AppSetting, setting_key(owner_id))
    if row is None:
        existing = await db.scalar(select(Agent.id).where(Agent.owner_id == owner_id).limit(1))
        state = fresh_state(existing_agents=existing is not None or legacy_completed)
    else:
        state = dict(row.value_json)
    if state["status"] == "configured" and state.get("receipt_draft") == draft:
        return state, True
    if expected_version != state["version"] or state["status"] != "pending" or draft != state["draft"]:
        raise VersionConflict
    return state, False


async def skip(db: AsyncSession, owner_id: str, expected_version: int, *, legacy_completed: bool = False) -> dict:
    await begin_write(db)
    row = await locked_row(db, owner_id)
    if row is None:
        existing = await db.scalar(select(Agent.id).where(Agent.owner_id == owner_id).limit(1))
        state = fresh_state(existing_agents=existing is not None or legacy_completed)
    else:
        state = dict(row.value_json)
    if expected_version != state["version"] or state["status"] != "pending":
        raise VersionConflict
    state.update(version=state["version"] + 1, status="skipped")
    db.add(persist(row, owner_id, state))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise VersionConflict from None
    return state


async def restart(db: AsyncSession, owner_id: str, expected_version: int) -> dict:
    await begin_write(db)
    row = await locked_row(db, owner_id)
    state = dict(row.value_json) if row else fresh_state()
    if expected_version != state["version"]:
        raise VersionConflict
    draft = dict(state["draft"])
    if state.get("agent_id") is not None:
        # Reopening a completed wizard preserves its choices but requires an
        # explicit new-agent choice before it can create another starter.
        draft.update(create_agent=False, make_lead=False)
    state.update(version=state["version"] + 1, status="pending", draft=draft)
    db.add(persist(row, owner_id, state))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise VersionConflict from None
    return state


async def complete(
    db: AsyncSession, owner_id: str, expected_version: int, draft: dict, create_agent, *, legacy_completed: bool = False
):
    """Run `create_agent(db)` and store its replay receipt in the same commit."""
    await begin_write(db)
    row = await locked_row(db, owner_id)
    if row is None:
        existing = await db.scalar(select(Agent.id).where(Agent.owner_id == owner_id).limit(1))
        state = fresh_state(existing_agents=existing is not None or legacy_completed)
    else:
        state = dict(row.value_json)
    # The successful receipt is checked before readiness/version validation so
    # clients can safely retry after losing the response.
    if state["status"] == "configured" and state.get("receipt_draft") == draft:
        await db.rollback()
        return state
    if expected_version != state["version"] or state["status"] != "pending":
        raise VersionConflict
    if draft != state["draft"]:
        raise VersionConflict
    if state.get("agent_id") is not None and state.get("receipt_draft") == draft:
        agent_id = state["agent_id"]
    else:
        agent_id = await create_agent(db)
    if agent_id is None:
        agent_id = state.get("agent_id")
    state.update(version=state["version"] + 1, status="configured", agent_id=agent_id, receipt_draft=draft)
    db.add(persist(row, owner_id, state))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise VersionConflict from None
    return state


async def record_first_reply(db: AsyncSession, owner_id: str, thread_id: int, *, legacy_completed: bool = False) -> dict:
    """Mark the first successful assistant turn; caller-supplied claims are never trusted."""
    await begin_write(db)
    row = await locked_row(db, owner_id)
    if row is None:
        existing = await db.scalar(select(Agent.id).where(Agent.owner_id == owner_id).limit(1))
        state = fresh_state(existing_agents=existing is not None or legacy_completed)
    else:
        state = dict(row.value_json)
    owned_thread = await db.scalar(select(Thread.id).where(Thread.id == thread_id, Thread.owner_id == owner_id))
    if owned_thread is None:
        raise ThreadNotFound
    valid = await db.scalar(
        select(Turn.id)
        .join(Thread, Thread.id == Turn.thread_id)
        .join(Event, (Event.turn_id == Turn.id) & (Event.thread_id == Thread.id))
        .where(
            Thread.id == thread_id,
            Thread.owner_id == owner_id,
            Turn.status == "succeeded",
            Event.type == "turn.completed",
        )
        .limit(1)
    )
    if valid is None:
        raise ThreadNotCompleted
    if state["status"] != "configured":
        raise NotConfigured
    if state.get("first_reply_at") is None:
        state.update(version=state["version"] + 1, first_reply_at=datetime.now(UTC).isoformat())
        db.add(persist(row, owner_id, state))
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            saved = await db.get(AppSetting, setting_key(owner_id))
            if saved is not None and isinstance(saved.value_json, dict) and saved.value_json.get("first_reply_at"):
                return dict(saved.value_json)
            raise VersionConflict from None
    else:
        await db.rollback()
    return state


class ThreadNotCompleted(Exception):
    pass


class ThreadNotFound(Exception):
    pass


class NotConfigured(Exception):
    pass
