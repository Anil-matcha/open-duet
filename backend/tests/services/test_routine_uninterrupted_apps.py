import httpx
import pytest
from sqlalchemy import delete, select

from app.db.models import Agent
from app.db.models.routine import Routine, RoutineRun, RoutineAppAction
from app.services import agent_store, composio_bridge, composio_service, routine_service, routine_uninterrupted
from app.services.composio_client import ComposioClient
from app.services.provider_adapter import TurnOutcome
from tests.services.test_composio_bridge import (  # noqa: F401
    world, fake, ask, owner, sessions, cleanup, wait_until,
)
from tests.services.test_composio_generic_chat import GenericComposio, run_args


@pytest.fixture(autouse=True)
async def full_routine_cleanup(sessions, owner):
    yield
    async with sessions() as db:
        ids = select(Routine.id).where(Routine.owner_id == owner)
        run_ids = select(RoutineRun.id).where(RoutineRun.routine_id.in_(ids))
        await db.execute(delete(RoutineAppAction).where(RoutineAppAction.run_id.in_(run_ids)))
        await db.execute(delete(RoutineRun).where(RoutineRun.routine_id.in_(ids)))
        await db.execute(delete(Routine).where(Routine.owner_id == owner))
        await db.commit()


async def full_turn(world, sessions, handler, holder=None):
    runtime, engine, agent = world
    engine.handler = handler
    thread = await runtime.create_thread(agent_id=agent.id)
    async with sessions() as db:
        routine = await routine_service.create_routine(db, runtime.owner_id, {"agent_id": agent.id, "name": "R", "prompt": "P"})
        routine.uninterrupted_access = True
        ceiling = await routine_uninterrupted.snapshot(db, runtime.owner_id, agent.id)
        occurrence = RoutineRun(routine_id=routine.id, trigger="manual", state="running", thread_id=thread.id,
                                uninterrupted_access=True, capability_snapshot=ceiling)
        db.add(occurrence)
        await db.commit()
    if holder is not None:
        holder["routine_id"] = routine.id
    turn = await runtime.send_turn(thread.id, "go", team_origin="routine", routine_run_id=occurrence.id)
    await wait_until(lambda: turn.id not in runtime._runs)
    return occurrence


async def receipts(sessions, occurrence):
    async with sessions() as db:
        return list((await db.scalars(select(RoutineAppAction).where(RoutineAppAction.run_id == occurrence.id).order_by(RoutineAppAction.id))).all())


async def test_full_curated_write_has_receipt_and_exact_replay_is_not_dispatched(world, fake, sessions):
    runtime, _, agent = world
    async with sessions() as db:
        await agent_store.update_agent(db, agent.id, connector_scopes={"github": "write"}, connector_account_scopes={"github": ["ca_1"]})
    fake.answer = {"result_type": "completed", "data": {"number": 1, "html_url": "https://github.com/o/r/issues/1"}, "error": None}
    seen = {}
    args = {"owner": "o", "repo": "r", "title": "Plan", "body": "Private input body"}
    async def handler(ctx, sink, gate):
        assert ctx.routine_uninterrupted is True
        seen["first"] = await ask(ctx, gate, "github_create_issue", args)
        seen["again"] = await ask(ctx, gate, "github_create_issue", args)
        return TurnOutcome("succeeded", result="ok")
    occurrence = await full_turn(world, sessions, handler)
    assert "error" not in seen["first"]
    assert seen["again"]["code"] == "already_attempted"
    assert len(fake.executes) == 1
    rows = await receipts(sessions, occurrence)
    completed = next(row for row in rows if row.status == "completed")
    assert completed.account_id == "ca_1" and len(completed.request_key) == 64
    assert completed.result == {"completed": True}
    assert "Private input" not in str([row.result for row in rows])


async def test_run_start_account_ceiling_and_current_scope_both_apply(world, fake, sessions):
    _, _, agent = world
    fake.accounts.append({"id": "ca_other", "toolkit": {"slug": "github"}, "alias": "other", "status": "ACTIVE", "user_id": "u1"})
    seen = {}
    async def handler(ctx, sink, gate):
        async with sessions() as db:
            await agent_store.update_agent(db, agent.id, connector_account_scopes={"github": ["ca_1", "ca_other"]})
        seen["new_account"] = await ask(ctx, gate, "github_get_authenticated_user", {"account": "other"})
        async with sessions() as db:
            await agent_store.update_agent(db, agent.id, connector_scopes={})
        seen["revoked"] = await ask(ctx, gate, "github_get_authenticated_user", {})
        return TurnOutcome("succeeded", result="ok")
    await full_turn(world, sessions, handler)
    assert seen["new_account"].get("error")
    assert seen["revoked"] == {"decision": "deny"}
    assert fake.executes == []


async def test_revocation_in_the_before_execute_hook_blocks_provider_dispatch(world, fake, sessions, monkeypatch):
    _, _, agent = world
    async with sessions() as db:
        await agent_store.update_agent(db, agent.id, connector_scopes={"github": "write"})
    holder, seen = {}, {}
    original = composio_service.run_tool
    async def run_tool(db, *args, before_execute=None, **kwargs):
        async def revoke(account_id):
            (await db.get(Routine, holder["routine_id"])).uninterrupted_access = False
            await db.commit()
            return await before_execute(account_id)
        return await original(db, *args, before_execute=revoke, **kwargs)
    monkeypatch.setattr(composio_service, "run_tool", run_tool)
    async def handler(ctx, sink, gate):
        seen["result"] = await ask(ctx, gate, "github_create_issue", {"owner": "o", "repo": "r", "title": "Plan"})
        return TurnOutcome("succeeded", result="ok")
    await full_turn(world, sessions, handler, holder)
    assert seen["result"]["code"] == "not_allowed"
    assert fake.executes == []


async def test_full_generic_write_reserves_uncertain_outcome_and_prevents_replay(world, sessions, monkeypatch):
    _, _, agent = world
    provider = GenericComposio()
    provider.execute_fault = "500"
    monkeypatch.setattr(composio_bridge, "make_client", lambda key: ComposioClient(key, transport=httpx.MockTransport(provider.handler)))
    async with sessions() as db:
        await agent_store.update_agent(db, agent.id, connector_scopes={"notion": "write"}, connector_account_scopes={"notion": ["ca_n"]})
    seen = {}
    args = run_args(provider)
    async def handler(ctx, sink, gate):
        seen["first"] = await ask(ctx, gate, "app_run_action", args)
        seen["again"] = await ask(ctx, gate, "app_run_action", args)
        return TurnOutcome("succeeded", result="ok")
    occurrence = await full_turn(world, sessions, handler)
    assert seen["first"]["code"] == "outcome_unknown"
    assert seen["again"]["code"] == "already_attempted"
    assert provider.execute_attempts == 1
    rows = await receipts(sessions, occurrence)
    uncertain = next(row for row in rows if row.status == "outcome_unknown")
    assert uncertain.account_id == "ca_n" and uncertain.request_key is not None
