"""Files attached to messages (docs/EVERYDAY.md)."""

import asyncio
import contextlib
import threading
from pathlib import Path

from fastapi import Request, APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel

from app.routers.threads import _thread_or_404, get_runtime
from app.services import attachments, audio_ingestion
from app.services.local_access_policy import require_local_access
from app.services.thread_runtime import ThreadRuntime

router = APIRouter(prefix="/threads", tags=["Attachments"], dependencies=[Depends(require_local_access)])

_READ_LIMIT = max(attachments.IMAGE_MAX_BYTES, audio_ingestion.MAX_BYTES) + 1


class AttachmentResponse(BaseModel):
    id: str
    name: str
    mime: str
    bytes: int
    # image | text | audio
    kind: str
    transcript: dict | None = None


def _refuse(error: attachments.AttachmentError) -> HTTPException:
    return HTTPException(status_code=error.status, detail={"error_code": error.code, "message": error.message})


@router.post("/{thread_id}/attachments", response_model=AttachmentResponse, status_code=201)
async def upload_attachment(
    thread_id: int, request: Request, file: UploadFile = File(...), consent_provider: str | None = Form(None), rt: ThreadRuntime = Depends(get_runtime)
):
    """Store one file for this conversation's next message. Send its id in
    `attachment_ids` with the turn."""
    await _thread_or_404(rt, thread_id)
    data = await file.read(_READ_LIMIT)
    if len(data) >= _READ_LIMIT:
        raise _refuse(
            attachments.AttachmentError(
                413, "too_large", f"{attachments.display_name(file.filename)} is over the 25 MB upload limit."
            )
        )
    try:
        transcript = None
        if (file.content_type and file.content_type.startswith("audio/")) or Path(file.filename or "").suffix.lower() in audio_ingestion.TYPES:
            transcript = await _while_connected(request, audio_ingestion.transcribe(attachments.display_name(file.filename), data, consent_provider))
        await _thread_or_404(rt, thread_id)
        saved = attachments.save(thread_id, file.filename, file.content_type, data, transcript=transcript)
    except attachments.AttachmentError as error:
        raise _refuse(error) from None
    return AttachmentResponse(**saved.public())


@router.get("/{thread_id}/attachments/{attachment_id}")
async def get_attachment(thread_id: int, attachment_id: str, rt: ThreadRuntime = Depends(get_runtime)):
    """The attached file's bytes. Images are shown inline; text is served as
    plain text. Never interpreted by the browser as a page."""
    await _thread_or_404(rt, thread_id)
    try:
        attachment, data = await run_in_threadpool(attachments.read_bytes, thread_id, attachment_id)
    except attachments.AttachmentError as error:
        raise _refuse(error) from None
    media = attachment.mime if attachment.kind in ("image", "audio") else "text/plain; charset=utf-8"
    return Response(
        content=data,
        media_type=media,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "Cache-Control": "private, max-age=3600",
        },
    )


@router.get("/audio/capabilities")
async def audio_capabilities():
    return audio_ingestion.capabilities()


class AudioURLRequest(BaseModel):
    url: str
    consent_provider: str


@router.post("/{thread_id}/attachments/audio-url", response_model=AttachmentResponse, status_code=201)
async def import_audio_url(thread_id: int, body: AudioURLRequest, request: Request, rt: ThreadRuntime = Depends(get_runtime)):
    await _thread_or_404(rt, thread_id)
    try:
        audio_ingestion.require_consent(body.consent_provider)
        cancelled = threading.Event()
        try:
            name, data = await _while_connected(request, asyncio.to_thread(audio_ingestion.fetch_url, body.url, cancelled))
        finally:
            cancelled.set()
        name = attachments.display_name(name)
        transcript = await _while_connected(request, audio_ingestion.transcribe(name, data, body.consent_provider))
        transcript["source_url"] = body.url
        await _thread_or_404(rt, thread_id)
        saved = attachments.save(thread_id, name, None, data, transcript=transcript)
    except attachments.AttachmentError as error:
        raise _refuse(error) from None
    return AttachmentResponse(**saved.public())


async def _while_connected(request: Request, operation):
    """Cancel outbound provider requests when the user disconnects; never save partial output."""
    task = asyncio.create_task(operation)
    try:
        while not task.done():
            await asyncio.wait({task}, timeout=0.1)
            if await request.is_disconnected():
                raise attachments.AttachmentError(499, "audio_cancelled", "Audio processing was cancelled. No attachment was stored.")
        return await task
    finally:
        if not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
