from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import FastAPI

from app.core.config import settings
from app.db.models.thread import Thread
from app.db.models.turn import Turn
from app.routers.threads import get_runtime
from app.routers.workflows import router as workflows_router
from tests.services.thread_harness import cleanup, owner, sessions  # noqa: F401


@pytest.fixture(autouse=True)
def local_enabled(monkeypatch):
    monkeypatch.setattr(settings, "LOCAL_EXECUTION_ENABLED", True)
    monkeypatch.setattr(settings, "LOCAL_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]")


@pytest.fixture
async def api(sessions, owner):
    app = FastAPI()
    app.include_router(workflows_router, prefix="/api/v1")
    app.dependency_overrides[get_runtime] = lambda: WorkflowTestRuntime(sessions, owner)
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
        yield client


class WorkflowTestRuntime:
    """Return deterministic successful turns without launching an engine process."""

    def __init__(self, sessions, owner_id):
        self.sessions = sessions
        self.owner_id = owner_id

    @asynccontextmanager
    async def session(self):
        async with self.sessions() as db:
            yield db

    async def create_thread(self, *, title=None, agent_id=None, **kwargs):
        async with self.sessions() as db:
            thread = Thread(owner_id=self.owner_id, provider="test", title=title, agent_id=agent_id)
            db.add(thread)
            await db.commit()
            await db.refresh(thread)
            return thread

    async def send_turn(self, thread_id, prompt, **kwargs):
        async with self.sessions() as db:
            turn = Turn(
                thread_id=thread_id,
                seq=1,
                prompt_text=prompt,
                status="succeeded",
                result="Test assistant response",
            )
            db.add(turn)
            await db.commit()
            await db.refresh(turn)
            return turn


@pytest.mark.asyncio
async def test_workflows_api_lifecycle(api):
    # 1. Initially empty
    res = await api.get("/api/v1/workflows")
    assert res.status_code == 200
    assert res.json() == []

    # 2. Create workflow
    payload = {
        "name": "Customer Support Triage",
        "description": "Multi-step support response with branch and approval gate",
        "trigger_type": "manual",
        "steps": [
            {
                "id": "triage",
                "type": "action",
                "name": "Classify inquiry",
                "agent_id": 1,
                "prompt": "Classify: {{input.message}}",
                "next_step_id": "check_refund",
            },
            {
                "id": "check_refund",
                "type": "condition",
                "name": "Check if refund requested",
                "target": "input.message",
                "operator": "contains",
                "value": "refund",
                "if_true": "approval_gate",
                "if_false": "auto_reply",
            },
            {
                "id": "approval_gate",
                "type": "approval",
                "name": "Approve refund process",
                "prompt": "Approve refund processing for: {{input.customer}}",
                "timeout_minutes": 60,
                "on_approve": "process_refund",
                "on_reject": "reject_refund",
            },
            {
                "id": "auto_reply",
                "type": "action",
                "name": "Auto reply",
                "agent_id": 1,
                "prompt": "Thank you for reaching out.",
                "next_step_id": None,
            },
            {
                "id": "process_refund",
                "type": "action",
                "name": "Process refund",
                "agent_id": 2,
                "prompt": "Process refund for {{input.customer}}",
                "next_step_id": None,
            },
            {
                "id": "reject_refund",
                "type": "end",
                "name": "Refund rejected",
                "status": "failed",
                "message": "Refund request was declined by finance",
            },
        ],
    }
    create_res = await api.post("/api/v1/workflows", json=payload)
    assert create_res.status_code == 201
    wf = create_res.json()
    wf_id = wf["id"]
    assert wf["name"] == "Customer Support Triage"
    assert len(wf["steps"]) == 6

    # 3. Get workflow by ID
    get_res = await api.get(f"/api/v1/workflows/{wf_id}")
    assert get_res.status_code == 200
    assert get_res.json()["id"] == wf_id

    # 4. Update workflow
    update_res = await api.put(f"/api/v1/workflows/{wf_id}", json={"name": "Support Triage V2"})
    assert update_res.status_code == 200
    assert update_res.json()["name"] == "Support Triage V2"

    # 5. Run workflow with non-refund inquiry -> auto_reply path
    run1_res = await api.post(
        f"/api/v1/workflows/{wf_id}/runs",
        json={"input": {"customer": "Bob", "message": "Where is my delivery?"}},
    )
    assert run1_res.status_code == 201
    run1 = run1_res.json()
    assert run1["status"] == "completed"
    assert "auto_reply" in run1["step_states"]
    assert "approval_gate" not in run1["step_states"]

    # 6. Run workflow with refund inquiry -> approval gate path
    run2_res = await api.post(
        f"/api/v1/workflows/{wf_id}/runs",
        json={"input": {"customer": "Charlie", "message": "I demand a refund"}},
    )
    assert run2_res.status_code == 201
    run2 = run2_res.json()
    assert run2["status"] == "waiting_approval"
    assert run2["pending_approval"]["step_id"] == "approval_gate"
    assert "Charlie" in run2["pending_approval"]["prompt"]

    # Approve run2
    approve_res = await api.post(
        f"/api/v1/workflows/runs/{run2['id']}/approve",
        json={"decision": "approve", "notes": "Eligible for refund"},
    )
    assert approve_res.status_code == 200
    approved_run = approve_res.json()
    assert approved_run["status"] == "completed"
    assert "process_refund" in approved_run["step_states"]

    # 7. Run workflow and reject approval
    run3_res = await api.post(
        f"/api/v1/workflows/{wf_id}/runs",
        json={"input": {"customer": "Dave", "message": "refund please"}},
    )
    run3 = run3_res.json()
    assert run3["status"] == "waiting_approval"
    reject_res = await api.post(
        f"/api/v1/workflows/runs/{run3['id']}/approve",
        json={"decision": "reject", "notes": "Past 30 days window"},
    )
    assert reject_res.status_code == 200
    assert reject_res.json()["status"] == "failed"
    assert "declined by finance" in reject_res.json()["error"]

    # 8. List runs for this workflow
    runs_res = await api.get(f"/api/v1/workflows/{wf_id}/runs")
    assert runs_res.status_code == 200
    assert len(runs_res.json()) == 3

    # 9. Cancel an active run
    # Start paused workflow or cancellation
    run4_res = await api.post(
        f"/api/v1/workflows/{wf_id}/runs",
        json={"input": {"customer": "Eve", "message": "refund request"}},
    )
    run4 = run4_res.json()
    assert run4["status"] == "waiting_approval"
    cancel_res = await api.post(f"/api/v1/workflows/runs/{run4['id']}/cancel")
    assert cancel_res.status_code == 200
    assert cancel_res.json()["status"] == "cancelled"

    # 10. Delete workflow
    del_res = await api.delete(f"/api/v1/workflows/{wf_id}")
    assert del_res.status_code == 204
    assert (await api.get(f"/api/v1/workflows/{wf_id}")).status_code == 404


