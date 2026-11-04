from sqlalchemy import delete, select
import pytest

from app.db.models import Routine, RoutineRun
from app.services import routine_service as service, thread_store
from tests.computers.test_computer_turns import (  # noqa: F401
    rt, cli, docker, rows_cleanup, cleanup, owner, sessions, agent_with_computer, tool_step,
    finished, pending_approval, wait_until, events_of,
)
from tests.services.test_routine_service import Clock, T0


@pytest.fixture(autouse=True)
async def routines_cleanup(sessions, owner):
    yield
    async with sessions() as db:
        ids = select(Routine.id).where(Routine.owner_id == owner)
        await db.execute(delete(RoutineRun).where(RoutineRun.routine_id.in_(ids)))
        await db.execute(delete(Routine).where(Routine.owner_id == owner))
        await db.commit()


async def test_two_scheduled_runs_use_saved_access_without_widening_person_chats(rt, sessions, owner, cli, docker, monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    agent, computer, _, workspace = await agent_with_computer(rt, sessions, docker)
    clock = Clock(T0)
    scheduler = service.RoutineScheduler(runtime=rt, clock=clock)
    async with sessions() as db:
        routine = await service.create_routine(db, owner, {"agent_id": agent.id, "name": "Daily research", "prompt": "Work",
            "schedule_kind": "interval", "schedule_spec": {"every_minutes": 5}}, now=clock())
        routine.uninterrupted_access = True
        await db.commit()

    for index in (1, 2):
        cli.script(tool_step("exec", {"command": f"printf {index} > report.txt"}))
        clock.advance(minutes=5)
        await scheduler.tick()
        async def dispatched():
            async with sessions() as db:
                rows = (await db.scalars(select(RoutineRun).where(RoutineRun.routine_id == routine.id).order_by(RoutineRun.id))).all()
                return rows[-1] if len(rows) == index and rows[-1].thread_id else None
        occurrence = await wait_until(dispatched)
        await finished(sessions, occurrence.thread_id)
        await scheduler.tick()
        async with sessions() as db:
            recorded = await db.get(RoutineRun, occurrence.id)
            approvals = await thread_store.list_approvals(db, occurrence.thread_id)
        assert recorded.state == "completed"
        assert recorded.uninterrupted_access is True
        assert recorded.capability_snapshot["computer_id"] == computer.id
        assert [(a.tool, a.status) for a in approvals] == [("mcp__computer__exec", "allowed")]
        assert (workspace / "report.txt").read_text() == str(index)
        resolved = [e.data for e in await events_of(sessions, occurrence.thread_id) if e.type == "approval.resolved"]
        assert resolved[0]["by"] == "routine_uninterrupted_grant"

    cli.script(tool_step("exec", {"command": "touch person.txt"}))
    person_thread = await rt.create_thread(agent_id=agent.id)
    await rt.send_turn(person_thread.id, "Ordinary chat")
    approval = await pending_approval(sessions, person_thread.id)
    assert not (workspace / "person.txt").exists()
    assert await rt.answer_approval(approval.id, "deny")
    await finished(sessions, person_thread.id)


async def test_an_unconfigured_host_action_is_denied_without_an_approval_wait(rt, sessions, owner, cli, monkeypatch):
    from app.core.config import settings
    from app.services import agent_store
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    monkeypatch.setattr(settings, "LOCAL_TOOLS_ENABLED", True)
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=owner, name="No computer")
        routine = await service.create_routine(db, owner, {"agent_id": agent.id, "name": "R", "prompt": "Work"})
        routine.uninterrupted_access = True
        await db.commit()
        occurrence = await service.run_now(db, owner, routine.id)
    cli.script({"type": "tool", "tool_name": "Bash", "tool_input": {"command": "ls"}})
    scheduler = service.RoutineScheduler(runtime=rt)
    await scheduler.tick()
    async def dispatched():
        async with sessions() as db:
            row = await db.get(RoutineRun, occurrence.id)
            return row if row.thread_id else None
    occurrence = await wait_until(dispatched)
    await finished(sessions, occurrence.thread_id)
    async with sessions() as db:
        [approval] = await thread_store.list_approvals(db, occurrence.thread_id)
    assert approval.status == "denied"
    resolved = [e.data for e in await events_of(sessions, occurrence.thread_id) if e.type == "approval.resolved"]
    assert resolved[0]["by"] == "routine_tool_not_granted"


