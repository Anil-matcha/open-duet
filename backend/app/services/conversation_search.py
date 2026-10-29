"""Full-text search across conversations (docs/EVERYDAY.md).

One portable query on SQLite and PostgreSQL: every word of the query must
appear in a title or in one message, case-insensitively. Message text is read
from the event JSON with SQLAlchemy's JSON element access (json_extract on
SQLite, ->> on PostgreSQL). No FTS index.
"""

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Event, Thread

MIN_QUERY_CHARS = 2
MAX_TERMS = 6
SNIPPET_BEFORE = 60
SNIPPET_AFTER = 100
MESSAGE_TYPES = {"turn.started": "user", "assistant.message": "assistant", "room.message": "assistant"}


@dataclass
class SearchHit:
    thread_id: int
    thread_title: str | None
    agent_id: int | None
    archived: bool
    kind: str  # title | user | assistant
    at: datetime
    snippet: str
    highlights: list[list[int]] = field(default_factory=list)
    seq: int | None = None
    turn_id: int | None = None
    room_id: int | None = None


def query_terms(query: str) -> list[str]:
    """Distinct lower-cased words, longest first, at most MAX_TERMS."""
    seen: list[str] = []
    for word in query.lower().split():
        if word not in seen:
            seen.append(word)
    return sorted(seen[:MAX_TERMS], key=len, reverse=True)


def _matches_all(text: str, terms: list[str]) -> bool:
    folded = text.lower()
    return all(term in folded for term in terms)


def make_snippet(
    text: str, terms: list[str], *, before: int = SNIPPET_BEFORE, after: int = SNIPPET_AFTER
) -> tuple[str, list[list[int]]]:
    """About 160 characters around the first match, whitespace folded, with
    `[start, length]` of every term occurrence inside it."""
    flat = " ".join(text.split())
    folded = flat.lower()
    positions = [folded.find(term) for term in terms if folded.find(term) >= 0]
    first = min(positions) if positions else 0
    start = max(0, first - before)
    if start > 0:
        space = flat.find(" ", start, first) if first > start else -1
        start = space + 1 if space >= 0 else start
    end = min(len(flat), start + before + after)
    head = "…" if start > 0 else ""
    tail = "…" if end < len(flat) else ""
    snippet = head + flat[start:end] + tail
    lowered = snippet.lower()
    spans: list[list[int]] = []
    for term in terms:
        at = lowered.find(term)
        while at >= 0:
            if not any(s <= at < s + n or at <= s < at + len(term) for s, n in spans):
                spans.append([at, len(term)])
            at = lowered.find(term, at + len(term))
    spans.sort()
    return snippet, spans


def _like_all(column, terms: list[str]):
    return and_(*[column.icontains(term, autoescape=True) for term in terms])


async def search(
    db: AsyncSession,
    owner_id: str,
    query: str,
    *,
    agent_id: int | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    include_archived: bool = False,
    include_delegated: bool = False,
    limit: int = 40,
) -> list[SearchHit]:
    hits, _ = await search_page(
        db,
        owner_id,
        query,
        agent_id=agent_id,
        since=since,
        until=until,
        include_archived=include_archived,
        include_delegated=include_delegated,
        limit=limit,
    )
    return hits


