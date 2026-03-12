"""Phase 3: character arc_stages, voice_samples; relation stage/stage_history; AI trace custom words

Revision ID: b2c3d4e5f6g7
Revises: a1b2c3d4e5f6
Create Date: 2026-03-11 16:00:00.000000
"""

from alembic import op
import sqlalchemy as sa

revision = "b2c3d4e5f6g7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Character: arc_stages_json (growth arc tracking), voice_samples_json (voice fingerprints)
    with op.batch_alter_table("characters") as batch_op:
        batch_op.add_column(sa.Column("arc_stages_json", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("voice_samples_json", sa.Text(), nullable=True))

    # MemoryRelation: stage (relationship phase), stage_history_json (phase transitions)
    with op.batch_alter_table("relations") as batch_op:
        batch_op.add_column(sa.Column("stage", sa.String(length=64), nullable=True))
        batch_op.add_column(sa.Column("stage_history_json", sa.Text(), nullable=True))

    # ProjectSettings: custom_ai_trace_words (user-defined words to clean in post-edit)
    with op.batch_alter_table("project_settings") as batch_op:
        batch_op.add_column(sa.Column("custom_ai_trace_words_json", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("project_settings") as batch_op:
        batch_op.drop_column("custom_ai_trace_words_json")

    with op.batch_alter_table("relations") as batch_op:
        batch_op.drop_column("stage_history_json")
        batch_op.drop_column("stage")

    with op.batch_alter_table("characters") as batch_op:
        batch_op.drop_column("voice_samples_json")
        batch_op.drop_column("arc_stages_json")
