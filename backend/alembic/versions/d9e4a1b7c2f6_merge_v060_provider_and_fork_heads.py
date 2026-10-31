"""join the fork's v0.6.0-era merge node with upstream's provider head

Syncing the fork's main onto upstream 29a639d (the first commits after the
v0.6.0 release) added upstream's computer-provider migration c2d8f4a91e63 as
a second leaf beside our own v0.6.0-era merge node c3d4e5f6a7b9. This
migration only joins the two leaves so `alembic upgrade head` resolves to a
single head again.

Revision ID: d9e4a1b7c2f6
Revises: c2d8f4a91e63, c3d4e5f6a7b9
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'd9e4a1b7c2f6'
down_revision: Union[str, Sequence[str], None] = ('c2d8f4a91e63', 'c3d4e5f6a7b9')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
