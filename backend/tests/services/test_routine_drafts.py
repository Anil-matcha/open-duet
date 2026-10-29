"""Checked-message source binding and global draft budget."""
import asyncio
import json
import pytest
from app import composio_tools
from app.services import routine_drafts, tool_policy
from app.db.models import Routine, RoutineRun
from tests.services.test_routine_app_writes import write_world, action_rows  # noqa: F401
from tests.services.thread_harness import owner, sessions  # noqa: F401

SOURCE = {"id": "message_1", "threadId": "thread_1", "snippet": "hello", "payload": {"headers": [
    {"name": "From", "value": "Sender <sender@example.com>"}]}}
DRAFT = {"message_id": "message_1", "thread_id": "thread_1", "subject": "Reply", "body": "Answer"}

@pytest.fixture
async def draft_world(write_world, sessions):
    runtime, run, routine, rr, agent, fake, bridge = write_world
    grants = [{"tool": t, "account_id": "ca_mail"} for t in (routine_drafts.TOOL, "gmail_fetch_message", "gmail_get_profile")]
    run.routine_grants = {g["tool"]: g["account_id"] for g in grants}
    run.ctx.draft_only = True
    async with sessions() as db:
        (await db.get(Routine, routine.id)).connected_app_grants = grants
        (await db.get(RoutineRun, rr.id)).connected_app_grants = grants
        await db.commit()
    original = fake.handler
    def handler(request):
        if request.url.path.endswith("/execute"):
            slug = json.loads(request.content)["tool_slug"]
            data = SOURCE if slug == "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID" else {"emailAddress": "owner@example.com"} if slug == "GMAIL_GET_PROFILE" else {"id": "draft_1"}
            fake.answer = {"result_type": "completed", "data": data, "error": None}
        return original(request)
    fake.handler = handler
    yield runtime, run, routine, rr, agent, fake, bridge

async def read_source(bridge):
    result = await bridge.execute("gmail_fetch_message", {"message_id": "message_1"})
    assert not result.get("error"), result
    assert "_checked_source" not in result

async def test_exact_source_required_and_recipient_derived(draft_world):
    *_, fake, bridge = draft_world
    assert (await bridge.execute(routine_drafts.TOOL, DRAFT))["code"] == "not_allowed"
    assert fake.executes == []
    await read_source(bridge)
    result = await bridge.execute(routine_drafts.TOOL, DRAFT)
    assert result["result"]["id"] == "draft_1"
    assert fake.executes[-1]["arguments"]["recipient_email"] == "sender@example.com"
    assert "message_id" not in fake.executes[-1]["arguments"]

async def test_concurrent_different_bodies_share_budget(draft_world, sessions):
    _, _, _, rr, _, fake, bridge = draft_world
    await read_source(bridge)
    answers = await asyncio.gather(bridge.execute(routine_drafts.TOOL, DRAFT), bridge.execute(routine_drafts.TOOL, {**DRAFT, "body": "Other"}))
    assert sum(a.get("code") == "already_attempted" for a in answers) == 1
    assert sum(c["tool_slug"] == "GMAIL_CREATE_EMAIL_DRAFT" for c in fake.executes) == 1
    assert sum(r.request_key == "checked-reply-draft-budget" for r in await action_rows(sessions, rr.id)) == 1

async def test_changed_source_and_override_fail(draft_world, monkeypatch):
    *_, fake, bridge = draft_world
    await read_source(bridge)
    monkeypatch.setitem(SOURCE, "snippet", "changed")
    assert (await bridge.execute(routine_drafts.TOOL, DRAFT))["code"] == "not_allowed"
    assert (await bridge.execute(routine_drafts.TOOL, {**DRAFT, "recipient_email": "evil@example.com"}))["code"] == "bad_arguments"
    assert all(c["tool_slug"] != "GMAIL_CREATE_EMAIL_DRAFT" for c in fake.executes)

@pytest.mark.parametrize("tool", ["Bash", "mcp__team__ask_agent", "mcp__memory__session_read", "computer_click"])
async def test_alternate_routes_denied(draft_world, tool):
    _, run, *_ = draft_world
    assert tool_policy.automatic(tool, "ask", run, {}) == ("denied", "draft_only_run")

@pytest.mark.parametrize("headers", [[], [{"name": "From", "value": "one@example.com, two@example.com"}], [{"name": "From", "value": "one@example.com"}, {"name": "Reply-To", "value": "other@example.com"}]])
def test_bad_headers(headers):
    with pytest.raises(composio_tools.BadArguments):
        routine_drafts.source_identity({**SOURCE, "payload": {"headers": headers}})

def test_hidden_from_interactive_tools():
    assert routine_drafts.TOOL not in {t["name"] for t in composio_tools.mcp_tools({"gmail": "write"})}


