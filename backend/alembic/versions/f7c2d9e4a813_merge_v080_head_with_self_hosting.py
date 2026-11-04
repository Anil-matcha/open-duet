"""join the self-hosting merge node with upstream's v0.8.1 head

Upstream's v0.8.x development (MCP marketplace, Muapi, provider work) added
e4c9a7b2d610 beyond the head our earlier merge migration
(d9e4a1b7c2f6) covered. This migration joins the two leaves so
`alembic upgrade head` resolves to the single head f7c2d9e4a813.

Revision ID: f7c2d9e4a813
Revises: d9e4a1b7c2f6, e4c9a7b2d610
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'f7c2d9e4a813'
down_revision: Union[str, Sequence[str], None] = ('d9e4a1b7c2f6', 'e4c9a7b2d610')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
