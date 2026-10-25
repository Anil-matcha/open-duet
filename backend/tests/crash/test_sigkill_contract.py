"""SIGKILL crash fault injection — parametrised over the turn's phase.

See `tests/crash/harness.py` for the barrier design. Each case: start the real
backend -> drive a turn to the phase with the fake engine -> SIGKILL ->
restart -> assert exactly-one interrupted, zero auto-replay, lease reclaimed.
"""

import signal
import sys

import pytest

from tests.crash.harness import (
    PHASES,
    Crash,
    all_turn_ids,
    interrupted_rows,
    kill,
    replay_of,
)
from tests.e2e.backend import wait_for

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals and process groups")

# `after_accept` and `unknown` are deterministic (the fake engine's step makes
# the phase observable, and the backend sets engine_phase=sent before it spawns
# the engine). `before_accept` is the phase docs/RELIABILITY.md calls
# unobservable: there is no external signal for "not yet sent", so the kill may
# land in `preparing` (before_accept) or already `sent` (unknown). Its case
# asserts the contract that holds either way and records the demotion.
DETERMINISTIC = ["after_accept", "unknown"]
UNOBSERVABLE = ["before_accept"]


@pytest.fixture
def crash(tmp_path):
    items: list[Crash] = []

    def make(name: str) -> Crash:
        c = Crash(tmp_path / name)
        items.append(c)
        return c

    yield make
    for c in items:
        c.stop()


def drive_to_phase(c: Crash, phase: str) -> tuple[int, int]:
    """Start a turn and block until the phase is observable (or the engine has
    started, for the phases where the kill lands once the engine runs)."""
    spec = PHASES[phase]
    c.backend.script(spec["step"])
    owner = c.owner_client()
    thread_id, turn_id = _start_turn(owner)
    if spec["expect_log"] is not None:
        wait_for(
            lambda: c.backend.cli_log(spec["expect_log"]),
            timeout=20,
            what=f"the engine to reach {phase}",
        )
    return thread_id, turn_id


def _start_turn(owner):
    thread = owner.post("/api/v1/threads", json={})
    assert thread.status_code == 201, thread.text
    thread_id = thread.json()["id"]
    turn = owner.post(f"/api/v1/threads/{thread_id}/turns", json={"prompt_text": "work on it"})
    assert turn.status_code == 202, turn.text
    return thread_id, turn.json()["id"]


def assert_contract_after_kill(c: Crash, thread_id: int, turn_id: int, *, expected_replay: str | None):
    """Kill, restart, and assert the three-part crash contract. When
    `expected_replay` is None the phase is unobservable, so only the contract
    (not the specific replay class) is asserted."""
    kill(c.backend)
    c.backend.start(migrate=False)
    wait_for(
        lambda: interrupted_rows(c.backend, turn_id) == 1,
        timeout=40,
        what="the killed turn to be interrupted exactly once",
    )
    # AC2 exactly one interrupted row.
    assert interrupted_rows(c.backend, turn_id) == 1

    # AC3 no auto-replay: after restart and one sweep tick, no new turn row
    # exists. Wait for the turn count to settle (the sweep runs once at startup
    # and then on an interval), so the assertion cannot race the sweep.
    settled = wait_for(
        lambda: _turn_count_is_stable(c.backend, thread_id),
        timeout=30,
        what="the sweep to settle",
    )
    assert settled == [turn_id], f"a turn appeared after the kill: {settled}"
    if expected_replay is not None:
        assert replay_of(c.backend, turn_id) == expected_replay

    # AC4 lease reclaimed: a new user-initiated turn on the same thread is admitted.
    c.backend.script({"type": "chat", "text": "back again"})
    owner = c.login()
    new_turn = owner.post(f"/api/v1/threads/{thread_id}/turns", json={"prompt_text": "again"})
    assert new_turn.status_code == 202, new_turn.text
    wait_for(
        lambda: c.backend.query("SELECT status FROM turn WHERE id = ?", new_turn.json()["id"])[0][0]
        in ("succeeded", "failed"),
        timeout=40,
        what="the new turn to finish",
    )
    # The killed turn stays interrupted (never replayed).
    assert interrupted_rows(c.backend, turn_id) == 1


def _turn_count_is_stable(backend, thread_id: int, window: float = 1.0):
    """Wait until the thread's turn id list stops changing for `window` seconds,
    then return it — so an after-the-fact auto-replay is not missed by a too-early
    read."""
    import time as _t

    last = all_turn_ids(backend, thread_id)
    stable_since = _t.monotonic()
    while True:
        now = all_turn_ids(backend, thread_id)
        if now != last:
            last = now
            stable_since = _t.monotonic()
        elif _t.monotonic() - stable_since >= window:
            return last
        _t.sleep(0.1)


@pytest.mark.parametrize("phase", DETERMINISTIC)
def test_kill_at_observed_phase_interrupts_once_and_replays_the_right_class(crash, phase):
    c = crash(phase)
    c.start()
    thread_id, turn_id = drive_to_phase(c, phase)
    assert_contract_after_kill(c, thread_id, turn_id, expected_replay=PHASES[phase]["replay"])


@pytest.mark.parametrize("phase", UNOBSERVABLE)
def test_kill_at_the_unobservable_phase_interrupts_once_and_replays_nothing(crash, phase):
    """The `before_accept` phase cannot be observed from outside (engine_phase is
    `sent` before the engine spawns). This case kills as soon as the turn exists
    and asserts the contract that holds whichever sub-phase the kill landed in;
    it deliberately does not assert a specific replay class. Recorded in
    negative-control.md and the standing-requirement note (demotion protocol)."""
    c = crash(phase)
    c.start()
    thread_id, turn_id = drive_to_phase(c, phase)
    assert_contract_after_kill(c, thread_id, turn_id, expected_replay=None)
    # Whichever side of the mark_engine_sent race the kill landed on, the turn is
    # unreplayable and its replay class is one of the two honest values.
    assert replay_of(c.backend, turn_id) in ("before_accept", "unknown")


def test_no_kill_control_creates_no_interrupted_row(crash):
    """AC8 clean-lifecycle true negative: a turn driven to completion with no
    kill produces zero contract findings — the harness cannot pass by inventing
    violations on the nominal path."""
    c = crash("clean")
    c.start()
    c.backend.script({"type": "chat", "text": "all done"})
    owner = c.owner_client()
    thread_id, turn_id = _start_turn(owner)

    wait_for(
        lambda: c.backend.query("SELECT status FROM turn WHERE id = ?", turn_id)[0][0] == "succeeded",
        timeout=40,
        what="the clean turn to finish",
    )
    assert interrupted_rows(c.backend, turn_id) == 0
    assert replay_of(c.backend, turn_id) is None
