import httpx
import pytest
from fastapi import FastAPI

from app.core.config import settings
from app.routers.profile import router as profile_router
from app.routers.threads import get_runtime
from app.routers.usage import router as usage_router
from tests.services.thread_harness import cleanup, cli, owner, rt, sessions  # noqa: F401


@pytest.fixture(autouse=True)
def local_enabled(monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    monkeypatch.setattr(settings, "LOCAL_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")


@pytest.fixture
async def api(rt):
    app = FastAPI()
    app.include_router(usage_router, prefix="/api/v1")
    app.include_router(profile_router, prefix="/api/v1")
    app.dependency_overrides[get_runtime] = lambda: rt
    transport = httpx.ASGITransport(app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        yield client


@pytest.mark.asyncio
async def test_profile_read_and_update(api):
    # Initial read
    res = await api.get("/api/v1/profile")
    assert res.status_code == 200
    data = res.json()
    assert "name" in data
    assert "avatar_url" in data

    # Update profile
    put = await api.put("/api/v1/profile", json={"name": "Alice Developer", "bio": "AI Engineer"})
    assert put.status_code == 200
    updated = put.json()
    assert updated["ok"] is True
    assert updated["name"] == "Alice Developer"
    assert updated["bio"] == "AI Engineer"

    # Re-read to confirm persistence
    re_read = await api.get("/api/v1/profile")
    assert re_read.status_code == 200
    re_data = re_read.json()
    assert re_data["name"] == "Alice Developer"
    assert re_data["bio"] == "AI Engineer"


@pytest.mark.asyncio
async def test_usage_annual(api):
    res = await api.get("/api/v1/usage/annual?days=365")
    assert res.status_code == 200
    data = res.json()
    assert "days" in data
    assert len(data["days"]) > 300
    assert "tokens" in data
    assert "messages" in data
    assert "models" in data
    assert "providers" in data
    assert "teammates" in data
