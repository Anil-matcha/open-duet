"""The generic connected-app path in a real chat turn: the fake CLI asks, the gate records, a person decides on a card,
the real shim and bridge run the call against a fake Composio that also serves tool schemas.

Covers the contract in .internal/DECISIONS.md (D-021 addendum, 2026-10-28): every unknown action asks every time, a
curated app stays curated, nothing reaches a proxy or code tool, a schema or permission change while a card waits cancels
the call, and a reviewed read needs one approved first use."""
import json

import httpx
import pytest

from app import composio_generic as generic
from app.services import agent_store, composio_actions, composio_bridge, composio_service
from app.services.composio_client import ComposioClient
from tests.services.test_composio_bridge import KEY, FakeComposio
from tests.services.test_composio_chat import agent_with, cli, rt, tool_step  # noqa: F401
from tests.services.thread_harness import TERMINAL, events_of, finished, owner, pending_approval, sessions, types_of, wait_until  # noqa: F401

SCHEMA = {"type": "object", "required": ["title"], "properties": {"title": {"type": "string", "maxLength": 100}, "body": {"type": "string"}}}
VERSION = "20261001_00"
LEAK = "SECRET_PAGE_TOKEN"


def tool_item(slug, toolkit, schema=SCHEMA, version=VERSION):
    return {"slug": slug, "name": slug.title(), "description": "Does a thing.", "toolkit": {"slug": toolkit}, "input_parameters": schema,
            "version": version, "tags": ["readOnlyHint"], "is_deprecated": False}


class GenericComposio(FakeComposio):
    """The fake Composio of the bridge tests, with a Notion account and the tool catalog."""

    def __init__(self):
        super().__init__()
        self.accounts = [{"id": "ca_n", "toolkit": {"slug": "notion"}, "alias": "work", "status": "ACTIVE", "user_id": "u1"}]
        self.answer = {"result_type": "completed", "error": None,
                       "data": {"id": "p1", "url": "https://notion.so/p1", "access_token": LEAK, "body": "x" * 5000}}
        self.tools = {
            "NOTION_CREATE_PAGE": tool_item("NOTION_CREATE_PAGE", "notion"),
            "NOTION_SEARCH_PAGES": tool_item("NOTION_SEARCH_PAGES", "notion"),
            "NOTION_ODD": tool_item("NOTION_ODD", "notion", {"type": "object", "properties": {"a": {"$ref": "#/x"}}}),
            "NOTION_FAKE": tool_item("NOTION_FAKE", "slack"),   # named like a Notion action, but Composio says it is Slack's
        }
        self.lookups: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        route = f"{request.method} {request.url.path.removeprefix('/api/v3.1')}"
        if route == "GET /tools":
            wanted = request.url.params.get("toolkit_slug")
            self.lookups.append(route)
            items = [t for t in self.tools.values() if t["toolkit"]["slug"] == wanted]
            return httpx.Response(200, json={"items": items, "next_cursor": None})
        if route.startswith("GET /tools/"):
            found = self.tools.get(route.rsplit("/", 1)[1])
            self.lookups.append(route)
            return httpx.Response(200, json=found) if found else httpx.Response(404, json={"error": {"message": "no such tool"}})
        return super().handler(request)


@pytest.fixture
def composio(monkeypatch):
    fake = GenericComposio()
    monkeypatch.setattr(composio_bridge, "make_client", lambda key: ComposioClient(key, transport=httpx.MockTransport(fake.handler)))
    return fake


def revision(composio, slug="NOTION_CREATE_PAGE"):
    item = composio.tools[slug]
    return generic.revision_of(slug, item["version"], item["input_parameters"])


def run_args(composio, slug="NOTION_CREATE_PAGE", arguments=None, **more):
    return {"app": "notion", "action": slug, "revision": revision(composio, slug), "arguments": {"title": "Plan", "body": "Hello"} if arguments is None else arguments, **more}


def search_step(query="page"):
    return tool_step("app_search_actions", {"app": "notion", "query": query})


def run_step(args):
    return tool_step("app_run_action", args)


def results(cli):  # noqa: F811
    return [(json.loads(r["content"]) if r["content"].startswith("{") else r["content"], r["is_error"]) for r in cli.log("mcp_result")]


async def decided(sessions, thread_id):  # noqa: F811
    return [(e.data["status"], e.data.get("by")) for e in await events_of(sessions, thread_id) if e.type == "approval.resolved"]


