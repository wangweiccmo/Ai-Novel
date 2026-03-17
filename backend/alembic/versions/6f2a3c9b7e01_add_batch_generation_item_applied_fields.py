"""add batch generation item applied fields

Revision ID: 6f2a3c9b7e01
Revises: a1b2c3d4e5f6
Create Date: 2026-03-17 12:00:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "6f2a3c9b7e01"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("batch_generation_task_items", schema=None) as batch_op:
        batch_op.add_column(sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column("applied_by_user_id", sa.String(length=36), nullable=True))
        batch_op.create_foreign_key(
            "fk_batch_generation_task_items_applied_by_user_id_users",
            "users",
            ["applied_by_user_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("batch_generation_task_items", schema=None) as batch_op:
        batch_op.drop_constraint("fk_batch_generation_task_items_applied_by_user_id_users", type_="foreignkey")
        batch_op.drop_column("applied_by_user_id")
        batch_op.drop_column("applied_at")
