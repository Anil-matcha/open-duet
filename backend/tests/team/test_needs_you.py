"""The Needs you card: what is listed and when it leaves, when the card is written,
edited and notified, and the presence rules."""
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import delete, select

from app.db.models import (
    Agent, AgentJob, Event, NeedsYouState, Notification, Routine, RoutineRun, Team, Turn, WorkColumn,
)
from app.services import agent_store
from app.services import thread_store as store
from app.team import needs_you, service
from tests.services.thread_harness import cleanup, owner, rt, sessions  # noqa: F401

T0 = datetime(2026, 10, 24, 9, 0, tzinfo=UTC)
SIGNED_OUT = {"id": "claude", "label": "Claude", "installed": True, "signed_in": False, "limit": None}
LIMITED = {"id": "codex", "label": "Codex", "installed": True, "signed_in": True,
           "limit": {"kind": "usage_limit", "resets_at": "2026-10-24T12:00:00+00:00", "message": "Weekly limit"}}
BROKE = {"id": "api", "label": "API", "installed": True, "signed_in": True,
         "limit": {"kind": "credits", "resets_at": None, "message": "No credit"}}


class Clock:
    def __init__(self, now=T0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, **delta):
        self.now += timedelta(**delta)


@pytest.fixture(autouse=True)
def workspace(monkeypatch, tmp_path):
    from app.services import local_claude_runner
    monkeypatch.setattr(local_claude_runner, 'workspace_dir', lambda: tmp_path)


@pytest.fixture(autouse=True)
async def tidy(sessions, owner):
    yield
    async with sessions() as db:
        ids = select(Routine.id).where(Routine.owner_id == owner)
        await db.execute(delete(RoutineRun).where(RoutineRun.routine_id.in_(ids)))
        await db.execute(delete(Routine).where(Routine.owner_id == owner))
        await db.execute(delete(Notification).where(Notification.owner_id == owner))
        await db.execute(delete(NeedsYouState).where(NeedsYouState.owner_id == owner))
        await db.execute(delete(Team).where(Team.owner_id == owner))
        await db.execute(delete(Agent).where(Agent.owner_id == owner))
        await db.commit()


@pytest.fixture
async def lead(sessions, owner):
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=owner, name="Lead")
        await service.set_lead(db, owner, agent.id)
    return agent


def make(rt, clock, engines=(), issues=()):
    async def engines_():
        return list(engines)

    async def issues_():
        return list(issues)
    return needs_you.NeedsYou(rt, clock, engines=engines_, issues=issues_)


async def pending_approval(sessions, rt, agent, summary="Run the tests"):
    thread = await rt.create_thread(agent_id=agent.id, title="Work")
    async with sessions() as db:
        turn = await store.start_turn(db, thread.id, "go", owner_instance="t")
        approval = await store.create_approval(
            db, thread_id=thread.id, turn_id=turn.id, request_id=uuid4().hex, tool="Bash",
            input={}, summary=summary, kind="command", owner_token=turn.owner_token)
    return thread, turn, approval


async def routine_with_runs(sessions, owner, agent, *states, name="Digest"):
    async with sessions() as db:
        routine = Routine(owner_id=owner, agent_id=agent.id, name=name, prompt="x",
                          schedule_kind="interval", schedule_spec={}, next_run_at=T0)
        db.add(routine)
        await db.flush()
        for i, state in enumerate(states):
            db.add(RoutineRun(routine_id=routine.id, trigger="schedule", state=state,
                              error="boom" if state == "failed" else None,
                              scheduled_for=T0 + timedelta(minutes=i),
                              finished_at=T0 + timedelta(minutes=i), created_at=T0 + timedelta(minutes=i)))
        await db.commit()
        return routine


async def events(sessions, thread_id):
    async with sessions() as db:
        return [e for e in (await store.list_all_events(db, thread_id)) if e.type == needs_you.CARD_EVENT]


# --- zones ---------------------------------------------------------------------------


def test_zone_and_day():
    assert needs_you.valid_zone("Europe/Paris") == "Europe/Paris"
    for bad in ("", "Nope/Nowhere", "/etc/passwd", None, 5, "x" * 80):
        with pytest.raises(ValueError):
            needs_you.valid_zone(bad)
    late = datetime(2026, 10, 24, 23, 30, tzinfo=UTC)
    assert needs_you.local_day(late, needs_you.zone_of("UTC")) == "2026-10-24"
    assert needs_you.local_day(late, needs_you.zone_of("Asia/Kolkata")) == "2026-10-25"
    assert needs_you.zone_of("garbage").key == "UTC"