async def search_page(
    db: AsyncSession,
    owner_id: str,
    query: str,
    *,
    agent_id: int | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    include_archived: bool = False,
    include_delegated: bool = False,
    limit: int = 40,
    offset: int = 0,
) -> tuple[list[SearchHit], bool]:
    """One page of `search` (newest first) and whether more hits may follow.
    Each source is read down to `offset + limit + 1` rows and merged, so a
    page is the same slice of one stable order however deep it is. A title hit
    is left out whenever the conversation has any message hit, so that order
    never depends on how far down the messages were read."""
    terms = query_terms(query)
    if len(query.strip()) < MIN_QUERY_CHARS or not terms:
        return [], False
    fetch = offset + limit + 1

    def scoped(statement, at_column):
        statement = statement.where(Thread.owner_id == owner_id, Thread.kind != "room_member")
        if not include_delegated:
            statement = statement.where(Thread.kind != "job")
        if not include_archived:
            statement = statement.where(Thread.archived_at.is_(None))
        if agent_id is not None:
            statement = statement.where(Thread.agent_id == agent_id)
        if since is not None:
            statement = statement.where(at_column >= since)
        if until is not None:
            statement = statement.where(at_column <= until)
        return statement

    message_text = func.coalesce(
        Event.data["text"].as_string(), Event.data["prompt_text"].as_string()
    )
    message_hit = (
        select(Event.id)
        .where(
            Event.thread_id == Thread.id,
            Event.type.in_(tuple(MESSAGE_TYPES)),
            _like_all(message_text, terms),
        )
        .correlate(Thread)
    )
    if since is not None:
        message_hit = message_hit.where(Event.created_at >= since)
    if until is not None:
        message_hit = message_hit.where(Event.created_at <= until)
    titles = (
        scoped(
            select(Thread).where(
                Thread.title.is_not(None), _like_all(Thread.title, terms), ~exists(message_hit)
            ),
            Thread.updated_at,
        )
        .order_by(Thread.updated_at.desc(), Thread.id.desc())
        .limit(fetch)
    )
    messages = (
        scoped(
            select(Event, Thread, message_text.label("body"))
            .join(Thread, Thread.id == Event.thread_id)
            .where(Event.type.in_(tuple(MESSAGE_TYPES)), _like_all(message_text, terms)),
            Event.created_at,
        )
        .order_by(Event.created_at.desc(), Event.id.desc())
        .limit(fetch)
    )

    hits: list[SearchHit] = []
    titled = list((await db.execute(titles)).scalars())
    message_rows = (await db.execute(messages)).all()
    for event, thread, body in message_rows:
        body = body or ""
        # LIKE matched the database's lower(); confirm in Python so a hit is
        # never shown without the words in it.
        if not _matches_all(body, terms):
            continue
        snippet, spans = make_snippet(body, terms)
        hits.append(
            SearchHit(
                thread_id=thread.id, room_id=thread.room_id,
                thread_title=thread.title,
                agent_id=thread.agent_id,
                archived=thread.archived_at is not None,
                kind=MESSAGE_TYPES[event.type],
                at=event.created_at,
                snippet=snippet,
                highlights=spans,
                seq=event.seq,
                turn_id=event.turn_id,
            )
        )
    for thread in titled:
        # A title is usually the first message cut short: a conversation with a
        # message hit is shown by that hit alone (the query above leaves it out).
        snippet, spans = make_snippet(thread.title or "", terms)
        hits.append(
            SearchHit(
                thread_id=thread.id, room_id=thread.room_id,
                thread_title=thread.title,
                agent_id=thread.agent_id,
                archived=thread.archived_at is not None,
                kind="title",
                at=thread.updated_at,
                snippet=snippet,
                highlights=spans,
            )
        )
    hits.sort(key=lambda hit: hit.at, reverse=True)
    # A source that filled its read may hold more than it returned, so a full
    # last page can still be followed by one.
    cut = len(message_rows) >= fetch or len(titled) >= fetch
    more = len(hits) > offset + limit or (cut and len(hits) >= offset + limit)
    return hits[offset : offset + limit], more


async def search_any(
    db: AsyncSession,
    owner_id: str,
    terms: list[str],
    *,
    agent_id: int,
    exclude_thread_id: int | None = None,
    candidates: int = 200,
) -> list[tuple[SearchHit, int]]:
    """Messages in one agent's conversations holding ANY of `terms`, newest
    first, each with how many distinct terms it holds (for recall, which
    ranks by that). Archived conversations and `exclude_thread_id` are left
    out. The same portable query as `search`, with OR instead of AND."""
    terms = [t for t in terms if t]
    if not terms:
        return []
    message_text = func.coalesce(
        Event.data["text"].as_string(), Event.data["prompt_text"].as_string()
    )
    statement = (
        select(Event, Thread, message_text.label("body"))
        .join(Thread, Thread.id == Event.thread_id)
        .where(
            Thread.owner_id == owner_id,
            Thread.agent_id == agent_id,
            Thread.archived_at.is_(None),
            Event.type.in_(tuple(MESSAGE_TYPES)),
            or_(*[message_text.icontains(term, autoescape=True) for term in terms]),
        )
        .order_by(Event.created_at.desc(), Event.id.desc())
        .limit(candidates)
    )
    if exclude_thread_id is not None:
        statement = statement.where(Thread.id != exclude_thread_id)
    out: list[tuple[SearchHit, int]] = []
    for event, thread, body in (await db.execute(statement)).all():
        body = body or ""
        folded = body.lower()
        matched = sum(1 for term in terms if term in folded)
        if not matched:
            continue
        snippet, spans = make_snippet(body, terms, before=120, after=240)
        out.append(
            (
                SearchHit(
                    thread_id=thread.id, room_id=thread.room_id,
                    thread_title=thread.title,
                    agent_id=thread.agent_id,
                    archived=False,
                    kind=MESSAGE_TYPES[event.type],
                    at=event.created_at,
                    snippet=snippet,
                    highlights=spans,
                    seq=event.seq,
                    turn_id=event.turn_id,
                ),
                matched,
            )
        )
    return out
