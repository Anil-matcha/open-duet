from datetime import datetime
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

StepType = Literal["action", "llm", "agent", "condition", "approval", "end"]
ApprovalMode = Literal["ask", "accept_edits", "approve_for_me", "plan"]
ConditionOperator = Literal[
    "contains",
    "not_contains",
    "equals",
    "not_equals",
    "matches_regex",
    "is_empty",
    "is_not_empty",
]


class BaseStep(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)
    x: float | None = None
    y: float | None = None
    width: float | None = None
    height: float | None = None
    target_port: Literal["text", "image", "file"] | None = None
    if_true_target_port: Literal["text", "image", "file"] | None = None
    if_false_target_port: Literal["text", "image", "file"] | None = None
    on_approve_target_port: Literal["text", "image", "file"] | None = None
    on_reject_target_port: Literal["text", "image", "file"] | None = None


class ActionStep(BaseStep):
    type: Literal["action"] = "action"
    agent_id: int | None = None
    prompt: str = Field(default="", max_length=20_000)
    approval_mode: ApprovalMode = "ask"
    next_step_id: str | None = None


class LLMStep(BaseStep):
    type: Literal["llm"] = "llm"
    prompt: str = Field(default="", max_length=20_000)
    model: str | None = None
    effort: str | None = None
    system_prompt: str | None = None
    agent_id: int | None = None
    approval_mode: ApprovalMode = "ask"
    next_step_id: str | None = None


class AgentStep(BaseStep):
    type: Literal["agent"] = "agent"
    agent_id: int | None = None
    prompt: str = Field(default="", max_length=20_000)
    model: str | None = None
    approval_mode: ApprovalMode = "ask"
    next_step_id: str | None = None


class ConditionStep(BaseStep):
    type: Literal["condition"] = "condition"
    target: str = Field(default="", max_length=200)
    operator: ConditionOperator = "contains"
    value: str = ""
    if_true: str | None = None
    if_false: str | None = None


class ApprovalStep(BaseStep):
    type: Literal["approval"] = "approval"
    prompt: str = Field(default="", max_length=2_000)
    timeout_minutes: int = Field(default=60, ge=1, le=10_080)
    on_approve: str | None = None
    on_reject: str | None = None


class EndStep(BaseStep):
    type: Literal["end"] = "end"
    status: Literal["completed", "failed"] = "completed"
    message: str = Field(default="", max_length=2_000)


class NoteStep(BaseStep):
    type: Literal["note"] = "note"
    prompt: str = Field(default="", max_length=20_000)
    text: str | None = None
    color: str | None = "yellow"
    tone: str | None = "yellow"
    ink: str | None = "ink"
    font: str | None = "sans"
    size: str | int | None = "18"
    align: str | None = "start"
    bold: bool | None = False
    next_step_id: str | None = None


class ShapeStep(BaseStep):
    type: Literal["shape"] = "shape"
    shape: str | None = "rectangle"
    color: str | None = "ink"
    text: str | None = ""
    prompt: str = Field(default="", max_length=20_000)
    next_step_id: str | None = None


class SectionStep(BaseStep):
    type: Literal["section"] = "section"
    color: str | None = "zinc"
    description: str | None = None
    next_step_id: str | None = None


class TextStep(BaseStep):
    type: Literal["text"] = "text"
    text: str = Field(default="", max_length=10_000)
    font_size: str | None = "medium"
    color: str | None = "zinc"
    next_step_id: str | None = None


class TriggerStep(BaseStep):
    type: Literal["trigger"] = "trigger"
    trigger_type: Literal["manual", "schedule", "webhook", "message"] = "schedule"
    schedule_kind: Literal["daily", "hourly", "weekly", "monthly", "cron"] = "daily"
    schedule_days: str | None = "every_day"
    schedule_time: str | None = "09:00"
    schedule_hours: int | None = 1
    schedule_cron: str | None = "0 9 * * 1-5"
    webhook_url: str | None = None
    webhook_secret: str | None = None
    message_keyword: str | None = None
    next_step_id: str | None = None


WorkflowStep = Annotated[
    Union[
        ActionStep,
        LLMStep,
        AgentStep,
        ConditionStep,
        ApprovalStep,
        EndStep,
        NoteStep,
        ShapeStep,
        SectionStep,
        TextStep,
        TriggerStep,
    ],
    Field(discriminator="type"),
]


class WorkflowCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=1_000)
    trigger_type: Literal["manual", "schedule", "webhook"] = "manual"
    trigger_spec: dict[str, Any] = Field(default_factory=dict)
    steps: list[WorkflowStep] = Field(default_factory=list)
    paused: bool = False


class WorkflowUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=1_000)
    trigger_type: Literal["manual", "schedule", "webhook"] | None = None
    trigger_spec: dict[str, Any] | None = None
    steps: list[WorkflowStep] | None = None
    paused: bool | None = None


class WorkflowResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    owner_id: str
    name: str
    description: str | None
    trigger_type: str
    trigger_spec: dict[str, Any]
    steps: list[dict[str, Any]]
    paused: bool
    created_at: datetime
    updated_at: datetime


class WorkflowRunCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    input: dict[str, Any] = Field(default_factory=dict)
    background: bool = False


class WorkflowApprovalDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    decision: Literal["approve", "reject"]
    notes: str | None = Field(default=None, max_length=1_000)


class WorkflowRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    workflow_id: int
    owner_id: str
    trigger: str
    status: str
    current_step_id: str | None
    context: dict[str, Any]
    step_states: dict[str, Any]
    pending_approval: dict[str, Any] | None
    error: str | None
    started_at: datetime
    finished_at: datetime | None
    created_at: datetime
    updated_at: datetime

