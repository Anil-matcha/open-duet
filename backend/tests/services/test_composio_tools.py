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


def test_every_tool_is_one_fixed_tool_and_writes_are_a_short_list():
    assert tools.TOOLS and all(t.kind in tools.LEVELS for t in tools.TOOLS)
    prefixes = {"github": "GITHUB_", "gmail": "GMAIL_", "googlecalendar": "GOOGLECALENDAR_"}
    assert all(t.slug.startswith(prefixes[t.app]) and t.slug.isupper() for t in tools.TOOLS)
    assert len({t.name for t in tools.TOOLS}) == len(tools.TOOLS) == len({t.slug for t in tools.TOOLS})
    writes = {t.name for t in tools.TOOLS if t.kind == "write"}
    assert writes == {"github_create_issue", "github_comment_on_issue", "github_close_issue", "github_reopen_issue", "github_dispatch_workflow", "gmail_create_draft_reply"}
    for word in ("delete", "merge", "push", "force", "settings", "collaborator", "secret", "token"):
        assert not any(word in t.name or word in t.slug.lower() for t in tools.TOOLS), word


def test_the_shim_shows_tools_by_level():
    read = {t["name"] for t in tools.mcp_tools({"github": "read"})}
    write = {t["name"] for t in tools.mcp_tools({"github": "write"})}
    assert tools.LIST_ACCOUNTS in read and tools.LIST_ACCOUNTS in write
    assert read < write and write - read == {"github_create_issue", "github_comment_on_issue", "github_close_issue", "github_reopen_issue", "github_dispatch_workflow"}
    assert [t["name"] for t in tools.mcp_tools({})] == [tools.LIST_ACCOUNTS]
    assert [t["name"] for t in tools.mcp_tools({"github": "admin"})] == [tools.LIST_ACCOUNTS]
    assert all(t["inputSchema"]["additionalProperties"] is False for t in tools.mcp_tools({"github": "write"}))
    assert "ask the person first" in tools.tool_note({"github": "write"}) and "only read" in tools.tool_note({"github": "read"})
    note = tools.tool_note({"github": "read"})
    # The agent is told to prefer the app over local files and how to find the owner.
    assert "not local files or the shell" in note and "github_get_authenticated_user" in note and "connected apps (github)" in note


@pytest.mark.parametrize("level, kind, ok", [
    ("read", "read", True), ("write", "read", True), ("write", "write", True),
    ("read", "write", False), (None, "read", False), ("admin", "read", False), ("", "write", False),
])
def test_a_level_allows_its_own_tools_and_the_ones_below(level, kind, ok):
    assert tools.allows(level, kind) is ok


O, R = "o", "r"


@pytest.mark.parametrize("name, args", [
    ("github_get_issue", {"owner": O, "repo": R, "issue_number": 0}),
    ("github_get_issue", {"owner": O, "repo": R, "issue_number": 2_000_000_001}),
    ("github_get_issue", {"owner": O, "repo": R, "issue_number": "3"}),
    ("github_get_issue", {"owner": "..", "repo": R, "issue_number": 1}),
    ("github_get_issue", {"owner": ".", "repo": R, "issue_number": 1}),
    ("github_get_file", {"owner": O, "repo": R, "path": "../secret"}),
    ("github_get_file", {"owner": O, "repo": R, "path": "a/../../b"}),
    ("github_get_file", {"owner": O, "repo": R, "path": "/etc/passwd"}),
    ("github_get_file", {"owner": O, "repo": R, "path": "a\x00b"}),
    ("github_get_file", {"owner": O, "repo": R, "path": ""}),
    ("github_get_file", {"owner": O, "repo": R, "path": "x", "ref": "a..b"}),
    ("github_get_file", {"owner": O, "repo": R, "path": "x", "ref": "main; rm"}),
    ("github_list_commits", {"owner": O, "repo": R, "sha": "x" * 201}),
    ("github_search_issues", {"q": "x" * 257}),
    ("github_search_issues", {"q": "two\nlines"}),
    ("github_search_issues", {"q": ""}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "two\nlines"}),
    ("github_create_issue", {"owner": O, "repo": R, "title": ""}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "t" * 257}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "t", "body": "b" * 10_001}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "t", "body": "nul\x00byte"}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "t", "labels": "bug"}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "t", "labels": [f"l{i}" for i in range(11)]}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "t", "labels": [5]}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "t", "labels": ["a\nb"]}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "t", "assignees": ["someone"]}),
    ("github_create_issue", {"owner": O, "repo": R, "title": "t", "milestone": "1"}),
    ("github_comment_on_issue", {"owner": O, "repo": R, "issue_number": 1}),
    ("github_comment_on_issue", {"owner": O, "repo": R, "issue_number": 1, "body": ""}),
    ("github_close_issue", {"owner": O, "repo": R, "issue_number": 1, "state_reason": "duplicate"}),
    ("github_close_issue", {"owner": O, "repo": R, "issue_number": 1, "state": "closed"}),
    ("github_reopen_issue", {"owner": O, "repo": R, "issue_number": 1, "state_reason": "reopened"}),
])
def test_the_new_tools_refuse_what_does_not_fit(name, args):
    with pytest.raises(tools.BadArguments):
        tools.clean_arguments(tool(name), args)


