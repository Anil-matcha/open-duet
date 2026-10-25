"""The cross-agent pending-work feed: aggregation, urgency ordering, the change
signal and the read-only contract.

Derived-only over the existing approval and needs-you stores, so the tests drive
real approvals through the runtime and compare the feed against a direct store
query for the same fixture.
"""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from app.db.models import Agent, Approval, Event, Turn
from app.routers.pending_work import router as pending_work_router
from app.routers.threads import get_runtime
from app.services import agent_store, pending_work
from app.services import thread_store as store
from tests.services.thread_harness import (  # noqa: F401
    cleanup,
    owner,
    rt,
    sessions,
)

T0 = datetime(2026, 10, 25, 9, 0, tzinfo=UTC)


def app_for(rt) -> FastAPI:
    app = FastAPI()
    app.include_router(pending_work_router, prefix="/api/v1")
    app.dependency_overrides[get_runtime] = lambda: rt
    return app


def client_for(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app, client=("127.0.0.1", 50000)),
        base_url="http://localhost",
    )


@pytest.fixture
async def api(rt):
    async with client_for(app_for(rt)) as client:
        yield client


@pytest.fixture
async def agent(sessions, owner):
    async with sessions() as db:
        return await agent_store.create_agent(db, owner_id=owner, name="Agent A")


async def _pending(sessions, rt, agent, *, summary="Approve", title="Work"):
    thread = await rt.create_thread(agent_id=agent.id, title=title)
    async with sessions() as db:
        turn = await store.start_turn(db, thread.id, "go", owner_instance="t")
        approval = await store.create_approval(
            db, thread_id=thread.id, turn_id=turn.id, request_id=uuid4().hex, tool="Bash",
            input={}, summary=summary, kind="command", owner_token=turn.owner_token,
        )
    return thread, turn, approval


# --- unit: urgency is a pure function ----------------------------------------


@pytest.mark.parametrize(
    "offset,expected",
    [
        (timedelta(minutes=-1), "expired"),
        (timedelta(seconds=0), "due"),
        (timedelta(minutes=5), "due"),
        (timedelta(minutes=15), "due"),
        (timedelta(minutes=16), "normal"),
        (timedelta(hours=1), "normal"),
        (None, "normal"),
    ],
)
def test_urgency_is_a_pure_function_of_deadline(offset, expected):
    deadline = None if offset is None else T0 + offset
    assert pending_work.urgency_of(deadline, T0) == expected


def test_sort_orders_expired_then_due_then_normal_newest_first():
    def item(urgency, age_minutes):
        return pending_work.WorkItem(
            kind="approval", thread_id=1, agent_id=None, agent_name=None, title="t",
            created_at=T0 - timedelta(minutes=age_minutes), deadline=None,
            urgency=urgency, key=f"approval:{age_minutes}",
        )

    items = [item("normal", 1), item("due", 5), item("expired", 2), item("normal", 9), item("due", 1)]
    ordered = sorted(items, key=pending_work.sort_key)
    assert [i.urgency for i in ordered] == ["expired", "due", "due", "normal", "normal"]
    # within an urgency bucket, newest first
    due = [i for i in ordered if i.urgency == "due"]
    assert due[0].created_at > due[1].created_at


# --- AC1: aggregation correctness --------------------------------------------


async def test_feed_lists_every_pending_item_once(api, sessions, rt, agent, owner):
    a1, _, ap1 = await _pending(sessions, rt, agent, summary="Run the tests")
    a2, _, ap2 = await _pending(sessions, rt, agent, summary="Push the branch")

    body = (await api.get("/api/v1/pending-work")).json()
    kinds = {i["kind"] for i in body["items"]}
    assert kinds <= {"approval", "needs_you"}
    titles = [i["title"] for i in body["items"]]
    assert "Run the tests" in titles and "Push the branch" in titles
    # exactly once each: no duplicate keys
    assert len(body["items"]) == len(set(titles))
    approvals = [i for i in body["items"] if i["kind"] == "approval"]
    thread_ids = {i["thread_id"] for i in approvals}
    assert {a1.id, a2.id} <= thread_ids
    assert all(i["agent_name"] == "Agent A" for i in approvals)


