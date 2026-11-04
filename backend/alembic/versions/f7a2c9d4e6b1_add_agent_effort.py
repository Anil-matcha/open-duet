"""Persist a default reasoning effort on each agent.

Revision ID: f7a2c9d4e6b1
Revises: e4c9a7b2d610
"""
from alembic import context, op
import sqlalchemy as sa

revision = "f7a2c9d4e6b1"
down_revision = "e4c9a7b2d610"
branch_labels = None
depends_on = None


def _missing_effort_column() -> bool:
    if context.is_offline_mode():
        return True
    return "effort" not in {column["name"] for column in sa.inspect(op.get_bind()).get_columns("agent")}


def upgrade():
    if _missing_effort_column():
        op.add_column("agent", sa.Column("effort", sa.String(length=64), nullable=True))


def downgrade():
    op.drop_column("agent", "effort")
