"""Require an app account in addition to the desktop launch capability."""

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.desktop import profile


async def signed_in() -> bool:
    if not profile.active():
        return True
    from app.desktop.account import DesktopAccountError, get_manager
    try:
        await get_manager().require_account()
        return True
    except DesktopAccountError:
        return False


class DesktopAccountMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        path = scope.get("path", "")
        protected = path.startswith(("/api/v1/", "/hooks/"))
        exempt = path.startswith("/api/v1/desktop-account/") or path in ("/api/v1/auth/status", "/api/v1/health")
        if scope["type"] not in ("http", "websocket") or not profile.active() or not protected or exempt:
            await self.app(scope, receive, send)
            return
        from app.desktop.account import DesktopAccountError, get_manager
        try:
            await get_manager().require_account()
        except DesktopAccountError as error:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            else:
                message = "Sign in to your app account to open this workspace." if error.status == 401 else "Could not check your app account. Check your connection and try again."
                response = JSONResponse({"detail": {"error_code": error.code, "message": message}}, status_code=error.status, headers={"Cache-Control": "no-store"})
                await response(scope, receive, send)
            return
        await self.app(scope, receive, send)