async def test_workflow_node_dimensions(api):
    create_res = await api.post(
        "/api/v1/workflows",
        json={
            "name": "Sized Workflow",
            "steps": [
                {
                    "id": "trig_1",
                    "name": "Schedule Trigger",
                    "type": "trigger",
                    "trigger_type": "schedule",
                    "schedule_kind": "daily",
                    "width": 320,
                    "x": 60,
                    "y": 120,
                },
                {
                    "id": "llm_1",
                    "name": "LLM Analysis",
                    "type": "llm",
                    "prompt": "Summarize input",
                    "width": 440,
                    "height": 400,
                    "x": 440,
                    "y": 120,
                },
                {
                    "id": "note_1",
                    "name": "Documentation",
                    "type": "note",
                    "prompt": "Note text",
                    "width": 300,
                    "height": 220,
                    "x": 940,
                    "y": 120,
                },
            ],
        },
    )
    assert create_res.status_code == 201
    wf = create_res.json()
    assert wf["steps"][0]["width"] == 320
    assert wf["steps"][1]["width"] == 440
    assert wf["steps"][1]["height"] == 400
    assert wf["steps"][2]["width"] == 300
    assert wf["steps"][2]["height"] == 220

    # Update width & height and target port
    update_res = await api.put(
        f"/api/v1/workflows/{wf['id']}",
        json={
            "steps": [
                {
                    "id": "llm_1",
                    "name": "LLM Analysis Resized",
                    "type": "llm",
                    "prompt": "Summarize input",
                    "width": 520,
                    "height": 480,
                    "x": 440,
                    "y": 120,
                    "next_step_id": "note_1",
                    "target_port": "image",
                }
            ]
        },
    )
    assert update_res.status_code == 200
    updated_wf = update_res.json()
    assert updated_wf["steps"][0]["width"] == 520
    assert updated_wf["steps"][0]["height"] == 480
    assert updated_wf["steps"][0]["target_port"] == "image"


@pytest.mark.asyncio
async def test_workflow_section_and_text_steps(api):
    create_res = await api.post(
        "/api/v1/workflows",
        json={
            "name": "Canvas With Section and Text Annotation",
            "trigger_type": "manual",
            "steps": [
                {
                    "id": "sec_1",
                    "name": "Pipeline Section",
                    "type": "section",
                    "color": "amber",
                    "prompt": "Core data extraction group",
                    "width": 600,
                    "height": 400,
                    "x": 100,
                    "y": 100,
                },
                {
                    "id": "txt_1",
                    "name": "Header Text",
                    "type": "text",
                    "text": "Production Ingestion Phase",
                    "font_size": "large",
                    "color": "emerald",
                    "width": 320,
                    "height": 60,
                    "x": 120,
                    "y": 120,
                },
                {
                    "id": "end_1",
                    "name": "Done",
                    "type": "end",
                    "status": "completed",
                    "x": 500,
                    "y": 200,
                },
            ],
        },
    )
    assert create_res.status_code == 201
    wf = create_res.json()
    assert len(wf["steps"]) == 3
    sec = next(s for s in wf["steps"] if s["id"] == "sec_1")
    txt = next(s for s in wf["steps"] if s["id"] == "txt_1")
    assert sec["type"] == "section"
    assert sec["color"] == "amber"
    assert txt["type"] == "text"
    assert txt["text"] == "Production Ingestion Phase"
    assert txt["font_size"] == "large"

    # Test executing the workflow containing section and text steps
    run_res = await api.post(f"/api/v1/workflows/{wf['id']}/runs", json={"input": {}})
    assert run_res.status_code == 201
    run = run_res.json()
    assert run["status"] == "completed"