# --- what is listed ------------------------------------------------------------------


async def test_approval_listed_while_pending_only(sessions, rt, owner, lead):
    thread, turn, approval = await pending_approval(sessions, rt, lead)
    async with sessions() as db:
        items = await needs_you.collect(db, owner, now=T0, engines=[], issues=[])
    assert [(i.kind, i.title, i.thread_id) for i in items] == [("approval", "Run the tests", thread.id)]
    async with sessions() as db:
        await store.decide_approval(db, approval.id, "allowed")
        items = await needs_you.collect(db, owner, now=T0, engines=[], issues=[])
    assert items == []


async def test_routine_leaves_when_a_later_run_completes(sessions, rt, owner, lead):
    await routine_with_runs(sessions, owner, lead, "completed", "failed")
    async with sessions() as db:
        items = await needs_you.collect(db, owner, now=T0, engines=[], issues=[])
    assert [i.title for i in items] == ["Digest failed"] and items[0].detail == "boom"
    await routine_with_runs(sessions, owner, lead, "failed", "completed", name="Fixed")
    await routine_with_runs(sessions, owner, lead, "missed", name="Late")
    async with sessions() as db:
        titles = {i.title for i in await needs_you.collect(db, owner, now=T0, engines=[], issues=[])}
    assert titles == {"Digest failed", "Late missed its time"}


async def test_engines_and_repeats_ordered_most_blocking_first(sessions, rt, owner, lead):
    await pending_approval(sessions, rt, lead)
    await routine_with_runs(sessions, owner, lead, "failed")
    issue = {"sig": "s1", "kind": "retry_loop", "title": "Bash failed the same way", "severity": "high",
             "count": 4, "last_at": T0, "thread_id": None}
    quiet = {"sig": "s2", "kind": "tool_error", "title": "once", "severity": "low", "count": 1, "last_at": T0}
    async with sessions() as db:
        items = await needs_you.collect(db, owner, now=T0, engines=[LIMITED, BROKE, SIGNED_OUT], issues=[issue, quiet])
    assert [i.kind for i in items] == [
        "signed_out", "out_of_credit", "usage_limit", "approval", "routine", "repeated_failure"]
    # An engine that is not installed is not "signed out".
    async with sessions() as db:
        gone = await needs_you.collect(db, owner, now=T0, engines=[{**SIGNED_OUT, "installed": False}], issues=[])
    assert all(i.kind != "signed_out" for i in gone)


async def test_card_caps_rows_and_counts_the_rest():
    items = [needs_you.Item("approval", f"a{i}", f"t{i}", None, None, T0) for i in range(9)]
    card = needs_you.build_card(items, day="2026-10-24", now=T0, zone=needs_you.zone_of("UTC"))
    assert len(card["items"]) == needs_you.CARD_ROWS and card["more"] == 3
    assert card["subtitle"] == "Saturday, 24 October" and card["card_id"] == "needs-you:2026-10-24"


# --- the card's life -----------------------------------------------------------------


async def test_never_posted_empty_and_needs_a_lead(sessions, rt, owner):
    clock = Clock()
    assert await make(rt, clock, [SIGNED_OUT]).render(create=True) is None  # no lead
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=owner, name="Lead")
        await service.set_lead(db, owner, agent.id)
    assert await make(rt, clock).render(create=True) is None  # nothing to say
    async with sessions() as db:
        assert (await db.get(NeedsYouState, owner)) is None


