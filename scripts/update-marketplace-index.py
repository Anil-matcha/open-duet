#!/usr/bin/env python3
"""Regenerate the public marketplace index from the checked-in listings."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKETPLACE = ROOT / "marketplace"


def main() -> int:
    community = sorted(
        f"plugins/community/{path.name}"
        for path in (MARKETPLACE / "plugins/community").glob("*.json")
    )
    tested = sorted(
        f"plugins/tested/{path.name}"
        for path in (MARKETPLACE / "plugins/tested").glob("*.json")
        if path.name != "evidence.json"
    )
    target = MARKETPLACE / "catalog.json"
    target.write_text(
        json.dumps(
            {"schema_version": 1, "community": community, "tested": tested},
            ensure_ascii=False,
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    print(f"Updated {target.relative_to(ROOT)} ({len(community)} community, {len(tested)} tested)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
