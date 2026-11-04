"""An optional turn time limit that stops while a person decides: waiting for
an approval is not the engine running long (the wait has its own limit)."""

import time


class TurnClock:
    def __init__(self, seconds: float) -> None:
        self._enabled = seconds > 0
        self._left = float(seconds) if self._enabled else 0.0
        self._since: float | None = time.monotonic() if self._enabled else None
        self._pauses = 0

    def pause(self) -> None:
        if not self._enabled:
            return
        self._pauses += 1
        if self._pauses == 1 and self._since is not None:
            self._left -= time.monotonic() - self._since
            self._since = None

    def resume(self) -> None:
        if not self._enabled:
            return
        if self._pauses == 0:
            return
        self._pauses -= 1
        if self._pauses == 0:
            self._since = time.monotonic()

    def remaining(self) -> float | None:
        """Seconds left, or None while paused (no limit runs)."""
        if self._since is None:
            return None
        return self._left - (time.monotonic() - self._since)

    @property
    def expired(self) -> bool:
        left = self.remaining()
        return left is not None and left <= 0
