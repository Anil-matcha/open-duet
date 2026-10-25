"""The schema-drift gate's exit contract and comparator.

The script (backend/scripts/check_schema_drift.py) is the CI gate; these tests
pin the parts a stranger can run without mutating the tree: a clean tree exits 0
with the documented stdout, a missing recipe env fails clearly, and the
comparator reports column/index/type drift in the documented JSON shape. The
on-disk negative controls (leaf, model column, incident replay, revert) live in
.agents/specs/schema-drift-gate/negative-control.md — they mutate tracked files
and so are not run under pytest.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).parents[2]
SCRIPT = BACKEND_DIR / "scripts" / "check_schema_drift.py"

pytestmark = pytest.mark.skipif(
    os.environ.get("DATABASE_BACKEND") != "sqlite",
    reason="the drift check runs the SQLite migration path",
)


def run_script(**environment) -> subprocess.CompletedProcess:
    env = {
        **os.environ,
        "DATABASE_BACKEND": "sqlite",
        "TOKEN_ENCRYPTION_KEYS": "3n3b2YkQd0xVv8m1c1m0nq1l4Z3xk9q0n7xv7y5q8wE=",
        **environment,
    }
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )


def test_a_clean_tree_exits_zero_with_the_documented_line():
    result = run_script()
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith("schema drift: ok (")
    assert result.stdout.strip().endswith("1 head)")


def test_the_recipe_environment_is_required():
    result = run_script(TOKEN_ENCRYPTION_KEYS="")
    assert result.returncode == 2
    assert "TOKEN_ENCRYPTION_KEYS" in result.stderr
    assert "Traceback" not in result.stderr


def test_the_backend_must_be_sqlite():
    result = run_script(DATABASE_BACKEND="postgres")
    assert result.returncode == 2
    assert "sqlite" in result.stderr.lower()


# --- the comparator: drift is reported in the documented shape ------------------


def _models(columns, indexes=None, type_texts=None):
    return {
        "agent": {
            "columns": columns,
            "type_texts": type_texts or {},
            "indexes": indexes or {},
        }
    }


def _db(columns, indexes=None, type_texts=None):
    return {
        "agent": {
            "columns": columns,
            "type_texts": type_texts or {},
            "indexes": indexes or {},
        }
    }


def import_tool():
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    import scripts.check_schema_drift as tool

    return tool


def test_a_model_column_absent_from_the_database_is_missing_in_db():
    tool = import_tool()
    drifts, _unexpected, _warnings = tool._compare(
        _models({"id": False, "probe": False}), _db({"id": False})
    )
    assert drifts == [
        {
            "table": "agent",
            "missing_in_db": ["probe"],
            "missing_in_models": [],
            "index_drifts": [],
        }
    ]


def test_a_database_column_absent_from_the_models_is_missing_in_models():
    tool = import_tool()
    drifts, _unexpected, _warnings = tool._compare(
        _models({"id": False}), _db({"id": False, "legacy": True})
    )
    assert drifts[0]["missing_in_models"] == ["legacy"]


def test_a_nullability_change_is_drift_named_under_missing_in_db():
    tool = import_tool()
    drifts, _unexpected, _warnings = tool._compare(
        _models({"id": False}), _db({"id": True})
    )
    assert drifts[0]["missing_in_db"] == ["id"]


def test_an_index_only_the_database_has_is_reported():
    tool = import_tool()
    drifts, _unexpected, _warnings = tool._compare(
        _models({"id": False}), _db({"id": False}, indexes={"ix_extra": False})
    )
    assert drifts[0]["index_drifts"] == ["missing_in_models:ix_extra"]


def test_a_type_family_mismatch_is_a_warning_not_drift():
    tool = import_tool()
    drifts, _unexpected, warnings = tool._compare(
        _models({"id": False, "flag": False}, type_texts={"flag": "boolean"}),
        _db({"id": False, "flag": False}, type_texts={"flag": "VARCHAR"}),
    )
    assert drifts == []
    assert warnings == ["agent.flag: models=boolean db=text"]


def test_a_type_text_that_reads_the_same_family_is_not_a_warning():
    tool = import_tool()
    _drifts, _unexpected, warnings = tool._compare(
        _models({"code": False}, type_texts={"code": "text"}),
        _db({"code": False}, type_texts={"code": "VARCHAR(64)"}),
    )
    assert warnings == []


def test_the_json_report_keys_are_exactly_heads_and_table_drifts():
    """The report shape is consumed by name (integration-approval-trust)."""
    tool = import_tool()
    drifts, _unexpected, _warnings = tool._compare(
        _models({"id": False}), _db({})
    )
    report = {"heads": ["x"], "table_drifts": drifts}
    assert set(report) == {"heads", "table_drifts"}
    assert set(report["table_drifts"][0]) >= {
        "table",
        "missing_in_db",
        "missing_in_models",
        "index_drifts",
    }
    json.dumps(report)  # serializable
