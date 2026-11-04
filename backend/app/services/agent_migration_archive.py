"""Bounded, in-memory previews of portable agent migration manifests.

Archives carry one root JSON document and optional portable profile text.
Every profile is validated through the native agent package parser before any
preview is returned. Nothing is extracted or written to the local workspace.
"""

import io
import json
import re
import stat
import struct
import unicodedata
import zipfile
import zlib
from typing import Any

from app.schemas.agent import INSTRUCTIONS_MAX_BYTES
from app.services import agent_package, agent_skills
from app.services.agent_memory import FILE_MAX_BYTES, redact_secrets

FORMAT = "open-dots.agent-migration"
VERSION = 1
MAX_SOURCE_BYTES = 10_000_000
MAX_MANIFEST_BYTES = 10_000_000
MAX_PROFILES = 20
MAX_JSON_DEPTH = 32
MAX_JSON_SEPARATORS = 50_000
MAX_SUMMARY_FIELDS = 100
MAX_ARCHIVE_MEMBERS = 512
MAX_EXPANDED_BYTES = 20_000_000
MAX_OPAQUE_FORMAT_BYTES = 200
MAX_PORTABLE_SKILLS = 32
MAX_PORTABLE_MEMORIES = 64
MAX_PORTABLE_CHANNELS = 100
MAX_MEMORY_CHARACTERS = 500
_PROFILE_KEY = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\Z")
_SOURCE_APPS = {"grok-bot": "grok", "hermes-agent": "hermes"}
_INSTRUCTION_FILES = ("INSTRUCTIONS.md", "SOUL.md")


class MigrationArchiveError(ValueError):
    pass


def _pairs(pairs: list[tuple[str, Any]]) -> dict:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise MigrationArchiveError("JSON object members must not be repeated.")
        out[key] = value
    return out


def _constant(value: str) -> None:
    raise MigrationArchiveError("The manifest must contain standard JSON values.")


def _check_json_structure(data: bytes) -> None:
    # Check depth before the JSON decoder allocates nested Python containers.
    depth = separators = 0
    quoted = escaped = False
    for byte in data:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise MigrationArchiveError("The manifest JSON is nested too deeply.")
        elif byte in (93, 125):
            depth -= 1
        elif byte in (44, 58):
            separators += 1
            if separators > MAX_JSON_SEPARATORS:
                raise MigrationArchiveError("The manifest has too many JSON members.")


def _safe_path(value: Any, *, directory: bool = False) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 1024:
        raise MigrationArchiveError("The package contains an invalid path.")
    path = value[:-1] if directory and value.endswith("/") else value
    if "\\" in path or ":" in path or any(unicodedata.category(ch).startswith("C") for ch in path):
        raise MigrationArchiveError("The package contains an unsafe path.")
    parts = path.split("/")
    if any(not part or part in (".", "..") or part.endswith((".", " ")) for part in parts):
        raise MigrationArchiveError("The package contains an unsafe path.")
    if any(len(part) > 128 for part in parts):
        raise MigrationArchiveError("The package contains an invalid path.")
    return path


def _zip_directory(data: bytes) -> int:
    """Bound and walk the central directory before ZipFile allocates members."""
    end = data.rfind(b"PK\x05\x06", max(0, len(data) - 65557))
    if end < 0 or len(data) - end < 22:
        raise MigrationArchiveError("The migration ZIP directory is malformed.")
    record = struct.unpack_from("<4s4H2IH", data, end)
    _, disk, directory_disk, local_count, count, size, offset, comment_size = record
    if disk or directory_disk or local_count != count or not 1 <= count <= MAX_ARCHIVE_MEMBERS:
        raise MigrationArchiveError("The migration ZIP must contain at most 512 members on one disk.")
    if end + 22 + comment_size != len(data) or offset + size != end:
        raise MigrationArchiveError("The migration ZIP directory is malformed or unsupported.")
    cursor = offset
    actual = 0
    while cursor < end:
        if cursor + 46 > end or actual >= MAX_ARCHIVE_MEMBERS:
            raise MigrationArchiveError("The migration ZIP directory is malformed.")
        header = struct.unpack_from("<4s6H3I5H2I", data, cursor)
        if header[0] != b"PK\x01\x02" or header[13]:
            raise MigrationArchiveError("The migration ZIP directory is malformed.")
        cursor += 46 + header[10] + header[11] + header[12]
        actual += 1
    if cursor != end or actual != count:
        raise MigrationArchiveError("The migration ZIP member count is inconsistent.")
    return offset


