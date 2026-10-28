"""Local desktop account endpoints. The renderer never receives cloud tokens."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from app.desktop import account, profile
from app.auth.routes import require_admin
from app.services.local_access_policy import require_local_access
from app.db.session import get_db
from app.db.models import Turn
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

def _no_store(response: Response):
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/desktop-account", tags=["Desktop account"], dependencies=[Depends(require_local_access), Depends(require_admin), Depends(_no_store)])


class EmailStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    invite_code: Optional[str] = Field(default=None, max_length=256)


class EmailVerify(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(min_length=3, max_length=254)
    code: str = Field(pattern=r"^\d{6}$")
    adopt_local_data: bool


def _manager() -> account.AccountManager:
    if not profile.active():
        raise HTTPException(status_code=404, detail={"error_code": "desktop_only"})
    try:
        return account.get_manager()
    except RuntimeError:
        raise HTTPException(status_code=503, detail={"error_code": "desktop_account_unavailable"}) from None


def _error(err: account.DesktopAccountError) -> HTTPException:
    messages = {
        "account_sign_in_required": "Sign in to your account to continue.",
        "account_service_unavailable": "Account sign-in is temporarily unavailable. Check your connection and try again.",
        "profile_storage_error": "This desktop profile's account data could not be read safely. Contact support before continuing.",
        "local_data_adoption_required": "Confirm that this account may use the data in this desktop profile.",
        "profile_account_mismatch": "This desktop profile is already linked to a different account.",
        "profile_already_bound": "This desktop profile is already linked to an account.",
        "invalid_request": "Check the sign-in details and try again.",
        "account_request_rejected": "The sign-in request was rejected. Check the code and try again.",
        "rate_limited": "Too many attempts. Wait a little and try again.",
    }
    return HTTPException(status_code=err.status, detail={"error_code": err.code,
                                                           "message": messages.get(err.code, "Account sign-in failed. Try again.")})


@router.get("/status")
async def status():
    try:
        return await _manager().status()
    except account.DesktopAccountError as err:
        raise _error(err)


@router.post("/email/start")
async def email_start(data: EmailStart):
    try:
        return await _manager().email_start(data.email, data.invite_code)
    except account.DesktopAccountError as err:
        raise _error(err)


@router.post("/email/verify")
async def email_verify(data: EmailVerify):
    try:
        return await _manager().email_verify(data.email, data.code, data.adopt_local_data)
    except account.DesktopAccountError as err:
        raise _error(err)


@router.post("/logout")
async def logout(db: AsyncSession = Depends(get_db)):
    _manager()
    active = await db.scalar(select(Turn.id).where(Turn.status == "running").limit(1))
    if active is not None:
        raise HTTPException(409, detail={"error_code": "turn_running", "message": "Stop active agent tasks before signing out."})
    try:
        return await _manager().logout()
    except account.DesktopAccountError as err:
        raise _error(err)
