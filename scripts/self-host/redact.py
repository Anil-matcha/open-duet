#!/usr/bin/env python3
"""Capture-time redaction filter for the self-hosting walkthrough (AC 3).

The walkthrough runs on a live host with a real provider key and a sign-in
passphrase. Nothing may reach an artifact raw: every transcript is piped through
`redact()` at capture time, and a post-run grep over every artifact for the four
secret shapes plus the literal passphrase must come back empty.

The four shapes it must know (AC 3):
  (a) the zen (opencode) key prefix         -> `sk-…`/`zen-…` tokens
  (b) the river key prefix                  -> `rv_…`
  (c) the app passphrase                    -> supplied at run time, substituted
  (d) JWT-shaped session tokens             -> `eyJ…` (sign-in cookies)

It is deliberately standalone (no backend import): the direct-install route runs
it from the scratch clone, not from the server package. `redact` is total — it
never raises on bytes, None or odd input.

The passphrase is never hard-coded. `set_passphrase(value)` (or the
`SPRIME_PASSPHRASE` env var, read once) registers it; the filter replaces it with a
placeholder wherever it appears, including inside otherwise-unremarkable text.
"""

from __future__ import annotations

import os
import re

PLACEHOLDER = "<redacted:{kind}>"

# Shape patterns. Ordered so the more specific key prefixes are tried before the
# generic long-token catch-all.
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # (b) river key: rv_ followed by a token body.
    ("river-key", re.compile(r"\brv_[A-Za-z0-9_\-]{8,}\b")),    # (a) zen/opencode key prefixes.
    ("zen-key", re.compile(r"\b(?:sk|zen)-[A-Za-z0-9_\-]{8,}\b", re.IGNORECASE)),
    # (d) JWT-shaped session token: three base64url segments starting eyJ.
    ("session-token", re.compile(r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b")),
    # Bearer/Basic headers (sign-in flow).
    ("auth-header", re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/\-]{12,}=*")),
    # Generic `key|token|secret|password = <value>` assignments.
    (
        "named-secret",
        re.compile(
            r"(?i)([A-Za-z0-9_.\-]*(?:key|token|secret|passw(?:or)?d|credential|auth)[A-Za-z0-9_.\-]*"
            r"\s*[=:]\s*)(?:\"[^\"]*\"|'[^']*'|\S+)"
        ),
    ),
    # Long opaque token catch-all (>=40 chars) — keys that match no known prefix.
    # Deliberately conservative: no path separators (`.`, `/`) and requires mixed
    # classes (a letter and a digit, plus an upper or lower change), so plain long
    # words and absolute paths are NOT eaten. Prefixed keys are already caught above.
    (
        "opaque-token",
        re.compile(
            r"\b(?=[A-Za-z0-9_\-]{40,}={0,2}\b)"
            r"(?=[A-Za-z0-9_\-]*[0-9])(?=[A-Za-z0-9_\-]*[A-Za-z])"
            r"(?=[A-Za-z0-9_\-]*[A-Z][A-Za-z0-9_\-]*[a-z]|[A-Za-z0-9_\-]*[a-z][A-Za-z0-9_\-]*[A-Z])"
            r"[A-Za-z0-9_\-]{40,}={0,2}\b"
        ),
    ),
]

# The literal passphrase, registered at run time. Kept last so it always wins.
_passphrase: str | None = None


def set_passphrase(value: str | None) -> None:
    """Register the app passphrase so it is scrubbed wherever it appears."""
    global _passphrase
    _passphrase = value or None


def _load_passphrase_from_env() -> None:
    value = os.environ.get("SPRIME_PASSPHRASE")
    if value:
        set_passphrase(value)


def redact(text) -> str:
    """Return `text` with every recognized secret shape replaced by a placeholder.

    Total: bytes are decoded, `None` becomes the empty string, and no input raises.
    """
    if text is None:
        return ""
    if isinstance(text, (bytes, bytearray)):
        text = bytes(text).decode("utf-8", "replace")
    if not isinstance(text, str):
        text = str(text)

    for kind, pattern in _PATTERNS:
        if pattern.groups:
            text = pattern.sub(lambda m, k=kind: m.group(1) + PLACEHOLDER.format(kind=k), text)
        else:
            text = pattern.sub(PLACEHOLDER.format(kind=kind), text)

    if _passphrase:
        text = text.replace(_passphrase, PLACEHOLDER.format(kind="passphrase"))
    return text


_shapes_loaded = False


def _ensure_shapes() -> None:
    global _shapes_loaded
    if not _shapes_loaded:
        _load_passphrase_from_env()
        _shapes_loaded = True


def capture(source: str) -> str:
    """Read `source` (a command whose stdout/stderr are being captured), or a
    string, and return it redacted. With no argument it reads stdin.

    Intended to be used as `… | redact.py` or `redact.capture(text)` — the whole
    point is that the raw text never touches disk before it is filtered.
    """
    _ensure_shapes()
    import sys

    if source == "-":
        return redact(sys.stdin.read())
    return redact(source)


def main(argv: list[str]) -> int:
    _ensure_shapes()
    import sys

    text = sys.stdin.read() if not argv[1:] else " ".join(argv[1:])
    sys.stdout.write(redact(text))
    return 0


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))