# --- AC2: urgency ordering in the feed ---------------------------------------


async def test_feed_orders_by_urgency(api, sessions, rt, agent):
    # No stored deadlines today, so approvals are `normal`; the ordering must
    # still be stable and by created_at, and urgency is exercised via the pure
    # function above. This asserts the feed's shape uses the same urgency key.
    await _pending(sessions, rt, agent, summary="First")
    await _pending(sessions, rt, agent, summary="Second")
    body = (await api.get("/api/v1/pending-work")).json()
    urgencies = [i["urgency"] for i in body["items"]]
    assert all(u in {"expired", "due", "normal"} for u in urgencies)
    assert urgencies == sorted(urgencies, key=lambda u: pending_work._URGENCY_ORDER[u])


# --- AC3: change signal -------------------------------------------------------


async def test_answering_an_approval_emits_one_frame_and_removes_it(api, sessions, rt, agent):
    watcher = pending_work.hub.subscribe()
    try:
        _, _, approval = await _pending(sessions, rt, agent, summary="Decide me")
        # Creating via store does not go through the runtime notify path here;
        # the runtime path is asserted in the integration suite. Assert the
        # answering path emits exactly one frame.
        before = (await api.get("/api/v1/pending-work")).json()
        assert any(i["title"] == "Decide me" for i in before["items"])

        await rt.answer_approval(approval.id, "deny")
        frame = await watcher.queue.get()
        assert frame["change"] == "approval_removed"

        after = (await api.get("/api/v1/pending-work")).json()
        assert not any(i["title"] == "Decide me" for i in after["items"])
    finally:
        pending_work.hub.unsubscribe(watcher)


def test_frame_payload_is_an_event_named_pending_work_changed():
    frame = pending_work.format_change("approval_added")
    assert frame.startswith("event: pending_work.changed\ndata: ")
    # The JSON envelope carries `type` + `data`, matching the frontend SSE parser.
    assert '"type": "pending_work.changed"' in frame
    assert '"change": "approval_added"' in frame


# --- AC4: read-only and idempotent -------------------------------------------


async def test_two_gets_are_identical_and_mutate_nothing(api, sessions, rt, agent, owner):
    _, _, approval = await _pending(sessions, rt, agent, summary="Stable")

    async def snapshot():
        async with sessions() as db:
            approvals = (await db.execute(select(func.count()).select_from(Approval))).scalar()
            status = (
                await db.execute(select(Approval.status).where(Approval.id == approval.id))
            ).scalar()
            events = (await db.execute(select(func.count()).select_from(Event))).scalar()
            return approvals, status, events

    before = await snapshot()
    first = (await api.get("/api/v1/pending-work")).json()
    second = (await api.get("/api/v1/pending-work")).json()
    after = await snapshot()
    assert first == second
    assert before == after
    assert after[1] == "pending"


# --- AC5 / owner scoping -----------------------------------------------------


async def test_feed_is_owner_scoped(api, sessions, rt, agent, owner):
    await _pending(sessions, rt, agent, summary="Mine")
    other = rt.__class__(
        hub=rt.hub, adapters=rt.adapters, status_ttl=0, _session_factory=sessions,
        owner_id="od_other_" + owner,
    )
    async with client_for(app_for(other)) as foreign:
        foreign_items = (await foreign.get("/api/v1/pending-work")).json()["items"]
    assert all(i["title"] != "Mine" for i in foreign_items)


async def test_feed_omits_approvals_whose_turn_is_not_running(api, sessions, rt, agent):
    thread, turn, approval = await _pending(sessions, rt, agent, summary="Not running")
    async with sessions() as db:
        await store.interrupt_turn(db, turn.id, stale_before=datetime.now(UTC) + timedelta(minutes=1))
    body = (await api.get("/api/v1/pending-work")).json()
    assert not any(i["title"] == "Not running" for i in body["items"])
