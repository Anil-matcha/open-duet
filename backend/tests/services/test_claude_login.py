"""Real bounded child processes; no provider account or credentials."""
import asyncio
import os
import sys

import pytest

from app.services import claude_login

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX executable fixture")


@pytest.fixture
async def login(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_login, "child_env", lambda: {**os.environ, "CLAUDE_CONFIG_DIR": str(tmp_path)})
    script = tmp_path / "fake-claude"
    script.write_text(f'''#!{sys.executable}
import os, pathlib, sys, time
home = pathlib.Path(os.environ["CLAUDE_CONFIG_DIR"])
if sys.argv[1:] == ["auth", "status", "--json"]:
    if (home / "account").exists():
        print('{{"loggedIn": true}}')
        sys.exit(0)
    print('{{"loggedIn": false}}')
    sys.exit(1)
assert sys.argv[1:] == ["auth", "login"]
(home / "pid").write_text(str(os.getpid()))
mode = (home / "mode").read_text() if (home / "mode").exists() else "wait"
if mode == "overflow":
    print("SECRET_PROVIDER_TEXT" * 2000, flush=True)
else:
    target = "https://attacker.example/oauth/authorize?state=test" if mode == "forged" else "https://claude.ai/oauth/authorize?state=test"
    for fragment in ["\\x1b[3", "2m" + target, "\\x1b[0m\\nEnter code AB12-", "CDE34\\n"]:
        sys.stderr.write(fragment)
        sys.stderr.flush()
        time.sleep(.01)
code = sys.stdin.readline().strip()
(home / "received").write_text(code)
(home / "account").write_text("private-token-never-returned")
''')
    script.chmod(0o700)
    manager = claude_login.ClaudeLogin()
    yield manager, script, tmp_path
    await manager.close()


async def until(manager, flow, predicate):
    async with asyncio.timeout(5):
        while True:
            result = manager.view("browser:1", flow["id"])
            if predicate(result):
                return result
            await asyncio.sleep(.01)


async def test_private_code_and_confirmed_success(login):
    manager, script, home = login
    flow = await manager.start("browser:1", script)
    waiting = await until(manager, flow, lambda s: "authorization_url" in s)
    assert waiting["authorization_url"] == "https://claude.ai/oauth/authorize?state=test"
    with pytest.raises(KeyError):
        manager.view("browser:2", flow["id"])
    with pytest.raises(KeyError):
        await manager.cancel("browser:2", flow["id"])
    with pytest.raises(claude_login.LoginError):
        await manager.start("browser:2", script)
    with pytest.raises(KeyError):
        await manager.complete("browser:2", flow["id"], "private-code123")
    with pytest.raises(claude_login.LoginError):
        await manager.complete("browser:1", flow["id"], "bad\ncode")
    sent = await asyncio.gather(*[manager.complete("browser:1", flow["id"], "private-code123") for _ in range(2)], return_exceptions=True)
    assert sum(isinstance(result, claude_login.LoginError) for result in sent) == 1
    result = await until(manager, flow, lambda s: s["phase"] != "running")
    assert result == {"id": flow["id"], "phase": "succeeded"}
    assert "private-token" not in str(result)


async def test_cancel_kills_child_and_releases_home_lock(login):
    manager, script, home = login
    flow = await manager.start("browser:1", script)
    await until(manager, flow, lambda s: "authorization_url" in s)
    other = claude_login.ClaudeLogin()
    with pytest.raises(claude_login.LoginError):
        await other.start("browser:2", script)
    pid = int((home / "pid").read_text())
    await manager.cancel("browser:1", flow["id"])
    assert manager.view("browser:1", flow["id"])["phase"] == "cancelled"
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    await other.start("browser:2", script)
    await other.close()


async def test_cancel_before_worker_starts_does_not_leak_lock(login):
    manager, script, home = login
    await manager.start("browser:1", script)
    await manager.close()
    await manager.start("browser:1", script)
    await manager.close()


