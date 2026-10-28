"""The local browser: launcher lifecycle, gating and the browser-only MCP server, against a fake broker."""
import json
import os
import signal
import sys
import time
from pathlib import Path

import pytest

from app.computers import browser, grants, local_browser, screen
from app.computers.local_browser import LocalBrowser, LocalBrowserError
from app.computers.local_browser_server import LocalServer
from app.core import engine_processes, host_exec

FAKE = Path(__file__).with_name("fake_broker.py")


@pytest.fixture
def local(tmp_path, monkeypatch):
    chrome = tmp_path / "fake-chrome"
    chrome.write_text("#!/bin/sh\n")
    chrome.chmod(0o755)
    monkeypatch.setenv(local_browser.BROKER_ENV, str(FAKE))
    monkeypatch.setenv(local_browser.CHROME_ENV, str(chrome))
    monkeypatch.delenv("HOST_EXECUTION_DISABLED", raising=False)
    monkeypatch.setattr(host_exec, "disabled", lambda: False)
    monkeypatch.setattr(engine_processes, "records_dir", lambda: tmp_path / "records")
    browsers = []

    def make(agent="agent-1", **kw):
        b = LocalBrowser(tmp_path / "profiles", agent, **kw)
        browsers.append(b)
        return b
    yield make
    for b in browsers:
        b.release()


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        return not engine_processes.process_info(pid).zombie
    except AttributeError:
        return False


def seen(b):
    return json.loads((b.runtime / "seen.json").read_text())


def test_start_uses_private_profile_loopback_port_and_own_session(local, tmp_path):
    b = local(proxy_server="socks5://127.0.0.1:9")
    result = b.request({"name": "browser_snapshot", "args": {}, "owner": "t", "epoch": 0})
    assert result["content"][0]["text"].startswith("ok ")
    info = seen(b)
    env = info["env"]
    assert env["OD_BROWSER_PROFILE"] == str(tmp_path / "profiles" / "agent-1")
    assert oct((tmp_path / "profiles" / "agent-1").stat().st_mode & 0o777) == "0o700"
    assert 1024 < int(env["OD_BROWSER_PORT"]) < 65536 and env["OD_BROWSER_HEADLESS"] == "1"
    assert env["OD_BROWSER_PROXY"] == "socks5://127.0.0.1:9"
    assert info["pgid"] == b.process.pid != os.getpgrp()  # its own session and group
    assert info["marker"]  # engine_processes marker, for the orphan sweep
    assert (tmp_path / "records" / f"{b.process.pid}.json").exists()


def test_profiles_and_sockets_are_per_agent(local):
    a, b = local("a"), local("b")
    a.start(); b.start()
    assert a.profile != b.profile and a.socket_path != b.socket_path and a.port != b.port


def test_release_kills_the_whole_group_and_forgets(local, tmp_path):
    b = local()
    b.request({"name": "browser_snapshot", "args": {}, "owner": "t", "epoch": 0})
    child, pid, runtime = seen(b)["child"], b.process.pid, b.runtime
    assert alive(child)
    b.release()
    for _ in range(50):
        if not alive(child):
            break
        time.sleep(.1)
    assert not alive(child) and not alive(pid)
    assert not runtime.exists() and not (tmp_path / "records" / f"{pid}.json").exists()
    b.release()  # twice is fine


def test_a_dead_broker_is_started_again(local):
    b = local()
    b.start()
    first = b.process.pid
    os.killpg(first, signal.SIGKILL)
    b.process.wait()
    b.request({"name": "browser_snapshot", "args": {}, "owner": "t", "epoch": 0})
    assert b.process.pid != first


def test_refused_when_host_execution_is_disabled(local, monkeypatch):
    monkeypatch.setattr(host_exec, "disabled", lambda: True)
    b = local()
    with pytest.raises(host_exec.HostExecutionDisabled):
        b.start()
    assert b.process is None and b.runtime is None


def test_missing_chrome_or_broker_and_bad_agent(local, monkeypatch, tmp_path):
    monkeypatch.delenv(local_browser.CHROME_ENV)
    monkeypatch.setattr(local_browser.shutil, "which", lambda name: None)
    with pytest.raises(LocalBrowserError, match="No Chrome"):
        local().start()
    monkeypatch.setenv(local_browser.CHROME_ENV, "/bin/true")
    monkeypatch.setenv(local_browser.BROKER_ENV, str(tmp_path / "nope"))
    with pytest.raises(LocalBrowserError, match="broker"):
        local().start()
    with pytest.raises(LocalBrowserError):
        local("../escape")