async def new_thread(rt, agent, cli, *steps):  # noqa: F811
    """The fake CLI plays one scripted step per turn, so each step is its own turn (see `turn`)."""
    cli.script(*steps)
    return await rt.create_thread(agent_id=agent.id)


async def turns_done(sessions, thread):  # noqa: F811
    return len([t for t in await types_of(sessions, thread.id) if t in TERMINAL])


async def turn(rt, sessions, thread, answer=None, *, before=None):  # noqa: F811
    """One turn: the next scripted step. With `answer`, wait for its card, run `before`, then answer it."""
    count = await turns_done(sessions, thread) + 1
    await rt.send_turn(thread.id, "go")
    if answer is not None:
        approval = await pending_approval(sessions, thread.id)
        if before is not None:
            await before()
        assert await rt.answer_approval(approval.id, answer)
    await finished(sessions, thread.id, count)


# -- the normal path ------------------------------------------------------------------------------------------------------

async def test_search_is_automatic_and_run_shows_a_card_with_the_exact_arguments(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})
    args = run_args(composio)
    thread = await new_thread(rt, agent, cli, search_step(), run_step(args))
    await turn(rt, sessions, thread)                                   # the search: no card

    async def look():
        approval = await pending_approval(sessions, thread.id)
        assert approval.tool == "mcp__composio__app_run_action" and approval.input == args   # nothing is added or defaulted
        assert composio.executes == []                                                          # nothing ran before the Allow

    await turn(rt, sessions, thread, "allow", before=look)

    searched, ran = results(cli)
    assert not searched[1] and searched[0]["actions"][0]["revision"] == revision(composio)
    assert {a["action"] for a in searched[0]["actions"]} >= {"NOTION_CREATE_PAGE", "NOTION_SEARCH_PAGES"}
    assert "NOTION_FAKE" not in json.dumps(searched)        # Composio's listing for another app's tool is dropped
    assert not ran[1] and ran[0]["result"]["id"] == "p1" and "Data from notion" in ran[0]["notice"] and ran[0]["truncated"] is True
    assert LEAK not in json.dumps(ran) and KEY not in json.dumps(ran)
    assert [(e["tool_slug"], e["arguments"], e["account"]) for e in composio.executes] == [("NOTION_CREATE_PAGE", args["arguments"], "ca_n")]
    assert await decided(sessions, thread.id) == [("allowed", "composio_search"), ("allowed", None)]  # the second was a person


async def test_a_denied_card_does_nothing(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})
    thread = await new_thread(rt, agent, cli, run_step(run_args(composio)))
    await turn(rt, sessions, thread, "deny")
    assert composio.executes == [] and cli.log("mcp_result") == []


async def test_the_same_action_asks_again_every_time(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})
    thread = await new_thread(rt, agent, cli, run_step(run_args(composio)), run_step(run_args(composio)))
    await turn(rt, sessions, thread, "allow")
    await turn(rt, sessions, thread, "allow")
    assert len(composio.executes) == 2 and await decided(sessions, thread.id) == [("allowed", None), ("allowed", None)]


# -- permissions at the gate ---------------------------------------------------------------------------------------------------

async def test_a_read_level_agent_can_search_but_never_run(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "read"})
    thread = await new_thread(rt, agent, cli, search_step(), run_step(run_args(composio)))
    await turn(rt, sessions, thread)
    await turn(rt, sessions, thread)
    args = cli.launches[-1]["args"]
    server = json.loads(args[args.index("--mcp-config") + 1])["mcpServers"]["composio"]
    assert server["args"][-2:] == ["--apps", "notion=read"]
    assert len(results(cli)) == 1 and composio.executes == []
    assert await decided(sessions, thread.id) == [("allowed", "composio_search"), ("denied", "write_not_allowed")]


