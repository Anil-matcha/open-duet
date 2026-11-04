"""Version and updates API router for Open Duet (BL-64).

Provides endpoints to inspect running app version, git commit, installation mode,
and check if newer releases are available on GitHub with the exact update command.
"""

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.services import version_service

router = APIRouter(prefix="/version", tags=["Version"])


class VersionResponse(BaseModel):
    current_version: str
    commit: str | None = None
    latest_version: str | None = None
    update_available: bool = False
    install_kind: str
    update_command: str
    release_notes_url: str


@router.get("", response_model=VersionResponse)
async def read_version(refresh: bool = Query(default=False)):
    """Returns running version, update availability, and update command."""
    info = await version_service.get_version_info(force_refresh=refresh)
    return info.to_dict()

