"""PATCH /api/v1/agents/{id} with connector_scopes: which connected apps an agent may read."""
import pytest

from tests.routers.test_engines_api import api, local_enabled  # noqa: F401
from tests.services.thread_harness import cleanup, owner, sessions  # noqa: F401


def code_of(response) -> str:
    return response.json()["detail"]["error_code"]


async def new_agent(api, provider="claude"):  # noqa: F811
    response = await api.post("/api/v1/agents", json={"name": f"Reader {provider}", "provider": provider})
    assert response.status_code == 201, response.text
    return response.json()


async def test_a_new_agent_has_no_apps_and_they_can_be_allowed_and_removed(api):  # noqa: F811
    agent = await new_agent(api)
    assert agent["connector_scopes"] is None
    allowed = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": {"github": "read"}})
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["connector_scopes"] == {"github": "read"}
    assert (await api.get(f"/api/v1/agents/{agent['id']}")).json()["connector_scopes"] == {"github": "read"}
    # An empty set and an explicit null both mean none.
    for body in ({}, None):
        await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": {"github": "read"}})
        cleared = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": body})
        assert cleared.status_code == 200 and cleared.json()["connector_scopes"] is None


@pytest.mark.parametrize("scopes", [
    {"github": "admin"}, {"github": True}, {"github": ""}, {"slack": "read"},
    {"github": "read", "slack": "read"}, {"": "read"}, {"googlecalendar": "admin"},
])
async def test_only_known_apps_and_known_levels_are_accepted(api, scopes):  # noqa: F811
    agent = await new_agent(api)
    response = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": scopes})
    assert response.status_code in (422,), response.text
    assert (await api.get(f"/api/v1/agents/{agent['id']}")).json()["connector_scopes"] is None


@pytest.mark.parametrize("scopes", [
    {"gmail": "read"}, {"gmail": "write"}, {"googlecalendar": "read"}, {"googlecalendar": "write"},
    {"github": "read", "gmail": "read", "googlecalendar": "read"},
])
async def test_supported_apps_can_be_allowed(api, scopes):  # noqa: F811
    agent = await new_agent(api)
    response = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": scopes})
    assert response.status_code == 200, response.text
    assert response.json()["connector_scopes"] == scopes


@pytest.mark.parametrize("scopes", [["github"], "github", 5])
async def test_a_malformed_value_is_refused(api, scopes):  # noqa: F811
    agent = await new_agent(api)
    assert (await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": scopes})).status_code == 422


async def test_an_engine_that_cannot_mount_them_is_refused(api):  # noqa: F811
    agent = await new_agent(api, provider="openai_compat")
    response = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": {"github": "read"}})
    assert response.status_code == 409 and code_of(response) == "engine_without_connected_apps"


async def test_moving_an_allowed_agent_to_another_engine_is_refused(api):  # noqa: F811
    agent = await new_agent(api)
    await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": {"github": "read"}})
    response = await api.patch(f"/api/v1/agents/{agent['id']}", json={"provider": "openai_compat"})
    assert response.status_code == 409 and code_of(response) == "engine_without_connected_apps"
    assert (await api.get(f"/api/v1/agents/{agent['id']}")).json()["provider"] == "claude"


async def test_a_copy_of_an_agent_starts_with_no_apps(api):  # noqa: F811
    agent = await new_agent(api)
    await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": {"github": "read"}})
    copy = await api.post(f"/api/v1/agents/{agent['id']}/duplicate")
    assert copy.status_code == 201 and copy.json()["connector_scopes"] is None


async def test_the_write_level_is_accepted_and_can_be_lowered(api):  # noqa: F811
    agent = await new_agent(api)
    up = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": {"github": "write"}})
    assert up.status_code == 200 and up.json()["connector_scopes"] == {"github": "write"}
    down = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": {"github": "read"}})
    assert down.json()["connector_scopes"] == {"github": "read"}


# -- apps without curated tools -----------------------------------------------------------------------------------

@pytest.fixture
def listed(monkeypatch):
    """Composio lists these apps; every question is recorded."""
    from app.services import composio_service
    asked = []

    async def known_app(db, owner_id, make_client, slug):
        asked.append(slug)
        if slug == "unreachable":
            raise composio_service.UserError(503, "composio_unavailable", "Could not reach Composio.")
        return slug in {"slack", "notion", "github"}

    monkeypatch.setattr(composio_service, "known_app", known_app)
    return asked


async def test_an_app_composio_lists_can_be_allowed_at_either_level(api, listed):  # noqa: F811
    agent = await new_agent(api)
    url = f"/api/v1/agents/{agent['id']}"
    for scopes in ({"slack": "read"}, {"slack": "write"}, {"github": "write", "notion": "read", "slack": "write"}):
        response = await api.patch(url, json={"connector_scopes": scopes})
        assert response.status_code == 200, response.text
        assert response.json()["connector_scopes"] == dict(sorted(scopes.items()))


@pytest.mark.parametrize("scopes", [
    {"made_up": "read"}, {"Slack": "read"}, {"slack": "admin"}, {"composio": "write"}, {"codeinterpreter": "read"},
    {"a b": "read"}, {"../x": "read"}, {"x" * 65: "read"}, {"slack": "read", "made_up": "read"},
])
async def test_an_app_composio_does_not_list_or_a_blocked_one_fails_closed(api, listed, scopes):  # noqa: F811
    agent = await new_agent(api)
    response = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": scopes})
    assert response.status_code == 422 and code_of(response) == "invalid_connector_scopes"
    assert (await api.get(f"/api/v1/agents/{agent['id']}")).json()["connector_scopes"] is None


async def test_composio_is_asked_only_about_apps_that_are_new_to_the_agent(api, listed):  # noqa: F811
    agent = await new_agent(api)
    url = f"/api/v1/agents/{agent['id']}"
    await api.patch(url, json={"connector_scopes": {"slack": "read", "github": "read"}})
    assert listed == ["slack"]                      # curated apps are never asked about
    await api.patch(url, json={"connector_scopes": {"slack": "write", "github": "read"}})
    assert listed == ["slack"]                      # already allowed: changing its level needs no question
    await api.patch(url, json={"connector_scopes": {"slack": "write", "notion": "read"}})
    assert listed == ["slack", "notion"]


async def test_when_composio_cannot_be_asked_the_change_is_refused_not_guessed(api, listed):  # noqa: F811
    agent = await new_agent(api)
    response = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": {"unreachable": "read"}})
    assert response.status_code == 502 and code_of(response) == "composio_unavailable"
    assert (await api.get(f"/api/v1/agents/{agent['id']}")).json()["connector_scopes"] is None