async def test_switching_a_confined_draft_routine_to_full_mode_attaches_its_computer(rt, sessions, owner, cli, docker, monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    agent, computer, _, workspace = await agent_with_computer(rt, sessions, docker)
    legacy_grants = [{"tool": tool, "account_id": "mail_1"} for tool in
                     ("gmail_prepare_checked_reply", "gmail_fetch_message", "gmail_get_profile")]
    async with sessions() as db:
        routine = await service.create_routine(db, owner, {"agent_id": agent.id, "name": "Former draft", "prompt": "Use computer"})
        routine.connected_app_grants = legacy_grants
        routine.uninterrupted_access = True
        await db.commit()
        occurrence = await service.run_now(db, owner, routine.id)
    cli.script(tool_step("exec", {"command": "printf ready > full-computer.txt"}))
    scheduler = service.RoutineScheduler(runtime=rt)
    await scheduler.tick()
    async def dispatched():
        async with sessions() as db:
            row = await db.get(RoutineRun, occurrence.id)
            return row if row.thread_id else None
    occurrence = await wait_until(dispatched)
    await finished(sessions, occurrence.thread_id)
    assert (workspace / "full-computer.txt").read_text() == "ready"
    async with sessions() as db:
        recorded = await db.get(RoutineRun, occurrence.id)
        assert recorded.uninterrupted_access is True
        assert recorded.capability_snapshot["computer_id"] == computer.id
        assert recorded.connected_app_grants == []
        assert (await db.get(Routine, routine.id)).connected_app_grants == legacy_grants


async def test_a_legacy_full_run_with_stale_draft_grants_keeps_full_computer_context(rt, sessions, owner, cli, docker):
    from app.services import routine_uninterrupted
    agent, computer, thread, workspace = await agent_with_computer(rt, sessions, docker)
    async with sessions() as db:
        routine = await service.create_routine(db, owner, {"agent_id": agent.id, "name": "R", "prompt": "Computer"})
        routine.uninterrupted_access = True
        legacy_grants = [{"tool": tool, "account_id": "mail_1"} for tool in
                         ("gmail_prepare_checked_reply", "gmail_fetch_message", "gmail_get_profile")]
        occurrence = RoutineRun(routine_id=routine.id, trigger="manual", state="running", thread_id=thread.id,
            uninterrupted_access=True, connected_app_grants=legacy_grants,
            capability_snapshot=await routine_uninterrupted.snapshot(db, owner, agent.id))
        db.add(occurrence)
        await db.commit()
    cli.script(tool_step("exec", {"command": "printf full > legacy-full.txt"}))
    await rt.send_turn(thread.id, "Use computer", team_origin="routine", routine_run_id=occurrence.id)
    await finished(sessions, thread.id)
    assert (workspace / "legacy-full.txt").read_text() == "full"


async def test_revoking_access_after_auto_decision_but_before_allow_delivery_blocks_the_computer(rt, sessions, owner, cli, docker, monkeypatch):
    from app.core.config import settings
    from app.services import routine_uninterrupted
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    agent, _, _, workspace = await agent_with_computer(rt, sessions, docker)
    async with sessions() as db:
        routine = await service.create_routine(db, owner, {"agent_id": agent.id, "name": "R", "prompt": "Computer"})
        routine.uninterrupted_access = True
        await db.commit()
        occurrence = await service.run_now(db, owner, routine.id)
    original = routine_uninterrupted.automatic
    revoked = False
    async def revoke_after_decision(runtime, run, tool, args):
        nonlocal revoked
        decision = await original(runtime, run, tool, args)
        if tool == "mcp__computer__exec" and not revoked and decision == ("allowed", "routine_uninterrupted_grant"):
            revoked = True
            async with sessions() as db:
                (await db.get(Routine, routine.id)).uninterrupted_access = False
                await db.commit()
        return decision
    monkeypatch.setattr(routine_uninterrupted, "automatic", revoke_after_decision)
    cli.script(tool_step("exec", {"command": "touch never-dispatched.txt"}))
    scheduler = service.RoutineScheduler(runtime=rt)
    await scheduler.tick()
    async def dispatched():
        async with sessions() as db:
            row = await db.get(RoutineRun, occurrence.id)
            return row if row.thread_id else None
    occurrence = await wait_until(dispatched)
    await finished(sessions, occurrence.thread_id)
    assert not (workspace / "never-dispatched.txt").exists()
    async with sessions() as db:
        [approval] = await thread_store.list_approvals(db, occurrence.thread_id)
    assert approval.status == "denied" and approval.delivered_at is None
    resolved = [e.data for e in await events_of(sessions, occurrence.thread_id) if e.type == "approval.resolved"]
    assert [entry["status"] for entry in resolved] == ["allowed", "denied"]
    assert resolved[-1]["by"] == "routine_uninterrupted_revoked"


@pytest.mark.parametrize("trigger", ["webhook", "retry"])
async def test_external_and_retry_runs_do_not_inherit_uninterrupted_access(rt, sessions, owner, cli, trigger, monkeypatch):
    from app.core.config import settings
    from app.services import agent_store
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=owner, name="No computer")
        routine = await service.create_routine(db, owner, {"agent_id": agent.id, "name": "R", "prompt": "Work"})
        routine.uninterrupted_access = True
        occurrence = RoutineRun(routine_id=routine.id, trigger=trigger, state="queued", scheduled_for=service.utcnow())
        db.add(occurrence)
        await db.commit()
    cli.script({"type": "chat"})
    scheduler = service.RoutineScheduler(runtime=rt)
    await scheduler.tick()
    async def dispatched():
        async with sessions() as db:
            row = await db.get(RoutineRun, occurrence.id)
            return row if row.thread_id else None
    occurrence = await wait_until(dispatched)
    await finished(sessions, occurrence.thread_id)
    async with sessions() as db:
        row = await db.get(RoutineRun, occurrence.id)
        assert row.uninterrupted_access is False
        assert row.capability_snapshot == {}
