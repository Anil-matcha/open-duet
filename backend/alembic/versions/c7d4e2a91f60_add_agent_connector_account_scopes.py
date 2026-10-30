"""Bind connected-app grants to exact Composio accounts.

Revision ID: c7d4e2a91f60
Revises: f6b4d8a2c901
"""
from alembic import context, op
import sqlalchemy as sa

revision = "c7d4e2a91f60"
down_revision = "f6b4d8a2c901"
branch_labels = None
depends_on = None


def upgrade():
    if context.is_offline_mode() or "connector_account_scopes" not in {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("agent")
    }:
        op.add_column(
            "agent",
            sa.Column(
                "connector_account_scopes",
                sa.JSON(none_as_null=True),
                nullable=False,
                server_default=sa.text("'{}'"),
            ),
        )


def downgrade():
    op.drop_column("agent", "connector_account_scopes")
