import sqlite3
from tests.db.sqlite_helpers import run_alembic


def test_existing_routines_keep_grants_off_and_downgrade(tmp_path):
    database = tmp_path / "routine-grants.db"
    result = run_alembic(database, "upgrade", "d4b9e1a37c58")
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as db:
        db.execute("INSERT INTO routine (owner_id,agent_id,name,prompt,schedule_kind,schedule_spec) VALUES ('owner',1,'Report','Hello','manual','{}')")
    result = run_alembic(database, "upgrade", "e8a3c7b1d902")
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as db:
        assert db.execute("SELECT connected_app_grants FROM routine").fetchone() == ("[]",)
        db.execute("INSERT INTO routine_run (routine_id, trigger, state) VALUES (1, 'manual', 'running')")
        for _ in range(2):
            db.execute("INSERT INTO routine_app_action (run_id,tool,account_id,status) VALUES (1,'gmail_fetch_thread','ca_mail','completed')")
        db.execute("INSERT INTO routine_app_action (run_id,tool,account_id,request_key,status) VALUES (1,'gmail_send_email','ca_mail','request-sha256','reserved')")
        try:
            db.execute("INSERT INTO routine_app_action (run_id,tool,account_id,request_key,status) VALUES (1,'gmail_send_email','ca_mail','request-sha256','reserved')")
            raise AssertionError("A write reservation was replayed")
        except sqlite3.IntegrityError:
            pass
    result = run_alembic(database, "downgrade", "d4b9e1a37c58")
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(database) as db:
        assert "routine_app_action" not in {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert "connected_app_grants" not in {r[1] for r in db.execute("PRAGMA table_info(routine)")}
