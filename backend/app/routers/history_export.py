"""Download a ZIP copy of the signed-in owner's local history.

The desktop account guard covers every `/api/v1/` path, so a signed-out desktop
profile cannot reach this route; the local access check keeps remote clients out.
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.routers.agents import get_runtime
from app.services import history_export
from app.services.local_access_policy import require_local_access
from app.services.thread_runtime import ThreadRuntime

router = APIRouter(prefix="/history", tags=["History"], dependencies=[Depends(require_local_access)])


def _chunks(handle, size: int = 64 * 1024):
    try:
        while chunk := handle.read(size):
            yield chunk
    finally:
        handle.close()


@router.get("/export")
async def export_history(rt: ThreadRuntime = Depends(get_runtime)):
    try:
        handle, size, name = await history_export.build_export(rt)
    except history_export.ExportError as error:
        raise HTTPException(error.status, detail={"error_code": error.code, "message": error.message}) from None
    return StreamingResponse(
        _chunks(handle),
        media_type="application/zip",
        headers={
            "Content-Length": str(size),
            "Content-Disposition": f'attachment; filename="{name}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
