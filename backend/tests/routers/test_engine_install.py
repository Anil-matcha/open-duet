"""Transactional engine installation uses fake subprocesses only."""

import asyncio
import os
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.desktop import profile
from app.routers.engine_install import InstallRequest
from app.services import engine_install


@pytest.fixture(autouse=True)
def desktop_profile(monkeypatch, tmp_path):
    monkeypatch.setattr(profile, "_current", profile.DesktopProfile(tmp_path, "http://localhost", "x" * 48))
    engine_install.reset_for_tests()
    yield tmp_path
    engine_install.reset_for_tests()


class FakeProcess:
    def __init__(self, code=0, text="installing package\n", *, wait_event=None, stream_open=False):
        self.returncode = None
        self.pid = 12345
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(text.encode())
        if not stream_open:
            self.stdout.feed_eof()
        self.code = code
        self.wait_event = wait_event
        self.killed = False

    async def wait(self):
        if self.wait_event:
            await self.wait_event.wait()
        self.returncode = self.code
        return self.code


def make_installer(monkeypatch, tmp_path, *, npm_code=0, version_code=0, version_text="1.2.3\n", hold=None, open_stdout=False):
    calls = []
    process = None

    async def create(*args, **kwargs):
        nonlocal process
        calls.append((args, kwargs))
        if args[0] == "/usr/bin/npm":
            prefix = Path(args[4])
            if npm_code == 0:
                executable = prefix / "bin" / "claude"
                executable.parent.mkdir(parents=True, exist_ok=True)
                executable.write_text("#!/bin/sh\nexit 0\n")
                executable.chmod(0o755)
            process = FakeProcess(npm_code, "install output\n", wait_event=hold, stream_open=open_stdout)
        else:
            process = FakeProcess(version_code, version_text)
        return process

    monkeypatch.setattr(engine_install.shutil, "which", lambda name: "/usr/bin/npm" if name == "npm" else None)
    monkeypatch.setattr(engine_install.asyncio, "create_subprocess_exec", create)
    return calls, lambda: process


async def test_install_stages_validates_and_atomically_activates(monkeypatch, desktop_profile):
    calls, _ = make_installer(monkeypatch, desktop_profile)
    op = engine_install.begin("claude", "install")
    await op.task
    assert op.status == "succeeded"
    args, kwargs = calls[0]
    assert args[:4] == ("/usr/bin/npm", "install", "--global", "--prefix")
    assert args[5] == "@anthropic-ai/claude-code"
    assert Path(args[4]).parent == desktop_profile / "engine-runtimes" / "claude"
    assert Path(args[4]).name.startswith("staging-")
    assert kwargs["start_new_session"] is True and "shell" not in kwargs
    assert calls[1][0][0].endswith("/claude") and calls[1][0][1] == "--version"
    current = desktop_profile / "engine-runtimes" / "claude" / "current"
    assert current.is_symlink() and (current / "bin" / "claude").is_file()
    assert engine_install.installed("claude")
    assert (desktop_profile / "bin").exists() is False  # does not overwrite the user's regular CLI path


async def test_failed_update_version_check_preserves_previous_release(monkeypatch, desktop_profile):
    engine_root = desktop_profile / "engine-runtimes" / "claude"
    old = engine_root / "release-old"
    old_executable = old / "bin" / "claude"
    old_executable.parent.mkdir(parents=True)
    old_executable.write_text("old executable")
    old_executable.chmod(0o755)
    engine_root.mkdir(parents=True, exist_ok=True)
    (engine_root / "current").symlink_to("release-old")
    calls, _ = make_installer(monkeypatch, desktop_profile, version_code=1, version_text="not valid\n")

    op = engine_install.begin("claude", "update")
    await op.task
    assert op.status == "failed" and "version check" in op.error
    assert os.readlink(engine_root / "current") == "release-old"
    assert old_executable.read_text() == "old executable"
    assert not list(engine_root.glob("staging-*"))
    assert len(calls) == 2


