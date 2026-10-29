"""Routines and the notification feed (docs/ROUTINES.md).

A routine runs a local agent, so the local access check covers the whole
router, as for threads and agents. Webhook deliveries arrive elsewhere
(app/routers/hooks.py), authenticated by the routine's own secret.

Errors a client acts on carry a machine-readable code:
`{"detail": {"error_code": "...", "message": "..."}}`.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.core.config import settings
from app.schemas.routine import (
    NotificationResponse,
    RoutineCreateRequest,
    RoutineAppActionResponse,
    RoutineImportRequest,
    RoutineResponse,
    RoutineRunResponse,
    RoutineUpdateRequest,
    SchedulePreviewRequest,
    SchedulePreviewResponse,
    UnreadCountResponse,
    WebhookSecretResponse,
)
from app.services import notification_feed
from app.services import routine_schedule as schedules
from app.services import routine_service as service
from app.services.local_access_policy import require_local_access
from app.db import tenant_schema

router = APIRouter(tags=["Routines"], dependencies=[Depends(require_local_access)])


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"error_code": code, "message": message})


def _not_found() -> HTTPException:
    return _error(404, "routine_not_found", "Routine not found")


def _invalid(exc: service.InvalidRoutine) -> HTTPException:
    return _error(422, exc.code, str(exc))


async def _validated_grants(db, owner_id, agent_id, grants):
    """Only the person-facing editor can assign grants; imports/chat omit them."""
    from app import composio_tools
    from app.db.models import Agent
    from app.services import composio_service
    from app.services.composio_bridge import apps_for, make_client

    if grants is None:
        raise _error(422, "invalid_app_grant", "Use an empty list to switch app access off.")
    if not grants:
        return []
    tools = [g.tool for g in grants]
    if len(set(tools)) != len(tools):
        raise _error(422, "invalid_app_grant", "Choose only one account per action.")
    agent = await db.get(Agent, agent_id)
    if agent is None or agent.owner_id != owner_id or agent.archived_at is not None:
        raise _error(422, "invalid_app_grant", "Choose an available agent.")
    scopes = apps_for(agent.connector_scopes)
    try:
        accounts = await composio_service.accounts(db, owner_id, make_client)
    except composio_service.UserError as exc:
        raise _error(exc.status, exc.code, exc.message) from None
    for grant in grants:
        tool = composio_tools.BY_NAME.get(grant.tool)
        if tool is None or (tool.kind != "read" and grant.tool not in composio_tools.ROUTINE_WRITE_TOOLS) or not composio_tools.allows(scopes.get(tool.app), tool.kind):
            raise _error(422, "invalid_app_grant", "The agent must have access to this action's app.")
        if not any(a.id == grant.account_id and a.toolkit == tool.app and a.status == "ACTIVE" for a in accounts):
            raise _error(422, "invalid_app_grant", "Select an active connected account for each action.")
    return [g.model_dump() for g in grants]


def _describe(routine, latest=None, now: datetime | None = None) -> RoutineResponse:
    now = now or datetime.now(UTC)
    response = RoutineResponse.model_validate(routine)
    try:
        summary = schedules.summary(routine.schedule_kind, routine.schedule_spec, routine.timezone)
        dates = schedules.next_dates(routine.schedule_kind, routine.schedule_spec, routine.timezone, now)
    except (schedules.InvalidSchedule, KeyError, ValueError):
        summary, dates = "Schedule cannot be read", []
    return response.model_copy(update={
        "summary": summary,
        "next_dates": dates,
        "webhook_enabled": routine.webhook_secret_hash is not None,
        "latest_run": RoutineRunResponse.model_validate(latest) if latest is not None else None,
    })


async def _one(db, routine) -> RoutineResponse:
    latest = (await service.latest_runs(db, [routine.id])).get(routine.id)
    return _describe(routine, latest)


def _hook_path(routine_id: int) -> str:
    """The address to give a sender. In a hosted deployment it names the account (routers/hooks.py).
    A configured OPEN_DOTS_WEBHOOK_BASE wins and makes the address absolute."""
    if settings.OPEN_DOTS_WEBHOOK_BASE:
        return f"{settings.OPEN_DOTS_WEBHOOK_BASE.rstrip('/')}/{routine_id}"
    tenant = tenant_schema.current_tenant()
    return f"/hooks/t/{tenant[2:]}/{routine_id}" if tenant else f"/hooks/{routine_id}"


@router.get("/routines", response_model=list[RoutineResponse])
async def list_routines(sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        routines = await service.list_routines(db, sch.owner_id)
        latest = await service.latest_runs(db, [r.id for r in routines])
    now = datetime.now(UTC)
    return [_describe(r, latest.get(r.id), now) for r in routines]


@router.post("/routines", response_model=RoutineResponse, status_code=201)
async def create_routine(payload: RoutineCreateRequest, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        try:
            grants = await _validated_grants(db, sch.owner_id, payload.agent_id, payload.connected_app_grants)
            routine = await service.create_routine(db, sch.owner_id, payload.model_dump(), commit=False)
            routine.connected_app_grants = grants
            await db.commit()
            await db.refresh(routine)
        except service.InvalidRoutine as exc:
            raise _invalid(exc) from None
        return _describe(routine)


@router.post("/routines/preview", response_model=SchedulePreviewResponse)
async def preview_schedule(payload: SchedulePreviewRequest):
    now = datetime.now(UTC)
    try:
        spec = schedules.normalize(payload.schedule_kind, payload.schedule_spec, payload.timezone, now=now)
        return SchedulePreviewResponse(
            summary=schedules.summary(payload.schedule_kind, spec, payload.timezone),
            next_dates=schedules.next_dates(payload.schedule_kind, spec, payload.timezone, now),
        )
    except schedules.InvalidSchedule as exc:
        raise _error(422, "invalid_schedule", str(exc)) from None


@router.post("/routines/import", response_model=list[RoutineResponse], status_code=201)
async def import_routines(payload: RoutineImportRequest, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    created = []
    async with sch.session() as db:
        for document in payload.documents:
            try:
                created.append(await service.import_document(db, sch.owner_id, payload.agent_id, document))
            except service.InvalidRoutine as exc:
                raise _invalid(exc) from None
    return [_describe(r) for r in created]


@router.get("/routines/runs", response_model=list[RoutineRunResponse])
async def recent_runs(limit: int = Query(50, ge=1, le=500), sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        return await service.list_runs(db, sch.owner_id, limit=limit)


@router.get("/routines/{routine_id}", response_model=RoutineResponse)
async def get_routine(routine_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        try:
            routine = await service.get_routine(db, sch.owner_id, routine_id)
        except service.RoutineNotFound:
            raise _not_found() from None
        return await _one(db, routine)


@router.patch("/routines/{routine_id}", response_model=RoutineResponse)
async def update_routine(
    routine_id: int, payload: RoutineUpdateRequest, sch: service.RoutineScheduler = Depends(service.get_scheduler)
):
    async with sch.session() as db:
        try:
            grants = None
            if "connected_app_grants" in payload.model_fields_set or payload.agent_id is not None:
                existing = await service.get_routine(db, sch.owner_id, routine_id)
                selected = payload.connected_app_grants
                if "connected_app_grants" not in payload.model_fields_set:
                    from app.schemas.routine import ConnectedAppGrant
                    selected = [ConnectedAppGrant.model_validate(g) for g in existing.connected_app_grants]
                grants = await _validated_grants(db, sch.owner_id, payload.agent_id or existing.agent_id, selected)
            routine = await service.update_routine(
                db, sch.owner_id, routine_id, payload.model_dump(exclude_unset=True), commit=False
            )
            if grants is not None:
                routine.connected_app_grants = grants
            await db.commit()
            await db.refresh(routine)
        except service.RoutineNotFound:
            raise _not_found() from None
        except service.InvalidRoutine as exc:
            raise _invalid(exc) from None
        return await _one(db, routine)


@router.delete("/routines/{routine_id}", status_code=204)
async def delete_routine(routine_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        try:
            await service.delete_routine(db, sch.owner_id, routine_id)
        except service.RoutineNotFound:
            raise _not_found() from None
    return Response(status_code=204)


async def _pause(routine_id: int, paused: bool, sch: service.RoutineScheduler) -> RoutineResponse:
    async with sch.session() as db:
        try:
            routine = await service.set_paused(db, sch.owner_id, routine_id, paused)
        except service.RoutineNotFound:
            raise _not_found() from None
        return await _one(db, routine)


@router.post("/routines/{routine_id}/pause", response_model=RoutineResponse)
async def pause_routine(routine_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    return await _pause(routine_id, True, sch)


@router.post("/routines/{routine_id}/resume", response_model=RoutineResponse)
async def resume_routine(routine_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    return await _pause(routine_id, False, sch)


@router.post("/routines/{routine_id}/run", response_model=RoutineRunResponse, status_code=202)
async def run_routine_now(routine_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        try:
            run = await service.run_now(db, sch.owner_id, routine_id)
        except service.RoutineNotFound:
            raise _not_found() from None
        except service.RoutineBusy:
            raise _error(409, "routine_busy", "A run of this routine is still in progress.") from None
    sch.kick()
    return run


@router.get("/routines/{routine_id}/runs", response_model=list[RoutineRunResponse])
async def routine_runs(
    routine_id: int, limit: int = Query(50, ge=1, le=500), sch: service.RoutineScheduler = Depends(service.get_scheduler)
):
    async with sch.session() as db:
        try:
            await service.get_routine(db, sch.owner_id, routine_id)
        except service.RoutineNotFound:
            raise _not_found() from None
        return await service.list_runs(db, sch.owner_id, routine_id, limit=limit)


@router.get("/routines/{routine_id}/runs/{run_id}/app-actions", response_model=list[RoutineAppActionResponse])
async def routine_app_actions(
    routine_id: int, run_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)
):
    from sqlalchemy import select
    from app.db.models import RoutineAppAction, RoutineRun

    async with sch.session() as db:
        try:
            await service.get_routine(db, sch.owner_id, routine_id)
        except service.RoutineNotFound:
            raise _not_found() from None
        run = await db.get(RoutineRun, run_id)
        if run is None or run.routine_id != routine_id:
            raise _error(404, "routine_run_not_found", "Routine run not found")
        rows = await db.scalars(
            select(RoutineAppAction).where(RoutineAppAction.run_id == run_id)
            .order_by(RoutineAppAction.created_at.desc(), RoutineAppAction.id.desc()).limit(100)
        )
        return list(rows.all())


@router.get("/routines/{routine_id}/export")
async def export_routine(routine_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        try:
            routine = await service.get_routine(db, sch.owner_id, routine_id)
        except service.RoutineNotFound:
            raise _not_found() from None
    return service.export_document(routine)


@router.post("/routines/{routine_id}/webhook", response_model=WebhookSecretResponse)
async def enable_webhook(routine_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        try:
            routine, secret = await service.enable_webhook(db, sch.owner_id, routine_id)
        except service.RoutineNotFound:
            raise _not_found() from None
        described = await _one(db, routine)
    return WebhookSecretResponse(routine=described, secret=secret, path=_hook_path(routine_id))


@router.delete("/routines/{routine_id}/webhook", response_model=RoutineResponse)
async def disable_webhook(routine_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        try:
            routine = await service.disable_webhook(db, sch.owner_id, routine_id)
        except service.RoutineNotFound:
            raise _not_found() from None
        return await _one(db, routine)


# --- notifications ---------------------------------------------------------------------------


@router.get("/notifications", response_model=list[NotificationResponse])
async def list_notifications(
    unread_only: bool = False,
    limit: int = Query(50, ge=1, le=200),
    sch: service.RoutineScheduler = Depends(service.get_scheduler),
):
    async with sch.session() as db:
        return await notification_feed.list_feed(db, sch.owner_id, limit=limit, unread_only=unread_only)


@router.get("/notifications/unread-count", response_model=UnreadCountResponse)
async def unread_notifications(sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        return UnreadCountResponse(unread=await notification_feed.unread_count(db, sch.owner_id))


@router.post("/notifications/read-all", response_model=UnreadCountResponse)
async def read_all_notifications(sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        await notification_feed.mark_all_read(db, sch.owner_id)
        return UnreadCountResponse(unread=0)


@router.post("/notifications/{notification_id}/read", status_code=204)
async def read_notification(notification_id: int, sch: service.RoutineScheduler = Depends(service.get_scheduler)):
    async with sch.session() as db:
        if not await notification_feed.mark_read(db, sch.owner_id, notification_id):
            raise _error(404, "notification_not_found", "Notification not found")
    return Response(status_code=204)
