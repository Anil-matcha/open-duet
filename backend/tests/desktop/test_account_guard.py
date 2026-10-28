"""An app account and the local launch capability are independent checks."""

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.desktop import account, launch_auth, profile
from app.desktop.account_guard import DesktopAccountMiddleware, signed_in


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setattr(profile, "_current", SimpleNamespace())
    monkeypatch.setattr(launch_auth, "_token", b"t" * 43)
    api = FastAPI()
    api.add_middleware(DesktopAccountMiddleware)
    api.add_middleware(launch_auth.LaunchAuthMiddleware)

    @api.get("/api/v1/agents")
    async def agents():
        return ["local-private-agent"]

    @api.get("/api/v1/desktop-account/status")
    async def status():
        return {"signed_in": False}

    return api


@pytest.mark.asyncio
async def test_launch_token_does_not_replace_email_account(app, monkeypatch):
    class SignedOut:
        async def require_account(self):
            raise account.DesktopAccountError(401, "account_sign_in_required")
    monkeypatch.setattr(account, "get_manager", lambda: SignedOut())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost") as client:
        assert (await client.get("/api/v1/agents")).status_code == 401
        headers = {launch_auth.HEADER: "t" * 43}
        denied = await client.get("/api/v1/agents", headers=headers)
        assert denied.status_code == 401
        assert denied.json()["detail"]["error_code"] == "account_sign_in_required"
        assert "local-private-agent" not in denied.text
        assert (await client.get("/api/v1/desktop-account/status", headers=headers)).status_code == 200


@pytest.mark.asyncio
async def test_valid_account_still_needs_launch_token(app, monkeypatch):
    class SignedIn:
        async def require_account(self):
            return {"email": "owner@acme.dev", "tenantId": "one"}
    monkeypatch.setattr(account, "get_manager", lambda: SignedIn())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost") as client:
        assert (await client.get("/api/v1/agents")).status_code == 401
        result = await client.get("/api/v1/agents", headers={launch_auth.HEADER: "t" * 43})
        assert result.status_code == 200 and result.json() == ["local-private-agent"]


@pytest.mark.asyncio
async def test_background_admission_fails_closed_without_affecting_server(monkeypatch):
    class Unreachable:
        async def require_account(self):
            raise account.DesktopAccountError(503, "account_service_unavailable")
    monkeypatch.setattr(profile, "_current", SimpleNamespace())
    monkeypatch.setattr(account, "get_manager", lambda: Unreachable())
    assert await signed_in() is False
    monkeypatch.setattr(profile, "_current", None)
    assert await signed_in() is True
