#!/usr/bin/env python3
"""AC 3 verifier: the redaction filter scrubs every secret shape it claims to know.

Runs with plain `python3` (or `uv run`) from the scratch clone — no test framework
required, matching the standalone capture script. All values here are DUMMY
strings shaped like the real ones; no live secret is ever used.

Covers AC 3's four shapes:
  (a) zen/opencode key prefix, (b) river key prefix `rv_`,
  (c) the app passphrase (substituted), (d) JWT-shaped session tokens
and the "post-run grep returns empty" contract.
"""

from __future__ import annotations

import io
import re
import sys
from contextlib import redirect_stdout

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import redact  # noqa: E402

# Dummy shapes — deliberately not real credentials.
ZEN = "sk-live-zen-abcdef0123456789XYZ"
RIVER = "rv_AbCdEf0123456789_zzz"
JWT = (
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVuLWR1ZXQifQ."
    "c2lnbmF0dXJlLWR1bW15LXZhbHVlLTEyMzQ1Ng"
)
PASSPHRASE = "correct horse battery staple dummy"

SECRET_SHAPES = [
    ("zen key", ZEN),
    ("river key", RIVER),
    ("session token", JWT),
    ("passphrase", PASSPHRASE),
]

_failures: list[str] = []


def check(name: str, condition: bool) -> None:
    status = "ok  " if condition else "FAIL"
    print(f"[{status}] {name}")
    if not condition:
        _failures.append(name)


try:  # pytest-visible guard: no test may end with a failed check
    import pytest

    @pytest.fixture(autouse=True)
    def _assert_no_failures():
        """Fail the test the moment any check() reported FAIL — so a mutation to
        the filter cannot silently pass the pytest suite. Unused under __main__."""
        _failures.clear()
        yield
        failed = list(_failures)
        _failures.clear()
        assert not failed, f"redaction checks failed: {failed}"

except ImportError:  # plain python3 run: __main__ aggregates instead
    pass


def test_each_shape_is_removed() -> None:
    redact.set_passphrase(PASSPHRASE)
    try:
        for label, value in SECRET_SHAPES:
            out = redact.redact(f"prefix {value} suffix")
            check(f"{label} removed", value not in out)
            check(f"{label} leaves surroundings", "prefix" in out and "suffix" in out)
    finally:
        redact.set_passphrase(None)


def test_named_assignment_shapes() -> None:
    cases = [
        "OPENAI_API_KEY=sk-live-zen-abcdef0123456789XYZ",
        "river_key: rv_AbCdEf0123456789_zzz",
        'token="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVuLWR1ZXQifQ.c2lnLWR1bQ"',
        "Authorization: Bearer abcdef0123456789ABCDEF",
    ]
    for case in cases:
        out = redact.redact(case)
        check(f"assignment scrubbed: {case.split('=', 1)[0].split(':', 1)[0]}", "v_" not in out and "sk-" not in out and "eyJ" not in out and "Bearer abcdef" not in out)


def test_passphrase_substitution() -> None:
    redact.set_passphrase(PASSPHRASE)
    try:
        out = redact.redact(f"you typed {PASSPHRASE} and {PASSPHRASE} again")
        check("passphrase never appears", PASSPHRASE not in out)
        check("passphrase placeholder present", out.count("<redacted:passphrase>") == 2)
    finally:
        redact.set_passphrase(None)


def test_total_on_odd_input() -> None:
    check("bytes do not raise", isinstance(redact.redact(b"rv_AbCdEf0123456789_zzz"), str))
    check("None is empty", redact.redact(None) == "")
    check("int does not raise", isinstance(redact.redact(12345), str))


def test_paths_are_not_over_redacted() -> None:
    """D-2 regression: the opaque-token catch-all must not eat absolute paths or
    long plain words (the round-1 filter turned `/tmp/.../out` into a placeholder)."""
    keep = [
        "/tmp/sprime-walkthrough/clone/frontend/out",
        "/opt/open-dots/backend/.venv/bin/python",
        "ThisIsALongCamelCaseWordThatShouldProbablyStayAsIsNotASecretX",
    ]
    for s in keep:
        out = redact.redact(s)
        check(f"path/word kept: {s[:40]}", "<redacted" not in out and out == s)
    # A real mixed-class opaque token is still caught.
    token = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0UvWxYz"
    check("opaque token still caught", token not in redact.redact(token))


def test_grep_contract() -> None:
    """The AC 3 end contract: after redaction, a grep for any shape returns empty."""
    redact.set_passphrase(PASSPHRASE)
    try:
        fake_transcript = "\n".join(
            [
                f"$ export OPENAI_API_KEY={ZEN}",
                f"$ export RIVER_API_KEY={RIVER}",
                f"set-cookie: session={JWT}",
                f"passphrase prompt> {PASSPHRASE}",
            ]
        )
        cleaned = redact.redact(fake_transcript)
        for label, value in SECRET_SHAPES:
            check(f"grep empty for {label}", re.search(re.escape(value), cleaned) is None)
        # Control: the raw text WOULD match — the grep has teeth.
        for label, value in SECRET_SHAPES:
            check(f"raw raw would match {label}", re.search(re.escape(value), fake_transcript) is not None)
    finally:
        redact.set_passphrase(None)


def test_stdin_cli_path() -> None:
    """`… | redact.py` must scrub too (the capture path), not just the function."""
    real_stdin = sys.stdin
    buf = io.StringIO(f"key={RIVER}\n")
    sys.stdin = buf
    captured = io.StringIO()
    try:
        with redirect_stdout(captured):
            redact.main(["redact.py"])
    finally:
        sys.stdin = real_stdin
    check("stdin path scrubbed", RIVER not in captured.getvalue())


if __name__ == "__main__":
    test_each_shape_is_removed()
    test_named_assignment_shapes()
    test_passphrase_substitution()
    test_total_on_odd_input()
    test_grep_contract()
    test_stdin_cli_path()
    print()
    if _failures:
        print(f"FAILED ({len(_failures)}): {_failures}")
        raise SystemExit(1)
    print("all checks passed")
