import sqlite3
from tests.db.sqlite_helpers import run_alembic


def test_quiet_upgrade_preserves_existing_history_and_downgrade(tmp_path):
    database = tmp_path / "quiet.db"
    result = run_alembic(database, "upgrade", "e8a3c7b1d902")
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as db:
        db.execute("INSERT INTO routine(owner_id,agent_id,name,prompt,schedule_kind,schedule_spec) VALUES('owner',1,'Check','Check','manual','{}')")
        db.execute("INSERT INTO routine_run(routine_id,trigger,state,result) VALUES(1,'schedule','completed','Report')")
    result = run_alembic(database, "upgrade", "f6b4d8a2c901")
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT quiet_reporting FROM routine").fetchone() == (0,)
        assert db.execute("SELECT result,outcome,outcome_details FROM routine_run").fetchone() == ('Report', None, None)
    result = run_alembic(database, "downgrade", "e8a3c7b1d902")
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT result FROM routine_run").fetchone() == ('Report',)
        assert 'quiet_reporting' not in {r[1] for r in db.execute('PRAGMA table_info(routine)')}
