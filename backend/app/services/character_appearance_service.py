"""Character appearance frequency monitoring.

Tracks which characters appear in each chapter and warns when important
characters have been absent for too long.  Purely rule-based — no LLM call.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, load_only

from app.models.chapter import Chapter
from app.models.character import Character

logger = logging.getLogger("ainovel")

# Thresholds
_MAJOR_ROLE_LABELS = {"主角", "protagonist", "main", "主要角色"}
_SUPPORTING_ROLE_LABELS = {"配角", "supporting", "重要配角"}
_MAJOR_ABSENT_THRESHOLD = 15   # chapters before warning for major roles
_SUPPORTING_ABSENT_THRESHOLD = 30  # chapters before warning for supporting roles


@dataclass
class AppearanceWarning:
    character_name: str
    role: str
    last_seen_chapter: int | None
    absent_chapters: int
    severity: str  # "high" | "medium"


def _count_character_mentions(content: str, name: str) -> int:
    """Simple substring count for character name mentions."""
    if not content or not name:
        return 0
    return content.count(name)


def scan_character_appearances(
    db: Session,
    *,
    project_id: str,
    current_chapter_number: int,
) -> list[AppearanceWarning]:
    """Scan recent chapters for character appearances and flag absences."""
    characters = (
        db.execute(
            select(Character)
            .options(load_only(Character.id, Character.name, Character.role))
            .where(Character.project_id == project_id)
        )
        .scalars()
        .all()
    )
    if not characters:
        return []

    # Load recent chapter content (last N chapters to scan)
    scan_window = max(_MAJOR_ABSENT_THRESHOLD, _SUPPORTING_ABSENT_THRESHOLD) + 5
    chapters = (
        db.execute(
            select(Chapter)
            .options(load_only(Chapter.id, Chapter.number, Chapter.content))
            .where(Chapter.project_id == project_id)
            .where(Chapter.number.isnot(None))
            .where(Chapter.number <= current_chapter_number)
            .order_by(Chapter.number.desc())
            .limit(scan_window)
        )
        .scalars()
        .all()
    )
    if not chapters:
        return []

    # Build chapter_number → content map
    chapter_contents: dict[int, str] = {}
    for ch in chapters:
        if ch.number is not None:
            chapter_contents[int(ch.number)] = str(ch.content or "")

    warnings: list[AppearanceWarning] = []

    for char in characters:
        name = str(char.name or "").strip()
        if not name or len(name) < 2:
            continue
        role = str(char.role or "").strip().lower()

        # Determine threshold based on role
        is_major = any(label in role for label in _MAJOR_ROLE_LABELS)
        is_supporting = any(label in role for label in _SUPPORTING_ROLE_LABELS)
        if not is_major and not is_supporting:
            continue  # Only track named-role characters

        threshold = _MAJOR_ABSENT_THRESHOLD if is_major else _SUPPORTING_ABSENT_THRESHOLD

        # Find last chapter where this character appeared
        last_seen: int | None = None
        for ch_num in sorted(chapter_contents.keys(), reverse=True):
            content = chapter_contents[ch_num]
            if _count_character_mentions(content, name) > 0:
                last_seen = ch_num
                break

        if last_seen is None:
            absent = current_chapter_number
        else:
            absent = current_chapter_number - last_seen

        if absent >= threshold:
            warnings.append(AppearanceWarning(
                character_name=name,
                role=str(char.role or ""),
                last_seen_chapter=last_seen,
                absent_chapters=absent,
                severity="high" if is_major else "medium",
            ))

    # Sort by severity then absent chapters
    warnings.sort(key=lambda w: (0 if w.severity == "high" else 1, -w.absent_chapters))
    return warnings


def format_appearance_warnings(warnings: list[AppearanceWarning]) -> list[dict[str, Any]]:
    """Format warnings for template rendering."""
    return [
        {
            "category": "角色失踪",
            "character_name": w.character_name,
            "role": w.role,
            "message": (
                f"角色「{w.character_name}」（{w.role}）已 {w.absent_chapters} 章未出场"
                + (f"，上次出现在第 {w.last_seen_chapter} 章" if w.last_seen_chapter else "")
            ),
            "severity": w.severity,
        }
        for w in warnings
    ]
