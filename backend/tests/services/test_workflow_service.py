import pytest
from app.services.workflow_service import (
    WorkflowService,
    evaluate_condition,
    render_template,
    resolve_context_target,
)


def test_render_template():
    context = {
        "input": {"customer": "Alice", "priority": "urgent"},
        "steps": {
            "triage": {"output": "Issue is high priority server outage"},
            "empty_step": {"output": ""},
        },
    }
    assert (
        render_template("Hello {{input.customer}}, your ticket is {{input.priority}}.", context)
        == "Hello Alice, your ticket is urgent."
    )
    assert (
        render_template("Report: {{steps.triage.output}}", context)
        == "Report: Issue is high priority server outage"
    )
    # Unresolved variable left as is
    assert render_template("Check {{unknown.field}}", context) == "Check {{unknown.field}}"


def test_evaluate_condition():
    # contains
    assert evaluate_condition("server outage detected", "contains", "outage")
    assert not evaluate_condition("normal operation", "contains", "outage")

    # not_contains
    assert evaluate_condition("normal operation", "not_contains", "error")
    assert not evaluate_condition("error code 500", "not_contains", "error")

    # equals & not_equals
    assert evaluate_condition("urgent", "equals", "URGENT")
    assert not evaluate_condition("low", "equals", "urgent")
    assert evaluate_condition("low", "not_equals", "high")

    # regex
    assert evaluate_condition("Order #12345 approved", "matches_regex", r"#\d+")
    assert not evaluate_condition("No numbers here", "matches_regex", r"#\d+")

    # is_empty & is_not_empty
    assert evaluate_condition("", "is_empty", "")
    assert evaluate_condition("   ", "is_empty", "")
    assert evaluate_condition("content", "is_not_empty", "")
    assert not evaluate_condition("", "is_not_empty", "")


def test_resolve_context_target():
    context = {"steps": {"step1": {"output": "done", "meta": {"code": 200}}}}
    assert resolve_context_target(context, "steps.step1.output") == "done"
    assert resolve_context_target(context, "steps.step1.meta.code") == 200
    assert resolve_context_target(context, "steps.nonexistent") is None


@pytest.mark.asyncio
async def test_workflow_crud_and_branching(db_session, user_id):
    owner = user_id
    db = db_session

    # Create workflow with action -> condition -> approval -> action branches
    wf_data = {
        "name": "Incident Triage Workflow",
        "description": "Triages issues, branches on severity, and gates on approval",
        "trigger_type": "manual",
        "steps": [
            {
                "id": "step_triage",
                "type": "action",
                "name": "Analyze issue",
                "agent_id": 1,
                "prompt": "Analyze issue: {{input.issue}}",
                "next_step_id": "step_check_severity",
            },
            {
                "id": "step_check_severity",
                "type": "condition",
                "name": "Check severity",
                "target": "steps.step_triage.output",
                "operator": "contains",
                "value": "critical",
                "if_true": "step_approval_gate",
                "if_false": "step_standard_response",
            },
            {
                "id": "step_approval_gate",
                "type": "approval",
                "name": "Approve escalation",
                "prompt": "Please review escalation for: {{input.issue}}",
                "timeout_minutes": 30,
                "on_approve": "step_escalate",
                "on_reject": "step_cancel_notice",
            },
            {
                "id": "step_standard_response",
                "type": "action",
                "name": "Standard response",
                "agent_id": 1,
                "prompt": "Send standard reply",
                "next_step_id": None,
            },
            {
                "id": "step_escalate",
                "type": "action",
                "name": "Escalate incident",
                "agent_id": 2,
                "prompt": "Escalate critical issue to on-call",
                "next_step_id": None,
            },
            {
                "id": "step_cancel_notice",
                "type": "end",
                "name": "Reject notice",
                "status": "failed",
                "message": "Escalation rejected by operator",
            },
        ],
    }
    wf = await WorkflowService.create_workflow(db, owner, wf_data)
    assert wf.id is not None
    assert wf.name == "Incident Triage Workflow"

    # 1. Run with non-critical issue -> should branch to standard_response and complete
    run1 = await WorkflowService.start_run(
        db, owner, wf.id, input_data={"issue": "low priority login delay"}
    )
    assert run1.status == "completed"
    assert "step_standard_response" in run1.step_states
    assert "step_approval_gate" not in run1.step_states

    # 2. Run with critical issue -> should branch to approval gate and pause
    run2 = await WorkflowService.start_run(
        db, owner, wf.id, input_data={"issue": "critical database crash"}
    )
    assert run2.status == "waiting_approval"
    assert run2.pending_approval is not None
    assert run2.pending_approval["step_id"] == "step_approval_gate"
    assert "critical database crash" in run2.pending_approval["prompt"]

    # Approve run2 -> should advance to escalate and complete
    run2_res = await WorkflowService.resolve_approval(
        db, owner, run2.id, decision="approve", notes="Approved by lead"
    )
    assert run2_res.status == "completed"
    assert "step_escalate" in run2_res.step_states
    assert run2_res.step_states["step_approval_gate"]["decision"] == "approved"

    # 3. Run with critical issue -> reject approval gate -> should branch to step_cancel_notice
    run3 = await WorkflowService.start_run(
        db, owner, wf.id, input_data={"issue": "critical payment issue"}
    )
    assert run3.status == "waiting_approval"
    run3_rej = await WorkflowService.resolve_approval(
        db, owner, run3.id, decision="reject", notes="Not a real incident"
    )
    assert run3_rej.status == "failed"
    assert run3_rej.error == "Escalation rejected by operator"

    # Update workflow
    updated = await WorkflowService.update_workflow(
        db, owner, wf.id, {"name": "Renamed Workflow", "paused": True}
    )
    assert updated.name == "Renamed Workflow"
    assert updated.paused is True

    # Starting paused workflow raises ValueError
    with pytest.raises(ValueError, match="paused"):
        await WorkflowService.start_run(db, owner, wf.id)

    # Delete workflow
    deleted = await WorkflowService.delete_workflow(db, owner, wf.id)
    assert deleted is True
    assert await WorkflowService.get_workflow(db, owner, wf.id) is None