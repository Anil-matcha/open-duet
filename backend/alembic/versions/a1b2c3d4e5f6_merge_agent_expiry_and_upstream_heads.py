"""merge our agent-expiry head with upstream's feature heads

Rebasing the fork's audit-remediation series onto upstream f4697ce left two
Alembic leaves: our sandbox-expiry index (e7b3c1a5d942, down-chain
c4a1f9e2d073) and upstream's feature migrations (merged at
32f1a61f1173, continued to 9e6d3b1a7c52). This migration only joins the
branches so `alembic upgrade head` has a single head again.

Revision ID: a1b2c3d4e5f6
Revises: e7b3c1a5d942, 9e6d3b1a7c52
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = ('e7b3c1a5d942', '9e6d3b1a7c52')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