def test_good_arguments_for_the_new_tools_are_rebuilt_as_given():
    created = {"owner": O, "repo": R, "title": "A bug", "body": "line 1\nline 2\ttab", "labels": ["bug", "help wanted"]}
    assert tools.clean_arguments(tool("github_create_issue"), created) == (created, None)
    closed = {"owner": O, "repo": R, "issue_number": 7, "state_reason": "not_planned"}
    assert tools.clean_arguments(tool("github_close_issue"), {**closed, "account": "work"}) == (closed, "work")
    assert tools.clean_arguments(tool("github_get_file"), {"owner": O, "repo": R, "path": "docs/guide.md", "ref": "feature/x-1"})[0]["path"] == "docs/guide.md"
    assert tools.clean_arguments(tool("github_search_issues"), {"q": "repo:o/r is:open label:bug"})[0] == {"q": "repo:o/r is:open label:bug", "per_page": 10}
    assert tools.clean_arguments(tool("github_list_commits"), {"owner": O, "repo": R})[0]["per_page"] == 10


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


def test_new_reads_are_cut_to_their_fields():
    issue = {"number": 3, "title": "T", "state": "open", "user": {"login": "u", "id": 1}, "labels": [{"name": "bug"}], "comments": 2,
             "created_at": "c", "updated_at": "u", "closed_at": None, "html_url": "h", "body": "b", "assignee": {"login": "z"}, "node_id": "N"}
    row = tools.project(tool("github_get_issue"), issue)["result"]
    assert row["number"] == 3 and row["user_login"] == "u" and row["labels"] == ["bug"] and "assignee" not in row and "node_id" not in row
    comments = tools.project(tool("github_list_issue_comments"), {"comments": [{"id": 9, "user": {"login": "u"}, "body": "hi", "author_association": "OWNER"}]})
    assert comments["count"] == 1 and comments["result"][0]["body"] == "hi" and "author_association" not in comments["result"][0]
    raw = [{"sha": "abc", "commit": {"message": "msg", "author": {"name": "N", "date": "d", "email": "e@x"}, "tree": {"sha": "t"}},
            "author": {"login": "u"}, "html_url": "h", "parents": [{"sha": "p"}]}]
    commits = tools.project(tool("github_list_commits"), raw)
    first = commits["result"][0]
    assert first["commit_message"] == "msg" and first["commit_author_name"] == "N" and "e@x" not in json.dumps(commits) and "parents" not in first
    branches = tools.project(tool("github_list_branches"), {"branches": [{"name": "main", "protected": True, "commit": {"sha": "s", "url": "u"}}]})
    assert branches["result"][0] == {"name": "main", "protected": True, "commit_sha": "s"}
    files = tools.project(tool("github_list_pull_request_files"), {"files": [{"filename": "a.py", "status": "modified", "additions": 1, "deletions": 0, "changes": 1, "patch": "SECRETDIFF"}]})
    assert "SECRETDIFF" not in json.dumps(files) and files["result"][0]["filename"] == "a.py"
    found = tools.project(tool("github_search_issues"), {"items": [{"number": 1, "title": "T", "state": "open", "user": {"login": "u"}, "html_url": "h", "score": 9}], "total_count": 1})
    assert found["result"][0]["number"] == 1 and "score" not in found["result"][0]


