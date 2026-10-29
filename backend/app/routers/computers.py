"""Agent computers (docs/COMPUTERS.md): an isolated machine per agent, where its
turns run their commands and file edits instead of on this machine.

Making and starting a computer runs Docker on this machine, so the local access
check covers the whole router, as for agents and threads.

Errors a client acts on carry a machine-readable code:
`{"detail": {"error_code": "...", "message": "..."}}`.
"""

import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from app.computers import docker_cli, grants, screen, mcp_server
from app.computers.provider import ComputerError, Health, Status
from app.computers.service import ComputerNotFound, ComputerService
from app.db.models import Agent, Computer
from app.desktop import computer_capabilities
from app.schemas.computer import (
    ComputerCreateRequest,
    ComputerDeleteResponse,
    ComputerHealthResponse,
    ComputerResponse,
    ComputerSummary,
    ComputerUpdateRequest,
    LastCommandResponse,
)
from app.services import agent_store, local_claude_runner
from app.services.local_access_policy import require_local_access
from app.services.thread_runtime import ThreadRuntime
from app.services.thread_runtime import runtime as default_runtime

router = APIRouter(tags=["Computers"], dependencies=[Depends(require_local_access)])

# Which HTTP status a provider refusal becomes.
_STATUS = {
    "capture_busy": 429,
    "docker_missing": 503,
    "docker_unavailable": 503,
    "docker_timeout": 503,
    "docker_failed": 502,
    "unknown_provider": 422,
    "invalid_computer": 422,
    "boat_key_missing": 409,
    "boat_key_unavailable": 503,
    "boat_auth_failed": 401,
    "boat_timeout": 503,
    "boat_unavailable": 503,
    "boat_invalid_url": 422,
    "boat_provisioning": 503,
    "boat_stopping": 503,
    "boat_computer_missing": 404,
    "boat_computer_unavailable": 409,
    "boat_plan_restricted": 403,
    "boat_rate_limited": 429,
    "boat_setup_failed": 502,
    "boat_create_failed": 502,
    "boat_invalid_response": 502,
    "boat_command_timeout": 504,
    "boat_screen_failed": 502,
    "desktop_not_ready": 503,
}


def get_runtime() -> ThreadRuntime:
    return default_runtime


def _service(rt: ThreadRuntime) -> ComputerService:
    return rt.computers


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"error_code": code, "message": message})


def _refused(exc: ComputerError) -> HTTPException:
    return _error(_STATUS.get(exc.code, 409), exc.code, str(exc))


def summary(service: ComputerService, computer: Computer) -> ComputerSummary:
    return ComputerSummary(
        id=computer.id,
        provider=computer.provider,
        kind=computer.kind,
        name=docker_cli.container_name(service.instance(), computer.id),
        image=computer.image,
        network=computer.network,
        state=computer.state,
    )


def _health(health: Health | None) -> ComputerHealthResponse | None:
    if health is None:
        return None
    return ComputerHealthResponse(
        provider=health.provider, available=health.available, version=health.version, error=health.error,
        hosted=health.hosted, browser_local=health.browser_local,
    )


def respond(
    service: ComputerService, computer: Computer, *, health: Health | None = None, status: Status | None = None
) -> ComputerResponse:
    last = service.last_command(computer.id)
    return ComputerResponse(
        **summary(service, computer).model_dump(),
        agent_id=computer.agent_id,
        image_pinned=docker_cli.image_is_pinned(computer.image),
        image_id=computer.image_id,
        cpus=computer.cpu_millis / 1000,
        memory_mb=computer.memory_mb,
        pids_limit=computer.pids_limit,
        idle_minutes=computer.idle_minutes,
        auto_start=computer.auto_start,
        browser_enabled=computer.browser_enabled,
        live_state=status.state if status else None,
        needs_recreate=bool(status and status.needs_recreate),
        problem=status.problem if status else None,
        last_error=computer.last_error,
        workspace_path=computer.workspace_path,
        guest_workspace=getattr(service.provider(computer.provider), "guest_workspace", docker_cli.GUEST_WORKSPACE),
        container_id=computer.container_id,
        busy=service.busy(computer.id),
        screen_busy=computer.kind == "desktop" and service.screen_busy(computer.id),
        desktop_ready=bool(status and status.desktop_ready),
        last_used_at=computer.last_used_at,
        last_command=LastCommandResponse(**{k: v for k, v in last.items() if k in LastCommandResponse.model_fields}) if last else None,
        health=_health(health),
        created_at=computer.created_at,
        updated_at=computer.updated_at,
    )


