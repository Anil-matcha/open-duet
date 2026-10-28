"""History export: owner scoped, bounded, credential-free, and signed-in only."""

import io
import json
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import delete

from app.db.models import Agent
from app.routers.agents import get_runtime
from app.routers.history_export import router
from app.services import attachments, history_export
from app.services import thread_store as store
from app.services.local_access_policy import require_local_access
from tests.services.thread_harness import owner, rt, sessions  # noqa: F401


def app_for(runtime):
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_runtime] = lambda: runtime
    app.dependency_overrides[require_local_access] = lambda: None
    return app


@pytest.fixture
async def api(rt):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app_for(rt)), base_url="http://localhost") as client:
        yield client


@pytest.fixture(autouse=True)
async def clean_agents(sessions, owner):
    yield
    async with sessions() as db:
        await db.execute(delete(Agent).where(Agent.owner_id == owner))
        await db.commit()


async def seed(sessions, owner, other):
    async with sessions() as db:
        agent = Agent(owner_id=owner, name="Planner", instructions="be brief", provider="claude", approval_mode="ask")
        db.add(agent)
        await db.commit()
        mine = await store.create_thread(
            db, owner_id=owner, provider="claude", title="Mine", agent_id=agent.id,
            provider_session_id="secret-session-id", provider_state={"token": "private-state"},
        )
        await store.append_event(db, mine.id, "turn.started", {"prompt_text": "hello ../../etc/passwd"})
        await store.append_event(db, mine.id, "assistant.message", {"text": "hi"})
        theirs = await store.create_thread(db, owner_id=other, provider="claude", title="Theirs")
        await store.append_event(db, theirs.id, "turn.started", {"prompt_text": "not yours"})
        return mine, theirs


def read_zip(response) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(response.content))


@pytest.mark.asyncio
async def test_export_contains_only_the_owners_history(api, sessions, owner):
    other = owner + "_other"
    mine, theirs = await seed(sessions, owner, other)
    try:
        response = await api.get("/api/v1/history/export")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        assert "attachment" in response.headers["content-disposition"]
        assert response.headers["cache-control"] == "no-store"
        archive = read_zip(response)
        names = set(archive.namelist())
        assert {"manifest.json", "agents.json", "threads.json", f"threads/{mine.id}/events.ndjson"} <= names
        assert f"threads/{theirs.id}/events.ndjson" not in names
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["version"] == history_export.FORMAT_VERSION
        assert manifest["counts"]["threads"] == 1 and manifest["counts"]["agents"] == 1
        assert manifest["counts"]["events"] >= 2
        blob = b"".join(archive.read(name) for name in names).decode()
        assert "not yours" not in blob and "Theirs" not in blob
        assert "secret-session-id" not in blob and "private-state" not in blob
        assert all(".." not in name and not name.startswith("/") for name in names)
    finally:
        async with sessions() as db:
            await store.delete_thread(db, theirs.id)
            await store.delete_thread(db, mine.id)


@pytest.mark.asyncio
async def test_attachment_metadata_without_file_contents(api, sessions, owner, tmp_path, monkeypatch):
    monkeypatch.setattr(attachments, "root_dir", lambda: tmp_path)
    mine, theirs = await seed(sessions, owner, owner + "_other")
    try:
        saved = attachments.save(mine.id, "note.txt", "text/plain", b"private body text")
        (tmp_path / str(mine.id) / "not-metadata.json").write_text("{}")
        response = await api.get("/api/v1/history/export")
        archive = read_zip(response)
        listed = json.loads(archive.read(f"threads/{mine.id}/attachments.json"))
        assert [item["id"] for item in listed] == [saved.id]
        assert set(listed[0]) == {"id", "name", "mime", "bytes", "kind", "sha256"}
        assert b"private body text" not in b"".join(archive.read(n) for n in archive.namelist())
    finally:
        async with sessions() as db:
            await store.delete_thread(db, theirs.id)
            await store.delete_thread(db, mine.id)


@pytest.mark.asyncio
async def test_size_limit_and_concurrent_export(api, sessions, owner, monkeypatch):
    mine, theirs = await seed(sessions, owner, owner + "_other")
    try:
        monkeypatch.setattr(history_export, "MAX_BYTES", 10)
        response = await api.get("/api/v1/history/export")
        assert response.status_code == 413
        assert response.json()["detail"]["error_code"] == "export_too_large"
        monkeypatch.setattr(history_export, "MAX_BYTES", 256 * 1024 * 1024)
        async with history_export._lock:
            busy = await api.get("/api/v1/history/export")
        assert busy.status_code == 429
        assert (await api.get("/api/v1/history/export")).status_code == 200
    finally:
        async with sessions() as db:
            await store.delete_thread(db, theirs.id)
            await store.delete_thread(db, mine.id)


@pytest.mark.asyncio
async def test_signed_out_desktop_account_cannot_export(monkeypatch):
    """The account guard covers /api/v1/ paths other than its own exempt ones."""
    from app.desktop import account_guard

    from app.desktop import account
    manager = account.AccountManager.__new__(account.AccountManager)

    async def deny():
        raise account.DesktopAccountError(401, "account_sign_in_required")

    manager.require_account = deny
    monkeypatch.setattr(account, "get_manager", lambda: manager)
    monkeypatch.setattr(account_guard.profile, "active", lambda: True)
    app = FastAPI()
    app.add_middleware(account_guard.DesktopAccountMiddleware)
    app.include_router(router, prefix="/api/v1")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://localhost") as client:
        response = await client.get("/api/v1/history/export")
    assert response.status_code == 401
