"""User profile endpoints (display name, avatar, bio, email)."""

from typing import Optional
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from app.auth.middleware import principal_of
from app.desktop import account, profile as desktop_profile
from app.services import user_profile
from app.services.local_access_policy import require_local_access

router = APIRouter(prefix="/profile", tags=["Profile"], dependencies=[Depends(require_local_access)])


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Optional[str] = Field(default=None, max_length=120)
    avatar_url: Optional[str] = Field(default=None, max_length=1_000_000)  # Support data URLs or http URLs
    bio: Optional[str] = Field(default=None, max_length=500)


@router.get("")
async def get_profile(request: Request):
    """Read the user profile: saved name and avatar, with fallback to desktop account email/user id."""
    saved = user_profile.read_profile()

    # Read account email and profile if desktop profile is active
    email = None
    account_name = None
    account_avatar = None
    if desktop_profile.active():
        try:
            status = await account.get_manager().status()
            if status.get("signed_in"):
                email = status.get("email")
                account_name = status.get("name")
                account_avatar = status.get("avatar_url")
        except Exception:
            pass

    principal = principal_of(request.scope)
    user_id = str(principal.session_id) if (principal and principal.session_id) else (principal.label if principal and principal.label else "local")
    is_admin = principal.is_admin if principal else True

    # If email or name is not set via desktop account, check detected system identity
    sys_name, detected_email = user_profile.detect_system_identity()
    if not email:
        email = detected_email
    if not account_name and sys_name:
        account_name = sys_name

    # Priority for display name:
    # 1. User saved override
    # 2. Account name from suparagent.ai
    # 3. Email username part (e.g. jaiprasadkowru)
    # 4. System detected name
    # 5. "User"
    default_name = saved.get("name")
    if not default_name and account_name:
        default_name = account_name
    if not default_name and email:
        default_name = email.split("@")[0]
    if not default_name:
        default_name = "User"

    effective_avatar = saved.get("avatar_url") or account_avatar

    return {
        "name": default_name,
        "avatar_url": effective_avatar,
        "bio": saved.get("bio"),
        "email": email,
        "user_id": user_id,
        "is_admin": is_admin,
        "updated_at": saved.get("updated_at"),
    }


@router.put("")
async def update_profile(data: ProfileUpdate, request: Request):
    """Update profile display name, avatar, and/or bio."""
    saved = user_profile.write_profile(
        name=data.name,
        avatar_url=data.avatar_url,
        bio=data.bio,
    )
    return {
        "ok": True,
        **saved,
    }