async def _computer_or_404(service: ComputerService, computer_id: int) -> Computer:
    try:
        return await service.get(computer_id)
    except ComputerNotFound:
        raise HTTPException(status_code=404, detail="Computer not found") from None


async def _agent_or_404(rt: ThreadRuntime, agent_id: int) -> Agent:
    async with rt.session() as db:
        agent = await agent_store.get_agent(db, agent_id)
    if agent is None or agent.owner_id != rt.owner_id:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


def agent_workspace(agent: Agent) -> str:
    """The folder a thread of this agent gets, spelled as the thread stores it."""
    if agent.workspace_path:
        folder = Path(agent.workspace_path)
    else:
        folder = local_claude_runner.workspace_dir() / "agents" / str(agent.id)
        folder.mkdir(parents=True, exist_ok=True)
    return str(folder.resolve())


async def _live(service: ComputerService, computer: Computer) -> ComputerResponse:
    health, status = await service.live_status(computer)
    try:
        computer = await service.get(computer.id)
    except ComputerNotFound:
        raise HTTPException(status_code=404, detail="Computer not found") from None
    return respond(service, computer, health=health, status=status)


# --- health and listing ------------------------------------------------------------------


@router.get("/computers/health", response_model=ComputerHealthResponse)
async def computers_health(rt: ThreadRuntime = Depends(get_runtime)):
    """Whether Docker answers. Never fails: a missing or stopped Docker is
    reported, so a page can say so and keep working."""
    return _health(await _service(rt).health(fresh=True))


@router.get("/computers", response_model=list[ComputerResponse])
async def list_computers(rt: ThreadRuntime = Depends(get_runtime)):
    service = _service(rt)
    return [respond(service, computer) for computer in await service.list_all()]


@router.get("/computers/{computer_id}", response_model=ComputerResponse)
async def get_computer(computer_id: int, live: bool = True, rt: ThreadRuntime = Depends(get_runtime)):
    """With `live` (the default) the provider is asked what it sees now."""
    service = _service(rt)
    computer = await _computer_or_404(service, computer_id)
    return await _live(service, computer) if live else respond(service, computer)


# --- an agent's computer -----------------------------------------------------------------


@router.get("/agents/{agent_id}/computer", response_model=ComputerResponse)
async def get_agent_computer(agent_id: int, rt: ThreadRuntime = Depends(get_runtime)):
    await _agent_or_404(rt, agent_id)
    service = _service(rt)
    computer = await service.for_agent(agent_id)
    if computer is None:
        raise _error(404, "no_computer", "This agent has no computer.")
    return await _live(service, computer)


@router.post("/agents/{agent_id}/computer", response_model=ComputerResponse, status_code=201)
async def create_agent_computer(
    agent_id: int, payload: ComputerCreateRequest, response: Response, rt: ThreadRuntime = Depends(get_runtime)
):
    """Give the agent a computer. Idempotent: an agent that already has one
    gets it back unchanged (200). From then on the agent's turns run their
    tools in it, and its host tools are off. With `start`, the machine is
    made and started now. Only an agent whose engine can run its tools in a
    computer can have one (409 `engine_without_computers`)."""
    agent = await _agent_or_404(rt, agent_id)
    try:
        supports = rt.engines.capabilities(agent.provider).computers
    except Exception:  # noqa: BLE001  (an engine this app no longer has)
        supports = False
    if not supports:
        raise _error(
            409,
            "engine_without_computers",
            f"This agent's engine ({agent.provider}) cannot run its tools in a computer. "
            "Computers work with Claude for now.",
        )
    service = _service(rt)
    settings = payload.model_dump(exclude={"start", "image"}, exclude_none=True)
    provider = settings.get("provider", "docker")
    try:
        computer, created = await service.create_for_agent(
            agent, workspace=agent_workspace(agent) if provider == "docker" else None, image=payload.image, **settings
        )
        if not created:
            response.status_code = 200
        if payload.start:
            computer = await service.start(computer.id)
    except ValueError as exc:
        raise _error(422, "invalid_computer", str(exc)) from None
    except ComputerError as exc:
        raise _refused(exc) from None
    return await _live(service, computer)


