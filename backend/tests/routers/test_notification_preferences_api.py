import httpx
import pytest
from fastapi import FastAPI

from app.core.config import settings
from app.routers.routines import router as routines_router
from app.services import notification_preference
from tests.services.thread_harness import cleanup, cli, owner, rt, sessions  # noqa: F401


@pytest.fixture(autouse=True)
def local_enabled(monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    monkeypatch.setattr(settings, "LOCAL_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")


@pytest.fixture
async def api(tmp_path, monkeypatch):
    # Mock preference file path to a temp dir
    test_file = tmp_path / "test-notification-pref.json"
    monkeypatch.setattr(notification_preference, "preference_file_path", lambda: test_file)

    app = FastAPI()
    app.include_router(routines_router, prefix="/api/v1")
    transport = httpx.ASGITransport(app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        yield client


@pytest.mark.asyncio
async def test_read_default_notification_preferences(api):
    res = await api.get("/api/v1/notifications/preferences")
    assert res.status_code == 200
    data = res.json()
    assert data["desktop_enabled"] is True
    assert data["notify_needs_you"] is True
    assert data["notify_failures"] is True
    assert data["notify_task_due"] is True
    assert data["sound_enabled"] is False


@pytest.mark.asyncio
async def test_update_notification_preferences(api):
    res = await api.put("/api/v1/notifications/preferences", json={
        "desktop_enabled": False,
        "notify_needs_you": True,
        "notify_failures": False,
        "notify_task_due": True,
        "sound_enabled": True,
    })
    assert res.status_code == 200
    data = res.json()
    assert data["desktop_enabled"] is False
    assert data["notify_failures"] is False
    assert data["sound_enabled"] is True

    # Read back to ensure disk persistence
    res2 = await api.get("/api/v1/notifications/preferences")
    assert res2.status_code == 200
    assert res2.json() == data

