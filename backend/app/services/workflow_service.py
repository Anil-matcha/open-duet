import asyncio
import copy
from sqlalchemy.orm.attributes import flag_modified
"""Multi-step workflow service with condition evaluation, branching, and approval checkpoints."""
import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import delete, desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.turn import Turn
from app.db.models.workflow import Workflow, WorkflowRun


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def render_template(template: str, context: dict[str, Any]) -> str:
    """Interpolate variables formatted as {{input.field}} or {{steps.<step_id>.output}}."""
    pattern = re.compile(r"\{\{\s*([\w\.\-]+)\s*\}\}")

    def replace_var(match: re.Match) -> str:
        var_path = match.group(1).split(".")
        curr: Any = context
        for part in var_path:
            if isinstance(curr, dict) and part in curr:
                curr = curr[part]
            else:
                return match.group(0)  # leave unreplaced if not found
        return str(curr) if curr is not None else ""

    return pattern.sub(replace_var, template)


def resolve_context_target(context: dict[str, Any], target_path: str) -> Any:
    """Retrieve nested context value by dot notation (e.g. 'steps.triage.output')."""
    parts = target_path.strip().split(".")
    curr: Any = context
    for p in parts:
        if isinstance(curr, dict) and p in curr:
            curr = curr[p]
        else:
            return None
    return curr


def evaluate_condition(target_value: Any, operator: str, expected_value: str) -> bool:
    """Evaluate condition operators against resolved context values."""
    s_val = str(target_value) if target_value is not None else ""
    exp = expected_value or ""

    if operator == "contains":
        return exp.lower() in s_val.lower()
    elif operator == "not_contains":
        return exp.lower() not in s_val.lower()
    elif operator == "equals":
        return s_val.strip().lower() == exp.strip().lower()
    elif operator == "not_equals":
        return s_val.strip().lower() != exp.strip().lower()
    elif operator == "matches_regex":
        try:
            return bool(re.search(exp, s_val, re.IGNORECASE))
        except re.error:
            return False
    elif operator == "is_empty":
        return not s_val.strip()
    elif operator == "is_not_empty":
        return bool(s_val.strip())
    return False



async def _commit_with_retry(db: AsyncSession, max_retries: int = 5) -> None:
    for attempt in range(max_retries):
        try:
            await db.commit()
            return
        except Exception as e:
            if "locked" in str(e).lower() and attempt < max_retries - 1:
                await db.rollback()
                await asyncio.sleep(0.1 * (attempt + 1))
                continue
            raise


