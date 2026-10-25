"""SIGKILL crash fault injection — the turn crash contract made executable.

`docs/RELIABILITY.md` promises that a hard kill (`kill -9`) cannot clean up, so
the next start marks the in-flight turn `interrupted` once its lease runs out,
and nothing is ever resumed or replayed automatically. This harness starts the
real backend process, drives a turn with the fake engine to a chosen phase,
SIGKILLs the backend, restarts it, and asserts the contract:

* exactly one `interrupted` row for the killed turn — never zero, never two;
* zero auto-replay — no turn is started by the restart or the sweep;
* the lease is reclaimed — a NEW user-initiated turn on the same thread is
  admitted.

Reuses `tests/e2e/backend.py` (the real process, signals, scratch SQLite) the
same way `tests/e2e/test_shutdown.py` does. The delta is the phase barrier and
the store assertions.
"""

import signal
import sys
import time
from pathlib import Path

import httpx
import pytest

from tests.e2e.backend import Backend, Owner, wait_for

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX signals and process groups")

# The three contract phases (docs/RELIABILITY.md "A cut turn says whether the
# engine had the message"). The fake engine step and the kill barrier that make
# each phase observable deterministically:
#
#   before_accept  the prompt never reached the engine (engine_phase=preparing,
#                  no stored engine events). Hard to observe from outside: the
#                  backend marks the phase `sent` before it spawns the engine,
#                  so there is no external signal for "not yet sent".
#   after_accept   the engine produced output (stored events) -> replay after_accept.
#   unknown        the engine had the prompt and reported nothing (phase sent,
#                  no stored events) -> replay unknown.
#
# `after_accept` and `unknown` are made deterministic by the fake engine step:
# the step logs `hanging` (engine started) only after the events it emits (or
# none), and the backend has already set engine_phase=sent before the engine
# runs, so killing after the log lands in the intended phase.
PHASES = {
    "after_accept": {"step": {"type": "accept_then_hang"}, "expect_log": "hanging", "replay": "after_accept"},
    "unknown": {"step": {"type": "silent"}, "expect_log": "hanging", "replay": "unknown"},
    # before_accept: kill as soon as the turn row exists, before the engine is
    # spawned. The harness polls engine_phase; if it cannot catch `preparing`
    # the case is treated as unobservable (demoted) rather than guessed.
    "before_accept": {"step": {"type": "silent"}, "expect_log": None, "replay": "before_accept"},
}


class Crash:
    """A backend under test, with a fresh scratch folder and the owner HTTP."""

    def __init__(self, root: Path) -> None:
        self.backend = Backend(root, env={"LOOPBACK_TRUST": "programs"})
        self.owner: Owner | None = None

    def start(self, *, migrate: bool = True) -> None:
        self.backend.start(migrate=migrate)

    def stop(self) -> None:
        self.backend.stop()

    def owner_client(self) -> Owner:
        owner = Owner(self.backend)
        owner.setup()
        self.owner = owner
        return owner

    def login(self) -> Owner:
        """Re-sign-in after a restart (the session lives in the process that
        died on SQLite? No — the owner row is durable; only the session cookie
        must be obtained again)."""
        owner = Owner(self.backend)
        owner.login()
        self.owner = owner
        return owner


def start_turn(owner: Owner, prompt: str = "work on it") -> tuple[int, int]:
    thread = owner.post("/api/v1/threads", json={})
    assert thread.status_code == 201, thread.text
    thread_id = thread.json()["id"]
    turn = owner.post(f"/api/v1/threads/{thread_id}/turns", json={"prompt_text": prompt})
    assert turn.status_code == 202, turn.text
    return thread_id, turn.json()["id"]


def kill(b: Backend) -> None:
    """SIGKILL the backend's process group.

    The engine child runs in its own session, so it may survive the parent (the
    contract is about durable state, not children); kill the group so nothing of
    the backend lingers, and rely on the startup sweep for the engine (which the
    restart test also exercises).
    """
    b.signal(signal.SIGKILL)
    b.wait_exit(timeout=10)


def wait_for_phase(b: Backend, turn_id: int, phase: str, timeout: float = 15.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        rows = b.query("SELECT engine_phase FROM turn WHERE id = ?", turn_id)
        if rows and rows[0][0] == phase:
            return True
        time.sleep(0.02)
    return False


def interrupted_rows(b: Backend, turn_id: int) -> int:
    return b.query("SELECT COUNT(*) FROM turn WHERE id = ? AND status = 'interrupted'", turn_id)[0][0]


def replay_of(b: Backend, turn_id: int) -> str | None:
    rows = b.query(
        "SELECT json_extract(data, '$.replay') FROM event "
        "WHERE turn_id = ? AND type = 'turn.interrupted' ORDER BY seq DESC LIMIT 1",
        turn_id,
    )
    return rows[0][0] if rows else None


def all_turn_ids(b: Backend, thread_id: int) -> list[int]:
    return [row[0] for row in b.query("SELECT id FROM turn WHERE thread_id = ? ORDER BY id", thread_id)]
