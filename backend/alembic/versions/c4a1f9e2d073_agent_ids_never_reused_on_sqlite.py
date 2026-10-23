"""Agent ids are never reused on SQLite.

SQLite gives a plain INTEGER PRIMARY KEY the value max(id) + 1, so deleting the
newest agent handed its id to the next one. An agent's default folder is
workspace_dir()/agents/<id> and team.lead_agent_id names an agent by id, so a
reused id handed the deleted agent's working directory -- and, if it was the
team lead, its authority -- to a brand-new agent. AUTOINCREMENT never reuses an
id. PostgreSQL identity columns never did, so this does nothing there.

SQLite cannot add AUTOINCREMENT to an existing table, so `agent` is rebuilt:
copied aside, dropped, created again, refilled with the same ids, and its
indexes and triggers are recreated. Existing databases already hold bare
integer references to agents (team.lead_agent_id, thread.agent_id,
agent_job.*, room*, ...), and a delete before this upgrade left some of them
dangling; the next id must start above every id any surviving row still names,
so those references never land on a new agent. Everything runs in this
migration's one transaction, so a failure leaves the database as it was. The
desktop app copies the database file aside first.

The rebuild reads the columns, defaults, indexes and triggers the live database
holds for `agent` at execution time instead of spelling the schema out here:
other migrations add columns to `agent` (memory upkeep and friends came in on a
merged branch), and whichever order a fresh database walks the merged
branches in, a rebuild from the live schema cannot drop them.

Revision ID: c4a1f9e2d073
Revises: b9d3e7a1c502
"""

from alembic import context, op

revision = "c4a1f9e2d073"
down_revision = "b9d3e7a1c502"
branch_labels = None
depends_on = None

# Every column, anywhere, that names an agent by id but is not a foreign key.
_REFERENCES = (
    ("team", "lead_agent_id"),
    ("team_event", "agent_id"),
    ("agent_job", "requester_agent_id"),
    ("agent_job", "assignee_agent_id"),
    ("room", "default_responder_agent_id"),
    ("room_member", "agent_id"),
    ("room_dispatch", "agent_id"),
    ("thread", "agent_id"),
    ("computer", "agent_id"),
    ("routine", "agent_id"),
    ("agent", "created_by_agent_id"),
)


def _agent_columns(bind) -> list:
    """The `agent` table's columns as the database holds them now."""
    columns = list(bind.exec_driver_sql('PRAGMA table_info("agent")'))
    if not columns:
        raise RuntimeError("the agent table does not exist")
    return columns


def _agent_objects(bind) -> list[str]:
    """The index and trigger DDL the live database holds for `agent`."""
    return [
        row[0]
        for row in bind.exec_driver_sql(
            "SELECT sql FROM sqlite_master "
            "WHERE tbl_name = 'agent' AND type IN ('index', 'trigger') "
            "AND sql IS NOT NULL"
        )
    ]


def _agent_ddl(columns, autoincrement: bool) -> str:
    """CREATE TABLE agent from the live column list, with (or without) AUTOINCREMENT."""
    pk_names = [row[1] for row in columns if row[5]]
    definitions = []
    for _cid, name, sqltype, notnull, dflt, _pk in columns:
        if autoincrement and name == "id":
            definitions.append("id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT")
            continue
        text = f'"{name}" {sqltype}'
        if notnull:
            text += " NOT NULL"
        if dflt is not None:
            text += f" DEFAULT {dflt}"
        definitions.append(text)
    body = ",\n        ".join(definitions)
    if not autoincrement and pk_names:
        keys = ", ".join(f'"{name}"' for name in pk_names)
        body += f",\n\tPRIMARY KEY ({keys})"
    return f"CREATE TABLE agent (\n        {body}\n)"


def _highest_referenced_id(bind) -> int:
    """The highest agent id any surviving row still names, or 0."""
    tables = {
        row[0]
        for row in bind.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    highest = 0
    for table, column in _REFERENCES:
        if table not in tables:
            continue
        columns = {row[1] for row in bind.exec_driver_sql(f'PRAGMA table_info("{table}")')}
        if column not in columns:
            continue
        value = bind.exec_driver_sql(f'SELECT MAX("{column}") FROM "{table}"').scalar()
        if isinstance(value, int) and not isinstance(value, bool):
            highest = max(highest, value)
    return highest


def _rebuild(autoincrement: bool) -> None:
    bind = op.get_bind()
    columns = _agent_columns(bind)
    object_ddl = _agent_objects(bind)
    names = ", ".join(f'"{row[1]}"' for row in columns)
    bind.exec_driver_sql("DROP TABLE IF EXISTS _rebuild_agent")
    bind.exec_driver_sql(f"CREATE TABLE _rebuild_agent AS SELECT {names} FROM agent")
    bind.exec_driver_sql("DROP TABLE agent")
    bind.exec_driver_sql(_agent_ddl(columns, autoincrement))
    bind.exec_driver_sql(
        f"INSERT INTO agent ({names}) SELECT {names} FROM _rebuild_agent ORDER BY rowid"
    )
    bind.exec_driver_sql("DROP TABLE _rebuild_agent")
    for statement in object_ddl:
        bind.exec_driver_sql(statement)

    if autoincrement:
        floor = _highest_referenced_id(bind)
        current = bind.exec_driver_sql(
            "SELECT seq FROM sqlite_sequence WHERE name = 'agent'"
        ).scalar() or 0
        if floor > current:
            if bind.exec_driver_sql(
                "SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'agent'"
            ).scalar():
                bind.exec_driver_sql(
                    "UPDATE sqlite_sequence SET seq = ? WHERE name = 'agent'", (floor,)
                )
            else:
                bind.exec_driver_sql(
                    "INSERT INTO sqlite_sequence (name, seq) VALUES ('agent', ?)", (floor,)
                )


def upgrade():
    if context.is_offline_mode() or op.get_bind().dialect.name != "sqlite":
        return
    _rebuild(autoincrement=True)


def downgrade():
    if context.is_offline_mode() or op.get_bind().dialect.name != "sqlite":
        return
    _rebuild(autoincrement=False)