# --- one computer ------------------------------------------------------------------------


@router.patch("/computers/{computer_id}", response_model=ComputerResponse)
async def update_computer(computer_id: int, payload: ComputerUpdateRequest, rt: ThreadRuntime = Depends(get_runtime)):
    """CPU, memory and process limits apply to a live machine at once; the
    image and network on the next recreate (`needs_recreate` says so)."""
    service = _service(rt)
    await _computer_or_404(service, computer_id)
    try:
        computer = await service.update_config(computer_id, **payload.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise _error(422, "invalid_computer", str(exc)) from None
    except ComputerError as exc:
        raise _refused(exc) from None
    except ComputerNotFound:
        raise HTTPException(status_code=404, detail="Computer not found") from None
    return await _live(service, computer)


async def _lifecycle(rt: ThreadRuntime, computer_id: int, step) -> ComputerResponse:
    service = _service(rt)
    await _computer_or_404(service, computer_id)
    try:
        computer = await step(service)
    except ComputerError as exc:
        raise _refused(exc) from None
    except ComputerNotFound:
        raise HTTPException(status_code=404, detail="Computer not found") from None
    return await _live(service, computer)


@router.post("/computers/{computer_id}/prepare-image", response_model=ComputerResponse)
async def prepare_image(computer_id: int, rt: ThreadRuntime = Depends(get_runtime)):
    """Download the computer's image. The only step that downloads anything."""
    return await _lifecycle(rt, computer_id, lambda s: s.prepare_image(computer_id))


@router.post("/computers/{computer_id}/start", response_model=ComputerResponse)
async def start_computer(computer_id: int, rt: ThreadRuntime = Depends(get_runtime)):
    """Make the machine if it does not exist yet (from an image already on this
    computer), then start it."""
    return await _lifecycle(rt, computer_id, lambda s: s.start(computer_id))


@router.post("/computers/{computer_id}/stop", response_model=ComputerResponse)
async def stop_computer(computer_id: int, rt: ThreadRuntime = Depends(get_runtime)):
    return await _lifecycle(rt, computer_id, lambda s: s.stop(computer_id))


@router.post("/computers/{computer_id}/recreate", response_model=ComputerResponse)
async def recreate_computer(computer_id: int, rt: ThreadRuntime = Depends(get_runtime)):
    """Remove the machine and make it again from the current settings and the
    agent's current folder. Files in the folder stay; everything else inside
    the machine is lost."""
    service = _service(rt)
    computer = await _computer_or_404(service, computer_id)
    async with rt.session() as db:
        agent = await agent_store.get_agent(db, computer.agent_id)
    workspace = agent_workspace(agent) if agent is not None and computer.provider == "docker" else None
    return await _lifecycle(rt, computer_id, lambda s: s.recreate(computer_id, workspace=workspace))


@router.delete("/computers/{computer_id}", response_model=ComputerDeleteResponse)
async def delete_computer(computer_id: int, rt: ThreadRuntime = Depends(get_runtime)):
    """Remove the computer. The agent's turns go back to running on this
    machine. Files in its folder are never touched."""
    service = _service(rt)
    await _computer_or_404(service, computer_id)
    try:
        removed = await service.delete(computer_id)
    except ComputerError as exc:
        raise _refused(exc) from None
    except ComputerNotFound:
        raise HTTPException(status_code=404, detail="Computer not found") from None
    return ComputerDeleteResponse(removed=removed)


@router.get("/computers/{computer_id}/screenshot")
async def computer_screenshot(computer_id: int, rt: ThreadRuntime = Depends(get_runtime)):
    service = _service(rt)
    computer = await _computer_or_404(service, computer_id)
    try:
        data = await service.screenshot(computer)
    except ComputerError as exc:
        raise _refused(exc) from None
    media_type = "image/png" if data.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg"
    return Response(content=data, media_type=media_type, headers={"Cache-Control": "private, no-store"})


@router.post("/computers/{computer_id}/boat-desktop-url")
async def boat_desktop_url(computer_id: int, request: Request, rt: ThreadRuntime = Depends(get_runtime)):
    """Return a provider viewing URL only while the person holds the local
    desktop control lease. Never store or log the secret-bearing URL."""
    payload = await request.json()
    lease_id = payload.get("lease_id") if isinstance(payload, dict) else None
    if not isinstance(lease_id, str) or not rt.computers.control.owns(computer_id, lease_id):
        raise HTTPException(status_code=409, detail={"error_code": "lease_lost", "message": "Take control first."})
    computer = await _computer_or_404(rt.computers, computer_id)
    if computer.provider != "boat" or computer.kind != "desktop":
        raise HTTPException(status_code=409, detail={"error_code": "not_a_cloud_desktop"})
    try:
        url = await rt.computers._call(rt.computers.provider("boat").desktop_url, rt.computers.spec(computer))
    except ComputerError as exc:
        raise _refused(exc) from None
    return JSONResponse({"url": url}, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.post("/computers/{computer_id}/provider-tool")
async def provider_tool(computer_id: int, request: Request, rt: ThreadRuntime = Depends(get_runtime)):
    """Narrow local bridge for a cloud MCP child. A matching computer-turn
    capability and one-use approval permit are both required."""
    token = request.headers.get("x-open-dots-computer-capability", "")
    turn_id = computer_capabilities.allows(computer_id, token)
    grants_dir = computer_capabilities.grants_for(computer_id, token)
    if turn_id is None or grants_dir is None:
        raise HTTPException(status_code=401, detail={"error_code": "computer_capability_required"})
    if turn_id not in rt.computers._leases.get(computer_id, set()):
        raise HTTPException(status_code=401, detail={"error_code": "computer_turn_ended"})
    try:
        computer = await _computer_or_404(rt.computers, computer_id)
    except HTTPException:
        raise
    if computer.provider != "boat":
        raise HTTPException(status_code=404, detail={"error_code": "computer_not_found"})
    raw = await request.body()
    if len(raw) > 2_100_000:
        raise HTTPException(status_code=413, detail={"error_code": "computer_tool_too_large"})
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail={"error_code": "invalid_computer_tool"}) from None
    if not isinstance(payload, dict) or set(payload) != {"name", "arguments"}:
        raise HTTPException(status_code=400, detail={"error_code": "invalid_computer_tool"})
    name, arguments = payload.get("name"), payload.get("arguments")
    allowed = name in mcp_server._TOOL_NAMES or (computer.kind == "desktop" and name in screen.DEFINITIONS)
    if not allowed or not isinstance(arguments, dict):
        raise HTTPException(status_code=400, detail={"error_code": "invalid_computer_tool"})
    problem = screen.validate(name, arguments) if name in screen.DEFINITIONS else mcp_server._argument_problem(name, arguments)
    if problem:
        raise HTTPException(status_code=422, detail={"error_code": "invalid_computer_tool", "message": problem})
    if not grants.consume(grants_dir, name, arguments):
        raise HTTPException(status_code=403, detail={"error_code": "computer_tool_not_approved"})
    try:
        result = await rt.computers._call(
            rt.computers.provider("boat").tool, rt.computers.spec(computer), name, arguments
        )
    except ComputerError as exc:
        raise _refused(exc) from None
    if not isinstance(result, dict) or not isinstance(result.get("content"), list):
        raise HTTPException(status_code=502, detail={"error_code": "invalid_computer_tool_response"})
    return result
