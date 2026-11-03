"""Read an OpenBot SQLite agent roster and normalize profiles to agent files.

This reader opens a bounded copy read-only, never runs source migrations, and
returns only the fields needed to review a new Open Dots agent.
"""

import json
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from app.services import agent_package

MAX_SOURCE_DATABASE_BYTES = 128 * 1024 * 1024
MAX_PROFILES = 200
MAX_AGENT_JSON_BYTES = 1024 * 1024
MIN_SCHEMA_VERSION = 8
MAX_SCHEMA_VERSION = 50


class OpenBotDatabaseImportError(ValueError):
    pass


def preview_database(data: bytes) -> dict[str, Any]:
    """Return safe agent-file previews from one supported local database."""
    if len(data) > MAX_SOURCE_DATABASE_BYTES:
        raise OpenBotDatabaseImportError("The OpenBot database is larger than 128 MB.")
    if not data.startswith(b"SQLite format 3\x00"):
        raise OpenBotDatabaseImportError("Choose a valid OpenBot SQLite database file.")

    try:
        with tempfile.TemporaryDirectory(prefix="agent-import-") as directory:
            path = Path(directory) / "source.sqlite"
            path.write_bytes(data)
            uri = f"{path.as_uri()}?mode=ro&immutable=1"
            connection = sqlite3.connect(uri, uri=True, timeout=1)
            try:
                connection.row_factory = sqlite3.Row
                connection.execute("PRAGMA query_only = ON")
                connection.execute("PRAGMA trusted_schema = OFF")
                version = _check_schema(connection)
                rows = connection.execute(
                    "SELECT agent_id, agent_json FROM projection_agents ORDER BY sort_order, agent_id LIMIT ?",
                    (MAX_PROFILES + 1,),
                ).fetchall()
                if len(rows) > MAX_PROFILES:
                    raise OpenBotDatabaseImportError("The OpenBot database has more than 200 agent profiles.")
                if not rows:
                    raise OpenBotDatabaseImportError("The OpenBot database has no agent profiles to import.")
                profiles = [_profile(row) for row in rows]
                return {"schema_version": version, "profiles": profiles}
            finally:
                connection.close()
    except OpenBotDatabaseImportError:
        raise
    except (OSError, sqlite3.Error, ValueError) as exc:
        raise OpenBotDatabaseImportError("The OpenBot database could not be read. Close OpenBot and choose its database again.") from exc


def _check_schema(connection: sqlite3.Connection) -> int:
    tables = {
        row["name"]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('schema_migrations', 'projection_agents')"
        )
    }
    if tables != {"schema_migrations", "projection_agents"}:
        raise OpenBotDatabaseImportError("That OpenBot database format is not supported.")

    migration_columns = {row["name"] for row in connection.execute("PRAGMA table_info(schema_migrations)")}
    agent_columns = {row["name"] for row in connection.execute("PRAGMA table_info(projection_agents)")}
    if "version" not in migration_columns or not {"agent_id", "agent_json", "sort_order"}.issubset(agent_columns):
        raise OpenBotDatabaseImportError("That OpenBot database format is not supported.")

    versions = [row["version"] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")]
    if not versions or any(not isinstance(version, int) for version in versions):
        raise OpenBotDatabaseImportError("That OpenBot database has invalid schema version information.")
    version = max(versions)
    if version < MIN_SCHEMA_VERSION or version > MAX_SCHEMA_VERSION:
        raise OpenBotDatabaseImportError("That OpenBot database version is not supported by this importer.")
    if any(number not in versions for number in range(MIN_SCHEMA_VERSION, version + 1)):
        raise OpenBotDatabaseImportError("That OpenBot database has incomplete schema version information.")
    return version


def _profile(row: sqlite3.Row) -> dict[str, Any]:
    raw = row["agent_json"]
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_AGENT_JSON_BYTES:
        raise OpenBotDatabaseImportError("An OpenBot agent profile is too large to preview.")
    try:
        source = json.loads(raw)
    except (TypeError, json.JSONDecodeError, RecursionError) as exc:
        raise OpenBotDatabaseImportError("An OpenBot agent profile contains invalid data.") from exc
    if not isinstance(source, dict):
        raise OpenBotDatabaseImportError("An OpenBot agent profile contains invalid data.")

    source_id = row["agent_id"]
    name = source.get("name")
    title = source.get("title") or ""
    role_text = source.get("description") or ""
    if (
        not isinstance(source_id, str)
        or not source_id
        or not isinstance(name, str)
        or not isinstance(title, str)
        or not isinstance(role_text, str)
    ):
        raise OpenBotDatabaseImportError("An OpenBot agent profile is missing a supported name or text field.")

    # OpenBot's description is its standing role text. Map it to Open Dots
    # instructions; do not copy unrelated source settings from agent_json.
    document = {
        "format": agent_package.FORMAT,
        "version": agent_package.VERSION,
        "agent": {"name": name, "title": title, "instructions": role_text},
    }
    try:
        parsed = agent_package.parse_package(document)
    except agent_package.PackageError as exc:
        raise OpenBotDatabaseImportError("An OpenBot agent profile exceeds Open Dots import limits.") from exc

    clean_agent: dict[str, str] = {"name": parsed["name"], "instructions": parsed["instructions"]}
    if parsed["title"]:
        clean_agent["title"] = parsed["title"]
    normalized = {"format": agent_package.FORMAT, "version": agent_package.VERSION, "agent": clean_agent}
    return {
        "key": source_id,
        "name": parsed["name"],
        "title": parsed["title"] or "",
        "instructions": parsed["instructions"],
        "document": normalized,
    }
