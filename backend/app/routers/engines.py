"""Engines: which agent engines this app can run conversations on (Claude,
Codex, an ACP agent, an OpenAI-compatible endpoint), whether each is usable
now, its models and what it can do (docs/ENGINES.md).

Status checks run the engine's CLI or reach its endpoint, so the local access
check covers the whole router, as for threads and agents. A check that fails
or hangs reports the engine as unavailable with the reason; it never fails
the request.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from contextlib import nullcontext
import shutil

from app.schemas.engine import EngineConfigRequest, EngineResponse
from app.services import engine_config
from app.services.local_access_policy import require_local_access
from app.services.thread_runtime import ThreadRuntime
from app.services.thread_runtime import runtime as default_runtime

router = APIRouter(
    prefix="/engines",
    tags=["Engines"],
    dependencies=[Depends(require_local_access)],
)


def get_runtime() -> ThreadRuntime:
    return default_runtime


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"error_code": code, "message": message})


def _configurable(rt: ThreadRuntime, engine_id: str):
    adapter = rt.adapters.get(engine_id)
    if adapter is None:
        raise HTTPException(status_code=404, detail="Engine not found")
    if not getattr(adapter, "needs_config", False) or not callable(getattr(adapter, "validate_config", None)):
        raise _error(409, "not_configurable", "This engine has nothing to configure here.")
    return adapter


@router.get("", response_model=list[EngineResponse])
async def list_engines(refresh: bool = False, rt: ThreadRuntime = Depends(get_runtime)):
    """Every engine, with status, models and capabilities. Results are kept
    for a few seconds; `refresh=true` checks again now."""
    return await rt.engines.describe(refresh=refresh)


@router.get("/{engine_id}", response_model=EngineResponse)
async def get_engine(engine_id: str, refresh: bool = False, rt: ThreadRuntime = Depends(get_runtime)):
    if engine_id not in rt.adapters:
        raise HTTPException(status_code=404, detail="Engine not found")
    return (await rt.engines.describe(refresh=refresh, only=engine_id))[0]


@router.put("/{engine_id}/config", response_model=EngineResponse)
async def save_engine_config(
    engine_id: str, payload: EngineConfigRequest, rt: ThreadRuntime = Depends(get_runtime)
):
    """Save the engine's configuration (encrypted, like every credential) and
    check the engine again. The response never includes a key."""
    adapter = _configurable(rt, engine_id)
    if engine_id == "antigravity" and (adapter.lock.locked() or (adapter.task and not adapter.task.done())):
        raise _error(409, "engine_busy", "Wait for Antigravity to finish before changing settings.")
    async with adapter.lock if engine_id == "antigravity" else nullcontext():
        return await _save_config(engine_id, payload, rt, adapter)


async def _save_config(engine_id, payload, rt, adapter):
    fields = getattr(adapter, "config_fields", None)
    if fields is not None:
        allowed = {field["name"] for field in fields}
        # Clearing a secret and setting the context budget are protocol
        # controls rather than text inputs in the generated form.
        if "api_key" in allowed:
            allowed.add("clear_api_key")
        if getattr(adapter, "kind", None) == "api":
            allowed.add("context_tokens")
        if payload.model_fields_set - allowed:
            raise _error(422, "invalid_engine_config", "This engine does not accept one or more supplied fields.")
    current = await rt.engine_config(engine_id)
    try:
        config = adapter.validate_config(payload.model_dump(exclude_none=True), current)
    except ValueError as exc:
        raise _error(422, "invalid_engine_config", str(exc)) from None
    async with rt.session() as db:
        await engine_config.save(db, rt.owner_id, engine_id, config)
    rt.engines.forget(engine_id)
    return (await rt.engines.describe(refresh=True, only=engine_id))[0]


@router.delete("/{engine_id}/config", status_code=204)
async def delete_engine_config(engine_id: str, rt: ThreadRuntime = Depends(get_runtime)):
    """Forget the engine's configuration, key included."""
    adapter = _configurable(rt, engine_id)
    if engine_id == "antigravity":
        if adapter.lock.locked() or (adapter.task and not adapter.task.done()):
            raise _error(409, "engine_busy", "Stop the conversation or cancel setup before removing the account.")
    async with adapter.lock if engine_id == "antigravity" else nullcontext():
        if engine_id == "antigravity":
            from app.services.antigravity_adapter import profile_dir

            config = await rt.engine_config(engine_id)
            if config and config.get("profile"):
                path = profile_dir(config)
                if path.exists():
                    shutil.rmtree(path)
        async with rt.session() as db:
            await engine_config.remove(db, rt.owner_id, engine_id)
        adapter.config = None
        rt.engines.forget(engine_id)


