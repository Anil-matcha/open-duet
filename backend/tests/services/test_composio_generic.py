"""The generic connected-app path without a network or a database: what it refuses, how it checks
arguments against a schema, what it trusts, and how it cuts and cleans an answer."""
import json
from types import SimpleNamespace

import pytest

from app import composio_generic as generic
from app import composio_tools
from app.services import composio_policy

KEY = "ak_SECRETKEY_abcdef123456"
SCHEMA = {
    "type": "object",
    "required": ["title"],
    "properties": {
        "title": {"type": "string", "maxLength": 20},
        "count": {"type": "integer", "minimum": 1, "maximum": 5},
        "kind": {"type": "string", "enum": ["a", "b"]},
        "tags": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
        "due": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "meta": {"type": "object", "additionalProperties": {"type": "string"}},
        "free": {"type": "object"},
    },
}


def info(slug="NOTION_CREATE_PAGE", toolkit="notion", schema=SCHEMA, version="v1", deprecated=False):
    return SimpleNamespace(slug=slug, name="Create page", description="Makes a page.", toolkit=toolkit, version=version,
                           schema=schema, tags=(), deprecated=deprecated)


# -- what the agent is shown ----------------------------------------------------------------

def test_the_tools_are_shown_only_for_apps_without_curated_tools_and_run_only_where_it_may_change():
    assert generic.mcp_tools([], []) == []
    search_only = generic.mcp_tools(["notion"], [])
    assert [t["name"] for t in search_only] == [generic.SEARCH]
    both = generic.mcp_tools(["notion", "slack"], ["slack"])
    assert [t["name"] for t in both] == [generic.SEARCH, generic.RUN]
    assert both[1]["inputSchema"]["properties"]["app"]["enum"] == ["slack"]
    assert all(t["inputSchema"]["additionalProperties"] is False for t in both)
    assert composio_tools.generic_apps({"github": "write", "notion": "write", "composio": "write", "slack": "read"}) == (["notion", "slack"], ["notion"])


def test_the_shim_lists_the_generic_tools_next_to_the_curated_ones():
    names = [t["name"] for t in composio_tools.mcp_tools({"github": "read", "notion": "write"})]
    assert generic.SEARCH in names and generic.RUN in names and "github_get_issue" in names
    assert generic.SEARCH not in [t["name"] for t in composio_tools.mcp_tools({"github": "write"})]
    assert "approves every call" in composio_tools.tool_note({"notion": "write"})
    assert "only be looked at" in composio_tools.tool_note({"notion": "read"})


# -- what can never be reached -------------------------------------------------------------------

@pytest.mark.parametrize("app,action,code", [
    ("github", "GITHUB_DELETE_A_REPOSITORY", "use_curated"),      # a curated app has only its curated tools
    ("gmail", "GMAIL_SEND_EMAIL", "use_curated"),
    ("googlecalendar", "GOOGLECALENDAR_DELETE_EVENT", "use_curated"),
    ("composio", "COMPOSIO_REMOTE_BASH_TOOL", "blocked_app"),
    ("codeinterpreter", "CODEINTERPRETER_RUN_TERMINAL_CMD", "blocked_app"),
    ("notion", "COMPOSIO_REMOTE_WORKBENCH", "blocked_action"),
    ("notion", "COMPOSIO_MULTI_EXECUTE_TOOL", "blocked_action"),
    ("notion", "NOTION_PROXY_EXECUTE", "blocked_action"),
    ("notion", "NOTION_RUN_CODE", "blocked_action"),
    ("notion", "SLACK_SEND_MESSAGE", "wrong_app"),                 # a name from another app
    ("notion", "NOTIONX_CREATE", "wrong_app"),
])
def test_actions_that_run_code_or_belong_elsewhere_are_refused(app, action, code):
    assert generic.refusal_for(app, action)[0] == code