@pytest.mark.parametrize("app,action,why", [
    ("github", "GITHUB_DELETE_A_REPOSITORY", "generic_not_available"),     # a curated app keeps only its curated tools
    ("notion", "COMPOSIO_REMOTE_BASH_TOOL", "generic_not_available"),      # no code, shell or proxy
    ("notion", "NOTION_PROXY_EXECUTE", "generic_not_available"),
    ("notion", "COMPOSIO_MULTI_EXECUTE_TOOL", "generic_not_available"),
    ("notion", "SLACK_POST_MESSAGE", "generic_not_available"),             # another app's action
    ("slack", "SLACK_POST_MESSAGE", "app_not_allowed"),                    # an app the agent was not given
])
async def test_forbidden_actions_are_denied_without_a_card(rt, sessions, cli, composio, app, action, why):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write", "github": "write"})
    thread = await new_thread(rt, agent, cli, run_step({"app": app, "action": action, "revision": "0" * 16, "arguments": {}}))
    await turn(rt, sessions, thread)
    assert await decided(sessions, thread.id) == [("denied", why)]
    assert composio.executes == [] and cli.log("mcp_result") == []


async def test_plan_mode_denies_an_unknown_action(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})
    async with sessions() as db:
        await agent_store.update_agent(db, agent.id, approval_mode="plan")
    thread = await new_thread(rt, agent, cli, run_step(run_args(composio)))
    await turn(rt, sessions, thread)
    assert await decided(sessions, thread.id) == [("denied", "plan_mode")] and composio.executes == []


# -- what is checked at dispatch, after the card -----------------------------------------------------------------------------------

async def run_and_allow(rt, sessions, cli, composio, args, *, before_allow=None, scopes=None):  # noqa: F811
    agent = await agent_with(rt, sessions, scopes or {"notion": "write"})
    thread = await new_thread(rt, agent, cli, run_step(args))

    async def before():
        if before_allow is not None:
            await before_allow(agent)

    await turn(rt, sessions, thread, "allow", before=before)
    await wait_until(lambda: cli.log("mcp_result"))      # the CLI writes its result just before it exits
    return results(cli)


async def test_a_schema_that_changes_while_the_card_waits_cancels_the_call(rt, sessions, cli, composio):  # noqa: F811
    async def change(agent):
        composio.tools["NOTION_CREATE_PAGE"]["input_parameters"] = {**SCHEMA, "required": ["title", "body"]}

    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio), before_allow=change)
    assert out[0][1] and out[0][0]["code"] == "schema_changed" and composio.executes == []


async def test_a_new_action_version_cancels_the_call_too(rt, sessions, cli, composio):  # noqa: F811
    async def bump(agent):
        composio.tools["NOTION_CREATE_PAGE"]["version"] = "20261101_00"

    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio), before_allow=bump)
    assert out[0][0]["code"] == "schema_changed" and composio.executes == []


async def test_an_invented_revision_never_runs(rt, sessions, cli, composio):  # noqa: F811
    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio, revision=None) | {"revision": "f" * 16})
    assert out[0][0]["code"] == "schema_changed" and composio.executes == []


async def test_taking_the_app_away_while_the_card_waits_cancels_the_call(rt, sessions, cli, composio, owner):  # noqa: F811
    async def revoke(agent):
        async with sessions() as db:
            await agent_store.update_agent(db, agent.id, connector_scopes=None)

    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio), before_allow=revoke)
    assert out[0][0]["code"] == "not_allowed" and composio.executes == []


async def test_lowering_the_level_while_the_card_waits_cancels_the_call(rt, sessions, cli, composio):  # noqa: F811
    async def lower(agent):
        async with sessions() as db:
            await agent_store.update_agent(db, agent.id, connector_scopes={"notion": "read"})

    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio), before_allow=lower)
    assert out[0][0]["code"] == "not_allowed" and composio.executes == []


async def test_disconnecting_the_account_while_the_card_waits_cancels_the_call(rt, sessions, cli, composio):  # noqa: F811
    async def disconnect(agent):
        composio.accounts.clear()

    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio), before_allow=disconnect)
    assert out[0][0]["code"] == "not_connected" and composio.executes == []


async def test_removing_the_key_while_the_card_waits_cancels_the_call(rt, sessions, cli, composio, owner):  # noqa: F811
    async def remove(agent):
        async with sessions() as db:
            await composio_service.remove_key(db, owner)

    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio), before_allow=remove)
    assert out[0][0]["code"] == "not_configured" and composio.executes == []


async def test_an_action_composio_says_belongs_to_another_app_is_refused(rt, sessions, cli, composio):  # noqa: F811
    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio, "NOTION_FAKE"))
    assert out[0][0]["code"] == "wrong_app" and composio.executes == []


