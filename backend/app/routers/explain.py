"""Read-only explanation of approvals and rule previews.

Local access only, owner-scoped, and strictly a projection: nothing here writes,
consumes or mutates an approval. It shows the owner what the enforcement
machinery will do — the resolved command, the matched rule, the safety-floor
verdict, and the other commands the same rule would also allow.
"""

from fastapi import APIRouter, Depends, HTTPException

from app.routers.threads import get_runtime
from app.schemas.approvals import ApprovalRuleCreate
from app.services import approval_explain as explain
from app.services import approval_allowlist as allowlist
from app.services import thread_store as store
from app.services.local_access_policy import require_local_access
from app.services.thread_runtime import ThreadRuntime

router = APIRouter(
    tags=["Approvals"],
    dependencies=[Depends(require_local_access)],
)


@router.post("/approvals/{approval_id}/explain")
async def explain_approval(
    approval_id: str,
    rt: ThreadRuntime = Depends(get_runtime),
):
    """Explain a pending approval: the consequence of allowing it. Idempotent and
    read-only — it never transitions, consumes or spends the approval."""
    async with rt.session() as db:
        approval = await store.get_approval(db, approval_id)
        if approval is None:
            raise HTTPException(status_code=404, detail="Approval not found")
        thread = await store.get_thread(db, approval.thread_id)
        if thread is None or thread.owner_id != rt.owner_id:
            raise HTTPException(status_code=404, detail="Approval not found")
        tool_input = approval.input if isinstance(approval.input, dict) else {}
        command = tool_input.get("command")
        rule = None
        if isinstance(command, str) and command.strip():
            matched = await allowlist.matching_rule(
                db, rt.owner_id, approval.tool, tool_input, getattr(thread, "workspace_path", None)
            )
            if matched is not None:
                rule = explain._rule_summary(matched)
    return explain.explain_approval(approval, rule)


@router.post("/approval-rules/preview")
async def preview_rule(
    payload: ApprovalRuleCreate,
    rt: ThreadRuntime = Depends(get_runtime),
):
    """Dry-run a candidate rule: what it would allow and reject, without saving.
    A payload that would be refused on save is refused here with the same message."""
    try:
        return explain.preview_rule(payload.match, payload.command, payload.workspace)
    except allowlist.InvalidRule as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
