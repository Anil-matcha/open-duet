"""Guided resume — the sweep reconciliation contract (ISSUE-20 residuals).

When `ThreadRuntime.sweep_stale` declares a turn dead, the run alive in this
process must be stopped and its computer lease released, not left holding either
until a later emit fails or a stall watchdog fires.

Two tests:
- `..._reconciles_fabricated_run`: isolates the sweep's reconcile loop with a
  fabricated live run, so the abort/cancel/lease-release calls are the sweep's own
  (a real hang run self-reconciles on ownership loss, which would mask the sweep).
  This is the criterion-6 mutation control's target.
- `..._end_to_end`: the real-path regression net, mirroring the runtime suite's
  in-process sweep coverage.
"""

from datetime import timedelta
from types import SimpleNamespace

from sqlalchemy import update

from app.core.config import settings
from app.db.models import Turn
from app.services import thread_store as store
from app.services import thread_runtime as thread_runtime_module
from tests.services.thread_harness import *  # noqa: F401,F403
from tests.services.thread_harness import (  # noqa: F401
    cleanup,
    cli,
    new_thread,
    owner,
    rt,
    sessions,
    wait_until,
)


class _FakeRun:
    """A live run shaped like the parts `sweep_stale` reconciles."""

    def __init__(self) -> None:
        self.aborted = False
        self.recorder = SimpleNamespace(lost=False, lose=lambda: setattr(self.recorder, "lost", True))
        self.task = SimpleNamespace(cancelled=False, cancel=lambda: setattr(self.task, "cancelled", True))

        outer = self

        class _Ctx:
            aborted = False

            def abort(self) -> None:
                outer.aborted = True
                outer.ctx.aborted = True

        self.ctx = _Ctx()


async def test_sweep_reconcile_reconciles_a_fabricated_run(rt, monkeypatch):
    """The sweep's own reconcile loop must abort the run, lose the recorder and
    cancel the task — named effects, isolated from any self-unwind."""
    fake = _FakeRun()
    rt._runs[4242] = fake  # type: ignore[index]

    async def fake_interrupt(_db, *, stale_after):
        return [4242]

    async def fake_get_turn(_db, turn_id):
        return SimpleNamespace(thread_id=7) if turn_id == 4242 else None

    monkeypatch.setattr(store, "interrupt_stale_turns", fake_interrupt)
    monkeypatch.setattr(store, "get_turn", fake_get_turn)
    monkeypatch.setattr(rt.hub, "notify", lambda *_a, **_k: None)
    monkeypatch.setattr(rt.team_jobs, "recover", lambda: _noop())
    monkeypatch.setattr(rt.rooms, "recover", lambda: _noop())
    monkeypatch.setattr(rt.notices, "after_interrupt", lambda *_a, **_k: _noop())
    monkeypatch.setattr(rt.capture, "restore", lambda: _noop())

    try:
        interrupted = await rt.sweep_stale()
        assert interrupted == [4242]
        assert fake.aborted, "sweep_stale must abort the engine run it declared dead"
        assert fake.ctx.aborted
        assert fake.recorder.lost, "sweep_stale must make the recorder lose the turn"
        assert fake.task.cancelled, "sweep_stale must cancel the run's task"
    finally:
        rt._runs.pop(4242, None)


async def _noop():
    return None


async def test_sweep_reconcile_releases_the_lease_end_to_end(rt, sessions, cli, monkeypatch, owner):
    """The real path: a stale in-process run is interrupted and its computer
    lease released (the release runs from the run's own teardown)."""
    thread = await new_thread(sessions, owner)
    cli.script({"type": "silent"})
    monkeypatch.setattr(settings, "THREAD_HEARTBEAT_SECONDS", 3600)
    turn = await rt.send_turn(thread.id, "work")
    await wait_until(lambda: cli.log("hanging"))
    assert turn.id in rt._runs

    releases: list[int] = []
    original_release = rt.computers.release_turn

    async def spy_release(binding, turn_id):
        releases.append(turn_id)
        return await original_release(binding, turn_id)

    monkeypatch.setattr(rt.computers, "release_turn", spy_release)

    async with sessions() as db:
        await db.execute(
            update(Turn)
            .where(Turn.id == turn.id)
            .values(heartbeat_at=store.utcnow() - timedelta(seconds=settings.THREAD_LEASE_SECONDS + 30))
        )
        await db.commit()

    assert turn.id in await rt.sweep_stale()
    await wait_until(lambda: turn.id in releases, timeout=10.0)
    assert turn.id in releases, "an interrupted turn must release its computer lease"
    async with sessions() as db:
        assert (await store.get_turn(db, turn.id)).status == "interrupted"