async def test_card_written_once_edited_in_place_and_notified_once(sessions, rt, owner, lead):
    clock = Clock()
    engines = [SIGNED_OUT]
    ny = make(rt, clock, engines)
    opened = await ny.render(create=False)
    assert opened["agent_id"] == lead.id
    thread_id = opened["thread_id"]
    first = await events(sessions, thread_id)
    assert len(first) == 1 and first[0].data["revision"] == 1
    assert first[0].data["items"][0]["key"] == "signed_out:claude"
    # Nothing changed: no new event, no second notification.
    clock.advance(minutes=1)
    assert (await ny.render(create=False))["thread_id"] == thread_id
    assert len(await events(sessions, thread_id)) == 1
    # Something new: same card id, next revision, a second notification.
    engines.append(LIMITED)
    await ny.render(create=False)
    cards = await events(sessions, thread_id)
    assert [c.data["revision"] for c in cards] == [1, 2]
    assert {c.data["card_id"] for c in cards} == {"needs-you:2026-10-24"}
    async with sessions() as db:
        notes = (await db.execute(select(Notification).where(Notification.owner_id == owner))).scalars().all()
    assert len(notes) == 2 and notes[0].kind == "needs_you" and notes[0].thread_id == thread_id
    # It clears: the card is edited to the empty text rather than left stale.
    engines.clear()
    assert await ny.render(create=False) is None
    last = (await events(sessions, thread_id))[-1].data
    assert last["items"] == [] and last["revision"] == 3 and last["empty_text"] == needs_you.EMPTY_TEXT
    async with sessions() as db:
        assert len((await db.execute(select(Notification).where(Notification.owner_id == owner))).scalars().all()) == 2


async def test_next_day_is_a_new_card(sessions, rt, owner, lead):
    clock = Clock()
    ny = make(rt, clock, [SIGNED_OUT])
    thread_id = (await ny.render(create=False))["thread_id"]
    clock.advance(days=1)
    await ny.render(create=False)
    cards = await events(sessions, thread_id)
    assert [(c.data["day"], c.data["revision"]) for c in cards] == [("2026-10-24", 1), ("2026-10-25", 1)]


async def test_never_written_into_a_running_turn(sessions, rt, owner, lead):
    clock = Clock()
    thread = await rt.create_thread(agent_id=lead.id, title="Chat")
    async with sessions() as db:
        await store.start_turn(db, thread.id, "busy", owner_instance="t")
    ny = make(rt, clock, [SIGNED_OUT])
    assert await ny.render(create=True) is None
    assert await events(sessions, thread.id) == []
    async with sessions() as db:
        turn = (await db.execute(select(Turn).where(Turn.thread_id == thread.id))).scalar_one()
        turn.status = "succeeded"
        await db.commit()
    assert (await ny.render(create=True))["thread_id"] == thread.id  # the lead's existing chat is reused
    assert len(await events(sessions, thread.id)) == 1


# --- presence ------------------------------------------------------------------------


async def test_presence_stores_zone_and_opens_only_on_return_or_new_day(sessions, rt, owner, lead):
    clock = Clock()
    ny = make(rt, clock, [SIGNED_OUT])
    with pytest.raises(ValueError):
        await ny.presence("Not/AZone")
    first = await ny.presence("Asia/Kolkata")
    assert first["returned"] and first["first_today"] and first["open"]["agent_id"] == lead.id
    async with sessions() as db:
        state = await db.get(NeedsYouState, owner)
        assert state.time_zone == "Asia/Kolkata" and state.card_day == "2026-10-24"
    # A ping a few minutes later records the time and opens nothing.
    clock.advance(minutes=5)
    quick = await ny.presence("Asia/Kolkata")
    assert not quick["returned"] and not quick["first_today"] and quick["open"] is None
    # Back after three hours: edits the same card in place.
    clock.advance(hours=3)
    back = await ny.presence("Asia/Kolkata")
    assert back["returned"] and back["open"]["thread_id"] == first["open"]["thread_id"]
    assert len(await events(sessions, first["open"]["thread_id"])) == 1
    # A clock that ran backwards counts as neither a return nor a new day.
    clock.advance(hours=-1)
    skew = await ny.presence("Asia/Kolkata")
    assert not skew["returned"] and not skew["first_today"]


async def test_tick_waits_until_the_person_has_been_here(sessions, rt, owner, lead):
    clock = Clock()
    ny = make(rt, clock, [SIGNED_OUT])
    await ny.tick()
    async with sessions() as db:
        assert await db.get(NeedsYouState, owner) is None
    async with sessions() as db:
        db.add(NeedsYouState(owner_id=owner, time_zone="UTC", last_active_at=T0, notified=[]))
        await db.commit()
    await ny.tick()
    async with sessions() as db:
        assert (await db.get(NeedsYouState, owner)).card_thread_id is not None


# --- who started a turn --------------------------------------------------------------


