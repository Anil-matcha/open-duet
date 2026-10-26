"""Run an agent turn inside the signed-in account's own Boat sandbox (hosted deployments).

A hosted server starts no engine process on its own machine (core/host_exec.py). With
HOST_EXECUTION_DISABLED set, this adapter is the Claude engine: each account has one Boat
sandbox, the Claude CLI runs there as a detached command, and its `stream-json` log is read
back and turned into the same normalized events as a local run.

Everything that talks to Boat goes through `BoatBoxes`, so the adapter holds no database
session and no SDK object, and tests drive it with a fake. The real implementation is
`SdkBoatBoxes` (end of file).

Limits of this first version, stated rather than hidden:
- Approval cards are not available. The CLI cannot ask this app mid-command over a detached
  process, so `ask` runs with `dontAsk` (tools that need permission are refused), `accept_edits`
  with `acceptEdits`, and `plan` with `plan`.
- No agent computer, images, team tools, memory search or connected-apps tools yet.
- Engine sign-in is the existing /sandboxes/{box}/auth flow; this adapter only checks that a
  credential is stored and puts it on the box before a turn.
"""

import asyncio
import json
import shlex
from dataclasses import dataclass
from typing import Protocol
from uuid import uuid4

from app.core.logging import get_logger
from app.services.local_claude_stream import StreamNormalizer, ToolEvent
from app.services.provider_adapter import (
    Capabilities,
    EngineProbe,
    ProviderStatus,
    TurnContext,
    TurnOutcome,
)

logger = get_logger(__name__)

POLL_SECONDS = 1.5
TURN_TIMEOUT_SECONDS = 1800
WORK_DIR = "open-dots-work"
CREDENTIAL_PROVIDER = "claude"
SIGN_IN_REASON = "Connect your Claude account in Settings → Engines to use your private sandbox."
# `ask` cannot be answered from inside a detached command, so tools that need permission are refused.
_PERMISSION_MODES = {"ask": "dontAsk", "accept_edits": "acceptEdits", "plan": "plan"}
TOOL_NAMES = "Read,Write,Edit,Glob,Grep,Bash"


class SandboxUnavailable(RuntimeError):
    """The account's sandbox could not be created, resumed or reached."""


@dataclass
class Process:
    process_id: int
    log_path: str


@dataclass
class ProcessState:
    running: bool
    exit_code: int | None
    stderr: str = ""


class BoatBoxes(Protocol):
    """What the adapter needs from Boat, per account (`user_id` is the account's tenant id)."""

    async def credential_ready(self, user_id: str) -> bool: ...

    async def ensure_box(self, user_id: str) -> str:
        """The account's running sandbox id (created or resumed), with its Claude login in place."""

    async def write_file(self, box_id: str, path: str, content: str) -> None: ...

    async def start(self, box_id: str, command: str, timeout_seconds: int) -> Process: ...

    async def state(self, box_id: str, process: Process) -> ProcessState: ...

    async def read_log(self, box_id: str, process: Process) -> str: ...

    async def kill(self, box_id: str, process: Process) -> None: ...


def current_user() -> str:
    from app.db import tenant_schema

    return tenant_schema.current_tenant_id() or "owner"


def build_command(*, session_id: str, resume: bool, prompt_path: str, model: str | None,
                  approval_mode: str | None, instructions: str | None) -> str:
    args = ["claude", "-p", "--verbose", "--include-partial-messages", "--output-format", "stream-json",
            "--resume" if resume else "--session-id", session_id]
    if model:
        args += ["--model", model]
    if instructions:
        args += ["--append-system-prompt", instructions]
    args += ["--permission-mode", _PERMISSION_MODES.get(approval_mode or "ask", "dontAsk"),
             "--tools", TOOL_NAMES, "--strict-mcp-config", "--disable-slash-commands"]
    # The prompt is read from a file on the box, never placed on the command line.
    quoted = " ".join(shlex.quote(a) for a in args)
    return f"mkdir -p {WORK_DIR} && cd {WORK_DIR} && {quoted} < {shlex.quote('../' + prompt_path)}"


