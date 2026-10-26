"""A small stdio MCP server giving a turn read access to the person's connected
apps (Composio; .internal/design/composio-integration.md).

It holds no key and makes no network call. Each tool call is a request file in
the turn's private mailbox folder; the backend checks it against the agent's
app scope, claims the matching one-use approval, runs it with the person's key
and writes the reply beside it (app/services/composio_bridge.py). The same
transport as the memory and team tools. The apps listed with --apps are the
only ones whose tools it shows.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path
from uuid import uuid4

from app import composio_tools


class Server:
    def __init__(self, mailbox, allowed_apps):
        self.mailbox = Path(mailbox)
        self.tools = composio_tools.mcp_tools(set(allowed_apps))
        self.names = {tool["name"] for tool in self.tools}

    def call(self, name, arguments):
        if name not in self.names or not isinstance(arguments, dict):
            return {"error": "Unknown tool or invalid arguments."}
        token = uuid4().hex
        path = self.mailbox / f"req-{token}.json"
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"name": name, "arguments": arguments}), encoding="utf-8")
        os.replace(temporary, path)
        response = self.mailbox / f"resp-{token}.json"
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if response.exists():
                result = json.loads(response.read_text(encoding="utf-8"))
                response.unlink(missing_ok=True)
                return result
            time.sleep(0.05)
        return {"error": "The app did not answer in time. It may still have been read; check before repeating."}

    def handle(self, message):
        method, identifier = message.get("method"), message.get("id")
        if identifier is None:
            return None
        if method == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "composio", "version": "1"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": self.tools}
        elif method == "tools/call":
            params = message.get("params") or {}
            body = self.call(params.get("name"), params.get("arguments") or {})
            result = {"content": [{"type": "text", "text": json.dumps(body, ensure_ascii=False)}],
                      "isError": bool(body.get("error"))}
        else:
            return {"jsonrpc": "2.0", "id": identifier, "error": {"code": -32601, "message": "Unknown method"}}
        return {"jsonrpc": "2.0", "id": identifier, "result": result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mailbox", required=True)
    parser.add_argument("--apps", default="")
    arguments = parser.parse_args()
    server = Server(arguments.mailbox, [app for app in arguments.apps.split(",") if app])
    for line in sys.stdin:
        try:
            if len(line) > 100000:
                continue
            result = server.handle(json.loads(line))
            if result is not None:
                print(json.dumps(result), flush=True)
        except (ValueError, OSError, TypeError):
            continue


if __name__ == "__main__":
    main()
