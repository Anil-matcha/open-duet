"""Exact routine connected-app grants and durable action receipts; existing rows stay off."""
from alembic import context, op
from app.db.types import BigIntPK, UTCDateTime
import sqlalchemy as sa

revision = "e8a3c7b1d902"
down_revision = "d4b9e1a37c58"
branch_labels = None
depends_on = None


def upgrade():
    for table in ("routine", "routine_run"):
        if context.is_offline_mode() or "connected_app_grants" not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}:
            op.add_column(table, sa.Column("connected_app_grants", sa.JSON(), nullable=False, server_default="[]"))

    if context.is_offline_mode() or "routine_app_action" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "routine_app_action",
            sa.Column("id", BigIntPK, sa.Identity(always=True), primary_key=True),
            sa.Column("run_id", sa.BigInteger(), sa.ForeignKey("routine_run.id", name="fk_routine_app_action_run_id", ondelete="CASCADE"), nullable=False),
            sa.Column("tool", sa.String(), nullable=False),
            sa.Column("account_id", sa.String(), nullable=False),
            sa.Column("request_key", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("code", sa.String(), nullable=True),
            sa.Column("result", sa.JSON(none_as_null=True), nullable=True),
            sa.Column("created_at", UTCDateTime, nullable=False, server_default=sa.func.now()),
            sqlite_autoincrement=True,
        )
        op.create_index("uq_routine_app_action_request", "routine_app_action", ["run_id", "account_id", "request_key"], unique=True)


def downgrade():
    op.drop_table("routine_app_action")
    for table in ("routine_run", "routine"):
        # Native DROP COLUMN keeps referenced routine rows intact on SQLite.
        op.drop_column(table, "connected_app_grants")
