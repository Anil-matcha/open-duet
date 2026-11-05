"""Add multi-step workflow and workflow_run tables.

Revision ID: a1b2c3d4e5f6
Revises: f7a2c9d4e6b1
"""
from alembic import context, op
import sqlalchemy as sa

revision = "a1b2c3d4e5f6"
down_revision = "f7a2c9d4e6b1"
branch_labels = None
depends_on = None

_ID = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def _indexes(table: str) -> set[str]:
    return {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade():
    offline = context.is_offline_mode()
    if offline or "workflow" not in _tables():
        op.create_table(
            "workflow",
            sa.Column("id", _ID, sa.Identity(always=True), primary_key=True),
            sa.Column("owner_id", sa.String(), nullable=False),
            sa.Column("name", sa.String(length=100), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("trigger_type", sa.String(length=32), nullable=False, server_default="manual"),
            sa.Column("trigger_spec", sa.JSON(none_as_null=True), nullable=False),
            sa.Column("steps", sa.JSON(none_as_null=True), nullable=False),
            sa.Column("paused", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sqlite_autoincrement=True,
        )
    if offline or "ix_workflow_owner_paused" not in _indexes("workflow"):
        op.create_index("ix_workflow_owner_paused", "workflow", ["owner_id", "paused"])

    if offline or "workflow_run" not in _tables():
        op.create_table(
            "workflow_run",
            sa.Column("id", _ID, sa.Identity(always=True), primary_key=True),
            sa.Column("workflow_id", sa.BigInteger(), sa.ForeignKey("workflow.id", ondelete="CASCADE"), nullable=False),
            sa.Column("owner_id", sa.String(), nullable=False),
            sa.Column("trigger", sa.String(length=32), nullable=False, server_default="manual"),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="running"),
            sa.Column("current_step_id", sa.String(length=64), nullable=True),
            sa.Column("context", sa.JSON(none_as_null=True), nullable=False),
            sa.Column("step_states", sa.JSON(none_as_null=True), nullable=False),
            sa.Column("pending_approval", sa.JSON(none_as_null=True), nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
            sqlite_autoincrement=True,
        )
    if offline or "ix_workflow_run_workflow_created" not in _indexes("workflow_run"):
        op.create_index("ix_workflow_run_workflow_created", "workflow_run", ["workflow_id", "created_at"])
    if offline or "ix_workflow_run_status" not in _indexes("workflow_run"):
        op.create_index("ix_workflow_run_status", "workflow_run", ["status"])


def downgrade():
    offline = context.is_offline_mode()
    if offline or "workflow_run" in _tables():
        op.drop_table("workflow_run")
    if offline or "workflow" in _tables():
        op.drop_table("workflow")

