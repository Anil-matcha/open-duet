"""Transactional, user-scoped installs of the supported engine CLIs."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import signal
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from app.desktop import profile

INSTALLERS = {
    "claude": ("@anthropic-ai/claude-code", "claude"),
    "codex": ("@openai/codex", "codex"),
    "opencode": ("opencode-ai", "opencode"),
}
TIMEOUT_SECONDS = 600
VERSION_TIMEOUT_SECONDS = 20
PIPE_DRAIN_SECONDS = 3
MAX_OUTPUT_CHARS = 2400
_SECRET = re.compile(r"(?i)(token|password|secret|api[_-]?key)(\s*[=:]\s*)\S+")
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_CREDENTIAL_URL = re.compile(r"(?i)(https?://)[^/@\s:]+:[^/@\s]+@")
_KEY = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,})\b")


class InstallFailure(Exception):
    """A safe, user-facing install failure."""


class InstallTimeout(InstallFailure):
    pass


@dataclass
class Operation:
    id: str
    engine: str
    action: str
    status: str = "queued"
    progress: str = "Waiting to start."
    error: str | None = None
    output: str = ""
    task: asyncio.Task | None = field(default=None, repr=False)
    process: asyncio.subprocess.Process | None = field(default=None, repr=False)
    reader: asyncio.Task | None = field(default=None, repr=False)

    def public(self) -> dict[str, object]:
        return {"id": self.id, "engine": self.engine, "action": self.action,
                "status": self.status, "progress": self.progress,
                "error": self.error, "output": self.output}


_operations: dict[str, Operation] = {}
_locks = {engine: asyncio.Lock() for engine in INSTALLERS}


def runtime_bin(profile_data_dir: Path, engine: str) -> Path:
    """Stable discovery path; each CLI lives in its own atomic current release."""
    if engine not in INSTALLERS:
        raise KeyError(engine)
    return profile_data_dir / "engine-runtimes" / engine / "current" / "bin"


def executable_path(engine: str) -> Path:
    if not profile.active():
        raise RuntimeError("Managed installs are available only in the desktop app.")
    return runtime_bin(profile.current().data_dir, engine) / INSTALLERS[engine][1]


def installed(engine: str) -> bool:
    path = executable_path(engine)
    return path.is_file() and os.access(path, os.X_OK)


def _redact(line: str) -> str:
    line = _SECRET.sub(r"\1\2[redacted]", line)
    line = _BEARER.sub("Bearer [redacted]", line)
    line = _CREDENTIAL_URL.sub(r"\1[redacted]@", line)
    line = _KEY.sub("[redacted]", line)
    line = line.replace(str(profile.current().data_dir), "<app data>")
    home = str(Path.home())
    if home:
        line = line.replace(home, "<home>")
    return line[:500]


async def _read_output(op: Operation, stream: asyncio.StreamReader) -> str:
    pending = ""
    captured = ""
    while chunk := await stream.read(1024):
        pending += chunk.decode("utf-8", errors="replace")
        lines = pending.splitlines(keepends=True)
        pending = ""
        if lines and not lines[-1].endswith(("\n", "\r")):
            pending = lines.pop()[-500:]
        for raw in lines:
            line = _redact(raw.strip())
            if line:
                captured = (captured + "\n" + line)[-MAX_OUTPUT_CHARS:]
                op.output = (op.output + "\n" + line)[-MAX_OUTPUT_CHARS:]
                op.progress = line[:180]
    if pending:
        line = _redact(pending.strip())
        if line:
            captured = (captured + "\n" + line)[-MAX_OUTPUT_CHARS:]
            op.output = (op.output + "\n" + line)[-MAX_OUTPUT_CHARS:]
            op.progress = line[:180]
    return captured.strip()


async def _drain_reader(op: Operation) -> str:
    reader = op.reader
    if reader is None:
        return ""
    try:
        return await asyncio.wait_for(asyncio.shield(reader), timeout=PIPE_DRAIN_SECONDS)
    except asyncio.TimeoutError:
        if op.process is not None:
            await _kill_process_group(op.process)
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        raise InstallFailure("The installer left output open after exiting. Stop related processes and retry.") from None
    finally:
        op.reader = None


async def _kill_process_group(process: asyncio.subprocess.Process) -> None:
    """Stop descendants that kept the install pipe open after npm exited."""
    if os.name != "posix":
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    await asyncio.sleep(0.15)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


async def _stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGTERM)
        else:
            process.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=3)
    except asyncio.TimeoutError:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        await asyncio.wait_for(process.wait(), timeout=3)


async def _run_child(op: Operation, args: list[str], *, cwd: Path, env: dict[str, str], timeout: float) -> tuple[int, str]:
    process = await asyncio.create_subprocess_exec(
        *args, cwd=str(cwd), env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    op.process = process
    op.reader = asyncio.create_task(_read_output(op, process.stdout))
    try:
        code = await asyncio.wait_for(process.wait(), timeout)
    except asyncio.TimeoutError:
        await _stop_process(process)
        await _drain_reader(op)
        raise InstallTimeout("The install took too long. Check your connection and retry.") from None
    except asyncio.CancelledError:
        await _stop_process(process)
        try:
            await _drain_reader(op)
        except InstallFailure:
            pass
        raise
    output = await _drain_reader(op)
    op.process = None
    return code, output


def _engine_root(data_dir: Path, engine: str) -> Path:
    root = data_dir / "engine-runtimes"
    if root.is_symlink():
        raise InstallFailure("The managed runtime folder is not a regular app folder. Fix it, then retry.")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = root / engine
    path.mkdir(mode=0o700, exist_ok=True)
    if path.is_symlink():
        raise InstallFailure("The managed runtime folder is not a regular app folder. Fix it, then retry.")
    return path


def _commit_release(engine_root: Path, stage: Path, operation_id: str) -> None:
    release_name = f"release-{operation_id}"
    release = engine_root / release_name
    current = engine_root / "current"
    temporary_link = engine_root / f".current-{operation_id}"
    if current.exists() and not current.is_symlink():
        raise InstallFailure("The managed runtime pointer is not a regular link. Fix it, then retry.")
    previous_target = os.readlink(current) if current.is_symlink() else None
    os.replace(stage, release)
    try:
        os.symlink(release_name, temporary_link)
        os.replace(temporary_link, current)
    except OSError:
        temporary_link.unlink(missing_ok=True)
        # os.replace is atomic; if it had switched the pointer before an
        # exceptional filesystem response, restore its previous target.
        if previous_target is not None:
            rollback_link = engine_root / f".rollback-{operation_id}"
            os.symlink(previous_target, rollback_link)
            os.replace(rollback_link, current)
        elif current.is_symlink() and os.readlink(current) == release_name:
            current.unlink()
        shutil.rmtree(release, ignore_errors=True)
        raise InstallFailure("Could not activate the new CLI. The previous install remains available.") from None


async def _run(op: Operation) -> None:
    stage: Path | None = None
    release: Path | None = None
    committed = False
    async with _locks[op.engine]:
        if op.status == "cancelled":
            return
        op.status = "running"
        op.progress = "Checking the desktop runtime."
        if not profile.active():
            op.status, op.error = "failed", "Managed installs are available only in the desktop app."
            return
        if os.name != "posix":
            op.status, op.error = "failed", "Managed installs currently require macOS or Linux."
            return
        npm = shutil.which("npm")
        if not npm:
            op.status, op.error = "failed", "Node.js and npm are required. Install Node.js, restart the app, then retry."
            return

        data_dir = profile.current().data_dir
        package, executable = INSTALLERS[op.engine]
        engine_root: Path | None = None
        try:
            engine_root = _engine_root(data_dir, op.engine)
            stage = engine_root / f"staging-{op.id}"
            release = engine_root / f"release-{op.id}"
            stage.mkdir(mode=0o700)
            args = [npm, "install", "--global", "--prefix", str(stage)]
            args.append(package if op.action == "install" else f"{package}@latest")
            env = {"PATH": os.environ.get("PATH", ""), "HOME": str(Path.home()),
                   "NPM_CONFIG_UPDATE_NOTIFIER": "false", "CI": "1"}
            for key in ("TMPDIR", "TEMP", "TMP", "SYSTEMROOT"):
                if os.environ.get(key):
                    env[key] = os.environ[key]

            op.progress = "Installing the selected engine CLI in a staging folder."
            code, _ = await _run_child(op, args, cwd=data_dir, env=env, timeout=TIMEOUT_SECONDS)
            if code != 0:
                raise InstallFailure(f"npm exited with status {code}. Check Node.js/npm and your connection, then retry.")
            staged_executable = stage / "bin" / executable
            if not staged_executable.is_file() or not os.access(staged_executable, os.X_OK):
                raise InstallFailure("The installer did not produce a usable CLI. Check the output and retry.")

            op.progress = "Checking the staged CLI before activation."
            version_code, version_output = await _run_child(
                op, [str(staged_executable), "--version"], cwd=data_dir, env=env,
                timeout=VERSION_TIMEOUT_SECONDS,
            )
            if version_code != 0 or not version_output:
                raise InstallFailure("The staged CLI did not pass its version check. The existing install is unchanged.")

            _commit_release(engine_root, stage, op.id)
            committed = True
            op.status, op.progress = "succeeded", "Install complete. Check engine status to continue."
        except asyncio.CancelledError:
            op.status, op.progress = "cancelled", "Install cancelled."
            raise
        except InstallFailure as exc:
            op.status, op.error = "failed", str(exc)
        except OSError:
            op.status, op.error = "failed", "Could not start or activate the CLI. Check the desktop data folder and retry."
        finally:
            op.process = None
            if op.reader is not None:
                op.reader.cancel()
                await asyncio.gather(op.reader, return_exceptions=True)
                op.reader = None
            if stage is not None:
                shutil.rmtree(stage, ignore_errors=True)
            if release is not None and not committed:
                shutil.rmtree(release, ignore_errors=True)


def begin(engine: str, action: str) -> Operation:
    if engine not in INSTALLERS:
        raise KeyError(engine)
    if action not in {"install", "update"}:
        raise ValueError("Choose install or update.")
    existing = _operations.get(engine)
    if existing and existing.status in {"queued", "running"}:
        return existing
    op = Operation(id=uuid.uuid4().hex, engine=engine, action=action)
    _operations[engine] = op
    op.task = asyncio.create_task(_run(op))
    return op


def status(engine: str) -> dict[str, object]:
    op = _operations.get(engine)
    return {"engine": engine, "installed": installed(engine), "operation": op.public() if op else None}


async def cancel(engine: str) -> None:
    op = _operations.get(engine)
    if not op or op.status not in {"queued", "running"}:
        return
    if op.task:
        op.task.cancel()
        await asyncio.gather(op.task, return_exceptions=True)
    if op.status in {"queued", "running"}:
        # Cancellation can win before the coroutine acquires its per-engine lock.
        op.status, op.progress = "cancelled", "Install cancelled."


def reset_for_tests() -> None:
    _operations.clear()
