"""Real disposable CLI processes, never provider accounts."""

import asyncio
import os
import sys

import pytest

from app.services import engine_logout
from app.services.claude_login import ClaudeLogin
from app.services.codex_login import CodexLogin, LoginError

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX executable fixture")


@pytest.fixture(params=["claude", "codex"])
async def account(request, tmp_path, monkeypatch):
    engine = request.param
    variable = "CODEX_HOME" if engine == "codex" else "CLAUDE_CONFIG_DIR"
    monkeypatch.setattr(engine_logout, "child_env", lambda: {**os.environ, variable: str(tmp_path)})
    script = tmp_path / "fake-cli"
    script.write_text(f'''#!{sys.executable}
import os, pathlib, sys, time
home = pathlib.Path(os.environ[{variable!r}])
if "logout" in sys.argv:
    (home / "pid").write_text(str(os.getpid()))
    mode = (home / "mode").read_text() if (home / "mode").exists() else "success"
    if mode == "wait":
        time.sleep(60)
    if mode == "fail":
        print("PRIVATE_PROVIDER_OUTPUT", file=sys.stderr)
        sys.exit(2)
    if mode != "unchanged":
        (home / "account").unlink(missing_ok=True)
    sys.exit(0)
signed_in = (home / "account").exists()
if {engine!r} == "claude":
    print('{{"loggedIn": true}}' if signed_in else '{{"loggedIn": false}}')
else:
    print("Logged in using ChatGPT" if signed_in else "Not logged in", file=sys.stderr)
sys.exit(0 if signed_in else 1)
''')
    script.chmod(0o700)
    (tmp_path / "account").write_text("synthetic-account")
    manager = CodexLogin() if engine == "codex" else ClaudeLogin()
    yield manager, engine, script, tmp_path
    await manager.close()


async def test_signout_is_confirmed_and_old_flow_is_invalidated(account):
    manager, engine, script, home = account
    manager.flow = {"id": "old", "owner": "browser:1", "phase": "succeeded"}
    await engine_logout.logout(manager, engine, script)
    assert not (home / "account").exists()
    with pytest.raises(KeyError):
        manager.view("browser:1", "old")
    # The credential-home lock has been released after completion.
    await engine_logout.logout(manager, engine, script)


@pytest.mark.parametrize("mode", ["fail", "unchanged"])
async def test_failed_or_unconfirmed_signout_is_private(account, mode):
    manager, engine, script, home = account
    (home / "mode").write_text(mode)
    with pytest.raises(LoginError) as error:
        await engine_logout.logout(manager, engine, script)
    assert "PRIVATE_PROVIDER_OUTPUT" not in str(error.value)
    assert (home / "account").exists()


async def test_shutdown_reaps_signout_and_serializes_account_home(account):
    manager, engine, script, home = account
    (home / "mode").write_text("wait")
    operation = asyncio.create_task(engine_logout.logout(manager, engine, script))
    async with asyncio.timeout(5):
        while not (home / "pid").exists():
            await asyncio.sleep(.01)
    with pytest.raises(LoginError):
        await engine_logout.logout(manager, engine, script)
    other = CodexLogin() if engine == "codex" else ClaudeLogin()
    with pytest.raises(LoginError):
        await engine_logout.logout(other, engine, script)
    pid = int((home / "pid").read_text())
    await manager.close()
    with pytest.raises(asyncio.CancelledError):
        await operation
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    (home / "mode").unlink()
    await engine_logout.logout(other, engine, script)
