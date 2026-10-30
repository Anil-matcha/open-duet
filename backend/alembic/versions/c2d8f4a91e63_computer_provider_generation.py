"""Give each computer lifecycle generation a stable provider idempotency key.

Revision ID: c2d8f4a91e63
Revises: c7d4e2a91f60, a7c3e9d1f206, b6d1f4a9c3e7
"""
from alembic import op
import sqlalchemy as sa

revision = "c2d8f4a91e63"
down_revision = ("c7d4e2a91f60", "a7c3e9d1f206", "b6d1f4a9c3e7")
branch_labels = None
depends_on = None


def upgrade():
    # A fixed legacy value is safe because the computer ID is also part of the
    # provider idempotency key. New rows receive a random value in the model.
    with op.batch_alter_table("computer") as batch:
        batch.add_column(
            sa.Column("provider_generation", sa.String(), nullable=False, server_default="legacy")
        )
        batch.add_column(sa.Column("provider_delete_id", sa.String(), nullable=True))


def downgrade():
    with op.batch_alter_table("computer") as batch:
        batch.drop_column("provider_generation")
        batch.drop_column("provider_delete_id")