class WorkflowService:
    @staticmethod
    async def list_workflows(db: AsyncSession, owner_id: str) -> list[Workflow]:
        result = await db.scalars(
            select(Workflow).where(Workflow.owner_id == owner_id).order_by(desc(Workflow.updated_at))
        )
        return list(result.all())

    @staticmethod
    async def get_workflow(db: AsyncSession, owner_id: str, workflow_id: int) -> Workflow | None:
        return await db.scalar(
            select(Workflow).where(Workflow.id == workflow_id, Workflow.owner_id == owner_id)
        )

    @staticmethod
    async def create_workflow(db: AsyncSession, owner_id: str, data: dict[str, Any]) -> Workflow:
        workflow = Workflow(
            owner_id=owner_id,
            name=data["name"].strip(),
            description=data.get("description"),
            trigger_type=data.get("trigger_type", "manual"),
            trigger_spec=data.get("trigger_spec") or {},
            steps=data.get("steps") or [],
            paused=bool(data.get("paused", False)),
        )
        db.add(workflow)
        await db.commit()
        await db.refresh(workflow)
        return workflow

    @staticmethod
    async def update_workflow(
        db: AsyncSession, owner_id: str, workflow_id: int, data: dict[str, Any]
    ) -> Workflow | None:
        workflow = await WorkflowService.get_workflow(db, owner_id, workflow_id)
        if workflow is None:
            return None

        if "name" in data and data["name"] is not None:
            workflow.name = data["name"].strip()
        if "description" in data:
            workflow.description = data["description"]
        if "trigger_type" in data and data["trigger_type"] is not None:
            workflow.trigger_type = data["trigger_type"]
        if "trigger_spec" in data and data["trigger_spec"] is not None:
            workflow.trigger_spec = data["trigger_spec"]
            flag_modified(workflow, "trigger_spec")
        if "steps" in data and data["steps"] is not None:
            workflow.steps = data["steps"]
            flag_modified(workflow, "steps")
        if "paused" in data and data["paused"] is not None:
            workflow.paused = bool(data["paused"])

        workflow.updated_at = utcnow()
        await _commit_with_retry(db)
        await db.refresh(workflow)
        return workflow

    @staticmethod
    async def delete_workflow(db: AsyncSession, owner_id: str, workflow_id: int) -> bool:
        workflow = await WorkflowService.get_workflow(db, owner_id, workflow_id)
        if workflow is None:
            return False
        await db.delete(workflow)
        await db.commit()
        return True

    @staticmethod
    async def list_runs(
        db: AsyncSession, owner_id: str, workflow_id: int | None = None, limit: int = 50
    ) -> list[WorkflowRun]:
        query = select(WorkflowRun).where(WorkflowRun.owner_id == owner_id)
        if workflow_id is not None:
            query = query.where(WorkflowRun.workflow_id == workflow_id)
        query = query.order_by(desc(WorkflowRun.created_at)).limit(limit)
        result = await db.scalars(query)
        return list(result.all())

    @staticmethod
    async def get_run(db: AsyncSession, owner_id: str, run_id: int) -> WorkflowRun | None:
        return await db.scalar(
            select(WorkflowRun).where(WorkflowRun.id == run_id, WorkflowRun.owner_id == owner_id)
        )

    @staticmethod
    async def start_run(
        db: AsyncSession,
        owner_id: str,
        workflow_id: int,
        input_data: dict[str, Any] | None = None,
        trigger: str = "manual",
        rt: Any = None,
        background: bool = False,
    ) -> WorkflowRun:
        workflow = await WorkflowService.get_workflow(db, owner_id, workflow_id)
        if workflow is None:
            raise ValueError("Workflow not found")
        if workflow.paused:
            raise ValueError("Workflow is paused")

        steps = workflow.steps or []
        first_step_id = steps[0]["id"] if steps else None

        run = WorkflowRun(
            workflow_id=workflow.id,
            owner_id=owner_id,
            trigger=trigger,
            status="running" if first_step_id else "completed",
            current_step_id=first_step_id,
            context={"input": input_data or {}, "steps": {}},
            step_states={},
            pending_approval=None,
            error=None,
            started_at=utcnow(),
            finished_at=utcnow() if not first_step_id else None,
        )
        db.add(run)
        await _commit_with_retry(db)
        await db.refresh(run)

        if first_step_id:
            if background and rt is not None:
                async def _run_bg():
                    try:
                        async with rt.session() as bg_db:
                            await WorkflowService.step_run(bg_db, run.id, rt=rt)
                    except Exception:
                        pass

                asyncio.create_task(_run_bg())
            else:
                run = await WorkflowService.step_run(db, run.id, rt=rt)

        return run

    @staticmethod
    async def step_run(db: AsyncSession, run_id: int, rt: Any = None) -> WorkflowRun | None:
        """Executes steps sequentially or across branches until paused, ended, or failed."""
        run = await db.get(WorkflowRun, run_id)
        if run is None or run.status != "running":
            return run

        workflow = await db.get(Workflow, run.workflow_id)
        if workflow is None:
            run.status = "failed"
            run.error = "Associated workflow was deleted"
            run.finished_at = utcnow()
            await db.commit()
            return run

        steps_by_id = {s["id"]: s for s in (workflow.steps or [])}
        context = dict(run.context or {})
        step_states = dict(run.step_states or {})

        max_iterations = 100
        iteration = 0

        while run.status == "running" and run.current_step_id and iteration < max_iterations:
            iteration += 1
            step = steps_by_id.get(run.current_step_id)
            if not step:
                run.status = "failed"
                run.error = f"Step '{run.current_step_id}' not found in workflow definition"
                run.finished_at = utcnow()
                break

            step_id = step["id"]
            step_type = step.get("type", "action")
            step_name = step.get("name", step_id)

            step_states[step_id] = {
                "id": step_id,
                "name": step_name,
                "type": step_type,
                "started_at": utcnow().isoformat(),
                "status": "running",
            }

            if step_type in ("action", "llm", "agent"):
                prompt = render_template(step.get("prompt", ""), context)
                output_text = ""
                if rt is not None:
                    run.context = context
                    run.step_states = step_states
                    run.updated_at = utcnow()
                    flag_modified(run, "step_states")
                    flag_modified(run, "context")
                    await _commit_with_retry(db)
                    try:
                        agent_id = step.get("agent_id") or 1
                        model = step.get("model")
                        effort = step.get("effort")
                        system_prompt = step.get("system_prompt")
                        if system_prompt:
                            prompt = f"System prompt:\n{system_prompt}\n\nTask:\n{prompt}"
                        thread = await rt.create_thread(
                            agent_id=agent_id,
                            model=model,
                            effort=effort,
                            title=f"Workflow: {step_name}",
                        )
                        turn = await rt.send_turn(
                            thread.id,
                            prompt,
                            approval_mode=step.get("approval_mode", "ask"),
                            team_origin="workflow",
                        )
                        max_wait = 180
                        waited = 0.0
                        poll_interval = 0.5
                        while waited < max_wait:
                            await asyncio.sleep(poll_interval)
                            waited += poll_interval
                            db.expire_all()
                            turn_row = await db.scalar(select(Turn).where(Turn.id == turn.id))
                            if turn_row and turn_row.status != "running":
                                if turn_row.status == "succeeded":
                                    output_text = turn_row.result or "Step completed."
                                elif turn_row.status == "failed":
                                    output_text = turn_row.error or turn_row.result or "Step failed."
                                else:
                                    output_text = turn_row.result or f"Turn status: {turn_row.status}"
                                break
                        else:
                            output_text = f"Turn {turn.id} timed out waiting for assistant reply."
                    except BaseException as e:
                        output_text = f"Action executed with note: {e}"
                else:
                    output_text = f"Simulated output for {step_type} '{step_name}': {prompt[:100]}"

                context.setdefault("steps", {})[step_id] = {
                    "output": output_text,
                    "status": "completed",
                }
                step_states[step_id].update({
                    "status": "completed",
                    "output": output_text,
                    "finished_at": utcnow().isoformat(),
                })

                run.current_step_id = step.get("next_step_id")
                if not run.current_step_id:
                    run.status = "completed"
                    run.finished_at = utcnow()

            elif step_type == "condition":
                target_path = step.get("target", "")
                target_val = resolve_context_target(context, target_path)
                operator = step.get("operator", "contains")
                expected = step.get("value", "")

                passed = evaluate_condition(target_val, operator, expected)
                next_branch = step.get("if_true") if passed else step.get("if_false")

                step_states[step_id].update({
                    "status": "completed",
                    "result": passed,
                    "branch_taken": next_branch,
                    "target_value": str(target_val) if target_val is not None else None,
                    "finished_at": utcnow().isoformat(),
                })

                run.current_step_id = next_branch
                if not run.current_step_id:
                    run.status = "completed"
                    run.finished_at = utcnow()

            elif step_type == "approval":
                prompt = render_template(step.get("prompt", ""), context)
                timeout_minutes = int(step.get("timeout_minutes", 60))

                run.status = "waiting_approval"
                run.pending_approval = {
                    "step_id": step_id,
                    "name": step_name,
                    "prompt": prompt,
                    "timeout_minutes": timeout_minutes,
                    "on_approve": step.get("on_approve"),
                    "on_reject": step.get("on_reject"),
                    "requested_at": utcnow().isoformat(),
                }
                step_states[step_id].update({
                    "status": "waiting_approval",
                    "prompt": prompt,
                })
                break

            elif step_type in ("trigger", "note"):
                step_states[step_id].update({
                    "status": "completed",
                    "output": f"Trigger fired ({step.get('trigger_type', 'manual')})" if step_type == "trigger" else step.get("prompt", ""),
                    "finished_at": utcnow().isoformat(),
                })
                run.current_step_id = step.get("next_step_id")
                if not run.current_step_id:
                    run.status = "completed"
                    run.finished_at = utcnow()

            elif step_type == "end":
                end_status = step.get("status", "completed")
                run.status = end_status
                run.error = step.get("message") if end_status == "failed" else None
                run.finished_at = utcnow()
                step_states[step_id].update({
                    "status": end_status,
                    "message": step.get("message", ""),
                    "finished_at": utcnow().isoformat(),
                })
                run.current_step_id = None
                break

        if iteration >= max_iterations and run.status == "running":
            run.status = "failed"
            run.error = "Workflow execution exceeded maximum loop limit (possible cycle)"
            run.finished_at = utcnow()

        run.context = copy.deepcopy(context)
        run.step_states = copy.deepcopy(step_states)
        flag_modified(run, "context")
        flag_modified(run, "step_states")
        run.updated_at = utcnow()
        await _commit_with_retry(db)
        await db.refresh(run)
        return run

    @staticmethod
    async def resolve_approval(
        db: AsyncSession,
        owner_id: str,
        run_id: int,
        decision: str,
        notes: str | None = None,
        rt: Any = None,
    ) -> WorkflowRun:
        run = await WorkflowService.get_run(db, owner_id, run_id)
        if run is None:
            raise ValueError("Workflow run not found")
        if run.status != "waiting_approval" or not run.pending_approval:
            raise ValueError("Workflow run is not awaiting approval")

        pending = run.pending_approval
        step_id = pending["step_id"]
        step_states = dict(run.step_states or {})

        if decision == "approve":
            step_states.setdefault(step_id, {}).update({
                "status": "approved",
                "decision": "approved",
                "notes": notes,
                "decided_at": utcnow().isoformat(),
            })
            run.current_step_id = pending.get("on_approve")
            run.status = "running"
            run.pending_approval = None
            run.step_states = step_states

            if not run.current_step_id:
                run.status = "completed"
                run.finished_at = utcnow()
                await db.commit()
                await db.refresh(run)
            else:
                await db.commit()
                await WorkflowService.step_run(db, run.id, rt=rt)
                await db.refresh(run)

        elif decision == "reject":
            step_states.setdefault(step_id, {}).update({
                "status": "rejected",
                "decision": "rejected",
                "notes": notes,
                "decided_at": utcnow().isoformat(),
            })
            on_reject = pending.get("on_reject")
            run.pending_approval = None
            run.step_states = step_states

            if on_reject:
                run.current_step_id = on_reject
                run.status = "running"
                await db.commit()
                await WorkflowService.step_run(db, run.id, rt=rt)
                await db.refresh(run)
            else:
                run.status = "cancelled"
                run.error = f"Workflow rejected at approval step '{pending.get('name', step_id)}'"
                run.finished_at = utcnow()
                run.current_step_id = None
                await db.commit()
                await db.refresh(run)
        else:
            raise ValueError("Invalid decision; must be 'approve' or 'reject'")

        return run

    @staticmethod
    async def cancel_run(db: AsyncSession, owner_id: str, run_id: int) -> WorkflowRun:
        run = await WorkflowService.get_run(db, owner_id, run_id)
        if run is None:
            raise ValueError("Workflow run not found")
        if run.status in ("completed", "failed", "cancelled"):
            return run

        run.status = "cancelled"
        run.finished_at = utcnow()
        run.pending_approval = None
        run.updated_at = utcnow()
        await db.commit()
        await db.refresh(run)
        return run

    @staticmethod
    async def run_single_step(
        db: AsyncSession,
        owner_id: str,
        workflow_id: int,
        step_id: str,
        input_data: dict[str, Any] | None = None,
        rt: Any = None,
    ) -> dict[str, Any]:
        workflow = await WorkflowService.get_workflow(db, owner_id, workflow_id)
        if workflow is None:
            raise ValueError("Workflow not found")
        step = next((s for s in (workflow.steps or []) if s.get("id") == step_id), None)
        if step is None:
            raise ValueError(f"Step '{step_id}' not found")

        step_type = step.get("type", "action")
        step_name = step.get("name", step_id)
        context = {"input": input_data or {}, "steps": {}}
        prompt = render_template(step.get("prompt", ""), context)

        if rt is not None and step_type in ("action", "llm", "agent"):
            agent_id = step.get("agent_id") or 1
            thread = await rt.create_thread(
                agent_id=agent_id,
                title=f"Workflow Step Test: {step_name}",
            )
            turn = await rt.send_turn(
                thread.id,
                prompt,
                approval_mode=step.get("approval_mode", "ask"),
                team_origin="workflow",
            )
            max_wait = 180
            waited = 0.0
            poll_interval = 0.5
            output_text = ""
            while waited < max_wait:
                await asyncio.sleep(poll_interval)
                waited += poll_interval
                db.expire_all()
                turn_row = await db.scalar(select(Turn).where(Turn.id == turn.id))
                if turn_row and turn_row.status != "running":
                    output_text = turn_row.result or (turn_row.error if turn_row.status == "failed" else "Completed.")
                    return {
                        "step_id": step_id,
                        "status": turn_row.status,
                        "output": output_text,
                        "thread_id": thread.id,
                        "turn_id": turn.id,
                    }
            return {
                "step_id": step_id,
                "status": "timeout",
                "output": f"Step turn {turn.id} timed out.",
                "thread_id": thread.id,
                "turn_id": turn.id,
            }
        elif step_type == "condition":
            target_path = step.get("target", "")
            target_val = resolve_context_target(context, target_path)
            operator = step.get("operator", "contains")
            expected = step.get("value", "")
            passed = evaluate_condition(target_val, operator, expected)
            return {
                "step_id": step_id,
                "status": "completed",
                "result": passed,
                "output": f"Condition evaluated to: {passed}",
            }
        elif step_type == "trigger":
            return {
                "step_id": step_id,
                "status": "completed",
                "output": f"Trigger '{step_name}' ({step.get('trigger_type', 'manual')}) fired successfully.",
            }
        elif step_type == "note":
            return {
                "step_id": step_id,
                "status": "completed",
                "output": step.get("prompt", ""),
            }
        else:
            return {
                "step_id": step_id,
                "status": "completed",
                "output": f"Simulated output for {step_name}: {prompt}",
            }
