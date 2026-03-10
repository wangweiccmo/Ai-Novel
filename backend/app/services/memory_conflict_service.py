from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.structured_memory import (
    MemoryEntity,
    MemoryEvidence,
    MemoryEvent,
    MemoryForeshadow,
    MemoryRelation,
)


def _safe_json_loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _value_differs(a: object, b: object) -> bool:
    if a is None or b is None:
        return False
    return str(a).strip() != str(b).strip()


def _attr_conflicts(existing: dict[str, Any], proposed: dict[str, Any]) -> list[tuple[str, object, object]]:
    out: list[tuple[str, object, object]] = []
    for key, value in proposed.items():
        if key in existing and existing.get(key) is not None and value is not None:
            if str(existing.get(key)).strip() != str(value).strip():
                out.append((key, existing.get(key), value))
    return out


def detect_memory_update_conflicts(
    *,
    db: Session,
    project_id: str,
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Best-effort conflict detection for structured memory updates.

    Rules (fail-soft):
    - Only checks upsert ops.
    - Flags when proposed values differ from existing non-empty values.
    - Detects duplicates within the same ops list.
    """

    conflicts: list[dict[str, Any]] = []
    seen_keys: dict[str, dict[str, Any]] = {}

    for item in items:
        if str(item.get("op") or "") != "upsert":
            continue

        idx = int(item.get("item_index") or 0)
        table = str(item.get("target_table") or "").strip()
        target_id = str(item.get("target_id") or "").strip() or None
        after = item.get("after") if isinstance(item.get("after"), dict) else {}

        # Dedup within ops (same logical key).
        if table == "entities":
            key = f"entities:{str(after.get('entity_type') or 'generic').strip()}:{str(after.get('name') or '').strip()}"
            if key.strip().endswith(":"):
                key = ""
        elif table == "relations":
            key = "relations:{from_id}:{rtype}:{to_id}".format(
                from_id=str(after.get("from_entity_id") or "").strip(),
                rtype=str(after.get("relation_type") or "").strip(),
                to_id=str(after.get("to_entity_id") or "").strip(),
            )
        elif table == "events":
            key = f"events:{str(after.get('chapter_id') or '').strip()}:{str(after.get('title') or '').strip()}"
        elif table == "foreshadows":
            key = f"foreshadows:{str(after.get('chapter_id') or '').strip()}:{str(after.get('title') or '').strip()}"
        else:
            key = ""

        if key:
            prev = seen_keys.get(key)
            if prev is not None and prev.get("after") != after:
                conflicts.append(
                    {
                        "item_index": idx,
                        "target_table": table,
                        "target_id": target_id,
                        "conflict_type": "duplicate_ops",
                        "message": "ops 内部存在相同对象的不同更新",
                        "existing": prev.get("after"),
                        "proposed": after,
                    }
                )
            else:
                seen_keys[key] = {"after": after, "item_index": idx}

        if table == "entities":
            entity_type = str(after.get("entity_type") or "generic").strip() or "generic"
            name = str(after.get("name") or "").strip()
            if not name:
                continue
            existing = None
            if target_id:
                existing = db.get(MemoryEntity, target_id)
                if existing is not None and str(existing.project_id) != str(project_id):
                    existing = None
            if existing is None:
                existing = (
                    db.execute(
                        select(MemoryEntity)
                        .where(MemoryEntity.project_id == project_id)
                        .where(MemoryEntity.entity_type == entity_type)
                        .where(MemoryEntity.name == name)
                        .where(MemoryEntity.deleted_at.is_(None))
                    )
                    .scalars()
                    .first()
                )
            if existing is None:
                continue

            if _value_differs(existing.entity_type, entity_type) or _value_differs(existing.name, name):
                conflicts.append(
                    {
                        "item_index": idx,
                        "target_table": table,
                        "target_id": target_id or str(existing.id),
                        "conflict_type": "identity_mismatch",
                        "message": "实体标识与现有记录不一致",
                        "existing": {"entity_type": existing.entity_type, "name": existing.name},
                        "proposed": {"entity_type": entity_type, "name": name},
                    }
                )

            if _value_differs(existing.summary_md, after.get("summary_md")):
                conflicts.append(
                    {
                        "item_index": idx,
                        "target_table": table,
                        "target_id": target_id or str(existing.id),
                        "conflict_type": "summary_mismatch",
                        "message": "实体摘要与现有记录不一致",
                        "existing": existing.summary_md,
                        "proposed": after.get("summary_md"),
                    }
                )

            proposed_attrs = after.get("attributes") if isinstance(after.get("attributes"), dict) else {}
            existing_attrs = _safe_json_loads(existing.attributes_json)
            for k, v_existing, v_proposed in _attr_conflicts(existing_attrs, proposed_attrs):
                conflicts.append(
                    {
                        "item_index": idx,
                        "target_table": table,
                        "target_id": target_id or str(existing.id),
                        "conflict_type": "attributes_mismatch",
                        "field": k,
                        "message": "实体属性与现有记录不一致",
                        "existing": v_existing,
                        "proposed": v_proposed,
                    }
                )

        elif table == "relations":
            from_id = str(after.get("from_entity_id") or "").strip()
            to_id = str(after.get("to_entity_id") or "").strip()
            rtype = str(after.get("relation_type") or "related_to").strip() or "related_to"
            if not from_id or not to_id:
                continue
            existing = None
            if target_id:
                existing = db.get(MemoryRelation, target_id)
                if existing is not None and str(existing.project_id) != str(project_id):
                    existing = None
            if existing is None:
                existing = (
                    db.execute(
                        select(MemoryRelation)
                        .where(MemoryRelation.project_id == project_id)
                        .where(MemoryRelation.from_entity_id == from_id)
                        .where(MemoryRelation.to_entity_id == to_id)
                        .where(MemoryRelation.relation_type == rtype)
                        .where(MemoryRelation.deleted_at.is_(None))
                    )
                    .scalars()
                    .first()
                )
            if existing is None:
                continue

            if _value_differs(existing.description_md, after.get("description_md")):
                conflicts.append(
                    {
                        "item_index": idx,
                        "target_table": table,
                        "target_id": target_id or str(existing.id),
                        "conflict_type": "description_mismatch",
                        "message": "关系描述与现有记录不一致",
                        "existing": existing.description_md,
                        "proposed": after.get("description_md"),
                    }
                )

            proposed_attrs = after.get("attributes") if isinstance(after.get("attributes"), dict) else {}
            existing_attrs = _safe_json_loads(existing.attributes_json)
            for k, v_existing, v_proposed in _attr_conflicts(existing_attrs, proposed_attrs):
                conflicts.append(
                    {
                        "item_index": idx,
                        "target_table": table,
                        "target_id": target_id or str(existing.id),
                        "conflict_type": "attributes_mismatch",
                        "field": k,
                        "message": "关系属性与现有记录不一致",
                        "existing": v_existing,
                        "proposed": v_proposed,
                    }
                )

        elif table == "events":
            existing = None
            if target_id:
                existing = db.get(MemoryEvent, target_id)
                if existing is not None and str(existing.project_id) != str(project_id):
                    existing = None
            if existing is None:
                continue
            if _value_differs(existing.title, after.get("title")) or _value_differs(existing.content_md, after.get("content_md")):
                conflicts.append(
                    {
                        "item_index": idx,
                        "target_table": table,
                        "target_id": target_id or str(existing.id),
                        "conflict_type": "event_mismatch",
                        "message": "事件内容与现有记录不一致",
                        "existing": {"title": existing.title, "content_md": existing.content_md},
                        "proposed": {"title": after.get("title"), "content_md": after.get("content_md")},
                    }
                )

        elif table == "foreshadows":
            existing = None
            if target_id:
                existing = db.get(MemoryForeshadow, target_id)
                if existing is not None and str(existing.project_id) != str(project_id):
                    existing = None
            if existing is None:
                continue
            if _value_differs(existing.title, after.get("title")) or _value_differs(existing.content_md, after.get("content_md")):
                conflicts.append(
                    {
                        "item_index": idx,
                        "target_table": table,
                        "target_id": target_id or str(existing.id),
                        "conflict_type": "foreshadow_mismatch",
                        "message": "伏笔内容与现有记录不一致",
                        "existing": {"title": existing.title, "content_md": existing.content_md},
                        "proposed": {"title": after.get("title"), "content_md": after.get("content_md")},
                    }
                )

        elif table == "evidence":
            existing = None
            if target_id:
                existing = db.get(MemoryEvidence, target_id)
                if existing is not None and str(existing.project_id) != str(project_id):
                    existing = None
            if existing is None:
                continue
            if _value_differs(existing.quote_md, after.get("quote_md")):
                conflicts.append(
                    {
                        "item_index": idx,
                        "target_table": table,
                        "target_id": target_id or str(existing.id),
                        "conflict_type": "evidence_mismatch",
                        "message": "证据内容与现有记录不一致",
                        "existing": existing.quote_md,
                        "proposed": after.get("quote_md"),
                    }
                )

    return conflicts
