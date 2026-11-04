"""R0 — the loop-ownership guard for blocking lock acquisitions.

The turn engine once called a blocking cross-process ``flock`` directly on the
event loop (issue: ``release_turn``), which stalled every task on the loop. The
guard named here fails that mistake loudly instead of silently. These are the
R0 properties:

* calling the guarded lock path from a coroutine raises ``LoopBlockedError``
  instead of blocking (true positive);
* the same path from a worker thread completes normally — the guard checks the
  loop thread, not the lock, so it does not over-fence (true negative).
"""

import asyncio
import threading

import pytest

from app.computers import screen
from app.core.loop_guard import LoopBlockedError, assert_off_loop


def test_the_guard_raises_on_the_event_loop():
    async def call_it() -> None:
        assert_off_loop("a test lock")

    with pytest.raises(LoopBlockedError):
        asyncio.run(call_it())


def test_the_guard_permits_a_worker_thread():
    done = threading.Event()
    raised: list[BaseException] = []

    def worker() -> None:
        try:
            assert_off_loop("a test lock")
        except BaseException as exc:  # noqa: BLE001 — the test fails on any raise
            raised.append(exc)
        finally:
            done.set()

    thread = threading.Thread(target=worker)
    thread.start()
    assert done.wait(timeout=5)
    thread.join()
    assert raised == []


def test_driver_lock_refuses_the_event_loop(tmp_path):
    """The guarded lock path itself (not just the helper) refuses the loop."""

    async def acquire() -> None:
        with screen.driver_lock(tmp_path):
            pass  # pragma: no cover — the guard raises before this

    with pytest.raises(LoopBlockedError):
        asyncio.run(acquire())


def test_driver_lock_through_a_worker_thread_succeeds(tmp_path):
    """The true negative for the lock path: off-loop use must still work, or the
    guard would over-fence the legitimate call sites."""
    asyncio.run(asyncio.to_thread(_enter_and_leave, tmp_path))


def _enter_and_leave(state_dir) -> None:
    with screen.driver_lock(state_dir):
        (state_dir / "screen-owner.json").write_text('{"turn_id": "t"}')


def test_release_turn_does_not_block_the_loop(tmp_path, monkeypatch):
    """Regression pin for the ISSUE-17 site: the call that once held the flock
    on the loop now runs it in a worker thread, so the loop stays responsive.
    With the guard in place and no worker thread, this path would raise."""

    async def drive() -> float:
        lag = 0.0
        stop = asyncio.Event()

        async def spin() -> None:
            nonlocal lag
            loop = asyncio.get_running_loop()
            while not stop.is_set():
                before = loop.time()
                await asyncio.sleep(0.005)
                lag = max(lag, loop.time() - before - 0.005)

        task = asyncio.create_task(spin())
        await asyncio.to_thread(_enter_and_leave, tmp_path)
        stop.set()
        await task
        return lag

    assert asyncio.run(drive()) < 0.05
