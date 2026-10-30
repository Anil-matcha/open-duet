"""GitHub-backed marketplace metadata and a bounded remote Streamable HTTP MCP client.

Marketplace services never execute code from a listing. Remote tool traffic stays
in the local backend; engine processes receive only the local stdio mailbox shim.
"""

from __future__ import annotations

import asyncio
from datetime import date
import hashlib
import ipaddress
import json
import re
import socket
import ssl
import sys
import time
import weakref
from pathlib import Path
from urllib.parse import urlsplit

import httpcore
import httpx
from httpcore._backends.anyio import AnyIOBackend

GITHUB_RAW = "https://raw.githubusercontent.com/Anil-matcha/open-duet/main/marketplace/"
MAX_CATALOG_BYTES = 128_000
MAX_MANIFEST_BYTES = 32_000
MAX_SCHEMA_BYTES = 64_000
MAX_RESULT_BYTES = 1_000_000
MAX_REQUEST_BYTES = 64_000
MAX_TOOLS = 100
MAX_TOOLSET_BYTES = 512_000
MAX_PAGES = 20
MAX_DEPTH = 8
CATALOG_TTL_SECONDS = 300
SUPPORTED_PROTOCOLS = {"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}
SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_catalog_cache: tuple[float, dict] | None = None
_connection_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()
_agent_grant_locks: weakref.WeakValueDictionary[int, asyncio.Lock] = weakref.WeakValueDictionary()


def connection_lock(slug: str) -> asyncio.Lock:
    """Serialize one installed service's calls with local revoke/update actions."""
    lock = _connection_locks.get(slug)
    if lock is None:
        lock = asyncio.Lock()
        _connection_locks[slug] = lock
    return lock


def agent_grant_lock(agent_id: int) -> asyncio.Lock:
    """Serialize grant replacements so concurrent integrations share one limit."""
    lock = _agent_grant_locks.get(agent_id)
    if lock is None:
        lock = asyncio.Lock()
        _agent_grant_locks[agent_id] = lock
    return lock


class McpError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.status = status


def canonical(value: object) -> str:
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise McpError("invalid_json", "The supplied value is not valid JSON.", 422) from None


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _json_bytes(data: bytes, *, limit: int, source: str):
    if len(data) > limit:
        raise McpError("response_too_large", f"The {source} is too large.", 502)
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object, parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise McpError("invalid_response", f"The {source} was not valid JSON.", 502) from None
    return value


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value):
    raise ValueError("non-standard JSON number")


def _marketplace_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "marketplace"
    return Path(__file__).resolve().parents[2] / "marketplace"


