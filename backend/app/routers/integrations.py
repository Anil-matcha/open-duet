"""Connected apps through Composio: the owner's key, and connecting,
listing and disconnecting apps (.internal/design/composio-integration.md).

Owner only. The local access check keeps remote clients out; `_owner` then
requires an admin principal, so a paired chat device is refused. The key is
write-only: nothing here returns it or echoes a request body.
"""

import json

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.middleware import principal_of
from app.db.session import get_db
from app.schemas.composio import ComposioAccount, ComposioApp, ComposioConnectRequest, ComposioLink, ComposioStatus
from app.services import composio_service as service
from app.services.composio_client import LINK_LIFETIME_SECONDS, ComposioClient
from app.services.local_access_policy import require_local_access
from app.services.thread_runtime import LOCAL_OWNER_ID

MAX_KEY_BODY = 1024


def _owner(request: Request) -> None:
    principal = principal_of(request.scope)
    if principal is None or not principal.is_admin:
        raise HTTPException(
            status_code=403,
            detail={"error_code": "admin_required", "message": "Sign in as the owner to manage connected apps."},
        )


router = APIRouter(
    prefix="/integrations/composio",
    tags=["Integrations"],
    dependencies=[Depends(require_local_access), Depends(_owner)],
)


def get_client_factory():
    """Builds a client for a key; tests replace this to point at a fake Composio."""
    return ComposioClient


def _fail(error: service.UserError) -> HTTPException:
    return HTTPException(status_code=error.status, detail={"error_code": error.code, "message": error.message})


@router.get("", response_model=ComposioStatus)
async def status(response: Response, db: AsyncSession = Depends(get_db)):
    """Whether a key is saved, and the apps offered. Does not call Composio."""
    response.headers["Cache-Control"] = "no-store"
    return ComposioStatus(
        configured=await service.configured(db, LOCAL_OWNER_ID),
        apps=[ComposioApp(slug=slug, label=label) for slug, label in service.SUPPORTED_APPS],
    )


@router.put("/key", response_model=ComposioStatus)
async def save_key(
    request: Request, response: Response, db: AsyncSession = Depends(get_db), make_client=Depends(get_client_factory),
):
    """Check the key with Composio and save it encrypted. Replacing a key
    drops the saved session; accounts are rediscovered under the new key."""
    response.headers["Cache-Control"] = "no-store"
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_KEY_BODY:
            break
    key = None
    try:
        payload = json.loads(bytes(body)) if len(body) <= MAX_KEY_BODY else None
        if isinstance(payload, dict) and set(payload) == {"api_key"}:
            key = payload["api_key"]
    except ValueError:
        pass
    try:
        await service.set_key(db, LOCAL_OWNER_ID, key, make_client)
    except service.UserError as error:
        raise _fail(error) from None
    return await status(response, db)


@router.delete("/key", status_code=204)
async def delete_key(db: AsyncSession = Depends(get_db)):
    """Forget the key. Connected accounts stay at Composio; this does not revoke them."""
    await service.remove_key(db, LOCAL_OWNER_ID)


@router.get("/accounts", response_model=list[ComposioAccount])
async def list_accounts(response: Response, db: AsyncSession = Depends(get_db), make_client=Depends(get_client_factory)):
    response.headers["Cache-Control"] = "no-store"
    try:
        found = await service.accounts(db, LOCAL_OWNER_ID, make_client)
    except service.UserError as error:
        raise _fail(error) from None
    return [ComposioAccount(**vars(account)) for account in found]


@router.post("/connect", response_model=ComposioLink, status_code=201)
async def connect(
    payload: ComposioConnectRequest, response: Response,
    db: AsyncSession = Depends(get_db), make_client=Depends(get_client_factory),
):
    """Start connecting an app. The returned link is for the owner's browser
    only; it is not stored. Completion is seen by listing accounts."""
    response.headers["Cache-Control"] = "no-store"
    try:
        link = await service.connect(db, LOCAL_OWNER_ID, make_client, payload.toolkit, payload.alias)
    except service.UserError as error:
        raise _fail(error) from None
    return ComposioLink(redirect_url=link.redirect_url, account_id=link.account_id, expires_in_seconds=LINK_LIFETIME_SECONDS)


@router.delete("/accounts/{account_id}", status_code=204)
async def disconnect(account_id: str, db: AsyncSession = Depends(get_db), make_client=Depends(get_client_factory)):
    """Disconnect an account and ask Composio to revoke it. If Composio cannot
    be reached the account is not reported as removed."""
    try:
        await service.disconnect(db, LOCAL_OWNER_ID, make_client, account_id)
    except service.UserError as error:
        raise _fail(error) from None