async def test_turn_records_who_started_it(sessions, rt, owner, lead):
    thread = await rt.create_thread(agent_id=lead.id)
    async with sessions() as db:
        turn = await store.start_turn(db, thread.id, "hi", owner_instance="t", origin="routine")
        assert (await db.get(Turn, turn.id)).origin == "routine"


# --- routes --------------------------------------------------------------------------


async def test_routes_read_and_presence(sessions, rt, owner, lead):
    import httpx
    from fastapi import FastAPI

    from app.routers import needs_you as route

    app = FastAPI()
    app.include_router(route.router)
    app.dependency_overrides[route.get_runtime] = lambda: rt
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as client:
        read = await client.get("/needs-you")
        assert read.status_code == 200 and read.json()["items"] == [] and read.json()["title"] == "Today"
        bad = await client.post("/needs-you/presence", json={"time_zone": "Mars/Base"})
        assert bad.status_code == 422
        ok = await client.post("/needs-you/presence", json={"time_zone": "Europe/Paris"})
        assert ok.status_code == 200 and ok.json()["returned"] is True and ok.json()["open"] is None  # nothing to say
    async with sessions() as db:
        assert (await db.get(NeedsYouState, owner)).time_zone == "Europe/Paris"


async def test_local_completions_use_owner_day_and_refresh_quietly(sessions, rt, owner, lead):
    # 20:00 UTC belongs to tomorrow in Kolkata but today in Los Angeles.
    clock = Clock(datetime(2026, 10, 24, 20, tzinfo=UTC))
    routine = await routine_with_runs(sessions, owner, lead, "completed", "completed")
    async with sessions() as db:
        runs = list((await db.scalars(select(RoutineRun).where(RoutineRun.routine_id == routine.id))).all())
        for run in runs:
            run.finished_at = clock.now - timedelta(minutes=5)
        await db.commit()
    ny = make(rt, clock)
    opened = await ny.presence("Asia/Kolkata")
    thread_id = opened["open"]["thread_id"]
    card = (await events(sessions, thread_id))[-1].data
    assert card["title"] == "Today" and card["day"] == "2026-10-25"
    assert len(card["items"]) == 1 and "2 completed today" in card["items"][0]["title"]
    assert card["items"][0]["routine_id"] == routine.id
    assert card["items"][0]["source"] == "Routine runs"
    assert card["sources"] == {"local": "available", "calendar": "unavailable", "gmail": "unavailable"}
    clock.advance(minutes=1)
    await ny.tick()
    assert len(await events(sessions, thread_id)) == 1
    async with sessions() as db:
        assert not list((await db.scalars(select(Notification).where(Notification.owner_id == owner))).all())


async def test_questions_and_recorded_engine_failure_survive_new_brief_instance(sessions, rt, owner, lead):
    thread = await rt.create_thread(agent_id=lead.id)
    async with sessions() as db:
        turn = await store.start_turn(db, thread.id, "go", owner_instance="t")
        turn.status, turn.finished_at, turn.error_code = "failed", T0, "engine_limited"
        job = AgentJob(owner_id=owner, requester_agent_id=lead.id, requester_thread_id=thread.id,
                       requester_turn_id=turn.id, assignee_agent_id=lead.id, assignee_thread_id=thread.id,
                       status="needs_input", reply="resume", brief="Review", brief_hash="x",
                       question="Which environment?", last_activity_at=T0)
        db.add(job)
        await db.commit()
    ny = make(rt, Clock())
    card = await ny.read()
    assert {row["kind"] for row in card["items"]} == {"question", "usage_limit"}
    assert all(row["thread_id"] == thread.id and row["at"] for row in card["items"])
    async with sessions() as db:
        later = await store.start_turn(db, thread.id, "retry", owner_instance="t")
        later.status, later.finished_at = "succeeded", T0 + timedelta(minutes=1)
        job = await db.get(AgentJob, job.id)
        job.status = "completed"
        await db.commit()
    assert (await make(rt, Clock(T0 + timedelta(minutes=2))).read())["items"] == []


