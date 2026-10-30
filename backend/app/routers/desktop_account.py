"""Local desktop account endpoints. The renderer never receives cloud tokens."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from app.desktop import account, profile, boat_credentials
from app.auth.routes import require_admin
from app.services.local_access_policy import require_local_access
from app.db.session import get_db
from app.db.models import Computer, Turn
from app.desktop.local_data import wipe_local_data
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


class Confirm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm: str = Field(max_length=32)


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
        "local_reset_failed": "Local data could not be erased. Nothing was unlinked; try again.",
        "account_deleted_local_cleanup_failed": "Your account was deleted, but local data could not be fully erased. Choose Reset this profile to finish.",
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


async def _refuse_while_running(db: AsyncSession, action: str) -> None:
    active = await db.scalar(select(Turn.id).where(Turn.status == "running").limit(1))
    if active is not None:
        raise HTTPException(409, detail={"error_code": "turn_running", "message": f"Stop active agent tasks before {action}."})


async def _refuse_while_cloud_computers_exist(db: AsyncSession) -> None:
    cloud_computer = await db.scalar(select(Computer.id).where(Computer.provider == "boat").limit(1))
    if cloud_computer is not None:
        raise HTTPException(
            409,
            detail={
                "error_code": "cloud_computers_remain",
                "message": "Remove all cloud computers first. Profile reset does not delete remote resources; successful reset erases their saved key.",
            },
        )


def _require_confirm(data: Confirm, word: str) -> None:
    if data.confirm != word:
        raise HTTPException(400, detail={"error_code": "confirmation_required", "message": f"Type {word} to confirm."})


@router.post("/reset-profile")
async def reset_profile(data: Confirm, db: AsyncSession = Depends(get_db)):
    """Erase local agents, conversations and settings and unlink the profile. Never implicit."""
    manager = _manager()
    _require_confirm(data, "RESET")
    await _refuse_while_running(db, "resetting this profile")
    async with boat_credentials.configuration_lock:
        await _refuse_while_cloud_computers_exist(db)
        try:
            return await manager.reset_profile(lambda: wipe_local_data(db))
        except account.DesktopAccountError as err:
            raise _error(err)


@router.post("/delete-account")
async def delete_account(data: Confirm, db: AsyncSession = Depends(get_db)):
    """Delete the cloud account, then erase local data and unlink the profile."""
    manager = _manager()
    _require_confirm(data, "DELETE")
    await _refuse_while_running(db, "deleting your account")
    async with boat_credentials.configuration_lock:
        await _refuse_while_cloud_computers_exist(db)
        try:
            return await manager.delete_account(lambda: wipe_local_data(db))
        except account.DesktopAccountError as err:
            raise _error(err)
