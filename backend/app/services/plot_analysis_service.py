from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.logging import exception_log_fields, log_event, redact_secrets_text
from app.db.session import SessionLocal
from app.db.utils import new_id, utc_now
from app.models.chapter import Chapter
from app.models.generation_run import GenerationRun
from app.models.llm_preset import LLMPreset
from app.models.plot_analysis import PlotAnalysis
from app.models.project import Project
from app.models.project_settings import ProjectSettings
from app.models.project_task import ProjectTask
from app.models.story_memory import StoryMemory
from app.schemas.chapter_analysis import ChapterAnalyzeRequest
from app.services.chapter_context_service import build_chapter_analyze_render_values
from app.services.generation_service import prepare_llm_call
from app.services.llm_key_resolver import resolve_api_key_for_project
from app.services.llm_task_preset_resolver import resolve_task_llm_config
from app.services.llm_retry import (
    LlmRetryExhausted,
    call_llm_and_record_with_retries,
    task_llm_max_attempts,
    task_llm_retry_base_seconds,
    task_llm_retry_jitter,
    task_llm_retry_max_seconds,
)
from app.services.output_contracts import contract_for_task
from app.services.project_task_event_service import emit_and_enqueue_project_task
from app.services.task_queue import get_task_queue
from app.services.prompt_presets import ensure_default_chapter_analyze_preset, render_preset_for_task
from app.services.search_index_service import schedule_search_rebuild_task
from app.services.vector_rag_service import schedule_vector_rebuild_task

_MANAGED_MEMORY_TYPES = {"chapter_summary", "hook", "plot_point", "foreshadow", "character_state"}
_QUALITY_TOKEN_RE = re.compile(r"[A-Za-z0-9]+|[\u4e00-\u9fff]")

logger = logging.getLogger("ainovel")

PLOT_AUTO_UPDATE_KIND = "plot_auto_update"

_ANALYSIS_SCHEMA_V1_TOP_LEVEL_KEYS = {
    "schema_version",
    "chapter_summary",
    "hooks",
    "foreshadows",
    "plot_points",
    "character_states",
    "suggestions",
    "overall_notes",
}

_ANALYSIS_SCHEMA_V1_LIST_ITEM_KEYS: dict[str, set[str]] = {
    "hooks": {"excerpt", "note"},
    "foreshadows": {"excerpt", "note", "type"},
    "plot_points": {"beat", "excerpt"},
    "character_states": {"character_name", "state_before", "state_after", "psychological_change"},
    "suggestions": {"title", "excerpt", "issue", "recommendation", "priority"},
}


def _resolve_plot_llm_call(
    *,
    db: Session,
    project: Project,
    actor_user_id: str,
) -> tuple[object, str] | None:
    missing_key_exc: AppError | None = None
    try:
        resolved_task = resolve_task_llm_config(
            db,
            project=project,
            user_id=actor_user_id,
            task_key=PLOT_AUTO_UPDATE_KIND,
            header_api_key=None,
        )
    except OperationalError:
        resolved_task = None
    except AppError as exc:
        if str(exc.code or "") != "LLM_KEY_MISSING":
            raise
        missing_key_exc = exc
        resolved_task = None

    if resolved_task is not None:
        return resolved_task.llm_call, str(resolved_task.api_key)

    preset = db.get(LLMPreset, project.id)
    if preset is None:
        if missing_key_exc is not None:
            raise missing_key_exc
        return None

    api_key = resolve_api_key_for_project(db, project=project, user_id=actor_user_id, header_api_key=None)
    return prepare_llm_call(preset), str(api_key)


def _canonical_json(value: dict[str, Any]) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except TypeError:
        raise AppError(code="ANALYSIS_PARSE_ERROR", message="analysis 无法序列化为 JSON", status_code=400)


def compute_analysis_hash(analysis: dict[str, Any]) -> tuple[str, str]:
    canonical = _canonical_json(analysis)
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return canonical, digest