async def test_unknown_draft_outcome_keeps_global_budget_after_bridge_restart(draft_world, sessions):
    from types import SimpleNamespace
    from app.services import composio_bridge
    runtime, run, _, rr, _, fake, bridge = draft_world
    await read_source(bridge)
    original = fake.handler
    def uncertain(request):
        if request.url.path.endswith('/execute') and json.loads(request.content)['tool_slug'] == 'GMAIL_CREATE_EMAIL_DRAFT':
            fake.execute_fault = 'down'
        return original(request)
    fake.handler = uncertain
    first = await bridge.execute(routine_drafts.TOOL, DRAFT)
    assert first['code'] == 'outcome_unknown'
    assert sum(c['tool_slug'] == 'GMAIL_CREATE_EMAIL_DRAFT' for c in fake.executes) <= 1
    fake.execute_fault = None
    fake.handler = original
    restarted_run = SimpleNamespace(**{key: value for key, value in vars(run).items() if key != 'checked_reply_sources'})
    restarted = composio_bridge.ComposioBridge(runtime, restarted_run, bridge.apps)
    try:
        await read_source(restarted)
        result = await restarted.execute(routine_drafts.TOOL, {**DRAFT, 'body': 'Different after restart'})
        assert result['code'] == 'already_attempted'
    finally:
        await restarted.close()
    receipts = await action_rows(sessions, rr.id)
    budgets = [r for r in receipts if r.request_key == 'checked-reply-draft-budget']
    assert len(budgets) == 1 and budgets[0].status == 'outcome_unknown'


async def test_checked_source_cannot_be_reused_under_another_account(draft_world, sessions):
    _, run, routine, rr, _, fake, bridge = draft_world
    await read_source(bridge)
    fake.accounts.append({'id': 'ca_other_mail', 'toolkit': {'slug': 'gmail'}, 'alias': 'other-mail',
                          'status': 'ACTIVE', 'user_id': 'u1', 'data': {}})
    changed = [{'tool': name, 'account_id': 'ca_other_mail'} for name in run.routine_grants]
    run.routine_grants = {g['tool']: g['account_id'] for g in changed}
    async with sessions() as db:
        (await db.get(Routine, routine.id)).connected_app_grants = changed
        (await db.get(RoutineRun, rr.id)).connected_app_grants = changed
        await db.commit()
    result = await bridge.execute(routine_drafts.TOOL, DRAFT)
    assert result['code'] == 'not_allowed'
    assert all(c['tool_slug'] != 'GMAIL_CREATE_EMAIL_DRAFT' for c in fake.executes)


@pytest.mark.parametrize('target', ['routine_grant', 'agent_scope', 'owner', 'settled_run', 'routine_owner', 'reassigned_routine'])
async def test_current_access_revoked_during_recheck_blocks_draft(draft_world, sessions, monkeypatch, target):
    from app.db.models import Agent
    from app.services import composio_service
    runtime, _, routine, rr, agent, fake, bridge = draft_world
    await read_source(bridge)
    original = composio_service.run_tool
    async def revoke(db, owner_id, make_client, tool, args, alias, **kwargs):
        result = await original(db, owner_id, make_client, tool, args, alias, **kwargs)
        if tool.name == 'gmail_get_profile':
            async with sessions() as changed:
                if target == 'routine_grant':
                    (await changed.get(Routine, routine.id)).connected_app_grants = []
                elif target == 'agent_scope':
                    (await changed.get(Agent, agent.id)).connector_scopes = {'gmail': 'read'}
                elif target == 'owner':
                    (await changed.get(Agent, agent.id)).owner_id = owner_id + '_other'
                elif target == 'settled_run':
                    (await changed.get(RoutineRun, rr.id)).state = 'interrupted'
                elif target == 'routine_owner':
                    (await changed.get(Routine, routine.id)).owner_id = owner_id + '_other'
                else:
                    (await changed.get(Routine, routine.id)).agent_id = agent.id + 1_000_000
                await changed.commit()
        return result
    monkeypatch.setattr(composio_service, 'run_tool', revoke)
    result = await bridge.execute(routine_drafts.TOOL, DRAFT)
    assert result['code'] == 'not_allowed'
    assert all(c['tool_slug'] != 'GMAIL_CREATE_EMAIL_DRAFT' for c in fake.executes)


