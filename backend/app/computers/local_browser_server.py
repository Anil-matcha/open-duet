"""The browser tools alone, as a stdio MCP server the engine starts for a turn, backed by a
Chromium on this machine (local_browser.py) instead of a Docker computer.

It exposes only the `browser_*` tools: no exec and no file tools. Every call needs a one-use permit
(grants.py), the person's take-over and the other-conversation checks run as for the desktop
browser, and one call runs at a time (screen.driver_lock).

Line-delimited JSON-RPC 2.0 on stdin/stdout. Started as

    python -m app.computers.local_browser_server --grants DIR --state DIR --profiles DIR \
        --agent NAME [--turn-id ID] [--proxy-server URL] [--url-check module:function]

Unless --no-egress-gate or --proxy-server is given, a local egress gate (local_browser_egress.py) starts
with the server, Chromium is sent through it, and its URL check runs before each browser_open.

A url check takes a URL and returns a problem text, or None when the address may be opened.
"""

import argparse
import asyncio
import importlib
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Callable

from app.computers import browser, grants, local_browser_egress, local_browser_guard as guard, screen
from app.computers.local_browser import LocalBrowser, LocalBrowserError
from app.computers.mcp_server import NOT_APPROVED, PROTOCOL_VERSION, _text

LAST_COMMAND_FILE = "last-command.json"
UNAVAILABLE = "Browser unavailable here. Use browser_restart after a timeout, or tell the person."


