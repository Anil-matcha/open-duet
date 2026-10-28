"""Opt-in real Chrome acceptance for the local browser (no Docker): launcher, broker, egress check.

Skipped unless a Chrome or Chromium binary and Playwright are both available. Starts one headless
Chrome against a throwaway local page and checks the whole process group is gone after release.
"""
import functools
import http.server
import importlib.util
import os
import re
import signal
import threading
import time
from pathlib import Path

import pytest

from app.computers import local_browser, local_browser_egress
from app.computers.local_browser import LocalBrowser
from app.core import engine_processes, host_exec

MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME = os.environ.get(local_browser.CHROME_ENV) or (MAC_CHROME if Path(MAC_CHROME).is_file() else local_browser.find_chrome())
pytestmark = pytest.mark.skipif(
    not CHROME or importlib.util.find_spec("playwright") is None,
    reason="Needs a Chrome or Chromium binary and the playwright package",
)

HTML = """<!doctype html><title>Local fixture</title><h1>Local fixture</h1>
<button id="count" onclick="this.textContent='Count '+(++window.n)">Count 0</button>
<script>window.n=0</script>"""


@pytest.fixture
def page(tmp_path):
    (tmp_path / "www").mkdir()
    (tmp_path / "www" / "index.html").write_text(HTML)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(tmp_path / "www"))
    handler.log_message = lambda *a, **k: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/"
    finally:
        server.shutdown()


@pytest.fixture
def browser(tmp_path, monkeypatch):
    monkeypatch.setattr(host_exec, "disabled", lambda: False)
    monkeypatch.setattr(engine_processes, "records_dir", lambda: tmp_path / "records")
    b = LocalBrowser(tmp_path / "profiles", "real-agent", chrome=CHROME, idle_seconds=120)
    try:
        yield b
    finally:
        b.release()


def call(browser, name, args=None):
    result = browser.request({"name": name, "args": args or {}, "owner": "turn-1", "epoch": 1})
    return result, "\n".join(part.get("text", "") for part in result["content"])


def group_gone(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def test_real_open_snapshot_click_and_release_kills_the_group(browser, page):
    result, text = call(browser, "browser_open", {"url": page})
    assert not result.get("isError") and "Local fixture" in text
    ref = re.search(r"\[(e[0-9a-f]+)\][^\n]*Count 0", text)[1]
    result, _ = call(browser, "browser_click", {"ref": ref})
    assert not result.get("isError")
    _, read = call(browser, "browser_read")
    assert "Count 1" in read
    pgid = browser.process.pid  # start_new_session: the broker leads its own group, Chrome is in it
    assert not group_gone(pgid)
    browser.release()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not group_gone(pgid):
        time.sleep(.1)
    assert group_gone(pgid), "broker and Chrome should be gone after release"
    assert not browser.running()


def test_the_egress_check_blocks_loopback_and_metadata_urls(page):
    # `page` is a live loopback address, the exact kind of URL a hosted agent must not open
    assert local_browser_egress.check_url(page)
    assert local_browser_egress.check_url("http://169.254.169.254/latest/meta-data/")
    assert local_browser_egress.check_url("file:///etc/passwd")
    assert local_browser_egress.check_url("https://example.com/") is None


VIEW_HTML = """<!doctype html><title>View fixture</title>
<button id="count" style="position:absolute;left:100px;top:100px;width:200px;height:100px" onclick="this.textContent='Count '+(++window.n)">Count 0</button>
<script>window.n=0</script>"""


async def test_real_live_view_streams_frames_and_relays_a_click(tmp_path, monkeypatch, page):
    """The screencast and the input relay against a real Chrome: a JPEG frame arrives, a relayed click reaches the
    page, and a navigation to a loopback address through the viewer is refused."""
    import asyncio
    import json

    import websockets

    from app.computers import local_browser_viewer as live

    (tmp_path / "www").mkdir(exist_ok=True)
    (tmp_path / "www" / "view.html").write_text(VIEW_HTML)
    monkeypatch.setattr(host_exec, "disabled", lambda: False)
    monkeypatch.setattr(engine_processes, "records_dir", lambda: tmp_path / "records")
    state = tmp_path / "state"
    b = LocalBrowser(tmp_path / "profiles", "real-viewer", chrome=CHROME, idle_seconds=120, state_dir=state)
    try:
        result, _ = await asyncio.to_thread(call, b, "browser_open", {"url": page + "view.html"})
        assert not result.get("isError")
        port = live.debug_port(state)
        assert port == b.port
        url = await live.page_socket_url(port)
        assert url

        class Client:
            def __init__(self):
                self.texts, self.binaries = [], []

            async def send_text(self, text):
                self.texts.append(json.loads(text))

            async def send_bytes(self, data):
                self.binaries.append(data)

        client = Client()
        async with websockets.connect(url, max_size=8 * 1024 * 1024, proxy=None) as cdp:
            session = live.Session(cdp, client)
            await session.start()

            async def until(condition, seconds=15):
                deadline = time.monotonic() + seconds
                while time.monotonic() < deadline and not condition():
                    try:
                        await session.on_chrome(await asyncio.wait_for(cdp.recv(), 1))
                    except asyncio.TimeoutError:
                        pass
                assert condition()

            await until(lambda: client.binaries)
            assert client.binaries[0][:2] == b"\xff\xd8" and client.texts[0]["t"] == "size"
            await session.on_client('{"t":"ack"}')  # releases Chrome to send the next frame
            for action in ("down", "up"):
                assert await session.on_client(json.dumps({"t": "mouse", "a": action, "x": 200, "y": 150, "b": "left"})) is None
            for _ in range(40):
                _, read = await asyncio.to_thread(call, b, "browser_read")
                if "Count 1" in read:
                    break
                await asyncio.sleep(.25)
            assert "Count 1" in read
            refusal = await session.on_client(json.dumps({"t": "nav", "url": page}))
            assert refusal and "view.html" not in refusal
            await session.stop()
        pgid = b.process.pid
        b.release()
        assert not (state / local_browser.CDP_FILE).exists()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not group_gone(pgid):
            await asyncio.sleep(.1)
        assert group_gone(pgid)
    finally:
        b.release()
