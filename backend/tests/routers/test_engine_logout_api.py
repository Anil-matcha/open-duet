"""Real auth middleware around account removal; no real provider commands."""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.core.config import settings
from app.routers.engines import get_runtime
from app.services import codex_adapter, engine_logout, local_claude_runner
from app.services.codex_login import LoginError
from app.services.thread_runtime import ProviderUnavailable, ThreadRuntime
from tests.auth.test_auth_api import (  # noqa: F401
    app, factory, auth_settings, client, login, pairing_code, set_owner,
)


@pytest.fixture(params=["claude", "codex"])
def account(request, app, monkeypatch):
    engine = request.param
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    monkeypatch.setattr(codex_adapter, "resolve_codex_executable", lambda: Path("/fake/codex"))
    monkeypatch.setattr(local_claude_runner, "resolve_claude_executable", lambda: Path("/fake/claude"))
    operation = AsyncMock()
    monkeypatch.setattr(engine_logout, "logout", operation)
    rt = SimpleNamespace(claude_login=object(), codex_login=object(), adapters={engine: object()},
                         _closing=False, engines=Mock(), _runs={}, _starting_turns=0, _account_changing=False)
    app.dependency_overrides[get_runtime] = lambda: rt
    return f"/api/v1/engines/{engine}/logout", engine, rt, operation


async def test_owner_csrf_confirmed_logout_and_no_store(app, factory, account):
    path, engine, rt, operation = account
    await set_owner(factory)
    async with client(app) as owner:
        session = await login(owner)
        assert (await owner.post(path)).status_code == 403
        operation.assert_not_awaited()
        result = await owner.post(path, headers={"X-CSRF-Token": session["csrf_token"]})
        assert result.status_code == 204, result.text
        assert result.headers["cache-control"] == "no-store"
        operation.assert_awaited_once()
        rt.engines.forget.assert_called_with(engine)


async def test_device_cannot_remove_account(app, factory, account):
    path, engine, rt, operation = account
    await set_owner(factory)
    async with client(app) as admin, client(app) as phone:
        session = await login(admin)
        code = await pairing_code(admin, session["csrf_token"], scope="chat")
        paired = await phone.post("/api/v1/auth/pair", json={"code": code})
        result = await phone.post(path, headers={"Authorization": f"Bearer {paired.json()['token']}"})
        assert result.status_code == 403
        operation.assert_not_awaited()


async def test_busy_and_failure_do_not_expose_cli_output(app, factory, account):
    path, engine, rt, operation = account
    await set_owner(factory)
    async with client(app) as owner:
        session = await login(owner)
        headers = {"X-CSRF-Token": session["csrf_token"]}
        rt._runs[1] = object()
        assert (await owner.post(path, headers=headers)).status_code == 409
        operation.assert_not_awaited()
        rt._runs.clear()
        operation.side_effect = LoginError("PRIVATE_OUTPUT")
        result = await owner.post(path, headers=headers)
        assert result.status_code == 409
        assert "PRIVATE_OUTPUT" not in result.text
        rt.engines.forget.assert_called_with(engine)
        assert not rt._account_changing


async def test_account_change_refuses_turn_admission_and_other_signout(app, factory, account):
    path, engine, rt, operation = account
    entered, finish = asyncio.Event(), asyncio.Event()
    async def held_logout(*args):
        entered.set()
        await finish.wait()
    operation.side_effect = held_logout
    rt._send_turn = AsyncMock()
    await set_owner(factory)
    async with client(app) as owner:
        session = await login(owner)
        headers = {"X-CSRF-Token": session["csrf_token"]}
        pending = asyncio.create_task(owner.post(path, headers=headers))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            with pytest.raises(ProviderUnavailable):
                await ThreadRuntime.send_turn(rt, 1, "hello")
            rt._send_turn.assert_not_awaited()
            assert (await owner.post(path, headers=headers)).status_code == 409
        finally:
            finish.set()
            result = await pending
        assert result.status_code == 204
        assert not rt._account_changing
        await ThreadRuntime.send_turn(rt, 1, "hello")
        rt._send_turn.assert_awaited_once()


async def test_turn_still_preparing_also_refuses_account_removal(app, factory, account):
    path, engine, rt, operation = account
    entered, finish = asyncio.Event(), asyncio.Event()
    async def prepare(*args):
        entered.set()
        await finish.wait()
        raise ProviderUnavailable("synthetic readiness failure")
    rt._send_turn = prepare
    await set_owner(factory)
    async with client(app) as owner:
        session = await login(owner)
        pending = asyncio.create_task(ThreadRuntime.send_turn(rt, 1, "hello"))
        try:
            await asyncio.wait_for(entered.wait(), 3)
            assert not rt._runs
            assert (await owner.post(path, headers={"X-CSRF-Token": session["csrf_token"]})).status_code == 409
            operation.assert_not_awaited()
        finally:
            finish.set()
            with pytest.raises(ProviderUnavailable):
                await pending
        assert rt._starting_turns == 0
