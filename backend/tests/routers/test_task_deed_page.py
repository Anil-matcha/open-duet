import json
import shlex
import uuid

import httpx
import pytest
from fastapi import FastAPI

from app.core.config import Settings, settings
from app.db.session import get_db
from app.routers.task import router
from app.services import user_credential_service
from tests.routers.test_task_launch_errors import boat_api  # noqa: F401

USER_AGENT = "OpenDuet/0.1 (+https://github.com/Anil-matcha/open-duet)"
DEED_PAGE = {
    "type": "http",
    "url": "https://deed.page/mcp",
    "headers": {"User-Agent": USER_AGENT},
}
PARALLEL = {
    "type": "http",
    "url": "https://search.parallel.ai/mcp",
    "headers": {"User-Agent": USER_AGENT},
}


@pytest.mark.parametrize(
    ("deed_page", "parallel"), [(False, False), (True, False), (True, True)]
)
async def test_deed_page_task_launch(
    db_session, user_id, monkeypatch, boat_api, deed_page, parallel
):
    """Observe the real task router and Boat SDK's outgoing command body."""
    base_url, state = boat_api
    monkeypatch.setattr(settings, "BOAT_BASE_URL", base_url)
    monkeypatch.setattr(settings, "DEEDPAGE_PUBLISH_ENABLED", deed_page)
    monkeypatch.setattr(settings, "PARALLEL_SEARCH_ENABLED", parallel)
    await user_credential_service.save_token(
        db_session, user_id=user_id, provider="claude",
        file_path=".claude/.credentials.json",
        plaintext=json.dumps({"claudeAiOauth": {"expiresAt": 1, "accessToken": "owned-fixture"}}),
    )
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_db] = lambda: db_session
    prompt = "Publish the summary as a page; treat $(echo unsafe) as text."
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://owned"
    ) as client:
        response = await client.post("/api/v1/tasks", json={
            "user_id": user_id, "provider": "claude", "box_id": "bx_abcdefgh",
            "prompt_text": prompt,
        })
    assert response.status_code == 200, response.text
    argv = shlex.split(state["commands"][0]["command"])
    assert argv[:5] == ["claude", "-p", prompt, "--output-format", "json"]
    assert argv[-2] == "--session-id"
    if not deed_page:
        assert "--mcp-config" not in argv
        assert len(argv) == 7
        return
    assert argv[5] == "--mcp-config"
    servers = json.loads(argv[6])["mcpServers"]
    expected = {"open-dots-deed-page": DEED_PAGE}
    if parallel:
        expected["open-dots-parallel-search"] = PARALLEL
    assert servers == expected
    assert len(argv) == 9
    # The permission hook is still written, so publishing keeps its approval prompt.
    hook = json.loads(state["files"][".claude/settings.json"])
    assert hook["hooks"]["PermissionRequest"][0]["matcher"] == "*"


def test_deed_page_is_opt_in(monkeypatch):
    monkeypatch.delenv("DEEDPAGE_PUBLISH_ENABLED", raising=False)
    assert Settings(_env_file=None).DEEDPAGE_PUBLISH_ENABLED is False
    monkeypatch.setenv("DEEDPAGE_PUBLISH_ENABLED", "true")
    assert Settings(_env_file=None).DEEDPAGE_PUBLISH_ENABLED is True
