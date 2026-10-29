"""Opt-in quiet completion and durable explicit routine outcomes."""
from alembic import context, op
import sqlalchemy as sa

revision = "f6b4d8a2c901"
down_revision = "e8a3c7b1d902"
branch_labels = None
depends_on = None


def upgrade():
    for table, column in (
        ("routine", sa.Column("quiet_reporting", sa.Boolean(), nullable=False, server_default=sa.false())),
        ("routine_run", sa.Column("outcome", sa.String(), nullable=True)),
        ("routine_run", sa.Column("outcome_details", sa.JSON(none_as_null=True), nullable=True)),
    ):
        if context.is_offline_mode() or column.name not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}:
            op.add_column(table, column)


def downgrade():
    op.drop_column("routine_run", "outcome_details")
    op.drop_column("routine_run", "outcome")
    op.drop_column("routine", "quiet_reporting")
