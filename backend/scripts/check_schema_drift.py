"""Refuse schema drift before merge.

A fresh, migrated SQLite database must describe exactly the schema the
SQLAlchemy models describe, and the Alembic revision graph must have a single
leaf. On 2026-10-23 the tree shipped a two-headed migration chain and a
hard-coded table rebuild that silently dropped ``agent.memory_upkeep`` on fresh
databases; only a full test-suite run happened to catch it. This script makes
that failure class a one-command, CI-enforced gate.

It creates a scratch SQLite database under a temp directory, upgrades it to
``head`` with the real migration entry point, reflects what the database
actually holds, and compares it against ``Base.metadata``. It never touches the
repository or any project database.

Exit contract (consumed by name — do not change without a manifest revision):

* ``0`` and ``schema drift: ok (N tables, 1 head)`` on a clean tree.
* ``1`` and a JSON report on stdout when the schema drifts or the revision
  graph has more than one leaf.

Run from ``backend/``::

    DATABASE_BACKEND=sqlite TOKEN_ENCRYPTION_KEYS=<key> \\
        python scripts/check_schema_drift.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Tables that exist in the database but are not ours (Alembic's bookkeeping).
_IGNORED_TABLES = {"alembic_version"}


class EnvMissing(RuntimeError):
    """A required environment variable is absent."""


class MigrationFailed(RuntimeError):
    """The migration entry point did not reach head on the scratch database."""


def _require_environment() -> None:
    """Fail with a clear message when the recipe env is absent, rather than a
    traceback from deep inside settings or the migration chain."""
    missing = [name for name in ("DATABASE_BACKEND", "TOKEN_ENCRYPTION_KEYS") if not os.environ.get(name)]
    if missing:
        raise EnvMissing(
            "missing environment variable(s): "
            + ", ".join(missing)
            + ". Set DATABASE_BACKEND=sqlite and TOKEN_ENCRYPTION_KEYS=<key> "
            "(the throwaway key in .github/workflows/ci.yml) before running."
        )
    if os.environ.get("DATABASE_BACKEND", "").strip().lower() != "sqlite":
        raise EnvMissing(
            "DATABASE_BACKEND must be 'sqlite' for the schema-drift check "
            f"(got {os.environ.get('DATABASE_BACKEND')!r})."
        )


def _upgrade_scratch_to_head(sqlite_file: Path) -> None:
    """Create ``sqlite_file`` fresh and upgrade it to head through the real
    Alembic entry point, in its own process, exactly as the app would."""
    environment = {
        **os.environ,
        "DATABASE_BACKEND": "sqlite",
        "SQLITE_PATH": str(sqlite_file),
        "PYTHONUTF8": "1",
    }
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND_DIR,
        env=environment,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        raise MigrationFailed(
            "alembic upgrade head failed on the scratch database:\n" + result.stderr.strip()
        )


def _revision_leaves() -> list[str]:
    """The leaf revisions of the Alembic graph.

    A leaf is a revision no other revision names as its ``down_revision``. More
    than one leaf is a two-headed chain even when ``upgrade head`` would
    succeed through a later merge. ``ScriptDirectory.get_heads()`` reports
    exactly these leaves.
    """
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    return sorted(script.get_heads())


def _model_tables() -> dict:
    """The model ground truth: table -> {columns: {name: nullable}, indexes:
    {name: unique}}."""
    import app.db.models  # noqa: F401  (populate Base.metadata)
    from app.db.base import Base

    tables = {}
    for table in Base.metadata.tables.values():
        columns = {column.name: bool(column.nullable) for column in table.columns}
        type_texts = {
            column.name: _affinity_of_model_column(column) for column in table.columns
        }
        indexes = {}
        for index in table.indexes:
            indexes[index.name] = bool(index.unique)
        # A single-column unique constraint is reported by the inspector as a
        # unique index on SQLite; fold it in so the comparison sees it.
        for constraint in table.constraints:
            from sqlalchemy import UniqueConstraint

            if isinstance(constraint, UniqueConstraint) and constraint.name:
                indexes[constraint.name] = True
        tables[table.name] = {
            "columns": columns,
            "type_texts": type_texts,
            "indexes": indexes,
        }
    return tables


def _db_tables(engine) -> dict:
    """What the migrated database actually holds: table -> {columns, indexes}."""
    from sqlalchemy import inspect

    inspector = inspect(engine)
    tables = {}
    for name in sorted(set(inspector.get_table_names()) - _IGNORED_TABLES):
        columns = {
            column["name"]: bool(column["nullable"]) for column in inspector.get_columns(name)
        }
        type_texts = {
            column["name"]: column["type"].compile(dialect=engine.dialect).upper()
            for column in inspector.get_columns(name)
        }
        indexes = {}
        for index in inspector.get_indexes(name):
            indexes[index["name"]] = bool(index["unique"])
        # SQLite reports unique constraints as unique indexes, but be safe on
        # other backends too.
        for constraint in inspector.get_unique_constraints(name):
            if constraint.get("name"):
                indexes[constraint["name"]] = True
        tables[name] = {"columns": columns, "type_texts": type_texts, "indexes": indexes}
    return tables


# SQLite DDL and the model type annotations name the same affinity differently
# (BOOLEAN vs BOOLEAN, DATETIME vs TIMESTAMP WITH TIME ZONE, VARCHAR vs TEXT,
# INTEGER vs BIGINT). Type text is compared loosely by affinity family; any
# remaining difference is a warning, never an exit 1.
_TYPE_FAMILY = {
    "BIGINT": "integer", "INTEGER": "integer", "SMALLINT": "integer",
    "TIMESTAMP WITH TIME ZONE": "datetime", "DATETIME": "datetime",
    "VARCHAR": "text", "TEXT": "text",
    "BOOLEAN": "boolean",
}


def _affinity(text: str) -> str:
    """The affinity family of a reflected type text (loose comparison)."""
    upper = text.upper()
    if upper.startswith("VARCHAR") or upper.startswith("CHAR"):
        return "text"
    if upper.startswith("NUMERIC") or upper.startswith("DECIMAL"):
        return "real"
    return _TYPE_FAMILY.get(upper, upper)


def _affinity_of_model_column(column) -> str:
    """The affinity family of a model column, from its Python type, so the
    comparison does not depend on the exact SQLAlchemy type class name.

    Custom column types whose Python type is not introspectable (``UTCDateTime``,
    ``JSON``) yield ``unknown``; the caller treats that as "do not compare" so a
    clean tree never emits a spurious warning."""
    import datetime
    import decimal

    try:
        python_type = column.type.python_type
    except NotImplementedError:
        return "unknown"
    if python_type is bool:
        return "boolean"
    if python_type is int:
        return "integer"
    if python_type in (float, decimal.Decimal):
        return "real"
    if python_type in (str, bytes):
        return "text"
    if python_type in (datetime.datetime, datetime.date, datetime.time):
        return "datetime"
    return "unknown"


def _compare(models: dict, db: dict) -> tuple[list[dict], list[str], list[str]]:
    """Per-table drift, warnings for tables only the database has, and type-text
    warnings.

    Columns are compared by (name, nullability) strictly; indexes by name and
    uniqueness. Tables present in the database but absent from the models are
    warnings, not failures (Alembic and third-party bookkeeping tables exist).
    Column type text is compared by affinity family only.
    """
    table_drifts = []
    unexpected = []
    type_warnings = []
    for name in sorted(set(db) - set(models)):
        unexpected.append(name)
    for name in sorted(set(models)):
        model = models[name]
        live = db.get(name)
        if live is None:
            table_drifts.append(
                {
                    "table": name,
                    "missing_in_db": [],
                    "missing_in_models": [],
                    "index_drifts": [],
                    "missing_table": True,
                }
            )
            continue
        missing_in_db = sorted(set(model["columns"]) - set(live["columns"]))
        missing_in_models = sorted(set(live["columns"]) - set(model["columns"]))
        # Same column on both sides but a nullability difference is drift too;
        # report it under missing_in_db so the reader sees the column named.
        for column in sorted(set(model["columns"]) & set(live["columns"])):
            if model["columns"][column] != live["columns"][column]:
                if column not in missing_in_db:
                    missing_in_db.append(column)
        index_drifts = []
        for index in sorted(set(model["indexes"]) - set(live["indexes"])):
            index_drifts.append(f"missing_in_db:{index}")
        for index in sorted(set(live["indexes"]) - set(model["indexes"])):
            index_drifts.append(f"missing_in_models:{index}")
        for index in sorted(set(model["indexes"]) & set(live["indexes"])):
            if model["indexes"][index] != live["indexes"][index]:
                index_drifts.append(
                    f"uniqueness_mismatch:{index} "
                    f"(models={model['indexes'][index]} db={live['indexes'][index]})"
                )
        if missing_in_db or missing_in_models or index_drifts:
            table_drifts.append(
                {
                    "table": name,
                    "missing_in_db": sorted(missing_in_db),
                    "missing_in_models": sorted(missing_in_models),
                    "index_drifts": sorted(index_drifts),
                }
            )
        for column in sorted(set(model["columns"]) & set(live["columns"])):
            model_family = model["type_texts"].get(column)
            db_family = _affinity(live["type_texts"].get(column, ""))
            if model_family in (None, "unknown") or not db_family:
                continue
            if model_family != db_family:
                type_warnings.append(
                    f"{name}.{column}: models={model_family} db={db_family}"
                )
    return table_drifts, unexpected, type_warnings


def run() -> int:
    _require_environment()

    from sqlalchemy import create_engine

    from app.db.engine import configure_sqlite

    leaves = _revision_leaves()

    # A multi-leaf graph is reported before any migration is attempted: the
    # failure is the revision wiring, not a migration error, and `upgrade head`
    # would itself refuse ("multiple heads") or silently pick one. Report the
    # heads as drift and stop.
    if len(leaves) > 1:
        print(json.dumps({"heads": leaves, "table_drifts": []}, indent=2, sort_keys=True))
        return 1

    with tempfile.TemporaryDirectory(prefix="schema-drift-") as tmp:
        sqlite_file = Path(tmp) / "scratch.db"
        _upgrade_scratch_to_head(sqlite_file)

        engine = create_engine(f"sqlite:///{sqlite_file.as_posix()}")
        configure_sqlite(engine)
        try:
            db_tables = _db_tables(engine)
        finally:
            engine.dispose()

    models = _model_tables()
    table_drifts, unexpected, type_warnings = _compare(models, db_tables)

    if not table_drifts:
        print(f"schema drift: ok ({len(db_tables)} tables, 1 head)")
        for table in unexpected:
            print(f"warning: table {table!r} is in the database but not the models", file=sys.stderr)
        for warning in type_warnings:
            print(f"warning: type affinity differs: {warning}", file=sys.stderr)
        return 0

    report = {"heads": leaves, "table_drifts": table_drifts}
    for warning in type_warnings:
        print(f"warning: type affinity differs: {warning}", file=sys.stderr)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1


def main() -> int:
    try:
        return run()
    except EnvMissing as exc:
        print(f"schema drift: cannot run: {exc}", file=sys.stderr)
        return 2
    except MigrationFailed as exc:
        print(f"schema drift: cannot run: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
