"""Owner-scoped remote MCP marketplace connections and exact agent grants.

Revision ID: d7a4c91e5b26
Revises: c2d8f4a91e63
"""
from alembic import op
import sqlalchemy as sa

revision = "d7a4c91e5b26"
down_revision = "c2d8f4a91e63"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "community_mcp_connection",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_id", sa.String(), nullable=False),
        sa.Column("slug", sa.String(length=64), nullable=False),
        sa.Column("section", sa.String(length=16), nullable=False),
        sa.Column("manifest", sa.JSON(none_as_null=True), nullable=False),
        sa.Column("manifest_digest", sa.String(length=64), nullable=False),
        sa.Column("revision", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_id", "slug", name="uq_community_mcp_owner_slug"),
    )
    op.create_index("ix_community_mcp_connection_owner", "community_mcp_connection", ["owner_id"])
    op.create_table(
        "community_mcp_tool_grant",
        sa.Column("agent_id", sa.BigInteger(), nullable=False),
        sa.Column("connection_id", sa.String(length=36), nullable=False),
        sa.Column("tool_name", sa.String(length=200), nullable=False),
        sa.Column("schema_digest", sa.String(length=64), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column("input_schema", sa.JSON(none_as_null=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["agent_id"], ["agent.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["connection_id"], ["community_mcp_connection.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("agent_id", "connection_id", "tool_name"),
    )
    op.create_index("ix_community_mcp_tool_connection", "community_mcp_tool_grant", ["connection_id"])


def downgrade():
    op.drop_index("ix_community_mcp_tool_connection", table_name="community_mcp_tool_grant")
    op.drop_table("community_mcp_tool_grant")
    op.drop_index("ix_community_mcp_connection_owner", table_name="community_mcp_connection")
    op.drop_table("community_mcp_connection")
