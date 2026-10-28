#!/usr/bin/env python3
"""AC 3 end contract: grep every artifact for any secret shape, and report.

Used by the runbook after the walkthrough: it walks a directory, runs each file
through the same recognition used by `redact.py`, and fails loudly if any shape
from the environment (or a registered passphrase) appears raw.

It reads the shapes to look for from the environment, so it never hard-codes a
secret:
  SPRIME_ZEN_KEY        (optional) literal zen key
  SPRIME_RIVER_KEY      (optional) literal river key
  SPRIME_PASSPHRASE     (optional) literal passphrase
Plus structural shapes (rv_…, sk-/zen-…, eyJ… JWT) recognized by `redact.py`.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import redact  # noqa: E402

TEXT_SUFFIXES = {".txt", ".log", ".json", ".md", ".env", ".out", ""}


def _literal_shapes() -> list[tuple[str, str]]:
    shapes = []
    for env, label in (
        ("SPRIME_ZEN_KEY", "zen key (literal)"),
        ("SPRIME_RIVER_KEY", "river key (literal)"),
        ("SPRIME_PASSPHRASE", "passphrase (literal)"),
    ):
        value = os.environ.get(env)
        if value:
            shapes.append((label, re.escape(value)))
    return shapes


def _structural_shapes() -> list[tuple[str, str]]:
    return [
        ("river key (shape)", r"\brv_[A-Za-z0-9_\-]{8,}\b"),
        ("zen key (shape)", r"\b(?:sk|zen)-[A-Za-z0-9_\-]{8,}\b"),
        ("session token (shape)", r"\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b"),
    ]


def scan(root: Path) -> list[str]:
    findings: list[str] = []
    shapes = _literal_shapes() + _structural_shapes()
    files = [p for p in root.rglob("*") if p.is_file() and p.suffix in TEXT_SUFFIXES]
    for path in files:
        try:
            text = path.read_text(errors="replace")
        except OSError:
            continue
        for label, pattern in shapes:
            for match in re.finditer(pattern, text):
                findings.append(f"{path}: {label} at offset {match.start()}")
    return findings


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: verify_no_secrets.py <artifacts-dir>", file=sys.stderr)
        return 64
    root = Path(argv[1])
    if not root.exists():
        print(f"no such directory: {root}", file=sys.stderr)
        return 66

    findings = scan(root)
    if findings:
        print("SECRET SHAPES FOUND — rotate the river key before anything lands:")
        for line in findings:
            print(f"  {line}")
        return 1
    print("clean: no secret shapes in any artifact")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
