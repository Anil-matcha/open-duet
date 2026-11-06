"""boxd-key storage for Desktop: the same write-only routes as the Boat key, kept apart from it."""

import httpx
import pytest
from cryptography.fernet import Fernet

from app.auth.routes import require_admin
from app.db.models import Computer
from app.db.session import get_db
from app.desktop import boat_credentials, boxd_credentials, profile
from app.routers.computer_credentials import boxd_router
from app.services.local_access_policy import require_local_access

KEY = "test-boxd-secret-key-123456789"
PATH = "/api/v1/computers/boxd-credentials"


@pytest.fixture
def desktop_profile(tmp_path, monkeypatch):
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(profile, "_current", profile.DesktopProfile(tmp_path, "http://127.0.0.1:1234", key))
    yield tmp_path


@pytest.fixture
def api(desktop_profile, db_session):
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(boxd_router, prefix="/api/v1")
    app.dependency_overrides[require_local_access] = lambda: None
    app.dependency_overrides[require_admin] = lambda: object()

    async def session_override():
        yield db_session

    app.dependency_overrides[get_db] = session_override
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost")


@pytest.mark.asyncio
async def test_key_is_encrypted_write_only_and_apart_from_boat(api, desktop_profile):
    async with api as client:
        assert (await client.get(PATH)).json() == {"configured": False}
        saved = await client.put(PATH, json={"api_key": KEY})
        assert saved.status_code == 200 and saved.json() == {"configured": True}
        assert KEY not in saved.text
        path = desktop_profile / boxd_credentials.FILE_NAME
        assert KEY.encode() not in path.read_bytes()
        assert oct(path.stat().st_mode & 0o777) == "0o600"
        assert not (desktop_profile / boat_credentials.FILE_NAME).exists()
        assert (await client.get(PATH)).json() == {"configured": True}
        assert (await client.delete(PATH)).status_code == 204
        assert not path.exists()


@pytest.mark.asyncio
async def test_boxd_computer_blocks_key_changes_but_a_boat_one_does_not(api, db_session):
    boxd_credentials.get_store().set(KEY)
    db_session.add(Computer(owner_id="local-owner", agent_id=601, provider="boat", image="boat/default"))
    await db_session.flush()
    async with api as client:
        assert (await client.put(PATH, json={"api_key": KEY})).status_code == 200
        db_session.add(Computer(owner_id="local-owner", agent_id=602, provider="boxd", image="boxd/default"))
        await db_session.flush()
        removed = await client.delete(PATH)
    assert removed.status_code == 409
    assert removed.json()["detail"]["error_code"] == "boxd_computers_exist"
    assert boxd_credentials.get_store().get() == KEY



@pytest.mark.asyncio
async def test_key_routes_are_not_shadowed_by_the_computer_routes(desktop_profile, db_session):
    # In the full API, GET /computers/{computer_id} would answer
    # /computers/boxd-credentials (and boat-credentials) with a 422 if it
    # were registered first.
    from fastapi import FastAPI

    from app.routers.router import router

    app = FastAPI()
    app.include_router(router)  # already under /api/v1
    app.dependency_overrides[require_local_access] = lambda: None
    app.dependency_overrides[require_admin] = lambda: object()

    async def session_override():
        yield db_session

    app.dependency_overrides[get_db] = session_override
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
        for provider in ("boat", "boxd"):
            response = await client.get(f"/api/v1/computers/{provider}-credentials")
            assert response.status_code == 200, response.text
            assert response.json() == {"configured": False}
