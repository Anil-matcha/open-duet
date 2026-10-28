"""Live view and take-over for the browser on this machine, against a fake DevTools socket."""
import asyncio
import base64
import json
import os
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete

from app.computers import local_browser_guard as guard
from app.computers import local_browser_viewer as live
from app.computers import screen
from app.computers.local_browser import CDP_FILE
from app.computers.local_browser_server import LocalServer
from app.computers.service import ComputerService, hold_dir, hold_key
from app.core.config import settings
from app.db.models import Agent
from app.routers.agents import get_runtime as agents_runtime
from app.routers.agents import router as agents_router
from app.routers.browser_viewer import router as browser_viewer_router
from app.routers.computers import get_runtime as computers_runtime
from tests.services.thread_harness import cleanup, cli, owner, rt, sessions  # noqa: F401


def allow_all(url):
    return None


def jpeg(n=100):
    return base64.b64encode(b"\xff\xd8" + b"x" * n).decode()


def frame(session, data=None, size=(1000, 600)):
    return json.dumps({"method": "Page.screencastFrame", "params": {"sessionId": session, "data": data or jpeg(), "metadata": {"deviceWidth": size[0], "deviceHeight": size[1]}}})


class FakeCdp:
    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    def methods(self):
        return [c["method"] for c in self.sent]


class FakeClient:
    def __init__(self):
        self.texts, self.binaries = [], []

    async def send_text(self, text):
        self.texts.append(json.loads(text))

    async def send_bytes(self, data):
        self.binaries.append(data)


def session(clock=lambda: 100.0, **kw):
    cdp, client, naps = FakeCdp(), FakeClient(), []

    async def sleep(seconds):
        naps.append(seconds)
    s = live.Session(cdp, client, allow_all, clock=clock, sleep=sleep, **kw)
    return s, cdp, client, naps


# -- translate ---------------------------------------------------------------------------

def tr(message, size=(1000, 600), check=allow_all):
    return live.translate(message, size, check)


def test_mouse_events_are_bounded_to_the_frame():
    assert tr({"t": "mouse", "a": "down", "x": 10, "y": 20, "b": "right"}) == ("Input.dispatchMouseEvent", {"type": "mousePressed", "x": 10, "y": 20, "button": "right", "clickCount": 1})
    assert tr({"t": "mouse", "a": "move", "x": 10.26, "y": 20})[1] == {"type": "mouseMoved", "x": 10.3, "y": 20}
    for bad in ({"x": 1001, "y": 5}, {"x": -1, "y": 5}, {"x": True, "y": 5}, {"x": "1", "y": 5}, {"x": 5}):
        assert tr({"t": "mouse", "a": "down", **bad}) is None
    assert tr({"t": "mouse", "a": "drag", "x": 1, "y": 1}) is None
    assert tr({"t": "mouse", "a": "down", "x": 1, "y": 1, "b": "back"}) is None


def test_wheel_is_clamped():
    assert tr({"t": "wheel", "x": 5, "y": 5, "dx": 0, "dy": 99999})[1]["deltaY"] == 1200


def test_keys_named_printable_and_control_combinations():
    assert tr({"t": "key", "a": "down", "key": "Enter"})[1] == {"type": "keyDown", "key": "Enter", "windowsVirtualKeyCode": 13, "modifiers": 0, "text": "\r"}
    assert tr({"t": "key", "a": "up", "key": "ArrowLeft"})[1]["type"] == "keyUp"
    assert tr({"t": "key", "a": "down", "key": "a"})[1]["text"] == "a"
    assert "text" not in tr({"t": "key", "a": "down", "key": "a", "mods": 2})[1]  # Ctrl+A types nothing
    for bad in ({"key": "F13"}, {"key": "ab"}, {"key": "\x07"}, {"key": 5}, {"key": "a", "mods": 99}, {"key": "a", "a": "tap"}):
        assert tr({"t": "key", "a": "down", **bad}) is None


def test_text_is_bounded():
    assert tr({"t": "text", "text": "hello"}) == ("Input.insertText", {"text": "hello"})
    for bad in ("", "x" * 2001, "a\x00b", 5):
        assert tr({"t": "text", "text": bad}) is None


