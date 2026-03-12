from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.utils import utc_now


# NOTE: The graph subsystem uses a flexible schema:
# - relation_type is a short string (NOT enforced by DB beyond length).
# - attributes_json stores optional structured attributes.
#
# We provide a small, stable recommended set for UX/prompting while keeping extensibility.
RECOMMENDED_RELATION_TYPES: tuple[str, ...] = (
    # Generic fallback
    "related_to",
    # People
    "family",
    "romance",
    "friend",
    "ally",
    "enemy",
    "mentor",
    "student",
    # Social/organization
    "leader_of",
    "member_of",
    # Plot/interaction
    "owes",
    "betrayed",
    "protects",
)

# Suggested schema keys for entities.attributes_json (NOT enforced).
# Keep keys stable; add new keys by versioning in docs when needed.
ENTITY_ATTRIBUTES_SCHEMA_V1: dict[str, dict[str, object]] = {
    "aliases": {"type": "array[string]", "description": "别名/昵称（用于消歧与搜索）"},
    "tags": {"type": "array[string]", "description": "自定义标签"},
    "role": {"type": "string", "description": "角色/身份（如 主角/反派/导师/线人 等）"},
    "faction": {"type": "string", "description": "阵营/组织（如有）"},
    "confidence": {"type": "number", "description": "AI 抽取置信度（用于 UI 提示/排序）"},
}

# Suggested schema keys for relations.attributes_json (NOT enforced).
# Keep keys stable; add new keys by versioning in docs when needed.
RELATION_ATTRIBUTES_SCHEMA_V1: dict[str, dict[str, object]] = {
    "strength": {"type": "number", "description": "0~1 或 0~100（亲密度/敌对度/强度）"},
    "status": {"type": "string", "enum": ["active", "past", "unknown"], "description": "关系当前是否有效"},
    "since_chapter_id": {"type": "string", "description": "关系起始章节（可用于回放/时间线）"},
    "until_chapter_id": {"type": "string", "description": "关系结束章节（若已结束）"},
    "last_seen_at_chapter_id": {"type": "string", "description": "最后一次被证据支持的章节"},
    "context_md": {"type": "string", "description": "关键事件/语境摘要（Markdown；尽量短）"},
    "tags": {"type": "array[string]", "description": "自定义标签"},
    "confidence": {"type": "number", "description": "AI 抽取置信度（用于 UI 提示/排序）"},
    "is_symmetric": {"type": "boolean", "description": "是否应在 UI 以无向方式展示"},
}

# Optional direction/semantics hints for prompting/UX (NOT enforced).
RELATION_TYPE_HINTS_V1: dict[str, dict[str, object]] = {
    "related_to": {"description": "泛关系（信息不足时兜底）", "direction": "variable"},
    "family": {"description": "亲属/家族关系（尽量用更具体类型；方向不固定）", "direction": "variable"},
    "romance": {"description": "恋爱/暧昧/伴侣", "direction": "symmetric"},
    "friend": {"description": "朋友/交情", "direction": "symmetric"},
    "ally": {"description": "盟友/合作关系", "direction": "symmetric"},
    "enemy": {"description": "敌对/仇恨关系", "direction": "symmetric"},
    "mentor": {"description": "导师/师父", "direction": "mentor -> student"},
    "student": {"description": "学生/徒弟", "direction": "student -> mentor"},
    "leader_of": {"description": "领导/统领", "direction": "leader -> organization"},
    "member_of": {"description": "成员/隶属", "direction": "member -> organization"},
    "owes": {"description": "欠债/欠人情", "direction": "debtor -> creditor"},
    "betrayed": {"description": "背叛/出卖（通常有具体事件证据）", "direction": "betrayer -> betrayed"},
    "protects": {"description": "保护/守护", "direction": "protector -> protected"},
}


class MemoryEntity(Base):
    __tablename__ = "entities"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)

    entity_type: Mapped[str] = mapped_column(String(64), nullable=False, default="generic")
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    summary_md: Mapped[str | None] = mapped_column(Text, nullable=True)
    attributes_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (UniqueConstraint("project_id", "entity_type", "name", name="uq_entities_project_type_name"),)


class MemoryRelation(Base):
    __tablename__ = "relations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    from_entity_id: Mapped[str] = mapped_column(ForeignKey("entities.id", ondelete="CASCADE"), nullable=False)
    to_entity_id: Mapped[str] = mapped_column(ForeignKey("entities.id", ondelete="CASCADE"), nullable=False)

    relation_type: Mapped[str] = mapped_column(String(64), nullable=False, default="related_to")
    description_md: Mapped[str | None] = mapped_column(Text, nullable=True)
    attributes_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    stage: Mapped[str | None] = mapped_column(String(64), nullable=True)
    stage_history_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "from_entity_id",
            "to_entity_id",
            "relation_type",
            name="uq_relations_project_from_to_type",
        ),
    )


