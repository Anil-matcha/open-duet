from types import SimpleNamespace as NS
from uuid import uuid4

import pytest
from sqlalchemy import delete, select

from app.core.config import settings
from app.db.models import Agent, Computer, Thread, Turn, CommunityMcpConnection, CommunityMcpToolGrant
from app.db.models.routine import Routine, RoutineRun, RoutineAppAction
from app.services import routine_uninterrupted
from app.services import thread_store
from app.services.community_mcp_bridge import CommunityMcpBridge
from tests.services.thread_harness import sessions, owner, cleanup  # noqa: F401


@pytest.fixture
async def community_world(sessions, owner, monkeypatch):
    monkeypatch.setattr(settings, "HOST_EXECUTION_DISABLED", False)
    async with sessions() as db:
        agent = Agent(owner_id=owner, name="Tools")
        db.add(agent)
        await db.flush()
        thread = Thread(owner_id=owner, agent_id=agent.id, provider="codex")
        db.add(thread)
        await db.flush()
        turn = Turn(thread_id=thread.id, seq=1, prompt_text="Research", origin="routine", status="running", owner_token="owner-token")
        routine = Routine(owner_id=owner, agent_id=agent.id, name="R", prompt="P", schedule_kind="manual",
                          schedule_spec={}, uninterrupted_access=True)
        connection = CommunityMcpConnection(id=uuid4().hex, owner_id=owner, slug="test-" + uuid4().hex,
            section="community", manifest={"auth_mode": "none", "name": "Public tool", "slug": "public", "endpoint": "https://example.com/mcp"},
            manifest_digest="manifest-1", revision=1)
        db.add_all([turn, routine, connection])
        await db.flush()
        grant = CommunityMcpToolGrant(agent_id=agent.id, connection_id=connection.id, tool_name="lookup", schema_digest="schema-1",
            description="Look up", input_schema={"type": "object", "properties": {}, "additionalProperties": False})
        db.add(grant)
        await db.flush()
        ceiling = await routine_uninterrupted.snapshot(db, owner, agent.id)
        occurrence = RoutineRun(routine_id=routine.id, trigger="schedule", state="running", thread_id=thread.id, turn_id=turn.id,
                                uninterrupted_access=True, capability_snapshot=ceiling)
        db.add(occurrence)
        await db.commit()
    runtime = NS(owner_id=owner, session=sessions)
    run = NS(agent_id=agent.id, routine_run_id=occurrence.id, thread_id=thread.id, turn_id=turn.id, owner_token="owner-token",
             uninterrupted_access=True, ctx=NS(computer=NS(computer_id=7), browser=None, team=NS(), draft_only=False,
                                              media_review_only=False, aborted=False, community_tools=[], approval_mode="ask"))
    adapter = NS(key="codex", capabilities=NS(mcp=True, approvals=True))
    yield runtime, run, adapter, routine, connection, agent
    async with sessions() as db:
        await db.execute(delete(CommunityMcpToolGrant).where(CommunityMcpToolGrant.agent_id == agent.id))
        await db.execute(delete(CommunityMcpConnection).where(CommunityMcpConnection.id == connection.id))
        await db.execute(delete(RoutineAppAction).where(RoutineAppAction.run_id == occurrence.id))
        await db.delete(await db.get(RoutineRun, occurrence.id))
        await db.delete(await db.get(Routine, routine.id))
        await db.delete(await db.get(Agent, agent.id))
        await db.commit()


async def test_full_routine_mounts_only_snapshotted_tools_and_revocation_blocks_dispatch(community_world, sessions):
    runtime, run, adapter, routine, connection, agent = community_world
    mounted = await CommunityMcpBridge.for_turn(runtime, run, adapter)
    assert [item["grant"]["tool_name"] for item in mounted] == ["lookup"]
    async with sessions() as db:
        db.add(CommunityMcpToolGrant(agent_id=agent.id, connection_id=connection.id, tool_name="new_tool", schema_digest="new-schema",
                                    description="Added later", input_schema={"type": "object", "properties": {}}))
        await db.commit()
    assert [item["grant"]["tool_name"] for item in await CommunityMcpBridge.for_turn(runtime, run, adapter)] == ["lookup"]
    bridge = CommunityMcpBridge(runtime, run, mounted)
    try:
        [alias] = bridge.aliases_allowed
        run.ctx.community_tools = [alias]
        assert await bridge._current_snapshot(alias) is not None
        async with sessions() as db:
            (await db.get(Routine, routine.id)).uninterrupted_access = False
            await db.commit()
        assert await bridge._current_snapshot(alias) is None
        assert (await bridge.execute(alias, {}))["code"] == "revoked"
    finally:
        await bridge.close()


@pytest.mark.parametrize("ambiguous", [False, True])
async def test_identical_full_mode_marketplace_calls_are_reserved_once(community_world, sessions, ambiguous):
    from app import community_mcp
    runtime, run, adapter, _, _, _ = community_world
    mounted = await CommunityMcpBridge.for_turn(runtime, run, adapter)
    bridge = CommunityMcpBridge(runtime, run, mounted)
    [alias] = bridge.aliases_allowed
    calls = []
    class Remote:
        async def call_tool(self, name, arguments):
            calls.append((name, arguments))
            if ambiguous:
                raise community_mcp.McpError("outcome_unknown", "response lost", 502)
            return {"content": [{"type": "text", "text": "done"}]}
    async def approve(request_id):
        async with sessions() as db:
            row = await thread_store.create_approval(db, thread_id=run.thread_id, turn_id=run.turn_id,
                request_id=request_id, tool="mcp__community__" + alias, input={}, summary="Lookup", kind="other", owner_token=run.owner_token)
            await thread_store.decide_approval(db, row.id, "allowed", by={"by": "routine_uninterrupted_grant"})
    try:
        await approve("first")
        first = await bridge._consume_and_call(Remote(), alias, {})
        await approve("second")
        second = await bridge._consume_and_call(Remote(), alias, {})
        assert second["code"] == "already_attempted"
        assert len(calls) == 1
        if ambiguous:
            assert first["code"] == "outcome_unknown"
        async with sessions() as db:
            [receipt] = list((await db.scalars(select(RoutineAppAction).where(RoutineAppAction.run_id == run.routine_run_id))).all())
        assert receipt.status == ("outcome_unknown" if ambiguous else "completed")
        assert receipt.request_key is not None
    finally:
        await bridge.close()
