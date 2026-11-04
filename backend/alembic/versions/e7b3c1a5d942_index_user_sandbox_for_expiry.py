"""Index user_sandbox for the expiry sweep.

The reaper (services/user_sandbox_service.expire) looks for active rows past
their `expires_at` on every upkeep tick; this index keeps that lookup off a
full table scan as abandoned sandboxes accumulate.

Revision ID: e7b3c1a5d942
Revises: c4a1f9e2d073
"""

from alembic import op

revision = "e7b3c1a5d942"
down_revision = "c4a1f9e2d073"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_user_sandbox_active_expires", "user_sandbox", ["is_active", "expires_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_user_sandbox_active_expires", table_name="user_sandbox")
