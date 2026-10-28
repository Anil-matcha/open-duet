"""Live view and take-over for the browser on this machine.

The page's own screencast (Chrome DevTools `Page.startScreencast`) is relayed to the person's browser as
JPEG frames over a WebSocket, and their pointer and keys are relayed back as `Input.*` events. It reuses the
desktop viewer's ticket, control and hold machinery (viewer.py, control.py): holding control writes
`control.json` in the browser's state folder, so the agent's calls refuse while the person drives and the
resource guard never ends a browser that is being watched (screen.held).

Limits: one frame in flight (Chrome is acknowledged only after the viewer acknowledged the last frame, and
not faster than MAX_FPS), frames over MAX_FRAME_BYTES are dropped, client messages are small and rate limited.
The only way to navigate from the viewer is a `nav` message, which runs the same URL check as the agent's
browser_open; links the person clicks go through the browser's egress gate like any other traffic.

A view-only session (a viewer that holds no control) streams frames and acknowledges them, and nothing else:
pointer, key, text and navigation messages are dropped, and a navigation attempt is answered with a plain refusal.

Wire format, client to server (JSON text): ack, mouse, wheel, key, text, nav. Server to client: a JSON text
`{"t": "size", "w", "h"}` whenever the frame size changes, then each frame as one binary JPEG message.
"""

import asyncio
import base64
import json
import os
import time
from pathlib import Path
from typing import Awaitable, Callable

import httpx

from app.computers import local_browser_egress
from app.computers.local_browser import CDP_FILE

MAX_FPS = 8
MAX_FRAME_BYTES = 600_000
MAX_MESSAGE_BYTES = 4096
MAX_TEXT = 2000
MAX_INPUT_PER_SECOND = 80
QUALITY = 55
FIRST_FRAME_SECONDS = 10
VIEW_ONLY_REFUSAL = "This view is watch-only. Take control to use the browser."
WIDTH, HEIGHT = 1280, 800

BUTTONS = {"left": "left", "middle": "middle", "right": "right"}
NAMED_KEYS = {
    "Enter": 13, "Backspace": 8, "Tab": 9, "Escape": 27, "Delete": 46, "Home": 36, "End": 35,
    "PageUp": 33, "PageDown": 34, "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40,
}
MODIFIER_BITS = 15  # Alt 1, Ctrl 2, Meta 4, Shift 8


def state_folder(state_root: Path, agent_id: int) -> Path:
    return state_root / f"browser-{agent_id}"


def debug_port(folder: Path) -> int | None:
    """The loopback port of this agent's running browser, or None when it is not running."""
    try:
        record = json.loads((folder / CDP_FILE).read_text())
        port, pid = int(record["port"]), int(record["pid"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    return port if 0 < port < 65536 else None


async def page_socket_url(port: int) -> str | None:
    """The DevTools WebSocket of the most recently used page. The host and port are fixed to loopback and
    the debug port: the address the browser reports is never followed."""
    async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
        reply = await client.get(f"http://127.0.0.1:{port}/json/list")
    for target in reply.json():
        if target.get("type") == "page":
            identity = str(target.get("id", ""))
            if identity.isalnum():
                return f"ws://127.0.0.1:{port}/devtools/page/{identity}"
    return None


def translate(message: object, size: tuple[int, int], check_url: Callable[[str], str | None]) -> tuple[str, dict] | str | None:
    """One client message as a DevTools command (method, params), a plain refusal text, or None to ignore it.
    Pure: nothing here touches the browser."""
    if not isinstance(message, dict):
        return None
    kind = message.get("t")
    width, height = size
    if kind in ("mouse", "wheel"):
        x, y = message.get("x"), message.get("y")
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in (x, y)) or not (0 <= x <= width and 0 <= y <= height):
            return None
        x, y = round(x, 1), round(y, 1)
        if kind == "wheel":
            dx, dy = message.get("dx", 0), message.get("dy", 0)
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in (dx, dy)):
                return None
            clamp = lambda v: max(-1200, min(1200, round(v)))  # noqa: E731
            return "Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": clamp(dx), "deltaY": clamp(dy)}
        action, button = message.get("a"), BUTTONS.get(message.get("b", "left"))
        if action not in ("move", "down", "up") or button is None:
            return None
        params = {"type": {"move": "mouseMoved", "down": "mousePressed", "up": "mouseReleased"}[action], "x": x, "y": y}
        if action != "move":
            params.update(button=button, clickCount=1)
        return "Input.dispatchMouseEvent", params
    if kind == "key":
        key, action, mods = message.get("key"), message.get("a"), message.get("mods", 0)
        if not isinstance(key, str) or action not in ("down", "up") or isinstance(mods, bool) or not isinstance(mods, int) or not 0 <= mods <= MODIFIER_BITS:
            return None
        if key in NAMED_KEYS:
            params = {"type": "rawKeyDown" if action == "down" else "keyUp", "key": key, "windowsVirtualKeyCode": NAMED_KEYS[key], "modifiers": mods}
            if key == "Enter" and action == "down":
                params.update(type="keyDown", text="\r")
            return "Input.dispatchKeyEvent", params
        if len(key) == 1 and key.isprintable():
            params = {"type": "keyDown" if action == "down" else "keyUp", "key": key, "modifiers": mods}
            if action == "down" and not mods & 6:  # no text for Ctrl or Meta combinations
                params["text"] = key
            return "Input.dispatchKeyEvent", params
        return None
    if kind == "text":
        text = message.get("text")
        if not isinstance(text, str) or not text or len(text) > MAX_TEXT or "\x00" in text:
            return None
        return "Input.insertText", {"text": text}
    if kind == "nav":
        url = message.get("url")
        if not isinstance(url, str) or not url or len(url) > 2048:
            return None
        return check_url(url) or ("Page.navigate", {"url": url})
    return None


