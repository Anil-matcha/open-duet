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
    {"github": "admin"}, {"github": True}, {"github": ""}, {"gmail": "read"}, {"slack": "read"},
    {"github": "read", "gmail": "read"}, {"": "read"},
])
async def test_only_known_apps_and_known_levels_are_accepted(api, scopes):  # noqa: F811
    agent = await new_agent(api)
    response = await api.patch(f"/api/v1/agents/{agent['id']}", json={"connector_scopes": scopes})
    assert response.status_code in (422,), response.text
    assert (await api.get(f"/api/v1/agents/{agent['id']}")).json()["connector_scopes"] is None


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
