"""The "Needs you" card: one server-written card a day in the lead's chat that
lists what only the person can fix.

Local attention is computed on demand: approvals waiting on the
person, routines whose latest run failed or was missed, engines that are signed
out or limited, and faults that keep repeating (Sentinel). A bounded read-only provider snapshot
adds inbox messages and today’s primary-calendar events when the lead has access.
An attention item leaves when
something later proves it fixed (the approval is decided, the routine ran
again, the engine is signed in or reset), never because time passed.

The card is an ordinary event (`card.needs_you`) in the lead's conversation.
Events are append-only, so "edited in place" means a newer event with the same
`card_id`; the client shows only the latest one. It is written only when its
content changed, when something needs the person or a granted source could not
be checked, and never while the conversation has a turn running.
"""
import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import exists, func, or_, select

from app.db.models import (Agent, AgentJob, Approval, NeedsYouState, Routine, RoutineRun,
                           Team, Thread, Turn, WorkColumn, WorkItem, WorkItemRun)
from app.db.transactions import begin_write
from app.services import notification_feed, sentinel
from app.services import thread_store as store

logger = logging.getLogger(__name__)

CARD_EVENT = "card.needs_you"
CARD_ROWS = 6
WINDOW = timedelta(days=7)
AWAY = timedelta(hours=3)
NOTIFIED_KEPT = 200
REPEATED_FAILURES_SHOWN = 3
EMPTY_TEXT = "Nothing needs you right now."

# Most blocking first: nothing runs while an engine is signed out or out of credit.
KIND_ORDER = {
    "signed_out": 0,
    "out_of_credit": 1,
    "usage_limit": 2,
    "approval": 3,
    "question": 4,
    "routine": 5,
    "due": 6,
    "repeated_failure": 7,
    "routine_completed": 8,
    "calendar_event": 9,
    "gmail_message": 10,
}
_BAD_RUN_STATES = frozenset({"failed", "missed", "interrupted"})
_SETTLED_RUN_STATES = frozenset({"completed", "failed", "missed", "interrupted"})


@dataclass(frozen=True)
class Item:
    kind: str
    key: str
    title: str
    detail: str | None
    thread_id: int | None
    at: datetime
    routine_id: int | None = None
    work_item_id: int | None = None
    source: str | None = None
    source_id: str | None = None
    source_url: str | None = None
    source_timestamp: str | None = None
    source_record: dict | None = None

    def public(self) -> dict:
        at = _provider_time(self.source_timestamp) if self.kind in {"gmail_message", "calendar_event"} else self.at
        dated = self.kind not in {"signed_out", "out_of_credit", "usage_limit"} or self.thread_id
        return {"kind": self.kind, "key": self.key, "title": self.title,
                "detail": self.detail, "thread_id": self.thread_id,
                "at": _aware(at).isoformat() if at is not None and dated else None,
                "routine_id": self.routine_id, "work_item_id": self.work_item_id,
                "source_id": self.source_id, "source_url": self.source_url,
                "source_timestamp": self.source_timestamp, "source_record": self.source_record,
                "source": self.source or ("Routine runs" if self.kind.startswith("routine") else
                    "Approvals" if self.kind == "approval" else "Health scan" if self.kind == "repeated_failure" else "Engine status")}


def utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def zone_of(name: str | None) -> ZoneInfo:
    """The zone named, or UTC when it is missing or unknown."""
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            pass
    return ZoneInfo("UTC")


def valid_zone(name: object) -> str:
    """An IANA zone name the host knows, or ValueError."""
    if not isinstance(name, str) or not name or len(name) > 64 or name.startswith(("/", ".")):
        raise ValueError("Send a time zone name such as Europe/Paris.")
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        raise ValueError("That time zone is not known on this computer.") from None
    return name


def local_day(now: datetime, zone: ZoneInfo) -> str:
    return _aware(now).astimezone(zone).date().isoformat()


