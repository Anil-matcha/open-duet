"""Explicit desktop-only install and update actions for supported CLIs."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict

from app.desktop import profile
from app.services.local_access_policy import require_local_access
from app.services import engine_install

router = APIRouter(
    prefix="/engine-install",
    tags=["Engine install"],
    dependencies=[Depends(require_local_access)],
)


class InstallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["install", "update"]


def _guard(engine_id: str, request: Request) -> None:
    from app.auth.middleware import principal_of

    if engine_id not in engine_install.INSTALLERS:
        raise HTTPException(status_code=404, detail="Engine not found")
    if not profile.active():
        raise HTTPException(status_code=404, detail="Managed installs are available only in the desktop app.")
    principal = principal_of(request.scope)
    if principal is None or not principal.is_admin:
        raise HTTPException(status_code=403, detail={"error_code": "admin_required", "message": "Sign in as the owner to install an engine."})


@router.get("/{engine_id}/status")
async def get_install_status(engine_id: str, request: Request, response: Response):
    _guard(engine_id, request)
    response.headers["Cache-Control"] = "no-store"
    return engine_install.status(engine_id)


@router.post("/{engine_id}", status_code=202)
async def start_install(engine_id: str, payload: InstallRequest, request: Request, response: Response):
    _guard(engine_id, request)
    response.headers["Cache-Control"] = "no-store"
    try:
        return engine_install.begin(engine_id, payload.action).public()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@router.delete("/{engine_id}", status_code=204)
async def cancel_install(engine_id: str, request: Request, response: Response):
    _guard(engine_id, request)
    response.headers["Cache-Control"] = "no-store"
    await engine_install.cancel(engine_id)