class Bucket:
    """At most `rate` messages a second; the rest are dropped, not queued."""

    def __init__(self, rate: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.rate, self.clock = rate, clock
        self.tokens, self.at = float(rate), clock()

    def take(self) -> bool:
        now = self.clock()
        self.tokens = min(self.rate, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


class Session:
    """One viewer's relay. `cdp` has `send(str)` and `recv() -> str`; `client` has `send_text`, `send_bytes`."""

    def __init__(self, cdp, client, check_url: Callable[[str], str | None] = local_browser_egress.check_url,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], Awaitable] = asyncio.sleep,
                 view_only: bool = False) -> None:
        self.cdp, self.client, self.check_url, self.clock, self.sleep = cdp, client, check_url, clock, sleep
        self.view_only = view_only
        self.size = (WIDTH, HEIGHT)
        self.next_id = 0
        self.waiting: int | None = None  # the screencast session id Chrome is waiting to have acknowledged
        self.last_sent = 0.0
        self.frames = 0
        self.dropped = 0
        self.bucket = Bucket(MAX_INPUT_PER_SECOND, clock)

    async def command(self, method: str, params: dict | None = None) -> None:
        self.next_id += 1
        await self.cdp.send(json.dumps({"id": self.next_id, "method": method, "params": params or {}}))

    async def start(self) -> None:
        await self.command("Page.enable")
        await self.command("Page.startScreencast", {"format": "jpeg", "quality": QUALITY, "maxWidth": WIDTH, "maxHeight": HEIGHT, "everyNthFrame": 1})

    async def stop(self) -> None:
        try:
            await self.command("Page.stopScreencast")
        except Exception:  # noqa: BLE001  (the page may already be gone)
            pass

    async def on_chrome(self, raw: str) -> None:
        try:
            event = json.loads(raw)
        except ValueError:
            return
        if event.get("method") != "Page.screencastFrame":
            return
        params = event.get("params") or {}
        session = params.get("sessionId")
        data = params.get("data")
        if not isinstance(session, int) or not isinstance(data, str):
            return
        if len(data) * 3 // 4 > MAX_FRAME_BYTES or self.waiting is not None:
            self.dropped += 1
            await self.command("Page.screencastFrameAck", {"sessionId": session})
            return
        try:
            jpeg = base64.b64decode(data, validate=True)
        except ValueError:
            await self.command("Page.screencastFrameAck", {"sessionId": session})
            return
        meta = params.get("metadata") or {}
        size = (int(meta.get("deviceWidth") or WIDTH), int(meta.get("deviceHeight") or HEIGHT))
        if size != self.size or self.frames == 0:
            self.size = size
            await self.client.send_text(json.dumps({"t": "size", "w": size[0], "h": size[1]}))
        self.waiting = session
        self.frames += 1
        await self.client.send_bytes(jpeg)

    async def on_client(self, raw: str) -> str | None:
        """Handle one client message. Returns a plain refusal for the person, if any."""
        try:
            message = json.loads(raw)
        except ValueError:
            return None
        if isinstance(message, dict) and message.get("t") == "ack":
            session, self.waiting = self.waiting, None
            if session is not None:
                wait = 1 / MAX_FPS - (self.clock() - self.last_sent)
                if wait > 0:
                    await self.sleep(wait)
                self.last_sent = self.clock()
                await self.command("Page.screencastFrameAck", {"sessionId": session})
            return None
        if self.view_only:
            if isinstance(message, dict) and message.get("t") == "nav":
                return VIEW_ONLY_REFUSAL
            return None
        if not self.bucket.take():
            return None
        outcome = translate(message, self.size, self.check_url)
        if isinstance(outcome, str):
            return outcome
        if outcome:
            await self.command(*outcome)
        return None


async def serve(websocket, port: int, valid: Callable[[], Awaitable[bool]], check_url=local_browser_egress.check_url, view_only: bool = False) -> None:
    """Relay until either side ends, the hold is lost (`valid` False) or no frame arrives at first."""
    import websockets

    url = await page_socket_url(port)
    if not url:
        await websocket.close(code=4404)
        return

    class Client:
        send_text = staticmethod(websocket.send_text)
        send_bytes = staticmethod(websocket.send_bytes)

    async with websockets.connect(url, max_size=8 * 1024 * 1024, open_timeout=5, origin=None, proxy=None) as cdp:
        session = Session(cdp, Client, check_url, view_only=view_only)
        await session.start()

        async def from_chrome():
            async for raw in cdp:
                await session.on_chrome(raw)

        async def from_client():
            while True:
                raw = await websocket.receive_text()
                if len(raw) > MAX_MESSAGE_BYTES:
                    await websocket.close(code=1009)
                    return
                refusal = await session.on_client(raw)
                if refusal:
                    await websocket.send_text(json.dumps({"t": "refused", "text": refusal}))

        async def revalidate():
            started = time.monotonic()
            while True:
                await asyncio.sleep(2)
                if not session.frames and time.monotonic() - started > FIRST_FRAME_SECONDS:
                    await websocket.close(code=4408)
                    return
                if not await valid():
                    await websocket.close(code=4409)
                    return

        tasks = [asyncio.create_task(fn()) for fn in (from_chrome, from_client, revalidate)]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await session.stop()