class LocalServer:
    def __init__(
        self,
        grants_dir: Path,
        state_dir: Path,
        local: LocalBrowser,
        turn_id: str = "",
        max_actions: int = 300,
        url_check: Callable[[str], str | None] | None = None,
        max_tabs: int = 4,
    ) -> None:
        self.grants_dir = grants_dir
        self.state_dir = state_dir
        self.local = local
        self.url_check = url_check
        self.max_tabs = max_tabs
        self.screen = screen.Screen(self, turn_id or str(grants_dir), max_actions)

    # -- protocol ----------------------------------------------------------------------

    def handle(self, message: dict) -> dict | None:
        method = message.get("method")
        msg_id = message.get("id")
        params = message.get("params") or {}
        if msg_id is None:
            return None
        try:
            if method == "initialize":
                result = {
                    "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "open-dots-browser", "version": "1"},
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": browser.TOOLS}
            elif method == "tools/call":
                result = self.call(params.get("name"), params.get("arguments") or {})
            else:
                return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Unknown method: {method}"}}
        except Exception as exc:  # noqa: BLE001  (a tool failure must not end the server)
            result = _text(f"The browser tool failed: {exc}", error=True)
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    # -- tools -------------------------------------------------------------------------

    def call(self, name: object, arguments: object) -> dict:
        if not isinstance(name, str) or name not in browser.DEFINITIONS:
            return _text("Unknown browser tool.", error=True)
        if not isinstance(arguments, dict):
            return _text("Tool arguments must be an object.", error=True)
        problem = browser.validate(name, arguments)
        if not problem and guard.opens_page(name, arguments):
            problem = self.page_refusal()
        if not problem and name == "browser_open" and self.url_check:
            problem = self.url_check(arguments["url"])
        if problem:
            return _text(problem, error=True)
        if not grants.consume(self.grants_dir, name, arguments):
            return _text(NOT_APPROVED, error=True)
        return self.run(name, arguments)

    def page_refusal(self) -> str | None:
        """A plain refusal when memory is low or the tab cap is reached, else None."""
        if guard.memory_low(guard.memory_state()):
            return guard.LOW_MEMORY
        if not self.local.running():
            return None  # a fresh browser has one blank tab
        try:
            reply = self.local.request({"name": "browser_tabs", "args": {"action": "list"}, "owner": self.screen.turn_id, "epoch": 0})
            text = reply["content"][0]["text"]
            tabs = len(json.loads(text[text.index("{"):])["tabs"])
        except (LocalBrowserError, KeyError, IndexError, ValueError, TypeError):
            return None
        return guard.check_tabs(tabs, self.max_tabs)

    def run(self, name: str, args: dict) -> dict:
        """The same take-over, ownership and action-limit checks as Browser.run, then the local broker."""
        with screen.driver_lock(self.state_dir):
            if screen.held(self.state_dir):
                return _text(screen.CONTROL_REFUSAL, error=True)
            owner_path = self.state_dir / "screen-owner.json"
            owner = screen.read_state(owner_path)
            if owner.get("until", 0) > time.time() and owner.get("turn_id") != self.screen.turn_id:
                self.screen.needs_observation = True
                return _text(screen.BUSY_REFUSAL, error=True)
            if name in browser.INPUT_NAMES:
                if self.screen.actions >= self.screen.max_actions:
                    return _text("This turn reached its screen action limit.", error=True)
                screen.write_state(self.state_dir / "screen-epoch.json", {"at": time.time_ns()})
                self.screen.actions += 1
                screen.write_state(owner_path, {"turn_id": self.screen.turn_id, "until": time.time() + 60})
            epoch = screen.read_state(self.state_dir / "browser-epoch.json").get("at", 0)
            try:
                result = self.local.request({"name": name, "args": args, "owner": self.screen.turn_id, "epoch": epoch})
            except LocalBrowserError as exc:
                return _text(f"{UNAVAILABLE} ({exc})", error=True)
            self._remember(name, 1 if result.get("isError") else 0)
            return result

    def _remember(self, tool: str, code: int) -> None:
        """What ran last, for the Computer panel. Best effort."""
        record = {"tool": tool, "subject": "Browser action", "exit_code": code, "timed_out": False, "output": "", "at": time.time()}
        try:
            grants.private_dir(self.state_dir)
            tmp = self.state_dir / f".{LAST_COMMAND_FILE}.{os.getpid()}"
            tmp.write_text(json.dumps(record), encoding="utf-8")
            os.replace(tmp, self.state_dir / LAST_COMMAND_FILE)
        except OSError:
            pass


class _ThreadedGate:
    """Runs the async egress gate on its own loop so the stdio server stays synchronous."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.gate = local_browser_egress.Gate()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)

    def start(self) -> str:
        self.thread.start()
        return asyncio.run_coroutine_threadsafe(self.gate.start(), self.loop).result(10)

    def stop(self) -> None:
        try:
            asyncio.run_coroutine_threadsafe(self.gate.stop(), self.loop).result(5)
        finally:
            self.loop.call_soon_threadsafe(self.loop.stop)


def _load_check(spec: str) -> Callable[[str], str | None]:
    module, _, attr = spec.partition(":")
    return getattr(importlib.import_module(module), attr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="open-dots-browser-mcp")
    parser.add_argument("--grants", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--agent", required=True)
    parser.add_argument("--turn-id", default="")
    parser.add_argument("--max-screen-actions", type=int, default=300)
    parser.add_argument("--proxy-server", default=None)
    parser.add_argument("--url-check", default=None)
    parser.add_argument("--idle-seconds", type=int, default=1800)
    parser.add_argument("--hosted", action="store_true", help="hosted sandbox: close idle browsers after three minutes")
    parser.add_argument("--no-egress-gate", action="store_true", help="skip the local egress gate (tests and trusted hosts only)")
    options = parser.parse_args(argv)
    gate = None
    try:
        proxy_server, check = options.proxy_server, _load_check(options.url_check) if options.url_check else None
        if not options.no_egress_gate and not proxy_server:
            gate = _ThreadedGate()
            proxy_server = gate.start()
            check = check or local_browser_egress.check_url
        caps = guard.limits(hosted=options.hosted)
        state = Path(options.state)
        local = LocalBrowser(
            Path(options.profiles), options.agent, proxy_server=proxy_server, idle_seconds=caps.idle_seconds or options.idle_seconds,
            registry=Path(options.profiles) / ".running", state_dir=state, max_browsers=caps.browsers, held=screen.held,
        )
    except (LocalBrowserError, ImportError, AttributeError) as exc:
        if gate:
            gate.stop()
        sys.stderr.write(f"invalid browser connection: {exc}\n")
        return 2
    server = LocalServer(Path(options.grants), Path(options.state), local, options.turn_id, options.max_screen_actions, check, caps.tabs)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
            else:
                reply = server.handle(message) if isinstance(message, dict) else None
            if reply is not None:
                sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
                sys.stdout.flush()
    finally:
        local.release()
        if gate:
            gate.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
