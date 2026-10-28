"""Owner-scoped onboarding wizard state and its explicit completion action."""

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import IntegrityError

from app.auth.routes import require_admin
from app.db.models import Agent
from app.desktop import profile
from app.routers.agents import _check_engine, get_runtime
from app.services import onboarding as state_store
from app.services.engine_registry import capabilities_of
from app.services.local_access_policy import require_local_access
from app.services.thread_runtime import ThreadRuntime
from app.team.service import TeamError, set_lead

def _no_store(response: Response):
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/onboarding", tags=["Onboarding"], dependencies=[Depends(require_local_access), Depends(require_admin), Depends(_no_store)])


class Draft(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    step: int = Field(ge=0, le=3)
    provider: str = Field(max_length=64)
    model: str | None = Field(default=None, max_length=200)
    name: str = Field(max_length=80)
    purpose: str = Field(max_length=24000)
    first_request: str = Field(max_length=24000)
    create_agent: bool
    make_lead: bool

    @field_validator("provider", "name")
    @classmethod
    def clean_line(cls, value: str) -> str:
        value = value.strip()
        if any(ord(char) < 32 for char in value):
            raise ValueError("must be a single line")
        return value

    @field_validator("purpose", "first_request")
    @classmethod
    def bounded_text(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 24000:
            raise ValueError("text is too large")
        return value


class VersionedDraft(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_version: int = Field(ge=1)
    draft: Draft


class VersionOnly(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expected_version: int = Field(ge=1)


class FirstReplyBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    thread_id: int = Field(gt=0)


def _conflict() -> HTTPException:
    return HTTPException(409, detail={"error_code": "onboarding_conflict", "message": "Onboarding changed in another tab. Reload and try again."})


def _execution_host() -> str:
    return "desktop" if profile.active() else "server"


def _legacy_completed() -> bool:
    if _execution_host() != "desktop":
        return False
    from app.core import app_settings

    return app_settings.get("DESKTOP_ONBOARDING_COMPLETED", live=True) is True


async def _response(rt: ThreadRuntime, state: dict | None = None) -> dict:
    async with rt.session() as db:
        stored, existing = await state_store.load(db, rt.owner_id)
    if state is None:
        state = stored
    if state is None:
        state = state_store.fresh_state(existing_agents=existing or _legacy_completed())
    return state_store.response(state, execution_host=_execution_host(), existing_agents=existing)


@router.get("")
async def get_onboarding(rt: ThreadRuntime = Depends(get_runtime)):
    return await _response(rt)


@router.put("")
async def put_draft(body: VersionedDraft, rt: ThreadRuntime = Depends(get_runtime)):
    try:
        async with rt.session() as db:
            state = await state_store.put(db, rt.owner_id, body.expected_version, body.draft.model_dump(), legacy_completed=_legacy_completed())
    except state_store.VersionConflict:
        raise _conflict() from None
    return await _response(rt, state)


@router.post("/complete")
async def complete(body: VersionedDraft, rt: ThreadRuntime = Depends(get_runtime)):
    draft = body.draft.model_dump()
    legacy_completed = _legacy_completed()

    # Receipt replay is a read-only fast path, before probing a provider or
    # opening the write transaction used for the agent and receipt together.
    try:
        async with rt.session() as db:
            state, replay = await state_store.preflight_complete(
                db, rt.owner_id, body.expected_version, draft, legacy_completed=legacy_completed
            )
    except state_store.VersionConflict:
        raise _conflict() from None
    if replay:
        return await _response(rt, state)

    if draft["make_lead"] and not draft["create_agent"]:
        raise HTTPException(409, detail={"error_code": "lead_requires_agent", "message": "A team lead must be an agent."})
    if draft["create_agent"] and not draft["purpose"].strip():
        raise HTTPException(422, detail={"error_code": "invalid_agent_purpose", "message": "Enter a purpose for the agent."})
    if draft["create_agent"] and not draft["name"].strip():
        raise HTTPException(422, detail={"error_code": "invalid_agent_name", "message": "Enter a name for the agent."})
    if draft["make_lead"]:
        adapter = rt.adapters.get(draft["provider"])
        if adapter is None or not capabilities_of(adapter).mcp:
            raise HTTPException(409, detail={"error_code": "lead_engine", "message": "A lead needs an engine with team tools."})
    # Validate the selected engine/model even when agent creation is disabled:
    # the first conversation still needs to be runnable.
    _check_engine(rt, draft["provider"], draft["model"])
    engines = await rt.engines.describe(only=draft["provider"])
    if not engines or not engines[0]["available"]:
        reason = engines[0]["reason"] if engines else "This engine is not available."
        raise HTTPException(409, detail={"error_code": "engine_not_ready", "message": reason or "This engine is not ready."})

    async def create(db):
        if not draft["create_agent"]:
            return None
        name = draft["name"].strip()
        agent = Agent(owner_id=rt.owner_id, name=name, instructions=draft["purpose"], provider=draft["provider"], model=draft["model"], approval_mode="ask")
        db.add(agent)
        try:
            await db.flush()
        except IntegrityError:
            raise HTTPException(409, detail={"error_code": "agent_name_taken", "message": "An agent with that name already exists."}) from None
        if draft["make_lead"]:
            try:
                await set_lead(db, rt.owner_id, agent.id, commit=False)
            except TeamError as exc:
                raise HTTPException(409, detail={"error_code": exc.code, "message": str(exc)}) from None
        return agent.id

    try:
        async with rt.session() as db:
            state = await state_store.complete(db, rt.owner_id, body.expected_version, draft, create, legacy_completed=legacy_completed)
    except state_store.VersionConflict:
        raise _conflict() from None
    return await _response(rt, state)


@router.post("/skip")
async def skip(body: VersionOnly, rt: ThreadRuntime = Depends(get_runtime)):
    try:
        async with rt.session() as db:
            state = await state_store.skip(db, rt.owner_id, body.expected_version, legacy_completed=_legacy_completed())
    except state_store.VersionConflict:
        raise _conflict() from None
    return await _response(rt, state)


@router.post("/restart")
async def restart(body: VersionOnly, rt: ThreadRuntime = Depends(get_runtime)):
    try:
        async with rt.session() as db:
            state = await state_store.restart(db, rt.owner_id, body.expected_version)
    except state_store.VersionConflict:
        raise _conflict() from None
    return await _response(rt, state)


@router.post("/first-reply")
async def first_reply(body: FirstReplyBody, rt: ThreadRuntime = Depends(get_runtime)):
    try:
        async with rt.session() as db:
            state = await state_store.record_first_reply(db, rt.owner_id, body.thread_id, legacy_completed=_legacy_completed())
    except state_store.ThreadNotFound:
        raise HTTPException(404, detail="Thread not found") from None
    except state_store.ThreadNotCompleted:
        raise HTTPException(409, detail={"error_code": "first_reply_not_completed", "message": "The thread has no successful completed assistant turn yet."}) from None
    except state_store.NotConfigured:
        raise HTTPException(409, detail={"error_code": "onboarding_not_configured", "message": "Complete onboarding before recording its first reply."}) from None
    except state_store.VersionConflict:
        raise _conflict() from None
    return await _response(rt, state)
