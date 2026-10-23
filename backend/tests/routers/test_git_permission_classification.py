"""The real hook and stored policy must distinguish listings from mutations."""
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

from app.core import hook_token
from app.core.config import settings
from app.db.models.permission_rule import PermissionRule
from app.db.session import get_db
from app.main import app


@pytest.mark.parametrize(
    "command,behavior",
    [
        ("git branch -D topic", "deny"),
        ("git branch new-topic", "deny"),
        ("git remote set-url origin https://example.invalid/changed", "deny"),
        ("git remote remove origin", "deny"),
        ("git branch --list", "allow"),
        ("git remote -v", "allow"),
    ],
)
async def test_git_hook_uses_mutation_policy(db_session, monkeypatch, command, behavior):
    owner = "git_policy_" + uuid4().hex
    db_session.add_all([
        PermissionRule(user_id=owner, bucket="read", decision="allow"),
        PermissionRule(user_id=owner, bucket="create", decision="deny"),
    ])
    await db_session.flush()

    async def session():
        yield db_session

    monkeypatch.setitem(app.dependency_overrides, get_db, session)
    async with AsyncClient(transport=ASGITransport(app), base_url="http://localhost") as client:
        response = await client.post(
            f"/api/v1/permissions/check/{owner}/1",
            headers={"Authorization": f"Bearer {hook_token.scoped_token(settings.HOOK_TOKEN, owner, 1)}"},
            json={"tool_name": "Bash", "tool_input": {"command": command}},
        )
    assert response.status_code == 200, response.text
    assert response.json()["hookSpecificOutput"]["decision"]["behavior"] == behavior


async def test_a_hook_token_is_good_for_only_its_own_user_and_task(db_session, monkeypatch):
    """A token found inside one sandbox must not answer a check for another
    task or another user."""
    owner = "git_policy_" + uuid4().hex
    other = "git_policy_" + uuid4().hex
    db_session.add_all([
        PermissionRule(user_id=owner, bucket="read", decision="allow"),
        PermissionRule(user_id=other, bucket="read", decision="allow"),
    ])
    await db_session.flush()

    async def session():
        yield db_session

    monkeypatch.setitem(app.dependency_overrides, get_db, session)
    body = {"tool_name": "Read", "tool_input": {}}
    good = hook_token.scoped_token(settings.HOOK_TOKEN, owner, 1)
    async with AsyncClient(transport=ASGITransport(app), base_url="http://localhost") as client:
        accepted = await client.post(
            f"/api/v1/permissions/check/{owner}/1",
            headers={"Authorization": f"Bearer {good}"}, json=body,
        )
        wrong_task = await client.post(
            f"/api/v1/permissions/check/{owner}/2",
            headers={"Authorization": f"Bearer {good}"}, json=body,
        )
        wrong_user = await client.post(
            f"/api/v1/permissions/check/{other}/1",
            headers={"Authorization": f"Bearer {good}"}, json=body,
        )
        bare = await client.post(
            f"/api/v1/permissions/check/{owner}/1",
            headers={"Authorization": f"Bearer {settings.HOOK_TOKEN}"}, json=body,
        )
    assert accepted.status_code == 200
    assert wrong_task.status_code == 401
    assert wrong_user.status_code == 401
    assert bare.status_code == 401  # the raw install token is not a hook token
