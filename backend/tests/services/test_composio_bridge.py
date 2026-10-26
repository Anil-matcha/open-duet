"""Connected-app calls end to end: a real runtime, the real approval gate and bridge,
the real shim mailbox format, and a fake Composio behind httpx.MockTransport."""
import asyncio
import json
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import delete, select

from app.db.models import Agent
from app.db.models.user_credential import UserCredential
from app.services import agent_store, composio_bridge, composio_service
from app.services.composio_client import ComposioClient
from app.services.provider_adapter import ALLOW, Capabilities, ProviderStatus, TurnOutcome
from app.services.thread_hub import ThreadHub
from app.services.thread_runtime import ThreadRuntime
from tests.services.thread_harness import cleanup, owner, sessions, wait_until  # noqa: F401

KEY = "ak_BRIDGEKEY_abcdef123456"
TOKEN = "gho_SECRET_OAUTH_TOKEN"
PREFIX = composio_bridge.PREFIX
REPOS = {"repositories": [{"full_name": "o/r", "private": True, "description": "d", "permissions": {"admin": True}, "secret": TOKEN}]}


class FakeComposio:
    def __init__(self):
        self.executes: list[dict] = []
        self.keys: list[str] = []
        self.accounts = [{"id": "ca_1", "toolkit": {"slug": "github"}, "alias": "work", "status": "ACTIVE", "user_id": "u1",
                          "data": {"access_token": TOKEN}}]
        self.answer: dict = {"result_type": "completed", "data": REPOS, "error": None}
        self.session_ok = True
        self.down = False

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("down " + KEY)
        self.keys.append(request.headers.get("x-api-key"))
        route = f"{request.method} {request.url.path.removeprefix('/api/v3.1')}"
        if route == "GET /connected_accounts":
            return httpx.Response(200, json={"items": self.accounts})
        if route == "POST /tool_router/session":
            return httpx.Response(201, json={"session_id": "sess_new"})
        if route.endswith("/execute"):
            if not self.session_ok:
                return httpx.Response(404, json={"error": {"message": "no session"}})
            self.executes.append({"route": route, **json.loads(request.content)})
            return httpx.Response(200, json=self.answer)
        return httpx.Response(404, json={"error": {"message": route}})


class Engine:
    key = "claude"
    capabilities = Capabilities(tools=True, approvals=True, mcp=True, connected_apps=True)
    custom_models = True

    def __init__(self):
        self.handler = None
        self.contexts = []

    def new_session_id(self):
        return None

    async def status(self):
        return ProviderStatus(ready=True)

    async def run_turn(self, ctx, sink, gate):
        self.contexts.append(ctx)
        return await self.handler(ctx, sink, gate)


class PlainEngine(Engine):
    capabilities = Capabilities(tools=True, approvals=True, mcp=True)


@pytest.fixture
async def fake(monkeypatch):
    fake = FakeComposio()
    monkeypatch.setattr(composio_bridge, "make_client", lambda key: ComposioClient(key, transport=httpx.MockTransport(fake.handler)))
    return fake


@pytest.fixture
async def world(sessions, owner, fake, tmp_path, monkeypatch):
    from app.services import local_claude_runner

    monkeypatch.setattr(local_claude_runner, "workspace_dir", lambda: tmp_path)
    engine = Engine()
    runtime = ThreadRuntime(hub=ThreadHub(), adapters={"claude": engine}, owner_id=owner, _session_factory=sessions)
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=owner, name="Reader")
        await agent_store.update_agent(db, agent.id, connector_scopes={"github": "read"})
        await composio_service._save(db, owner, {"api_key": KEY, "user_id": "u1", "session_id": "sess_1"})
    yield runtime, engine, agent
    await runtime.shutdown()
    async with sessions() as db:
        await db.execute(delete(UserCredential).where(UserCredential.user_id == owner))
        await db.execute(delete(Agent).where(Agent.owner_id == owner))
        await db.commit()


def mailbox_of(ctx):
    args = ctx.composio_launch.args
    return __import__("pathlib").Path(args[args.index("--mailbox") + 1])


async def ask(ctx, gate, name, approved_args, sent_args=None, approve=True):
    """What the engine and the shim do for one call: the permission question, then
    the shim's request file. Returns the bridge's answer."""
    if approve:
        handle = await gate.open(request_id=uuid4().hex, tool=PREFIX + name, input=approved_args, summary=None, kind=None)
        decision = await gate.decide(handle)
        if decision.kind != ALLOW:
            return {"decision": decision.kind}
    box = mailbox_of(ctx)
    token = uuid4().hex
    (box / f"req-{token}.tmp").write_text(json.dumps({"name": name, "arguments": approved_args if sent_args is None else sent_args}))
    (box / f"req-{token}.tmp").rename(box / f"req-{token}.json")
    reply = box / f"resp-{token}.json"
    for _ in range(300):
        if reply.exists():
            return json.loads(reply.read_text(encoding="utf-8"))
        await asyncio.sleep(0.05)
    raise AssertionError("no answer from the bridge")


