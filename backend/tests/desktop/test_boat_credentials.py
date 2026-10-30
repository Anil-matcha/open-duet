"""Boat-key storage for Desktop: encrypted at rest, write-only, no provider calls."""

import json

import httpx
import pytest
from cryptography.fernet import Fernet

from app.auth.routes import require_admin
from app.db.models import Computer
from app.db.session import get_db
from app.desktop import boat_credentials, profile
from app.routers.computer_credentials import router
from app.services.local_access_policy import require_local_access

KEY = "boat_secret_key_123456789"
OTHER_KEY = "boat_other_secret_key_123456789"
PATH = "/api/v1/computers/boat-credentials"


@pytest.fixture
def desktop_profile(tmp_path, monkeypatch):
    key = Fernet.generate_key().decode("ascii")
    monkeypatch.setattr(profile, "_current", profile.DesktopProfile(tmp_path, "http://127.0.0.1:1234", key))
    yield tmp_path


@pytest.fixture
def api(desktop_profile, db_session):
    from fastapi import FastAPI

    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[require_local_access] = lambda: None
    app.dependency_overrides[require_admin] = lambda: object()

    async def session_override():
        yield db_session

    app.dependency_overrides[get_db] = session_override
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost")


@pytest.mark.asyncio
async def test_key_is_encrypted_atomic_owner_only_and_write_only(api, desktop_profile):
    async with api as client:
        before = await client.get(PATH)
        assert before.status_code == 200
        assert before.json() == {"configured": False}
        assert before.headers["cache-control"] == "no-store"

        saved = await client.put(PATH, json={"api_key": KEY})
        assert saved.status_code == 200
        assert saved.json() == {"configured": True}
        assert KEY not in saved.text

        key_path = desktop_profile / boat_credentials.FILE_NAME
        raw = key_path.read_bytes()
        assert KEY.encode() not in raw
        assert oct(key_path.stat().st_mode & 0o777) == "0o600"
        assert not list(desktop_profile.glob(f".{boat_credentials.FILE_NAME}.*"))

        after = await client.get(PATH)
        assert after.json() == {"configured": True}
        assert KEY not in after.text
        assert (await client.delete(PATH)).status_code == 204
        assert not key_path.exists()


@pytest.mark.asyncio
async def test_existing_boat_computer_refuses_replacement_and_removal(api, db_session, desktop_profile):
    store = boat_credentials.BoatCredentials()
    store.set(KEY)
    db_session.add(Computer(owner_id="local-owner", agent_id=501, provider="boat", image="boat-shell"))
    await db_session.flush()

    async with api as client:
        replaced = await client.put(PATH, json={"api_key": OTHER_KEY})
        removed = await client.delete(PATH)

    assert replaced.status_code == 409
    assert replaced.json()["detail"]["error_code"] == "boat_computers_exist"
    assert OTHER_KEY not in replaced.text
    assert removed.status_code == 409
    assert removed.json()["detail"]["error_code"] == "boat_computers_exist"
    assert store.get() == KEY


@pytest.mark.asyncio
async def test_docker_computer_does_not_block_boat_key_management(api, db_session):
    db_session.add(Computer(owner_id="local-owner", agent_id=502, provider="docker", image="python:3.12"))
    await db_session.flush()
    async with api as client:
        response = await client.put(PATH, json={"api_key": KEY})
    assert response.status_code == 200
    assert response.json() == {"configured": True}


@pytest.mark.asyncio
async def test_invalid_or_oversized_body_does_not_echo_key(api):
    async with api as client:
        invalid = await client.put(PATH, json={"api_key": "  " + KEY + "  ", "other": "x"})
        oversized = await client.put(PATH, content=json.dumps({"api_key": "x" * 9000}))
    assert invalid.status_code == 400
    assert KEY not in invalid.text
    assert oversized.status_code == 413
    assert "x" * 128 not in oversized.text


def test_corrupt_or_wrong_key_ciphertext_fails_closed(tmp_path):
    current_key = Fernet.generate_key().decode("ascii")
    other_key = Fernet.generate_key().decode("ascii")
    path = tmp_path / boat_credentials.FILE_NAME
    path.write_bytes(Fernet(other_key.encode()).encrypt(KEY.encode()))
    store = boat_credentials.BoatCredentials(data_dir=tmp_path, encryption_key=current_key)
    with pytest.raises(boat_credentials.CredentialError):
        store.configured()
    with pytest.raises(boat_credentials.CredentialError):
        store.get()


@pytest.mark.asyncio
async def test_routes_are_desktop_only(monkeypatch, api):
    monkeypatch.setattr(profile, "_current", None)
    async with api as client:
        response = await client.get(PATH)
    assert response.status_code == 404
    assert response.json()["detail"]["error_code"] == "desktop_only"
