"""Local Desktop management of the Boat key used by future Boat computers.

These routes store the key only. They never contact Boat or return the secret.
"""

import json

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.routes import require_admin
from app.db.models import Computer
from app.db.session import get_db
from app.desktop import boat_credentials, profile
from app.services.local_access_policy import require_local_access

MAX_BODY_BYTES = 8192


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(
    prefix="/computers/boat-credentials",
    tags=["Computer credentials"],
    dependencies=[Depends(require_local_access), Depends(require_admin), Depends(_no_store)],
)


def _store() -> boat_credentials.BoatCredentials:
    if not profile.active():
        raise HTTPException(status_code=404, detail={"error_code": "desktop_only"})
    try:
        return boat_credentials.get_store()
    except boat_credentials.CredentialError:
        raise HTTPException(status_code=503, detail={"error_code": "credential_storage_error"}) from None
    except RuntimeError:
        raise HTTPException(status_code=404, detail={"error_code": "desktop_only"}) from None


async def _refuse_if_computers_exist(db: AsyncSession, *, allow_removing: bool = False) -> None:
    query = select(Computer.id).where(Computer.provider == "boat")
    if allow_removing:
        # A failed deletion can be waiting on a revoked key. Let the owner
        # replace that key so the queued cleanup can be retried.
        query = query.where(Computer.state != "deleting")
    found = await db.scalar(query.limit(1))
    if found is not None:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "boat_computers_exist",
                "message": "Remove all Boat computers before changing or removing this key.",
            },
        )


async def _read_key(request: Request) -> str:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail={"error_code": "invalid_request"})
        body.extend(chunk)
    try:
        payload = json.loads(bytes(body))
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail={"error_code": "invalid_request"}) from None
    if not isinstance(payload, dict) or set(payload) != {"api_key"} or not isinstance(payload["api_key"], str):
        raise HTTPException(status_code=400, detail={"error_code": "invalid_request"})
    key = payload["api_key"].strip()
    if not key or len(key) > boat_credentials.MAX_KEY_LENGTH or "\x00" in key:
        raise HTTPException(status_code=422, detail={"error_code": "invalid_key"})
    return key


@router.get("")
async def status(response: Response):
    response.headers["Cache-Control"] = "no-store"
    store = _store()
    try:
        return {"configured": store.configured()}
    except (OSError, boat_credentials.CredentialError):
        raise HTTPException(status_code=503, detail={"error_code": "credential_storage_error"}) from None


@router.put("")
async def set_key(request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    store = _store()
    key = await _read_key(request)
    async with boat_credentials.configuration_lock:
        await _refuse_if_computers_exist(db, allow_removing=True)
        try:
            store.set(key)
        except boat_credentials.CredentialError:
            raise HTTPException(status_code=503, detail={"error_code": "credential_storage_error"}) from None
    # Keep the result deliberately small and write-only.
    return {"configured": True}


@router.delete("", status_code=204)
async def delete_key(db: AsyncSession = Depends(get_db)):
    store = _store()
    async with boat_credentials.configuration_lock:
        await _refuse_if_computers_exist(db)
        try:
            store.delete()
        except boat_credentials.CredentialError:
            raise HTTPException(status_code=503, detail={"error_code": "credential_storage_error"}) from None
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