def validate_analysis_payload(analysis: object) -> dict[str, Any]:
    if not isinstance(analysis, dict):
        raise AppError(code="ANALYSIS_PARSE_ERROR", message="analysis 必须是 JSON object", status_code=400)

    schema_version = analysis.get("schema_version")
    if schema_version is not None:
        if isinstance(schema_version, bool) or not isinstance(schema_version, (int, float)):
            raise AppError(code="ANALYSIS_SCHEMA_ERROR", message="analysis.schema_version 必须是 number", status_code=400)
        if int(schema_version) != 1:
            raise AppError(code="ANALYSIS_SCHEMA_ERROR", message="analysis.schema_version 不支持（仅支持 1）", status_code=400)

    unknown_top_level = sorted(set(analysis.keys()) - _ANALYSIS_SCHEMA_V1_TOP_LEVEL_KEYS)
    if unknown_top_level:
        raise AppError(
            code="ANALYSIS_SCHEMA_ERROR",
            message="analysis 含未知字段",
            status_code=400,
            details={"unknown_fields": unknown_top_level},
        )

    def _ensure_str_field(key: str) -> None:
        if key not in analysis or analysis[key] is None:
            return
        if not isinstance(analysis[key], str):
            raise AppError(code="ANALYSIS_PARSE_ERROR", message=f"analysis.{key} 必须是 string", status_code=400)

    def _ensure_list_of_objects(key: str) -> None:
        if key not in analysis or analysis[key] is None:
            return
        value = analysis[key]
        if not isinstance(value, list):
            raise AppError(code="ANALYSIS_PARSE_ERROR", message=f"analysis.{key} 必须是 list", status_code=400)
        for idx, item in enumerate(value):
            if not isinstance(item, dict):
                raise AppError(
                    code="ANALYSIS_PARSE_ERROR",
                    message=f"analysis.{key}[{idx}] 必须是 object",
                    status_code=400,
                )
            allowed = _ANALYSIS_SCHEMA_V1_LIST_ITEM_KEYS.get(key)
            if allowed is None:
                continue
            unknown_item = sorted(set(item.keys()) - allowed)
            if unknown_item:
                raise AppError(
                    code="ANALYSIS_SCHEMA_ERROR",
                    message=f"analysis.{key}[{idx}] 含未知字段",
                    status_code=400,
                    details={"unknown_fields": unknown_item},
                )

            for k, v in item.items():
                if v is None:
                    continue
                # Schema v1 list items are strings only.
                if not isinstance(v, str):
                    raise AppError(code="ANALYSIS_PARSE_ERROR", message=f"analysis.{key}[{idx}].{k} 必须是 string", status_code=400)

    _ensure_str_field("chapter_summary")
    _ensure_str_field("overall_notes")
    _ensure_list_of_objects("hooks")
    _ensure_list_of_objects("plot_points")
    _ensure_list_of_objects("foreshadows")
    _ensure_list_of_objects("character_states")
    _ensure_list_of_objects("suggestions")
    return analysis


def _clamp01(value: float) -> float:
    if value < 0:
        return 0.0
    if value > 1:
        return 1.0
    return float(value)


def _list_len(value: object) -> int:
    return int(len(value)) if isinstance(value, list) else 0


def _count_words(text: str | None) -> int:
    if not text:
        return 0
    return int(len(_QUALITY_TOKEN_RE.findall(text)))


def _length_score(words: int) -> float:
    if words <= 0:
        return 0.0
    if words < 300:
        return _clamp01(words / 300.0)
    if words <= 1800:
        return 1.0
    if words <= 3600:
        return 0.9
    if words <= 6000:
        return 0.8
    return 0.7