def test_an_ordinary_action_of_an_ordinary_app_is_not_refused():
    assert generic.refusal_for("notion", "NOTION_CREATE_PAGE") is None
    assert generic.refusal_for("google-sheets".replace("-", "_"), None) is None
    assert generic.refusal_for("ms-teams", "MS_TEAMS_SEND_MESSAGE") is None


def test_a_search_result_leaves_out_blocked_and_deprecated_actions():
    found = generic.search_result("notion", [info(), info("NOTION_PROXY_EXECUTE"), info("NOTION_OLD", deprecated=True)], None)
    assert [row["action"] for row in found["actions"]] == ["NOTION_CREATE_PAGE"]


# -- reading a request ---------------------------------------------------------------------------------

def test_requests_are_read_strictly():
    assert generic.parse_search({"app": "notion", "query": " pages "}) == ("notion", "pages", None)
    for bad in ({"app": "Not Valid"}, {"app": "notion", "query": "x" * 201}, {"app": "notion", "x": 1}, {"app": "notion", "cursor": ""}, "text"):
        with pytest.raises(generic.GenericError):
            generic.parse_search(bad)
    good = {"app": "notion", "action": "NOTION_CREATE_PAGE", "revision": "0123456789abcdef", "arguments": {"title": "x"}}
    assert generic.parse_run(good)["account"] is None
    for change in ({"action": "notion_create"}, {"revision": "nope"}, {"arguments": "x"}, {"account": "bad\nname"}, {"extra": 1}, {"app": "Bad App"}):
        with pytest.raises(generic.GenericError):
            generic.parse_run({**good, **change})


# -- schemas and arguments ------------------------------------------------------------------------------------

def test_a_plain_schema_can_be_checked_and_a_clever_one_cannot():
    assert generic.check_schema(SCHEMA) is None
    assert generic.check_schema({"type": "object", "properties": {"a": {"$ref": "#/x"}}})
    assert generic.check_schema({"type": "object", "allOf": [{}]})
    assert generic.check_schema({"type": "object", "properties": {"a": {"not": {}}}})
    assert generic.check_schema({"type": "object", "properties": {"a": {"type": "weird"}}})
    assert generic.check_schema(None) and generic.check_schema([])
    deep = {"type": "string"}
    for _ in range(12):
        deep = {"type": "object", "properties": {"a": deep}}
    assert generic.check_schema(deep)
    assert generic.check_schema({"type": "object", "properties": {f"p{i}": {"type": "string"} for i in range(401)}})


def test_good_arguments_pass_and_each_kind_of_wrong_one_is_named():
    generic.validate_arguments(SCHEMA, {"title": "Plan", "count": 2, "kind": "a", "tags": ["x"], "due": None, "meta": {"k": "v"}, "free": {"any": [1, {"b": None}]}})
    generic.validate_arguments(SCHEMA, {"title": "Plan", "due": "2026-11-01"})
    for bad, hint in [
        ({}, "title"), ({"title": 5}, "title"), ({"title": "x" * 21}, "title"), ({"title": "t", "count": 0}, "count"),
        ({"title": "t", "count": True}, "count"), ({"title": "t", "kind": "c"}, "kind"), ({"title": "t", "tags": ["a"] * 4}, "tags"),
        ({"title": "t", "tags": [1]}, "tags"), ({"title": "t", "meta": {"k": 1}}, "meta.k"), ({"title": "t", "nope": 1}, "nope"),
        ({"title": "t", "due": 3}, "due"), ({"title": "t\x00"}, "title"),
    ]:
        with pytest.raises(generic.GenericError, match=hint):
            generic.validate_arguments(SCHEMA, bad)


