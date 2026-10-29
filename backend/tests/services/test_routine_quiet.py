"""Explicit routine outcomes are requests, verified against durable receipts."""
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from app.db.models import Approval, Event, Notification, Routine, RoutineRun, Thread, Turn
from app.db.models.routine import RoutineAppAction
from app.services import routine_service as service

NOW = datetime(2026, 10, 29, 10, tzinfo=UTC)
READ = {"tool": "gmail_fetch_message", "account_id": "ca_mail"}


@pytest.fixture
async def world(db_session):
    db = db_session
    routine = Routine(owner_id="quiet-owner", agent_id=1, name="Mail check", prompt="Check mail", schedule_kind="manual", schedule_spec={}, quiet_reporting=True)
    thread = Thread(owner_id="quiet-owner", provider="fake", agent_id=1)
    db.add_all([routine, thread])
    await db.flush()
    turn = Turn(thread_id=thread.id, seq=1, prompt_text="Check", status="succeeded", result="", owner_token="owned")
    db.add(turn)
    await db.flush()
    run = RoutineRun(routine_id=routine.id, trigger="schedule", state="running", thread_id=thread.id, turn_id=turn.id,
                     connected_app_grants=[READ], outcome_details={"requested": "no_change"})
    db.add(run)
    await db.flush()
    receipt = RoutineAppAction(run_id=run.id, tool=READ["tool"], account_id=READ["account_id"], status="completed", result={"coverage_complete": True})
    db.add(receipt)
    await db.flush()
    return db, routine, run, turn, receipt


async def settle(world):
    db, routine, run, turn, _ = world
    staged = await service.RoutineScheduler()._settle(db, routine, run, turn, NOW)
    await db.flush()
    notifications = list((await db.scalars(select(Notification).where(Notification.run_id == run.id))).all())
    return staged, notifications


@pytest.mark.parametrize("trigger,enabled,expected", [("schedule", True, 0), ("manual", True, 1), ("schedule", False, 1), ("webhook", True, 1)])
async def test_only_opted_in_scheduled_verified_result_is_quiet(world, trigger, enabled, expected):
    db, routine, run, turn, receipt = world
    run.trigger, routine.quiet_reporting = trigger, enabled
    staged, notes = await settle(world)
    assert len(staged) == len(notes) == expected
    assert run.state == "completed" and run.outcome == "no_change"
    await db.refresh(run)
    assert run.finished_at == NOW
    assert run.outcome_details["checked_sources"][0]["action_id"] == receipt.id
    assert run.outcome_details["checked_at"] == NOW.isoformat()


@pytest.mark.parametrize("text,requested,outcome", [("New issue requires action", "no_change", "report"), ("[[no-update]]", None, "report"), ("", None, "unknown")])
async def test_meaningful_text_markers_and_empty_success_stay_visible(world, text, requested, outcome):
    _, _, run, turn, _ = world
    turn.result = text
    run.outcome_details = {"requested": requested}
    staged, notes = await settle(world)
    assert len(staged) == len(notes) == 1
    assert run.outcome == outcome
    assert (text in run.result) if text else "No verified outcome" in run.result


@pytest.mark.parametrize("failure", ["failed", "reserved", "outcome_unknown", "refused"])
async def test_incomplete_check_overrides_no_change_and_preserves_partial_report(world, failure):
    _, _, run, turn, receipt = world
    receipt.status = failure
    turn.result = "One source had a useful update; another could not be checked."
    staged, notes = await settle(world)
    assert staged and notes[0].kind == "routine_failed"
    assert run.state == "failed" and run.outcome == "source_failed"
    assert "useful update" in run.result


@pytest.mark.parametrize("variant", ["missing", "none", "write", "artifact", "question", "pending"])
async def test_unverified_sources_receipts_and_questions_cannot_be_silenced(world, variant):
    db, _, run, turn, receipt = world
    if variant == "missing":
        run.connected_app_grants = [READ, {"tool": "gmail_get_profile", "account_id": "ca_mail"}]
    elif variant == "none":
        run.connected_app_grants = []
    elif variant == "write":
        receipt.tool = "gmail_send_email"
    elif variant in ("artifact", "question"):
        db.add(Event(thread_id=run.thread_id, turn_id=turn.id, seq=1,
                     type="assistant.message" if variant == "artifact" else "question.prompt",
                     data={"attachments": [{"id": "file"}]}))
    else:
        db.add(Approval(id="pending-quiet", thread_id=run.thread_id, turn_id=turn.id, request_id="ask", tool="Write", status="pending"))
    await db.flush()
    staged, notes = await settle(world)
    assert staged and notes
    assert run.outcome == "unknown"