def compute_quality_scores(*, analysis: dict[str, Any], content_md: str | None) -> dict[str, Any]:
    hooks = _list_len(analysis.get("hooks"))
    foreshadows = _list_len(analysis.get("foreshadows"))
    plot_points = _list_len(analysis.get("plot_points"))
    suggestions = _list_len(analysis.get("suggestions"))
    summary_present = bool(str(analysis.get("chapter_summary") or "").strip())
    words = _count_words(content_md)

    hook_score = min(hooks / 2.0, 1.0)
    foreshadow_score = min(foreshadows / 2.0, 1.0)
    plot_score = min(plot_points / 4.0, 1.0)
    length_score = _length_score(words)

    coherence = _clamp01(0.35 + 0.35 * plot_score + 0.3 * (1.0 if summary_present else 0.0))
    engagement = _clamp01(0.3 + 0.35 * hook_score + 0.35 * foreshadow_score)
    pacing = _clamp01(0.2 + 0.4 * plot_score + 0.4 * length_score)
    base = (coherence + engagement + pacing) / 3.0
    penalty = min(float(suggestions), 6.0) * 0.03
    overall = _clamp01(base - penalty)

    report_md = (
        "## 质量评估（v1 / heuristic）\n"
        f"- 字数（approx）：{words}\n"
        f"- Hooks：{hooks} | Foreshadows：{foreshadows} | Plot Points：{plot_points} | Suggestions：{suggestions}\n"
        f"- 整体：{overall:.2f} | 连贯：{coherence:.2f} | 张力：{engagement:.2f} | 节奏：{pacing:.2f}\n"
        "\n"
        "说明：该评分为启发式估计，主要基于章节结构密度与分析产物数量，用于趋势参考而非绝对评判。"
    )

    return {
        "schema_version": "quality_v1",
        "method": "heuristic",
        "word_count": words,
        "counts": {
            "hooks": hooks,
            "foreshadows": foreshadows,
            "plot_points": plot_points,
            "suggestions": suggestions,
            "summary_present": int(summary_present),
        },
        "scores": {
            "overall": overall,
            "coherence": coherence,
            "engagement": engagement,
            "pacing": pacing,
        },
        "report_md": report_md,
    }


def _importance_from_item(item: dict[str, Any], default: float) -> float:
    for k in ("importance_score", "importance", "strength"):
        v = item.get(k)
        if isinstance(v, (int, float)):
            num = float(v)
            if k in ("importance", "strength") and num > 1:
                num = num / 10.0
            return _clamp01(num)
    return _clamp01(default)


_WORLDBOOK_STYLE_PREFIXES = (
    "地点",
    "物品",
    "设定",
    "世界观",
    "势力",
    "组织",
    "条目",
    "世界书",
)


