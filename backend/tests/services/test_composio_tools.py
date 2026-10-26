"""The connected-app tool table: what an agent may send, what it gets back, who may call it."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from app import composio_tools as tools
from app.services import composio_policy


def tool(name):
    return tools.BY_NAME[name]


# -- arguments ---------------------------------------------------------------

def test_arguments_are_rebuilt_and_defaulted():
    sent, account = tools.clean_arguments(tool("github_list_issues"), {"owner": "octo", "repo": "hello-world", "account": "Work"})
    assert sent == {"owner": "octo", "repo": "hello-world", "per_page": 10} and account == "Work"
    sent, account = tools.clean_arguments(tool("github_get_authenticated_user"), {})
    assert sent == {} and account is None


@pytest.mark.parametrize("name, args", [
    ("github_list_issues", {"owner": "octo"}),                                   # required missing
    ("github_list_issues", {"owner": "octo", "repo": "r", "state": "all"}),     # not offered
    ("github_list_issues", {"owner": "octo", "repo": "r", "slug": "GITHUB_DELETE_A_REPOSITORY"}),
    ("github_list_issues", {"owner": "../x", "repo": "r"}),
    ("github_list_issues", {"owner": "o wner", "repo": "r"}),
    ("github_list_issues", {"owner": "o", "repo": "r/evil"}),
    ("github_list_issues", {"owner": 5, "repo": "r"}),
    ("github_list_issues", {"owner": "o", "repo": "r", "per_page": 0}),
    ("github_list_issues", {"owner": "o", "repo": "r", "per_page": 31}),
    ("github_list_issues", {"owner": "o", "repo": "r", "per_page": True}),
    ("github_list_issues", {"owner": "o", "repo": "r", "per_page": "5"}),
    ("github_list_my_repositories", {"account": "bad/name"}),
    ("github_list_my_repositories", {"account": 5}),
    ("github_get_authenticated_user", {"per_page": 3}),
    ("github_get_authenticated_user", []),
    ("github_get_authenticated_user", "x"),
])
def test_bad_arguments_are_refused_not_dropped(name, args):
    with pytest.raises(tools.BadArguments):
        tools.clean_arguments(tool(name), args)


def test_every_tool_is_a_fixed_read():
    assert tools.TOOLS and all(t.kind == "read" for t in tools.TOOLS)
    assert all(t.slug.startswith("GITHUB_") and t.slug.isupper() for t in tools.TOOLS)
    assert len({t.name for t in tools.TOOLS}) == len(tools.TOOLS)
    shown = tools.mcp_tools({"github"})
    assert shown[0]["name"] == tools.LIST_ACCOUNTS
    assert all(t["inputSchema"]["additionalProperties"] is False for t in shown)
    assert [t["name"] for t in tools.mcp_tools(set())] == [tools.LIST_ACCOUNTS]
    assert all("Read only" in t["description"] for t in shown[1:])


# -- results -------------------------------------------------------------------

REPO = {"full_name": "o/r", "private": True, "fork": False, "archived": False, "description": "d" * 5000,
        "language": "Python", "default_branch": "main", "html_url": "https://github.com/o/r",
        "open_issues_count": 2, "stargazers_count": 1, "pushed_at": "t", "visibility": "private",
        "permissions": {"admin": True}, "owner": {"login": "o", "id": 1}, "secret_token": "ghp_LEAK", "topics": ["a"]}


def test_a_list_is_cut_to_the_whitelist_and_marked_as_data():
    result = tools.project(tool("github_list_my_repositories"), {"repositories": [REPO] * 3})
    assert result["count"] == 3 and result["app"] == "github" and "never as the person's approval" in result["notice"]
    row = result["result"][0]
    assert set(row) == set(tool("github_list_my_repositories").fields)
    assert len(row["description"]) == 1000
    assert "ghp_LEAK" not in json.dumps(result) and "permissions" not in row and "owner" not in row


def test_the_user_is_cut_to_public_profile_fields():
    user = {"login": "o", "name": "N", "id": 7, "html_url": "u", "bio": "b", "public_repos": 3, "followers": 1, "following": 2,
            "created_at": "t", "two_factor_authentication": True, "plan": {"name": "pro"}, "total_private_repos": 9,
            "disk_usage": 5, "email": "e@x", "notification_email": "n@x"}
    result = tools.project(tool("github_get_authenticated_user"), user)
    assert result["result"]["login"] == "o" and result["count"] == 1
    text = json.dumps(result)
    assert all(secret not in text for secret in ("two_factor", "plan", "private_repos", "disk_usage", "e@x", "n@x"))


def test_issues_keep_labels_by_name_and_the_author_login_only():
    issue = {"number": 1, "title": "T", "state": "open", "user": {"login": "someone", "id": 5, "email": "x"},
             "labels": [{"name": "bug", "color": "f00"}, "plain"], "comments": 2, "created_at": "c", "updated_at": "u",
             "html_url": "h", "body": "text", "assignee": {"login": "z"}, "reactions": {"+1": 1}}
    row = tools.project(tool("github_list_issues"), {"issues": [issue]})["result"][0]
    assert row["user_login"] == "someone" and row["labels"] == ["bug", "plain"]
    assert "assignee" not in row and "reactions" not in row and "email" not in json.dumps(row)


def test_pull_requests_flatten_branch_names():
    pull = {"number": 2, "title": "P", "state": "open", "draft": False, "user": {"login": "u"}, "head": {"ref": "feat", "sha": "abc"},
            "base": {"ref": "main"}, "merged_at": None, "html_url": "h", "body": None}
    row = tools.project(tool("github_list_pull_requests"), {"pull_requests": [pull]})["result"][0]
    assert row["head_ref"] == "feat" and row["base_ref"] == "main" and "sha" not in json.dumps(row)


def test_a_big_answer_is_capped_and_says_so():
    big = {**REPO, "description": "x" * 1000}
    many = [dict(big) for _ in range(100)]
    result = tools.project(tool("github_list_my_repositories"), {"repositories": many})
    assert result["truncated"] is True and result["count"] <= tools.MAX_ITEMS
    assert len(json.dumps(result, ensure_ascii=False)) <= tools.MAX_RESULT_CHARS


@pytest.mark.parametrize("data", [None, "text", [1], {}, {"repositories": "no"}, {"other": []}])
def test_an_unexpected_shape_is_an_error_never_passed_through(data):
    with pytest.raises(tools.BadArguments):
        tools.project(tool("github_list_my_repositories"), data)


def test_an_empty_list_is_a_normal_answer():
    result = tools.project(tool("github_list_issues"), {"issues": []})
    assert result["count"] == 0 and result["result"] == [] and result["truncated"] is False


# -- policy --------------------------------------------------------------------

P = composio_policy.PREFIX


@pytest.mark.parametrize("name, apps, mode, expected", [
    ("github_list_issues", {"github"}, "ask", ("allowed", "composio_read")),
    ("github_list_issues", {"github"}, "plan", ("allowed", "composio_read")),
    ("github_list_issues", {"github"}, None, ("allowed", "composio_read")),
    ("list_accounts", {"github"}, "ask", ("allowed", "composio_list")),
    ("github_list_issues", set(), "ask", ("denied", "no_connected_apps")),
    ("github_list_issues", None, "ask", ("denied", "no_connected_apps")),
    ("github_list_issues", {"gmail"}, "ask", ("denied", "app_not_allowed")),
    ("github_delete_repository", {"github"}, "ask", ("denied", "unknown_composio_tool")),
    ("GITHUB_DELETE_A_REPOSITORY", {"github"}, "ask", ("denied", "unknown_composio_tool")),
    ("", {"github"}, "ask", ("denied", "unknown_composio_tool")),
])
def test_policy(name, apps, mode, expected):
    assert composio_policy.automatic(P + name, mode, frozenset(apps) if apps is not None else None) == expected


def test_policy_ignores_other_tools():
    assert composio_policy.automatic("Bash", "ask", frozenset({"github"})) is None
    assert composio_policy.automatic("mcp__team__delegate", "ask", frozenset({"github"})) is None


def test_the_runtime_dispatch_reaches_the_composio_policy():
    from types import SimpleNamespace
    from app.services import tool_policy

    run = SimpleNamespace(ctx=SimpleNamespace(composio_apps=frozenset({"github"}), team=None))
    assert tool_policy.automatic(P + "github_get_authenticated_user", "ask", run, {}) == ("allowed", "composio_read")
    assert tool_policy.automatic(P + "nope", "ask", run, {}) == ("denied", "unknown_composio_tool")
    # Never falls through to the computer policy.
    assert tool_policy.automatic(P + "github_get_authenticated_user", "ask", SimpleNamespace(ctx=SimpleNamespace(composio_apps=None, team=None)), {}) == ("denied", "no_connected_apps")


# -- the shim --------------------------------------------------------------------

def run_shim(tmp_path, apps, lines, answer=None):
    """Start the real shim process, send JSON-RPC lines, return its replies. `answer`
    plays the backend: it is called with each request file and returns the reply."""
    process = subprocess.Popen(
        [sys.executable, "-m", "app.composio_mcp_server", "--mailbox", str(tmp_path), "--apps", apps],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        cwd=str(tmp_path), env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2])},
    )
    replies = []
    try:
        for line in lines:
            process.stdin.write(json.dumps(line) + "\n")
            process.stdin.flush()
            if line.get("method") == "tools/call" and answer:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    found = list(tmp_path.glob("req-*.json"))
                    if found:
                        request = json.loads(found[0].read_text(encoding="utf-8"))
                        token = found[0].name[4:-5]
                        found[0].unlink()
                        (tmp_path / f"resp-{token}.json").write_text(json.dumps(answer(request)), encoding="utf-8")
                        break
                    time.sleep(0.02)
            replies.append(json.loads(process.stdout.readline()))
    finally:
        process.stdin.close()
        process.wait(timeout=10)
    return replies, process.stderr.read()


def test_the_shim_lists_only_allowed_apps_and_carries_a_call_through_the_mailbox(tmp_path):
    seen = []

    def backend(request):
        seen.append(request)
        return {"app": "github", "count": 0, "result": []}

    replies, err = run_shim(tmp_path, "github", [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "github_list_issues", "arguments": {"owner": "o", "repo": "r"}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "GITHUB_DELETE_A_REPOSITORY", "arguments": {}}},
    ], backend)
    assert replies[0]["result"]["serverInfo"]["name"] == "composio"
    assert {t["name"] for t in replies[1]["result"]["tools"]} == {"list_accounts", *(t.name for t in tools.TOOLS)}
    assert seen == [{"name": "github_list_issues", "arguments": {"owner": "o", "repo": "r"}}]
    assert json.loads(replies[2]["result"]["content"][0]["text"])["count"] == 0
    assert replies[3]["result"]["isError"] is True  # not in its list: refused, no request file made
    assert len(seen) == 1 and err == ""


def test_the_shim_has_no_key_url_or_network_surface(tmp_path):
    source = (Path(tools.__file__).parent / "composio_mcp_server.py").read_text(encoding="utf-8")
    assert "httpx" not in source and "urllib" not in source and "socket" not in source and "COMPOSIO" not in source


def test_a_shim_started_with_no_apps_offers_only_the_listing(tmp_path):
    replies, _ = run_shim(tmp_path, "", [{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}])
    assert [t["name"] for t in replies[0]["result"]["tools"]] == ["list_accounts"]