def test_navigation_uses_the_agents_url_check():
    from app.computers import local_browser_egress
    assert tr({"t": "nav", "url": "https://example.com/"}, check=local_browser_egress.check_url) == ("Page.navigate", {"url": "https://example.com/"})
    for url in ("file:///etc/passwd", "http://127.0.0.1:8080/", "http://169.254.169.254/latest", "javascript:alert(1)", "https://u:p@example.com/"):
        refusal = tr({"t": "nav", "url": url}, check=local_browser_egress.check_url)
        assert isinstance(refusal, str) and refusal, url
    assert tr({"t": "nav", "url": "https://" + "a" * 3000}) is None


def test_anything_else_is_ignored():
    for message in (None, [], "mouse", {"t": "eval", "expression": "1"}, {"t": "mouse"}):
        assert tr(message) is None


# -- the relay ---------------------------------------------------------------------------

async def test_a_frame_reaches_the_viewer_and_chrome_waits_for_the_viewers_ack():
    s, cdp, client, naps = session()
    await s.start()
    assert cdp.methods() == ["Page.enable", "Page.startScreencast"] and cdp.sent[1]["params"]["format"] == "jpeg"
    await s.on_chrome(frame(7))
    assert client.texts == [{"t": "size", "w": 1000, "h": 600}] and client.binaries[0].startswith(b"\xff\xd8")
    assert "Page.screencastFrameAck" not in cdp.methods()  # Chrome is held until the viewer acknowledges
    await s.on_chrome(frame(8))  # a second frame while one is in flight is dropped and released at once
    assert cdp.sent[-1] == {"id": cdp.sent[-1]["id"], "method": "Page.screencastFrameAck", "params": {"sessionId": 8}} and len(client.binaries) == 1
    await s.on_client('{"t":"ack"}')
    assert cdp.sent[-1]["params"] == {"sessionId": 7}


async def test_frames_are_paced_to_the_frame_rate():
    now = [100.0]
    s, cdp, client, naps = session(clock=lambda: now[0])
    await s.on_chrome(frame(1))
    await s.on_client('{"t":"ack"}')
    assert naps == []  # the first frame is not delayed
    await s.on_chrome(frame(2))
    now[0] = 100.02
    await s.on_client('{"t":"ack"}')
    assert naps == [pytest.approx(1 / live.MAX_FPS - 0.02)]
    await s.on_chrome(frame(3))
    now[0] = 101.0
    naps.clear()
    await s.on_client('{"t":"ack"}')
    assert naps == []  # a slow viewer is not slowed further


async def test_oversize_and_corrupt_frames_are_dropped_not_forwarded():
    s, cdp, client, _ = session()
    await s.on_chrome(frame(1, data=base64.b64encode(b"x" * (live.MAX_FRAME_BYTES + 10)).decode()))
    await s.on_chrome(frame(2, data="!!not base64!!"))
    assert client.binaries == [] and s.waiting is None and s.dropped == 1
    assert [c["params"]["sessionId"] for c in cdp.sent if c["method"] == "Page.screencastFrameAck"] == [1, 2]


async def test_input_goes_to_the_page_and_a_blocked_navigation_never_does():
    from app.computers import local_browser_egress
    s, cdp, client, _ = session()
    s.check_url = local_browser_egress.check_url
    await s.on_chrome(frame(1))  # sets the frame size to 1000x600
    assert await s.on_client('{"t":"mouse","a":"down","x":999,"y":599}') is None
    assert await s.on_client('{"t":"mouse","a":"down","x":1200,"y":10}') is None  # outside the frame: ignored
    assert cdp.methods().count("Input.dispatchMouseEvent") == 1
    refusal = await s.on_client('{"t":"nav","url":"http://127.0.0.1:8080/"}')
    assert refusal and "Page.navigate" not in cdp.methods()
    assert await s.on_client('{"t":"nav","url":"https://example.com/"}') is None and cdp.methods()[-1] == "Page.navigate"
    assert await s.on_client("not json") is None


def test_input_is_rate_limited_by_dropping():
    now = [0.0]
    bucket = live.Bucket(10, clock=lambda: now[0])
    assert sum(bucket.take() for _ in range(50)) == 10
    now[0] = 0.5
    assert sum(bucket.take() for _ in range(50)) == 5


