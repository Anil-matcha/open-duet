"""Watch and take over the browser on this machine (computers/local_browser_viewer.py).

Same lease, heartbeat and single-use ticket flow as the desktop viewer (routers/computer_viewer.py), keyed by
agent: the browser holds under the agent's negative id and writes its hold to the `browser-<agent id>` folder.
"""
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from app.auth.middleware import principal_of
from app.computers import local_browser_viewer as live
from app.computers.service import local_browser_enabled
from app.db.models.auth import AuthSession
from app.routers.computer_viewer import identity, viewers
from app.routers.computers import _agent_or_404, _error, get_runtime
from app.services.local_access_policy import LocalAccessDenied, get_local_access_policy, require_local_access
from app.services.thread_runtime import ThreadRuntime

router = APIRouter(tags=["Browser viewer"])


class BrowserControl(BaseModel):
    action: Literal["take", "release"]
    lease_id: str | None = Field(default=None, min_length=64, max_length=64)


class BrowserBeat(BaseModel):
    lease_id: str = Field(min_length=64, max_length=64)


def _port(rt: ThreadRuntime, agent_id: int) -> int:
    if not local_browser_enabled():
        raise _error(409, "browser_off", "The browser is off on this machine.")
    port = live.debug_port(live.state_folder(rt.computers.state_dir(), agent_id))
    if port is None:
        raise _error(409, "browser_not_running", "The browser opens when the agent first uses it in a turn. Ask the agent to open a page, then try again.")
    return port


@router.post("/agents/{agent_id}/browser/control", dependencies=[Depends(require_local_access)])
async def browser_control(agent_id: int, payload: BrowserControl, request: Request, rt: ThreadRuntime = Depends(get_runtime)):
    service, key = rt.computers, -agent_id
    await _agent_or_404(rt, agent_id)
    service.expire_control()
    if payload.action == "release":
        released = service.release_control(key, payload.lease_id)
        if released:
            await viewers(service).close_computer(key)
        return {**service.control.snapshot(key), "released": released}
    _port(rt, agent_id)
    snapshot, owned, acquired, token = service.control.take(key, payload.lease_id)
    result = {**snapshot, "owned": owned}
    if owned:
        await service._call(service.write_control, key)
        lease = token or payload.lease_id
        try:
            result.update(ticket=viewers(service).issue(key, lease, identity(request)), ticket_expires_in=30)
        except ValueError as exc:
            raise _error(429, "too_many_viewers", str(exc)) from None
        if acquired:
            result["lease_id"] = token
    return result


@router.post("/agents/{agent_id}/browser/control/heartbeat", dependencies=[Depends(require_local_access)])
async def browser_heartbeat(agent_id: int, payload: BrowserBeat, rt: ThreadRuntime = Depends(get_runtime)):
    service, key = rt.computers, -agent_id
    await _agent_or_404(rt, agent_id)
    service.expire_control()
    if not service.control.heartbeat(key, payload.lease_id):
        raise _error(409, "lease_lost", "This view no longer holds control.")
    await service._call(service.write_control, key)
    return Response(status_code=204)


@router.websocket("/agents/{agent_id}/browser/viewer")
async def browser_viewer(websocket: WebSocket, agent_id: int, rt: ThreadRuntime = Depends(get_runtime), policy=Depends(get_local_access_policy)):
    service, key = rt.computers, -agent_id
    manager = viewers(service)
    try:
        policy.authorize(websocket)
        ticket = manager.consume(websocket.query_params.get("ticket", ""), key, identity(websocket))
        if not ticket:
            await websocket.close(code=4403)
            return
        await _agent_or_404(rt, agent_id)
        service.expire_control()
        if not service.control.owns(key, ticket.lease):
            await websocket.close(code=4409)
            return
        port = _port(rt, agent_id)
        ident = manager.reserve(key, websocket)
        if ident is None:
            await websocket.close(code=4429)
            return
    except (LocalAccessDenied, Exception):  # noqa: BLE001  (HTTP errors cannot be sent on a WebSocket)
        await websocket.close(code=1008)
        return
    service.control.viewer_opened(key, ident)
    principal = principal_of(websocket.scope)
    folder = live.state_folder(service.state_dir(), agent_id)

    async def valid() -> bool:
        service.expire_control()
        if not service.control.owns(key, ticket.lease):
            return False
        if principal and principal.session_id:
            async with rt.session() as db:
                session = await db.get(AuthSession, principal.session_id)
                if session is None or session.revoked_at or session.expires_at <= datetime.now(UTC):
                    service.release_control(key, ticket.lease)
                    return False
        if live.debug_port(folder) != port:  # the browser ended, or restarted on another port
            service.release_control(key, ticket.lease)
            return False
        return True

    try:
        await websocket.accept()
        await live.serve(websocket, port, valid)
    except (WebSocketDisconnect, OSError):
        pass
    except Exception:  # noqa: BLE001  (a page that went away mid-stream ends the view, not the app)
        pass
    finally:
        manager.active.pop(ident, None)
        service.control.viewer_closed(key, ident)
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
