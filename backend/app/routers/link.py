from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import limiter, request_info
from app.core.config import settings
from app.db.session import get_db
from app.schemas.link import LinkCodeCreateResponse, LinkCodeStatusResponse
from app.services import link_service

router = APIRouter(
    prefix="/link",
    tags=["Link"],
)


def _require_rate(request: Request) -> str:
    source = request_info.client_source(request.scope)
    if not limiter.link_code_requests.allow(source):
        raise HTTPException(status_code=429, detail="Too many link codes requested. Try again shortly.")
    return source


@router.post("", response_model=LinkCodeCreateResponse)
async def create_link_code(request: Request, db: AsyncSession = Depends(get_db)):
    _require_rate(request)
    record = await link_service.create_code(db)
    return LinkCodeCreateResponse(
        code=record.code,
        expires_at=record.expires_at,
        bot_username=settings.TELEGRAM_BOT_USERNAME or None,
    )


@router.get("/{code}", response_model=LinkCodeStatusResponse)
async def get_link_code_status(code: str, db: AsyncSession = Depends(get_db)):
    record = await link_service.get_code(db, code.strip().upper())
    if record is None or (
        record.claimed_at is None and record.expires_at < datetime.now(timezone.utc)
    ):
        return LinkCodeStatusResponse(status="expired")

    if record.claimed_at is not None:
        return LinkCodeStatusResponse(status="claimed")

    return LinkCodeStatusResponse(status="pending")