def _validate_manifest(value: object, *, section: str, path: str) -> dict:
    required = {
        "slug", "name", "version", "summary", "publisher", "source_repo", "endpoint",
        "auth_mode", "privacy_url", "terms_url", "license", "setup_instructions", "test_instructions",
    }
    allowed = required
    if not isinstance(value, dict) or set(value) - allowed or required - set(value):
        raise McpError("invalid_catalog", f"Marketplace listing {path} has an invalid shape.", 502)
    slug = value.get("slug")
    if (not isinstance(slug, str) or not 2 <= len(slug) <= 64 or not SLUG.fullmatch(slug)
            or path.rsplit("/", 1)[-1] != f"{slug}.json"):
        raise McpError("invalid_catalog", f"Marketplace listing {path} has an invalid identifier.", 502)
    if (not isinstance(value.get("version"), str) or len(value["version"]) > 64
            or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", value["version"])):
        raise McpError("invalid_catalog", f"Marketplace listing {path} has an invalid version.", 502)
    text_limits = {
        "name": 100, "summary": 500, "publisher": 120, "license": 80,
        "setup_instructions": 4000, "test_instructions": 4000,
    }
    for key, limit in text_limits.items():
        item = value.get(key)
        if not isinstance(item, str) or not item.strip() or len(item) > limit:
            raise McpError("invalid_catalog", f"Marketplace listing {path} has invalid text.", 502)
    if value.get("auth_mode") not in ("none", "bearer_token"):
        raise McpError("invalid_catalog", f"Marketplace listing {path} uses unsupported authentication.", 502)
    for field in ("source_repo", "endpoint", "privacy_url", "terms_url"):
        _validate_public_url(value.get(field), field, require_standard_port=(field == "endpoint"), max_length=300)
    if section == "community" and any(key.startswith("tested_") for key in value):
        raise McpError("invalid_catalog", "A community listing cannot claim Open Dots testing.", 502)
    return dict(value)


def _validate_public_url(
    raw: object, field: str, *, require_standard_port: bool = False, max_length: int = 1000,
) -> tuple[str, str, int]:
    if (not isinstance(raw, str) or len(raw) > max_length
            or any(ord(char) < 0x21 or ord(char) == 0x7f for char in raw)):
        raise McpError("unsafe_endpoint", f"The {field} URL is invalid.")
    try:
        parts = urlsplit(raw)
        host, port = parts.hostname, parts.port
    except ValueError:
        raise McpError("unsafe_endpoint", f"The {field} URL is invalid.") from None
    if (parts.scheme != "https" or not host or parts.username or parts.password or parts.fragment
            or (require_standard_port and port not in (None, 443))
            or (field == "endpoint" and parts.query)):
        raise McpError("unsafe_endpoint", f"The {field} must be a public HTTPS URL without credentials or query parameters.")
    host = host.rstrip(".").lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".test", ".invalid")):
        raise McpError("unsafe_endpoint", f"The {field} cannot use a local or reserved hostname.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise McpError("unsafe_endpoint", f"The {field} cannot use a private or reserved IP address.")
    return host, parts.path or "/", 443 if port is None else port


async def _raw_file(path: str, *, limit: int) -> bytes:
    if not re.fullmatch(r"(?:catalog\.json|plugins/(?:community|tested)/[a-z0-9]+(?:-[a-z0-9]+)*\.json|plugins/tested/evidence\.json)", path):
        raise McpError("invalid_catalog", "The marketplace index contains an invalid path.", 502)
    async with httpx.AsyncClient(timeout=5, follow_redirects=False, trust_env=False) as client:
        try:
            async with asyncio.timeout(15):
                async with client.stream("GET", GITHUB_RAW + path, headers={"Accept": "application/json"}) as response:
                    if response.status_code != 200 or response.headers.get("content-type", "").split(";", 1)[0].strip().lower() not in ("application/json", "text/plain"):
                        raise McpError("catalog_unavailable", "The public marketplace could not be reached.", 503)
                    pieces, size = [], 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > limit:
                            raise McpError("catalog_too_large", "A public marketplace file is too large.", 502)
                        pieces.append(chunk)
                    return b"".join(pieces)
        except McpError:
            raise
        except (httpx.HTTPError, TimeoutError):
            raise McpError("catalog_unavailable", "The public marketplace could not be reached.", 503) from None


async def _bundle_file(path: str, *, limit: int) -> bytes:
    root = _marketplace_root().resolve()
    candidate = (root / path).resolve()
    if root not in candidate.parents or not candidate.is_file():
        raise McpError("catalog_unavailable", "No bundled marketplace catalog is available.", 503)
    data = candidate.read_bytes()
    if len(data) > limit:
        raise McpError("catalog_too_large", "A bundled marketplace file is too large.", 502)
    return data


async def _get_catalog_data() -> dict:
    global _catalog_cache
    now = time.monotonic()
    if _catalog_cache is not None and _catalog_cache[0] > now:
        return _catalog_cache[1]
    result = None
    try:
        async with asyncio.timeout(60):
            result = await _load_catalog(_raw_file)
    except McpError:
        result = await _load_catalog(_bundle_file)
    except TimeoutError:
        result = await _load_catalog(_bundle_file)
    _catalog_cache = (now + CATALOG_TTL_SECONDS, result)
    return result


async def _load_catalog(read_file) -> dict:
    catalog = _json_bytes(await read_file("catalog.json", limit=MAX_CATALOG_BYTES), limit=MAX_CATALOG_BYTES, source="catalog")
    if not isinstance(catalog, dict) or set(catalog) != {"schema_version", "community", "tested"} or catalog.get("schema_version") != 1:
        raise McpError("invalid_catalog", "The public marketplace catalog is invalid.", 502)
    sections = {}
    manifests_by_slug = {}
    for section in ("community", "tested"):
        paths = catalog[section]
        if not isinstance(paths, list) or len(paths) > 250 or any(not isinstance(p, str) for p in paths):
            raise McpError("invalid_catalog", "The public marketplace catalog is invalid.", 502)
        expected_prefix = f"plugins/{section}/"
        entries = []
        section_slugs = set()
        for path in paths:
            if not path.startswith(expected_prefix) or not re.fullmatch(rf"plugins/{section}/[a-z0-9]+(?:-[a-z0-9]+)*\.json", path):
                raise McpError("invalid_catalog", "The public marketplace catalog contains an invalid path.", 502)
            raw = await read_file(path, limit=MAX_MANIFEST_BYTES)
            manifest = _validate_manifest(_json_bytes(raw, limit=MAX_MANIFEST_BYTES, source="manifest"), section=section, path=path)
            if manifest["slug"] in section_slugs:
                raise McpError("invalid_catalog", f"Marketplace section {section} has duplicate listings.", 502)
            section_slugs.add(manifest["slug"])
            manifest_digest = digest(manifest)
            prior = manifests_by_slug.get(manifest["slug"])
            if prior is not None and prior != manifest_digest:
                raise McpError("invalid_catalog", "A listing differs between marketplace sections.", 502)
            manifests_by_slug[manifest["slug"]] = manifest_digest
            manifest["section"] = section
            manifest["manifest_digest"] = manifest_digest
            manifest["source_path"] = path
            entries.append(manifest)
        sections[section] = entries
    if sections["tested"]:
        evidence = _json_bytes(await read_file("plugins/tested/evidence.json", limit=MAX_MANIFEST_BYTES), limit=MAX_MANIFEST_BYTES, source="tested evidence")
        if not isinstance(evidence, dict) or set(evidence) != {entry["slug"] for entry in sections["tested"]}:
            raise McpError("invalid_catalog", "Test evidence does not match the tested listings.", 502)
        for entry in sections["tested"]:
            record = evidence.get(entry["slug"])
            if (not isinstance(record, dict) or set(record) != {"version", "tested_on", "evidence_url"}
                    or record.get("version") != entry["version"]
                    or not isinstance(record.get("tested_on"), str)
                    or not isinstance(record.get("evidence_url"), str)):
                raise McpError("invalid_catalog", "A tested listing has incomplete evidence.", 502)
            try:
                date.fromisoformat(record["tested_on"])
            except ValueError:
                raise McpError("invalid_catalog", "A tested listing has an invalid evidence date.", 502) from None
            _validate_public_url(record["evidence_url"], "evidence_url", max_length=300)
            entry["evidence"] = record
    return sections


async def marketplace_catalog() -> dict:
    data = await _get_catalog_data()
    return {"tested": data["tested"], "community": data["community"]}


async def find_listing(section: str, slug: str) -> dict | None:
    if section not in ("tested", "community") or not SLUG.fullmatch(slug):
        return None
    return next((item for item in (await _get_catalog_data())[section] if item["slug"] == slug), None)


async def find_live_listing(section: str, slug: str) -> dict | None:
    """Read the current public catalog only; never install from stale bundled data."""
    if section not in ("tested", "community") or not SLUG.fullmatch(slug):
        return None
    try:
        async with asyncio.timeout(60):
            data = await _load_catalog(_raw_file)
    except TimeoutError:
        raise McpError("catalog_unavailable", "The public marketplace could not be reached.", 503) from None
    return next((item for item in data[section] if item["slug"] == slug), None)


def reject_credential_in_metadata(tools: list[dict], token: str | None) -> list[dict]:
    """Do not expose service-controlled metadata that repeats the bearer secret."""
    if token and any(token in canonical(tool) for tool in tools):
        raise McpError("unsafe_metadata", "The remote service returned metadata that matches its saved credential.", 502)
    return tools


def safe_schema(value: object, depth: int = 0) -> dict:
    """Keep only a bounded, locally validated JSON Schema subset."""
    if depth > MAX_DEPTH or not isinstance(value, dict) or len(canonical(value).encode("utf-8")) > MAX_SCHEMA_BYTES:
        raise McpError("unsupported_schema", "This tool's input schema is too large or complex.", 422)
    allowed = {"$schema", "type", "title", "description", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"}
    if set(value) - allowed:
        raise McpError("unsupported_schema", "This tool uses a schema feature Open Dots cannot validate safely.", 422)
    kind = value.get("type", "object")
    if kind not in ("object", "array", "string", "number", "integer", "boolean", "null"):
        raise McpError("unsupported_schema", "This tool uses an unsupported input type.", 422)
    result = {"type": kind}
    for key in ("title", "description"):
        if key in value and isinstance(value[key], str):
            result[key] = value[key][:1000 if key == "title" else 4000]
    if "$schema" in value and isinstance(value["$schema"], str) and len(value["$schema"]) < 200:
        result["$schema"] = value["$schema"]
    if "enum" in value:
        options = value["enum"]
        if not isinstance(options, list) or len(options) > 200 or len(canonical(options).encode("utf-8")) > 8_000:
            raise McpError("unsupported_schema", "This tool has an oversized enum.", 422)
        result["enum"] = options
    for key in ("minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"):
        if key in value:
            item = value[key]
            if not isinstance(item, (int, float)) or isinstance(item, bool) or abs(item) > 1_000_000:
                raise McpError("unsupported_schema", "This tool has invalid input bounds.", 422)
            result[key] = item
    if "properties" in value:
        props = value["properties"]
        if not isinstance(props, dict) or len(props) > 100 or any(not isinstance(name, str) or len(name) > 128 for name in props):
            raise McpError("unsupported_schema", "This tool has invalid input properties.", 422)
        result["properties"] = {name: safe_schema(child, depth + 1) for name, child in props.items()}
    if "required" in value:
        required = value["required"]
        if not isinstance(required, list) or len(required) > 100 or any(not isinstance(name, str) for name in required):
            raise McpError("unsupported_schema", "This tool has invalid required fields.", 422)
        if any(name not in value.get("properties", {}) for name in required):
            raise McpError("unsupported_schema", "This tool has a required field without a schema.", 422)
        result["required"] = required
    additional = value.get("additionalProperties", True)
    if not isinstance(additional, bool):
        raise McpError("unsupported_schema", "This tool uses unsupported dynamic input properties.", 422)
    result["additionalProperties"] = additional
    if kind == "array":
        if "items" not in value:
            raise McpError("unsupported_schema", "This tool's array input has no item schema.", 422)
        result["items"] = safe_schema(value["items"], depth + 1)
    if kind != "object" and any(key in value for key in ("properties", "required", "additionalProperties")):
        raise McpError("unsupported_schema", "This tool has schema fields that do not match its input type.", 422)
    return result


def validate_arguments(schema: dict, value: object, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        raise McpError("bad_arguments", "Tool arguments are nested too deeply.")
    kind = schema["type"]
    valid = {
        "object": lambda v: isinstance(v, dict),
        "array": lambda v: isinstance(v, list),
        "string": lambda v: isinstance(v, str),
        "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
        "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
        "boolean": lambda v: isinstance(v, bool),
        "null": lambda v: v is None,
    }[kind](value)
    if not valid:
        raise McpError("bad_arguments", f"Expected {kind} tool arguments.")
    if "enum" in schema and value not in schema["enum"]:
        raise McpError("bad_arguments", "Tool arguments are outside the listed choices.")
    if kind == "object":
        props = schema.get("properties", {})
        if len(value) > 100 or any(not isinstance(k, str) or len(k) > 128 for k in value):
            raise McpError("bad_arguments", "Tool arguments contain too many or invalid fields.")
        if any(name not in value for name in schema.get("required", [])):
            raise McpError("bad_arguments", "Tool arguments are missing a required field.")
        if schema.get("additionalProperties") is False and any(name not in props for name in value):
            raise McpError("bad_arguments", "Tool arguments contain an unlisted field.")
        for name, child in props.items():
            if name in value:
                validate_arguments(child, value[name], depth + 1)
    elif kind == "array":
        if len(value) > schema.get("maxItems", 1000) or len(value) < schema.get("minItems", 0):
            raise McpError("bad_arguments", "Tool arguments have an invalid array length.")
        for item in value:
            validate_arguments(schema["items"], item, depth + 1)
    elif kind == "string":
        if len(value) > schema.get("maxLength", 100_000) or len(value) < schema.get("minLength", 0):
            raise McpError("bad_arguments", "Tool arguments have an invalid string length.")
    elif kind in ("number", "integer"):
        if value > schema.get("maximum", float("inf")) or value < schema.get("minimum", float("-inf")):
            raise McpError("bad_arguments", "Tool arguments are outside the allowed numeric range.")


class _PinnedBackend:
    """Resolve hostnames once per new socket and connect to a validated IP."""

    def __init__(self):
        self._fallback = AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        try:
            try:
                literal = ipaddress.ip_address(host)
                addresses = [literal]
            except ValueError:
                host_text = host.decode("ascii") if isinstance(host, bytes) else str(host)
                loop = asyncio.get_running_loop()
                rows = await asyncio.wait_for(
                    loop.getaddrinfo(host_text, port, type=socket.SOCK_STREAM),
                    timeout=timeout or 8,
                )
                addresses = []
                for row in rows:
                    address = ipaddress.ip_address(row[4][0].split("%", 1)[0])
                    if address not in addresses:
                        addresses.append(address)
            if not addresses or any(not address.is_global for address in addresses):
                raise McpError("unsafe_endpoint", "The remote server resolves to a private or reserved address.", 502)
        except McpError:
            raise
        except Exception:
            raise McpError("dns_failed", "The remote server could not be safely resolved.", 502) from None
        last_error = None
        for address in addresses:
            try:
                stream = await self._fallback.connect_tcp(
                    address.compressed, port, timeout=timeout,
                    local_address=local_address, socket_options=socket_options,
                )
                observed = stream.get_extra_info("server_addr")
                if not isinstance(observed, tuple) or ipaddress.ip_address(str(observed[0]).split("%", 1)[0]) != address:
                    await stream.aclose()
                    raise McpError("endpoint_mismatch", "The remote connection did not reach its validated address.", 502)
                return stream
            except McpError:
                raise
            except Exception as exc:
                last_error = exc
        raise McpError("connect_failed", "The remote MCP server could not be reached.", 502) from last_error

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise McpError("unsafe_endpoint", "Local socket MCP servers are not supported.", 502)

    async def sleep(self, seconds):
        await self._fallback.sleep(seconds)


class _AsyncResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream):
        self.stream = stream

    async def __aiter__(self):
        async for part in self.stream:
            yield part

    async def aclose(self):
        await self.stream.aclose()


class PinnedHTTPSTransport(httpx.AsyncBaseTransport):
    def __init__(self):
        self.pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl.create_default_context(),
            max_connections=1,
            max_keepalive_connections=1,
            keepalive_expiry=15,
            http1=True,
            http2=False,
            retries=0,
            network_backend=_PinnedBackend(),
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        core_request = httpcore.Request(
            method=request.method,
            url=httpcore.URL(
                scheme=request.url.raw_scheme,
                host=request.url.raw_host,
                port=request.url.port,
                target=request.url.raw_path,
            ),
            headers=request.headers.raw,
            content=request.stream,
            extensions=request.extensions,
        )
        response = await self.pool.handle_async_request(core_request)
        return httpx.Response(
            status_code=response.status,
            headers=response.headers,
            stream=_AsyncResponseStream(response.stream),
            extensions=response.extensions,
        )

    async def aclose(self):
        await self.pool.aclose()


class RemoteMcpSession:
    def __init__(self, endpoint: str, token: str | None = None):
        self.endpoint = endpoint
        self.host, _path, self.port = _validate_public_url(endpoint, "endpoint", require_standard_port=True)
        self.token = token
        self.client = httpx.AsyncClient(
            transport=PinnedHTTPSTransport(),
            timeout=httpx.Timeout(15, connect=8),
            follow_redirects=False,
            trust_env=False,
            limits=httpx.Limits(max_connections=1, max_keepalive_connections=1),
        )
        self.protocol: str | None = None
        self.session_id: str | None = None
        self.request_id = 0
        self.started = False

    def _headers(self):
        headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
        if self.protocol:
            headers["MCP-Protocol-Version"] = self.protocol
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    async def _read_response(self, response: httpx.Response) -> bytes:
        pieces, size = [], 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > MAX_RESULT_BYTES:
                raise McpError("response_too_large", "The remote MCP response is too large.", 502)
            pieces.append(chunk)
        return b"".join(pieces)

    def _parse_rpc(self, content: bytes, content_type: str, expected_id: int) -> dict:
        if content_type == "application/json":
            candidates = [_json_bytes(content, limit=MAX_RESULT_BYTES, source="MCP response")]
        elif content_type == "text/event-stream":
            text = content.decode("utf-8", errors="strict")
            candidates = []
            for event in re.split(r"\r?\n\r?\n", text):
                data_lines = [line[5:].lstrip() for line in event.splitlines() if line.startswith("data:")]
                if data_lines:
                    candidates.append(_json_bytes("\n".join(data_lines).encode(), limit=MAX_RESULT_BYTES, source="MCP event"))
        else:
            raise McpError("invalid_response", "The remote MCP server returned an unsupported response type.", 502)
        for value in candidates:
            if not isinstance(value, dict) or value.get("jsonrpc") != "2.0":
                continue
            if value.get("method") is not None:
                raise McpError("unsupported_protocol", "The remote MCP server sent an unsupported request.", 502)
            if value.get("id") == expected_id:
                if "error" in value:
                    raise McpError("remote_error", "The remote MCP server rejected the request.", 502)
                result = value.get("result")
                if isinstance(result, dict):
                    return result
        raise McpError("invalid_response", "The remote MCP server did not return the expected response.", 502)

    async def _read_sse_result(self, response: httpx.Response, expected_id: int) -> dict:
        pending = bytearray()
        data_lines: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > MAX_RESULT_BYTES:
                raise McpError("response_too_large", "The remote MCP response is too large.", 502)
            pending.extend(chunk)
            while b"\n" in pending:
                raw_line, _, remaining = pending.partition(b"\n")
                pending = bytearray(remaining)
                line = raw_line.rstrip(b"\r")
                if not line:
                    if data_lines:
                        payload = b"\n".join(data_lines)
                        data_lines.clear()
                        try:
                            return self._parse_rpc(payload, "application/json", expected_id)
                        except McpError as exc:
                            if exc.code != "invalid_response":
                                raise
                    continue
                if line.startswith(b"data:"):
                    value = line[5:]
                    if value.startswith(b" "):
                        value = value[1:]
                    data_lines.append(value)
        raise McpError("invalid_response", "The remote MCP event stream ended before its result.", 502)

    async def _post(self, message: dict, *, expect_result: bool):
        body = canonical(message).encode("utf-8")
        if len(body) > MAX_REQUEST_BYTES:
            raise McpError("request_too_large", "The remote MCP request is too large.")
        try:
            async with asyncio.timeout(20):
                async with self.client.stream("POST", self.endpoint, headers=self._headers(), content=body) as response:
                    if 300 <= response.status_code < 400:
                        raise McpError("redirect_denied", "The remote MCP endpoint redirected; redirects are blocked.", 502)
                    if response.status_code in (401, 403):
                        raise McpError("authentication_failed", "The remote MCP server rejected its saved credential.", 502)
                    if not expect_result:
                        if response.status_code not in (200, 202, 204):
                            raise McpError("remote_error", "The remote MCP server rejected initialization.", 502)
                        return None
                    if response.status_code != 200:
                        raise McpError("remote_error", "The remote MCP server did not return a successful result.", 502)
                    raw_session = response.headers.get("mcp-session-id")
                    if raw_session:
                        if len(raw_session) > 256 or any(ord(char) < 33 or ord(char) > 126 for char in raw_session):
                            raise McpError("invalid_response", "The remote MCP server returned an invalid session id.", 502)
                        if self.session_id is not None and raw_session != self.session_id:
                            raise McpError("session_changed", "The remote MCP session changed unexpectedly.", 502)
                        self.session_id = raw_session
                    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                    if content_type == "text/event-stream":
                        return await self._read_sse_result(response, message["id"])
                    content = await self._read_response(response)
                    return self._parse_rpc(content, content_type, message["id"])
        except McpError:
            raise
        except Exception:
            raise McpError("remote_unavailable", "The remote MCP request failed; the call may have reached the server.", 502) from None

    async def start(self):
        if self.started:
            return
        self.request_id += 1
        response = await self._post({
            "jsonrpc": "2.0", "id": self.request_id, "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "open-dots", "version": "1"},
            },
        }, expect_result=True)
        protocol = response.get("protocolVersion")
        if protocol not in SUPPORTED_PROTOCOLS:
            raise McpError("unsupported_protocol", "The remote MCP server negotiated an unsupported protocol version.", 502)
        self.protocol = protocol
        self.request_id += 1
        await self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, expect_result=False)
        self.started = True

    async def _rpc(self, method: str, params: dict | None = None):
        await self.start()
        self.request_id += 1
        message = {"jsonrpc": "2.0", "id": self.request_id, "method": method}
        if params is not None:
            message["params"] = params
        return await self._post(message, expect_result=True)

    async def list_tools(self) -> list[dict]:
        async with asyncio.timeout(60):
            return await self._list_tools()

    async def _list_tools(self) -> list[dict]:
        tools, cursor, seen, total_bytes = [], None, set(), 0
        for _ in range(MAX_PAGES):
            params = {"cursor": cursor} if cursor else {}
            result = await self._rpc("tools/list", params)
            page = result.get("tools")
            if not isinstance(page, list):
                raise McpError("invalid_response", "The remote MCP server returned an invalid tool list.", 502)
            for raw in page:
                tool = _normalize_tool(raw)
                total_bytes += len(canonical(tool).encode("utf-8"))
                if total_bytes > MAX_TOOLSET_BYTES:
                    raise McpError("toolset_too_large", "This remote server exposes too much tool metadata.", 502)
                if tool["name"] in seen:
                    raise McpError("invalid_response", "The remote MCP server returned duplicate tool names.", 502)
                seen.add(tool["name"])
                tools.append(tool)
                if len(tools) > MAX_TOOLS:
                    raise McpError("too_many_tools", "This remote server exposes too many tools.", 502)
            cursor = result.get("nextCursor")
            if cursor is None:
                return tools
            if not isinstance(cursor, str) or len(cursor) > 1000 or cursor in seen:
                raise McpError("invalid_response", "The remote MCP server returned an invalid pagination cursor.", 502)
            seen.add(cursor)
        raise McpError("too_many_pages", "The remote MCP server's tool list has too many pages.", 502)

    async def call_tool(self, name: str, arguments: dict) -> dict:
        result = await self._rpc("tools/call", {"name": name, "arguments": arguments})
        if not isinstance(result, dict):
            raise McpError("invalid_response", "The remote MCP server returned an invalid tool result.", 502)
        safe_content = []
        content = result.get("content", [])
        if isinstance(content, list):
            for item in content[:100]:
                if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                    safe_content.append({"type": "text", "text": item["text"][:200_000]})
                elif isinstance(item, dict) and item.get("type") == "resource_link":
                    safe_content.append({"type": "text", "text": "[A remote resource link was returned and is not opened by Open Dots.]"})
        output = {"content": safe_content, "isError": result.get("isError") is True}
        structured = result.get("structuredContent")
        if structured is not None:
            encoded = canonical(structured).encode("utf-8")
            if len(encoded) > MAX_RESULT_BYTES:
                raise McpError("response_too_large", "The tool returned too much structured data.", 502)
            output["structuredContent"] = structured
        return output

    async def close(self):
        if self.session_id:
            try:
                async with asyncio.timeout(2):
                    async with self.client.stream("DELETE", self.endpoint, headers=self._headers()) as response:
                        await self._read_response(response)
            except Exception:
                pass
        await self.client.aclose()


def _normalize_tool(raw: object) -> dict:
    if not isinstance(raw, dict) or set(raw) - {"name", "title", "description", "inputSchema", "outputSchema", "annotations", "_meta"}:
        raise McpError("invalid_response", "The remote MCP server returned an unsupported tool definition.", 502)
    name = raw.get("name")
    if not isinstance(name, str) or not name or len(name) > 200:
        raise McpError("invalid_response", "The remote MCP server returned an invalid tool name.", 502)
    description = raw.get("description", "")
    if not isinstance(description, str):
        description = ""
    input_schema = safe_schema(raw.get("inputSchema", {"type": "object", "properties": {}}))
    if input_schema["type"] != "object":
        raise McpError("unsupported_schema", "MCP tools must accept an object of arguments.", 422)
    record = {"name": name, "description": description[:4000], "inputSchema": input_schema}
    record["schema_digest"] = digest(record)
    return record
