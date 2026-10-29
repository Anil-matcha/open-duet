from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

ScheduleKind = Literal["cron", "weekdays", "interval", "once", "manual"]
ApprovalMode = Literal["ask", "accept_edits", "plan"]


class ConnectedAppGrant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tool: str
    account_id: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")

    @field_validator("tool")
    @classmethod
    def routine_tool(cls, value):
        from app.composio_tools import BY_NAME, ROUTINE_WRITE_TOOLS
        tool = BY_NAME.get(value)
        if tool is None or (tool.kind != "read" and value not in ROUTINE_WRITE_TOOLS):
            raise ValueError("Select a read action or a supported routine write action")
        return value


def validate_draft_grants(grants: list[ConnectedAppGrant]) -> None:
    """A checked reply workflow has exactly one mailbox and no other writes."""
    draft = "gmail_prepare_checked_reply"
    if not any(g.tool == draft for g in grants):
        return
    from app.composio_tools import BY_NAME
    tools = {g.tool for g in grants}
    if (len({g.account_id for g in grants}) != 1
            or not {"gmail_fetch_message", "gmail_get_profile"}.issubset(tools)
            or any(g.tool != draft and (g.tool not in BY_NAME or BY_NAME[g.tool].app != "gmail" or BY_NAME[g.tool].kind != "read") for g in grants)):
        raise ValueError("A checked reply requires Read a message and View account profile from one Gmail account, with no other writes or apps.")


class RoutineCreateRequest(BaseModel):
    agent_id: int
    connected_app_grants: list[ConnectedAppGrant] = Field(default_factory=list, max_length=50)
    name: str = Field(min_length=1, max_length=80)
    prompt: str = Field(min_length=1, max_length=20_000)
    schedule_kind: ScheduleKind = "manual"
    schedule_spec: dict = Field(default_factory=dict)
    timezone: str = Field(default="UTC", min_length=1, max_length=64)
    paused: bool = False
    run_limit_minutes: int = 30
    approval_mode: ApprovalMode = "ask"
    approval_timeout_minutes: int = 30
    catch_up_minutes: int = 60
    quiet_reporting: bool = False
    retry_limit: int = 0
    retry_delay_minutes: int = 5


class RoutineUpdateRequest(BaseModel):
    connected_app_grants: list[ConnectedAppGrant] | None = Field(default=None, max_length=50)
    agent_id: int | None = None
    name: str | None = Field(default=None, min_length=1, max_length=80)
    prompt: str | None = Field(default=None, min_length=1, max_length=20_000)
    schedule_kind: ScheduleKind | None = None
    schedule_spec: dict | None = None
    timezone: str | None = Field(default=None, min_length=1, max_length=64)
    run_limit_minutes: int | None = None
    approval_mode: ApprovalMode | None = None
    approval_timeout_minutes: int | None = None
    catch_up_minutes: int | None = None
    quiet_reporting: bool | None = None
    retry_limit: int | None = None
    retry_delay_minutes: int | None = None


class SchedulePreviewRequest(BaseModel):
    schedule_kind: ScheduleKind
    schedule_spec: dict = Field(default_factory=dict)
    timezone: str = Field(default="UTC", min_length=1, max_length=64)


class SchedulePreviewResponse(BaseModel):
    summary: str
    next_dates: list[datetime]


class RoutineAppActionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tool: str
    account_id: str
    status: str
    code: str | None
    result: dict | None
    created_at: datetime


class RoutineRunResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    routine_id: int
    connected_app_grants: list[ConnectedAppGrant] = Field(default_factory=list)
    trigger: str
    state: str
    scheduled_for: datetime | None
    thread_id: int | None
    turn_id: int | None
    outcome: str | None = None
    outcome_details: dict | None = None
    result: str | None
    error: str | None
    waiting_since: datetime | None
    waited_seconds: int
    attempt: int = 1
    retry_of: int | None = None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime


class RoutineResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    agent_id: int
    connected_app_grants: list[ConnectedAppGrant] = Field(default_factory=list)
    name: str
    prompt: str
    schedule_kind: str
    schedule_spec: dict
    timezone: str
    paused: bool
    paused_reason: str | None
    next_run_at: datetime | None
    run_limit_minutes: int
    approval_mode: str
    approval_timeout_minutes: int
    catch_up_minutes: int
    quiet_reporting: bool = False
    retry_limit: int = 0
    retry_delay_minutes: int = 5
    last_run_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # Derived for the client.
    summary: str = ""
    next_dates: list[datetime] = Field(default_factory=list)
    webhook_enabled: bool = False
    latest_run: RoutineRunResponse | None = None


class WebhookSecretResponse(BaseModel):
    routine: RoutineResponse
    # Shown once: only its hash is stored.
    secret: str
    path: str


class RoutineImportRequest(BaseModel):
    agent_id: int
    documents: list[dict] = Field(min_length=1, max_length=50)


class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    body: str | None
    routine_id: int | None
    run_id: int | None
    thread_id: int | None
    read_at: datetime | None
    created_at: datetime


class UnreadCountResponse(BaseModel):
    unread: int
