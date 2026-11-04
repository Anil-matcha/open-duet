"""Per-turn local MCP shim for approved marketplace tools.

The shim has no endpoint or credential. It exposes only the metadata prepared
by the backend for this agent and forwards calls through a private mailbox.
"""

import argparse
import json
import os
import stat
import sys
import time
from pathlib import Path
from uuid import uuid4


MAX_LINE = 100_000
MAX_REPLY = 8_000_000
MAX_WAIT_SECONDS = 120


class Server:
    def __init__(self, mailbox: str, tools_path: str):
        self.mailbox = Path(mailbox)
        tools_file = Path(tools_path)
        descriptor = os.open(tools_file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0))
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 1_000_000:
                raise ValueError("tool metadata too large")
            with os.fdopen(descriptor, "rb") as source:
                raw = source.read(1_000_001)
            if len(raw) > 1_000_000:
                raise ValueError("tool metadata too large")
        except BaseException:
            try:
                os.close(descriptor)
            except OSError:
                pass
            raise
        data = json.loads(raw)
        if not isinstance(data, list) or len(data) > 100:
            raise ValueError("invalid tool metadata")
        self.tools = []
        self.names = set()
        for tool in data:
            if (not isinstance(tool, dict) or set(tool) != {"name", "description", "inputSchema"}
                    or not isinstance(tool["name"], str) or not tool["name"].isascii()
                    or not tool["name"].replace("_", "a").isalnum() or len(tool["name"]) > 128
                    or not isinstance(tool["description"], str) or len(tool["description"]) > 5000
                    or not isinstance(tool["inputSchema"], dict)):
                raise ValueError("invalid tool metadata")
            if tool["name"] in self.names:
                raise ValueError("duplicate tool")
            self.names.add(tool["name"])
            self.tools.append(tool)

    def _request(self, request):
        body = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
        if len(body.encode("utf-8")) > 64_000:
            return {"error": "The request is too large."}
        token = uuid4().hex
        path = self.mailbox / f"req-{token}.json"
        temporary = self.mailbox / f".req-{token}-{uuid4().hex}.tmp"
        descriptor = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0),
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            target.write(body)
        os.replace(temporary, path)
        response = self.mailbox / f"resp-{token}.json"
        deadline = time.monotonic() + MAX_WAIT_SECONDS
        while time.monotonic() < deadline:
            descriptor = None
            try:
                descriptor = os.open(
                    response, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
                )
            except FileNotFoundError:
                time.sleep(0.05)
                continue
            except OSError:
                return {"error": "The marketplace call could not be completed."}
            try:
                info = os.fstat(descriptor)
                if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REPLY:
                    response.unlink(missing_ok=True)
                    return {"error": "The remote tool returned too much data."}
                with os.fdopen(descriptor, "rb") as source:
                    descriptor = None
                    raw = source.read(MAX_REPLY + 1)
                if len(raw) > MAX_REPLY:
                    response.unlink(missing_ok=True)
                    return {"error": "The remote tool returned too much data."}
                result = json.loads(raw.decode("utf-8"))
                response.unlink(missing_ok=True)
                return result if isinstance(result, dict) else {"error": "Invalid backend response."}
            except (OSError, UnicodeDecodeError, ValueError):
                return {"error": "The marketplace call could not be completed."}
            finally:
                if descriptor is not None:
                    os.close(descriptor)
            time.sleep(0.05)
        return {"error": "The call timed out. It may have reached the service; check before repeating."}

    def call(self, name, arguments):
        if name not in self.names or not isinstance(arguments, dict):
            return {"error": "Unknown tool or invalid arguments."}
        return self._request({"kind": "call", "name": name, "arguments": arguments})

    def list_tools(self):
        result = self._request({"kind": "list"})
        tools = result.get("tools")
        if (not isinstance(tools, list) or len(tools) > 100
                or any(not isinstance(tool, dict) or tool.get("name") not in self.names for tool in tools)):
            return []
        allowed = {tool["name"] for tool in tools}
        return [tool for tool in self.tools if tool["name"] in allowed]

    def handle(self, message):
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return None
        method, identifier = message.get("method"), message.get("id")
        if identifier is None:
            return None
        if method == "initialize":
            result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "open-dots-community", "version": "1"}}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": self.list_tools()}
        elif method == "tools/call":
            params = message.get("params")
            if not isinstance(params, dict):
                params = {}
            body = self.call(params.get("name"), params.get("arguments", {}))
            result = {"content": [{"type": "text", "text": json.dumps(body, ensure_ascii=False)}],
                      "isError": bool(body.get("error"))}
        else:
            return {"jsonrpc": "2.0", "id": identifier,
                    "error": {"code": -32601, "message": "Unknown method"}}
        return {"jsonrpc": "2.0", "id": identifier, "result": result}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mailbox", required=True)
    parser.add_argument("--tools", required=True)
    arguments = parser.parse_args()
    server = Server(arguments.mailbox, arguments.tools)
    for line in sys.stdin:
        try:
            if len(line.encode("utf-8")) > MAX_LINE:
                continue
            response = server.handle(json.loads(line))
            if response is not None:
                print(json.dumps(response, ensure_ascii=False), flush=True)
        except (ValueError, OSError, TypeError):
            continue


if __name__ == "__main__":
    main()