class BoatClaudeAdapter:
    kind = "cli"
    label = "Claude (private sandbox)"
    capabilities = Capabilities(tools=True, resume=True)
    models: list = []
    custom_models = True
    needs_config = False

    def __init__(self, boxes: BoatBoxes, key: str = "claude", *, poll_seconds: float = POLL_SECONDS,
                 timeout_seconds: int = TURN_TIMEOUT_SECONDS, user=current_user) -> None:
        self.key = key
        self._boxes = boxes
        self._poll = poll_seconds
        self._timeout = timeout_seconds
        self._user = user

    def new_session_id(self) -> str:
        return str(uuid4())

    async def status(self) -> ProviderStatus:
        probe = await self.probe()
        return ProviderStatus(ready=probe.ready, error=probe.reason, installed=probe.installed,
                              signed_in=probe.signed_in)

    async def probe(self) -> EngineProbe:
        signed_in = await self._boxes.credential_ready(self._user())
        return EngineProbe(installed=True, ready=signed_in, signed_in=signed_in,
                           reason=None if signed_in else SIGN_IN_REASON)

    async def run_turn(self, ctx: TurnContext, sink, gate) -> TurnOutcome:
        def failed(message: str, code: str, **extra) -> TurnOutcome:
            return TurnOutcome("failed", error=message, error_code=code, model=ctx.model, **extra)

        if ctx.computer is not None:
            return failed("This engine cannot use an agent computer yet.", "engine_without_computers")
        user = self._user()
        if not await self._boxes.credential_ready(user):
            return failed(SIGN_IN_REASON, "engine_signed_out")
        try:
            box = await self._boxes.ensure_box(user)
        except SandboxUnavailable as exc:
            return failed(f"Your private sandbox is not available: {exc}", "sandbox_unavailable")

        session_id = ctx.provider_session_id or self.new_session_id()
        prompt_path = f".open-dots/prompt-{ctx.turn_id}.txt"
        command = build_command(session_id=session_id, resume=ctx.resume, prompt_path=prompt_path,
                                model=ctx.model, approval_mode=ctx.approval_mode, instructions=ctx.instructions)
        try:
            await self._boxes.write_file(box, prompt_path, ctx.prompt)
            process = await self._boxes.start(box, command, self._timeout)
        except SandboxUnavailable as exc:
            return failed(f"Your private sandbox is not available: {exc}", "sandbox_unavailable")

        normalizer = StreamNormalizer(max_text_bytes=2_000_000)
        seen = 0  # complete log lines already fed to the parser
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timeout
        state = ProcessState(running=True, exit_code=None)
        ctx.on_abort(lambda: asyncio.run_coroutine_threadsafe(self._boxes.kill(box, process), loop))

        async def drain(final: bool) -> None:
            nonlocal seen
            log = await self._boxes.read_log(box, process)
            lines = log.split("\n")
            # The last element is an unfinished line (or "" after a final newline); only once the
            # process has ended is an unfinished last line complete too.
            complete = lines[:-1] if not final or lines[-1] == "" else lines
            for line in complete[seen:]:
                for chunk in normalizer.feed(line):
                    sink.delta(chunk)
            seen = len(complete)
            for text in normalizer.take_messages():
                if not sink.lost:
                    await sink.emit("assistant.message", {"text": text})
            for event in normalizer.take_tool_events():
                if not sink.lost:
                    await self._tool_event(sink, event)

        try:
            while True:
                state = await self._boxes.state(box, process)
                await drain(final=not state.running)
                if ctx.aborted or sink.lost:
                    await self._boxes.kill(box, process)
                    return failed("The run was stopped because it no longer owns its turn.", "lost")
                if not state.running:
                    break
                if loop.time() > deadline:
                    await self._boxes.kill(box, process)
                    return failed(f"Timed out after {self._timeout} seconds", "timeout")
                await asyncio.sleep(self._poll)
        except SandboxUnavailable as exc:
            return failed(f"Lost contact with your private sandbox: {exc}", "sandbox_unavailable")

        return self._outcome(normalizer, state, ctx)

    async def _tool_event(self, sink, event: ToolEvent) -> None:
        data = event.data
        if event.kind == "tool_started":
            await sink.emit("tool.started", {"call_id": data["tool_use_id"], "name": data["tool"],
                                             "summary": data["summary"], "input": event.extra.get("input", {})})
        elif event.kind == "tool_completed":
            output = str(event.extra.get("output", ""))
            await sink.emit("tool.completed", {"call_id": data["tool_use_id"], "ok": not data["is_error"],
                                               "output": output[:20000], "truncated": len(output) > 20000})

    def _outcome(self, n: StreamNormalizer, state: ProcessState, ctx: TurnContext) -> TurnOutcome:
        common = {"model": n.model or ctx.model, "usage": n.usage}

        def failed(message: str, code: str, **extra) -> TurnOutcome:
            return TurnOutcome("failed", error=message, error_code=code, partial_text=n.unflushed_text or None,
                               **common, **extra)

        final = n.final
        stderr = (state.stderr or "").strip()
        said = f"{stderr} {final.text if final and final.text else ''}".lower()
        if ctx.resume and not n.init_seen and "no conversation found" in said:
            return failed("Claude could not find this conversation's session in your sandbox, so it cannot "
                          "continue it. Start a new session to go on.", "session_resume_failed",
                          session_state="broken")
        if final is None:
            if stderr:
                return failed(stderr, "cli_error")
            if state.exit_code not in (0, None):
                return failed(f"Claude exited with code {state.exit_code}", "cli_error")
            return failed("Claude ended without a result", "no_result")
        if final.is_error:
            return failed(final.text or n.api_error or stderr or "Claude reported an error", "claude_error",
                          limit_resets_at=n.limit_resets_at)
        text = final.text if final.text and final.text.strip() else n.text
        return TurnOutcome("succeeded", result=text, **common)


