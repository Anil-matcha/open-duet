"""join the agent-expiry merge node with upstream's v0.6.0-era head

Upstream's continued development (Expo mobile, connected apps, workflow
reporting) added f6b4d8a2c901 beyond d4b9e1a37c58 -- a leaf our earlier
merge migration (b2c3d4e5f6a7) did not cover. This migration joins the
leaves so `alembic upgrade head` resolves to the single head
c3d4e5f6a7b9.

Revision ID: c3d4e5f6a7b9
Revises: b2c3d4e5f6a7, f6b4d8a2c901
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'c3d4e5f6a7b9'
down_revision: Union[str, Sequence[str], None] = ('b2c3d4e5f6a7', 'f6b4d8a2c901')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