async def test_serve_relays_and_closes_when_the_hold_is_lost(monkeypatch):
    class Socket:
        def __init__(self):
            self.inbox, self.closed, self.texts, self.binaries = asyncio.Queue(), None, [], []

        async def receive_text(self):
            return await self.inbox.get()

        async def send_text(self, text):
            self.texts.append(text)

        async def send_bytes(self, data):
            self.binaries.append(data)

        async def close(self, code=1000):
            self.closed = code

    class Page:
        def __init__(self):
            self.sent, self.queue = [], asyncio.Queue()
            self.queue.put_nowait(frame(1))

        async def send(self, raw):
            self.sent.append(json.loads(raw))

        def __aiter__(self):
            return self

        async def __anext__(self):
            return await self.queue.get()

    page = Page()

    class Connect:
        async def __aenter__(self):
            return page

        async def __aexit__(self, *exc):
            return False

    async def url(port):
        return f"ws://127.0.0.1:{port}/devtools/page/abc"

    seen = {}
    import websockets
    monkeypatch.setattr(websockets, "connect", lambda u, **kw: seen.update(url=u, **kw) or Connect())
    monkeypatch.setattr(live, "page_socket_url", url)
    real_sleep = asyncio.sleep
    monkeypatch.setattr(live.asyncio, "sleep", lambda s: real_sleep(0))  # the 2-second revalidation tick runs at once
    socket, valid = Socket(), [True]

    async def check():
        return valid[0]

    task = asyncio.create_task(live.serve(socket, 9222, check, allow_all))
    for _ in range(50):
        await asyncio.sleep(0)
        if socket.binaries:
            break
    assert socket.binaries and seen["url"] == "ws://127.0.0.1:9222/devtools/page/abc"
    socket.inbox.put_nowait('{"t":"key","a":"down","key":"x"}')
    for _ in range(50):
        await asyncio.sleep(0)
    assert any(c["method"] == "Input.dispatchKeyEvent" for c in page.sent)
    valid[0] = False
    await asyncio.wait_for(task, 5)
    assert socket.closed == 4409 and page.sent[-1]["method"] == "Page.stopScreencast"


# -- finding the page --------------------------------------------------------------------

def test_the_debug_port_is_only_known_for_a_live_browser(tmp_path):
    assert live.debug_port(tmp_path) is None
    (tmp_path / CDP_FILE).write_text(json.dumps({"port": 9333, "pid": os.getpid()}))
    assert live.debug_port(tmp_path) == 9333
    (tmp_path / CDP_FILE).write_text(json.dumps({"port": 9333, "pid": 2 ** 22 + 12345}))
    assert live.debug_port(tmp_path) is None
    (tmp_path / CDP_FILE).write_text(json.dumps({"port": 70000, "pid": os.getpid()}))
    assert live.debug_port(tmp_path) is None
    (tmp_path / CDP_FILE).write_text("garbage")
    assert live.debug_port(tmp_path) is None


async def test_the_page_address_is_built_from_loopback_and_the_port_never_the_reported_host(monkeypatch):
    targets = [{"type": "service_worker", "id": "sw"}, {"type": "page", "id": "A1B2", "webSocketDebuggerUrl": "ws://evil.example:1/devtools/page/A1B2"}]

    class Client:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url):
            assert url == "http://127.0.0.1:9444/json/list"
            return httpx.Response(200, json=targets)

    monkeypatch.setattr(live.httpx, "AsyncClient", Client)
    assert await live.page_socket_url(9444) == "ws://127.0.0.1:9444/devtools/page/A1B2"
    targets[1]["id"] = "../x"
    assert await live.page_socket_url(9444) is None


# -- hold keys and folders ---------------------------------------------------------------

def test_hold_keys_map_computers_and_browsers_to_their_folders():
    assert hold_dir(5) == "5" and hold_dir(-7) == "browser-7"
    assert hold_key("5") == 5 and hold_key("browser-7") == -7 and hold_key("browser-x") is None and hold_key("grants") is None


# -- the hold over HTTP ------------------------------------------------------------------