def _clip(text: str | None, limit: int) -> str:
    text = " ".join((text if isinstance(text, str) else "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# --- what needs the person ---------------------------------------------------------


async def collect(db, owner_id: str, *, now: datetime, engines: list[dict],
                  issues: list[dict]) -> list[Item]:
    """Every item, most blocking first. `engines` are the engine entries
    (`GET /engines`); `issues` are Sentinel's public issues."""
    since = now - WINDOW
    items: list[Item] = []

    for engine in engines:
        label = engine.get("label") or engine["id"]
        limit = engine.get("limit")
        if engine.get("installed") and engine.get("signed_in") is False:
            items.append(Item("signed_out", f"signed_out:{engine['id']}", f"Sign in to {label}",
                              "Nothing can run on this engine until you do.", None, now))
        if limit:
            credits = limit.get("kind") == "credits"
            when = f" Resets {limit['resets_at']}." if limit.get("resets_at") else ""
            items.append(Item(
                "out_of_credit" if credits else "usage_limit", f"{'credit' if credits else 'limit'}:{engine['id']}",
                f"{label} is out of credit" if credits else f"{label} hit its limit",
                _clip((limit.get("message") or "") + when, 160) or None, None, now))

    pending = (await db.execute(
        select(Approval, Thread.title)
        .join(Thread, Thread.id == Approval.thread_id)
        .join(Turn, Turn.id == Approval.turn_id)
        .where(Thread.owner_id == owner_id, Approval.status == "pending", Turn.status == "running")
        .order_by(Approval.created_at, Approval.id)
    )).all()
    for approval, title in pending:
        items.append(Item("approval", f"approval:{approval.id}",
                          _clip(approval.summary or f"Approve {approval.tool}", 120),
                          _clip(title, 80) or None, approval.thread_id,
                          _aware(approval.created_at)))

    routines = {r.id: r for r in (await db.execute(
        select(Routine).where(Routine.owner_id == owner_id,
            ~exists().where(WorkItemRun.routine_id == Routine.id)))).scalars()}
    runs = (await db.execute(
        select(RoutineRun).where(RoutineRun.routine_id.in_(list(routines) or [0]),
                                 RoutineRun.created_at >= since).order_by(RoutineRun.id)
    )).scalars()
    latest: dict[int, RoutineRun] = {}
    for run in runs:
        if run.state in _SETTLED_RUN_STATES:
            latest[run.routine_id] = run
    for routine_id, run in latest.items():
        if run.state in _BAD_RUN_STATES:
            what = "missed its time" if run.state == "missed" else "was interrupted" if run.state == "interrupted" else "failed"
            items.append(Item("routine", f"routine:{routine_id}", f"{routines[routine_id].name} {what}",
                              _clip(run.error, 160) or None, run.thread_id,
                              _aware(run.finished_at or run.created_at), routine_id=routine_id))
    for routine in routines.values():
        if routine.paused and routine.paused_reason:
            items.append(Item("routine", f"routine_paused:{routine.id}", f"{routine.name} is paused",
                              _clip(routine.paused_reason, 160), None, _aware(routine.updated_at), routine_id=routine.id))

    repeated = [i for i in issues if i.get("count", 0) >= sentinel.RETRY_LOOP_MIN
                or i.get("kind") == "repeated_denial"]
    repeated.sort(key=lambda i: (sentinel._SEVERITY_ORDER.get(i.get("severity"), 3), -i.get("count", 0)))
    for issue in repeated[:REPEATED_FAILURES_SHOWN]:
        items.append(Item("repeated_failure", f"repeated_failure:{issue['sig']}",
                          _clip(issue["title"], 120), f"{issue['count']} times in the last day",
                          issue.get("thread_id"), _aware(issue["last_at"])))

    items.sort(key=lambda i: (KIND_ORDER[i.kind], -i.at.timestamp()))
    return items


async def collect_local(db, owner_id: str, *, now: datetime, zone: ZoneInfo,
                        attention: list[Item]) -> list[Item]:
    """Durable local sources for the same card. No provider calls or AI work.

    Completion rows aggregate by routine/day; every source has a stable key.
    Source queries are capped, and the card reports only the rows actually read.
    A failed routine is shown once in attention, not again as a completion.
    """
    items = list(attention)
    since = now - WINDOW
    midnight = _aware(now).astimezone(zone).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    questions = (await db.execute(select(AgentJob, Thread.id)
        .join(Thread, Thread.id == func.coalesce(AgentJob.assignee_thread_id, AgentJob.requester_thread_id))
        .where(AgentJob.owner_id == owner_id, Thread.owner_id == owner_id,
               AgentJob.status == "needs_input", AgentJob.question.is_not(None))
        .order_by(AgentJob.id.desc()).limit(100))).all()
    for job, thread_id in questions:
        # Blocking consultations are answered through the requester; async jobs
        # accept the person's answer in their own conversation.
        target = job.requester_thread_id if job.reply == "wait" else thread_id
        thread = await db.get(Thread, target)
        if thread is None or thread.owner_id != owner_id:
            continue
        items.append(Item("question", f"question:{job.id}", _clip(job.question, 120),
                          "A teammate is waiting for your answer.", target,
                          _aware(job.last_activity_at or job.created_at), source="Team work"))

    due = (await db.execute(select(WorkItem).join(WorkColumn).where(
        WorkItem.owner_id == owner_id, WorkItem.archived.is_(False), WorkColumn.key != "done",
        or_(WorkItem.due_at <= now, WorkItem.due_date <= (_aware(now) + timedelta(days=1)).date()))
        .order_by(WorkItem.id).limit(100))).scalars()
    for task in due:
        if task.due_at:
            if _aware(task.due_at) > now:
                continue
            deadline = _aware(task.due_at).astimezone(zone).strftime("%d %b, %H:%M")
        elif task.due_date and task.due_date <= _aware(now).astimezone(zone_of(task.timezone)).date():
            deadline = f"{task.due_date.isoformat()} ({task.timezone})"
        else:
            continue
        items.append(Item("due", f"due:{task.id}", _clip(f"Task due: {task.title}", 120),
                          f"Due {deadline}. Review the task; this reminder starts no work.",
                          None, _aware(task.updated_at), work_item_id=task.id, source="Tasks & calendar"))

    # Keep the last recorded engine failure after restart. A later successful
    # turn on this provider proves it settled; do not infer success from an
    # absent in-memory limit. Raw error text stays in its source conversation.
    ranked = select(Turn.id.label("id"), func.row_number().over(
        partition_by=Thread.provider, order_by=(Turn.finished_at.desc(), Turn.id.desc())).label("rank"))\
        .join(Thread, Thread.id == Turn.thread_id).where(Thread.owner_id == owner_id,
            Turn.status.in_(["succeeded", "failed"]), Turn.finished_at >= since).subquery()
    failures = (await db.execute(select(Turn, Thread.provider).join(ranked, ranked.c.id == Turn.id)
        .join(Thread, Thread.id == Turn.thread_id).where(ranked.c.rank == 1, Turn.status == "failed",
            Turn.error_code.in_(["engine_limited", "engine_signed_out"])))).all()
    for turn, provider in failures:
        if any(i.key in {f"signed_out:{provider}", f"limit:{provider}", f"credit:{provider}"} for i in items):
            continue
        kind = "signed_out" if turn.error_code == "engine_signed_out" else "usage_limit"
        items.append(Item(kind, f"engine_failure:{provider}:{turn.id}",
                          f"{provider}: last run needed attention", "Review the recorded engine problem and try again.",
                          turn.thread_id, _aware(turn.finished_at), source="Recorded engine failure"))

    blocked = {i.routine_id for i in items if i.kind == "routine"}
    results = (await db.execute(select(Routine.id, Routine.name, func.count(RoutineRun.id),
        func.max(RoutineRun.finished_at)).join(RoutineRun, RoutineRun.routine_id == Routine.id)
        .where(Routine.owner_id == owner_id, RoutineRun.state == "completed",
               ~exists().where(WorkItemRun.routine_id == Routine.id),
               RoutineRun.finished_at >= midnight, RoutineRun.finished_at <= now)
        .group_by(Routine.id, Routine.name).order_by(func.max(RoutineRun.finished_at).desc(), Routine.id)
        .limit(100))).all()
    for routine_id, name, count, finished in results:
        if routine_id not in blocked:
            items.append(Item("routine_completed", f"completed:{routine_id}:{local_day(now, zone)}",
                _clip(f"{name}: {count} completed today", 120), "View the routine's run history.",
                None, _aware(finished), routine_id=routine_id, source="Routine runs"))
    items.sort(key=lambda i: (KIND_ORDER[i.kind], -i.at.timestamp(), i.key))
    return items


# Provider content is displayed as source data only: no model, actions or writes.
# A bounded snapshot is deliberately labelled partial when more records exist.
async def collect_providers(db, owner_id: str, lead_id: int | None, *, now: datetime,
                            zone: ZoneInfo, make_client=None) -> tuple[list[Item], dict]:
    from app import composio_tools
    from app.services import composio_service
    from app.services.composio_client import ComposioClient

    make_client = make_client or ComposioClient
    sources = {"local": "available", "calendar": "unavailable", "gmail": "unavailable"}
    items: list[Item] = []
    midnight = _aware(now).astimezone(zone).replace(hour=0, minute=0, second=0, microsecond=0)
    # Construct local midnights separately so DST days use their actual length.
    end = midnight + timedelta(days=1)
    requests = (("gmail", "gmail", "gmail_fetch_emails", {"query": "in:inbox newer_than:7d", "max_results": 30}),
                ("calendar", "googlecalendar", "googlecalendar_list_events", {
                    "timeMin": midnight.isoformat(), "timeMax": end.isoformat(), "maxResults": 30}))
    for source, app, name, arguments in requests:
        # Freshly check the lead, owner and grants before each provider call.
        agent = await db.scalar(select(Agent).where(Agent.id == lead_id, Agent.owner_id == owner_id,
            Agent.archived_at.is_(None)).execution_options(populate_existing=True)) if lead_id else None
        from app.services.composio_bridge import accounts_for
        scopes = agent.connector_scopes if agent and isinstance(agent.connector_scopes, dict) else {}
        account_ids = accounts_for(agent.connector_account_scopes).get(app, []) if agent else []
        if agent is None or not composio_tools.allows(scopes.get(app), "read") or not account_ids:
            continue
        tool = composio_tools.BY_NAME[name]
        if source == "calendar":
            tool = replace(tool, defaults=tuple((key, True if key == "showDeleted" else value) for key, value in tool.defaults))
        assert tool.kind == "read"
        sent, alias = composio_tools.clean_arguments(tool, arguments)
        try:
            async with asyncio.timeout(15):
                result = await composio_service.run_tool(db, owner_id, make_client, tool, sent, alias,
                                                         allowed_account_ids=account_ids)
        except Exception:
            # Never expose provider error text, request details or credentials.
            sources[source] = "failed"
            continue
        if result.get("error") or not isinstance(result.get("result"), list):
            sources[source] = "unavailable" if result.get("code") in {
                "not_configured", "not_connected", "account_required", "unknown_account"} else "failed"
            continue
        rows = result["result"][:30]
        sources[source] = "partial" if result.get("next_page_token") or result.get("truncated") else "available"
        seen = set()
        timed = []
        if not rows and sources[source] == "available":
            sources[source] = "quiet"
        for row in rows:
            if not isinstance(row, dict):
                sources[source] = "partial"
                continue
            source_id = row.get("messageId") or row.get("id") if source == "gmail" else row.get("id")
            if not isinstance(source_id, str) or not source_id or source_id in seen:
                sources[source] = "partial"
                continue
            seen.add(source_id)
            stamp = row.get("messageTimestamp") or row.get("internalDate") if source == "gmail" else row.get("updated")
            at = _provider_time(stamp)
            if source == "gmail":
                title = _clip(row.get("subject"), 120) or "Inbox message"
                detail = _clip(row.get("sender") or row.get("from"), 160) or None
                # The source ID remains available if the browser has another account open.
                thread_ref = row.get("threadId") if isinstance(row.get("threadId"), str) else source_id
                url = "https://mail.google.com/mail/#all/" + quote(thread_ref, safe="")
            else:
                title = _clip(row.get("summary"), 120) or "Calendar event"
                cancelled = row.get("status") == "cancelled"
                start, finish = _provider_time(row.get("start_dateTime")), _provider_time(row.get("end_dateTime"))
                all_day = row.get("start_date")
                detail = (f"All day: {all_day}" if all_day else
                    f"{start.astimezone(zone):%H:%M}–{finish.astimezone(zone):%H:%M} ({zone.key})" if start and finish else "Time unavailable")
                if cancelled:
                    title = "Cancelled: " + title
                elif start and finish and finish > start:
                    timed.append((source_id, start, finish))
                url = row.get("htmlLink")
                url = _source_link(url)
            items.append(Item("gmail_message" if source == "gmail" else "calendar_event",
                f"{source}:{source_id}", title, detail, None, at or now,
                source="Gmail inbox (last 7 days)" if source == "gmail" else "Primary calendar",
                source_id=source_id, source_url=url, source_timestamp=str(stamp) if stamp is not None else None,
                source_record={key: row.get(key) for key in (
                    ("id", "messageId", "threadId", "messageTimestamp", "internalDate") if source == "gmail" else
                    ("id", "status", "start_dateTime", "start_date", "end_dateTime", "end_date", "updated", "recurringEventId"))}))
        conflicts = {a[0] for a in timed for b in timed if a[0] != b[0] and a[1] < b[2] and b[1] < a[2]}
        if conflicts:
            items = [replace(i, detail="Conflict · " + (i.detail or "")) if i.kind == "calendar_event" and i.source_id in conflicts else i for i in items]
    items.sort(key=lambda item: (KIND_ORDER[item.kind], -item.at.timestamp(), item.key))
    return items, sources


def _source_link(value) -> str | None:
    try:
        parts = urlsplit(value) if isinstance(value, str) else None
        if parts and parts.scheme == "https" and parts.hostname in {"calendar.google.com", "www.google.com"} and not parts.username and not parts.password and parts.port in (None, 443):
            return value
    except ValueError:
        pass
    return None


def _provider_time(value) -> datetime | None:
    try:
        if isinstance(value, (int, float)) or isinstance(value, str) and value.isdigit():
            number = float(value)
            return datetime.fromtimestamp(number / 1000 if number > 100_000_000_000 else number, UTC)
        if isinstance(value, str):
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else None
    except (ValueError, OverflowError, OSError):
        pass
    return None


def build_card(items: list[Item], *, day: str, now: datetime, zone: ZoneInfo, sources: dict | None = None, provider_checked_at: datetime | None = None, provider_unknown: bool = False) -> dict:
    local = _aware(now).astimezone(zone)
    shown = items[:CARD_ROWS]
    return {
        "card_id": f"needs-you:{day}",
        "day": day,
        "title": "Today",
        "subtitle": f"{local:%A}, {local.day} {local:%B}",
        "time_zone": zone.key,
        "checked_at": _aware(now).isoformat(),
        "provider_checked_at": _aware(provider_checked_at).isoformat() if provider_checked_at else None,
        "sources": sources or {"local": "available", "calendar": "unavailable", "gmail": "unavailable"},
        "items": [i.public() for i in shown],
        "more": max(0, len(items) - len(shown)),
        "empty_text": "No local items need you. Connected app data is unknown." if provider_unknown else EMPTY_TEXT,
    }


def card_hash(card: dict) -> str:
    # A periodic check alone is not new content. Persist its timestamp when a
    # changed card is written, so the transcript says when it was last built.
    content = {key: value for key, value in card.items() if key not in {"checked_at", "provider_checked_at", "revision"}}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


# --- the card's life ---------------------------------------------------------------


class NeedsYou:
    """Writes the day's card for one runtime owner. `engines` and `issues` are
    injected so tests need no engine; by default they come from the runtime and
    from Sentinel."""

    def __init__(self, runtime, clock=utcnow, *, engines=None, issues=None, provider_client=None) -> None:
        self.runtime = runtime
        self.clock = clock
        self._provider_client = provider_client
        self._provider_cache = None
        self._engines = engines
        self._issues = issues
        self._dirty = False
        self._rendering = False

    @property
    def owner_id(self) -> str:
        return self.runtime.owner_id

    async def _engine_entries(self) -> list[dict]:
        if self._engines is not None:
            return await self._engines()
        return await self.runtime.engines.describe()

    async def _issue_entries(self, now: datetime) -> list[dict]:
        if self._issues is not None:
            return await self._issues()
        report = await sentinel.scan(self.runtime.session, self.owner_id, now=now)
        return report["issues"]

    async def _state(self, db) -> NeedsYouState:
        # INSERT + row lock also serializes the first visit across backends,
        # where there is no existing state row to lock yet. SQLite callers
        # already hold BEGIN IMMEDIATE; PostgreSQL waits on the owner key.
        if db.get_bind().dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import insert
        else:
            from sqlalchemy.dialects.sqlite import insert
        await db.execute(insert(NeedsYouState).values(
            owner_id=self.owner_id, notified=[], card_revision=0,
        ).on_conflict_do_nothing(index_elements=[NeedsYouState.owner_id]))
        return await db.scalar(select(NeedsYouState).where(
            NeedsYouState.owner_id == self.owner_id).with_for_update()
            .execution_options(populate_existing=True))

    async def _providers(self, db, lead_id, now, zone, *, force_refresh=False):
        # Always re-read authorization before using a snapshot. Changing owner,
        # lead, grants, zone or local day invalidates it immediately.
        agent = await db.scalar(select(Agent).where(Agent.id == lead_id, Agent.owner_id == self.owner_id,
            Agent.archived_at.is_(None)).execution_options(populate_existing=True)) if lead_id else None
        from app.services.composio_bridge import accounts_for
        scopes = agent.connector_scopes if agent and isinstance(agent.connector_scopes, dict) else {}
        account_scopes = accounts_for(agent.connector_account_scopes) if agent else {}
        key = (self.owner_id, lead_id, json.dumps(scopes, sort_keys=True),
               json.dumps(account_scopes, sort_keys=True), zone.key, local_day(now, zone))
        def unknown(sources):
            return any(scopes.get(app) in {"read", "write"} and sources[source] in {"failed", "unavailable", "partial"}
                       for source, app in (("gmail", "gmail"), ("calendar", "googlecalendar")))
        cached = self._provider_cache
        if (not force_refresh and cached and cached[0] == key
                and timedelta(0) <= now - cached[1] < timedelta(minutes=5)):
            return cached[2], cached[3], cached[1], unknown(cached[3])
        items, sources = await collect_providers(db, self.owner_id, lead_id, now=now,
            zone=zone, make_client=self._provider_client)
        self._provider_cache = (key, now, items, sources)
        return items, sources, now, unknown(sources)

    async def read(self, *, refresh=False) -> dict:
        """The card as it would be written now, with no side effects.

        ``refresh`` bypasses the short provider cache for an explicit refresh
        request. Local rows and provider access remain read-only either way.
        """
        now = self.clock()
        async with self.runtime.session() as db:
            state = await db.get(NeedsYouState, self.owner_id)
            zone = zone_of(state.time_zone if state else None)
            items = await collect(db, self.owner_id, now=now, engines=await self._engine_entries(),
                                  issues=await self._issue_entries(now))
            items = await collect_local(db, self.owner_id, now=now, zone=zone, attention=items)
            team = await db.scalar(select(Team).where(Team.owner_id == self.owner_id))
            provider_items, sources, provider_checked, provider_unknown = await self._providers(
                db, team.lead_agent_id if team else None, now, zone, force_refresh=refresh)
        items.extend(provider_items)
        return build_card(items, day=local_day(now, zone), now=now, zone=zone, sources=sources, provider_checked_at=provider_checked, provider_unknown=provider_unknown)

    async def presence(self, time_zone: str) -> dict:
        """The person opened or used the app. Records the zone and the time;
        only a return after 3 hours away, or the first visit of the local day,
        writes the card, and the answer says where it is only if it has
        something to show."""
        zone_name = valid_zone(time_zone)
        now = self.clock()
        async with self.runtime.session() as db:
            await begin_write(db)
            state = await self._state(db)
            previous = _aware(state.last_active_at) if state.last_active_at else None
            old_zone = zone_of(state.time_zone)
            state.time_zone = zone_name
            state.last_active_at = now
            await db.commit()
        skewed = previous is not None and previous - now > timedelta(minutes=5)
        returned = previous is None or (not skewed and now - previous >= AWAY)
        first_today = previous is None or (
            not skewed and local_day(previous, old_zone) != local_day(now, zone_of(zone_name)))
        opened = None
        if returned or first_today:
            opened = await self.render(create=True)
        return {"returned": returned, "first_today": first_today, "open": opened}

    async def tick(self) -> None:
        """The background check: updates today's card, and starts one only for
        something that needs the person. Does nothing until they have been here."""
        async with self.runtime.session() as db:
            state = await db.get(NeedsYouState, self.owner_id)
        if state is None or state.last_active_at is None:
            return
        if self._dirty:
            self._dirty = False
        await self.render(create=False)

    async def _home(self, db, state: NeedsYouState, lead_agent_id: int) -> int | None:
        """The lead's conversation the card lives in: the one it has used today,
        else the lead's newest chat, else None."""
        if state.card_thread_id is not None:
            thread = await db.get(Thread, state.card_thread_id)
            if thread is not None and thread.archived_at is None and thread.agent_id == lead_agent_id:
                return thread.id
        return (await db.execute(
            select(Thread.id).where(Thread.owner_id == self.owner_id, Thread.agent_id == lead_agent_id,
                                    Thread.kind == "chat", Thread.archived_at.is_(None))
            .order_by(Thread.updated_at.desc(), Thread.id.desc()).limit(1)
        )).scalar_one_or_none()

    async def render(self, *, create: bool) -> dict | None:
        """Write or refresh today's card. Returns `{agent_id, thread_id}` when
        the card has something worth opening, else None. `create` says the
        person just arrived; a new card needs an item or unknown granted-source data."""
        if self._rendering:
            self._dirty = True
            return None
        self._rendering = True
        try:
            return await self._render(create)
        finally:
            self._rendering = False

    async def _render(self, create: bool) -> dict | None:
        now = self.clock()
        async with self.runtime.session() as db:
            team = (await db.execute(select(Team).where(Team.owner_id == self.owner_id))).scalar_one_or_none()
            lead_id = team.lead_agent_id if team else None
            state = await db.get(NeedsYouState, self.owner_id)
        if lead_id is None:
            return None
        zone = zone_of(state.time_zone if state else None)
        day = local_day(now, zone)
        async with self.runtime.session() as db:
            items = await collect(db, self.owner_id, now=now, engines=await self._engine_entries(),
                                  issues=await self._issue_entries(now))
            items = await collect_local(db, self.owner_id, now=now, zone=zone, attention=items)
            provider_items, sources, provider_checked, provider_unknown = await self._providers(db, lead_id, now, zone)
        items.extend(provider_items)
        card = build_card(items, day=day, now=now, zone=zone, sources=sources, provider_checked_at=provider_checked, provider_unknown=provider_unknown)
        has_card = state is not None and state.card_day == day and state.card_thread_id is not None
        visible = bool(items) or provider_unknown
        if not has_card and not visible:
            # Quiet sources do not create a finding. A granted source that
            # could not be checked must remain visible even with no rows.
            return None
        digest = card_hash(card)
        async with self.runtime.session() as db:
            await begin_write(db)
            state = await self._state(db)
            thread_id = state.card_thread_id if (state.card_day == day and state.card_thread_id) else None
            if thread_id is None:
                thread_id = await self._home(db, state, lead_id)
            if thread_id is None:
                thread = await self.runtime.create_thread(agent_id=lead_id, title="Today", db=db)
                thread_id = thread.id
            # Serialize with start_turn too: a turn cannot start between the
            # quiet-thread check and publication of the card.
            await store._locked_thread(db, thread_id)
            if await store.running_turn_id(db, thread_id) is not None:
                # Never write into a running turn; the next tick tries again.
                await db.rollback()
                self._dirty = True
                return None
            if state.card_day == day and state.card_thread_id == thread_id and state.card_hash == digest:
                await db.rollback()
                return {"agent_id": lead_id, "thread_id": thread_id} if visible else None
            card["revision"] = (state.card_revision + 1) if state.card_day == day else 1
            await store._add_event(db, thread_id, CARD_EVENT, card, None)
            seen = set(state.notified or [])
            fresh = [i for i in items if i.key not in seen and i.kind not in {"routine_completed", "calendar_event", "gmail_message"}]
            if fresh:
                kinds = sum(i.kind not in {"routine_completed", "calendar_event", "gmail_message"} for i in items)
                notification_feed.add(
                    db, owner_id=self.owner_id, kind="needs_you",
                    title=f"{kinds} thing{'s' if kinds != 1 else ''} need{'' if kinds != 1 else 's'} you",
                    body="\n".join(i.title for i in items if i.kind not in {"routine_completed", "calendar_event", "gmail_message"})[:1000], thread_id=thread_id)
            state.notified = ([*state.notified, *(i.key for i in fresh)])[-NOTIFIED_KEPT:]
            state.card_day, state.card_thread_id, state.card_hash = day, thread_id, digest
            state.card_revision = card["revision"]
            await db.commit()
        self.runtime.hub.notify(thread_id)
        return {"agent_id": lead_id, "thread_id": thread_id} if visible else None
