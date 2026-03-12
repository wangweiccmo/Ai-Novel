"""Canon audit service: rule-based continuity checks before chapter generation.

Detects potential logical contradictions by comparing the current chapter context
against structured memory (entities, relations, events, foreshadows).
No LLM call required — pure rule-based matching for speed.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.chapter import Chapter
from app.models.character import Character
from app.models.structured_memory import MemoryEntity, MemoryEvent, MemoryForeshadow, MemoryRelation

logger = logging.getLogger("ainovel")

FORESHADOW_OVERDUE_THRESHOLD = 20
MISSING_CHARACTER_CHECK_GAP = 30


@dataclass
class ContinuityWarning:
    category: str  # timeline | spatial | relationship | foreshadow | character
    message: str
    severity: str = "medium"  # low | medium | high
    source_ids: list[str] = field(default_factory=list)


def run_canon_audit(
    db: Session,
    *,
    project_id: str,
    chapter_number: int,
    chapter_plan: str = "",
    character_ids: list[str] | None = None,
) -> list[ContinuityWarning]:
    """Run rule-based continuity checks. Returns a list of warnings to inject."""
    warnings: list[ContinuityWarning] = []

    if chapter_number <= 1:
        return warnings

    warnings.extend(_check_overdue_foreshadows(db, project_id=project_id, chapter_number=chapter_number))
    warnings.extend(_check_relation_contradictions(db, project_id=project_id))
    warnings.extend(_check_missing_characters(
        db, project_id=project_id, chapter_number=chapter_number,
        chapter_plan=chapter_plan, character_ids=character_ids,
    ))

    return warnings


def _check_overdue_foreshadows(
    db: Session,
    *,
    project_id: str,
    chapter_number: int,
) -> list[ContinuityWarning]:
    """Warn about foreshadows open for too many chapters."""
    warnings: list[ContinuityWarning] = []
    rows = (
        db.execute(
            select(MemoryForeshadow)
            .where(
                MemoryForeshadow.project_id == project_id,
                MemoryForeshadow.deleted_at.is_(None),
                MemoryForeshadow.resolved == 0,
            )
            .order_by(MemoryForeshadow.created_at.asc())
            .limit(50)
        )
        .scalars()
        .all()
    )

    for f in rows:
        status = str(getattr(f, "status", "") or "").strip()
        if status in ("resolved", "abandoned"):
            continue
        chapter_id = str(f.chapter_id or "").strip()
        if not chapter_id:
            continue
        # Find the chapter number for this foreshadow's source chapter
        source_ch = db.execute(
            select(Chapter.number).where(Chapter.id == chapter_id)
        ).scalar()
        if source_ch is None:
            continue
        try:
            source_num = int(source_ch)
        except (ValueError, TypeError):
            continue

        gap = chapter_number - source_num
        if gap >= FORESHADOW_OVERDUE_THRESHOLD:
            title = str(f.title or "").strip() or "未命名伏笔"
            warnings.append(ContinuityWarning(
                category="foreshadow",
                message=f"伏笔「{title}」已超过 {gap} 章未兑现（种下于第{source_num}章），请考虑回收或标记为放弃",
                severity="high" if gap >= 40 else "medium",
                source_ids=[str(f.id)],
            ))

    return warnings


def _check_relation_contradictions(
    db: Session,
    *,
    project_id: str,
) -> list[ContinuityWarning]:
    """Check for contradictory concurrent relations (e.g., A→B: ally AND enemy)."""
    warnings: list[ContinuityWarning] = []

    CONTRADICTING_TYPES = {
        ("ally", "enemy"), ("friend", "enemy"),
        ("romance", "enemy"), ("protects", "betrayed"),
        ("mentor", "enemy"),
    }

    rows = (
        db.execute(
            select(MemoryRelation)
            .where(
                MemoryRelation.project_id == project_id,
                MemoryRelation.deleted_at.is_(None),
            )
            .order_by(MemoryRelation.updated_at.desc())
            .limit(200)
        )
        .scalars()
        .all()
    )

    # Group by (from_entity_id, to_entity_id)
    pair_map: dict[tuple[str, str], list[MemoryRelation]] = {}
    for r in rows:
        key = (str(r.from_entity_id), str(r.to_entity_id))
        pair_map.setdefault(key, []).append(r)
        # Also check reverse direction
        rev_key = (str(r.to_entity_id), str(r.from_entity_id))
        pair_map.setdefault(rev_key, []).append(r)

    # Collect entity names for messages
    entity_ids = set()
    for r in rows:
        entity_ids.add(str(r.from_entity_id))
        entity_ids.add(str(r.to_entity_id))
    name_rows = (
        db.execute(
            select(MemoryEntity.id, MemoryEntity.name)
            .where(MemoryEntity.id.in_(list(entity_ids)))
        ).all()
        if entity_ids else []
    )
    name_by_id = {str(eid): str(name or "") for eid, name in name_rows}

    checked: set[frozenset[str]] = set()
    for (from_id, to_id), rels in pair_map.items():
        pair_key = frozenset([from_id, to_id])
        if pair_key in checked:
            continue
        checked.add(pair_key)

        rel_types = set()
        for r in rels:
            attrs_raw = r.attributes_json
            attrs = {}
            if attrs_raw:
                try:
                    attrs = json.loads(attrs_raw)
                except Exception:
                    pass
            status = str(attrs.get("status", "") or "").strip()
            if status == "past":
                continue
            rel_types.add(str(r.relation_type).strip().lower())

        for a, b in CONTRADICTING_TYPES:
            if a in rel_types and b in rel_types:
                from_name = name_by_id.get(from_id, from_id[:8])
                to_name = name_by_id.get(to_id, to_id[:8])
                warnings.append(ContinuityWarning(
                    category="relationship",
                    message=f"{from_name} 与 {to_name} 同时存在矛盾关系类型：{a} 和 {b}，请确认是否为角色转变",
                    severity="medium",
                ))

    return warnings


def _check_missing_characters(
    db: Session,
    *,
    project_id: str,
    chapter_number: int,
    chapter_plan: str,
    character_ids: list[str] | None,
) -> list[ContinuityWarning]:
    """Warn if a major character hasn't appeared in recent chapters."""
    warnings: list[ContinuityWarning] = []
    if chapter_number <= MISSING_CHARACTER_CHECK_GAP:
        return warnings

    characters = (
        db.execute(
            select(Character)
            .where(Character.project_id == project_id)
        )
        .scalars()
        .all()
    )
    # Only check protagonists and key supporting roles
    major_chars = [c for c in characters if str(c.role or "").strip().lower() in (
        "protagonist", "主角", "antagonist", "反派", "deuteragonist", "第二主角",
    )]
    if not major_chars:
        return warnings

    # Check if character is mentioned in recent chapter content
    selected_ids = set(character_ids or [])
    recent_chapters = (
        db.execute(
            select(Chapter.content_md)
            .where(
                Chapter.project_id == project_id,
                Chapter.number >= chapter_number - MISSING_CHARACTER_CHECK_GAP,
                Chapter.number < chapter_number,
            )
            .order_by(Chapter.number.desc())
            .limit(MISSING_CHARACTER_CHECK_GAP)
        )
        .scalars()
        .all()
    )
    recent_text = " ".join(str(c or "") for c in recent_chapters).lower()

    for char in major_chars:
        name = str(char.name or "").strip()
        if not name:
            continue
        if str(char.id) in selected_ids:
            continue  # Selected for this chapter, skip
        if name.lower() in recent_text:
            continue  # Appeared recently
        if name.lower() in (chapter_plan or "").lower():
            continue  # Planned for this chapter
        warnings.append(ContinuityWarning(
            category="character",
            message=f"主要角色「{name}」（{char.role or '未知角色'}）近 {MISSING_CHARACTER_CHECK_GAP} 章未出现，请考虑安排其出场或交代行踪",
            severity="low",
            source_ids=[str(char.id)],
        ))

    return warnings


def format_warnings_for_render(warnings: list[ContinuityWarning]) -> list[dict[str, str]]:
    """Convert warnings to dicts suitable for Jinja2 template rendering."""
    return [{"category": w.category, "message": w.message, "severity": w.severity} for w in warnings]
