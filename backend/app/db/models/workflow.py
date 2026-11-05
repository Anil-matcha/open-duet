"""Multi-step workflow automations with condition evaluation, branching, and approval checkpoints."""
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, ForeignKey, Identity, Index, String, Text, false, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import BigIntPK, JSONValue, UTCDateTime

WORKFLOW_RUN_STATES = ("running", "waiting_approval", "completed", "failed", "cancelled")


class Workflow(Base):
    """A multi-step automation composed of action steps, condition branches,
    and human approval checkpoints."""
    __tablename__ = "workflow"
    __table_args__ = (
        Index("ix_workflow_owner_paused", "owner_id", "paused"),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(BigIntPK, Identity(always=True), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    trigger_type: Mapped[str] = mapped_column(String(32), default="manual", server_default="manual", nullable=False)
    trigger_spec: Mapped[dict] = mapped_column(JSONValue, default=dict, nullable=False)
    steps: Mapped[list] = mapped_column(JSONValue, default=list, nullable=False)
    paused: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class WorkflowRun(Base):
    """One execution of a multi-step workflow tracking progress through steps,
    intermediate context, and waiting approvals."""
    __tablename__ = "workflow_run"
    __table_args__ = (
        Index("ix_workflow_run_workflow_created", "workflow_id", "created_at"),
        Index("ix_workflow_run_status", "status"),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(BigIntPK, Identity(always=True), primary_key=True)
    workflow_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("workflow.id", ondelete="CASCADE"), nullable=False)
    owner_id: Mapped[str] = mapped_column(String, nullable=False)
    trigger: Mapped[str] = mapped_column(String(32), default="manual", server_default="manual", nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="running", server_default="running", nullable=False)
    current_step_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    context: Mapped[dict] = mapped_column(JSONValue, default=dict, nullable=False)
    step_states: Mapped[dict] = mapped_column(JSONValue, default=dict, nullable=False)
    pending_approval: Mapped[dict | None] = mapped_column(JSONValue, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now(), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now(), onupdate=func.now(), nullable=False)