def test_sandbox_decision_is_recorded(local, monkeypatch):
    monkeypatch.setattr(local_browser, "sandbox_usable", lambda: False)
    b = local()
    b.start()
    assert b.no_sandbox is True and seen(b)["env"]["OD_BROWSER_NO_SANDBOX"] == "1"
    b.release()
    monkeypatch.setattr(local_browser, "sandbox_usable", lambda: True)
    b.start()
    assert b.no_sandbox is False and seen(b)["env"]["OD_BROWSER_NO_SANDBOX"] == "0"


# -- the MCP server ---------------------------------------------------------------------------


@pytest.fixture
def server(local, tmp_path):
    return LocalServer(tmp_path / "grants", tmp_path / "state", local(), "turn-1")


def permit(server, name, args):
    grants.issue(server.grants_dir, name, args)


def test_only_browser_tools_are_listed_and_callable(server):
    names = {t["name"] for t in server.handle({"id": 1, "method": "tools/list"})["result"]["tools"]}
    assert names == set(browser.DEFINITIONS)
    for other in ("exec", "read_file", "write_file", "click", "screenshot"):
        assert server.call(other, {})["isError"]
    assert server.handle({"id": 2, "method": "initialize", "params": {}})["result"]["serverInfo"]["name"] == "open-dots-browser"
    assert server.handle({"id": 3, "method": "nope"})["error"]["code"] == -32601


def test_a_call_needs_an_exact_one_use_permit(server):
    args = {"url": "https://example.com"}
    assert server.call("browser_open", args)["isError"]  # no permit: nothing started
    assert server.local.process is None
    permit(server, "browser_open", args)
    assert "isError" not in server.call("browser_open", args)
    assert server.call("browser_open", args)["isError"]  # spent
    permit(server, "browser_open", args)
    assert server.call("browser_open", {"url": "https://other.example"})["isError"]  # not that one


def test_invalid_arguments_are_refused_before_a_permit_is_used(server):
    permit(server, "browser_click", {})
    assert server.call("browser_click", {})["isError"]
    assert grants.consume(server.grants_dir, "browser_click", {})


def test_url_check_hook_can_refuse_an_address(local, tmp_path):
    s = LocalServer(tmp_path / "g", tmp_path / "s", local(), "t", url_check=lambda u: "Blocked address." if "169.254" in u else None)
    permit(s, "browser_open", {"url": "http://169.254.169.254/"})
    out = s.call("browser_open", {"url": "http://169.254.169.254/"})
    assert out["isError"] and "Blocked" in out["content"][0]["text"]
    assert s.local.process is None
    assert grants.consume(s.grants_dir, "browser_open", {"url": "http://169.254.169.254/"})  # not spent


def test_take_over_and_other_conversation_refuse(server):
    permit(server, "browser_snapshot", {})
    screen.write_state(server.state_dir / "control.json", {"until": time.time() + 60})
    out = server.call("browser_snapshot", {})
    assert out["isError"] and out["content"][0]["text"] == screen.CONTROL_REFUSAL
    screen.write_state(server.state_dir / "control.json", {"until": 0})
    screen.write_state(server.state_dir / "screen-owner.json", {"turn_id": "other", "until": time.time() + 60})
    permit(server, "browser_click", {"selector": "a"})
    out = server.call("browser_click", {"selector": "a"})
    assert out["content"][0]["text"] == screen.BUSY_REFUSAL
    assert server.local.process is None


def test_input_counts_against_the_action_limit_and_reads_do_not(local, tmp_path):
    s = LocalServer(tmp_path / "g", tmp_path / "s", local(), "t", max_actions=1)
    for _ in range(3):
        permit(s, "browser_snapshot", {})
        assert "isError" not in s.call("browser_snapshot", {})
    for expected_error in (False, True):
        permit(s, "browser_click", {"selector": "a"})
        assert bool(s.call("browser_click", {"selector": "a"}).get("isError")) is expected_error
    assert s.screen.actions == 1


def test_request_carries_turn_owner_and_epoch(server):
    screen.write_state(server.state_dir / "browser-epoch.json", {"at": 42})
    permit(server, "browser_snapshot", {})
    text = server.call("browser_snapshot", {})["content"][0]["text"]
    sent = json.loads(text[3:])
    assert sent["owner"] == "turn-1" and sent["epoch"] == 42 and sent["name"] == "browser_snapshot"
    assert json.loads((server.state_dir / "last-command.json").read_text())["tool"] == "browser_snapshot"


