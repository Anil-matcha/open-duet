"""Short lived, per-turn tokens for the local computer tool bridge.

The token never reaches a provider sandbox or a model. It is issued to the
local MCP child for one computer and one turn, then removed when that turn
ends. The Boat credential remains in the backend process.
"""

from __future__ import annotations

import hashlib
import secrets
import threading
import time
from pathlib import Path

_lock = threading.Lock()
_tokens: dict[str, tuple[int, int, Path, float]] = {}
_TTL_SECONDS = 60 * 60


def issue(computer_id: int, turn_id: int, grants_dir: Path) -> str:
    token = secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode("ascii")).hexdigest()
    with _lock:
        _purge_locked()
        _tokens[digest] = (computer_id, turn_id, grants_dir, time.monotonic() + _TTL_SECONDS)
    return token


def allows(computer_id: int, token: str) -> int | None:
    if not isinstance(token, str) or len(token) > 128:
        return None
    digest = hashlib.sha256(token.encode("utf-8", errors="ignore")).hexdigest()
    with _lock:
        record = _tokens.get(digest)
        if record is None:
            return None
        target, turn_id, _, expires = record
        if expires <= time.monotonic():
            _tokens.pop(digest, None)
            return None
        if target != computer_id:
            return None
        return turn_id


def grants_for(computer_id: int, token: str) -> Path | None:
    if not isinstance(token, str) or len(token) > 128:
        return None
    digest = hashlib.sha256(token.encode("utf-8", errors="ignore")).hexdigest()
    with _lock:
        record = _tokens.get(digest)
        if record is None:
            return None
        target, _, grants_dir, expires = record
        if expires <= time.monotonic() or target != computer_id:
            _tokens.pop(digest, None)
            return None
        return grants_dir


def revoke(token: str | None) -> None:
    if not token:
        return
    digest = hashlib.sha256(token.encode("utf-8", errors="ignore")).hexdigest()
    with _lock:
        _tokens.pop(digest, None)


def revoke_turn(computer_id: int, turn_id: int) -> None:
    with _lock:
        for digest, (target, turn, _, _) in tuple(_tokens.items()):
            if target == computer_id and turn == turn_id:
                _tokens.pop(digest, None)


def _purge_locked() -> None:
    now = time.monotonic()
    for digest, (_, _, _, expires) in tuple(_tokens.items()):
        if expires <= now:
            _tokens.pop(digest, None)