async def one_turn(world, handler):
    runtime, engine, agent = world
    engine.handler = handler
    thread = await runtime.create_thread(agent_id=agent.id)
    turn = await runtime.send_turn(thread.id, "go")
    await wait_until(lambda: turn.id not in runtime._runs)
    return turn


async def test_an_approved_read_runs_as_the_account_and_comes_back_trimmed(world, fake):
    seen = {}

    async def handler(ctx, sink, gate):
        seen["apps"] = ctx.composio_apps
        seen["answer"] = await ask(ctx, gate, "github_list_my_repositories", {"per_page": 2})
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen["apps"] == frozenset({"github"})
    assert seen["answer"]["count"] == 1 and seen["answer"]["result"][0]["full_name"] == "o/r"
    assert fake.executes == [{"route": "POST /tool_router/session/sess_1/execute", "tool_slug": "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
                              "arguments": {"per_page": 2}, "account": "ca_1"}]
    assert set(fake.keys) == {KEY}
    text = json.dumps(seen["answer"])
    assert TOKEN not in text and KEY not in text and "permissions" not in text


async def test_a_call_with_no_approval_never_reaches_composio(world, fake):
    seen = {}

    async def handler(ctx, sink, gate):
        seen["answer"] = await ask(ctx, gate, "github_list_my_repositories", {"per_page": 2}, approve=False)
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen["answer"]["code"] == "not_approved" and fake.executes == []


async def test_an_approval_covers_exactly_those_arguments_and_once(world, fake):
    seen = {}

    async def handler(ctx, sink, gate):
        # One approval for per_page 2. A request with other arguments does not use it...
        seen["changed"] = await ask(ctx, gate, "github_list_my_repositories", {"per_page": 2}, {"per_page": 3})
        # ...the exact request does, once...
        seen["first"] = await ask(ctx, gate, "github_list_my_repositories", {"per_page": 2}, approve=False)
        # ...and then it is spent.
        seen["again"] = await ask(ctx, gate, "github_list_my_repositories", {"per_page": 2}, approve=False)
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen["changed"]["code"] == "not_approved"
    assert seen["first"]["count"] == 1
    assert seen["again"]["code"] == "not_approved"
    assert len(fake.executes) == 1 and fake.executes[0]["arguments"] == {"per_page": 2}


async def test_an_app_the_agent_was_not_given_is_denied_at_the_gate(world, fake, sessions):
    runtime, engine, agent = world
    async with sessions() as db:
        await agent_store.update_agent(db, agent.id, connector_scopes={"gmail": "read"})
    seen = {}

    async def handler(ctx, sink, gate):
        seen["apps"] = ctx.composio_apps
        seen["launch"] = ctx.composio_launch
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen == {"apps": None, "launch": None}  # "gmail" has no tools yet: no server at all


async def test_removing_the_app_mid_turn_stops_a_call_that_was_already_approved(world, fake, sessions):
    runtime, engine, agent = world
    seen = {}

    async def handler(ctx, sink, gate):
        handle = await gate.open(request_id=uuid4().hex, tool=PREFIX + "github_get_authenticated_user", input={}, summary=None, kind=None)
        assert (await gate.decide(handle)).kind == ALLOW
        async with sessions() as db:
            await agent_store.update_agent(db, agent.id, connector_scopes=None)
        seen["answer"] = await ask(ctx, gate, "github_get_authenticated_user", {}, approve=False)
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen["answer"]["code"] == "not_allowed" and fake.executes == []


async def test_two_accounts_need_a_name_and_the_name_is_part_of_the_approval(world, fake):
    fake.accounts.append({"id": "ca_2", "toolkit": {"slug": "github"}, "alias": "home", "status": "ACTIVE", "user_id": "u1"})
    seen = {}

    async def handler(ctx, sink, gate):
        seen["none"] = await ask(ctx, gate, "github_get_authenticated_user", {})
        seen["home"] = await ask(ctx, gate, "github_get_authenticated_user", {"account": "home"})
        seen["wrong"] = await ask(ctx, gate, "github_get_authenticated_user", {"account": "nope"})
        return TurnOutcome("succeeded", result="ok")

    fake.answer = {"result_type": "completed", "data": {"login": "o", "name": "N"}, "error": None}
    await one_turn(world, handler)
    assert seen["none"]["code"] == "account_required" and "home" in seen["none"]["error"] and "work" in seen["none"]["error"]
    assert seen["home"]["result"]["login"] == "o"
    assert seen["wrong"]["code"] == "unknown_account"
    assert [e["account"] for e in fake.executes] == ["ca_2"]


async def test_the_agent_can_see_account_names_but_not_ids_or_tokens(world, fake):
    seen = {}

    async def handler(ctx, sink, gate):
        seen["answer"] = await ask(ctx, gate, "list_accounts", {})
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen["answer"] == {"apps": {"github": ["work"]}}