async def test_due_tasks_are_inert_and_exclude_done_and_other_owners(sessions, rt, owner, lead):
    from app.services import work_planner
    async with sessions() as db:
        board = await work_planner.default_board(db, owner)
        columns = {c.key: c.id for c in (await db.scalars(select(WorkColumn).where(WorkColumn.board_id == board.id))).all()}
        task = await work_planner.create_item(db, owner, {"board_id": board.id, "column_id": columns["backlog"],
            "title": "Review deployment", "due_date": T0.date(), "timezone": "UTC"})
        await work_planner.create_item(db, owner, {"board_id": board.id, "column_id": columns["done"],
            "title": "Finished", "due_date": T0.date(), "timezone": "UTC"})
        other_board = await work_planner.default_board(db, owner + "-other")
        other_column = await db.scalar(select(WorkColumn.id).where(WorkColumn.board_id == other_board.id).limit(1))
        await work_planner.create_item(db, owner + "-other", {"board_id": other_board.id, "column_id": other_column,
            "title": "Private other task", "due_date": T0.date(), "timezone": "UTC"})
    card = await make(rt, Clock()).read()
    due = [row for row in card["items"] if row["kind"] == "due"]
    assert len(due) == 1 and due[0]["work_item_id"] == task.id
    assert due[0]["thread_id"] is None
    async with sessions() as db:
        assert not list((await db.scalars(select(Routine).where(Routine.owner_id == owner))).all())


@pytest.mark.parametrize('has_home', [False, True])
async def test_concurrent_brief_instances_publish_one_card_and_notification(sessions, rt, owner, lead, has_home):
    import asyncio
    from app.db.models import Thread

    if has_home:
        await rt.create_thread(agent_id=lead.id)
    instances = [make(rt, Clock(), [SIGNED_OUT]) for _ in range(4)]
    opened = await asyncio.gather(*(ny.render(create=True) for ny in instances))
    assert len({item['thread_id'] for item in opened}) == 1
    async with sessions() as db:
        threads = list(await db.scalars(select(Thread).where(Thread.owner_id == owner)))
        cards = list(await db.scalars(select(Event).where(
            Event.thread_id.in_([t.id for t in threads]), Event.type == needs_you.CARD_EVENT)))
        notes = list(await db.scalars(select(Notification).where(Notification.owner_id == owner)))
        state = await db.get(NeedsYouState, owner)
    assert len(threads) == len(cards) == len(notes) == 1
    assert cards[0].data['revision'] == state.card_revision == 1


async def test_concurrent_first_presence_preserves_owner_state(sessions, rt, owner, lead):
    import asyncio

    responses = await asyncio.gather(*(make(rt, Clock(), [SIGNED_OUT]).presence('Asia/Kolkata')
                                       for _ in range(4)))
    assert sum(r['first_today'] for r in responses) == 1
    async with sessions() as db:
        state = await db.get(NeedsYouState, owner)
        assert state.time_zone == 'Asia/Kolkata' and state.card_revision == 1
        notes = list(await db.scalars(select(Notification).where(Notification.owner_id == owner)))
    assert len(notes) == 1


async def test_failed_card_publication_rolls_back_new_conversation(sessions, rt, owner, lead, monkeypatch):
    from app.db.models import Thread

    async def fail(*args, **kwargs):
        raise RuntimeError('publication failed')

    monkeypatch.setattr(store, '_add_event', fail)
    with pytest.raises(RuntimeError, match='publication failed'):
        await make(rt, Clock(), [SIGNED_OUT]).render(create=True)
    async with sessions() as db:
        assert not list(await db.scalars(select(Thread).where(Thread.owner_id == owner)))
        assert await db.get(NeedsYouState, owner) is None


@pytest.fixture
async def provider_fixture(sessions, owner, lead, monkeypatch):
    """Real connector service/client/projection with synthetic HTTP only."""
    import httpx
    import json
    from app.services import composio_service
    from app.services.composio_client import ComposioClient
    calls, answers = [], {"gmail": {"messages": []}, "googlecalendar": {"items": []}}
    async def record(db, scoped_owner):
        assert scoped_owner == owner
        return {"api_key": "ak_synthetic123", "user_id": "today_user", "session_id": "session_today"}
    monkeypatch.setattr(composio_service, "load", record)
    def handler(request):
        if request.method == "GET":
            assert request.url.params["user_ids"] == "today_user"
            app = request.url.params["toolkit_slugs"]
            return httpx.Response(200, json={"items": [{"id": "account_" + app,
                "user_id": "today_user", "toolkit": {"slug": app}, "status": "ACTIVE"}]})
        body = json.loads(request.content)
        calls.append(body)
        assert request.url.path.endswith("/execute")
        assert body["tool_slug"] in {"GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST"}
        app = "gmail" if body["tool_slug"] == "GMAIL_FETCH_EMAILS" else "googlecalendar"
        assert body["account"] == "account_" + app
        if answers[app] == "failure":
            return httpx.Response(503, json={"error": {"message": "ak_synthetic123 secret"}})
        return httpx.Response(200, json={"result_type": "completed", "data": answers[app]})
    async with sessions() as db:
        agent = await db.get(Agent, lead.id)
        agent.connector_scopes = {"gmail": "read", "googlecalendar": "read"}
        await db.commit()
    return lambda key: ComposioClient(key, transport=httpx.MockTransport(handler)), answers, calls


