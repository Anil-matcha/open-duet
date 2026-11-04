#!/usr/bin/env python3
"""Validate marketplace manifests and the checked-in catalog index."""

import argparse
from datetime import date
import ipaddress
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
MARKETPLACE = ROOT / "marketplace"
SCHEMA_PATH = MARKETPLACE / "schema/plugin.schema.json"
FIXTURE_DIR = MARKETPLACE / "fixtures"
CATALOG_PATH = MARKETPLACE / "catalog.json"
EVIDENCE_PATH = MARKETPLACE / "plugins/tested/evidence.json"
MAX_FILE_BYTES = 32_000
MAX_DEPTH = 8
URL_FIELDS = ("source_repo", "endpoint", "privacy_url", "terms_url")
REQUIRED = {
    "slug", "name", "version", "summary", "publisher", "source_repo",
    "endpoint", "auth_mode", "privacy_url", "terms_url", "license",
    "setup_instructions", "test_instructions",
}
ALLOWED = REQUIRED
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
SECRET_PATTERNS = (
    re.compile(r"(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    re.compile(r"(?i)\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def fail(path, message):
    raise ValueError(f"{path}: {message}")


def read_json(path):
    if path.stat().st_size > MAX_FILE_BYTES:
        fail(path, f"file exceeds {MAX_FILE_BYTES} bytes")
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        fail(path, f"invalid JSON: {exc}")


def walk_strings(value, path, depth=0):
    if depth > MAX_DEPTH:
        fail(path, f"nesting exceeds {MAX_DEPTH} levels")
    if isinstance(value, str):
        if len(value) > 12_000:
            fail(path, "string exceeds 12000 characters")
        for pattern in SECRET_PATTERNS:
            if pattern.search(value):
                fail(path, "looks like it contains a credential or private key")
        if re.search(r"(?i)(?:^|\s)(?:#!/|(?:sh|bash|python|node|powershell)\s+-[ec]|curl\s+[^\n]*\|\s*(?:sh|bash))", value):
            fail(path, "executable commands are not allowed")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            walk_strings(item, f"{path}[{index}]", depth + 1)
    elif isinstance(value, dict):
        for key, item in value.items():
            walk_strings(key, f"{path}.<key>", depth + 1)
            walk_strings(item, f"{path}.{key}", depth + 1)


def validate_public_https(value, field, manifest_path, standard_port=False):
    try:
        parts = urlsplit(value)
        host = parts.hostname
        port = parts.port
    except ValueError as exc:
        fail(manifest_path, f"{field} is malformed: {exc}")
    if parts.scheme != "https" or not host or parts.username or parts.password:
        fail(manifest_path, f"{field} must be a public HTTPS URL without embedded credentials")
    if standard_port and port not in (None, 443):
        fail(manifest_path, f"{field} must use the standard HTTPS port")
    normalized = host.rstrip(".").lower()
    if normalized == "localhost" or normalized.endswith((".localhost", ".local", ".internal", ".test", ".invalid")):
        fail(manifest_path, f"{field} must not use a local or reserved hostname")
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        fail(manifest_path, f"{field} must not use a private or reserved IP address")
    if any(ord(char) < 0x21 or ord(char) == 0x7f for char in value):
        fail(manifest_path, f"{field} must not contain control characters or whitespace")
    if parts.fragment or (field == "endpoint" and parts.query):
        fail(manifest_path, f"{field} must not include a query or fragment")


def validate_manifest(path, *, community=False):
    data = read_json(path)
    if not isinstance(data, dict):
        fail(path, "top level must be a JSON object")
    unknown = set(data) - ALLOWED
    missing = REQUIRED - set(data)
    if unknown:
        fail(path, "unknown fields: " + ", ".join(sorted(unknown)))
    if missing:
        fail(path, "missing fields: " + ", ".join(sorted(missing)))
    if not isinstance(data["slug"], str) or not 2 <= len(data["slug"]) <= 64 or not SLUG.fullmatch(data["slug"]):
        fail(path, "slug must be a stable lowercase hyphenated identifier")
    if path.name != f"{data['slug']}.json":
        fail(path, "filename must be <slug>.json")
    if not isinstance(data["version"], str) or not VERSION.fullmatch(data["version"]):
        fail(path, "version must use MAJOR.MINOR.PATCH form")
    text_limits = {
        "name": 100, "summary": 500, "publisher": 120, "license": 80,
        "setup_instructions": 4000, "test_instructions": 4000,
    }
    for field, limit in text_limits.items():
        if not isinstance(data[field], str) or not data[field].strip() or len(data[field]) > limit:
            fail(path, f"{field} must be a non-empty string of at most {limit} characters")
    if len(data["version"]) > 64:
        fail(path, "version exceeds 64 characters")
    if data["auth_mode"] not in ("none", "bearer_token"):
        fail(path, "auth_mode must be none or bearer_token")
    for field in URL_FIELDS:
        if not isinstance(data[field], str) or len(data[field]) > 300:
            fail(path, f"{field} must be a URL string of at most 300 characters")
        validate_public_https(data[field], field, path, standard_port=(field == "endpoint"))
    if community and any(key.startswith("tested_") for key in data):
        fail(path, "community manifests cannot claim product test status")
    walk_strings(data, str(path))
    return data


def validate_schema_and_fixtures():
    schema = read_json(SCHEMA_PATH)
    if schema.get("additionalProperties") is not False:
        fail(SCHEMA_PATH, "schema must reject unknown fields")
    if set(schema.get("required", [])) != REQUIRED or set(schema.get("properties", {})) != ALLOWED:
        fail(SCHEMA_PATH, "schema fields do not match the validator contract")
    fixtures = sorted(FIXTURE_DIR.glob("*.json"))
    if not fixtures:
        fail(FIXTURE_DIR, "at least one JSON fixture is required")
    for fixture in fixtures:
        validate_manifest(fixture)


def catalog_paths():
    community = sorted(f"plugins/community/{p.name}" for p in (MARKETPLACE / "plugins/community").glob("*.json"))
    tested = sorted(
        f"plugins/tested/{p.name}"
        for p in (MARKETPLACE / "plugins/tested").glob("*.json")
        if p.name != "evidence.json"
    )
    return community, tested


def validate_catalog():
    catalog = read_json(CATALOG_PATH)
    community, tested = catalog_paths()
    expected = {"schema_version": 1, "community": community, "tested": tested}
    if catalog != expected:
        fail(CATALOG_PATH, "index is stale; run python3 scripts/update-marketplace-index.py")
    community_by_slug = {}
    for path_text in community:
        manifest = validate_manifest(MARKETPLACE / path_text, community=True)
        community_by_slug[manifest["slug"]] = manifest
    tested_by_slug = {}
    for path_text in tested:
        manifest = validate_manifest(MARKETPLACE / path_text)
        if manifest["slug"] in tested_by_slug:
            fail(CATALOG_PATH, "duplicate tested slug")
        tested_by_slug[manifest["slug"]] = manifest
    for slug in community_by_slug.keys() & tested_by_slug.keys():
        if community_by_slug[slug] != tested_by_slug[slug]:
            fail(CATALOG_PATH, f"{slug}: community and tested copies must have identical manifest content")
    evidence = read_json(EVIDENCE_PATH)
    if not isinstance(evidence, dict) or set(evidence) != set(tested_by_slug):
        fail(EVIDENCE_PATH, "evidence records must match tested catalog slugs exactly")
    for slug, record in evidence.items():
        if not isinstance(record, dict) or set(record) != {"version", "tested_on", "evidence_url"}:
            fail(EVIDENCE_PATH, f"{slug}: evidence requires version, tested_on, and evidence_url")
        if record["version"] != tested_by_slug[slug]["version"]:
            fail(EVIDENCE_PATH, f"{slug}: evidence version must match the tested manifest version")
        if not isinstance(record["tested_on"], str):
            fail(EVIDENCE_PATH, f"{slug}: tested_on must be YYYY-MM-DD")
        try:
            date.fromisoformat(record["tested_on"])
        except ValueError:
            fail(EVIDENCE_PATH, f"{slug}: tested_on must be a valid YYYY-MM-DD date")
        if not isinstance(record["evidence_url"], str) or len(record["evidence_url"]) > 300:
            fail(EVIDENCE_PATH, f"{slug}: evidence_url must be at most 300 characters")
        validate_public_https(record["evidence_url"], "evidence_url", EVIDENCE_PATH)
        walk_strings(record, f"{EVIDENCE_PATH}.{slug}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--changed", nargs="*", default=[])
    args = parser.parse_args()
    try:
        validate_schema_and_fixtures()
        validate_catalog()
        for name in args.changed:
            path = (ROOT / name).resolve()
            if not path.is_relative_to(ROOT):
                fail(name, "changed path escapes the repository")
            relative = path.relative_to(ROOT).as_posix()
            is_listing = relative.startswith(("marketplace/plugins/community/", "marketplace/plugins/tested/")) and path.suffix == ".json"
            is_evidence = relative == "marketplace/plugins/tested/evidence.json"
            if not is_listing and not is_evidence:
                continue
            if path.exists() and is_listing and not is_evidence:
                validate_manifest(path, community=relative.startswith("marketplace/plugins/community/"))
            elif path.exists() and is_evidence:
                read_json(path)
    except (OSError, ValueError) as exc:
        print(f"Marketplace validation failed: {exc}", file=sys.stderr)
        return 1
    print("Marketplace schema, fixtures, catalog, and changed listings are valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
