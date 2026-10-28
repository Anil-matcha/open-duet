"""A headless Chromium started on this machine for one agent, with no Docker computer.

The broker (desktop-image/od-browser) is the same program the desktop container runs. Here it is
started as a process of its own, in its own session, with its own socket, debug port and profile,
and it starts Chromium. Killing the broker's process group therefore ends both.

Only the sandbox or a local install runs this. A control plane that signs many people in sets
HOST_EXECUTION_DISABLED and never gets here (core/host_exec.py).

Standard library only: the computer tool server that uses it is a child process with a minimal
environment.
"""

import contextlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable

from app.computers import local_browser_guard as guard
from app.core import engine_processes, host_exec

BROKER_ENV = "OPEN_DOTS_BROWSER_BROKER"
CHROME_ENV = "OPEN_DOTS_BROWSER_CHROME"
CHROME_NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
START_SECONDS = 20
REQUEST_SECONDS = 45
MAX_REPLY_BYTES = 2_000_000
_AGENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


def _bookkeeping(call, *args):
    """engine_processes logs to stdout, which here is the MCP channel: send anything it prints to stderr."""
    with contextlib.redirect_stdout(sys.stderr):
        return call(*args)


class LocalBrowserError(RuntimeError):
    pass


def broker_path() -> Path:
    override = os.environ.get(BROKER_ENV, "").strip()
    if override:
        return Path(override)
    # backend/app/computers/local_browser.py -> repo root / desktop-image / od-browser
    return Path(__file__).resolve().parents[3] / "desktop-image" / "od-browser"


def find_chrome() -> str | None:
    override = os.environ.get(CHROME_ENV, "").strip()
    if override:
        return override
    for name in CHROME_NAMES:
        found = shutil.which(name)
        if found and _runs(found):
            return found
    return None


def _runs(binary: str) -> bool:
    """A PATH match can be a wrapper whose app is gone, so ask it for its version."""
    try:
        done = subprocess.run([binary, "--version"], capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


def sandbox_usable() -> bool:
    """Whether Chromium can use its own sandbox here: not as root, and user namespaces allowed.
    When it cannot, the broker is told to pass --no-sandbox and the caller records that decision."""
    if os.name != "posix" or sys.platform == "darwin":
        return True
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        return False
    for path, bad in (("/proc/sys/kernel/unprivileged_userns_clone", "0"), ("/proc/sys/user/max_user_namespaces", "0")):
        try:
            if Path(path).read_text().strip() == bad:
                return False
        except OSError:
            pass
    return True


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class LocalBrowser:
    """One agent's browser. `request` starts it on first use; `release` ends it."""

    def __init__(
        self,
        profile_root: Path,
        agent: str,
        *,
        proxy_server: str | None = None,
        chrome: str | None = None,
        idle_seconds: int = 1800,
        registry: Path | None = None,
        state_dir: Path | None = None,
        max_browsers: int | None = None,
        held: Callable[[Path], bool] = lambda state: False,
        popen: Callable = subprocess.Popen,
    ) -> None:
        if not _AGENT.fullmatch(agent):
            raise LocalBrowserError("Invalid agent name for a browser profile.")
        self.profile = Path(profile_root) / agent
        self.proxy_server = proxy_server
        self.chrome = chrome
        self.idle_seconds = idle_seconds
        self.popen = popen
        self.registry, self.state_dir, self.max_browsers, self.held = registry, state_dir, max_browsers, held
        self.process: subprocess.Popen | None = None
        self.runtime: Path | None = None
        self.port = 0
        self.no_sandbox: bool | None = None  # the recorded sandbox decision, once started

    @property
    def socket_path(self) -> Path:
        assert self.runtime is not None
        return self.runtime / "broker.sock"

    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def start(self) -> None:
        if self.running():
            return
        host_exec.ensure_allowed("a browser")
        chrome = self.chrome or find_chrome()
        if not chrome:
            raise LocalBrowserError("No Chrome or Chromium is installed here.")
        broker = broker_path()
        if not broker.is_file():
            raise LocalBrowserError("The browser broker is missing.")
        self.release()
        if self.registry and self.max_browsers:
            refusal = guard.make_room(self.registry, self.profile.name, self.max_browsers, held=self.held)
            if refusal:
                raise LocalBrowserError(refusal)
        self.profile.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.profile, 0o700)
        # A short, private folder: unix socket paths are limited to about 100 characters.
        self.runtime = Path(tempfile.mkdtemp(prefix="odb"))
        self.port = free_port()
        self.no_sandbox = not sandbox_usable()
        env = engine_processes.mark({
            **{k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"}},
            "OD_BROWSER_SOCKET": str(self.socket_path),
            "OD_BROWSER_LOCK": str(self.runtime / "start.lock"),
            "OD_BROWSER_PROFILE": str(self.profile),
            "OD_BROWSER_PORT": str(self.port),
            "OD_BROWSER_CHROME": chrome,
            "OD_BROWSER_HEADLESS": "1",
            "OD_BROWSER_NO_SANDBOX": "1" if self.no_sandbox else "0",
            "OD_BROWSER_IDLE_SECONDS": str(self.idle_seconds),
        })
        if self.proxy_server:
            env["OD_BROWSER_PROXY"] = self.proxy_server
        self.process = self.popen(
            [sys.executable, str(broker), "--serve"], env=env, cwd=str(self.runtime),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        _bookkeeping(engine_processes.record, self.process.pid, "od-browser")
        guard.protect_app(self.process.pid)  # the broker's children (Chromium) inherit the raised score
        if self.registry:
            guard.register(self.registry, self.profile.name, self.process.pid, self.state_dir or self.runtime)
        deadline = time.monotonic() + START_SECONDS
        while time.monotonic() < deadline:
            if not self.running():
                self.release()
                raise LocalBrowserError("The browser broker exited at start.")
            if self.socket_path.exists():
                return
            time.sleep(.05)
        self.release()
        raise LocalBrowserError("The browser broker did not start.")

    def request(self, payload: dict) -> dict:
        """Send one broker request (name, args, owner, epoch) and return its MCP-shaped result."""
        self.start()
        if self.registry:
            guard.touch(self.registry, self.profile.name, self.process.pid, self.state_dir or self.runtime)
        data = json.dumps(payload).encode() + b"\n"
        if len(data) > 65537:
            raise LocalBrowserError("Browser request too large.")
        try:
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(REQUEST_SECONDS)
                connection.connect(str(self.socket_path))
                connection.sendall(data)
                with connection.makefile("rb") as reply:
                    raw = reply.readline(MAX_REPLY_BYTES)
        except (OSError, TimeoutError) as exc:
            raise LocalBrowserError("The browser did not answer.") from exc
        try:
            result = json.loads(raw)
        except ValueError as exc:
            raise LocalBrowserError("Invalid browser response.") from exc
        if not isinstance(result, dict) or "content" not in result:
            raise LocalBrowserError("Invalid browser response.")
        return result

    def release(self) -> None:
        """End the broker and Chromium together. Safe to call twice."""
        process, self.process = self.process, None
        if process is not None:
            pid = process.pid
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(pid, sig)
                except (ProcessLookupError, PermissionError, OSError):
                    break
                try:
                    process.wait(timeout=5 if sig == signal.SIGTERM else 2)
                    break
                except subprocess.TimeoutExpired:
                    continue
            # Chromium may outlive a broker that died first; the group is still ours.
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            _bookkeeping(engine_processes.forget, pid)
            if self.registry:
                guard.unregister(self.registry, self.profile.name)
        runtime, self.runtime = self.runtime, None
        if runtime is not None:
            shutil.rmtree(runtime, ignore_errors=True)