def _zip_members(data: bytes, archive: zipfile.ZipFile, directory_start: int) -> tuple[dict[str, zipfile.ZipInfo], dict[zipfile.ZipInfo, tuple[int, int]]]:
    members = archive.infolist()
    if not 1 <= len(members) <= MAX_ARCHIVE_MEMBERS or archive.start_dir != directory_start:
        raise MigrationArchiveError("The migration ZIP directory is inconsistent.")
    files: dict[str, zipfile.ZipInfo] = {}
    paths: dict[str, bool] = {}
    expanded = 0
    for member in members:
        is_directory = member.is_dir()
        path = _safe_path(member.filename, directory=is_directory)
        if member.orig_filename != member.filename:
            raise MigrationArchiveError("The ZIP contains an aliased member name.")
        mode = stat.S_IFMT(member.external_attr >> 16)
        if mode not in ((0, stat.S_IFDIR) if is_directory else (0, stat.S_IFREG)):
            raise MigrationArchiveError("ZIP members must be regular files or directory markers.")
        if not is_directory and member.external_attr & 0x10:
            raise MigrationArchiveError("The ZIP contains an inconsistent directory marker.")
        if is_directory and (member.file_size or member.compress_size or member.CRC):
            raise MigrationArchiveError("ZIP directory markers must be empty.")
        if member.flag_bits & (1 | 0x40 | 0x2000):
            raise MigrationArchiveError("Encrypted migration ZIPs are not supported.")
        if member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise MigrationArchiveError("The ZIP must use stored or deflated compression.")
        expanded += member.file_size
        if member.file_size > MAX_EXPANDED_BYTES or expanded > MAX_EXPANDED_BYTES:
            raise MigrationArchiveError("The migration ZIP expands beyond 20 MB.")
        canonical = unicodedata.normalize("NFC", path).casefold()
        parents = [canonical.rsplit("/", i)[0] for i in range(1, canonical.count("/") + 1)]
        if canonical in paths or any(parent in paths and not paths[parent] for parent in parents):
            raise MigrationArchiveError("The ZIP contains duplicate or colliding paths.")
        if not is_directory and any(known.startswith(canonical + "/") for known in paths):
            raise MigrationArchiveError("The ZIP contains colliding file and directory paths.")
        paths[canonical] = is_directory
        parts = path.split("/")
        if len(parts) == 1:
            if is_directory and path != "agents":
                raise MigrationArchiveError("The ZIP contains an unexpected root directory.")
            if not is_directory and not path.lower().endswith(".json"):
                raise MigrationArchiveError("The ZIP contains an unexpected root file.")
        elif parts[0] != "agents" or not _PROFILE_KEY.fullmatch(parts[1]):
            raise MigrationArchiveError("Profile files must stay inside their own package subtree.")
        if not is_directory:
            if len(parts) == 2:
                raise MigrationArchiveError("The ZIP contains an invalid profile subtree.")
            files[path] = member

    # Every local record must occupy its own exact range. This catches hidden
    # local members, prefixes, duplicate offsets, gaps and overlapping payloads
    # without inflating even a skipped file.
    payloads: dict[zipfile.ZipInfo, tuple[int, int]] = {}
    ordered = sorted(members, key=lambda item: item.header_offset)
    cursor = 0
    for index, member in enumerate(ordered):
        if member.header_offset != cursor or cursor + 30 > directory_start:
            raise MigrationArchiveError("The ZIP contains overlapping or unexpected local records.")
        header = struct.unpack_from("<4s5H3I2H", data, cursor)
        if header[0] != b"PK\x03\x04" or header[2] != member.flag_bits or header[3] != member.compress_type:
            raise MigrationArchiveError("The ZIP member headers disagree.")
        start = cursor + 30 + header[-2] + header[-1]
        end = start + member.compress_size
        next_start = ordered[index + 1].header_offset if index + 1 < len(ordered) else directory_start
        if start > end or end > next_start:
            raise MigrationArchiveError("The ZIP contains overlapping payloads.")
        encoding = "utf-8" if member.flag_bits & 0x800 else "cp437"
        if data[cursor + 30:cursor + 30 + header[-2]].decode(encoding) != member.filename:
            raise MigrationArchiveError("The ZIP member names disagree.")
        trailer = data[end:next_start]
        if member.flag_bits & 8:
            if trailer.startswith(b"PK\x07\x08"):
                trailer = trailer[4:]
            if len(trailer) != 12 or struct.unpack("<3I", trailer) != (member.CRC, member.compress_size, member.file_size):
                raise MigrationArchiveError("The ZIP member descriptor is malformed.")
        elif trailer or header[6:9] != (member.CRC, member.compress_size, member.file_size):
            raise MigrationArchiveError("The ZIP member sizes or checksums disagree.")
        payloads[member] = (start, end)
        cursor = next_start
    return files, payloads