def test_arguments_must_be_small_shallow_and_free_of_credentials():
    big = {"title": "t", "free": {"text": "y" * generic.MAX_ARGS_BYTES}}
    with pytest.raises(generic.GenericError, match="too large"):
        generic.validate_arguments(SCHEMA, big)
    deep = {}
    node = deep
    for _ in range(9):
        node["a"] = {}
        node = node["a"]
    with pytest.raises(generic.GenericError, match="deeply"):
        generic.validate_arguments(SCHEMA, {"title": "t", "free": deep})
    for name in ("password", "api_key", "Authorization", "client_secret", "access_token", "private-key"):
        with pytest.raises(generic.GenericError, match="Credentials"):
            generic.validate_arguments({"type": "object", "properties": {name: {"type": "string"}}}, {name: "x"})
    generic.validate_arguments({"type": "object", "properties": {"page_token": {"type": "string"}}}, {"page_token": "next"})  # not a credential
    with pytest.raises(generic.GenericError):
        generic.validate_arguments(SCHEMA, {"title": "t", "free": {"n": float("nan")}})


# -- what is trusted ------------------------------------------------------------------------------------------------

def test_the_revision_follows_the_schema_the_version_and_the_classification(monkeypatch):
    base = generic.revision_of("NOTION_CREATE_PAGE", "v1", SCHEMA)
    assert base == generic.revision_of("NOTION_CREATE_PAGE", "v1", json.loads(json.dumps(SCHEMA)))
    assert base != generic.revision_of("NOTION_CREATE_PAGE", "v2", SCHEMA)
    assert base != generic.revision_of("NOTION_CREATE_PAGE", "v1", {**SCHEMA, "required": []})
    assert base != generic.revision_of("NOTION_OTHER", "v1", SCHEMA)
    assert generic.is_reviewed_read("NOTION_CREATE_PAGE", "v1", SCHEMA) is False
    monkeypatch.setitem(generic.REVIEWED_READS, "NOTION_CREATE_PAGE", generic.action_digest("v1", SCHEMA))
    assert generic.is_reviewed_read("NOTION_CREATE_PAGE", "v1", SCHEMA) is True
    assert generic.revision_of("NOTION_CREATE_PAGE", "v1", SCHEMA) != base          # reviewing it changes the revision
    assert generic.is_reviewed_read("NOTION_CREATE_PAGE", "v2", SCHEMA) is False     # a new version is no longer reviewed


def test_nothing_is_reviewed_until_someone_does_it():
    assert generic.REVIEWED_READS == {}


# -- the approval policy ----------------------------------------------------------------------------------------------

RUN = composio_policy.PREFIX + generic.RUN
SEARCH = composio_policy.PREFIX + generic.SEARCH


def run_args(app="notion", action="NOTION_CREATE_PAGE"):
    return {"app": app, "action": action, "revision": "0" * 16, "arguments": {}}


@pytest.mark.parametrize("tool,mode,levels,args,expected", [
    (SEARCH, "ask", {"notion": "read"}, {"app": "notion"}, ("allowed", "composio_search")),
    (SEARCH, "plan", {"notion": "write"}, {"app": "notion"}, ("allowed", "composio_search")),
    (SEARCH, "ask", {"notion": "read"}, {"app": "slack"}, ("denied", "app_not_allowed")),
    (SEARCH, "ask", {"github": "read"}, {"app": "github"}, ("denied", "generic_not_available")),
    (SEARCH, "ask", {"composio": "write"}, {"app": "composio"}, ("denied", "generic_not_available")),
    (SEARCH, "ask", {"notion": "read"}, None, ("denied", "app_not_allowed")),
    (RUN, "ask", {"notion": "write"}, run_args(), None),                                     # a card, every time
    (RUN, None, {"notion": "write"}, run_args(), None),
    (RUN, "accept_edits", {"notion": "write"}, run_args(), None),
    (RUN, "ask", {"notion": "read"}, run_args(), ("denied", "write_not_allowed")),          # unknown needs write
    (RUN, "plan", {"notion": "write"}, run_args(), ("denied", "plan_mode")),
    (RUN, "ask", {"slack": "write"}, run_args(), ("denied", "app_not_allowed")),
    (RUN, "ask", {"github": "write"}, run_args("github", "GITHUB_DELETE_A_REPOSITORY"), ("denied", "generic_not_available")),
    (RUN, "ask", {"notion": "write"}, run_args("notion", "COMPOSIO_REMOTE_BASH_TOOL"), ("denied", "generic_not_available")),
    (RUN, "ask", {"notion": "write"}, run_args("notion", "SLACK_SEND_MESSAGE"), ("denied", "generic_not_available")),
    (RUN, "ask", {}, run_args(), ("denied", "no_connected_apps")),
])
def test_policy_for_generic_tools(tool, mode, levels, args, expected):
    assert composio_policy.automatic(tool, mode, levels, args) == expected