def _looks_like_worldbook_entry(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    for prefix in _WORLDBOOK_STYLE_PREFIXES:
        if t.startswith(prefix) and t[len(prefix) :].startswith(("：", ":")):
            return True
        if t.startswith(f"【{prefix}") and "】" in t[:8]:
            return True
    return False


def _find_position(content_md: str, needle: str) -> tuple[int, int]:
    text = (content_md or "")
    target = (needle or "").strip()
    if not text or not target:
        return -1, 0
    idx = text.find(target)
    if idx < 0:
        return -1, 0
    return int(idx), int(len(target))


def extract_story_memory_seeds(
    *,
    chapter_number: int,
    analysis: dict[str, Any],
    content_md: str,
) -> list[dict[str, Any]]:
    seeds: list[dict[str, Any]] = []
    timeline = int(chapter_number)

    chapter_summary = str(analysis.get("chapter_summary") or "").strip()
    if not chapter_summary:
        points = analysis.get("plot_points")
        pieces: list[str] = []
        if isinstance(points, list):
            for item in points:
                if not isinstance(item, dict):
                    continue
                beat = str(item.get("beat") or "").strip()
                excerpt = str(item.get("excerpt") or "").strip()
                if beat:
                    pieces.append(beat)
                elif excerpt:
                    pieces.append(excerpt)
                if len(pieces) >= 3:
                    break
        if pieces:
            chapter_summary = "；".join(pieces).strip()
    if not chapter_summary:
        chapter_summary = (content_md or "").strip()[:300].strip()
    if not chapter_summary:
        chapter_summary = "（未生成摘要）"

    seeds.append(
        {
            "memory_type": "chapter_summary",
            "title": None,
            "content": chapter_summary,
            "full_context_md": None,
            "importance_score": 1.0,
            "tags": ["chapter_summary"],
            "story_timeline": timeline,
            "text_position": -1,
            "text_length": 0,
            "is_foreshadow": 0,
            "foreshadow_resolved_at_chapter_id": None,
            "metadata": None,
        }
    )

    hooks = analysis.get("hooks")
    if isinstance(hooks, list):
        for item in hooks:
            if not isinstance(item, dict):
                continue
            excerpt = str(item.get("excerpt") or "").strip()
            note = str(item.get("note") or "").strip()
            content = note or excerpt
            if not content:
                continue
            pos, length = _find_position(content_md, excerpt)
            seeds.append(
                {
                    "memory_type": "hook",
                    "title": excerpt[:80].strip() or None,
                    "content": content,
                    "full_context_md": None,
                    "importance_score": _importance_from_item(item, 0.7),
                    "tags": ["hook"],
                    "story_timeline": timeline,
                    "text_position": pos,
                    "text_length": length,
                    "is_foreshadow": 0,
                    "foreshadow_resolved_at_chapter_id": None,
                    "metadata": None,
                }
            )

    plot_points = analysis.get("plot_points")
    if isinstance(plot_points, list):
        for item in plot_points:
            if not isinstance(item, dict):
                continue
            beat = str(item.get("beat") or "").strip()
            excerpt = str(item.get("excerpt") or "").strip()
            if beat and _looks_like_worldbook_entry(beat):
                if not excerpt:
                    continue
                beat = ""
            content = beat or excerpt
            if not content:
                continue
            pos, length = _find_position(content_md, excerpt)
            seeds.append(
                {
                    "memory_type": "plot_point",
                    "title": beat[:80].strip() or None,
                    "content": content,
                    "full_context_md": None,
                    "importance_score": _importance_from_item(item, 0.6),
                    "tags": ["plot_point"],
                    "story_timeline": timeline,
                    "text_position": pos,
                    "text_length": length,
                    "is_foreshadow": 0,
                    "foreshadow_resolved_at_chapter_id": None,
                    "metadata": None,
                }
            )

    foreshadows = analysis.get("foreshadows")
    if isinstance(foreshadows, list):
        for item in foreshadows:
            if not isinstance(item, dict):
                continue
            excerpt = str(item.get("excerpt") or "").strip()
            note = str(item.get("note") or "").strip()
            content = note or excerpt
            if not content:
                continue
            foreshadow_state = 1
            kind = str(item.get("type") or "").strip().lower()
            if kind in {"resolved", "resolve", "resolved_at"}:
                foreshadow_state = 2
            pos, length = _find_position(content_md, excerpt)
            seeds.append(
                {
                    "memory_type": "foreshadow",
                    "title": excerpt[:80].strip() or None,
                    "content": content,
                    "full_context_md": None,
                    "importance_score": _importance_from_item(item, 0.8),
                    "tags": ["foreshadow"],
                    "story_timeline": timeline,
                    "text_position": pos,
                    "text_length": length,
                    "is_foreshadow": foreshadow_state,
                    "foreshadow_resolved_at_chapter_id": None,
                    "metadata": None,
                }
            )

    character_states = analysis.get("character_states")
    if isinstance(character_states, list):
        for item in character_states:
            if not isinstance(item, dict):
                continue
            character_name = str(item.get("character_name") or "").strip()
            state_before = str(item.get("state_before") or "").strip()
            state_after = str(item.get("state_after") or "").strip()
            psychological_change = str(item.get("psychological_change") or "").strip()
            content_parts = [p for p in [state_before, state_after, psychological_change] if p]
            if not content_parts:
                continue
            content = "\n".join(content_parts)
            seeds.append(
                {
                    "memory_type": "character_state",
                    "title": character_name[:80].strip() or None,
                    "content": content,
                    "full_context_md": None,
                    "importance_score": _importance_from_item(item, 0.7),
                    "tags": ["character_state"],
                    "story_timeline": timeline,
                    "text_position": -1,
                    "text_length": 0,
                    "is_foreshadow": 0,
                    "foreshadow_resolved_at_chapter_id": None,
                    "metadata": None,
                }
            )

    return seeds


def apply_chapter_analysis(
    *,
    db: Session,
    request_id: str,
    actor_user_id: str | None,
    project_id: str,
    chapter_id: str,
    chapter_number: int,
    analysis: object,
    draft_content_md: str | None,
) -> dict[str, Any]:
    validated = validate_analysis_payload(analysis)
    canonical_json, analysis_hash = compute_analysis_hash(validated)

    existing = (
        db.execute(select(PlotAnalysis).where(PlotAnalysis.chapter_id == chapter_id).limit(1))
        .scalars()
        .first()
    )

    if existing is not None:
        existing_hash = hashlib.sha256((existing.analysis_json or "").encode("utf-8")).hexdigest()
        if existing_hash == analysis_hash:
            memories = (
                db.execute(
                    select(StoryMemory)
                    .where(StoryMemory.project_id == project_id, StoryMemory.chapter_id == chapter_id)
                    .order_by(StoryMemory.importance_score.desc(), StoryMemory.created_at.asc())
                )
                .scalars()
                .all()
            )
            quality = compute_quality_scores(analysis=validated, content_md=draft_content_md or "")
            return {
                "idempotent": True,
                "analysis_hash": analysis_hash,
                "plot_analysis_id": existing.id,
                "memories": [_story_memory_out(m) for m in memories],
                "quality_scores": quality,
            }

    content_md = draft_content_md or ""
    seeds = extract_story_memory_seeds(chapter_number=chapter_number, analysis=validated, content_md=content_md)

    now = utc_now()
    try:
        def _int_or_default(value: object, default: int) -> int:
            if value is None:
                return int(default)
            if isinstance(value, bool):
                return int(default)
            if isinstance(value, int):
                return int(value)
            if isinstance(value, float) and value.is_integer():
                return int(value)
            return int(default)

        quality = compute_quality_scores(analysis=validated, content_md=content_md)

        if existing is None:
            plot = PlotAnalysis(
                id=new_id(),
                project_id=project_id,
                chapter_id=chapter_id,
                analysis_json=canonical_json,
                created_at=now,
            )
            db.add(plot)
        else:
            existing.analysis_json = canonical_json
            existing.created_at = now
            plot = existing

        plot.overall_quality_score = float(quality["scores"]["overall"])
        plot.coherence_score = float(quality["scores"]["coherence"])
        plot.engagement_score = float(quality["scores"]["engagement"])
        plot.pacing_score = float(quality["scores"]["pacing"])
        plot.analysis_report_md = str(quality.get("report_md") or "")

        db.execute(
            delete(StoryMemory).where(
                StoryMemory.project_id == project_id,
                StoryMemory.chapter_id == chapter_id,
                StoryMemory.memory_type.in_(sorted(_MANAGED_MEMORY_TYPES)),
            )
        )

        created: list[StoryMemory] = []
        for seed in seeds:
            tags = seed.get("tags") or []
            tags_json = json.dumps(tags, ensure_ascii=False) if tags else None
            metadata = seed.get("metadata")
            metadata_json = json.dumps(metadata, ensure_ascii=False) if isinstance(metadata, dict) else None
            created.append(
                StoryMemory(
                    id=new_id(),
                    project_id=project_id,
                    chapter_id=chapter_id,
                    memory_type=str(seed.get("memory_type") or ""),
                    title=seed.get("title"),
                    content=str(seed.get("content") or ""),
                    full_context_md=seed.get("full_context_md"),
                    importance_score=float(seed.get("importance_score") or 0.0),
                    tags_json=tags_json,
                    story_timeline=_int_or_default(seed.get("story_timeline"), chapter_number),
                    text_position=_int_or_default(seed.get("text_position"), -1),
                    text_length=_int_or_default(seed.get("text_length"), 0),
                    is_foreshadow=_int_or_default(seed.get("is_foreshadow"), 0),
                    foreshadow_resolved_at_chapter_id=seed.get("foreshadow_resolved_at_chapter_id"),
                    metadata_json=metadata_json,
                    created_at=now,
                    updated_at=now,
                )
            )

        db.add_all(created)

        if not created:
            raise AppError(code="INTERNAL_ERROR", message="未生成任何 story_memories", status_code=500)

        db.add(
            GenerationRun(
                id=new_id(),
                project_id=project_id,
                actor_user_id=actor_user_id,
                chapter_id=chapter_id,
                type="analysis_apply",
                provider=None,
                model=None,
                request_id=request_id,
                prompt_system=None,
                prompt_user=None,
                prompt_render_log_json=None,
                params_json=json.dumps({"analysis_hash": analysis_hash}, ensure_ascii=False),
                output_text=None,
                error_json=None,
                created_at=now,
            )
        )

        settings_row = db.get(ProjectSettings, project_id)
        if settings_row is None:
            settings_row = ProjectSettings(project_id=project_id)
            db.add(settings_row)
        settings_row.vector_index_dirty = True

        db.commit()
        return {
            "idempotent": False,
            "analysis_hash": analysis_hash,
            "plot_analysis_id": plot.id,
            "memories": [_story_memory_out(m) for m in created],
            "quality_scores": quality,
        }
    except Exception:
        db.rollback()
        raise


def _safe_json(raw: str | None, default: object) -> object:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def _story_memory_out(row: StoryMemory) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "chapter_id": row.chapter_id,
        "memory_type": row.memory_type,
        "title": row.title,
        "content": row.content,
        "importance_score": row.importance_score,
        "tags": _safe_json(row.tags_json, []),
        "story_timeline": row.story_timeline,
        "text_position": row.text_position,
        "text_length": row.text_length,
        "is_foreshadow": row.is_foreshadow,
        "metadata": _safe_json(row.metadata_json, {}),
        "created_at": row.created_at.isoformat(),
    }