def _read_member(data: bytes, archive: zipfile.ZipFile, member: zipfile.ZipInfo, payloads: dict, limit: int) -> bytes:
    if member.file_size > limit:
        raise MigrationArchiveError("Selected package text exceeds its size limit.")
    start, end = payloads[member]
    payload = data[start:end]
    if member.compress_type == zipfile.ZIP_DEFLATED:
        decoder = zlib.decompressobj(-zlib.MAX_WBITS)
        checked = decoder.decompress(payload, member.file_size + 1)
        if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
            raise MigrationArchiveError("Selected ZIP text is malformed or exceeds its declared size.")
    else:
        checked = payload
    if len(checked) != member.file_size or zlib.crc32(checked) != member.CRC:
        raise MigrationArchiveError("Selected ZIP text has an invalid size or checksum.")
    # Use the validated ZipInfo, never a second lookup by a source-supplied name.
    with archive.open(member) as handle:
        content = handle.read(limit + 1)
    if content != checked:
        raise MigrationArchiveError("Selected ZIP text does not match its directory entry.")
    return content


def _summary_add(items: list[str], value: str) -> None:
    if len(items) < MAX_SUMMARY_FIELDS:
        items.append(redact_secrets(value)[0][:240])
    elif len(items) == MAX_SUMMARY_FIELDS:
        items.append("Additional fields were omitted from this summary.")


def _skipped(document: dict) -> list[str]:
    out: list[str] = []
    for key in document.keys() - {"format", "version", "exported_at", "agent", "notes", "skills"}:
        _summary_add(out, str(key))
    for key in document["agent"].keys() - {"name", "title", "description", "instructions"}:
        _summary_add(out, f"agent.{key}")
    notes = document.get("notes")
    if isinstance(notes, dict):
        for key in notes.keys() - {"MEMORY.md", "topics"}:
            _summary_add(out, f"notes.{key}")
    for index, skill in enumerate(document.get("skills") or []):
        for key in skill.keys() - {"name", "description", "body"}:
            _summary_add(out, f"skills[{index}].{key}")
    return sorted(out)


def _normalize(document: Any, index: int) -> dict:
    try:
        if not isinstance(document, dict) or type(document.get("version")) is not int:
            raise agent_package.PackageError("Each profile must be a native versioned agent document.")
        parsed = agent_package.parse_package(document)
        clean: dict[str, Any] = {"format": agent_package.FORMAT, "version": agent_package.VERSION, "agent": {}}
        redacted: list[str] = []

        def text(value: str, raw: str, path: str) -> str:
            result, _ = redact_secrets(value)
            if redact_secrets(raw)[1]:
                _summary_add(redacted, path)
            return result

        for field in ("name", "title", "description", "instructions"):
            value = parsed[field]
            if value is not None:
                clean["agent"][field] = text(value, document["agent"].get(field) or "", f"agent.{field}")
        raw_notes = document.get("notes") or {}
        if parsed["notes"]:
            clean["notes"] = {"MEMORY.md": text(parsed["notes"], raw_notes["MEMORY.md"], "notes.MEMORY.md")}
        if parsed["topics"]:
            clean.setdefault("notes", {})["topics"] = {
                name: text(value, raw_notes["topics"][name], f"notes.topics.{name}")
                for name, value in parsed["topics"].items()
            }
        if parsed["skills"]:
            clean["skills"] = [
                {
                    "name": item["name"],
                    "description": text(item["description"], document["skills"][i]["description"], f"skills[{i}].description"),
                    "body": text(item["body"], document["skills"][i]["body"], f"skills[{i}].body"),
                }
                for i, item in enumerate(parsed["skills"])
            ]
        # Redaction can change lengths; the returned file must itself import.
        agent_package.parse_package(clean)
        return {
            "key": f"profile-{index + 1}",
            "name": clean["agent"]["name"],
            "title": clean["agent"].get("title"),
            "document": clean,
            "skipped": _skipped(document),
            "redacted": redacted,
        }
    except (agent_package.PackageError, UnicodeError, ValueError, TypeError, OverflowError) as exc:
        message = redact_secrets(str(exc))[0][:500]
        raise MigrationArchiveError(f"Profile {index + 1}: {message}") from None


