"""phase2 model enhancements

Revision ID: a1b2c3d4e5f6
Revises: f89622011fdb
Create Date: 2026-03-11 12:00:00.000000

"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "a1b2c3d4e5f6"
down_revision = "c4a2b7e91d13"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Outline: arc_phase for story arc awareness
    with op.batch_alter_table("outlines") as batch_op:
        batch_op.add_column(sa.Column("arc_phase", sa.String(length=32), nullable=True))

    # MemoryForeshadow: status for foreshadow tracking (open/resolved/abandoned)
    with op.batch_alter_table("foreshadows") as batch_op:
        batch_op.add_column(
            sa.Column("status", sa.String(length=16), nullable=False, server_default="open")
        )

    # Character: profile versioning
    with op.batch_alter_table("characters") as batch_op:
        batch_op.add_column(
            sa.Column("profile_version", sa.Integer(), nullable=False, server_default="0")
        )
        batch_op.add_column(sa.Column("profile_history_json", sa.Text(), nullable=True))

    # WritingStyle: scene overrides for adaptive style
    with op.batch_alter_table("writing_styles") as batch_op:
        batch_op.add_column(sa.Column("scene_overrides_json", sa.Text(), nullable=True))

    # ProjectTask: user-visible errors for auto-update failure visibility
    with op.batch_alter_table("project_tasks") as batch_op:
        batch_op.add_column(sa.Column("user_visible_errors_json", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("project_tasks") as batch_op:
        batch_op.drop_column("user_visible_errors_json")

    with op.batch_alter_table("writing_styles") as batch_op:
        batch_op.drop_column("scene_overrides_json")

    with op.batch_alter_table("characters") as batch_op:
        batch_op.drop_column("profile_history_json")
        batch_op.drop_column("profile_version")

    with op.batch_alter_table("foreshadows") as batch_op:
        batch_op.drop_column("status")

    with op.batch_alter_table("outlines") as batch_op:
        batch_op.drop_column("arc_phase")
