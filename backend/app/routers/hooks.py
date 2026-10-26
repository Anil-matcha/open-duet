"""Webhook deliveries for routines: `POST /hooks/{routine_id}`.

Authenticated by the routine's own bearer secret, not by the local access
check, so a sender elsewhere can reach it through the ingress
(app/ingress.py). The secret is checked before the body is read, and the body
is size-limited while it is read.
"""

import re

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from app.core import tenant_jobs
from app.core.config import settings
from app.db import tenant_schema
from app.services import routine_service as service

router = APIRouter(tags=["Webhooks"])


def _refuse(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"detail": message}, headers={"Cache-Control": "no-store"})


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip() or None


async def _read_limited(request: Request, limit: int) -> bytes | None:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        return None
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            return None
    return bytes(body)


@router.post("/hooks/{routine_id}", status_code=202)
async def receive(
    routine_id: int, request: Request, scheduler: service.RoutineScheduler = Depends(service.get_scheduler)
):
    return await _deliver(routine_id, request, scheduler)


@router.post("/hooks/t/{tenant_hex}/{routine_id}", status_code=202)
async def receive_for_account(
    tenant_hex: str, routine_id: int, request: Request,
    scheduler: service.RoutineScheduler = Depends(service.get_scheduler),
):
    """A hosted deployment's webhook: the address names the account (its schema), because this route
    is public and routine ids repeat across accounts. The routine's own secret still decides; a
    malformed or unknown account, a routine that is not there and a wrong secret all answer the
    same 401, and with TENANT_SCHEMAS_ENABLED off the route does not exist."""
    if not settings.TENANT_SCHEMAS_ENABLED:
        return JSONResponse(status_code=404, content={"detail": "Not Found"})
    unknown = _refuse(401, "Unknown webhook or wrong secret")
    if not re.fullmatch(r"[0-9a-f]{32}", tenant_hex):
        return unknown
    tenant = f"u_{tenant_hex}"
    if tenant not in await tenant_jobs.tenants():
        return unknown
    with tenant_schema.use_tenant(tenant):
        return await _deliver(routine_id, request, scheduler)


async def _deliver(routine_id: int, request: Request, scheduler: service.RoutineScheduler):
    secret = _bearer(request)
    async with scheduler.session() as db:
        try:
            await service.authorize_webhook(db, routine_id, secret)
        except service.WebhookRejected as exc:
            return _refuse(exc.status_code, exc.message)
    body = await _read_limited(request, settings.ROUTINE_WEBHOOK_MAX_BYTES)
    if body is None:
        return _refuse(413, f"Body larger than {settings.ROUTINE_WEBHOOK_MAX_BYTES} bytes")
    try:
        payload = body.decode("utf-8")
    except UnicodeDecodeError:
        return _refuse(415, "The body must be UTF-8 text")
    async with scheduler.session() as db:
        try:
            run = await service.accept_webhook(
                db, routine_id, secret, payload, request.headers.get("content-type"),
                delivery_id=request.headers.get("idempotency-key"),
            )
        except service.WebhookRejected as exc:
            return _refuse(exc.status_code, exc.message)
    # Only the backend that runs routines starts one now; the ingress process
    # (app/ingress.py) just queues, and the backend's next poll starts it.
    if getattr(request.app.state, "routines_run_here", False):
        scheduler.kick()
    return JSONResponse(status_code=202, content={"accepted": True, "run_id": run.id},
                        headers={"Cache-Control": "no-store"})
