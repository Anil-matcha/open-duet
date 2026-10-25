"""Cross-agent pending work: one derived set across every thread and agent.

The product's loop waits on a person, but "something needs you in another agent's
thread" is otherwise only visible by opening that thread. This module derives one
feed — pending approvals plus the needs-you card's other items — ordered by
urgency, and offers a change signal so a consumer can react without polling.

Derived-only: nothing here writes, transitions or consumes. The approval and
needs-you queries are reused, never re-implemented.
"""

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from app.db.models import Approval, Thread as ThreadModel, Turn
from app.team import needs_you

# An approval with this little time left (or less) is "due".
DUE_WINDOW = timedelta(minutes=15)

URGENCY_EXPIRED = "expired"
URGENCY_DUE = "due"
URGENCY_NORMAL = "normal"

# Sort rank: expired first, then due, then normal.
_URGENCY_ORDER = {URGENCY_EXPIRED: 0, URGENCY_DUE: 1, URGENCY_NORMAL: 2}


def utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def urgency_of(deadline: datetime | None, now: datetime) -> str:
    """A pure function of `deadline` vs `now`. No deadline is `normal`."""
    deadline = _aware(deadline)
    if deadline is None:
        return URGENCY_NORMAL
    remaining = deadline - now
    if remaining.total_seconds() < 0:
        return URGENCY_EXPIRED
    if remaining <= DUE_WINDOW:
        return URGENCY_DUE
    return URGENCY_NORMAL


@dataclass(frozen=True)
class WorkItem:
    kind: str  # "approval" | "needs_you"
    thread_id: int | None
    agent_id: int | None
    agent_name: str | None
    title: str
    created_at: datetime
    deadline: datetime | None
    urgency: str
    key: str

    def public(self) -> dict:
        return {
            "kind": self.kind,
            "thread_id": self.thread_id,
            "agent_id": self.agent_id,
            "agent_name": self.agent_name,
            "title": self.title,
            "created_at": self.created_at.isoformat(),
            "deadline": self.deadline.isoformat() if self.deadline else None,
            "urgency": self.urgency,
        }


def sort_key(item: WorkItem) -> tuple:
    """Unexpired-first, then urgency, then newest first. Expired items are their
    own urgency bucket (rank 0), so 'unexpired-first' is folded into the urgency
    ordering for approvals that store no deadline."""
    return (_URGENCY_ORDER.get(item.urgency, 3), -item.created_at.timestamp())


async def _agent_names(db, thread_ids: list[int]) -> dict[int, tuple[int | None, str | None]]:
    if not thread_ids:
        return {}
    from sqlalchemy import select

    from app.db.models import Agent

    rows = (
        await db.execute(
            select(ThreadModel.id, Agent.id, Agent.name)
            .join(Agent, Agent.id == ThreadModel.agent_id, isouter=True)
            .where(ThreadModel.id.in_(thread_ids))
        )
    ).all()
    return {tid: (aid, name) for tid, aid, name in rows}


def _approval_deadlines(deadlines: dict[str, datetime]) -> dict[str, datetime]:
    """Approvals store no deadline today (the runtime holds one in memory only),
    so this is empty unless a caller supplies live deadlines. Kept as a seam so
    the ordering is ready the day deadlines are persisted."""
    return deadlines


async def collect(
    db,
    owner_id: str,
    *,
    now: datetime,
    engines: list[dict],
    issues: list[dict],
    deadlines: dict[str, datetime] | None = None,
) -> list[WorkItem]:
    """The owner's pending work: pending approvals plus the needs-you items,
    ordered by urgency. Reuses `needs_you.collect` for both legs."""
    deadlines = _approval_deadlines(deadlines or {})
    card_items = await needs_you.collect(db, owner_id, now=now, engines=engines, issues=issues)

    thread_ids = [i.thread_id for i in card_items if i.thread_id is not None]
    names = await _agent_names(db, thread_ids)

    items: list[WorkItem] = []
    for item in card_items:
        approval_id = item.key.split(":", 1)[1] if item.kind == "approval" else None
        deadline = _aware(deadlines.get(approval_id)) if approval_id else None
        agent_id, agent_name = names.get(item.thread_id, (None, None)) if item.thread_id else (None, None)
        items.append(
            WorkItem(
                kind="approval" if item.kind == "approval" else "needs_you",
                thread_id=item.thread_id,
                agent_id=agent_id,
                agent_name=agent_name,
                title=item.title,
                created_at=_aware(item.at) or now,
                deadline=deadline,
                urgency=urgency_of(deadline, now),
                key=item.key,
            )
        )
    items.sort(key=sort_key)
    return items


async def pending_approval_ids(db, owner_id: str) -> set[str]:
    """The ids of the owner's pending approvals whose turn is running — the same
    population the feed and the needs-you card derive from."""
    from sqlalchemy import select

    rows = (
        await db.execute(
            select(Approval.id)
            .join(ThreadModel, ThreadModel.id == Approval.thread_id)
            .join(Turn, Turn.id == Approval.turn_id)
            .where(
                ThreadModel.owner_id == owner_id,
                Approval.status == "pending",
                Turn.status == "running",
            )
        )
    ).scalars()
    return set(rows)


# --- Change signal -----------------------------------------------------------


@dataclass(eq=False)
class _Watcher:
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=64))


class PendingWorkHub:
    """A process-local fan-out for 'the pending set changed' frames. One watcher
    per open SSE stream; a change is dropped into each queue and a slow reader
    simply misses an intermediate summary (it re-reads and catches up)."""

    def __init__(self) -> None:
        self._watchers: set[_Watcher] = set()

    def subscribe(self) -> _Watcher:
        watcher = _Watcher()
        self._watchers.add(watcher)
        return watcher

    def unsubscribe(self, watcher: _Watcher) -> None:
        self._watchers.discard(watcher)

    def subscriber_count(self) -> int:
        return len(self._watchers)

    def notify(self, change: str) -> None:
        """The pending set changed in some way. The frame carries a summary (what
        changed), never the full set: the consumer re-reads when it wants the
        items, so clients never receive the whole set on every change."""
        for watcher in list(self._watchers):
            try:
                watcher.queue.put_nowait({"change": change})
            except asyncio.QueueFull:
                pass

    async def frames(self, watcher: _Watcher):
        """Yield one SSE frame per change, until the client goes away."""
        while True:
            payload = await watcher.queue.get()
            yield format_change(payload["change"])


import json  # noqa: E402  (kept beside the frame formatter it serves)


def format_change(change: str) -> str:
    envelope = {"type": "pending_work.changed", "data": {"change": change}}
    data = json.dumps(envelope)
    return f"event: pending_work.changed\ndata: {data}\n\n"


hub = PendingWorkHub()
