from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.types import JSONValue, UTCDateTime


class CommunityMcpConnection(Base):
    """An owner's pinned marketplace manifest. Credentials live separately encrypted."""

    __tablename__ = "community_mcp_connection"
    __table_args__ = (
        UniqueConstraint("owner_id", "slug", name="uq_community_mcp_owner_slug"),
        Index("ix_community_mcp_connection_owner", "owner_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String(64), nullable=False)
    section: Mapped[str] = mapped_column(String(16), nullable=False)
    manifest: Mapped[dict] = mapped_column(JSONValue, nullable=False)
    manifest_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default="1")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now(), onupdate=func.now(), nullable=False)


class CommunityMcpToolGrant(Base):
    """Exact per-agent tool grants bound to the schema shown when granted."""

    __tablename__ = "community_mcp_tool_grant"
    __table_args__ = (
        Index("ix_community_mcp_tool_connection", "connection_id"),
    )

    agent_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("agent.id", ondelete="CASCADE"), primary_key=True
    )
    connection_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("community_mcp_connection.id", ondelete="CASCADE"), primary_key=True
    )
    tool_name: Mapped[str] = mapped_column(String(200), primary_key=True)
    schema_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    input_schema: Mapped[dict] = mapped_column(JSONValue, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, server_default=func.now(), nullable=False)
