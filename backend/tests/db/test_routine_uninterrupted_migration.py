import sqlite3
from alembic.config import Config
from alembic.script import ScriptDirectory
from tests.db.sqlite_helpers import BACKEND_DIR, run_alembic


def test_existing_routines_and_runs_start_without_uninterrupted_access(tmp_path):
    database = tmp_path / "routine-uninterrupted.db"
    result = run_alembic(database, "upgrade", "d7a4c91e5b26")
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as db:
        db.execute("INSERT INTO routine (owner_id,agent_id,name,prompt,schedule_kind,schedule_spec) VALUES ('o',1,'R','P','manual','{}')")
        db.execute("INSERT INTO routine_run (routine_id,trigger,state) VALUES (1,'manual','running')")
    result = run_alembic(database, "upgrade", "head")
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT uninterrupted_access FROM routine").fetchone() == (0,)
        assert db.execute("SELECT uninterrupted_access,capability_snapshot FROM routine_run").fetchone() == (0, "{}")
    result = run_alembic(database, "downgrade", "d7a4c91e5b26")
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as db:
        assert "uninterrupted_access" not in {row[1] for row in db.execute("PRAGMA table_info(routine)")}


def test_single_alembic_head_and_offline_upgrade_sql(tmp_path):
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    assert ScriptDirectory.from_config(config).get_heads() == ["a1b2c3d4e5f6"]
    result = run_alembic(tmp_path / "offline.db", "upgrade", "d7a4c91e5b26:head", "--sql")
    assert result.returncode == 0, result.stderr
    assert "ALTER TABLE routine ADD COLUMN uninterrupted_access" in result.stdout
    assert "ALTER TABLE routine_run ADD COLUMN capability_snapshot" in result.stdout