async def test_fresh_claude_runtime_is_confined_and_disables_fallback(draft_world, sessions, tmp_path, monkeypatch):
    from app.db.models import Approval, Event, Thread, Turn
    from sqlalchemy import delete
    from app.services import local_claude_runner
    from app.services.thread_runtime import ThreadRuntime
    from app.services.thread_hub import ThreadHub
    from tests.services.thread_harness import ReadyClaude
    fixture_runtime, _, _, rr, agent, _, _ = draft_world
    monkeypatch.setattr(local_claude_runner, 'workspace_dir', lambda: tmp_path)
    rt = ThreadRuntime(hub=ThreadHub(), adapters={'claude': ReadyClaude()}, _session_factory=sessions,
                       owner_id=fixture_runtime.owner_id)
    captured = []
    async def capture(run, adapter, computers):
        captured.append(run)
    monkeypatch.setattr(rt, '_run', capture)
    async def no_recall(*args):
        raise AssertionError('Draft runs must not load history or recent work')
    monkeypatch.setattr(rt, '_recall', no_recall)
    monkeypatch.setattr(rt, '_recent_work', no_recall)
    thread = await rt.create_thread(agent_id=agent.id)
    try:
        assert thread.provider_session_id and thread.session_state == 'new'
        async with sessions() as db:
            from app.db.models import Agent
            (await db.get(Agent, agent.id)).fallback_provider = 'codex'
            await db.commit()
        async with sessions() as db:
            (await db.get(RoutineRun, rr.id)).thread_id = thread.id
            await db.commit()
        turn = await rt.send_turn(thread.id, 'Check then draft', team_origin='routine', routine_run_id=rr.id)
        await rt._runs[turn.id].task
        (run,) = captured
        assert run.ctx.draft_only and run.fallback is None
        assert run.ctx.team is None and run.ctx.team_launch is None and run.ctx.memory_launch is None
        assert not run.log_memory and not run.capturable
    finally:
        await rt.shutdown()
        async with sessions() as db:
            await db.execute(delete(Approval).where(Approval.thread_id == thread.id))
            await db.execute(delete(Event).where(Event.thread_id == thread.id))
            await db.execute(delete(Turn).where(Turn.thread_id == thread.id))
            await db.execute(delete(Thread).where(Thread.id == thread.id))
            await db.commit()


async def test_actual_claude_adapter_mounts_only_connector_and_no_builtin_tools(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from app.services import local_claude_runner
    from app.services.claude_adapter import ClaudeAdapter
    from app.services.provider_adapter import TurnContext
    async def history():
        return []
    launch = SimpleNamespace(command='python', args=['connector'], env={})
    ctx = TurnContext(thread_id=1, turn_id=1, prompt='draft', workspace=tmp_path, model=None,
        provider_session_id='fresh-claude-session', provider_state=None, resume=False, history=history,
        draft_only=True, composio_launch=launch, composio_apps={'gmail': 'write'},
        composio_exact_tools=[routine_drafts.TOOL, 'gmail_fetch_message', 'gmail_get_profile'])
    captured = []
    async def fake_prompt(*args, **kwargs):
        captured.append(kwargs)
        return local_claude_runner.RunOutput(stdout='', stderr='', exit_code=0, timed_out=False, output_truncated=False)
    monkeypatch.setattr(local_claude_runner, 'run_prompt', fake_prompt)
    await ClaudeAdapter().run_turn(ctx, SimpleNamespace(lost=False), SimpleNamespace())
    (options,) = captured
    assert options['tools'] is True and options['mcp_only'] is True
    assert set(options['mcp_servers']) == {'composio'}
    args = local_claude_runner.build_args(tmp_path/'claude', ctx.provider_session_id, tools=True,
        mcp_only=options['mcp_only'], mcp_servers=options['mcp_servers'])
    assert args[args.index('--tools') + 1] == ''
    assert '--strict-mcp-config' in args and '--disable-slash-commands' in args


async def test_cancelled_draft_dispatch_keeps_reserved_budget(draft_world, sessions, monkeypatch):
    from app.services import composio_service
    _, _, _, rr, _, fake, bridge = draft_world
    await read_source(bridge)
    original = composio_service.run_tool
    entered = asyncio.Event()
    blocked = asyncio.Event()
    draft_calls = 0
    async def cancel_at_dispatch(db, owner_id, make_client, tool, args, alias, **kwargs):
        nonlocal draft_calls
        if tool.name == routine_drafts.TOOL:
            draft_calls += 1
            entered.set()
            await blocked.wait()
        return await original(db, owner_id, make_client, tool, args, alias, **kwargs)
    monkeypatch.setattr(composio_service, 'run_tool', cancel_at_dispatch)
    task = asyncio.create_task(bridge.execute(routine_drafts.TOOL, DRAFT))
    await asyncio.wait_for(entered.wait(), timeout=3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await bridge.execute(routine_drafts.TOOL, {**DRAFT, 'subject': 'Retry'})
    assert result['code'] == 'already_attempted' and draft_calls == 1
    assert all(c['tool_slug'] != 'GMAIL_CREATE_EMAIL_DRAFT' for c in fake.executes)
    budgets = [row for row in await action_rows(sessions, rr.id) if row.request_key == 'checked-reply-draft-budget']
    assert len(budgets) == 1 and budgets[0].status == 'reserved'
