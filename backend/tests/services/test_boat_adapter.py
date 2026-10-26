"""The hosted Boat executor, driven by a fake Boat client (no network, no real credentials).

The real `SdkBoatBoxes` is not covered here; see the adapter's module notes."""

import asyncio
import json
import subprocess
import sys

import pytest

from app.core.config import settings
from app.services import engine_registry
from app.services.boat_adapter import (
    BoatClaudeAdapter,
    Process,
    ProcessState,
    SandboxUnavailable,
    build_command,
)
from app.services.provider_adapter import TurnContext


def line(**event) -> str:
    return json.dumps(event) + "\n"


INIT = line(type="system", subtype="init", model="claude-test")
ANSWER = line(type="assistant", message={"id": "m1", "content": [{"type": "text", "text": "Hello from the box"}]})
TOOL = line(type="assistant", message={"id": "m0", "content": [
    {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}]})
TOOL_RESULT = line(type="user", message={"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "a.txt"}]})
RESULT = line(type="result", subtype="success", is_error=False, result="Hello from the box")


class FakeBoxes:
    """Per-account boxes; a started process replays `script` one line group per poll."""

    def __init__(self, signed_in=("u_a", "u_b"), script=None, exit_code=0, stderr="", unavailable=False):
        self.signed_in = set(signed_in)
        self.script = list(script if script is not None else [INIT, ANSWER, RESULT])
        self.exit_code, self.stderr, self.unavailable = exit_code, stderr, unavailable
        self.boxes: dict[str, str] = {}
        self.ensure_calls: list[str] = []
        self.files: dict[tuple[str, str], str] = {}
        self.commands: list[tuple[str, str]] = []
        self.killed: list[int] = []
        self.polls = 0
        self.log = ""

    async def credential_ready(self, user_id):
        return user_id in self.signed_in

    async def ensure_box(self, user_id):
        self.ensure_calls.append(user_id)
        if self.unavailable:
            raise SandboxUnavailable("boat is down")
        return self.boxes.setdefault(user_id, f"bx_{len(self.boxes) + 1:08d}")

    async def write_file(self, box_id, path, content):
        self.files[(box_id, path)] = content

    async def start(self, box_id, command, timeout_seconds):
        self.commands.append((box_id, command))
        return Process(process_id=7, log_path="/log")

    async def state(self, box_id, process):
        self.polls += 1
        if self.script:
            self.log += self.script.pop(0)
        return ProcessState(running=bool(self.script), exit_code=None if self.script else self.exit_code,
                            stderr=self.stderr)

    async def read_log(self, box_id, process):
        return self.log

    async def kill(self, box_id, process):
        self.killed.append(process.process_id)


class Sink:
    def __init__(self):
        self.events, self.deltas, self.lost = [], [], False

    async def emit(self, type, data):
        self.events.append((type, data))
        return True

    def delta(self, text):
        self.deltas.append(text)


def context(**overrides) -> TurnContext:
    async def history():
        return []

    base = dict(thread_id=1, turn_id=11, prompt="say hello", workspace=None, model=None, provider_session_id="s-1",
                provider_state=None, resume=False, history=history)
    return TurnContext(**{**base, **overrides})


def adapter(boxes, user="u_a", **kwargs):
    return BoatClaudeAdapter(boxes, user=lambda: user, poll_seconds=0, **kwargs)


@pytest.mark.asyncio
async def test_a_turn_runs_in_the_accounts_box_and_streams_events():
    boxes = FakeBoxes(script=[INIT, TOOL, TOOL_RESULT, ANSWER, RESULT])
    sink = Sink()
    outcome = await adapter(boxes).run_turn(context(), sink, gate=None)
    assert outcome.status == "succeeded" and outcome.result == "Hello from the box"
    types = [t for t, _ in sink.events]
    assert types == ["tool.started", "tool.completed", "assistant.message"]
    assert sink.events[0][1]["name"] == "Bash" and sink.events[1][1]["output"] == "a.txt"
    box, command = boxes.commands[0]
    assert box == "bx_00000001"
    assert command.startswith("mkdir -p open-dots-work && cd open-dots-work && claude -p ")
    assert boxes.files[(box, ".open-dots/prompt-11.txt")] == "say hello"  # the prompt never goes on the command line
    assert "say hello" not in command


@pytest.mark.asyncio
async def test_the_sandbox_is_ensured_once_per_turn_and_two_accounts_get_different_boxes():
    boxes = FakeBoxes()
    await adapter(boxes, "u_a").run_turn(context(), Sink(), None)
    boxes.script = [INIT, ANSWER, RESULT]
    boxes.log = ""
    await adapter(boxes, "u_b").run_turn(context(), Sink(), None)
    assert boxes.ensure_calls == ["u_a", "u_b"]
    assert boxes.boxes["u_a"] != boxes.boxes["u_b"]
    assert [b for b, _ in boxes.commands] == [boxes.boxes["u_a"], boxes.boxes["u_b"]]


@pytest.mark.asyncio
async def test_a_missing_sign_in_is_a_clear_error_and_starts_nothing():
    boxes = FakeBoxes(signed_in=())
    outcome = await adapter(boxes).run_turn(context(), Sink(), None)
    assert outcome.status == "failed" and outcome.error_code == "engine_signed_out"
    assert "Connect your Claude account" in outcome.error
    assert boxes.ensure_calls == [] and boxes.commands == []
    probe = await adapter(boxes).probe()
    assert not probe.ready and probe.signed_in is False and probe.reason == outcome.error


@pytest.mark.asyncio
async def test_an_unreachable_sandbox_fails_the_turn_without_a_crash():
    outcome = await adapter(FakeBoxes(unavailable=True)).run_turn(context(), Sink(), None)
    assert outcome.error_code == "sandbox_unavailable"


@pytest.mark.asyncio
async def test_resume_and_approval_modes_reach_the_command():
    boxes = FakeBoxes()
    await adapter(boxes).run_turn(context(resume=True, approval_mode="plan", model="m-1"), Sink(), None)
    command = boxes.commands[0][1]
    assert "--resume s-1" in command and "--permission-mode plan" in command and "--model m-1" in command
    assert "--permission-mode dontAsk" in build_command(
        session_id="s", resume=False, prompt_path="p", model=None, approval_mode=None, instructions=None)
    assert "--permission-mode acceptEdits" in build_command(
        session_id="s", resume=False, prompt_path="p", model=None, approval_mode="accept_edits", instructions=None)


@pytest.mark.asyncio
async def test_a_failed_resume_marks_the_session_broken():
    boxes = FakeBoxes(script=[line(type="result", subtype="error", is_error=True, result="No conversation found")],
                      exit_code=1)
    outcome = await adapter(boxes).run_turn(context(resume=True), Sink(), None)
    assert outcome.error_code == "session_resume_failed" and outcome.session_state == "broken"


@pytest.mark.asyncio
async def test_a_stopped_run_kills_the_remote_process():
    boxes = FakeBoxes(script=[INIT, ANSWER, ANSWER, RESULT])
    ctx = context()
    sink = Sink()
    sink.lost = True
    outcome = await adapter(boxes).run_turn(ctx, sink, None)
    assert outcome.error_code == "lost" and boxes.killed == [7]


@pytest.mark.asyncio
async def test_a_turn_that_never_ends_times_out_and_is_killed():
    class Endless(FakeBoxes):
        async def state(self, box_id, process):
            return ProcessState(running=True, exit_code=None)

    boxes = Endless()
    outcome = await adapter(boxes, timeout_seconds=0).run_turn(context(), Sink(), None)
    assert outcome.error_code == "timeout" and boxes.killed == [7]


def test_hosted_mode_offers_only_the_sandbox_engine(monkeypatch):
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", True)
    adapters = engine_registry.default_adapters()
    assert isinstance(adapters["claude"], BoatClaudeAdapter)
    others = [a for key, a in adapters.items() if key != "claude"]
    assert others and all(isinstance(a, engine_registry.UnavailableAdapter) for a in others)
    assert all(a.reason == engine_registry.HOSTED_REASON for a in others)
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", False)
    assert not isinstance(engine_registry.default_adapters()["claude"], BoatClaudeAdapter)


def test_nothing_in_the_hosted_path_spawns_a_host_process(monkeypatch):
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", True)

    def forbidden(*args, **kwargs):
        raise AssertionError("a host process was started")

    monkeypatch.setattr(subprocess, "Popen", forbidden)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", forbidden)
    monkeypatch.setattr(asyncio, "create_subprocess_shell", forbidden)

    async def go():
        boxes = FakeBoxes()
        adapters = engine_registry.default_adapters()
        assert adapters  # building the hosted engines starts nothing
        return await adapter(boxes).run_turn(context(), Sink(), None)

    assert asyncio.run(go()).status == "succeeded"
    assert sys.modules["subprocess"].Popen is forbidden  # the guard was in place for the whole run