async def test_an_action_composio_does_not_know_is_not_run(rt, sessions, cli, composio):  # noqa: F811
    out = await run_and_allow(rt, sessions, cli, composio, {"app": "notion", "action": "NOTION_MADE_UP", "revision": "a" * 16, "arguments": {}})
    assert out[0][1] and composio.executes == []


async def test_a_schema_that_cannot_be_checked_is_not_run(rt, sessions, cli, composio):  # noqa: F811
    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio, "NOTION_ODD", {}))
    assert out[0][0]["code"] == "unsupported_schema" and "$ref" in out[0][0]["error"] and composio.executes == []


@pytest.mark.parametrize("arguments,hint", [
    ({"title": "t", "stray": 1}, "stray"),
    ({"body": "no title"}, "title"),
    ({"title": 5}, "title"),
    ({"title": "x" * 101}, "title"),
    ({"title": "t", "api_key": "k"}, "Credentials"),
    ({"title": "t", "body": "y" * 9000}, "too large"),
])
async def test_arguments_that_do_not_fit_the_schema_are_never_sent(rt, sessions, cli, composio, arguments, hint):  # noqa: F811
    schema = {**SCHEMA, "properties": {**SCHEMA["properties"], "api_key": {"type": "string"}}}
    composio.tools["NOTION_CREATE_PAGE"]["input_parameters"] = schema
    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio, arguments=arguments))
    assert out[0][1] and out[0][0]["code"] == "bad_arguments" and hint in out[0][0]["error"] and composio.executes == []


async def test_a_second_account_must_be_named_and_the_name_is_part_of_the_card(rt, sessions, cli, composio):  # noqa: F811
    composio.accounts.append({"id": "ca_h", "toolkit": {"slug": "notion"}, "alias": "home", "status": "ACTIVE", "user_id": "u1"})
    agent = await agent_with(rt, sessions, {"notion": "write"})
    thread = await new_thread(rt, agent, cli, run_step(run_args(composio)), run_step(run_args(composio, account="home")))

    async def unnamed():
        assert "account" not in (await pending_approval(sessions, thread.id)).input

    async def named():
        assert (await pending_approval(sessions, thread.id)).input["account"] == "home"

    await turn(rt, sessions, thread, "allow", before=unnamed)
    await turn(rt, sessions, thread, "allow", before=named)
    unnamed, named = results(cli)
    assert unnamed[0]["code"] == "account_required" and "work" in unnamed[0]["error"] and "home" in unnamed[0]["error"]
    assert not named[1] and [e["account"] for e in composio.executes] == ["ca_h"]


async def test_a_call_is_sent_once_and_an_answer_that_never_came_is_reported_unknown(rt, sessions, cli, composio):  # noqa: F811
    composio.execute_fault = "down"
    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio))
    assert out[0][0]["code"] == "outcome_unknown" and composio.execute_attempts == 1


@pytest.mark.parametrize("answer,code", [
    ({"result_type": "failed", "data": {}, "error": "Not Found"}, "app_error"),
    ({"result_type": "blocked", "reason": "hook", "message": "no"}, "not_run"),
    ({"result_type": "input_required", "input_requests": {"x": {}}}, "not_run"),
])
async def test_anything_but_a_completed_answer_is_a_short_error(rt, sessions, cli, composio, answer, code):  # noqa: F811
    composio.answer = answer
    out = await run_and_allow(rt, sessions, cli, composio, run_args(composio))
    assert out[0][0]["code"] == code and KEY not in json.dumps(out)


# -- search ----------------------------------------------------------------------------------------------------------------------------

async def test_search_needs_a_connected_account(rt, sessions, cli, composio):  # noqa: F811
    composio.accounts.clear()
    agent = await agent_with(rt, sessions, {"notion": "read"})
    thread = await new_thread(rt, agent, cli, search_step())
    await turn(rt, sessions, thread)
    (found,) = results(cli)
    assert found[1] and found[0]["code"] == "not_connected"


async def test_search_never_widens_a_curated_app(rt, sessions, cli, composio):  # noqa: F811
    agent = await agent_with(rt, sessions, {"github": "write", "notion": "read"})
    thread = await new_thread(rt, agent, cli, tool_step("app_search_actions", {"app": "github", "query": "delete"}))
    await turn(rt, sessions, thread)
    assert cli.log("mcp_result") == [] and await decided(sessions, thread.id) == [("denied", "generic_not_available")]
    assert composio.lookups == []