# --- the real Boat implementation -------------------------------------------------------


class SdkBoatBoxes:
    """`BoatBoxes` over the existing sandbox services. Never exercised against a live Boat in tests."""

    def __init__(self, ttl_seconds: int = 1800) -> None:
        self._ttl = ttl_seconds

    @staticmethod
    def _sessions():
        from app.db.session import AsyncSessionLocal

        return AsyncSessionLocal()

    async def credential_ready(self, user_id: str) -> bool:
        from app.services import user_credential_service

        async with self._sessions() as db:
            return await user_credential_service.get_decrypted(db, user_id, CREDENTIAL_PROVIDER) is not None

    async def ensure_box(self, user_id: str) -> str:
        from boat_sdk.exceptions import ApiException
        from fastapi.concurrency import run_in_threadpool

        from app.services import user_credential_service, user_sandbox_service
        from app.services.auth_flow_service import RUNNABLE_BOX_STATES
        from app.services.box_operations import BoatNotConfigured, ascii_box_service

        try:
            async with self._sessions() as db:
                _record, sandbox = await user_sandbox_service.ensure(db, user_id=user_id, ttl_seconds=self._ttl)
                if sandbox.state not in RUNNABLE_BOX_STATES:
                    await run_in_threadpool(ascii_box_service.resume_box, sandbox.id)
                await user_credential_service.inject_credential_into_box(
                    db, box_id=sandbox.id, user_id=user_id, provider=CREDENTIAL_PROVIDER)
                return sandbox.id
        except (ApiException, BoatNotConfigured) as exc:
            raise SandboxUnavailable(str(exc)) from exc

    async def _call(self, name: str, *args, **kwargs):
        from boat_sdk.exceptions import ApiException
        from fastapi.concurrency import run_in_threadpool

        from app.services.box_operations import ascii_box_service

        try:
            return await run_in_threadpool(getattr(ascii_box_service, name), *args, **kwargs)
        except ApiException as exc:
            raise SandboxUnavailable(f"{exc.status} {exc.reason}") from exc

    async def write_file(self, box_id: str, path: str, content: str) -> None:
        await self._call("run_command", box_id, f"mkdir -p {shlex.quote(path.rsplit('/', 1)[0])}")
        await self._call("write_file", box_id, path, content)

    async def start(self, box_id: str, command: str, timeout_seconds: int) -> Process:
        result = await self._call("run_command", box_id, command, timeout_seconds=min(timeout_seconds, 600),
                                  detached=True)
        data = json.loads(result.to_json())
        return Process(process_id=data["processId"], log_path=data.get("logPath") or "")

    async def state(self, box_id: str, process: Process) -> ProcessState:
        data = json.loads((await self._call("command_status", box_id, process.process_id)).to_json())
        return ProcessState(running=bool(data.get("running")), exit_code=data.get("exitCode"),
                            stderr=data.get("stderr") or "")

    async def read_log(self, box_id: str, process: Process) -> str:
        return (await self._call("read_file", box_id, process.log_path)).content or ""

    async def kill(self, box_id: str, process: Process) -> None:
        try:
            await self._call("run_command", box_id, f"kill {int(process.process_id)} 2>/dev/null; true")
        except SandboxUnavailable:
            pass

    async def stop_idle(self, idle_seconds: int = 900) -> int:
        """Stop this schema's sandboxes that no turn has touched for `idle_seconds`. Returns how many."""
        from datetime import datetime, timedelta, timezone

        from sqlalchemy import select

        from app.db.models.user_sandbox import UserSandbox
        from app.services import user_sandbox_service

        cutoff = datetime.now(timezone.utc) - timedelta(seconds=idle_seconds)
        stopped = 0
        async with self._sessions() as db:
            rows = (await db.execute(select(UserSandbox).where(UserSandbox.is_active.is_(True)))).scalars().all()
            for row in rows:
                touched = row.updated_at
                if touched is not None and touched.replace(tzinfo=touched.tzinfo or timezone.utc) < cutoff:
                    try:
                        await self._call("stop_box", row.box_id)
                    except SandboxUnavailable:
                        continue
                    await user_sandbox_service.update_state(db, row.box_id, state="stopped")
                    stopped += 1
        return stopped
