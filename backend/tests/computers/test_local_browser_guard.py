"""The browser's resource limits: caps, memory, eviction and OOM protection, with fakes for the machine."""
import json
import os
import subprocess
import sys

import pytest

from app.computers import grants, local_browser, local_browser_guard as guard
from app.computers.local_browser import LocalBrowserError
from app.computers.local_browser_server import LocalServer
from tests.computers.test_local_browser import FAKE, local, permit  # noqa: F401  (fixtures)

MB = 1024 * 1024


def test_limits_default_to_the_stricter_caps(monkeypatch):
    monkeypatch.delenv(guard.SIZE_ENV, raising=False)
    assert guard.limits() == guard.Limits(1, 4, None)
    assert guard.limits("default") == guard.Limits(4, 8, None)
    assert guard.limits("large", hosted=True) == guard.Limits(4, 8, 180)
    monkeypatch.setenv(guard.SIZE_ENV, "default")
    assert guard.limits().tabs == 8


def test_memory_state_reads_cgroup_then_meminfo(tmp_path):
    cg = tmp_path / "cg"
    cg.mkdir()
    info = tmp_path / "meminfo"
    info.write_text("MemTotal:  4000000 kB\nMemAvailable:  1000000 kB\n")
    assert guard.memory_state(cg, info) == (1_000_000 * 1024, 4_000_000 * 1024)  # no cgroup files
    (cg / "memory.max").write_text("max\n")
    assert guard.memory_state(cg, info)[1] == 4_000_000 * 1024  # unlimited cgroup
    (cg / "memory.max").write_text(str(2000 * MB))
    (cg / "memory.current").write_text(str(500 * MB))
    assert guard.memory_state(cg, info) == (1500 * MB, 2000 * MB)
    assert guard.memory_state(tmp_path / "none", tmp_path / "none") is None


@pytest.mark.parametrize("available,total,low", [
    (511 * MB, 100_000 * MB, True), (600 * MB, 8000 * MB, True),  # under 512 MB; under 12% of 8 GB
    (1000 * MB, 8000 * MB, False), (2000 * MB, 4000 * MB, False),
])
def test_memory_low(available, total, low):
    assert guard.memory_low((available, total)) is low
    assert guard.memory_low(None) is False


def test_tab_cap_message():
    assert guard.check_tabs(3, 4) is None
    assert "at most 4" in guard.check_tabs(4, 4)
    assert guard.opens_page("browser_open", {}) and guard.opens_page("browser_tabs", {"action": "new"})
    assert not guard.opens_page("browser_tabs", {"action": "list"}) and not guard.opens_page("browser_click", {})


def test_protect_app_writes_the_score_and_never_raises(tmp_path):
    proc = tmp_path / "proc"
    (proc / "42").mkdir(parents=True)
    (proc / "42" / "oom_score_adj").write_text("0")
    assert guard.protect_app(42, proc=proc) is True
    assert (proc / "42" / "oom_score_adj").read_text() == str(guard.OOM_SCORE)
    assert guard.protect_app(43, proc=proc) is False


def live_pid():
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])


def test_registry_drops_dead_and_evicts_least_recently_used(tmp_path):
    reg = tmp_path / "reg"
    a, b = live_pid(), live_pid()
    try:
        guard.register(reg, "a", a.pid, tmp_path / "sa", now=100)
        guard.register(reg, "b", b.pid, tmp_path / "sb", now=200)
        guard.register(reg, "dead", 2**22 + 7, tmp_path / "sd", now=1)
        assert set(guard.running(reg)) == {"a", "b"}
        killed = []
        assert guard.make_room(reg, "c", 2, kill=killed.append) is None
        assert killed == [a.pid] and set(guard.running(reg)) == {"b"}
    finally:
        a.kill(); b.kill()


def test_a_watched_browser_is_not_evicted(tmp_path):
    reg = tmp_path / "reg"
    a = live_pid()
    try:
        guard.register(reg, "a", a.pid, tmp_path / "sa", now=1)
        killed = []
        message = guard.make_room(reg, "b", 1, held=lambda state: True, kill=killed.append)
        assert "at most 1 browser" in message and not killed
        assert guard.make_room(reg, "a", 1, held=lambda state: True) is None  # its own entry never counts
    finally:
        a.kill()


def test_launcher_registers_evicts_and_unregisters(local, tmp_path):  # noqa: F811
    reg = tmp_path / "reg"
    first = local("agent-1", registry=reg, state_dir=tmp_path / "s1", max_browsers=1)
    first.start()
    assert set(guard.running(reg)) == {"agent-1"}
    second = local("agent-2", registry=reg, state_dir=tmp_path / "s2", max_browsers=1)
    second.start()
    first.process.wait(timeout=10)  # the older, idle one was ended to make room
    assert set(guard.running(reg)) == {"agent-2"}
    watched = local("agent-3", registry=reg, state_dir=tmp_path / "s3", max_browsers=1, held=lambda state: True)
    with pytest.raises(LocalBrowserError, match="at most 1 browser"):
        watched.start()
    second.release()
    assert guard.running(reg) == {}


def test_launcher_raises_the_oom_score(local, tmp_path, monkeypatch):  # noqa: F811
    calls = []
    monkeypatch.setattr(guard, "protect_app", lambda pid, *a, **k: calls.append(pid) or True)
    b = local("agent-1")
    b.start()
    assert calls == [b.process.pid]


@pytest.fixture
def guarded(local, tmp_path):  # noqa: F811
    return LocalServer(tmp_path / "grants", tmp_path / "state", local(), "turn-1", max_tabs=2)


def test_low_memory_refuses_a_new_page_before_a_permit_is_spent(guarded, monkeypatch):
    monkeypatch.setattr(guard, "memory_state", lambda: (100 * MB, 4000 * MB))
    args = {"url": "https://example.com"}
    permit(guarded, "browser_open", args)
    reply = guarded.call("browser_open", args)
    assert reply["isError"] and "low on memory" in reply["content"][0]["text"]
    assert guarded.local.process is None
    monkeypatch.setattr(guard, "memory_state", lambda: (3000 * MB, 4000 * MB))
    assert "isError" not in guarded.call("browser_open", args)  # the permit was kept


def test_tab_cap_refuses_open_and_new_tab_but_not_other_tools(guarded, monkeypatch):
    monkeypatch.setattr(guard, "memory_state", lambda: None)
    guarded.local.start()
    tabs = json.dumps({"tabs": [{"tab": "1"}, {"tab": "2"}]})
    real = guarded.local.request

    def request(payload):
        if payload["name"] == "browser_tabs" and payload["args"]["action"] == "list":
            return {"content": [{"type": "text", "text": "UNTRUSTED PAGE CONTENT\n" + tabs}]}
        return real(payload)
    monkeypatch.setattr(guarded.local, "request", request)
    for name, args in (("browser_open", {"url": "https://example.com"}), ("browser_tabs", {"action": "new"})):
        permit(guarded, name, args)
        reply = guarded.call(name, args)
        assert reply["isError"] and "at most 2 browser tabs" in reply["content"][0]["text"]
    permit(guarded, "browser_snapshot", {})
    assert "isError" not in guarded.call("browser_snapshot", {})
    permit(guarded, "browser_tabs", {"action": "list"})
    assert "isError" not in guarded.call("browser_tabs", {"action": "list"})