async def test_provider_brief_sources_conflicts_cancellations_and_no_writes(sessions, rt, owner, lead, provider_fixture):
    factory, answers, calls = provider_fixture
    answers["gmail"] = {"messages": [{"id": "mail1", "threadId": "thread1", "subject": "Review deadline",
        "internalDate": "1792832400000", "sender": "sender@example.test"}], "nextPageToken": "more"}
    def event(id, start, end, **extra):
        return {"id": id, "summary": id, "start": {"dateTime": start}, "end": {"dateTime": end},
            "updated": "2026-10-24T08:00:00Z", "htmlLink": "https://calendar.google.com/calendar/event?eid=" + id, **extra}
    answers["googlecalendar"] = {"items": [
        event("meeting1", "2026-10-24T10:00:00Z", "2026-10-24T11:00:00Z"),
        event("meeting2", "2026-10-24T10:30:00Z", "2026-10-24T12:00:00Z"),
        event("cancelled", "2026-10-24T10:00:00Z", "2026-10-24T11:00:00Z", status="cancelled"),
        {"id": "all-day", "summary": "Holiday", "start": {"date": "2026-10-24"}, "end": {"date": "2026-10-25"}}]}
    async def empty():
        return []
    ny = needs_you.NeedsYou(rt, Clock(), engines=empty, issues=empty, provider_client=factory)
    card = await ny.read()
    assert card["sources"] == {"local": "available", "gmail": "partial", "calendar": "available"}
    rows = {i["source_id"]: i for i in card["items"]}
    assert rows["mail1"]["source_url"] == "https://mail.google.com/mail/#all/thread1"
    assert rows["mail1"]["source_timestamp"] == "1792832400000"
    assert rows["mail1"]["source_record"]["threadId"] == "thread1"
    assert all(rows[k]["detail"].startswith("Conflict") for k in ("meeting1", "meeting2"))
    assert rows["cancelled"]["title"].startswith("Cancelled") and "Conflict" not in rows["cancelled"]["detail"]
    assert rows["all-day"]["detail"] == "All day: 2026-10-24" and rows["all-day"]["at"] is None
    assert len(calls) == 2 and calls[1]["arguments"]["showDeleted"] is True
    assert await ny.render(create=True)
    async with sessions() as db:
        assert not list(await db.scalars(select(Notification).where(Notification.owner_id == owner)))


async def test_provider_quiet_failure_grant_revocation_and_owner_isolation(sessions, owner, lead, provider_fixture):
    factory, answers, calls = provider_fixture
    async with sessions() as db:
        async def collect(scoped_owner=owner):
            return await needs_you.collect_providers(db, scoped_owner, lead.id, now=T0,
                zone=needs_you.zone_of("UTC"), make_client=factory)
        items, sources = await collect()
        assert items == [] and sources["gmail"] == sources["calendar"] == "quiet"
        answers["gmail"] = "failure"
        _, sources = await collect()
        assert sources["gmail"] == "failed" and sources["calendar"] == "quiet"
        agent = await db.get(Agent, lead.id)
        agent.connector_scopes = {}
        await db.commit()
        before = len(calls)
        _, sources = await collect()
        assert sources["gmail"] == sources["calendar"] == "unavailable" and len(calls) == before
        _, sources = await collect(owner + "other")
        assert sources["gmail"] == sources["calendar"] == "unavailable" and len(calls) == before