def test_broker_failure_is_a_plain_error(server, monkeypatch, tmp_path):
    permit(server, "browser_snapshot", {})
    server.local.start()
    os.killpg(server.local.process.pid, signal.SIGKILL)
    server.local.process.wait()
    server.local.socket_path.unlink(missing_ok=True)
    monkeypatch.setenv(local_browser.BROKER_ENV, str(tmp_path / "missing"))
    out = server.call("browser_snapshot", {})
    assert out["isError"] and "unavailable" in out["content"][0]["text"].lower()


def test_main_runs_over_stdio_and_releases_the_browser_at_end(local, tmp_path):
    import subprocess
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[2]), "HOST_EXECUTION_DISABLED": "",
           local_browser.BROKER_ENV: os.environ[local_browser.BROKER_ENV], local_browser.CHROME_ENV: os.environ[local_browser.CHROME_ENV]}
    grants_dir = tmp_path / "grants"
    grants.issue(grants_dir, "browser_snapshot", {})
    requests = "".join(json.dumps(r) + "\n" for r in (
        {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "browser_snapshot", "arguments": {}}},
    ))
    done = subprocess.run(
        [sys.executable, "-m", "app.computers.local_browser_server", "--grants", str(grants_dir), "--state", str(tmp_path / "st"),
         "--profiles", str(tmp_path / "pr"), "--agent", "a1", "--turn-id", "t"],
        input=requests, capture_output=True, text=True, timeout=60, env=env, cwd=Path(__file__).parents[2])
    assert done.returncode == 0, done.stderr
    replies = {r["id"]: r for r in map(json.loads, done.stdout.splitlines())}
    assert len(replies[1]["result"]["tools"]) == len(browser.TOOLS)
    assert replies[2]["result"]["content"][0]["text"].startswith("ok ")


def test_main_starts_and_stops_the_egress_gate(tmp_path, monkeypatch):
    from app.computers import local_browser_server as lbs

    seen = {}

    class FakeLocal:
        def __init__(self, profiles, agent, proxy_server=None, idle_seconds=0, **_):
            seen["proxy"] = proxy_server

        def release(self):
            seen["released"] = True

    monkeypatch.setattr(lbs, "LocalBrowser", FakeLocal)
    monkeypatch.setattr("sys.stdin", [])
    code = lbs.main(["--grants", str(tmp_path / "g"), "--state", str(tmp_path / "s"), "--profiles", str(tmp_path / "p"), "--agent", "a"])
    assert code == 0 and seen["released"]
    assert seen["proxy"].startswith("127.0.0.1:")


def test_find_chrome_skips_a_match_that_does_not_run(monkeypatch, tmp_path):
    from app.computers import local_browser as lb

    bad, good = tmp_path / "bad", tmp_path / "good"
    for path, code in ((bad, 1), (good, 0)):
        path.write_text(f"#!/bin/sh\nexit {code}\n")
        path.chmod(0o755)
    monkeypatch.delenv(lb.CHROME_ENV, raising=False)
    monkeypatch.setattr(lb, "CHROME_NAMES", ("bad", "good"))
    monkeypatch.setenv("PATH", str(tmp_path))
    assert lb.find_chrome() == str(good)


def test_the_debug_port_is_published_for_the_live_view_and_removed_on_release(local, tmp_path):
    state = tmp_path / "state"
    b = local(state_dir=state)
    b.start()
    record = json.loads((state / local_browser.CDP_FILE).read_text())
    assert record == {"port": b.port, "pid": b.process.pid} and oct((state / local_browser.CDP_FILE).stat().st_mode & 0o777) == "0o600"
    b.release()
    assert not (state / local_browser.CDP_FILE).exists()


def test_sandbox_is_unusable_when_the_namespace_call_is_refused(monkeypatch):
    from app.computers import local_browser as lb

    monkeypatch.setattr(lb.sys, "platform", "linux")
    monkeypatch.setattr(lb.os, "geteuid", lambda: 1000, raising=False)
    monkeypatch.setattr(lb, "_can_make_user_namespace", lambda: False)
    assert lb.sandbox_usable() is False
    monkeypatch.setattr(lb, "_can_make_user_namespace", lambda: True)
    assert lb.sandbox_usable() is True