def test_a_file_is_decoded_cut_and_refused_when_it_is_not_text():
    import base64
    text = "h\u00e9llo\nworld"
    shown = tools.project(tool("github_get_file"), {"content": base64.b64encode(text.encode()).decode(), "encoding": "base64", "path": "a.md", "size": 12, "sha": "x"})
    assert shown["result"]["text"] == text and shown["result"]["path"] == "a.md" and "sha" not in shown["result"]
    huge = tools.project(tool("github_get_file"), {"content": base64.b64encode(b"x" * 50_000).decode(), "encoding": "base64"})
    assert huge["truncated"] is True and len(json.dumps(huge)) <= tools.MAX_RESULT_CHARS
    binary = base64.b64encode(b"\xff\xfe\x00\x01").decode()
    for bad in ({"content": binary, "encoding": "base64"}, {"content": "!!!", "encoding": "base64"}, {"other": 1}, "text", None):
        with pytest.raises(tools.BadArguments):
            tools.project(tool("github_get_file"), bad)


def test_a_file_is_found_inside_a_wrapper_and_an_unreadable_answer_names_its_fields_only():
    import base64
    content = base64.b64encode(b"hello readme").decode()
    for wrapped in ({"content": {"content": content, "encoding": "base64", "path": "README.md"}},
                    {"data": {"details": {"content": content, "encoding": "base64"}}},
                    {"content": "hello readme", "encoding": "utf-8"},
                    [{"content": content, "encoding": "base64"}]):
        assert tools.project(tool("github_get_file"), wrapped)["result"]["text"] == "hello readme"
    with pytest.raises(tools.BadArguments) as error:
        tools.project(tool("github_get_file"), {"weird": {"x": "SECRETVALUE"}, "other": 1})
    message = str(error.value)
    assert "fields: other, weird" in message and "SECRETVALUE" not in message
    for data, expect in (("text", "it was text"), (None, "it was nothing"), ([], "it was a list")):
        with pytest.raises(tools.BadArguments, match=expect):
            tools.project(tool("github_get_file"), data)
    with pytest.raises(tools.BadArguments) as long:
        tools.project(tool("github_get_file"), {f"field_{i}": 1 for i in range(40)} | {"bad key!": "x"})
    assert str(long.value).count("field_") <= 12 and "bad key" not in str(long.value)


def test_a_folder_is_listed_by_name_path_type_and_size():
    entries = [{"name": "a.py", "path": "src/a.py", "type": "file", "size": 5, "download_url": "https://x", "sha": "s"},
               {"name": "d", "path": "src/d", "type": "dir", "size": 0}]
    shown = tools.project(tool("github_get_file"), entries)
    assert shown["result"]["folder"][0] == {"name": "a.py", "path": "src/a.py", "type": "file", "size": 5}
    assert "download_url" not in json.dumps(shown) and shown["count"] == 2


def test_a_change_is_reported_by_its_link_and_number_only():
    made = tools.project(tool("github_create_issue"), {"number": 12, "title": "T", "state": "open", "html_url": "https://github.com/o/r/issues/12", "body": "BODY", "user": {"login": "me"}})
    assert made["result"] == {"number": 12, "title": "T", "state": "open", "html_url": "https://github.com/o/r/issues/12"}
    posted = tools.project(tool("github_comment_on_issue"), {"id": 5, "html_url": "h", "created_at": "c", "body": "BODY"})
    assert posted["result"] == {"id": 5, "html_url": "h", "created_at": "c"}


# -- policy --------------------------------------------------------------------

P = composio_policy.PREFIX