async def test_nonzero_npm_failure_preserves_current_and_duplicate_returns_same_op(monkeypatch, desktop_profile):
    engine_root = desktop_profile / "engine-runtimes" / "codex"
    old = engine_root / "release-old"
    (old / "bin").mkdir(parents=True)
    (old / "bin" / "codex").write_text("old")
    (old / "bin" / "codex").chmod(0o755)
    (engine_root / "current").symlink_to("release-old")
    make_installer(monkeypatch, desktop_profile, npm_code=17)
    first = engine_install.begin("codex", "update")
    second = engine_install.begin("codex", "install")
    assert first is second
    await first.task
    assert first.status == "failed" and "status 17" in first.error
    assert os.readlink(engine_root / "current") == "release-old"
    with pytest.raises(KeyError):
        engine_install.begin("made-up", "install")
    with pytest.raises(ValueError):
        engine_install.begin("claude", "arbitrary")


async def test_timeout_kills_process_and_cleans_stage(monkeypatch, desktop_profile):
    hold = asyncio.Event()
    calls, get_process = make_installer(monkeypatch, desktop_profile, hold=hold)
    monkeypatch.setattr(engine_install, "TIMEOUT_SECONDS", 0.01)
    def kill_group(pid, sig):
        get_process().returncode, get_process().killed = -15, True
        hold.set()
        get_process().stdout.feed_eof()
    monkeypatch.setattr(engine_install.os, "killpg", kill_group)
    op = engine_install.begin("claude", "install")
    await op.task
    assert op.status == "failed" and "too long" in op.error
    assert get_process().killed
    assert not list((desktop_profile / "engine-runtimes" / "claude").glob("staging-*"))
    assert len(calls) == 1


async def test_parent_exit_with_inherited_pipe_is_bounded_and_cleans_stage(monkeypatch, desktop_profile):
    calls, _ = make_installer(monkeypatch, desktop_profile, open_stdout=True)
    monkeypatch.setattr(engine_install, "PIPE_DRAIN_SECONDS", 0.01)
    monkeypatch.setattr(engine_install.os, "killpg", lambda pid, sig: None)
    op = engine_install.begin("claude", "install")
    await asyncio.wait_for(op.task, timeout=1)
    assert op.status == "failed" and "left output open" in op.error
    assert not list((desktop_profile / "engine-runtimes" / "claude").glob("staging-*"))
    assert len(calls) == 1


async def test_cancel_kills_process_drains_reader_and_cleans_stage(monkeypatch, desktop_profile):
    started = asyncio.Event()
    hold = asyncio.Event()
    calls, get_process = make_installer(monkeypatch, desktop_profile, hold=hold)
    original = engine_install.asyncio.create_subprocess_exec

    async def create(*args, **kwargs):
        process = await original(*args, **kwargs)
        started.set()
        return process

    monkeypatch.setattr(engine_install.asyncio, "create_subprocess_exec", create)

    def kill_group(pid, sig):
        process = get_process()
        process.killed = True
        process.returncode = -15
        process.stdout.feed_eof()
        hold.set()

    monkeypatch.setattr(engine_install.os, "killpg", kill_group)
    op = engine_install.begin("claude", "install")
    await asyncio.wait_for(started.wait(), 1)
    await engine_install.cancel("claude")
    assert op.status == "cancelled" and op.reader is None
    assert get_process().killed
    assert not list((desktop_profile / "engine-runtimes" / "claude").glob("staging-*"))
    assert len(calls) == 1


async def test_headless_and_unsupported_platform_guards(monkeypatch, desktop_profile):
    monkeypatch.setattr(profile, "_current", None)
    headless = engine_install.begin("claude", "install")
    await headless.task
    assert headless.status == "failed" and "desktop" in headless.error

    monkeypatch.setattr(profile, "_current", profile.DesktopProfile(desktop_profile, "http://localhost", "x" * 48))
    monkeypatch.setattr(engine_install.os, "name", "nt")
    unsupported = engine_install.begin("codex", "install")
    await unsupported.task
    assert unsupported.status == "failed" and "macOS or Linux" in unsupported.error


def test_status_checks_managed_current_executable_and_rejects_extra_action_fields(desktop_profile):
    assert engine_install.status("claude")["installed"] is False
    root = desktop_profile / "engine-runtimes" / "claude"
    release = root / "release-one"
    executable = release / "bin" / "claude"
    executable.parent.mkdir(parents=True)
    executable.write_text("cli")
    executable.chmod(0o755)
    root.mkdir(parents=True, exist_ok=True)
    (root / "current").symlink_to("release-one")
    assert engine_install.status("claude")["installed"] is True
    with pytest.raises(ValidationError):
        InstallRequest.model_validate({"action": "install", "prefix": "/tmp/arbitrary"})