class MemoryEvent(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    chapter_id: Mapped[str | None] = mapped_column(ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)

    event_type: Mapped[str] = mapped_column(String(64), nullable=False, default="event")
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    content_md: Mapped[str] = mapped_column(Text, nullable=False, default="")
    attributes_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MemoryForeshadow(Base):
    __tablename__ = "foreshadows"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    chapter_id: Mapped[str | None] = mapped_column(ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)
    resolved_at_chapter_id: Mapped[str | None] = mapped_column(ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True)

    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    content_md: Mapped[str] = mapped_column(Text, nullable=False, default="")
    resolved: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    attributes_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MemoryEvidence(Base):
    __tablename__ = "evidence"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)

    source_type: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")
    source_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    quote_md: Mapped[str] = mapped_column(Text, nullable=False, default="")
    attributes_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MemoryChangeSet(Base):
    __tablename__ = "memory_change_sets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    actor_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    generation_run_id: Mapped[str | None] = mapped_column(ForeignKey("generation_runs.id", ondelete="SET NULL"), nullable=True)

    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False)

    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    summary_md: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="proposed")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rolled_back_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint("project_id", "idempotency_key", name="uq_memory_change_sets_project_idempotency_key"),
        CheckConstraint(
            "status IN ('proposed','applied','rolled_back','failed')",
            name="ck_memory_change_sets_status",
        ),
    )


class MemoryChangeSetItem(Base):
    __tablename__ = "memory_change_set_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    change_set_id: Mapped[str] = mapped_column(ForeignKey("memory_change_sets.id", ondelete="CASCADE"), nullable=False)

    item_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    target_table: Mapped[str] = mapped_column(String(32), nullable=False)
    target_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    op: Mapped[str] = mapped_column(String(16), nullable=False, default="upsert")

    before_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    after_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence_ids_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)

    __table_args__ = (
        UniqueConstraint("change_set_id", "item_index", name="uq_memory_change_set_items_change_set_index"),
        CheckConstraint("op IN ('upsert','delete')", name="ck_memory_change_set_items_op"),
        CheckConstraint(
            "target_table IN ('entities','relations','events','foreshadows','evidence','project_table_rows')",
            name="ck_memory_change_set_items_target_table",
        ),
    )


Index("ix_entities_project_id", MemoryEntity.project_id)
Index("ix_entities_project_id_entity_type", MemoryEntity.project_id, MemoryEntity.entity_type)
Index(
    "ix_entities_project_id_deleted_at_updated_at",
    MemoryEntity.project_id,
    MemoryEntity.deleted_at,
    MemoryEntity.updated_at,
)
Index("ix_relations_project_id", MemoryRelation.project_id)
Index("ix_relations_project_id_from_entity_id", MemoryRelation.project_id, MemoryRelation.from_entity_id)
Index("ix_relations_project_id_to_entity_id", MemoryRelation.project_id, MemoryRelation.to_entity_id)
Index(
    "ix_relations_project_id_deleted_at_updated_at",
    MemoryRelation.project_id,
    MemoryRelation.deleted_at,
    MemoryRelation.updated_at,
)
Index("ix_events_project_id", MemoryEvent.project_id)
Index("ix_events_project_id_chapter_id", MemoryEvent.project_id, MemoryEvent.chapter_id)
Index(
    "ix_events_project_id_deleted_at_updated_at",
    MemoryEvent.project_id,
    MemoryEvent.deleted_at,
    MemoryEvent.updated_at,
)
Index("ix_foreshadows_project_id", MemoryForeshadow.project_id)
Index("ix_foreshadows_project_id_resolved", MemoryForeshadow.project_id, MemoryForeshadow.resolved)
Index(
    "ix_foreshadows_project_id_deleted_at_updated_at",
    MemoryForeshadow.project_id,
    MemoryForeshadow.deleted_at,
    MemoryForeshadow.updated_at,
)
Index("ix_evidence_project_id", MemoryEvidence.project_id)
Index("ix_evidence_project_id_source", MemoryEvidence.project_id, MemoryEvidence.source_type, MemoryEvidence.source_id)
Index(
    "ix_evidence_project_id_deleted_at_created_at",
    MemoryEvidence.project_id,
    MemoryEvidence.deleted_at,
    MemoryEvidence.created_at,
)
Index("ix_memory_change_sets_project_id", MemoryChangeSet.project_id)
Index("ix_memory_change_sets_project_id_status", MemoryChangeSet.project_id, MemoryChangeSet.status)
Index("ix_memory_change_set_items_project_id", MemoryChangeSetItem.project_id)
Index("ix_memory_change_set_items_change_set_id", MemoryChangeSetItem.change_set_id)
Index("ix_memory_change_set_items_project_target", MemoryChangeSetItem.project_id, MemoryChangeSetItem.target_table)
