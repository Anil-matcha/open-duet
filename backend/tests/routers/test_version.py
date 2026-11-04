import httpx
import pytest
from fastapi import FastAPI

from app.routers.version import router as version_router
from app.services import version_service
from app.services.version_service import compare_versions, detect_install_kind, get_update_command


@pytest.fixture
async def api():
    app = FastAPI()
    app.include_router(version_router, prefix="/api/v1")
    transport = httpx.ASGITransport(app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        yield client


def test_compare_versions():
    assert compare_versions("0.8.1", "0.8.1") == 0
    assert compare_versions("0.8.2", "0.8.1") == 1
    assert compare_versions("0.8.0", "0.8.1") == -1
    assert compare_versions("0.9.0", "0.8.9") == 1
    assert compare_versions("1.0.0", "0.9.9") == 1
    assert compare_versions("v0.8.2", "0.8.1") == 1
    assert compare_versions("0.8.1", "0.8.1-rc1") == 1
    assert compare_versions("0.8.1-rc1", "0.8.1-rc2") == -1


def test_install_kind_and_update_command():
    assert detect_install_kind({"OPEN_DOTS_DOCKER": "1"}) == "docker"
    assert "docker compose" in get_update_command("docker")

    assert detect_install_kind({"OPEN_DOTS_SERVICE": "1"}) == "service"
    assert "systemctl restart" in get_update_command("service")

    assert get_update_command("git") == "git pull && uv sync && (cd frontend && npm run build)"


@pytest.mark.asyncio
async def test_read_version_endpoint(api):
    res = await api.get("/api/v1/version")
    assert res.status_code == 200
    data = res.json()
    assert data["current_version"] == version_service.APP_VERSION
    assert "install_kind" in data
    assert "update_command" in data
    assert "release_notes_url" in data
    assert isinstance(data["update_available"], bool)


@pytest.mark.asyncio
async def test_read_version_with_newer_release(api, monkeypatch):
    async def mock_fetch_release(client=None):
        return "0.9.0", "https://github.com/Anil-matcha/open-duet/releases/tag/v0.9.0"

    monkeypatch.setattr(version_service, "fetch_latest_release", mock_fetch_release)

    res = await api.get("/api/v1/version?refresh=true")
    assert res.status_code == 200
    data = res.json()
    assert data["update_available"] is True
    assert data["latest_version"] == "0.9.0"
    assert data["release_notes_url"] == "https://github.com/Anil-matcha/open-duet/releases/tag/v0.9.0"


@pytest.mark.asyncio
async def test_read_version_with_same_release(api, monkeypatch):
    async def mock_fetch_release(client=None):
        return "0.8.1", "https://github.com/Anil-matcha/open-duet/releases/tag/v0.8.1"

    monkeypatch.setattr(version_service, "fetch_latest_release", mock_fetch_release)

    res = await api.get("/api/v1/version?refresh=true")
    assert res.status_code == 200
    data = res.json()
    assert data["update_available"] is False
    assert data["latest_version"] == "0.8.1"


@pytest.mark.asyncio
async def test_read_version_network_error_graceful(api, monkeypatch):
    async def mock_fetch_release(client=None):
        return None, None

    monkeypatch.setattr(version_service, "fetch_latest_release", mock_fetch_release)

    res = await api.get("/api/v1/version?refresh=true")
    assert res.status_code == 200
    data = res.json()
    assert data["current_version"] == version_service.APP_VERSION
    assert data["update_available"] is False
    assert data["latest_version"] is None

