"""A deleted agent's id is never given to a new one on SQLite, and a deleted
agent is never still named.

SQLite hands out max(id) + 1 for a plain INTEGER PRIMARY KEY, so deleting the
newest agent used to give its id to the next one. An agent's default folder is
workspace_dir()/agents/<id> and team.lead_agent_id names an agent by id, so a
reused id handed the deleted agent's working directory -- and, if it was the
team lead, its authority -- to a brand-new agent. The agent table is declared
AUTOINCREMENT, which never reuses an id; PostgreSQL identity columns never did.

Plain `sqlite3` with foreign keys on, the way the app opens the file."""

import sqlite3

import pytest
from sqlalchemy.dialects import sqlite
from sqlalchemy.schema import CreateTable

from app.db import models  # noqa: F401
from app.db.base import Base
from app.db.engine import create_app_sync_engine
from tests.db.schema_description import describe
from tests.db.sqlite_helpers import run_alembic

# The revision before agent ids became AUTOINCREMENT on SQLite.
BEFORE = "b9d3e7a1c502"


def connect(path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def upgrade(path, target="head"):
    result = run_alembic(path, "upgrade", target)
    assert result.returncode == 0, result.stderr


def schema_of(path):
    engine = create_app_sync_engine(f"sqlite:///{path.as_posix()}")
    try:
        return describe(engine)
    finally:
        engine.dispose()


def table_sql(connection, table) -> str:
    return connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()[0]


def add_agent(connection, owner="o", name="a") -> int:
    return connection.execute(
        "INSERT INTO agent (owner_id, name) VALUES (?, ?)", (owner, name)
    ).lastrowid


def add_team(connection, owner="o", lead=None) -> int:
    return connection.execute(
        "INSERT INTO team (owner_id, name, lead_agent_id) VALUES (?, 'team', ?)", (owner, lead)
    ).lastrowid


def test_the_models_declare_autoincrement_for_sqlite_only():
    ddl = str(CreateTable(Base.metadata.tables["agent"]).compile(dialect=sqlite.dialect()))
    assert "AUTOINCREMENT" in ddl


def test_a_new_database_never_reuses_a_deleted_agents_id(tmp_path):
    path = tmp_path / "new.db"
    upgrade(path)
    connection = connect(path)
    try:
        assert "AUTOINCREMENT" in table_sql(connection, "agent")
        first, second, third = add_agent(connection, name="a"), add_agent(connection, name="b"), add_agent(connection, name="c")
        connection.execute("DELETE FROM agent WHERE id = ?", (third,))
        assert add_agent(connection, name="d") > third
        connection.commit()
    finally:
        connection.close()


@pytest.fixture
def existing(tmp_path):
    """A database at the revision before the change, with three agents and a
    team led by the newest."""
    path = tmp_path / "existing.db"
    upgrade(path, BEFORE)
    connection = connect(path)
    a, b, c = add_agent(connection, name="a"), add_agent(connection, name="b"), add_agent(connection, name="c")
    add_team(connection, lead=c)
    connection.commit()
    connection.close()
    return path


def test_upgrading_keeps_every_row_and_index(existing, tmp_path):
    connection = connect(existing)
    rows_before = connection.execute("SELECT id, owner_id, name FROM agent ORDER BY id").fetchall()
    indexes_before = dict(connection.execute(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent' AND sql IS NOT NULL"
    ).fetchall())
    connection.close()

    upgrade(existing)

    connection = connect(existing)
    try:
        assert connection.execute("SELECT id, owner_id, name FROM agent ORDER BY id").fetchall() == rows_before
        assert dict(connection.execute(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent' AND sql IS NOT NULL"
        ).fetchall()) == indexes_before
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
        assert not [n for (n,) in connection.execute(
            "SELECT name FROM sqlite_master WHERE name LIKE '%rebuild%'"
        )]
        assert "AUTOINCREMENT" in table_sql(connection, "agent")
    finally:
        connection.close()
    fresh = tmp_path / "fresh.db"
    upgrade(fresh)
    assert schema_of(existing) == schema_of(fresh)


def test_an_upgraded_database_never_reuses_a_deleted_agents_id(existing):
    upgrade(existing)
    connection = connect(existing)
    try:
        connection.execute("DELETE FROM agent WHERE id = 3")  # the newest, from before the upgrade
        assert add_agent(connection, name="d") == 4
        connection.commit()
    finally:
        connection.close()


def test_a_dangling_lead_id_is_not_handed_to_a_new_agent(existing):
    """Agent 3 is gone but team.lead_agent_id still says 3. The next id must
    start above it, so the new agent is not silently the team lead."""
    connection = connect(existing)
    connection.execute("DELETE FROM agent WHERE id = 3")
    connection.commit()
    connection.close()

    upgrade(existing)

    connection = connect(existing)
    try:
        assert add_agent(connection, name="d") == 4
        lead = connection.execute("SELECT lead_agent_id FROM team").fetchone()[0]
        assert lead == 3  # untouched; the new agent is simply not that id
    finally:
        connection.close()


def test_downgrade_and_upgrade_again_keep_the_data(existing):
    upgrade(existing)
    connection = connect(existing)
    rows = connection.execute("SELECT id, owner_id, name FROM agent ORDER BY id").fetchall()
    connection.close()

    down = run_alembic(existing, "downgrade", BEFORE)
    assert down.returncode == 0, down.stderr
    connection = connect(existing)
    assert connection.execute("SELECT id, owner_id, name FROM agent ORDER BY id").fetchall() == rows
    assert "AUTOINCREMENT" not in table_sql(connection, "agent")
    connection.close()

    upgrade(existing)
    connection = connect(existing)
    try:
        assert connection.execute("SELECT id, owner_id, name FROM agent ORDER BY id").fetchall() == rows
        assert "AUTOINCREMENT" in table_sql(connection, "agent")
    finally:
        connection.close()
