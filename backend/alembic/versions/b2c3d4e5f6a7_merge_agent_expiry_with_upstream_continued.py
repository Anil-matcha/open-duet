"""merge our agent-expiry merge node with upstream's continued chain

After the sync rebase-carry onto upstream 9b67118, upstream's feature chain
continued past 9e6d3b1a7c52 to d4b9e1a37c58, leaving our merge migration
a1b2c3d4e5f6 (e7b3c1a5d942 + 9e6d3b1a7c52) as a second leaf. This migration
joins the leaves so `alembic upgrade head` resolves to the single head
b2c3d4e5f6a7.

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6, d4b9e1a37c58
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'b2c3d4e5f6a7'
down_revision: Union[str, Sequence[str], None] = ('a1b2c3d4e5f6', 'd4b9e1a37c58')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
