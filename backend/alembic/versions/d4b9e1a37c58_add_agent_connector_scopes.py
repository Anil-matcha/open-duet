"""Which connected apps (Composio) an agent may read. Null means none.

Revision ID: d4b9e1a37c58
Revises: c6f2a8d4e901
"""
from alembic import context, op
import sqlalchemy as sa

revision = "d4b9e1a37c58"
down_revision = "c6f2a8d4e901"
branch_labels = None
depends_on = None


def upgrade():
    # A nullable ADD COLUMN works on SQLite without a table rebuild. Checked
    # first, so a re-run after a crash completes it.
    offline = context.is_offline_mode()
    if offline or "connector_scopes" not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("agent")}:
        op.add_column("agent", sa.Column("connector_scopes", sa.JSON(none_as_null=True), nullable=True))


def downgrade():
    with op.batch_alter_table("agent") as batch:
        batch.drop_column("connector_scopes")