def test_a_reviewed_read_needs_a_card_for_its_first_use_only(monkeypatch):
    monkeypatch.setitem(generic.REVIEWED_READS, "NOTION_SEARCH", "digest")
    args = run_args("notion", "NOTION_SEARCH")
    assert composio_policy.automatic(RUN, "ask", {"notion": "read"}, args, False) is None
    assert composio_policy.automatic(RUN, "ask", {"notion": "write"}, args, False) is None
    assert composio_policy.automatic(RUN, "ask", {"notion": "read"}, args, True) == ("allowed", "composio_reviewed_read")
    assert composio_policy.automatic(RUN, "plan", {"notion": "read"}, args, True) == ("allowed", "composio_reviewed_read")
    # An action that is not reviewed never becomes automatic, whatever the first-use hint says.
    assert composio_policy.automatic(RUN, "ask", {"notion": "write"}, run_args(), True) is None


# -- what comes back ---------------------------------------------------------------------------------------------------------

def test_an_answer_is_cut_cleaned_and_marked_as_other_peoples_data():
    data = {
        "title": "T", "access_token": "tok", "nested": {"password": "p", "list": list(range(100))},
        "text": "x" * 5000, "echo": f"key {KEY} and Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        "gh": "ghp_" + "a" * 30, "ok": True,
    }
    result = generic.bounded_result("notion", "NOTION_X", data)
    text = json.dumps(result)
    assert result["truncated"] is True and "Data from notion" in result["notice"]
    assert result["result"]["access_token"] == "[redacted]" and result["result"]["nested"]["password"] == "[redacted]"
    assert KEY not in text and "ghp_" not in text and "Bearer abc" not in text and "tok" not in result["result"].values()
    assert len(result["result"]["nested"]["list"]) == 30 and len(result["result"]["text"]) <= 2001
    assert len(text) <= generic.MAX_RESULT_CHARS


def test_a_huge_answer_is_still_bounded_and_deep_ones_are_flattened():
    huge = {f"k{i}": ["y" * 400 for _ in range(30)] for i in range(40)}
    result = generic.bounded_result("notion", "NOTION_X", huge)
    assert len(json.dumps(result, ensure_ascii=False)) <= generic.MAX_RESULT_CHARS and result["truncated"] is True
    deep = {}
    node = deep
    for _ in range(8):
        node["a"] = {}
        node = node["a"]
    assert "[too deep]" in json.dumps(generic.bounded_result("notion", "NOTION_X", deep))
    plain = generic.bounded_result("notion", "NOTION_X", {"a": 1})
    assert plain["truncated"] is False and plain["result"] == {"a": 1}


def test_search_results_list_parameters_and_say_when_an_action_cannot_run():
    unsupported = info("NOTION_ODD", schema={"type": "object", "properties": {"a": {"$ref": "#"}}})
    found = generic.search_result("notion", [info(), unsupported], "next")
    first, second = found["actions"]
    assert first["runnable"] is True and first["revision"] == generic.revision_of("NOTION_CREATE_PAGE", "v1", SCHEMA)
    assert {"name": "title", "type": "string", "required": True} == {k: v for k, v in first["parameters"][0].items() if k != "description"}
    assert second["runnable"] is False and "parameters" not in second and "cannot be checked" in second["not_runnable_because"]
    assert found["next_cursor"] == "next" and "not every action" in found["note"]