@pytest.fixture(autouse=True)
def local_enabled(monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    monkeypatch.setattr(settings, "LOCAL_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")


@pytest.fixture(autouse=True)
async def rows_cleanup(sessions, owner):  # noqa: F811
    yield
    async with sessions() as db:
        await db.execute(delete(Agent).where(Agent.owner_id == owner))
        await db.commit()


@pytest.fixture
async def api(rt, cli, tmp_path):  # noqa: F811
    rt.computers = ComputerService(providers={}, owner_id=rt.owner_id, root=tmp_path / "computers", _session_factory=rt.session)
    app = FastAPI()
    for router, dependency in ((agents_router, agents_runtime), (browser_viewer_router, computers_runtime)):
        app.include_router(router, prefix="/api/v1")
        app.dependency_overrides[dependency] = lambda: rt
    transport = httpx.ASGITransport(app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        client.service = rt.computers
        yield client


async def new_agent(api):
    response = await api.post("/api/v1/agents", json={"name": "Agent " + uuid4().hex[:6]})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def run_browser(service, agent_id):
    folder = live.state_folder(service.state_dir(), agent_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / CDP_FILE).write_text(json.dumps({"port": 9555, "pid": os.getpid()}))
    return folder


async def test_no_hold_while_the_browser_is_off_or_not_running(api, monkeypatch):
    agent = await new_agent(api)
    url = f"/api/v1/agents/{agent}/browser/control"
    off = await api.post(url, json={"action": "take"})
    assert off.status_code == 409 and off.json()["detail"]["error_code"] == "browser_off"
    monkeypatch.setattr(settings, "LOCAL_BROWSER_ENABLED", True)
    idle = await api.post(url, json={"action": "take"})
    assert idle.status_code == 409 and idle.json()["detail"]["error_code"] == "browser_not_running"
    assert (await api.post("/api/v1/agents/99999999/browser/control", json={"action": "take"})).status_code == 404


async def test_taking_control_holds_the_browser_so_the_agent_is_refused_and_the_guard_keeps_it(api, monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "LOCAL_BROWSER_ENABLED", True)
    service = api.service
    agent = await new_agent(api)
    folder = run_browser(service, agent)
    taken = (await api.post(f"/api/v1/agents/{agent}/browser/control", json={"action": "take"})).json()
    assert taken["owned"] and len(taken["lease_id"]) == 64 and taken["ticket"]
    assert screen.held(folder)  # the agent's tool server reads this file
    assert not screen.held(folder.parent / "browser-other")
    # While held, the agent's browser call is refused with the take-over message.
    server = LocalServer(tmp_path / "grants", folder, local=None)
    assert server.run("browser_snapshot", {})["content"][0]["text"] == screen.CONTROL_REFUSAL
    # A watched browser is never the one ended to make room.
    registry = tmp_path / "running"
    guard.register(registry, "agent-" + str(agent), os.getpid(), folder)
    refusal = guard.make_room(registry, "someone-else", 1, held=screen.held, kill=lambda pid: pytest.fail("ended a watched browser"))
    assert refusal and "being watched" in refusal
    # A second view cannot take it; the owner's heartbeat keeps it; release lets go and the agent can drive again.
    other = (await api.post(f"/api/v1/agents/{agent}/browser/control", json={"action": "take"})).json()
    assert other["owned"] is False and "ticket" not in other
    beat = await api.post(f"/api/v1/agents/{agent}/browser/control/heartbeat", json={"lease_id": taken["lease_id"]})
    assert beat.status_code == 204
    assert (await api.post(f"/api/v1/agents/{agent}/browser/control/heartbeat", json={"lease_id": "0" * 64})).status_code == 409
    released = (await api.post(f"/api/v1/agents/{agent}/browser/control", json={"action": "release", "lease_id": taken["lease_id"]})).json()
    assert released["released"] and not screen.held(folder)


async def test_a_stale_browser_hold_file_is_removed_when_the_registry_lost_it(api, monkeypatch):
    service = api.service
    folder = service.state_dir() / "browser-4"
    folder.mkdir(parents=True)
    service._control_initialized = True
    screen.write_state(folder / "control.json", {"until": 9e12})
    service.expire_control()
    assert not (folder / "control.json").exists()


async def test_the_ticket_is_bound_to_the_browser_and_single_use(api, monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_BROWSER_ENABLED", True)
    service = api.service
    agent = await new_agent(api)
    run_browser(service, agent)
    taken = (await api.post(f"/api/v1/agents/{agent}/browser/control", json={"action": "take"})).json()
    manager = service.viewers
    who = ("loopback", None)
    assert manager.consume(taken["ticket"], -agent - 1, who) is None  # another agent's browser
    # (the failed consume spent it: a ticket never works twice)
    assert manager.consume(taken["ticket"], -agent, who) is None