@pytest.mark.parametrize("name, levels, mode, expected", [
    ("github_list_issues", {"github": "read"}, "ask", ("allowed", "composio_read")),
    ("github_list_issues", {"github": "read"}, "plan", ("allowed", "composio_read")),
    ("github_list_issues", {"github": "write"}, None, ("allowed", "composio_read")),
    ("github_get_file", {"github": "read"}, "accept_edits", ("allowed", "composio_read")),
    ("list_accounts", {"github": "read"}, "ask", ("allowed", "composio_list")),
    ("github_list_issues", {}, "ask", ("denied", "no_connected_apps")),
    ("github_list_issues", None, "ask", ("denied", "no_connected_apps")),
    ("github_list_issues", {"gmail": "read"}, "ask", ("denied", "app_not_allowed")),
    ("github_delete_repository", {"github": "write"}, "ask", ("denied", "unknown_composio_tool")),
    ("GITHUB_DELETE_A_REPOSITORY", {"github": "write"}, "ask", ("denied", "unknown_composio_tool")),
    ("", {"github": "write"}, "ask", ("denied", "unknown_composio_tool")),
    # A change: only at the write level, never decided here (a person decides), never in plan mode.
    ("github_create_issue", {"github": "read"}, "ask", ("denied", "write_not_allowed")),
    ("github_create_issue", {"github": "write"}, "ask", None),
    ("github_create_issue", {"github": "write"}, None, None),
    ("github_create_issue", {"github": "write"}, "accept_edits", None),
    ("github_create_issue", {"github": "write"}, "plan", ("denied", "plan_mode")),
    ("github_comment_on_issue", {"github": "write"}, "ask", None),
    ("github_close_issue", {"github": "write"}, "ask", None),
    ("github_reopen_issue", {"github": "read"}, "ask", ("denied", "write_not_allowed")),
    ("github_close_issue", {"github": "admin"}, "ask", ("denied", "write_not_allowed")),
])
def test_policy(name, levels, mode, expected):
    assert composio_policy.automatic(P + name, mode, levels) == expected


def test_policy_ignores_other_tools():
    assert composio_policy.automatic("Bash", "ask", {"github": "read"}) is None
    assert composio_policy.automatic("mcp__team__delegate", "ask", {"github": "read"}) is None


def test_the_runtime_dispatch_reaches_the_composio_policy():
    from types import SimpleNamespace
    from app.services import tool_policy

    run = SimpleNamespace(ctx=SimpleNamespace(composio_apps={"github": "read"}, team=None))
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

    replies, err = run_shim(tmp_path, "github=read", [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "github_list_issues", "arguments": {"owner": "o", "repo": "r"}}},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "GITHUB_DELETE_A_REPOSITORY", "arguments": {}}},
    ], backend)
    assert replies[0]["result"]["serverInfo"]["name"] == "composio"
    assert {t["name"] for t in replies[1]["result"]["tools"]} == {
        "list_accounts", *(t.name for t in tools.TOOLS if t.app == "github" and t.kind == "read")
    }
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


def test_dispatch_workflow_checks_inputs_and_reports_done():
    t = tool("github_dispatch_workflow")
    good = {"owner": O, "repo": R, "workflow_id": "campaign.yml", "ref": "main", "inputs": {"mode": "sweep"}}
    assert tools.clean_arguments(t, good)[0] == good
    for bad in ({**good, "ref": "a..b"}, {**good, "inputs": {"mode": 1}}, {**good, "inputs": {"a b": "x"}},
                {**good, "inputs": {f"k{i}": "x" for i in range(11)}}, {**good, "inputs": "sweep"}, {**good, "workflow_id": "../x"}):
        with pytest.raises(tools.BadArguments):
            tools.clean_arguments(t, bad)
    assert tools.project(t, None)["result"] == "done"


def test_list_workflow_runs_is_a_bounded_read():
    t = tool("github_list_workflow_runs")
    assert t.kind == "read"
    assert tools.clean_arguments(t, {"owner": O, "repo": R, "status": "completed"})[0]["per_page"] == 10
    with pytest.raises(tools.BadArguments):
        tools.clean_arguments(t, {"owner": O, "repo": R, "status": "weird"})
    shown = tools.project(t, {"total_count": 1, "workflow_runs": [{"id": 9, "status": "completed", "conclusion": "success", "head_commit": {"message": "x"}}]})
    assert shown["count"] == 1 and shown["result"][0]["conclusion"] == "success" and "head_commit" not in shown["result"][0]