def _load_document(manifest: bytes) -> Any:
    if len(manifest) > MAX_MANIFEST_BYTES:
        raise MigrationArchiveError("The manifest is larger than 10 MB.")
    _check_json_structure(manifest)
    try:
        document = json.loads(manifest.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_constant)
        # Reject escaped unpaired surrogates and overflowing JSON floats, too.
        json.dumps(document, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (UnicodeError, ValueError, RecursionError, OverflowError) as exc:
        if isinstance(exc, MigrationArchiveError):
            raise
        raise MigrationArchiveError("The manifest must be valid UTF-8 JSON.") from None
    return document


def _agents(document: dict) -> list:
    if type(document.get("version")) is not int or document["version"] != VERSION:
        raise MigrationArchiveError("This app reads migration manifest version 1.")
    agents = document.get("agents")
    if not isinstance(agents, list) or not 1 <= len(agents) <= MAX_PROFILES:
        raise MigrationArchiveError("The manifest must contain between 1 and 20 agent profiles.")
    return agents


def _custom_preview(document: dict) -> dict:
    agents = _agents(document)
    if document.get("source") not in ("grok", "hermes"):
        raise MigrationArchiveError("The migration source must be grok or hermes.")
    skipped: list[str] = []
    for key in sorted(document.keys() - {"format", "version", "source", "agents"}):
        _summary_add(skipped, str(key))
    return {
        "format": FORMAT,
        "version": VERSION,
        "source": document["source"],
        "profiles": [_normalize(agent, index) for index, agent in enumerate(agents)],
        "skipped": skipped,
    }


def _profile_reference(value: Any, key: str, *, folder: bool = False) -> str | None:
    if value is None:
        return None
    path = _safe_path(value, directory=folder)
    if not path.startswith(f"agents/{key}/"):
        raise MigrationArchiveError("A profile reference leaves its own package subtree.")
    return path


def _portable_skill(data: bytes, archive: zipfile.ZipFile, files: dict, payloads: dict, folder: str, number: int, skipped: list[str], redacted: list[str]) -> dict | None:
    # Supporting files can change the meaning of a skill. Only a standalone
    # Markdown procedure is portable; nothing else in its folder is inflated.
    contents = [path for path in files if path.startswith(folder + "/")]
    member = files.get(folder + "/" + agent_skills.SKILL_FILE)
    label = f"Skill {number}"
    if member is None or len(contents) != 1:
        _summary_add(skipped, f"{label} was omitted because it is missing or needs supporting files.")
        return None
    if member.file_size > agent_skills.FILE_MAX_BYTES:
        _summary_add(skipped, f"{label} was omitted because its text exceeds the skill size limit.")
        return None
    content = _read_member(data, archive, member, payloads, agent_skills.FILE_MAX_BYTES)
    try:
        markdown = content.decode("utf-8")
        preview = agent_skills.preview(markdown)
        item = {field: preview[field] for field in ("name", "description", "body")}
        agent_package.parse_package({
            "format": agent_package.FORMAT,
            "version": agent_package.VERSION,
            "agent": {"name": "Imported agent"},
            "skills": [item],
        })
        if redact_secrets(markdown)[1]:
            _summary_add(redacted, f"{label} text")
        return item
    except (UnicodeError, agent_skills.SkillError, agent_package.PackageError):
        _summary_add(skipped, f"{label} was omitted because its text is not a valid standalone skill.")
        return None


def _portable_profile(value: Any, index: int, source: str, data: bytes | None, archive: zipfile.ZipFile | None, files: dict, payloads: dict) -> dict:
    if not isinstance(value, dict):
        raise MigrationArchiveError(f"Profile {index + 1} must be an object.")
    key = value.get("key")
    if not isinstance(key, str) or not _PROFILE_KEY.fullmatch(key):
        raise MigrationArchiveError(f"Profile {index + 1} has an invalid key.")
    description = value.get("description")
    if not isinstance(description, str) or len(description.encode("utf-8")) > INSTRUCTIONS_MAX_BYTES:
        raise MigrationArchiveError(f"Profile {index + 1} needs instructions within the native size limit.")
    skipped: list[str] = []
    redacted: list[str] = []
    imported_files: set[str] = set()
    instructions = description
    expected_files_folder = f"agents/{key}/files"
    files_reference = value.get("files")
    files_folder = expected_files_folder if files_reference in (expected_files_folder, expected_files_folder + "/") else None
    if files_reference is not None and files_folder is None:
        _summary_add(skipped, "The workspace file reference was skipped; only the profile description was imported.")
    avatar = _profile_reference(value.get("avatar"), key)
    if avatar:
        _summary_add(skipped, "Avatar images are not imported.")
    routines = value.get("routines", [])
    if not isinstance(routines, list):
        raise MigrationArchiveError(f"Profile {index + 1} has an invalid routine list.")
    if routines:
        _summary_add(skipped, "Routines are not imported.")
    if files_folder:
        preferred = _INSTRUCTION_FILES if source == "grok" else tuple(reversed(_INSTRUCTION_FILES))
        full = next((files[files_folder + "/" + name] for name in preferred if files_folder + "/" + name in files), None)
        if full is None or archive is None or data is None:
            _summary_add(skipped, "Full instructions were unavailable; only the profile description was imported.")
        elif full.file_size > INSTRUCTIONS_MAX_BYTES:
            _summary_add(skipped, "Full instructions exceeded 24 KB; only the profile description was imported.")
        else:
            content = _read_member(data, archive, full, payloads, INSTRUCTIONS_MAX_BYTES)
            try:
                text = content.decode("utf-8")
            except UnicodeError:
                text = ""
            if text.strip():
                instructions = text
                imported_files.add(full.filename)
            else:
                _summary_add(skipped, "Full instructions were empty or unreadable; only the profile description was imported.")
    elif any(name in description for name in _INSTRUCTION_FILES):
        _summary_add(skipped, "Full instructions were unavailable; only the profile description was imported.")

    skills = value.get("skills", [])
    if not isinstance(skills, list) or len(skills) > MAX_PORTABLE_SKILLS:
        raise MigrationArchiveError(f"Profile {index + 1} must list at most 32 skill folders.")
    native_skills: list[dict] = []
    references: set[str] = set()
    names: set[str] = set()
    total_skill_bytes = 0
    for skill_index, candidate in enumerate(skills):
        folder = _profile_reference(candidate, key, folder=True)
        if folder is None or not folder.startswith(f"agents/{key}/skills/") or folder.count("/") != 3:
            raise MigrationArchiveError(f"Profile {index + 1} has an invalid skill folder reference.")
        canonical = unicodedata.normalize("NFC", folder).casefold()
        if canonical in references:
            raise MigrationArchiveError(f"Profile {index + 1} repeats a skill folder reference.")
        references.add(canonical)
        if archive is None or data is None:
            _summary_add(skipped, f"Skill {skill_index + 1} was omitted because its text was not included.")
            continue
        item = _portable_skill(data, archive, files, payloads, folder, skill_index + 1, skipped, redacted)
        if item is None:
            continue
        size = len(item["body"].encode("utf-8"))
        if item["name"] in names or len(native_skills) >= agent_skills.MAX_SKILLS or total_skill_bytes + size > agent_package.SKILLS_MAX_BYTES:
            _summary_add(skipped, f"Skill {skill_index + 1} was omitted because its name collides or the native skill limits were reached.")
            continue
        names.add(item["name"])
        native_skills.append(item)
        total_skill_bytes += size
        imported_files.add(folder + "/" + agent_skills.SKILL_FILE)

    if any(path.startswith(f"agents/{key}/") and path not in imported_files for path in files):
        _summary_add(skipped, "Other profile files are not imported.")

    memories = value.get("memories", [])
    if not isinstance(memories, list) or len(memories) > MAX_PORTABLE_MEMORIES:
        raise MigrationArchiveError(f"Profile {index + 1} must contain at most 64 short memories.")
    if any(not isinstance(memory, str) or len(memory) > MAX_MEMORY_CHARACTERS for memory in memories):
        raise MigrationArchiveError(f"Profile {index + 1} has an invalid or oversized memory.")
    notes = "\n".join("- " + memory.replace("\r\n", "\n").replace("\n", " ").strip() for memory in memories if memory.strip())
    if len(notes.encode("utf-8")) > FILE_MAX_BYTES:
        raise MigrationArchiveError(f"Profile {index + 1} memories exceed the native notes size limit.")
    native = {
        "format": agent_package.FORMAT,
        "version": agent_package.VERSION,
        "agent": {"name": value.get("name"), "title": value.get("title"), "instructions": instructions},
    }
    if notes:
        native["notes"] = {"MEMORY.md": notes}
    if native_skills:
        native["skills"] = native_skills
    try:
        profile = _normalize(native, index)
    except MigrationArchiveError:
        # Native errors can quote a source field. Keep portable-package errors
        # limited to profile numbers and never disclose archive metadata.
        raise MigrationArchiveError(f"Profile {index + 1} cannot fit the native agent field limits.") from None
    if value.keys() - {"key", "name", "title", "description", "avatar", "skills", "files", "routines", "memories"}:
        _summary_add(skipped, "Additional profile settings are not imported.")
    profile["skipped"] = skipped
    profile["redacted"].extend(redacted)
    return profile


def _portable_preview(document: dict, data: bytes | None = None, archive: zipfile.ZipFile | None = None, files: dict | None = None, payloads: dict | None = None) -> dict:
    agents = _agents(document)
    marker = document.get("format")
    if not isinstance(marker, str) or not marker.strip() or len(marker.encode("utf-8")) > MAX_OPAQUE_FORMAT_BYTES:
        raise MigrationArchiveError("The portable package needs a bounded nonempty format field.")
    source = document.get("source")
    if not isinstance(source, dict) or not isinstance(source.get("app"), str) or source["app"] not in _SOURCE_APPS:
        raise MigrationArchiveError("The portable package source is unsupported.")
    source_name = _SOURCE_APPS[source["app"]]
    keys = [agent.get("key") if isinstance(agent, dict) else None for agent in agents]
    if any(not isinstance(key, str) or not _PROFILE_KEY.fullmatch(key) for key in keys) or len(set(keys)) != len(keys):
        raise MigrationArchiveError("Portable package profiles must have unique valid keys.")
    if archive is not None:
        for member in archive.infolist():
            parts = member.filename.rstrip("/").split("/")
            if len(parts) > 1 and parts[0] == "agents" and parts[1] not in keys:
                raise MigrationArchiveError("The ZIP contains an unknown profile subtree.")
    skipped: list[str] = []
    channels = document.get("channels", [])
    if not isinstance(channels, list) or len(channels) > MAX_PORTABLE_CHANNELS:
        raise MigrationArchiveError("The portable package must list at most 100 shared channels.")
    if channels:
        _summary_add(skipped, "Shared channels and their settings are not imported.")
    if document.keys() - {"format", "version", "source", "agents", "channels"}:
        _summary_add(skipped, "Additional package settings are not imported.")
    return {
        "format": FORMAT,
        "version": VERSION,
        "source": source_name,
        "profiles": [
            _portable_profile(agent, index, source_name, data, archive, files or {}, payloads or {})
            for index, agent in enumerate(agents)
        ],
        "skipped": skipped,
    }


def preview_archive(data: bytes) -> dict:
    if not data or len(data) > MAX_SOURCE_BYTES:
        raise MigrationArchiveError("The migration file must be nonempty and at most 10 MB.")
    if not data.startswith(b"PK"):
        document = _load_document(data)
        if not isinstance(document, dict):
            raise MigrationArchiveError("This is not a migration manifest.")
        return _custom_preview(document) if document.get("format") == FORMAT else _portable_preview(document)
    try:
        directory_start = _zip_directory(data)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            files, payloads = _zip_members(data, archive, directory_start)
            candidates = [member for path, member in files.items() if "/" not in path and path.lower().endswith(".json")]
            if len(candidates) != 1:
                raise MigrationArchiveError("The migration ZIP needs exactly one root JSON document.")
            candidate = candidates[0]
            document = _load_document(_read_member(data, archive, candidate, payloads, MAX_MANIFEST_BYTES))
            if not isinstance(document, dict):
                raise MigrationArchiveError("This is not a migration manifest.")
            if document.get("format") == FORMAT:
                if len(archive.infolist()) != 1 or candidate.filename != "manifest.json":
                    raise MigrationArchiveError("A native migration ZIP must contain only its root manifest.")
                return _custom_preview(document)
            return _portable_preview(document, data, archive, files, payloads)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, EOFError, OSError, RuntimeError, NotImplementedError, struct.error, zlib.error, UnicodeError):
        raise MigrationArchiveError("The migration ZIP is malformed or unsupported.") from None
