"""add project_module_slots

Revision ID: c5d9e3a7b1f2
Revises: b2c3d4e5f6g7
Create Date: 2026-03-14

"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

import sqlalchemy as sa
from alembic import op


revision = "c5d9e3a7b1f2"
down_revision = "b2c3d4e5f6g7"
branch_labels = None
depends_on = None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _new_id() -> str:
    return str(uuid4())


def upgrade() -> None:
    op.create_table(
        "project_module_slots",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("llm_profile_id", sa.String(length=36), nullable=False),
        sa.Column("display_name", sa.String(length=64), nullable=False),
        sa.Column("is_main", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["llm_profile_id"], ["llm_profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_pms_project_id", "project_module_slots", ["project_id"])
    op.create_index("ix_pms_profile_id", "project_module_slots", ["llm_profile_id"])
    op.create_index(
        "uq_pms_project_main",
        "project_module_slots",
        ["project_id"],
        unique=True,
        postgresql_where=sa.text("is_main = true"),
        sqlite_where=sa.text("is_main = 1"),
    )

    with op.batch_alter_table("llm_task_presets", schema=None) as batch_op:
        batch_op.add_column(sa.Column("module_slot_id", sa.String(length=36), nullable=True))
        batch_op.create_foreign_key(
            "fk_llm_task_presets_module_slot_id",
            "project_module_slots",
            ["module_slot_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index("ix_llm_task_presets_module_slot_id", ["module_slot_id"], unique=False)

    conn = op.get_bind()
    now = _utc_now()

    project_rows = conn.execute(sa.text("SELECT id, owner_user_id, llm_profile_id FROM projects")).fetchall()
    for project_id, owner_user_id, profile_id in project_rows:
        slot_id = None
        if profile_id:
            slot_id = _new_id()
            conn.execute(
                sa.text(
                    """
                    INSERT INTO project_module_slots
                        (id, project_id, llm_profile_id, display_name, is_main, sort_order, created_at)
                    VALUES
                        (:id, :project_id, :llm_profile_id, :display_name, :is_main, :sort_order, :created_at)
                    """
                ),
                {
                    "id": slot_id,
                    "project_id": project_id,
                    "llm_profile_id": profile_id,
                    "display_name": "主模块",
                    "is_main": True,
                    "sort_order": 0,
                    "created_at": now,
                },
            )
        else:
            preset = conn.execute(
                sa.text(
                    """
                    SELECT provider, base_url, model, temperature, top_p, max_tokens, presence_penalty,
                           frequency_penalty, top_k, stop_json, timeout_seconds, extra_json
                    FROM llm_presets
                    WHERE project_id = :project_id
                    """
                ),
                {"project_id": project_id},
            ).fetchone()
            if preset:
                new_profile_id = _new_id()
                conn.execute(
                    sa.text(
                        """
                        INSERT INTO llm_profiles
                            (id, owner_user_id, name, provider, base_url, model, temperature, top_p, max_tokens,
                             presence_penalty, frequency_penalty, top_k, stop_json, timeout_seconds, extra_json,
                             api_key_ciphertext, api_key_masked, created_at, updated_at)
                        VALUES
                            (:id, :owner_user_id, :name, :provider, :base_url, :model, :temperature, :top_p, :max_tokens,
                             :presence_penalty, :frequency_penalty, :top_k, :stop_json, :timeout_seconds, :extra_json,
                             :api_key_ciphertext, :api_key_masked, :created_at, :updated_at)
                        """
                    ),
                    {
                        "id": new_profile_id,
                        "owner_user_id": owner_user_id,
                        "name": "主模块",
                        "provider": preset[0],
                        "base_url": preset[1],
                        "model": preset[2],
                        "temperature": preset[3],
                        "top_p": preset[4],
                        "max_tokens": preset[5],
                        "presence_penalty": preset[6],
                        "frequency_penalty": preset[7],
                        "top_k": preset[8],
                        "stop_json": preset[9],
                        "timeout_seconds": preset[10],
                        "extra_json": preset[11],
                        "api_key_ciphertext": None,
                        "api_key_masked": None,
                        "created_at": now,
                        "updated_at": now,
                    },
                )
                conn.execute(
                    sa.text("UPDATE projects SET llm_profile_id = :pid WHERE id = :project_id"),
                    {"pid": new_profile_id, "project_id": project_id},
                )
                slot_id = _new_id()
                conn.execute(
                    sa.text(
                        """
                        INSERT INTO project_module_slots
                            (id, project_id, llm_profile_id, display_name, is_main, sort_order, created_at)
                        VALUES
                            (:id, :project_id, :llm_profile_id, :display_name, :is_main, :sort_order, :created_at)
                        """
                    ),
                    {
                        "id": slot_id,
                        "project_id": project_id,
                        "llm_profile_id": new_profile_id,
                        "display_name": "主模块",
                        "is_main": True,
                        "sort_order": 0,
                        "created_at": now,
                    },
                )

    task_rows = conn.execute(
        sa.text("SELECT project_id, task_key, llm_profile_id FROM llm_task_presets WHERE llm_profile_id IS NOT NULL")
    ).fetchall()
    for project_id, task_key, profile_id in task_rows:
        slot_row = conn.execute(
            sa.text(
                """
                SELECT id FROM project_module_slots
                WHERE project_id = :project_id AND llm_profile_id = :llm_profile_id
                """
            ),
            {"project_id": project_id, "llm_profile_id": profile_id},
        ).fetchone()
        if slot_row:
            slot_id = slot_row[0]
        else:
            name_row = conn.execute(
                sa.text("SELECT name FROM llm_profiles WHERE id = :profile_id"),
                {"profile_id": profile_id},
            ).fetchone()
            display_name = (name_row[0] if name_row else None) or "模块"
            sort_order = conn.execute(
                sa.text(
                    """
                    SELECT COALESCE(MAX(sort_order), 0) FROM project_module_slots WHERE project_id = :project_id
                    """
                ),
                {"project_id": project_id},
            ).scalar()
            slot_id = _new_id()
            conn.execute(
                sa.text(
                    """
                    INSERT INTO project_module_slots
                        (id, project_id, llm_profile_id, display_name, is_main, sort_order, created_at)
                    VALUES
                        (:id, :project_id, :llm_profile_id, :display_name, :is_main, :sort_order, :created_at)
                    """
                ),
                {
                    "id": slot_id,
                    "project_id": project_id,
                    "llm_profile_id": profile_id,
                    "display_name": display_name,
                    "is_main": False,
                    "sort_order": int(sort_order or 0) + 1,
                    "created_at": now,
                },
            )

        conn.execute(
            sa.text(
                """
                UPDATE llm_task_presets
                SET module_slot_id = :slot_id
                WHERE project_id = :project_id AND task_key = :task_key
                """
            ),
            {"slot_id": slot_id, "project_id": project_id, "task_key": task_key},
        )


def downgrade() -> None:
    with op.batch_alter_table("llm_task_presets", schema=None) as batch_op:
        batch_op.drop_index("ix_llm_task_presets_module_slot_id")
        batch_op.drop_constraint("fk_llm_task_presets_module_slot_id", type_="foreignkey")
        batch_op.drop_column("module_slot_id")

    op.drop_index("uq_pms_project_main", table_name="project_module_slots")
    op.drop_index("ix_pms_profile_id", table_name="project_module_slots")
    op.drop_index("ix_pms_project_id", table_name="project_module_slots")
    op.drop_table("project_module_slots")
