"""The cross-agent pending-work feed: what is waiting on the person, anywhere.

Read-only and owner-scoped. It derives the set from the existing approval and
needs-you queries; it never writes. A change stream on the same path family emits
one frame per change with a summary (not the full set).
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.routers.threads import get_runtime
from app.services import pending_work
from app.services.thread_runtime import ThreadRuntime

router = APIRouter(tags=["Pending work"])


@router.get("/pending-work")
async def read_pending_work(rt: ThreadRuntime = Depends(get_runtime)):
    """Every pending item for the owner, ordered by urgency. Idempotent: two
    calls with unchanged underlying state return identical bodies."""
    now = datetime.now(UTC)
    async with rt.session() as db:
        engines = await rt.engines.describe()
        from app.services import sentinel

        report = await sentinel.scan(rt.session, rt.owner_id, now=now)
        issues = [issue.public() for issue in report["issues"]]
        items = await pending_work.collect(
            db, rt.owner_id, now=now, engines=engines, issues=issues
        )
    return {"items": [item.public() for item in items]}


@router.get("/pending-work/stream")
async def stream_pending_work(rt: ThreadRuntime = Depends(get_runtime)):
    """Server-sent events for the pending-work set: one `pending_work.changed`
    frame per change, carrying a summary (the change and the new count), never
    the full set. Live only: after a disconnect, GET the feed again."""
    watcher = pending_work.hub.subscribe()

    async def frames():
        try:
            async for frame in pending_work.hub.frames(watcher):
                yield frame
        finally:
            pending_work.hub.unsubscribe(watcher)

    return StreamingResponse(
        frames(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )
