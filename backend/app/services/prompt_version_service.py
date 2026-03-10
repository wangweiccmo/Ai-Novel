from __future__ import annotations

import json
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.db.utils import new_id, utc_now
from app.models.prompt_block import PromptBlock
from app.models.prompt_preset import PromptPreset
from app.models.prompt_preset_version import PromptPresetVersion
from app.services.prompt_presets import parse_json_dict, parse_json_list


def _preset_snapshot(*, preset: PromptPreset, blocks: list[PromptBlock]) -> dict[str, Any]:
    return {
        "preset": {
            "name": preset.name,
            "category": preset.category,
            "scope": preset.scope,
            "version": int(preset.version or 1),
            "active_for": parse_json_list(preset.active_for_json),
        },
        "blocks": [
            {
                "identifier": b.identifier,
                "name": b.name,
                "role": b.role,
                "enabled": bool(b.enabled),
                "template": b.template,
                "marker_key": b.marker_key,
                "injection_position": b.injection_position,
                "injection_depth": b.injection_depth,
                "injection_order": int(b.injection_order),
                "triggers": parse_json_list(b.triggers_json),
                "forbid_overrides": bool(b.forbid_overrides),
                "budget": parse_json_dict(b.budget_json),
                "cache": parse_json_dict(b.cache_json),
            }
            for b in sorted(blocks, key=lambda x: (int(x.injection_order or 0), str(x.identifier or "")))
        ],
    }


def record_prompt_preset_version(
    *,
    db: Session,
    preset: PromptPreset,
    actor_user_id: str | None,
    note: str | None = None,
) -> PromptPresetVersion:
    blocks = (
        db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset.id).order_by(PromptBlock.injection_order.asc()))
        .scalars()
        .all()
    )
    snapshot = _preset_snapshot(preset=preset, blocks=blocks)
    raw_snapshot = json.dumps(snapshot, ensure_ascii=False)

    max_version = (
        db.execute(select(func.max(PromptPresetVersion.version)).where(PromptPresetVersion.preset_id == preset.id)).scalar()
    )
    next_version = int(max_version or 0) + 1

    row = PromptPresetVersion(
        id=new_id(),
        project_id=preset.project_id,
        preset_id=preset.id,
        actor_user_id=str(actor_user_id or "").strip() or None,
        version=next_version,
        preset_version=int(preset.version or 1),
        note=(str(note or "").strip() or None),
        snapshot_json=raw_snapshot,
    )
    db.add(row)
    return row


def rollback_prompt_preset_to_version(
    *,
    db: Session,
    preset: PromptPreset,
    version_row: PromptPresetVersion,
    actor_user_id: str | None,
) -> PromptPreset:
    try:
        data = json.loads(version_row.snapshot_json or "{}")
    except Exception as exc:
        raise AppError.validation(message="版本快照损坏，无法回滚") from exc

    if not isinstance(data, dict):
        raise AppError.validation(message="版本快照无效，无法回滚")

    preset_info = data.get("preset")
    blocks = data.get("blocks")
    if not isinstance(preset_info, dict) or not isinstance(blocks, list):
        raise AppError.validation(message="版本快照结构不完整，无法回滚")

    # Record current state before rollback.
    record_prompt_preset_version(
        db=db,
        preset=preset,
        actor_user_id=actor_user_id,
        note=f"rollback_before:{version_row.version}",
    )

    preset.name = str(preset_info.get("name") or preset.name)
    preset.category = preset_info.get("category")
    preset.scope = str(preset_info.get("scope") or preset.scope)
    preset.version = int(preset_info.get("version") or preset.version or 1)
    preset.active_for_json = json.dumps(list(preset_info.get("active_for") or []), ensure_ascii=False)
    preset.updated_at = utc_now()

    # Replace blocks.
    existing_blocks = db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset.id)).scalars().all()
    for b in existing_blocks:
        db.delete(b)
    db.flush()

    for idx, b in enumerate(blocks):
        if not isinstance(b, dict):
            continue
        db.add(
            PromptBlock(
                id=new_id(),
                preset_id=preset.id,
                identifier=str(b.get("identifier") or "").strip() or f"block_{idx}",
                name=str(b.get("name") or "").strip() or f"Block {idx + 1}",
                role=str(b.get("role") or "system").strip() or "system",
                enabled=bool(b.get("enabled", True)),
                template=b.get("template"),
                marker_key=b.get("marker_key"),
                injection_position=str(b.get("injection_position") or "relative").strip() or "relative",
                injection_depth=b.get("injection_depth"),
                injection_order=int(b.get("injection_order") or idx),
                triggers_json=json.dumps(list(b.get("triggers") or []), ensure_ascii=False),
                forbid_overrides=bool(b.get("forbid_overrides", False)),
                budget_json=json.dumps(b.get("budget") or {}, ensure_ascii=False) if b.get("budget") else None,
                cache_json=json.dumps(b.get("cache") or {}, ensure_ascii=False) if b.get("cache") else None,
            )
        )

    return preset
