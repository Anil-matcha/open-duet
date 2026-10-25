"""R2 — concurrent turns do not starve background jobs.

Each running turn holds one worker thread for its whole life (the runner waits
on the engine process), and the same thread pool carries the background
recovery jobs (routine scheduling, task sync, computer upkeep). The admission
cap (``TURN_MAX_CONCURRENT``) exists so that turns past it wait their turn
instead of exhausting the pool and starving those jobs (issue: the 40-thread
pool starvation, ISSUE-18).

The property: with more concurrent turns in flight than the cap allows, a
background job that needs a worker thread still runs and completes within a
stated bound — and the number of turns actually running at once never exceeds
the cap.
"""

import asyncio
import time

from fastapi.concurrency import run_in_threadpool

from app.core.config import settings
from tests.services.thread_harness import *  # noqa: F401,F403
from tests.services.thread_harness import finished, new_thread

# How long a background job may take to complete while the cap's worth of turns
# is in flight. The job itself is trivial (so the bound is about the pool, not
# the job); turns hold a worker thread each for their whole life. A generous
# bound stays deterministic on CI while still failing if a turn held every
# thread. Justified against the cap, not measured latency: the pool (AnyIO's 40)
# is far larger than the cap (16), so a correctly capped pool always has a free
# thread within this bound.
BACKGROUND_JOB_BOUND_SECONDS = 10.0


def _background_job() -> str:
    """A trivial unit of work that must hold a worker thread, standing in for
    the recovery/sweep family."""
    return "recovered"


async def test_turns_do_not_starve_a_background_thread_job(rt, sessions, cli, owner):
    """Launch two caps' worth of turns; a background thread job still completes
    within the bound, and no more than the cap runs at once."""
    cap = settings.TURN_MAX_CONCURRENT
    assert cap > 0, "this property assumes a positive admission cap"

    seen = 0
    high_water = 0

    original_run = rt._run_adapter

    async def counting_run_adapter(run, adapter):
        nonlocal seen, high_water
        seen += 1
        high_water = max(high_water, seen)
        try:
            return await original_run(run, adapter)
        finally:
            seen -= 1

    rt._run_adapter = counting_run_adapter
    try:
        threads = [await new_thread(sessions, owner) for _ in range(cap * 2)]
        # Every turn streams a few events and then finishes.
        cli.script({"type": "chat", "text": "a b c d e f g h i j"})

        turns = [await rt.send_turn(thread.id, "go") for thread in threads]

        # While the turns are in flight, run a background thread job and time it.
        started = time.monotonic()
        result = await asyncio.wait_for(run_in_threadpool(_background_job), timeout=BACKGROUND_JOB_BOUND_SECONDS)
        elapsed = time.monotonic() - started

        assert result == "recovered"
        assert elapsed < BACKGROUND_JOB_BOUND_SECONDS, (
            f"background job took {elapsed:.2f}s while {cap} turns ran — a turn is "
            f"starving the pool"
        )

        for thread in threads:
            await finished(sessions, thread.id, 1)
    finally:
        rt._run_adapter = original_run

    assert high_water <= cap, (
        f"as many as {high_water} turns ran at once, above the cap of {cap}"
    )
    assert len(turns) == cap * 2


async def test_the_admission_cap_is_configured_below_the_thread_pool(rt):
    """The guard's whole point: the cap stays under the pool size so turns
    cannot occupy every worker thread. Pinned so a config change that lets
    turns exhaust the pool fails here (the cap is one reviewable line)."""
    # AnyIO's default thread pool, which carries both turns and background jobs.
    ANYIO_DEFAULT_POOL = 40
    assert 0 < settings.TURN_MAX_CONCURRENT < ANYIO_DEFAULT_POOL