def schedule_plot_auto_update_task(
    *,
    db: Session | None = None,
    project_id: str,
    actor_user_id: str | None,
    request_id: str | None,
    chapter_id: str,
    chapter_token: str | None,
    reason: str,
) -> str | None:
    """
    Fail-soft scheduler: ensure/enqueue a ProjectTask(kind=plot_auto_update).
    """

    pid = str(project_id or "").strip()
    cid = str(chapter_id or "").strip()
    if not pid or not cid:
        return None

    token_norm = str(chapter_token or "").strip() or utc_now().isoformat().replace("+00:00", "Z")
    reason_norm = str(reason or "").strip() or "dirty"
    idempotency_key = f"plot:chapter:{cid}:since:{token_norm}:v1"

    owns_session = db is None
    if db is None:
        db = SessionLocal()
    try:
        task = (
            db.execute(
                select(ProjectTask).where(
                    ProjectTask.project_id == pid,
                    ProjectTask.idempotency_key == idempotency_key,
                )
            )
            .scalars()
            .first()
        )

        created_task = False
        if task is None:
            created_task = True
            task = ProjectTask(
                id=new_id(),
                project_id=pid,
                actor_user_id=str(actor_user_id or "").strip() or None,
                kind=PLOT_AUTO_UPDATE_KIND,
                status="queued",
                idempotency_key=idempotency_key,
                params_json=json.dumps(
                    {
                        "reason": reason_norm,
                        "request_id": (str(request_id or "").strip() or None),
                        "chapter_id": cid,
                        "chapter_token": token_norm,
                        "triggered_at": utc_now().isoformat().replace("+00:00", "Z"),
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                result_json=None,
                error_json=None,
            )
            db.add(task)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                task = (
                    db.execute(
                        select(ProjectTask).where(
                            ProjectTask.project_id == pid,
                            ProjectTask.idempotency_key == idempotency_key,
                        )
                    )
                    .scalars()
                    .first()
                )

        if task is None:
            return None

        return emit_and_enqueue_project_task(
            db,
            task=task,
            request_id=request_id,
            logger=logger,
            event_type="queued" if created_task else None,
            source="scheduler",
            payload={"reason": reason_norm, "request_id": request_id, "chapter_id": cid, "chapter_token": token_norm},
        )
    finally:
        if owns_session:
            db.close()


def plot_auto_update_v1(
    *,
    project_id: str,
    actor_user_id: str,
    request_id: str,
    chapter_id: str,
) -> dict[str, Any]:
    """
    Auto-run chapter_analyze -> apply_plot_analysis -> schedule vector/search rebuild.
    Designed for ProjectTask(kind=plot_auto_update).
    """

    pid = str(project_id or "").strip()
    cid = str(chapter_id or "").strip()
    actor = str(actor_user_id or "").strip()
    req = str(request_id or "").strip() or "plot_auto_update"
    if not pid or not cid:
        return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "invalid_args"}

    db_read = SessionLocal()
    project: Project | None = None
    chapter_number = 0
    chapter_content_md = ""
    prompt_system = ""
    prompt_user = ""
    prompt_messages = None
    prompt_render_log_json: str | None = None
    llm_call = None
    api_key = ""
    try:
        chapter = db_read.get(Chapter, cid)
        if chapter is None:
            return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "chapter_not_found"}
        if str(getattr(chapter, "project_id", "")) != pid:
            return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "chapter_not_found"}

        status = str(getattr(chapter, "status", "") or "").strip().lower()
        if status != "done":
            return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "chapter_not_done"}

        project = db_read.get(Project, pid)
        if project is None:
            return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "project_not_found"}

        resolved = _resolve_plot_llm_call(db=db_read, project=project, actor_user_id=actor)
        if resolved is None:
            return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "llm_preset_missing"}

        llm_call, api_key = resolved
        chapter_number = int(getattr(chapter, "number", 0) or 0)
        chapter_content_md = str(getattr(chapter, "content_md", "") or "")

        ensure_default_chapter_analyze_preset(db_read, project_id=pid, activate=True)
        body = ChapterAnalyzeRequest(
            instruction=(
                "仅提取剧情记忆：章节摘要/情节点/钩子/伏笔/人物状态变化。\n"
                "不要生成世界书/设定条目（人物/地点/物品/设定），不要用“地点：/物品：/设定：”百科条目格式。\n"
                "输出必须基于本章内容与剧情走向，不要扩写世界观。"
            )
        )
        body.context.include_world_setting = False
        body.context.include_style_guide = False
        body.context.include_constraints = False
        values = build_chapter_analyze_render_values(db_read, project=project, chapter=chapter, body=body)
        prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
            db_read,
            project_id=pid,
            task="chapter_analyze",
            values=values,  # type: ignore[arg-type]
            macro_seed=f"{req}:plot_auto_update",
            provider=llm_call.provider,
        )
        prompt_render_log_json = json.dumps(render_log, ensure_ascii=False)
    except Exception as exc:
        safe_message = redact_secrets_text(str(exc)).replace("\n", " ").strip()
        if not safe_message:
            safe_message = type(exc).__name__
        return {
            "ok": False,
            "project_id": pid,
            "chapter_id": cid,
            "reason": "api_key_missing",
            "error_type": type(exc).__name__,
            "error_message": safe_message[:400],
        }
    finally:
        db_read.close()

    if project is None or llm_call is None:
        return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "llm_preset_missing"}

    llm_attempts: list[dict[str, Any]] = []
    try:
        base_max_tokens = llm_call.params.get("max_tokens") if llm_call is not None else None

        def _clamp_max_tokens(limit: int) -> int:
            if isinstance(base_max_tokens, int) and base_max_tokens > 0:
                return min(int(limit), int(base_max_tokens))
            return int(limit)

        retry_instruction = (
            "【重试模式】上一轮调用失败/超时。请输出更短、更保守的 chapter_analyze JSON：\n"
            "- 只输出裸 JSON（不要 Markdown，不要代码块）\n"
            "- 只保留最关键的剧情记忆点，避免长段落\n"
        )

        max_attempts = task_llm_max_attempts(default=3)
        llm_result, llm_attempts = call_llm_and_record_with_retries(
            logger=logger,
            request_id=req,
            actor_user_id=actor,
            project_id=pid,
            chapter_id=cid,
            run_type="plot_auto_update",
            api_key=str(api_key),
            prompt_system=prompt_system,
            prompt_user=prompt_user,
            prompt_messages=prompt_messages,
            prompt_render_log_json=prompt_render_log_json,
            llm_call=llm_call,
            max_attempts=max_attempts,
            retry_messages_system_instruction=retry_instruction,
            llm_call_overrides_by_attempt={
                1: {"temperature": 0.2, "max_tokens": _clamp_max_tokens(2048)},
                2: {"temperature": 0.1, "max_tokens": _clamp_max_tokens(1024)},
                3: {"temperature": 0.0, "max_tokens": _clamp_max_tokens(512)},
            },
            backoff_base_seconds=task_llm_retry_base_seconds(),
            backoff_max_seconds=task_llm_retry_max_seconds(),
            jitter=task_llm_retry_jitter(),
        )
    except LlmRetryExhausted as exc:
        log_event(
            logger,
            "warning",
            event="PLOT_AUTO_UPDATE_LLM_ERROR",
            project_id=pid,
            chapter_id=cid,
            run_id=exc.run_id,
            error_type=str(exc.error_type),
            request_id=req,
            **exception_log_fields(exc.last_exception),
        )
        return {
            "ok": False,
            "project_id": pid,
            "chapter_id": cid,
            "reason": "llm_call_failed",
            "run_id": exc.run_id,
            "error_type": exc.error_type,
            "error_message": exc.error_message[:400],
            "attempts": list(exc.attempts or []),
            "error": {
                "code": exc.error_code or "LLM_CALL_FAILED",
                "details": {"attempts": list(exc.attempts or [])},
            },
        }

    contract = contract_for_task("chapter_analyze")
    parsed = contract.parse(llm_result.text, finish_reason=llm_result.finish_reason)
    if parsed.parse_error is not None:
        return {
            "ok": False,
            "project_id": pid,
            "chapter_id": cid,
            "reason": "parse_error",
            "run_id": llm_result.run_id,
            "finish_reason": llm_result.finish_reason,
            "parse_error": parsed.parse_error,
            "warnings": [*list(parsed.warnings or []), *([] if len(list(llm_attempts or [])) < 2 else ["llm_retry_used"])],
        }

    analysis = parsed.data.get("analysis") if isinstance(parsed.data, dict) else None
    if not isinstance(analysis, dict):
        return {
            "ok": False,
            "project_id": pid,
            "chapter_id": cid,
            "reason": "parse_error",
            "run_id": llm_result.run_id,
            "finish_reason": llm_result.finish_reason,
            "parse_error": {"code": "ANALYSIS_PARSE_ERROR", "message": "analysis 缺失或无效"},
        }

    db_apply = SessionLocal()
    try:
        out = apply_chapter_analysis(
            db=db_apply,
            request_id=req,
            actor_user_id=actor,
            project_id=pid,
            chapter_id=cid,
            chapter_number=chapter_number,
            analysis=analysis,
            draft_content_md=chapter_content_md,
        )

        try:
            schedule_vector_rebuild_task(
                db=db_apply,
                project_id=pid,
                actor_user_id=actor,
                request_id=req,
                reason="plot_auto_update",
            )
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="PLOT_AUTO_UPDATE_POST_TASK_ERROR",
                project_id=pid,
                chapter_id=cid,
                kind="vector_rebuild",
                error_type=type(exc).__name__,
                **exception_log_fields(exc),
            )

        try:
            schedule_search_rebuild_task(
                db=db_apply,
                project_id=pid,
                actor_user_id=actor,
                request_id=req,
                reason="plot_auto_update",
            )
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="PLOT_AUTO_UPDATE_POST_TASK_ERROR",
                project_id=pid,
                chapter_id=cid,
                kind="search_rebuild",
                error_type=type(exc).__name__,
                **exception_log_fields(exc),
            )

        return {
            "ok": True,
            "project_id": pid,
            "chapter_id": cid,
            "run_id": llm_result.run_id,
            "finish_reason": llm_result.finish_reason,
            "warnings": [*list(parsed.warnings or []), *([] if len(list(llm_attempts or [])) < 2 else ["llm_retry_used"])],
            "applied": out,
        }
    except Exception as exc:
        safe_message = redact_secrets_text(str(exc)).replace("\n", " ").strip()
        if not safe_message:
            safe_message = type(exc).__name__
        return {
            "ok": False,
            "project_id": pid,
            "chapter_id": cid,
            "reason": "apply_failed",
            "run_id": llm_result.run_id,
            "error_type": type(exc).__name__,
            "error_message": safe_message[:400],
        }
    finally:
        db_apply.close()