# -- reviewed reads (the shim is a separate process that cannot see a test's REVIEWED_READS, so these run at the change level;
# the Read level's reviewed reads are covered by test_composio_generic.py) ---------------------------------------------------------------------------------------------------------------------------

@pytest.fixture
def reviewed(monkeypatch, composio):
    item = composio.tools["NOTION_SEARCH_PAGES"]
    monkeypatch.setitem(generic.REVIEWED_READS, "NOTION_SEARCH_PAGES", generic.action_digest(item["version"], item["input_parameters"]))


def read_args(composio):
    return run_args(composio, "NOTION_SEARCH_PAGES", {"title": "plan"})


async def test_a_reviewed_read_asks_once_then_runs_without_a_card(rt, sessions, cli, composio, reviewed):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})
    thread = await new_thread(rt, agent, cli, run_step(read_args(composio)), run_step(read_args(composio)))
    await turn(rt, sessions, thread, "allow")        # the first use: a card
    await turn(rt, sessions, thread)                 # the second needed none
    assert await decided(sessions, thread.id) == [("allowed", None), ("allowed", "composio_reviewed_read")]
    assert len(composio.executes) == 2 and all(not r[1] for r in results(cli))


async def test_a_failed_first_use_does_not_count(rt, sessions, cli, composio, reviewed):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})
    composio.answer = {"result_type": "failed", "data": {}, "error": "no"}
    thread = await new_thread(rt, agent, cli, run_step(read_args(composio)), run_step(read_args(composio)))
    await turn(rt, sessions, thread, "allow")
    await turn(rt, sessions, thread, "allow")        # both asked
    assert await decided(sessions, thread.id) == [("allowed", None), ("allowed", None)]


async def test_a_denied_first_use_does_not_count_either(rt, sessions, cli, composio, reviewed):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})
    thread = await new_thread(rt, agent, cli, run_step(read_args(composio)), run_step(read_args(composio)))
    await turn(rt, sessions, thread, "deny")

    async def asked_again():
        assert await pending_approval(sessions, thread.id)

    await turn(rt, sessions, thread, "deny", before=asked_again)
    assert composio.executes == []


async def test_a_first_use_is_dropped_when_agent_access_changes_the_account_goes_or_the_key_is_replaced(rt, sessions, cli, composio, reviewed, owner):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})

    async def first_use_exists():
        async with sessions() as db:
            return await composio_actions.first_use_hit(db, owner, agent.id, read_args(composio))

    async def run_once():
        thread = await new_thread(rt, agent, cli, run_step(read_args(composio)))
        cli.plan.parent.joinpath("count").unlink(missing_ok=True)     # play the step again from the start
        await turn(rt, sessions, thread, "allow")

    await run_once()
    assert await first_use_exists() is True
    async with sessions() as db:
        await composio_actions.forget(db, owner, agent_id=agent.id)
    assert await first_use_exists() is False                          # agent access changed

    await run_once()
    assert await first_use_exists() is True
    async with sessions() as db:
        await composio_actions.forget(db, owner, account_id="ca_n")
    assert await first_use_exists() is False                          # the account was disconnected

    await run_once()
    assert await first_use_exists() is True
    async with sessions() as db:
        await composio_service.set_key(db, owner, "ak_ANOTHERKEY_abcdef123456", lambda key: ComposioClient(key, transport=httpx.MockTransport(composio.handler)))
    composio.accepted_keys = None
    assert await first_use_exists() is False                          # the key was replaced


async def test_a_call_decided_without_a_card_is_refused_when_its_first_use_is_gone(rt, sessions, cli, composio, reviewed, owner):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})
    request = generic.parse_run(read_args(composio))
    async with sessions() as db:
        answer = await composio_actions.run(db, owner, composio_bridge.make_client, agent_id=agent.id, auto_called=True, request=request)
    assert answer["code"] == "first_use_required" and composio.executes == []


async def test_a_reviewed_read_that_changed_is_no_longer_reviewed(rt, sessions, cli, composio, reviewed):  # noqa: F811
    agent = await agent_with(rt, sessions, {"notion": "write"})
    args = read_args(composio)
    composio.tools["NOTION_SEARCH_PAGES"]["version"] = "20270101_00"      # not what was reviewed
    thread = await new_thread(rt, agent, cli, run_step(args))
    await turn(rt, sessions, thread, "allow")
    assert results(cli)[0][0]["code"] == "schema_changed" and composio.executes == []
