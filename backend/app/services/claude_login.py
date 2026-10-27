"""Owner-session sign-in through the installed Claude CLI, never an OAuth client.

Only a validated provider URL leaves this process. Pasted codes travel once over
stdin and are not retained. Raw CLI output and account metadata stay private.
"""

import asyncio
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

from app.core import data_lease, engine_processes
from app.services import cli_probe
from app.services.codex_login import LoginError
from app.services.local_claude_runner import child_env
from app.core import host_exec

_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_HOSTS = {"claude.ai", "claude.com", "console.anthropic.com", "platform.claude.com"}


# Claude Code 2.1 prints https://claude.com/cai/oauth/authorize; older builds print /oauth/authorize.
_AUTHORIZE_PATH = re.compile(r"(/[a-z]{1,8})?/oauth/authorize")


def authorization_url(output: str) -> str | None:
    # Parse completed lines only: a pipe read can split the hostname or query.
    for line in _ANSI.sub("", output).splitlines(keepends=True):
        if not line.endswith(("\n", "\r")):
            continue
        for candidate in re.findall(r"https://[^\s\x00-\x20\x7f]+", line):
            try:
                parsed = urlsplit(candidate)
                if (parsed.scheme == "https" and parsed.hostname in _HOSTS
                        and _AUTHORIZE_PATH.fullmatch(parsed.path) and parsed.query
                        and not parsed.username and not parsed.password
                        and parsed.port in {None, 443} and not parsed.fragment):
                    return candidate
            except ValueError:
                continue
    return None


class ClaudeLogin:
    def __init__(self):
        self.flow = None
        self.task = None
        self._process = None
        self.lifetime = 300
        self.prompt_timeout = 30

    async def start(self, owner: str, executable: Path):
        if self.task and not self.task.done():
            raise LoginError("A Claude sign-in is already running.")
        env = child_env()
        home = Path(env.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude"))
        if not home.is_absolute():
            raise LoginError("Use an absolute CLAUDE_CONFIG_DIR before signing in.")
        home = home.resolve()
        home.mkdir(parents=True, exist_ok=True)
        fd = os.open(home / ".open-dots-login.lock", os.O_RDWR | os.O_CREAT, 0o600)
        if not data_lease._try_lock(fd):
            os.close(fd)
            raise LoginError("Another Claude sign-in is running for this account.")
        flow = {"id": uuid4().hex, "owner": owner, "phase": "running"}
        self.flow = flow
        self.task = asyncio.create_task(self._run(flow, executable.resolve(), env))

        def release(task):
            if task.cancelled():
                flow["phase"] = "cancelled"
            flow.pop("authorization_url", None)
            data_lease._unlock(fd)
            os.close(fd)
        self.task.add_done_callback(release)
        return self.view(owner, flow["id"])

    def view(self, owner: str, flow_id: str):
        if not self.flow or self.flow["owner"] != owner or self.flow["id"] != flow_id:
            raise KeyError("Sign-in not found")
        return {key: value for key, value in self.flow.items() if key != "owner"}

    async def complete(self, owner: str, flow_id: str, code: str):
        self.view(owner, flow_id)
        if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_#.:\-]{8,1024}", code):
            raise LoginError("Paste the full code from the Claude sign-in page.")
        flow, proc = self.flow, self._process
        if (flow["phase"] != "running" or not flow.get("authorization_url")
                or flow.get("code_sent") or proc is None or proc.returncode is not None):
            raise LoginError("This sign-in cannot accept a code. Start again if needed.")
        # Reserve before the first await; concurrent requests cannot send twice.
        flow["code_sent"] = True
        try:
            proc.stdin.write((code + "\n").encode())
            await asyncio.wait_for(proc.stdin.drain(), 3)
        except (OSError, RuntimeError, TimeoutError):
            await self.close()
            raise LoginError("Could not hand the code to Claude. Start sign-in again.") from None

    async def cancel(self, owner: str, flow_id: str):
        self.view(owner, flow_id)
        await self.close()

    async def close(self):
        if self.task and not self.task.done():
            if not self.task.cancelling():
                self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def _signed_in(self, executable, env):
        status = await cli_probe.run([str(executable), "auth", "status", "--json"], timeout=8, env=env)
        try:
            value = json.loads(status.stdout).get("loggedIn")
        except (ValueError, AttributeError):
            value = None
        if status.ok and value is True:
            return True
        if not status.timed_out and not status.failed_to_start and status.exit_code == 1 and value is False:
            return False
        raise LoginError("Claude could not confirm its account status. Check the CLI installation on the server.")

    async def _run(self, flow, executable, env):
        proc = None
        result = {"phase": "failed"}
        try:
            async with asyncio.timeout(self.lifetime):
                if await self._signed_in(executable, env):
                    result = {"phase": "succeeded"}
                    return
                # Prevent the server from opening a local browser; the owner
                # opens the validated URL in their own browser instead.
                env = {**env, "NO_COLOR": "1", "BROWSER": "true"}
                host_exec.ensure_allowed("an engine sign-in")
                starting = asyncio.create_task(asyncio.create_subprocess_exec(
                    str(executable), "auth", "login", stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                    env=env, cwd=str(Path.home()), start_new_session=os.name != "nt",
                ))
                try:
                    proc = await asyncio.shield(starting)
                except asyncio.CancelledError:
                    proc = await starting
                    raise
                self._process = proc
                await asyncio.to_thread(engine_processes.record, proc.pid, str(executable))
                output = b""
                async with asyncio.timeout(self.prompt_timeout):
                    while "authorization_url" not in flow:
                        chunk = await proc.stdout.read(1024)
                        if not chunk:
                            raise LoginError("Claude did not provide a supported sign-in link. Update the CLI or sign in from the server terminal.")
                        output += chunk
                        if len(output) > 16384:
                            raise LoginError("Claude returned too much sign-in output.")
                        url = authorization_url(output.decode("utf-8", "replace"))
                        if url:
                            flow["authorization_url"] = url
                total = len(output)
                del output
                while chunk := await proc.stdout.read(1024):
                    total += len(chunk)
                    if total > 32768:
                        raise LoginError("Claude returned too much sign-in output.")
                if await proc.wait() != 0:
                    raise LoginError("Claude sign-in did not finish. Start again with a new code.")
                if not await self._signed_in(executable, env):
                    raise LoginError("Claude did not confirm the new account. Start sign-in again.")
                result = {"phase": "succeeded"}
        except asyncio.CancelledError:
            result = {"phase": "cancelled"}
        except TimeoutError:
            result = {"phase": "expired", "error": "Claude sign-in timed out. Start again for a new link."}
        except LoginError as exc:
            result = {"phase": "failed", "error": str(exc)}
        except Exception:
            result = {"phase": "failed", "error": "Could not start Claude sign-in. Check the CLI installation on the server."}
        finally:
            if proc:
                cli_probe.kill_group(proc)
                try:
                    await asyncio.wait_for(proc.wait(), 2)
                except TimeoutError:
                    pass
                engine_processes.forget(proc.pid)
            self._process = None
            flow.pop("authorization_url", None)
            flow.pop("code_sent", None)
            flow.update(result)
