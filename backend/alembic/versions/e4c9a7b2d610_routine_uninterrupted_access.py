"""Persist routine uninterrupted access and each run's capability ceilings."""
from alembic import context, op
import sqlalchemy as sa

revision = "e4c9a7b2d610"
down_revision = "d7a4c91e5b26"
branch_labels = None
depends_on = None


def upgrade():
    for table in ("routine", "routine_run"):
        if context.is_offline_mode() or "uninterrupted_access" not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}:
            op.add_column(table, sa.Column("uninterrupted_access", sa.Boolean(), nullable=False, server_default=sa.false()))
    if context.is_offline_mode() or "capability_snapshot" not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("routine_run")}:
        op.add_column("routine_run", sa.Column("capability_snapshot", sa.JSON(), nullable=False, server_default="{}"))


def downgrade():
    op.drop_column("routine_run", "capability_snapshot")
    for table in ("routine_run", "routine"):
        op.drop_column(table, "uninterrupted_access")
