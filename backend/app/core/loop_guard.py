"""Refuse to block the event loop on a lock.

Some operations block the calling thread for a real, unbounded time: a
cross-process ``flock``/``msvcrt.locking`` a child process may hold, for
instance. Called from a coroutine they stall the whole loop — every turn, every
stream, every request (issue: the ``release_turn`` file lock). They must run in
a worker thread (``asyncio.to_thread``).

This module owns the single, named guard for that rule so a new call site
cannot reintroduce the stall silently, and a test can name the refusal.
"""

import asyncio

# The budget an operation may block the loop for free. Anything that can block
# longer than this must be moved off the loop.
LOOP_BUDGET_SECONDS = 0.05


class LoopBlockedError(RuntimeError):
    """A blocking operation was entered on the event loop thread.

    Raised instead of blocking, so the mistake fails loudly at the call site
    rather than silently stalling every task on the loop.
    """


def _on_event_loop() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def assert_off_loop(operation: str) -> None:
    """Raise ``LoopBlockedError`` when called on the event loop thread.

    ``operation`` names the thing that blocks, so the error tells the reader
    what to move into a worker thread and why.
    """
    if _on_event_loop():
        raise LoopBlockedError(
            f"{operation} blocks the calling thread; call it through "
            f"asyncio.to_thread (or a worker thread), never on the event loop."
        )
