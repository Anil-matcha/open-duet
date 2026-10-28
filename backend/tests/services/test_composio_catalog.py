from app import composio_catalog, composio_tools
from app.services import composio_service


def test_every_app_with_a_tool_has_display_text_and_nothing_else_is_listed():
    assert set(composio_tools.apps()) == set(composio_catalog.APP_INFO)
    assert [entry["app"] for entry in composio_catalog.catalog()] == list(composio_tools.apps())


def test_the_catalog_lists_exactly_the_allowlisted_tools_with_their_kinds():
    for entry in composio_catalog.catalog():
        expected = [(tool.name, tool.kind) for tool in composio_tools.TOOLS if tool.app == entry["app"]]
        assert [(tool["name"], tool["kind"]) for tool in entry["tools"]] == expected
        assert expected and {kind for _, kind in expected} <= set(composio_tools.LEVELS)
        assert entry["name"] and entry["description"] and entry["category"]


def test_the_apps_connect_accepts_are_the_catalog_apps():
    assert dict(composio_service.SUPPORTED_APPS) == {entry["app"]: entry["name"] for entry in composio_catalog.catalog()}