def _antigravity(rt):
    from app.services.antigravity_adapter import AntigravityAdapter

    adapter = rt.adapters.get("antigravity")
    if not isinstance(adapter, AntigravityAdapter):
        raise _error(404, "engine_unavailable", "Antigravity is disabled on this server.")
    return adapter


@router.post("/antigravity/setup/{action}", status_code=202)
async def setup_antigravity(action: str, response: Response, rt: ThreadRuntime = Depends(get_runtime)):
    from app.services import antigravity_runtime

    adapter = _antigravity(rt)
    response.headers["Cache-Control"] = "no-store"
    await rt.prepare_adapter("antigravity", adapter)
    async def save(config):
        async with rt.session() as db:
            await engine_config.save(db, rt.owner_id, "antigravity", config)
        rt.engines.forget("antigravity")

    async def work():
        if action == "install":
            def update_progress(percent, downloaded=0, total=0, detail=None):
                if adapter.operation:
                    adapter.operation["progress"] = percent
                    if detail:
                        adapter.operation["detail"] = detail
                    elif total > 0:
                        mb_down = downloaded / (1024 * 1024)
                        mb_tot = total / (1024 * 1024)
                        adapter.operation["detail"] = f"Downloading official Google runtime ({mb_down:.1f} MB / {mb_tot:.1f} MB)..."

            await antigravity_runtime.install(adapter.validate_runtime, on_progress=update_progress)
        elif action == "sign_in":
            if not antigravity_runtime.installed():
                raise ValueError("Install Antigravity first.")
            await adapter.sign_in(save)
        else:
            await adapter.discover(adapter.config or {})
        rt.engines.forget("antigravity")

    if action not in {"install", "sign_in", "models"}:
        raise HTTPException(status_code=404, detail="Unknown setup action")
    try:
        return adapter.start_operation(action, work)
    except ValueError as exc:
        raise _error(409, "engine_busy", str(exc)) from None


@router.get("/antigravity/setup/status")
async def antigravity_setup_status(response: Response, rt: ThreadRuntime = Depends(get_runtime)):
    response.headers["Cache-Control"] = "no-store"
    return _antigravity(rt).operation


@router.delete("/antigravity/setup", status_code=204)
async def cancel_antigravity_setup(rt: ThreadRuntime = Depends(get_runtime)):
    await _antigravity(rt).close()


@router.post("/antigravity/callback", status_code=204)
async def antigravity_callback(request: Request, rt: ThreadRuntime = Depends(get_runtime)):
    try:
        payload = await request.json()
        operation_id, callback = payload["operation_id"], payload["callback_url"]
        if not isinstance(operation_id, str) or len(operation_id) > 32 or not isinstance(callback, str) or len(callback) > 16384:
            raise ValueError
        await _antigravity(rt).complete_callback(operation_id, callback)
    except (ValueError, OSError, TypeError, KeyError):
        raise _error(422, "invalid_google_callback", "This sign-in response is invalid or expired. Start sign-in again.") from None


def _login_owner(request: Request) -> str:
    from app.auth.middleware import principal_of

    principal = principal_of(request.scope)
    if principal is None or not principal.is_admin:
        raise _error(403, "admin_required", "Sign in as the owner to connect an engine.")
    return f"{principal.kind}:{principal.session_id}"


@router.post("/{engine_id}/logout", status_code=204)
async def logout_engine(engine_id: str, request: Request, response: Response, rt: ThreadRuntime = Depends(get_runtime)):
    from app.services import engine_logout
    from app.services.codex_login import LoginError
    from app.services.codex_adapter import resolve_codex_executable
    from app.services.local_claude_runner import resolve_claude_executable

    _login_owner(request)
    response.headers["Cache-Control"] = "no-store"
    if engine_id not in {"claude", "codex"}:
        raise HTTPException(status_code=404, detail="Engine not found")
    if rt._closing or engine_id not in rt.adapters:
        raise _error(409, "engine_unavailable", "This engine is unavailable on this server.")
    executable = (resolve_codex_executable if engine_id == "codex" else resolve_claude_executable)()
    if executable is None:
        raise _error(409, "engine_unavailable", "Install the engine CLI on the server first.")
    # A running turn can switch to a fallback engine. Reserve before yielding,
    # and include turns still preparing readiness/context, before _runs exists.
    if rt._closing or rt._runs or rt._starting_turns or rt._account_changing:
        raise _error(409, "engine_busy", "Stop running conversations before signing out.")
    rt._account_changing = True
    try:
        await engine_logout.logout(getattr(rt, f"{engine_id}_login"), engine_id, executable)
    except (LoginError, OSError):
        raise _error(409, "logout_unavailable", "Could not confirm sign-out. Finish pending sign-in, check the CLI and any configured API key, then try again.") from None
    finally:
        rt._account_changing = False
        rt.engines.forget(engine_id)


