"""Multi-step workflow endpoints with condition evaluation, branching, and approval checkpoints."""
from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.routers.threads import get_runtime
from app.schemas.workflow import (
    WorkflowApprovalDecisionRequest,
    WorkflowCreateRequest,
    WorkflowResponse,
    WorkflowRunCreateRequest,
    WorkflowRunResponse,
    WorkflowUpdateRequest,
)
from app.services.local_access_policy import require_local_access
from app.services.workflow_service import WorkflowService

router = APIRouter(prefix="/workflows", tags=["Workflows"], dependencies=[Depends(require_local_access)])


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"error_code": code, "message": message})


@router.get("", response_model=list[WorkflowResponse])
async def list_workflows(rt=Depends(get_runtime)):
    async with rt.session() as db:
        workflows = await WorkflowService.list_workflows(db, rt.owner_id)
        return [WorkflowResponse.model_validate(w) for w in workflows]


@router.post("", response_model=WorkflowResponse, status_code=status.HTTP_201_CREATED)
async def create_workflow(payload: WorkflowCreateRequest, rt=Depends(get_runtime)):
    async with rt.session() as db:
        workflow = await WorkflowService.create_workflow(db, rt.owner_id, payload.model_dump())
        return WorkflowResponse.model_validate(workflow)


@router.get("/{workflow_id}", response_model=WorkflowResponse)
async def get_workflow(workflow_id: int, rt=Depends(get_runtime)):
    async with rt.session() as db:
        workflow = await WorkflowService.get_workflow(db, rt.owner_id, workflow_id)
        if workflow is None:
            raise _error(404, "workflow_not_found", "Workflow not found")
        return WorkflowResponse.model_validate(workflow)


@router.put("/{workflow_id}", response_model=WorkflowResponse)
async def update_workflow(workflow_id: int, payload: WorkflowUpdateRequest, rt=Depends(get_runtime)):
    async with rt.session() as db:
        workflow = await WorkflowService.update_workflow(
            db, rt.owner_id, workflow_id, payload.model_dump(exclude_unset=True)
        )
        if workflow is None:
            raise _error(404, "workflow_not_found", "Workflow not found")
        return WorkflowResponse.model_validate(workflow)


@router.delete("/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workflow(workflow_id: int, rt=Depends(get_runtime)):
    async with rt.session() as db:
        deleted = await WorkflowService.delete_workflow(db, rt.owner_id, workflow_id)
        if not deleted:
            raise _error(404, "workflow_not_found", "Workflow not found")
        return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{workflow_id}/runs", response_model=WorkflowRunResponse, status_code=status.HTTP_201_CREATED)
async def start_workflow_run(
    workflow_id: int, payload: WorkflowRunCreateRequest | None = None, rt=Depends(get_runtime)
):
    input_data = payload.input if payload else {}
    background = payload.background if payload else False
    async with rt.session() as db:
        try:
            run = await WorkflowService.start_run(
                db, rt.owner_id, workflow_id, input_data=input_data, trigger="manual", rt=rt, background=background
            )
            return WorkflowRunResponse.model_validate(run)
        except ValueError as exc:
            raise _error(422, "workflow_run_failed", str(exc)) from None


@router.get("/{workflow_id}/runs", response_model=list[WorkflowRunResponse])
async def list_workflow_runs(workflow_id: int, limit: int = 50, rt=Depends(get_runtime)):
    async with rt.session() as db:
        workflow = await WorkflowService.get_workflow(db, rt.owner_id, workflow_id)
        if workflow is None:
            raise _error(404, "workflow_not_found", "Workflow not found")
        runs = await WorkflowService.list_runs(db, rt.owner_id, workflow_id=workflow_id, limit=limit)
        return [WorkflowRunResponse.model_validate(r) for r in runs]


@router.get("/runs/all", response_model=list[WorkflowRunResponse])
async def list_all_runs(limit: int = 50, rt=Depends(get_runtime)):
    async with rt.session() as db:
        runs = await WorkflowService.list_runs(db, rt.owner_id, workflow_id=None, limit=limit)
        return [WorkflowRunResponse.model_validate(r) for r in runs]


@router.get("/runs/{run_id}", response_model=WorkflowRunResponse)
async def get_workflow_run(run_id: int, rt=Depends(get_runtime)):
    async with rt.session() as db:
        run = await WorkflowService.get_run(db, rt.owner_id, run_id)
        if run is None:
            raise _error(404, "workflow_run_not_found", "Workflow run not found")
        return WorkflowRunResponse.model_validate(run)


@router.post("/runs/{run_id}/approve", response_model=WorkflowRunResponse)
async def resolve_approval(run_id: int, payload: WorkflowApprovalDecisionRequest, rt=Depends(get_runtime)):
    async with rt.session() as db:
        try:
            run = await WorkflowService.resolve_approval(
                db, rt.owner_id, run_id, decision=payload.decision, notes=payload.notes, rt=rt
            )
            return WorkflowRunResponse.model_validate(run)
        except ValueError as exc:
            raise _error(422, "approval_resolution_failed", str(exc)) from None


@router.post("/runs/{run_id}/cancel", response_model=WorkflowRunResponse)
async def cancel_run(run_id: int, rt=Depends(get_runtime)):
    async with rt.session() as db:
        try:
            run = await WorkflowService.cancel_run(db, rt.owner_id, run_id)
            return WorkflowRunResponse.model_validate(run)
        except ValueError as exc:
            raise _error(422, "workflow_cancel_failed", str(exc)) from None


@router.post("/{workflow_id}/steps/{step_id}/run")
async def run_single_step(
    workflow_id: int,
    step_id: str,
    payload: WorkflowRunCreateRequest | None = None,
    rt=Depends(get_runtime),
):
    input_data = payload.input if payload else {}
    async with rt.session() as db:
        try:
            result = await WorkflowService.run_single_step(
                db, rt.owner_id, workflow_id, step_id, input_data=input_data, rt=rt
            )
            return result
        except ValueError as exc:
            raise _error(404, "step_run_failed", str(exc)) from None


@router.post("/{workflow_id}/trigger", response_model=WorkflowRunResponse, status_code=status.HTTP_201_CREATED)
async def webhook_trigger(
    workflow_id: int, payload: dict[str, Any] | None = None, rt=Depends(get_runtime)
):
    """External webhook trigger endpoint for executing a workflow."""
    async with rt.session() as db:
        try:
            run = await WorkflowService.start_run(
                db, rt.owner_id, workflow_id, input_data=payload or {}, trigger="webhook", rt=rt, background=True
            )
            return WorkflowRunResponse.model_validate(run)
        except ValueError as exc:
            raise _error(422, "webhook_trigger_failed", str(exc)) from None