async def test_provider_day_uses_local_dst_midnights(sessions, owner, lead, provider_fixture):
    factory, answers, calls = provider_fixture
    async with sessions() as db:
        await needs_you.collect_providers(db, owner, lead.id, now=datetime(2026, 11, 1, 12, tzinfo=UTC),
            zone=needs_you.zone_of("America/New_York"), make_client=factory)
    args = calls[1]["arguments"]
    assert args["timeMin"] == "2026-11-01T00:00:00-04:00"
    assert args["timeMax"] == "2026-11-02T00:00:00-05:00"


async def test_provider_cache_throttles_refresh_preserves_failure_and_invalidates_grants(sessions, rt, owner, lead, provider_fixture):
    factory, answers, calls = provider_fixture
    async def empty():
        return []
    clock = Clock()
    ny = needs_you.NeedsYou(rt, clock, engines=empty, issues=empty, provider_client=factory)
    first = await ny.read()
    clock.advance(minutes=1)
    second = await ny.read()
    assert len(calls) == 2 and first["provider_checked_at"] == second["provider_checked_at"]
    assert needs_you.card_hash(first) == needs_you.card_hash(second)
    clock.advance(minutes=4)
    answers["gmail"] = "failure"
    failed = await ny.read()
    assert len(calls) == 4 and failed["sources"]["gmail"] == "failed"
    assert failed["provider_checked_at"] != first["provider_checked_at"]
    clock.advance(minutes=1)
    assert (await ny.read())["sources"]["gmail"] == "failed" and len(calls) == 4
    async with sessions() as db:
        agent = await db.get(Agent, lead.id)
        agent.connector_scopes = {"googlecalendar": "read"}
        await db.commit()
    revoked = await ny.read()
    assert revoked["sources"]["gmail"] == "unavailable" and len(calls) == 5


def test_provider_timestamps_and_links_do_not_invent_missing_values():
    assert needs_you._provider_time("2026-10-24T10:00:00") is None
    assert needs_you._provider_time("invalid") is None
    assert needs_you._provider_time("1792832400000").tzinfo == UTC
    for value in ("https://calendar.google.com:bad/event", "https://evil.test/event", "javascript:alert(1)"):
        assert needs_you._source_link(value) is None


@pytest.mark.parametrize('problem', ['failure', 'missing_account', 'missing_configuration'])
async def test_granted_unknown_provider_creates_visible_card_without_attention_alert(sessions, rt, owner, lead, provider_fixture, monkeypatch, problem):
    from app.services import composio_service
    from app.services.composio_client import ComposioClient
    import httpx
    factory, answers, calls = provider_fixture
    if problem == 'failure':
        answers['gmail'] = 'failure'
    elif problem == 'missing_configuration':
        async def no_config(*args):
            return None
        monkeypatch.setattr(composio_service, 'load', no_config)
    else:
        # A valid owner configuration with no connected accounts.
        factory = lambda key: ComposioClient(key, transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={'items': []})))
    async def empty():
        return []
    ny = needs_you.NeedsYou(rt, Clock(), engines=empty, issues=empty, provider_client=factory)
    opened = await ny.render(create=True)
    assert opened and opened['agent_id'] == lead.id
    cards = await events(sessions, opened['thread_id'])
    assert len(cards) == 1 and cards[0].data['items'] == []
    card = cards[0].data
    assert card['sources']['gmail'] == ('failed' if problem == 'failure' else 'unavailable')
    assert 'unknown' in card['empty_text'] and card['empty_text'] != needs_you.EMPTY_TEXT
    # Repeated failure remains visible without another card or alert.
    assert await ny.render(create=False) == opened
    assert len(await events(sessions, opened['thread_id'])) == 1
    async with sessions() as db:
        assert not list(await db.scalars(select(Notification).where(Notification.owner_id == owner)))


async def test_successfully_checked_empty_providers_do_not_create_a_finding(sessions, rt, owner, lead, provider_fixture):
    factory, answers, calls = provider_fixture
    async def empty():
        return []
    ny = needs_you.NeedsYou(rt, Clock(), engines=empty, issues=empty, provider_client=factory)
    assert await ny.render(create=True) is None
    card = await ny.read()
    assert card['sources']['gmail'] == card['sources']['calendar'] == 'quiet'
    async with sessions() as db:
        assert await db.get(NeedsYouState, owner) is None
        assert not list(await db.scalars(select(Notification).where(Notification.owner_id == owner)))