async def test_expiry_kills_child_and_scrubs_code(login, monkeypatch):
    manager, script, home = login
    processes = []
    actual_spawn = asyncio.create_subprocess_exec
    async def capture_spawn(*args, **kwargs):
        process = await actual_spawn(*args, **kwargs)
        if "login" in args:
            processes.append(process)
        return process
    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_spawn)
    manager.lifetime = 1.5
    flow = await manager.start("browser:1", script)
    result = await until(manager, flow, lambda s: s["phase"] != "running")
    assert result["phase"] == "expired"
    assert "authorization_url" not in result
    assert len(processes) == 1
    assert processes[0].returncode is not None
    with pytest.raises(ProcessLookupError):
        os.kill(processes[0].pid, 0)


async def test_forged_url_is_never_exposed(login):
    manager, script, home = login
    manager.prompt_timeout = .2
    (home / "mode").write_text("forged")
    flow = await manager.start("browser:1", script)
    result = await until(manager, flow, lambda s: s["phase"] != "running")
    assert result["phase"] == "expired"
    assert "authorization_url" not in result


async def test_overflow_failure_never_echoes_output(login):
    manager, script, home = login
    (home / "mode").write_text("overflow")
    flow = await manager.start("browser:1", script)
    result = await until(manager, flow, lambda s: s["phase"] != "running")
    assert result["phase"] == "failed"
    assert "SECRET_PROVIDER_TEXT" not in str(result)


async def test_existing_login_is_preserved(login):
    manager, script, home = login
    (home / "account").write_text("previous-account")
    flow = await manager.start("browser:1", script)
    result = await until(manager, flow, lambda s: s["phase"] != "running")
    assert result["phase"] == "succeeded"
    assert not (home / "pid").exists()
    assert (home / "account").read_text() == "previous-account"


async def test_cancel_during_process_creation_reaps_child(login, monkeypatch):
    manager, script, home = login
    started = asyncio.Event()
    release_spawn = asyncio.Event()
    processes = []
    actual_spawn = asyncio.create_subprocess_exec
    async def delayed_spawn(*args, **kwargs):
        process = await actual_spawn(*args, **kwargs)
        if "login" in args:
            processes.append(process)
            started.set()
            await release_spawn.wait()
        return process
    monkeypatch.setattr(asyncio, "create_subprocess_exec", delayed_spawn)
    flow = await manager.start("browser:1", script)
    await asyncio.wait_for(started.wait(), 3)
    closing = asyncio.create_task(manager.close())
    # Yield to close() so cancellation arrives while OS creation is pending.
    await asyncio.sleep(0)
    assert manager.task.cancelling()
    release_spawn.set()
    await asyncio.gather(closing, manager.close())
    assert manager.view("browser:1", flow["id"])["phase"] == "cancelled"
    assert len(processes) == 1
    assert processes[0].returncode is not None
    with pytest.raises(ProcessLookupError):
        os.kill(processes[0].pid, 0)


@pytest.mark.parametrize("url", [
    "https://claude.ai.attacker.example/oauth/authorize?a=b\n",
    "https://claude.ai@attacker.example/oauth/authorize?a=b\n",
    "https://claude.ai/oauth/authorize?a=b",
    "https://claude.ai:444/oauth/authorize?a=b\n",
    "https://claude.ai/other?a=b\n",
    "https://claude.com/a/b/oauth/authorize?a=b\n",
    "https://claude.com/cai/oauth/authorizeX?a=b\n",
])
def test_untrusted_or_partial_links_are_rejected(url):
    assert claude_login.authorization_url(url) is None


@pytest.mark.parametrize("url", [
    "https://claude.com/cai/oauth/authorize?code=true&state=s\n",
    "https://claude.com/oauth/authorize?code=true&state=s\n",
])
def test_current_and_older_cli_links_are_accepted(url):
    assert claude_login.authorization_url(url) == url.strip()


async def test_unknown_status_does_not_replace_account(login):
    manager, script, home = login
    script.write_text(f"#!{sys.executable}\nprint('unknown-private-provider-output')\n")
    flow = await manager.start("browser:1", script)
    result = await until(manager, flow, lambda s: s["phase"] != "running")
    assert result["phase"] == "failed"
    assert "private-provider-output" not in str(result)
    assert not (home / "pid").exists()