@pytest.mark.parametrize("answer, code", [
    ({"result_type": "failed", "data": {}, "error": "Not Found"}, "app_error"),
    ({"result_type": "blocked", "reason": "hook", "message": "no"}, "not_run"),
    ({"result_type": "input_required"}, "not_run"),
    ({"result_type": "completed", "data": {"unexpected": 1}, "error": None}, "unreadable_answer"),
    ({"result_type": "completed", "data": "text", "error": None}, "unreadable_answer"),
])
async def test_anything_but_a_readable_completed_answer_is_a_short_error(world, fake, answer, code):
    fake.answer = answer
    seen = {}

    async def handler(ctx, sink, gate):
        seen["answer"] = await ask(ctx, gate, "github_list_my_repositories", {})
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen["answer"]["code"] == code and "error" in seen["answer"]
    assert TOKEN not in json.dumps(seen["answer"]) and "unexpected" not in json.dumps(seen["answer"])


async def test_composio_trouble_is_reported_without_details(world, fake):
    seen = {}

    async def handler(ctx, sink, gate):
        fake.down = True
        seen["down"] = await ask(ctx, gate, "github_get_authenticated_user", {})
        fake.down = False
        fake.accounts.clear()
        seen["none"] = await ask(ctx, gate, "github_get_authenticated_user", {})
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen["down"]["code"] == "composio_unavailable" and KEY not in json.dumps(seen["down"])
    assert seen["none"]["code"] == "not_connected"
    assert fake.executes == []


async def test_a_forgotten_session_is_replaced_once_and_saved(world, fake, sessions, owner):
    seen = {}

    async def handler(ctx, sink, gate):
        fake.session_ok = False
        original = fake.handler

        def recovering(request):
            if request.url.path.endswith("/sess_new/execute"):
                fake.session_ok = True
            return original(request)

        fake.handler = recovering
        seen["answer"] = await ask(ctx, gate, "github_list_my_repositories", {})
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen["answer"]["count"] == 1
    async with sessions() as db:
        assert (await composio_service.load(db, owner))["session_id"] == "sess_new"


async def test_no_key_means_no_server_and_a_removed_key_stops_calls(world, fake, sessions, owner):
    seen = {}

    async def handler(ctx, sink, gate):
        async with sessions() as db:
            await composio_service.remove_key(db, owner)
        seen["answer"] = await ask(ctx, gate, "github_get_authenticated_user", {})
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert seen["answer"]["code"] == "not_configured" and fake.executes == []
    seen.clear()

    async def second(ctx, sink, gate):
        seen["launch"] = ctx.composio_launch
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, second)
    assert seen["launch"] is None


@pytest.mark.parametrize("origin", ["routine", "outside", "restricted", "harness"])
async def test_a_turn_nobody_is_watching_gets_no_connected_apps(world, fake, origin):
    runtime, engine, agent = world
    seen = {}

    async def handler(ctx, sink, gate):
        seen["launch"] = ctx.composio_launch
        return TurnOutcome("succeeded", result="ok")

    engine.handler = handler
    thread = await runtime.create_thread(agent_id=agent.id)
    turn = await runtime.send_turn(thread.id, "go", team_origin=origin, internal=True)
    await wait_until(lambda: turn.id not in runtime._runs)
    assert seen["launch"] is None


async def test_an_engine_that_cannot_mount_them_gets_none(sessions, owner, fake, tmp_path, monkeypatch):
    from app.services import local_claude_runner

    monkeypatch.setattr(local_claude_runner, "workspace_dir", lambda: tmp_path)
    engine = PlainEngine()
    runtime = ThreadRuntime(hub=ThreadHub(), adapters={"claude": engine}, owner_id=owner, _session_factory=sessions)
    async with sessions() as db:
        agent = await agent_store.create_agent(db, owner_id=owner, name="Plain")
        await agent_store.update_agent(db, agent.id, connector_scopes={"github": "read"})
        await composio_service._save(db, owner, {"api_key": KEY, "user_id": "u1", "session_id": None})
    seen = {}

    async def handler(ctx, sink, gate):
        seen["launch"] = ctx.composio_launch
        return TurnOutcome("succeeded", result="ok")

    engine.handler = handler
    try:
        thread = await runtime.create_thread(agent_id=agent.id)
        turn = await runtime.send_turn(thread.id, "go")
        await wait_until(lambda: turn.id not in runtime._runs)
        assert seen["launch"] is None
    finally:
        await runtime.shutdown()
        async with sessions() as db:
            await db.execute(delete(UserCredential).where(UserCredential.user_id == owner))
            await db.execute(delete(Agent).where(Agent.owner_id == owner))
            await db.commit()


async def test_the_mailbox_folder_is_removed_when_the_turn_ends(world, fake):
    seen = {}

    async def handler(ctx, sink, gate):
        seen["box"] = mailbox_of(ctx)
        assert seen["box"].is_dir()
        return TurnOutcome("succeeded", result="ok")

    await one_turn(world, handler)
    assert not seen["box"].exists()