async def test_provider_failure_cannot_be_overridden_by_outcome_request(world):
    _, _, run, turn, _ = world
    turn.status, turn.error = "failed", "Provider unavailable"
    staged, notes = await settle(world)
    assert run.state == "failed" and run.error == "Provider unavailable"
    assert staged and notes[0].kind == "routine_failed"


async def test_explicit_failure_request_is_sticky_and_bound_to_active_turn(world):
    db, routine, run, turn, _ = world
    turn.status = "running"
    caller = SimpleNamespace(routine_run_id=run.id, turn_id=turn.id, agent_id=1, thread_id=run.thread_id, owner_token="owned")
    await service.report_outcome(db, routine.owner_id, caller, "source_failed", "Mailbox could not be checked")
    await service.report_outcome(db, routine.owner_id, caller, "no_change")
    assert run.outcome_details["requested"] == "source_failed"
    caller.owner_token = "stale"
    with pytest.raises(service.InvalidRoutine):
        await service.report_outcome(db, routine.owner_id, caller, "no_change")
    turn.status = "succeeded"
    staged, notes = await settle(world)
    assert staged and notes and run.outcome == "source_failed"


async def test_mixed_sources_retain_successful_and_failed_coverage(world):
    db, _, run, turn, _ = world
    run.connected_app_grants = [READ, {"tool": "gmail_get_profile", "account_id": "ca_mail"}]
    db.add(RoutineAppAction(run_id=run.id, tool="gmail_get_profile", account_id="ca_mail", status="failed"))
    await db.flush()
    staged, notes = await settle(world)
    assert staged and notes and run.outcome == "source_failed"
    assert {s["status"] for s in run.outcome_details["checked_sources"]} == {"completed", "failed"}


@pytest.mark.parametrize("quiet,expected", [(False, 1), (True, 0)])
async def test_duplicate_follow_after_reload_does_not_notify_again(world, quiet, expected):
    db, routine, run, _, _ = world
    routine.quiet_reporting = quiet
    await settle(world)
    await db.commit()
    from contextlib import asynccontextmanager
    @asynccontextmanager
    async def session():
        yield db
    scheduler = service.RoutineScheduler()
    scheduler.session = session
    run_id = run.id
    db.expunge_all()
    await scheduler._follow(run_id)
    assert len(list((await db.scalars(select(Notification).where(Notification.run_id == run_id))).all())) == expected
    restored = await db.get(RoutineRun, run_id)
    assert restored.outcome == "no_change" and restored.outcome_details["checked_sources"]


def test_checked_reply_grant_contract_is_single_account_and_read_only_elsewhere():
    from app.schemas.routine import ConnectedAppGrant, validate_draft_grants
    def grants(names):
        return [ConnectedAppGrant.model_construct(tool=name, account_id=account) for name, account in names]
    good = [("gmail_prepare_checked_reply", "ca_mail"), ("gmail_fetch_message", "ca_mail"), ("gmail_get_profile", "ca_mail")]
    validate_draft_grants(grants(good))
    for bad in (good[:-1], good + [("gmail_send_email", "ca_mail")], good + [("github_list_issues", "ca_gh")], good[:-1] + [("gmail_get_profile", "ca_other")]):
        with pytest.raises(ValueError):
            validate_draft_grants(grants(bad))


@pytest.mark.parametrize("metadata", [None, {}, {"coverage_complete": False}, {"coverage_complete": "true"}])
async def test_unknown_truncated_or_paginated_source_coverage_stays_visible(world, metadata):
    _, _, run, _, receipt = world
    receipt.result = metadata
    staged, notes = await settle(world)
    assert staged and notes and run.outcome == ("source_failed" if metadata == {"coverage_complete": False} else "unknown")
