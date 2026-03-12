from __future__ import annotations

import json
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session, load_only

from app.core.errors import AppError
from app.models.character import Character
from app.models.project_default_style import ProjectDefaultStyle
from app.models.writing_style import WritingStyle


StyleResolutionSource = Literal["request", "project_default", "settings_fallback", "none", "disabled"]


def _load_scene_overrides(style: WritingStyle) -> dict[str, str]:
    """Parse scene_overrides_json from a WritingStyle, returning {} on failure."""
    raw = getattr(style, "scene_overrides_json", None)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return {str(k): str(v) for k, v in parsed.items() if isinstance(v, str)}
    except Exception:
        pass
    return {}


def resolve_style_guide(
    db: Session,
    *,
    project_id: str,
    user_id: str,
    requested_style_id: str | None,
    include_style_guide: bool,
    settings_style_guide: str,
    scene_type: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """
    Resolve the effective style_guide text for prompt rendering.

    Priority: request(style_id) > project_default(style_id) > settings_style_guide fallback.
    If scene_type is provided, appends scene-specific override text.
    """
    if not include_style_guide:
        return "", {"style_id": None, "source": "disabled"}

    settings_style_guide = (settings_style_guide or "").strip()

    def _can_use_style(style: WritingStyle) -> bool:
        return bool(style.is_preset) or (style.owner_user_id == user_id)

    def _apply_scene_override(base: str, style: WritingStyle | None) -> str:
        if not scene_type or not style:
            return base
        overrides = _load_scene_overrides(style)
        scene_text = overrides.get(scene_type, "").strip()
        if not scene_text:
            return base
        return f"{base}\n\n【{scene_type}场景风格补充】\n{scene_text}".strip()

    if requested_style_id is not None:
        style = db.get(WritingStyle, requested_style_id)
        if style is None:
            raise AppError.validation(message="style_id 不存在")
        if not _can_use_style(style):
            raise AppError.forbidden(message="无权限使用该风格")
        text = _apply_scene_override((style.prompt_content or "").strip(), style)
        return text, {"style_id": style.id, "source": "request", "scene_type": scene_type}

    default = db.get(ProjectDefaultStyle, project_id)
    if default is not None and default.style_id:
        style = db.get(WritingStyle, default.style_id)
        if style is not None and _can_use_style(style):
            text = _apply_scene_override((style.prompt_content or "").strip(), style)
            return text, {"style_id": style.id, "source": "project_default", "scene_type": scene_type}

    if settings_style_guide:
        return settings_style_guide, {"style_id": None, "source": "settings_fallback"}

    return "", {"style_id": None, "source": "none"}


def _load_character_voice_samples(db: Session, *, project_id: str, character_names: list[str]) -> list[dict[str, str]]:
    """Load voice_samples for named characters in this project."""
    if not character_names:
        return []
    rows = (
        db.execute(
            select(Character)
            .options(load_only(Character.name, Character.voice_samples_json))
            .where(Character.project_id == project_id)
            .where(Character.name.in_(character_names))
        )
        .scalars()
        .all()
    )
    result: list[dict[str, str]] = []
    for row in rows:
        raw = getattr(row, "voice_samples_json", None)
        if not raw:
            continue
        try:
            samples = json.loads(raw)
        except Exception:
            continue
        if isinstance(samples, list) and samples:
            result.append({
                "name": str(row.name or ""),
                "samples": [str(s) for s in samples[:5] if isinstance(s, str) and s.strip()],
            })
    return result


def resolve_composite_style(
    db: Session,
    *,
    project_id: str,
    user_id: str,
    requested_style_id: str | None,
    include_style_guide: bool,
    settings_style_guide: str,
    scene_type: str | None = None,
    character_names: list[str] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Resolve a composite style: base + scene override + character voice layer.

    Combines:
    1. Base style (from resolve_style_guide)
    2. Scene-specific override (already handled by resolve_style_guide)
    3. Character voice samples (new layer)

    The character voice layer is appended as a reference section so the LLM
    can match dialogue style to each character.
    """
    base_text, meta = resolve_style_guide(
        db,
        project_id=project_id,
        user_id=user_id,
        requested_style_id=requested_style_id,
        include_style_guide=include_style_guide,
        settings_style_guide=settings_style_guide,
        scene_type=scene_type,
    )

    # Character voice layer
    voices = _load_character_voice_samples(db, project_id=project_id, character_names=character_names or [])
    if voices:
        voice_lines: list[str] = ["", "【角色语气参考】"]
        for v in voices:
            name = v["name"]
            samples = v.get("samples", [])
            if samples:
                voice_lines.append(f"◆ {name}：")
                for s in samples:
                    voice_lines.append(f"  「{s}」")
        voice_text = "\n".join(voice_lines)
        base_text = f"{base_text}\n{voice_text}".strip()
        meta["character_voices"] = [v["name"] for v in voices]
        meta["layers"] = ["base", "scene" if scene_type else None, "character_voice"]
        meta["layers"] = [l for l in meta["layers"] if l]
    else:
        meta["layers"] = ["base"] + (["scene"] if scene_type else [])

    return base_text, meta

