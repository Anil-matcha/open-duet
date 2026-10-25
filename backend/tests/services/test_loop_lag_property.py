"""R1 — the event loop never lags more than the budget across a full turn.

A full turn (start -> engine events -> approval -> completion) runs against the
fake Claude CLI while a monitor measures how late the loop wakes a periodic
probe. Drift beyond a small budget means a blocking call sits on the loop
(issue: the ``release_turn`` flock, ``time.sleep`` in a callback). The budget is
one constant, named once, with deliberate headroom over CI jitter.

This is a property test in the R1 sense: it drives the real turn path and
asserts an invariant over the whole lifecycle, not one code path.
"""

import asyncio

import pytest

from tests.services.thread_harness import *  # noqa: F401,F403
from tests.services.thread_harness import (
    finished,
    new_thread,
    pending_approval,
    types_of,
)

# The lag budget for a turn lifecycle. docs/RELIABILITY.md names ~50 ms; the
# monitor samples every SAMPLE_SECONDS and reports the worst overshoot. CI adds
# jitter, so the budget keeps headroom above it while still catching a real
# blocking call (which stalls for far longer).
LAG_BUDGET_SECONDS = 0.05
SAMPLE_SECONDS = 0.005


class LoopLagMonitor:
    """Measures how late the event loop runs a periodic probe.

    A ``call_later`` chain re-arms every ``SAMPLE_SECONDS``; the gap between
    when the callback should have run and when it did is the loop's lag. The
    worst sample over the window is what a blocking call inflates.
    """

    def __init__(self, interval: float = SAMPLE_SECONDS) -> None:
        self.interval = interval
        self.max_lag = 0.0
        self.samples = 0
        self._handle: asyncio.TimerHandle | None = None
        self._expected = 0.0
        self._running = False

    def _tick(self) -> None:
        loop = asyncio.get_running_loop()
        now = loop.time()
        if self._expected:
            self.max_lag = max(self.max_lag, max(0.0, now - self._expected))
        self.samples += 1
        if self._running:
            self._expected = now + self.interval
            self._handle = loop.call_later(self.interval, self._tick)

    def start(self) -> None:
        self._running = True
        self._expected = asyncio.get_running_loop().time() + self.interval
        self._handle = asyncio.get_running_loop().call_later(self.interval, self._tick)

    def stop(self) -> None:
        self._running = False
        if self._handle is not None:
            self._handle.cancel()


@pytest.fixture
def lag_monitor():
    return LoopLagMonitor()


async def test_a_full_turn_keeps_the_loop_under_budget(rt, sessions, cli, lag_monitor, owner):
    """start -> streamed events -> a tool approval -> completion, all while the
    monitor watches. The turn must keep max lag under the budget."""
    thread = await new_thread(sessions, owner)
    cli.script(
        {"type": "chat", "text": "one two three four five six seven eight nine ten"},
        {"type": "tool"},
    )

    lag_monitor.start()
    turn = await rt.send_turn(thread.id, "hello")
    await finished(sessions, thread.id, 1)
    lag_monitor.stop()

    assert lag_monitor.samples > 0, "the monitor never sampled the loop"
    assert lag_monitor.max_lag < LAG_BUDGET_SECONDS, (
        f"loop lag {lag_monitor.max_lag * 1000:.1f} ms exceeded the "
        f"{LAG_BUDGET_SECONDS * 1000:.0f} ms budget over {lag_monitor.samples} samples"
    )


async def test_an_approval_wait_keeps_the_loop_under_budget(rt, sessions, cli, lag_monitor, tools_on, owner):
    """The approval wait is a second lifecycle segment (start -> events ->
    approval -> answer -> completion); the loop must stay responsive across it
    too — a poll that blocks the loop would show here."""
    thread = await new_thread(sessions, owner)
    cli.script({"type": "tool"})

    lag_monitor.start()
    await rt.send_turn(thread.id, "write a note")
    approval = await pending_approval(sessions, thread.id)
    assert await rt.answer_approval(approval.id, "allow")
    await finished(sessions, thread.id)
    lag_monitor.stop()

    assert "turn.completed" in await types_of(sessions, thread.id)
    assert lag_monitor.samples > 0
    assert lag_monitor.max_lag < LAG_BUDGET_SECONDS, (
        f"loop lag {lag_monitor.max_lag * 1000:.1f} ms exceeded the "
        f"{LAG_BUDGET_SECONDS * 1000:.0f} ms budget over {lag_monitor.samples} samples"
    )


def test_the_budget_constant_matches_the_documented_ceiling():
    """The threshold is named once and stays at or below the doc's ~50 ms
    ceiling, so a change is one reviewable line."""
    assert LAG_BUDGET_SECONDS <= 0.05
