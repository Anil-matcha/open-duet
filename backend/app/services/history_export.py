"""A portable copy of one owner's local history: agents, conversations and
attachment metadata, as a ZIP of JSON files.

What it leaves out on purpose: engine credentials and sign-in state, the desktop
device token, adapter session ids and private provider state, approval records,
and the attachment files themselves (only their name, type, size and hash).
Entry names are built from integer ids and fixed words, never from stored text,
so nothing a conversation contains can name a path.
"""

import asyncio
import json
import re
import tempfile
import zipfile
from datetime import date, datetime
from pathlib import Path
from typing import IO

from sqlalchemy import select

from app.db.models import Agent, Thread
from app.services import attachments
from app.services import thread_store as store

FORMAT_VERSION = 1
MAX_BYTES = 256 * 1024 * 1024  # uncompressed JSON written into one export
MAX_SECONDS = 120
MAX_ATTACHMENT_ENTRIES = 5000

AGENT_FIELDS = (
    "id", "name", "title", "description", "instructions", "provider", "model",
    "fallback_provider", "fallback_model", "workspace_path", "approval_mode",
    "memory_enabled", "recall_enabled", "memory_upkeep", "compaction_summary",
    "use_helper", "connector_scopes", "connector_account_scopes", "pinned", "team_id", "delegation_enabled",
    "created_by_agent_id", "archived_at", "created_at", "updated_at",
)
THREAD_FIELDS = (
    "id", "title", "provider", "model", "workspace_path", "agent_id", "kind",
    "job_id", "room_id", "last_seq", "archived_at", "created_at", "updated_at",
)
_ATTACHMENT_META = re.compile(r"^[0-9a-f]{32}\.json$")

_lock = asyncio.Lock()


class ExportError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _plain(value):
    return value.isoformat() if isinstance(value, datetime) else value


def _row(obj, fields: tuple[str, ...]) -> dict:
    return {name: _plain(getattr(obj, name, None)) for name in fields}


class _Writer:
    def __init__(self, archive: zipfile.ZipFile) -> None:
        self.archive = archive
        self.total = 0

    def add(self, name: str, text: str) -> None:
        data = text.encode("utf-8")
        self.total += len(data)
        if self.total > MAX_BYTES:
            raise ExportError(413, "export_too_large", "Your history is too large to export in one file.")
        self.archive.writestr(name, data)


def _attachment_metadata(thread_id: int) -> list[dict]:
    folder = attachments.thread_dir(thread_id)
    found: list[dict] = []
    try:
        if folder.is_symlink() or not folder.is_dir():
            return found
        entries = sorted(folder.iterdir())
    except OSError:
        return found
    for path in entries:
        if not _ATTACHMENT_META.match(path.name) or path.is_symlink() or not path.is_file():
            continue
        try:
            meta = json.loads(path.read_text(encoding="utf-8"))
            found.append({key: meta[key] for key in ("id", "name", "mime", "bytes", "kind", "sha256")})
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if len(found) >= MAX_ATTACHMENT_ENTRIES:
            break
    return found


async def _build(rt, handle: IO[bytes]) -> dict:
    with zipfile.ZipFile(handle, "w", zipfile.ZIP_DEFLATED) as archive:
        out = _Writer(archive)
        async with rt.session() as db:
            agents = list((await db.execute(
                select(Agent).where(Agent.owner_id == rt.owner_id).order_by(Agent.id)
            )).scalars())
            threads = list((await db.execute(
                select(Thread).where(Thread.owner_id == rt.owner_id).order_by(Thread.id)
            )).scalars())
            out.add("agents.json", json.dumps([_row(a, AGENT_FIELDS) for a in agents], indent=1))
            out.add("threads.json", json.dumps([_row(t, THREAD_FIELDS) for t in threads], indent=1))
            event_count = attachment_count = 0
            for thread in threads:
                lines = []
                for event in await store.list_all_events(db, thread.id):
                    lines.append(json.dumps({
                        "seq": event.seq, "turn_id": event.turn_id, "type": event.type,
                        "data": event.data, "created_at": _plain(event.created_at),
                    }, separators=(",", ":")))
                event_count += len(lines)
                out.add(f"threads/{int(thread.id)}/events.ndjson", "\n".join(lines) + ("\n" if lines else ""))
                files = _attachment_metadata(thread.id)
                attachment_count += len(files)
                if files:
                    out.add(f"threads/{int(thread.id)}/attachments.json", json.dumps(files, indent=1))
        manifest = {
            "format": "open-dots-history", "version": FORMAT_VERSION,
            "exported_at": datetime.now().astimezone().isoformat(),
            "counts": {"agents": len(agents), "threads": len(threads),
                       "events": event_count, "attachments": attachment_count},
            "excludes": ["engine credentials", "account device token", "provider session state",
                         "approval records", "attachment file contents"],
        }
        out.add("manifest.json", json.dumps(manifest, indent=1))
    return manifest["counts"]


async def build_export(rt) -> tuple[IO[bytes], int, str]:
    """Write the export to a private temporary file. Returns (file at start,
    size, download name). The caller closes the file, which deletes it."""
    if _lock.locked():
        raise ExportError(429, "export_running", "An export is already running. Try again in a moment.")
    async with _lock:
        handle = tempfile.TemporaryFile()
        try:
            async with asyncio.timeout(MAX_SECONDS):
                await _build(rt, handle)
        except TimeoutError:
            handle.close()
            raise ExportError(504, "export_timeout", "The export took too long. Try again.") from None
        except BaseException:
            handle.close()
            raise
        size = handle.tell()
        handle.seek(0)
        return handle, size, f"open-dots-history-{date.today().isoformat()}.zip"