@router.post("/codex/login", status_code=202)
async def start_codex_login(request: Request, response: Response, rt: ThreadRuntime = Depends(get_runtime)):
    from app.services.codex_adapter import resolve_codex_executable
    from app.services.codex_login import LoginError

    owner = _login_owner(request)
    response.headers["Cache-Control"] = "no-store"
    if rt._closing or "codex" not in rt.adapters:
        raise _error(409, "engine_unavailable", "Codex is unavailable on this server.")
    executable = resolve_codex_executable()
    if executable is None:
        raise _error(409, "engine_unavailable", "Install the Codex CLI on the server first.")
    try:
        return await rt.codex_login.start(owner, executable)
    except (LoginError, OSError):
        raise _error(409, "login_unavailable", "Codex sign-in is busy or its account folder is unavailable. Finish any pending sign-in and try again.") from None


@router.get("/codex/login/{flow_id}")
async def codex_login_status(flow_id: str, request: Request, response: Response, rt: ThreadRuntime = Depends(get_runtime)):
    response.headers["Cache-Control"] = "no-store"
    try:
        result = rt.codex_login.view(_login_owner(request), flow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Sign-in not found") from None
    if result["phase"] == "succeeded":
        rt.engines.forget("codex")
    return result


@router.delete("/codex/login/{flow_id}", status_code=204)
async def cancel_codex_login(flow_id: str, request: Request, rt: ThreadRuntime = Depends(get_runtime)):
    try:
        await rt.codex_login.cancel(_login_owner(request), flow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Sign-in not found") from None


@router.post("/claude/login", status_code=202)
async def start_claude_login(request: Request, response: Response, rt: ThreadRuntime = Depends(get_runtime)):
    from app.services.local_claude_runner import resolve_claude_executable
    from app.services.codex_login import LoginError

    owner = _login_owner(request)
    response.headers["Cache-Control"] = "no-store"
    if rt._closing or "claude" not in rt.adapters:
        raise _error(409, "engine_unavailable", "Claude is unavailable on this server.")
    executable = resolve_claude_executable()
    if executable is None:
        raise _error(409, "engine_unavailable", "Install the Claude CLI on the server first.")
    try:
        return await rt.claude_login.start(owner, executable)
    except (LoginError, OSError):
        raise _error(409, "login_unavailable", "Claude sign-in is busy or its account folder is unavailable. Finish any pending sign-in and try again.") from None


@router.get("/claude/login/{flow_id}")
async def claude_login_status(flow_id: str, request: Request, response: Response, rt: ThreadRuntime = Depends(get_runtime)):
    response.headers["Cache-Control"] = "no-store"
    try:
        result = rt.claude_login.view(_login_owner(request), flow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Sign-in not found") from None
    if result["phase"] == "succeeded":
        rt.engines.forget("claude")
    return result


@router.post("/claude/login/{flow_id}/code", status_code=204)
async def complete_claude_login(flow_id: str, request: Request, response: Response, rt: ThreadRuntime = Depends(get_runtime)):
    import json
    from app.services.codex_login import LoginError

    owner = _login_owner(request)
    response.headers["Cache-Control"] = "no-store"
    try:
        # Avoid validation errors that echo a pasted authorization code.
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 4096:
                raise ValueError
        payload = json.loads(body)
        if not isinstance(payload, dict) or set(payload) != {"code"} or not isinstance(payload["code"], str):
            raise ValueError
        await rt.claude_login.complete(owner, flow_id, payload["code"])
    except KeyError:
        raise HTTPException(status_code=404, detail="Sign-in not found") from None
    except (ValueError, TypeError, LoginError):
        raise _error(422, "invalid_login_code", "The code or sign-in is invalid or already submitted. Check the code, or start sign-in again.") from None


@router.delete("/claude/login/{flow_id}", status_code=204)
async def cancel_claude_login(flow_id: str, request: Request, rt: ThreadRuntime = Depends(get_runtime)):
    try:
        await rt.claude_login.cancel(_login_owner(request), flow_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Sign-in not found") from None
