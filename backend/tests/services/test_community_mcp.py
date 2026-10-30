"""Remote MCP client parsing and the tool-list bounds."""

import json

import pytest

from app import community_mcp
from app.community_mcp import McpError, RemoteMcpSession, _normalize_tool, validate_arguments


def session():
    return RemoteMcpSession("https://example.com/mcp")


def test_a_notification_before_the_result_is_ignored_but_a_server_request_is_refused():
    note = {"jsonrpc": "2.0", "method": "notifications/progress", "params": {}}
    result = {"jsonrpc": "2.0", "id": 3, "result": {"ok": True}}
    body = f"data: {json.dumps(note)}\n\ndata: {json.dumps(result)}\n\n".encode()
    assert session()._parse_rpc(body, "text/event-stream", 3) == {"ok": True}
    request = {"jsonrpc": "2.0", "id": 9, "method": "sampling/createMessage"}
    with pytest.raises(McpError) as caught:
        session()._parse_rpc(json.dumps(request).encode(), "application/json", 3)
    assert caught.value.code == "unsupported_protocol"


@pytest.mark.asyncio
async def test_one_unsupported_tool_is_skipped_and_the_rest_are_listed(monkeypatch):
    page = {"tools": [
        {"name": "ok", "description": "fine", "inputSchema": {"type": "object", "properties": {}}},
        {"name": "fancy", "inputSchema": {"type": "object", "properties": {"x": {"anyOf": [{"type": "string"}]}}}},
    ]}
    s = session()

    async def rpc(method, params=None):
        return page

    monkeypatch.setattr(s, "_rpc", rpc)
    assert [t["name"] for t in await s.list_tools()] == ["ok"]


def test_schema_and_argument_validation_reject_unsafe_shapes():
    with pytest.raises(McpError):
        _normalize_tool({"name": "t", "inputSchema": {"type": "object", "$ref": "#/x"}})
    tool = _normalize_tool({"name": "t", "inputSchema": {
        "type": "object", "properties": {"n": {"type": "integer", "maximum": 5}},
        "required": ["n"], "additionalProperties": False}})
    schema = tool["inputSchema"]
    validate_arguments(schema, {"n": 3})
    for bad in ({}, {"n": 9}, {"n": True}, {"n": 1, "extra": 1}):
        with pytest.raises(McpError):
            validate_arguments(schema, bad)


def test_schema_supports_bounded_uri_defaults_and_model_enums():
    schema = _normalize_tool({"name": "media", "inputSchema": {
        "type": "object", "additionalProperties": False, "properties": {
            "image_url": {"type": "string", "format": "uri"},
            "model": {"type": "string", "enum": [f"model-{n}" for n in range(217)], "default": "model-0"},
            "duration": {"type": "integer", "minimum": 1, "maximum": 5, "default": 3},
            "enabled": {"type": "boolean", "default": False},
        }}})["inputSchema"]
    assert schema["properties"]["image_url"]["format"] == "uri"
    assert schema["properties"]["model"]["default"] == "model-0"
    validate_arguments(schema, {"image_url": "https://cdn.example/image.png"})
    validate_arguments(schema, {"image_url": "https://cdn.example/image.png", "duration": 5})
    for bad in (
        {"image_url": "http://cdn.example/image.png"},
        {"image_url": "https://localhost/image.png"},
        {"image_url": "https://cdn.example/image.png", "duration": 6},
        {"image_url": "https://cdn.example/image.png", "model": "unknown"},
    ):
        with pytest.raises(McpError):
            validate_arguments(schema, bad)


def test_schema_rejects_unsafe_formats_defaults_and_oversized_enums():
    for input_schema in (
        {"type": "object", "properties": {"x": {"type": "string", "format": "uri-reference"}}},
        {"type": "object", "properties": {"x": {"type": "string", "default": 3}}},
        {"type": "object", "properties": {"x": {"type": "integer", "minimum": 2, "default": 1}}},
        {"type": "object", "properties": {"x": {"type": "object", "default": {}}}},
        {"type": "object", "properties": {"x": {"type": "string", "enum": [f"model-{n}" for n in range(257)]}}},
    ):
        with pytest.raises(McpError):
            _normalize_tool({"name": "unsafe", "inputSchema": input_schema})


@pytest.mark.parametrize("url", [
    "http://example.com/mcp", "https://localhost/mcp", "https://10.0.0.1/mcp",
    "https://user:pw@example.com/mcp", "https://example.com:8443/mcp", "https://example.com/mcp?x=1",
    "https://[::1]/mcp", "https://169.254.169.254/mcp",
])
def test_unsafe_endpoints_are_refused(url):
    with pytest.raises(McpError):
        community_mcp._validate_public_url(url, "endpoint", require_standard_port=True)


@pytest.mark.asyncio
async def test_an_invalid_live_catalog_is_not_hidden_by_bundled_data(monkeypatch):
    async def invalid(path, *, limit):
        raise McpError("invalid_catalog", "bad", 502)

    monkeypatch.setattr(community_mcp, "_catalog_cache", None)
    monkeypatch.setattr(community_mcp, "_raw_file", invalid)
    with pytest.raises(McpError) as caught:
        await community_mcp._get_catalog_data()
    assert caught.value.code == "invalid_catalog"


def test_the_credential_is_redacted_in_common_encodings():
    from app.services.community_mcp_bridge import _redact
    import base64
    secret = 'tok/en"1'
    text = f"{secret} tok%2Fen%221 {base64.b64encode(secret.encode()).decode()} tok/en\\\"1"
    assert secret not in _redact(text, secret) and "tok%2Fen" not in _redact(text, secret)
