import json
"""Profile reset and account deletion: local data is erased only on explicit request."""

import httpx
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from app.db.models import Agent
from app.desktop import account, local_data, profile


@pytest.fixture
def manager(tmp_path):
    profile._current = profile.DesktopProfile(tmp_path, "http://127.0.0.1:1234", Fernet.generate_key().decode())
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(500)))
    instance = account.AccountManager(client=client)
    instance._write_secret(instance._binding_path, {"tenant_id": "tenant-1", "email": "p@example.org"})
    instance._write_secret(instance._session_path, {"token": "device-token", "expires_at": "2099-01-01T00:00:00Z"})
    yield instance, client
    profile._current = None


async def _wipe_ok():
    wiped.append(True)


wiped: list[bool] = []


@pytest.fixture(autouse=True)
def _reset_wiped():
    wiped.clear()


@pytest.mark.asyncio
async def test_reset_wipes_then_unbinds_and_revokes(manager):
    instance, client = manager
    seen = []
    client._transport = httpx.MockTransport(lambda r: (seen.append((r.method, r.url.path)), httpx.Response(200))[1])
    result = await instance.reset_profile(_wipe_ok)
    assert wiped == [True]
    assert result["profile_bound"] is False and result["signed_in"] is False
    assert not instance._binding_path.exists() and not instance._session_path.exists()
    assert seen == [("POST", "/api/v1/accounts/desktop/logout")]


@pytest.mark.asyncio
async def test_reset_failure_keeps_binding_and_session(manager):
    instance, _ = manager
    async def broken():
        raise OSError("disk")
    with pytest.raises(account.DesktopAccountError) as exc:
        await instance.reset_profile(broken)
    assert exc.value.code == "local_reset_failed"
    assert instance._binding_path.exists() and instance._token() == "device-token"


@pytest.mark.asyncio
async def test_reset_works_while_signed_out_and_offline(manager):
    instance, _ = manager
    instance._session_path.unlink()
    result = await instance.reset_profile(_wipe_ok)
    assert wiped == [True] and result["profile_bound"] is False


@pytest.mark.asyncio
async def test_delete_account_calls_cloud_then_wipes_and_unbinds(manager):
    instance, client = manager
    seen = []
    def handler(request):
        seen.append((request.method, request.url.path, request.headers["authorization"]))
        assert json.loads(request.content) == {"confirm_email": "p@example.org"}
        return httpx.Response(204)
    client._transport = httpx.MockTransport(handler)
    result = await instance.delete_account(_wipe_ok)
    assert seen == [("DELETE", "/api/v1/accounts/desktop/account", "Bearer device-token")]
    assert wiped == [True] and result["profile_bound"] is False
    assert not instance._binding_path.exists() and not instance._session_path.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [500, 503, 403, 429])
async def test_delete_account_fails_closed_when_cloud_refuses(manager, status):
    instance, client = manager
    client._transport = httpx.MockTransport(lambda r: httpx.Response(status))
    with pytest.raises(account.DesktopAccountError):
        await instance.delete_account(_wipe_ok)
    assert wiped == [] and instance._binding_path.exists() and instance._token() == "device-token"


@pytest.mark.asyncio
async def test_delete_account_network_failure_changes_nothing(manager):
    instance, client = manager
    def boom(request):
        raise httpx.ConnectError("down")
    client._transport = httpx.MockTransport(boom)
    with pytest.raises(account.DesktopAccountError) as exc:
        await instance.delete_account(_wipe_ok)
    assert exc.value.code == "account_service_unavailable"
    assert wiped == [] and instance._binding_path.exists() and instance._token() == "device-token"


@pytest.mark.asyncio
async def test_delete_account_requires_sign_in(manager):
    instance, _ = manager
    instance._session_path.unlink()
    with pytest.raises(account.DesktopAccountError) as exc:
        await instance.delete_account(_wipe_ok)
    assert exc.value.status == 401 and wiped == []


@pytest.mark.asyncio
async def test_delete_account_local_cleanup_failure_keeps_binding(manager):
    instance, client = manager
    client._transport = httpx.MockTransport(lambda r: httpx.Response(200))
    async def broken():
        raise OSError("disk")
    with pytest.raises(account.DesktopAccountError) as exc:
        await instance.delete_account(broken)
    assert exc.value.code == "account_deleted_local_cleanup_failed"
    assert instance._binding_path.exists() and not instance._session_path.exists()


@pytest.mark.asyncio
async def test_sign_out_never_wipes_or_unbinds(manager):
    instance, client = manager
    client._transport = httpx.MockTransport(lambda r: httpx.Response(200))
    await instance.logout()
    assert instance._binding_path.exists() and wiped == []


def test_wipe_files_clears_workspace_and_backups_only(tmp_path):
    profile._current = profile.DesktopProfile(tmp_path, "http://127.0.0.1:1", Fernet.generate_key().decode())
    try:
        (tmp_path / "local" / "agent-1").mkdir(parents=True)
        (tmp_path / "local" / "agent-1" / "a.txt").write_text("x")
        (tmp_path / "backups").mkdir()
        (tmp_path / "backups" / "b.db").write_text("x")
        (tmp_path / "open-dots.db").write_text("db")
        local_data.wipe_files()
        assert (tmp_path / "local").is_dir() and not any((tmp_path / "local").iterdir())
        assert (tmp_path / "backups").is_dir() and not any((tmp_path / "backups").iterdir())
        assert (tmp_path / "open-dots.db").exists()
    finally:
        profile._current = None


@pytest.mark.asyncio
async def test_wipe_database_removes_app_rows_but_keeps_sign_in_rows(db_session):
    db_session.add(Agent(owner_id="u1", name="Keep me not", instructions="x", provider="claude", approval_mode="ask"))
    await db_session.flush()
    assert (await db_session.scalars(select(Agent))).first() is not None
    await local_data.wipe_database(db_session)
    assert (await db_session.scalars(select(Agent))).first() is None


@pytest.mark.asyncio
async def test_routes_require_confirmation_and_refuse_while_a_turn_runs(manager, monkeypatch):
    from fastapi import FastAPI
    from app.auth.routes import require_admin
    from app.db.session import get_db
    from app.routers import desktop_account as routes
    from app.services.local_access_policy import require_local_access

    instance, _ = manager
    api = FastAPI()
    api.include_router(routes.router, prefix="/api/v1")
    running = {"value": False}

    class FakeDb:
        async def scalar(self, _query):
            return 1 if running["value"] else None

    async def fake_db():
        yield FakeDb()

    async def wipe(_db):
        wiped.append(True)

    api.dependency_overrides[require_admin] = lambda: None
    api.dependency_overrides[require_local_access] = lambda: None
    api.dependency_overrides[get_db] = fake_db
    monkeypatch.setattr(routes, "_manager", lambda: instance)
    monkeypatch.setattr(routes, "wipe_local_data", wipe)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api), base_url="http://test") as client:
        bad = await client.post("/api/v1/desktop-account/reset-profile", json={"confirm": "yes"})
        assert bad.status_code == 400 and wiped == []
        running["value"] = True
        busy = await client.post("/api/v1/desktop-account/reset-profile", json={"confirm": "RESET"})
        assert busy.status_code == 409 and busy.json()["detail"]["error_code"] == "turn_running" and wiped == []
        running["value"] = False
        ok = await client.post("/api/v1/desktop-account/reset-profile", json={"confirm": "RESET"})
        assert ok.status_code == 200 and ok.json()["profile_bound"] is False and wiped == [True]
        wrong = await client.post("/api/v1/desktop-account/delete-account", json={"confirm": "RESET"})
        assert wrong.status_code == 400
