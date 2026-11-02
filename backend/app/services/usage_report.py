"""Token and cost totals from what engines reported (docs/EVERYDAY.md).

The turn table is the ledger: each finished turn keeps the `usage` its engine
reported (input/output/cache tokens, cost_usd) or nothing. Totals never
estimate: a cost is the sum of reported costs, or None when no turn in the
group reported one.
"""

import csv
import io
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Agent, Thread, Turn
from app.services import helper_usage

TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def _int(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _cost(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value >= 0 and value == value and value != float("inf") else None


def reported(usage: dict | None) -> dict:
    """Only the well-formed numbers of a stored usage dict."""
    usage = usage if isinstance(usage, dict) else {}
    out = {key: _int(usage.get(key)) for key in TOKEN_KEYS}
    out["cost_usd"] = _cost(usage.get("cost_usd"))
    return out


@dataclass
class Totals:
    key: str
    label: str
    turns: int = 0
    reported_turns: int = 0
    unreported_turns: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cost_usd: float | None = None
    extra: dict = field(default_factory=dict)

    def add(self, numbers: dict) -> None:
        self.turns += 1
        if all(numbers[key] is None for key in TOKEN_KEYS) and numbers["cost_usd"] is None:
            self.unreported_turns += 1
            return
        self.reported_turns += 1
        for key in TOKEN_KEYS:
            setattr(self, key, getattr(self, key) + (numbers[key] or 0))
        if numbers["cost_usd"] is not None:
            self.cost_usd = (self.cost_usd or 0.0) + numbers["cost_usd"]

    def as_dict(self) -> dict:
        data = {k: v for k, v in vars(self).items() if k != "extra"}
        if self.cost_usd is not None:
            data["cost_usd"] = round(self.cost_usd, 6)
        return {**data, **self.extra}


def month_range(month: str | None, now: datetime | None = None) -> tuple[str, datetime, datetime]:
    now = now or datetime.now(UTC)
    if month:
        try:
            first = date.fromisoformat(f"{month}-01")
        except ValueError:
            raise ValueError("month must look like 2026-10") from None
    else:
        first = date(now.year, now.month, 1)
    start = datetime(first.year, first.month, 1, tzinfo=UTC)
    end = datetime(first.year + (first.month == 12), first.month % 12 + 1, 1, tzinfo=UTC)
    return f"{first.year:04d}-{first.month:02d}", start, end


async def _rows(db: AsyncSession, owner_id: str, start: datetime, end: datetime):
    query = (
        select(Turn, Thread)
        .join(Thread, Thread.id == Turn.thread_id)
        .where(
            Thread.owner_id == owner_id,
            Turn.status != "running",
            Turn.started_at >= start,
            Turn.started_at < end,
        )
        .order_by(Turn.started_at, Turn.id)
    )
    return (await db.execute(query)).all()


async def month_summary(db: AsyncSession, owner_id: str, month: str | None) -> dict:
    label, start, end = month_range(month)
    total = Totals("total", "Total")
    threads: dict[int, Totals] = {}
    engines: dict[str, Totals] = {}
    days: dict[str, Totals] = {}
    for turn, thread in await _rows(db, owner_id, start, end):
        numbers = reported(turn.usage)
        total.add(numbers)
        if thread.id not in threads:
            threads[thread.id] = Totals(
                f"thread:{thread.id}",
                thread.title or f"Conversation {thread.id}",
                extra={"thread_id": thread.id, "agent_id": thread.agent_id},
            )
        threads[thread.id].add(numbers)
        model = turn.model or thread.model or "default"
        key = f"{thread.provider}/{model}"
        engines.setdefault(key, Totals(key, key, extra={"provider": thread.provider, "model": model})).add(numbers)
        day = turn.started_at.astimezone(UTC).date().isoformat()
        days.setdefault(day, Totals(day, day)).add(numbers)

    def ordered(groups: dict) -> list[dict]:
        return [
            g.as_dict()
            for g in sorted(
                groups.values(),
                key=lambda g: (-(g.cost_usd or 0), -(g.input_tokens + g.output_tokens), g.label),
            )
        ]

    return {
        "month": label,
        "total": total.as_dict(),
        "by_thread": ordered(threads),
        "by_engine": ordered(engines),
        "by_day": [days[k].as_dict() for k in sorted(days)],
        "helper": helper_summary(start, end),
    }


def helper_summary(start: datetime, end: datetime) -> dict:
    """The calls the helper model made in the month (helper_usage.py): how many, for
    which jobs, on which engine and model, with the tokens the engine reported."""
    rows = helper_usage.rows(start, end)
    groups: dict[tuple, dict] = {}
    totals = {"calls": 0, "failed": 0, "input_tokens": 0, "output_tokens": 0, "reported_calls": 0}

    def add(target: dict, row: dict) -> None:
        target["calls"] += 1
        target["failed"] += 0 if row.get("ok") else 1
        if row.get("input_tokens") is not None or row.get("output_tokens") is not None:
            target["reported_calls"] += 1
            target["input_tokens"] += row.get("input_tokens") or 0
            target["output_tokens"] += row.get("output_tokens") or 0

    for row in rows:
        add(totals, row)
        key = (row.get("engine") or "", row.get("model") or "", row.get("job") or "", row.get("agent") or "")
        add(groups.setdefault(key, {
            "engine": key[0], "model": key[1], "job": key[2], "agent": key[3],
            "calls": 0, "failed": 0, "input_tokens": 0, "output_tokens": 0, "reported_calls": 0,
        }), row)
    return {**totals, "groups": sorted(groups.values(), key=lambda g: (-g["calls"], g["engine"], g["agent"]))}


def _cell(value) -> str:
    if value is None:
        return ""
    text = str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


async def month_csv(db: AsyncSession, owner_id: str, month: str | None) -> tuple[str, str]:
    label, start, end = month_range(month)
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(
        ["started_at", "thread_id", "conversation", "engine", "model", "status", *TOKEN_KEYS, "cost_usd"]
    )
    for turn, thread in await _rows(db, owner_id, start, end):
        numbers = reported(turn.usage)
        writer.writerow(
            [
                _cell(value)
                for value in (
                    turn.started_at.astimezone(UTC).isoformat(),
                    thread.id,
                    thread.title or "",
                    thread.provider,
                    turn.model or thread.model or "",
                    turn.status,
                    *(numbers[key] for key in TOKEN_KEYS),
                    numbers["cost_usd"],
                )
            ]
        )
    # The helper model's calls, one row each, marked by the status "helper" (no thread).
    for row in helper_usage.rows(start, end):
        job = helper_usage.JOBS.get(row.get("job"), row.get("job") or "")
        writer.writerow(
            [
                _cell(value)
                for value in (
                    datetime.fromtimestamp(float(row["at"]), UTC).isoformat(),
                    "",
                    f"Helper model: {job} for {row.get('agent') or 'an agent'}",
                    row.get("engine") or "",
                    row.get("model") or "",
                    "helper" if row.get("ok") else "helper_failed",
                    *(row.get(key) for key in TOKEN_KEYS),
                    None,
                )
            ]
        )
    return label, buffer.getvalue()


async def annual_summary(db: AsyncSession, owner_id: str, days_count: int = 365) -> dict:
    """The past year (default: 365 days) of usage and activity for the Profile tab,
    with a 365-day heatmap, streaks, peak day, model/provider shares,
    and agent teammate ranking."""
    now = datetime.now(UTC)
    start_date = (now - timedelta(days=days_count)).date()
    end_date = now.date()
    start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=UTC)

    query = (
        select(Turn, Thread)
        .join(Thread, Thread.id == Turn.thread_id)
        .where(
            Thread.owner_id == owner_id,
            Turn.status != "running",
            Turn.started_at >= start,
            Turn.started_at <= now,
        )
        .order_by(Turn.started_at, Turn.id)
    )
    rows = (await db.execute(query)).all()

    # Pre-populate all days in the range (date, weekday [0=Sun..6=Sat], tokens, messages)
    day_map: dict[str, dict] = {}
    current_d = start_date
    while current_d <= end_date:
        iso = current_d.isoformat()
        js_weekday = (current_d.weekday() + 1) % 7
        day_map[iso] = {
            "date": iso,
            "weekday": js_weekday,
            "tokens": 0,
            "messages": 0,
        }
        current_d += timedelta(days=1)

    total_tokens = 0
    total_messages = 0
    total_cost: float | None = None
    engines: dict[str, dict] = {}
    providers: dict[str, dict] = {}
    agent_tokens: dict[int, int] = {}

    for turn, thread in rows:
        nums = reported(turn.usage)
        turn_tokens = (
            (nums["input_tokens"] or 0)
            + (nums["output_tokens"] or 0)
            + (nums["cache_read_input_tokens"] or 0)
            + (nums["cache_creation_input_tokens"] or 0)
        )
        total_tokens += turn_tokens
        total_messages += 1

        if nums["cost_usd"] is not None:
            total_cost = (total_cost or 0.0) + nums["cost_usd"]

        day_iso = turn.started_at.astimezone(UTC).date().isoformat()
        if day_iso in day_map:
            day_map[day_iso]["tokens"] += turn_tokens
            day_map[day_iso]["messages"] += 1

        model = turn.model or thread.model or "default"
        provider = thread.provider or "unknown"
        engine_key = f"{provider}/{model}"

        if engine_key not in engines:
            engines[engine_key] = {"provider": provider, "model": model, "tokens": 0}
        engines[engine_key]["tokens"] += turn_tokens

        if provider not in providers:
            providers[provider] = {"provider": provider, "tokens": 0}
        providers[provider]["tokens"] += turn_tokens

        if thread.agent_id is not None:
            agent_tokens[thread.agent_id] = agent_tokens.get(thread.agent_id, 0) + turn_tokens

    days_list = [day_map[k] for k in sorted(day_map)]

    longest_streak = 0
    longest_streak_dates: dict[str, str] | None = None
    current_run = 0
    for idx, d in enumerate(days_list):
        if d["tokens"] > 0 or d["messages"] > 0:
            current_run += 1
            if current_run > longest_streak:
                longest_streak = current_run
                start_idx = idx - current_run + 1
                longest_streak_dates = {
                    "start": days_list[start_idx]["date"],
                    "end": d["date"],
                }
        else:
            current_run = 0

    active_days_count = sum(1 for d in days_list if d["tokens"] > 0 or d["messages"] > 0)
    today_active = (days_list[-1]["tokens"] > 0 or days_list[-1]["messages"] > 0) if days_list else False
    check_days = days_list if today_active else days_list[:-1]
    current_streak = 0
    for d in reversed(check_days):
        if d["tokens"] > 0 or d["messages"] > 0:
            current_streak += 1
        else:
            break

    current_streak_start = None
    if current_streak > 0 and len(check_days) >= current_streak:
        current_streak_start = check_days[-current_streak]["date"]

    peak = None
    for d in days_list:
        if d["tokens"] > 0:
            if peak is None or d["tokens"] > peak["tokens"]:
                peak = {"date": d["date"], "tokens": d["tokens"], "messages": d["messages"]}

    weekday_tokens = [0] * 7
    for d in days_list:
        weekday_tokens[d["weekday"]] += d["tokens"]
    max_wd = max(weekday_tokens)
    busiest_weekday = weekday_tokens.index(max_wd) if max_wd > 0 else None

    models_out = []
    for eng in sorted(engines.values(), key=lambda e: -e["tokens"]):
        share = (eng["tokens"] / total_tokens) if total_tokens > 0 else 0.0
        models_out.append({
            "provider": eng["provider"],
            "model": eng["model"],
            "tokens": eng["tokens"],
            "share": round(share, 4),
        })

    providers_out = []
    for prv in sorted(providers.values(), key=lambda p: -p["tokens"]):
        share = (prv["tokens"] / total_tokens) if total_tokens > 0 else 0.0
        providers_out.append({
            "provider": prv["provider"],
            "tokens": prv["tokens"],
            "share": round(share, 4),
        })

    teammates_out = []
    if agent_tokens:
        int_agent_ids = [aid for aid in agent_tokens.keys() if isinstance(aid, int)]
        agent_names: dict[int, str] = {}
        if int_agent_ids:
            agent_rows = (await db.execute(select(Agent).where(Agent.id.in_(int_agent_ids)))).scalars().all()
            for a in agent_rows:
                agent_names[a.id] = a.name
        for aid, tokens in sorted(agent_tokens.items(), key=lambda item: -item[1]):
            teammates_out.append({
                "agent": {
                    "id": str(aid),
                    "name": agent_names.get(aid, f"Agent {aid}"),
                },
                "tokens": tokens,
            })

    return {
        "days": days_list,
        "tokens": total_tokens,
        "messages": total_messages,
        "cost": round(total_cost, 4) if total_cost is not None else None,
        "activeDays": active_days_count,
        "peak": peak,
        "currentStreak": current_streak,
        "currentStreakStart": current_streak_start,
        "longestStreak": longest_streak,
        "longestStreakDates": longest_streak_dates,
        "busiestWeekday": busiest_weekday,
        "providers": providers_out,
        "models": models_out,
        "teammates": teammates_out,
    }
