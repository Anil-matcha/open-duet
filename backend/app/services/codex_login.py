"""Private, bounded device-code login. CLI output is never logged or returned."""

import asyncio
import os
import re
from pathlib import Path
from uuid import uuid4

from app.core import data_lease, engine_processes
from app.services import cli_probe
from app.services.local_claude_runner import child_env
from app.core import host_exec

DEVICE_URL = "https://auth.openai.com/codex/device"
_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_CODE = re.compile(r"(?<![A-Z0-9-])([A-Z0-9]{4,8}-[A-Z0-9]{4,8})(?![A-Z0-9-])")


class LoginError(ValueError):
    pass


class CodexLogin:
    def __init__(self):
        self.flow = None
        self.task = None
        self.lifetime = 300
        self.prompt_timeout = 30

    async def start(self, owner: str, executable: Path):
        if self.task and not self.task.done():
            raise LoginError("A Codex sign-in is already running. Finish or cancel it first.")
        env = child_env()
        configured_home = Path(env.get("CODEX_HOME") or str(Path.home() / ".codex"))
        if not configured_home.is_absolute():
            raise LoginError("Use an absolute CODEX_HOME path before signing in.")
        home = configured_home.resolve()
        home.mkdir(parents=True, exist_ok=True)
        fd = os.open(home / ".open-dots-login.lock", os.O_RDWR | os.O_CREAT, 0o600)
        if not data_lease._try_lock(fd):
            os.close(fd)
            raise LoginError("A Codex sign-in is already running on this server.")
        self.flow = {"id": uuid4().hex, "owner": owner, "phase": "running"}
        flow = self.flow
        self.task = asyncio.create_task(self._run(flow, executable.resolve(), env))
        def release(task):
            if task.cancelled():
                flow["phase"] = "cancelled"
            flow.pop("user_code", None)
            flow.pop("authorization_url", None)
            data_lease._unlock(fd)
            os.close(fd)
        self.task.add_done_callback(release)
        return self.view(owner, flow["id"])

    def view(self, owner: str, flow_id: str):
        if not self.flow or self.flow["owner"] != owner or self.flow["id"] != flow_id:
            raise KeyError("Sign-in not found")
        return {key: value for key, value in self.flow.items() if key != "owner"}

    async def cancel(self, owner: str, flow_id: str):
        self.view(owner, flow_id)
        await self.close()

    async def close(self):
        if self.task and not self.task.done():
            if not self.task.cancelling():
                self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def _run(self, flow, executable, env):
        proc = None
        result = {"phase": "failed"}
        try:
            # An existing working account is never silently replaced.
            status = await cli_probe.run([str(executable), "login", "status"], timeout=8, env=env)
            said = status.stdout + "\n" + status.stderr
            if status.ok and re.search(r"^\s*logged in\b", said, re.I | re.M):
                result = {"phase": "succeeded"}
                return
            if status.failed_to_start or status.timed_out or not re.search(r"^\s*not logged in\b", said, re.I | re.M):
                raise LoginError("Codex could not confirm its account status. Check its installation on the server.")
            host_exec.ensure_allowed("an engine sign-in")
            starting = asyncio.create_task(asyncio.create_subprocess_exec(
                str(executable), "login", "--device-auth", stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                env=env, cwd=str(Path.home()), start_new_session=os.name != "nt",
            ))
            # If cancellation arrives during OS process creation, retain the
            # resulting child so the finally block can kill and reap it.
            try:
                proc = await asyncio.shield(starting)
            except asyncio.CancelledError:
                proc = await starting
                raise
            await asyncio.to_thread(engine_processes.record, proc.pid, str(executable))
            async def receive():
                output = b""
                async with asyncio.timeout(self.prompt_timeout):
                    while "user_code" not in flow:
                        chunk = await proc.stdout.read(1024)
                        if not chunk:
                            raise LoginError("Codex did not provide a device code. Update the CLI and enable device-code login in your ChatGPT security settings.")
                        output += chunk
                        if len(output) > 16384:
                            raise LoginError("Codex returned too much sign-in output.")
                        text = _ANSI.sub("", output.decode("utf-8", "replace"))
                        code = next((_CODE.search(line) for line in text.split("\n")[:-1] if _CODE.search(line)), None)
                        if re.search(r"https://auth\.openai\.com/codex/device(?=[\s\x1b]|$)", text) and code:
                            flow.update(authorization_url=DEVICE_URL, user_code=code[1])
                # Keep draining without retaining arbitrary provider output.
                total = len(output)
                while chunk := await proc.stdout.read(1024):
                    total += len(chunk)
                    if total > 32768:
                        raise LoginError("Codex returned too much sign-in output.")
                if await proc.wait() != 0:
                    raise LoginError("Codex sign-in did not finish. Enable device-code login in ChatGPT, then try again.")
                checked = await cli_probe.run([str(executable), "login", "status"], timeout=8, env=env)
                if not checked.ok or not re.search(r"^\s*logged in\b", checked.stdout + "\n" + checked.stderr, re.I | re.M):
                    raise LoginError("Codex did not confirm the new account. Check its status on the server.")
            await asyncio.wait_for(receive(), timeout=self.lifetime)
            result = {"phase": "succeeded"}
        except asyncio.CancelledError:
            result = {"phase": "cancelled"}
        except TimeoutError:
            result = {"phase": "expired", "error": "Codex sign-in timed out. Start again for a new code."}
        except LoginError as exc:
            result = {"phase": "failed", "error": str(exc)}
        except Exception:
            result = {"phase": "failed", "error": "Could not start Codex sign-in. Check the CLI installation on the server."}
        finally:
            if proc:
                cli_probe.kill_group(proc)
                try:
                    await asyncio.wait_for(proc.wait(), 2)
                except TimeoutError:
                    pass
                engine_processes.forget(proc.pid)
            flow.pop("user_code", None)
            flow.pop("authorization_url", None)
            flow.update(result)
