from __future__ import annotations

from datetime import datetime, timezone
from dataclasses import dataclass
import json
import logging
import time
from typing import Literal

from fastapi import APIRouter, Header, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.deps import (
    DbDep,
    UserIdDep,
    require_chapter_editor,
    require_chapter_viewer,
    require_outline_viewer,
    require_project_editor,
    require_project_viewer,
)
from app.core.errors import AppError, ok_payload
from app.core.logging import exception_log_fields, log_event
from app.db.session import SessionLocal
from app.db.utils import new_id
from app.llm.client import call_llm_messages, call_llm_stream_messages
from app.llm.messages import ChatMessage, coalesce_system, flatten_messages
from app.llm.redaction import redact_text
from app.models.chapter import Chapter
from app.models.character import Character
from app.models.generation_run import GenerationRun
from app.models.outline import Outline
from app.models.project import Project
from app.models.project_settings import ProjectSettings
from app.schemas.chapters import (
    BulkCreateRequest,
    ChapterCreate,
    ChapterDetailOut,
    ChapterListItemOut,
    ChapterMetaPageOut,
    ChapterOut,
    ChapterUpdate,
)
from app.schemas.chapter_generate import ChapterGenerateRequest
from app.schemas.chapter_plan import ChapterPlanRequest
from app.services.generation_service import build_run_params_json, call_llm_and_record, prepare_llm_call, with_param_overrides
from app.services.generation_pipeline import (
    run_chapter_generate_llm_step,
    run_content_optimize_step,
    run_mcp_research_step,
    run_plan_llm_step,
    run_post_edit_step,
)
from app.services.llm_task_preset_resolver import resolve_task_llm_config, resolve_task_preset
from app.services.llm_retry import (
    compute_backoff_seconds,
    is_retryable_llm_error,
    task_llm_max_attempts,
    task_llm_retry_base_seconds,
    task_llm_retry_jitter,
    task_llm_retry_max_seconds,
)
from app.services.length_control import estimate_max_tokens
from app.services.mcp.service import McpResearchConfig as McpResearchConfigSvc
from app.services.mcp.service import McpToolCall as McpToolCallSvc
from app.services.output_contracts import contract_for_task
from app.services.outline_store import ensure_active_outline
from app.services.chapter_context_service import (
    build_chapter_generate_render_values,
    inject_plan_into_render_values,
)
from app.services.memory_query_service import normalize_query_text, parse_query_preprocessing_config
from app.services.memory_retrieval_service import build_memory_retrieval_log_json, retrieve_memory_context_pack
from app.services.prompt_presets import ensure_default_plan_preset, ensure_default_post_edit_preset, render_preset_for_task
from app.services.prompt_store import format_characters
from app.services.project_task_service import schedule_chapter_done_tasks
from app.services.run_store import write_generation_run
from app.services.search_index_service import schedule_search_rebuild_task
from app.services.vector_rag_service import schedule_vector_rebuild_task
from app.utils.sse_response import (
    create_sse_response,
    sse_chunk,
    sse_done,
    sse_error,
    sse_heartbeat,
    sse_progress,
    sse_result,
    sse_start,
)

router = APIRouter()
logger = logging.getLogger("ainovel")

PREVIOUS_CHAPTER_ENDING_CHARS = 1000
CURRENT_DRAFT_TAIL_CHARS = 1200
_MAX_MACRO_SEED_CHARS = 256
DEFAULT_CHAPTER_META_LIMIT = 200
MAX_CHAPTER_META_LIMIT = 500


class ChapterPostEditAdoption(BaseModel):
    generation_run_id: str = Field(max_length=36)
    post_edit_run_id: str | None = Field(default=None, max_length=36)
    choice: Literal["raw", "post_edit"]


class ChapterTriggerAutoUpdates(BaseModel):
    generation_run_id: str | None = Field(
        default=None,
        max_length=36,
        description="用于幂等的 token（优先使用 generation_run_id；不提供则回退 chapter.updated_at）",
    )


def _resolve_macro_seed(*, request_id: str, body: object) -> str:
    seed = str(getattr(body, "macro_seed", "") or "").strip()
    if not seed:
        return request_id
    return seed[:_MAX_MACRO_SEED_CHARS]


def _apply_prompt_override(
    *,
    prompt_system: str,
    prompt_user: str,
    prompt_messages: list[ChatMessage],
    body: ChapterGenerateRequest,
) -> tuple[str, str, list[ChatMessage], bool]:
    override = body.prompt_override
    if override is None:
        return prompt_system, prompt_user, prompt_messages, False

    override_messages: list[ChatMessage] = []
    for item in override.messages or []:
        role = str(item.role or "user").strip() or "user"
        content = str(item.content or "")
        name = str(item.name).strip() if isinstance(item.name, str) and item.name.strip() else None
        override_messages.append(ChatMessage(role=role, content=content, name=name))
    if override_messages:
        system, non_system = coalesce_system(override_messages)
        user = flatten_messages(non_system)
        return system, user, override_messages, True

    next_system = prompt_system if override.system is None else str(override.system or "")
    next_user = prompt_user if override.user is None else str(override.user or "")
    next_messages: list[ChatMessage] = []
    if next_system.strip():
        next_messages.append(ChatMessage(role="system", content=next_system))
    if next_user.strip():
        next_messages.append(ChatMessage(role="user", content=next_user))
    return next_system, next_user, next_messages, True


def _redact_prompt_override_for_params(body: ChapterGenerateRequest) -> dict[str, object] | None:
    override = body.prompt_override
    if override is None:
        return None
    data = override.model_dump()
    if isinstance(data.get("system"), str):
        data["system"] = redact_text(data["system"])
    if isinstance(data.get("user"), str):
        data["user"] = redact_text(data["user"])

    messages = data.get("messages")
    if isinstance(messages, list):
        for item in messages:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("content"), str):
                item["content"] = redact_text(item["content"])
    return data


def _redact_prompt_preview_for_params(
    *, prompt_system: str, prompt_user: str, prompt_messages: list[ChatMessage]
) -> dict[str, object]:
    return {
        "system": redact_text(prompt_system or ""),
        "user": redact_text(prompt_user or ""),
        "messages": [{"role": m.role, "content": redact_text(m.content or ""), "name": m.name} for m in prompt_messages],
    }


def _build_prompt_inspector_params(
    *,
    macro_seed: str,
    prompt_overridden: bool,
    body: ChapterGenerateRequest,
    precheck_prompt_system: str,
    precheck_prompt_user: str,
    precheck_prompt_messages: list[ChatMessage],
    final_prompt_system: str,
    final_prompt_user: str,
    final_prompt_messages: list[ChatMessage],
) -> dict[str, object]:
    out: dict[str, object] = {
        "macro_seed": macro_seed,
        "prompt_overridden": bool(prompt_overridden),
        "precheck": _redact_prompt_preview_for_params(
            prompt_system=precheck_prompt_system,
            prompt_user=precheck_prompt_user,
            prompt_messages=precheck_prompt_messages,
        ),
        "final": _redact_prompt_preview_for_params(
            prompt_system=final_prompt_system,
            prompt_user=final_prompt_user,
            prompt_messages=final_prompt_messages,
        ),
    }
    override = _redact_prompt_override_for_params(body)
    if override is not None:
        out["override"] = override
    return out


def _build_mcp_research_config(body: ChapterGenerateRequest) -> McpResearchConfigSvc:
    cfg = getattr(body, "mcp_research", None)
    if cfg is None:
        return McpResearchConfigSvc(enabled=False, allowlist=[], calls=[])

    calls: list[McpToolCallSvc] = []
    for item in getattr(cfg, "calls", None) or []:
        tool_name = str(getattr(item, "tool_name", "") or "").strip()
        if not tool_name:
            continue
        args = getattr(item, "args", None)
        calls.append(McpToolCallSvc(tool_name=tool_name, args=args if isinstance(args, dict) else {}))

    allowlist = list(getattr(cfg, "allowlist", None) or [])
    return McpResearchConfigSvc(
        enabled=bool(getattr(cfg, "enabled", False)),
        allowlist=[str(x).strip() for x in allowlist if isinstance(x, str) and str(x).strip()],
        calls=calls,
        timeout_seconds=getattr(cfg, "timeout_seconds", None),
        max_output_chars=getattr(cfg, "max_output_chars", None),
    )


def _inject_mcp_research_into_values(*, values: dict[str, object], context_md: str) -> None:
    text = str(context_md or "").strip()
    if not text:
        return

    base_instruction = str(values.get("instruction") or "").rstrip()
    user_obj = values.get("user")
    if isinstance(user_obj, dict):
        base = str(user_obj.get("instruction") or "").rstrip()
        user_obj["instruction"] = (base + "\n\n【资料收集 - 参考资料】\n" + text).strip()
    values["instruction"] = (base_instruction + "\n\n【资料收集 - 参考资料】\n" + text).strip()
    values["mcp_research"] = text


def _mcp_research_params(*, cfg: McpResearchConfigSvc, applied: bool, tool_run_ids: list[str], warnings: list[str]) -> dict[str, object]:
    return {
        "enabled": bool(cfg.enabled),
        "applied": bool(applied),
        "allowlist": list(cfg.allowlist or []),
        "tool_run_ids": list(tool_run_ids),
        "warnings": list(warnings or []),
    }


@dataclass(frozen=True, slots=True)
class _ChapterMemoryPreparation:
    memory_pack: dict[str, object] | None
    memory_injection_config: dict[str, object] | None
    memory_retrieval_log_json: dict[str, object] | None


def _resolve_memory_modules(raw_modules: dict[str, bool]) -> dict[str, bool]:
    return {
        "worldbook": bool(raw_modules.get("worldbook", True)),
        "story_memory": bool(raw_modules.get("story_memory", True)),
        "semantic_history": bool(raw_modules.get("semantic_history", False)),
        "foreshadow_open_loops": bool(raw_modules.get("foreshadow_open_loops", False)),
        "structured": bool(raw_modules.get("structured", True)),
        "tables": bool(raw_modules.get("tables", True)),
        "vector_rag": bool(raw_modules.get("vector_rag", True)),
        "graph": bool(raw_modules.get("graph", True)),
        "fractal": bool(raw_modules.get("fractal", True)),
    }


def _prepare_chapter_memory_injection(
    *,
    db: Session,
    project_id: str,
    chapter: Chapter,
    body: ChapterGenerateRequest,
    settings_row: ProjectSettings | None,
    base_instruction: str,
    values: dict[str, object],
) -> _ChapterMemoryPreparation:
    if not body.memory_injection_enabled:
        return _ChapterMemoryPreparation(
            memory_pack=None,
            memory_injection_config=None,
            memory_retrieval_log_json=None,
        )

    memory_query_text = ""
    query_text_source = "auto"
    requested_query_text = str(body.memory_query_text or "").strip()
    if requested_query_text:
        memory_query_text = requested_query_text[:5000]
        query_text_source = "user"
    else:
        memory_query_text = base_instruction
        if chapter.plan:
            memory_query_text = f"{memory_query_text}\n\n{chapter.plan}".strip()
        memory_query_text = memory_query_text[:5000]

    memory_modules = _resolve_memory_modules(body.memory_modules or {})
    raw_query_text = memory_query_text
    qp_cfg = parse_query_preprocessing_config(
        (settings_row.query_preprocessing_json or "").strip() if settings_row is not None else None
    )
    memory_query_text, preprocess_obs = normalize_query_text(query_text=raw_query_text, config=qp_cfg)

    pack = None
    pack_errors = None
    try:
        pack = retrieve_memory_context_pack(
            db=db,
            project_id=project_id,
            query_text=memory_query_text,
            section_enabled=memory_modules,
            current_chapter_number=int(chapter.number),
        )
    except Exception:
        pack = None
        pack_errors = ["memory_pack_error"]

    memory_pack = pack.model_dump() if pack is not None else None
    if memory_pack is not None:
        values["memory"] = memory_pack

    memory_injection_config: dict[str, object] = {
        "query_text": memory_query_text,
        "query_text_source": query_text_source,
        "modules": memory_modules,
        "raw_query_text": raw_query_text,
        "normalized_query_text": memory_query_text,
        "preprocess_obs": preprocess_obs,
    }
    memory_retrieval_log_json = build_memory_retrieval_log_json(
        enabled=True,
        query_text=memory_query_text,
        pack=pack,
        errors=pack_errors,
    )
    return _ChapterMemoryPreparation(
        memory_pack=memory_pack,
        memory_injection_config=memory_injection_config,
        memory_retrieval_log_json=memory_retrieval_log_json,
    )


def _build_memory_run_params_extra_json(
    *,
    style_resolution: dict[str, object],
    memory_injection_enabled: bool,
    memory_preparation: _ChapterMemoryPreparation,
) -> dict[str, object]:
    params: dict[str, object] = {
        "style_resolution": style_resolution,
        "memory_injection_enabled": memory_injection_enabled,
    }
    # Mirror generation_runs.params_json fields for observability + replay.
    if memory_injection_enabled and memory_preparation.memory_injection_config is not None:
        params["memory_injection_config"] = memory_preparation.memory_injection_config
        params["memory_retrieval_log_json"] = memory_preparation.memory_retrieval_log_json
    return params


def _resolve_task_llm_for_call(
    *,
    db: Session,
    project: Project,
    user_id: str,
    task_key: str,
    x_llm_provider: str | None,
    x_llm_api_key: str | None,
):
    resolved = resolve_task_llm_config(
        db,
        project=project,
        user_id=user_id,
        task_key=task_key,
        header_api_key=x_llm_api_key,
    )
    if resolved is None:
        raise AppError(code="LLM_CONFIG_ERROR", message="请先在 Prompts 页保存 LLM 配置", status_code=400)
    if x_llm_api_key and x_llm_provider and resolved.llm_call.provider != x_llm_provider:
        raise AppError(code="LLM_CONFIG_ERROR", message="当前任务 provider 与请求头不一致，请先保存/切换", status_code=400)
    return resolved


def _mark_vector_index_dirty(db: DbDep, *, project_id: str) -> None:
    row = db.get(ProjectSettings, project_id)
    if row is None:
        row = ProjectSettings(project_id=project_id)
        db.add(row)
        db.flush()
    row.vector_index_dirty = True


def _find_missing_prereq_numbers(
    db: Session,
    *,
    project_id: str,
    outline_id: str,
    chapter_number: int,
) -> list[int]:
    if chapter_number <= 1:
        return []

    rows = db.execute(
        select(Chapter.number, Chapter.content_md, Chapter.summary)
        .where(
            Chapter.project_id == project_id,
            Chapter.outline_id == outline_id,
            Chapter.number < chapter_number,
        )
        .order_by(Chapter.number.asc())
    ).all()

    existing: dict[int, tuple[str | None, str | None]] = {int(r[0]): (r[1], r[2]) for r in rows}
    missing: list[int] = []
    for n in range(1, int(chapter_number)):
        content_md, summary = existing.get(n, (None, None))
        if not ((content_md or "").strip() or (summary or "").strip()):
            missing.append(n)
    return missing


def _load_previous_chapter_context(
    db: Session,
    *,
    project_id: str,
    outline_id: str,
    chapter_number: int,
    previous_chapter: str | None,
) -> tuple[str, str]:
    mode = previous_chapter or "none"
    if mode == "none" or chapter_number <= 1:
        return "", ""

    prev = (
        db.execute(
            select(Chapter).where(
                Chapter.project_id == project_id,
                Chapter.outline_id == outline_id,
                Chapter.number == (chapter_number - 1),
            )
        )
        .scalars()
        .first()
    )
    if prev is None:
        return "", ""

    if mode == "summary":
        return (prev.summary or "").strip(), ""
    if mode == "content":
        return (prev.content_md or "").strip(), ""
    if mode == "tail":
        raw = (prev.content_md or "").strip()
        if not raw:
            return "", ""
        tail = raw[-PREVIOUS_CHAPTER_ENDING_CHARS:].lstrip()
        return "", tail

    return "", ""


def _resolve_current_draft_tail(*, chapter: Chapter, request_tail: str | None) -> str:
    if request_tail is not None and request_tail.strip():
        return request_tail.strip()[-CURRENT_DRAFT_TAIL_CHARS:].lstrip()
    raw = (chapter.content_md or "").strip()
    if not raw:
        return ""
    return raw[-CURRENT_DRAFT_TAIL_CHARS:].lstrip()


def _resolve_target_outline_id(*, db: Session, project_id: str, user_id: str, outline_id: str | None) -> str | None:
    project = require_project_viewer(db, project_id=project_id, user_id=user_id)
    if outline_id:
        outline = require_outline_viewer(db, outline_id=outline_id, user_id=user_id)
        if outline.project_id != project_id:
            raise AppError.validation("outline_id 不属于当前项目")
        return str(outline.id)
    if project.active_outline_id:
        return str(project.active_outline_id)
    return None


def _chapter_query(*, project_id: str, outline_id: str):
    return select(Chapter).where(Chapter.project_id == project_id, Chapter.outline_id == outline_id)


def _count_words(text: str | None) -> int:
    """Count words/characters in content. For CJK text, counts characters."""
    if not text:
        return 0
    content = text.strip()
    if not content:
        return 0
    # Count CJK characters + non-CJK word tokens
    count = 0
    for ch in content:
        code = ord(ch)
        if (0x4E00 <= code <= 0x9FFF) or (0x3400 <= code <= 0x4DBF):
            count += 1
        elif ch in (' ', '\n', '\t', '\r'):
            continue
        # For non-CJK, we just count total non-space chars as approximation
    # Simple approach: return character count minus whitespace for CJK-dominant text
    return len(content.replace(' ', '').replace('\n', '').replace('\t', '').replace('\r', ''))


def _chapter_meta_payload(row: Chapter, *, generation_count: int = 0) -> dict:
    return ChapterListItemOut(
        id=str(row.id),
        project_id=str(row.project_id),
        outline_id=str(row.outline_id),
        number=int(row.number),
        title=row.title,
        status=str(row.status),
        updated_at=row.updated_at,
        has_plan=bool(str(row.plan or "").strip()),
        has_summary=bool(str(row.summary or "").strip()),
        has_content=bool(str(row.content_md or "").strip()),
        word_count=_count_words(row.content_md),
        generation_count=generation_count,
    ).model_dump()


@router.get("/projects/{project_id}/chapters/meta")
def list_chapter_meta(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    outline_id: str | None = Query(default=None),
    cursor: int | None = Query(default=None, ge=0),
    limit: int = Query(default=DEFAULT_CHAPTER_META_LIMIT, ge=1, le=MAX_CHAPTER_META_LIMIT),
) -> dict:
    request_id = request.state.request_id
    target_outline_id = _resolve_target_outline_id(db=db, project_id=project_id, user_id=user_id, outline_id=outline_id)
    if target_outline_id is None:
        empty = ChapterMetaPageOut(chapters=[]).model_dump()
        return ok_payload(request_id=request_id, data=empty)

    filters = (Chapter.project_id == project_id, Chapter.outline_id == target_outline_id)
    total = int(db.execute(select(func.count(Chapter.id)).where(*filters)).scalar_one())

    query = select(Chapter).where(*filters)
    if cursor is not None:
        query = query.where(Chapter.number > cursor)
    rows = db.execute(query.order_by(Chapter.number.asc()).limit(limit + 1)).scalars().all()
    has_more = len(rows) > limit
    page_rows = rows[:limit]
    next_cursor = page_rows[-1].number if has_more and page_rows else None

    # Batch query generation counts for all chapters on this page
    gen_counts: dict[str, int] = {}
    if page_rows:
        chapter_ids = [str(r.id) for r in page_rows]
        gen_count_rows = db.execute(
            select(GenerationRun.chapter_id, func.count(GenerationRun.id))
            .where(GenerationRun.chapter_id.in_(chapter_ids))
            .group_by(GenerationRun.chapter_id)
        ).all()
        gen_counts = {str(row[0]): int(row[1]) for row in gen_count_rows}

    data = ChapterMetaPageOut(
        chapters=[
            ChapterListItemOut.model_validate(
                _chapter_meta_payload(row, generation_count=gen_counts.get(str(row.id), 0))
            ).model_dump()
            for row in page_rows
        ],
        next_cursor=next_cursor,
        has_more=has_more,
        returned=len(page_rows),
        total=total,
    ).model_dump()
    return ok_payload(request_id=request_id, data=data)


@router.get("/projects/{project_id}/chapters")
def list_chapters(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    outline_id: str | None = Query(default=None),
) -> dict:
    request_id = request.state.request_id
    target_outline_id = _resolve_target_outline_id(db=db, project_id=project_id, user_id=user_id, outline_id=outline_id)
    if target_outline_id is None:
        return ok_payload(request_id=request_id, data={"chapters": []})

    rows = (
        db.execute(
            _chapter_query(project_id=project_id, outline_id=target_outline_id).order_by(Chapter.number.asc())
        )
        .scalars()
        .all()
    )
    return ok_payload(request_id=request_id, data={"chapters": [ChapterOut.model_validate(r).model_dump() for r in rows]})


@router.post("/projects/{project_id}/chapters")
def create_chapter(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    body: ChapterCreate,
    outline_id: str | None = Query(default=None),
) -> dict:
    request_id = request.state.request_id
    project = require_project_editor(db, project_id=project_id, user_id=user_id)
    if outline_id:
        outline = require_outline_viewer(db, outline_id=outline_id, user_id=user_id)
        if outline.project_id != project_id:
            raise AppError.validation("outline_id 不属于当前项目")
        target_outline_id = outline.id
    else:
        target_outline_id = ensure_active_outline(db, project=project).id
    row = Chapter(
        id=new_id(),
        project_id=project_id,
        outline_id=target_outline_id,
        number=body.number,
        title=body.title,
        plan=body.plan,
        status=body.status,
    )
    db.add(row)
    try:
        _mark_vector_index_dirty(db, project_id=project_id)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise AppError.conflict("章节号已存在", details={"field": "number"})
    db.refresh(row)
    if str(row.status or "") == "done":
        token = None
        updated_at = getattr(row, "updated_at", None)
        if updated_at is not None:
            token = updated_at.isoformat().replace("+00:00", "Z")
        try:
            schedule_chapter_done_tasks(
                db=db,
                project_id=project_id,
                actor_user_id=user_id,
                request_id=request_id,
                chapter_id=str(row.id),
                chapter_token=token,
                reason="chapter_done",
            )
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="CHAPTER_DONE_TASKS",
                action="trigger_failed",
                project_id=str(row.project_id),
                chapter_id=str(row.id),
                **exception_log_fields(exc),
            )
    else:
        schedule_vector_rebuild_task(
            db=db, project_id=project_id, actor_user_id=user_id, request_id=request_id, reason="chapter_create"
        )
        schedule_search_rebuild_task(
            db=db, project_id=project_id, actor_user_id=user_id, request_id=request_id, reason="chapter_create"
        )
    return ok_payload(request_id=request_id, data={"chapter": ChapterOut.model_validate(row).model_dump()})


@router.post("/projects/{project_id}/chapters/bulk_create")
def bulk_create(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    body: BulkCreateRequest,
    replace: bool = Query(default=False),
    outline_id: str | None = Query(default=None),
) -> dict:
    request_id = request.state.request_id
    project = require_project_editor(db, project_id=project_id, user_id=user_id)
    if outline_id:
        outline = require_outline_viewer(db, outline_id=outline_id, user_id=user_id)
        if outline.project_id != project_id:
            raise AppError.validation("outline_id 不属于当前项目")
        target_outline_id = outline.id
    else:
        target_outline_id = ensure_active_outline(db, project=project).id

    has_any = (
        db.execute(select(Chapter.id).where(Chapter.project_id == project_id, Chapter.outline_id == target_outline_id).limit(1)).first()
        is not None
    )
    if has_any and not replace:
        raise AppError.conflict("该大纲已存在章节，无法创建（请选择覆盖创建）")

    numbers = [c.number for c in body.chapters]
    if len(numbers) != len(set(numbers)):
        raise AppError.validation("chapters.number 不能重复")

    if replace:
        db.execute(delete(Chapter).where(Chapter.project_id == project_id, Chapter.outline_id == target_outline_id))
        _mark_vector_index_dirty(db, project_id=project_id)
        db.commit()

    created: list[Chapter] = [
        Chapter(
            id=new_id(),
            project_id=project_id,
            outline_id=target_outline_id,
            number=c.number,
            title=c.title,
            plan=c.plan,
            status="planned",
        )
        for c in body.chapters
    ]
    db.add_all(created)
    try:
        _mark_vector_index_dirty(db, project_id=project_id)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise AppError.conflict("章节创建冲突（请检查章节号）")

    created_sorted = sorted(created, key=lambda x: x.number)
    schedule_vector_rebuild_task(db=db, project_id=project_id, actor_user_id=user_id, request_id=request_id, reason="chapters_bulk_create")
    schedule_search_rebuild_task(db=db, project_id=project_id, actor_user_id=user_id, request_id=request_id, reason="chapters_bulk_create")
    return ok_payload(
        request_id=request_id,
        data={"chapters": [ChapterOut.model_validate(r).model_dump() for r in created_sorted]},
    )


@router.get("/chapters/{chapter_id}")
def get_chapter(request: Request, db: DbDep, user_id: UserIdDep, chapter_id: str) -> dict:
    request_id = request.state.request_id
    row = require_chapter_viewer(db, chapter_id=chapter_id, user_id=user_id)
    return ok_payload(request_id=request_id, data={"chapter": ChapterDetailOut.model_validate(row).model_dump()})


@router.put("/chapters/{chapter_id}")
def update_chapter(request: Request, db: DbDep, user_id: UserIdDep, chapter_id: str, body: ChapterUpdate) -> dict:
    request_id = request.state.request_id
    row = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
    prev_status = str(row.status or "")

    if body.title is not None:
        row.title = body.title
    if body.plan is not None:
        row.plan = body.plan
    if body.content_md is not None:
        row.content_md = body.content_md
    if body.summary is not None:
        row.summary = body.summary
    if body.status is not None:
        row.status = body.status

    _mark_vector_index_dirty(db, project_id=str(row.project_id))
    db.commit()
    db.refresh(row)

    next_status = str(row.status or "")
    if prev_status != "done" and next_status == "done":
        token = None
        updated_at = getattr(row, "updated_at", None)
        if updated_at is not None:
            token = updated_at.isoformat().replace("+00:00", "Z")

        try:
            schedule_chapter_done_tasks(
                db=db,
                project_id=str(row.project_id),
                actor_user_id=user_id,
                request_id=request_id,
                chapter_id=str(row.id),
                chapter_token=token,
                reason="chapter_done",
            )
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="CHAPTER_DONE_TASKS",
                action="trigger_failed",
                project_id=str(row.project_id),
                chapter_id=str(row.id),
                **exception_log_fields(exc),
            )
    else:
        schedule_vector_rebuild_task(
            db=db, project_id=str(row.project_id), actor_user_id=user_id, request_id=request_id, reason="chapter_update"
        )
        schedule_search_rebuild_task(
            db=db, project_id=str(row.project_id), actor_user_id=user_id, request_id=request_id, reason="chapter_update"
        )
    return ok_payload(request_id=request_id, data={"chapter": ChapterOut.model_validate(row).model_dump()})


@router.post("/chapters/{chapter_id}/trigger_auto_updates")
def trigger_chapter_auto_updates(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    chapter_id: str,
    body: ChapterTriggerAutoUpdates,
) -> dict:
    request_id = request.state.request_id
    chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)

    token: str | None = None
    run_id = str(body.generation_run_id or "").strip()
    if run_id:
        token = run_id
    else:
        updated_at = getattr(chapter, "updated_at", None)
        if updated_at is not None:
            token = updated_at.isoformat().replace("+00:00", "Z")

    tasks = schedule_chapter_done_tasks(
        db=db,
        project_id=str(chapter.project_id),
        actor_user_id=user_id,
        request_id=request_id,
        chapter_id=str(chapter.id),
        chapter_token=token,
        reason="chapter_auto_updates",
    )

    return ok_payload(request_id=request_id, data={"tasks": tasks, "chapter_token": token})


@router.post("/chapters/{chapter_id}/post_edit_adoption")
def record_post_edit_adoption(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    chapter_id: str,
    body: ChapterPostEditAdoption,
) -> dict:
    request_id = request.state.request_id
    chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
    run = db.get(GenerationRun, str(body.generation_run_id))
    if not run:
        raise AppError.not_found("生成记录不存在")
    if str(run.project_id) != str(chapter.project_id) or str(run.chapter_id or "") != str(chapter_id):
        raise AppError.not_found("生成记录不存在")

    params: dict[str, object]
    if run.params_json:
        try:
            parsed = json.loads(run.params_json)
            params = parsed if isinstance(parsed, dict) else {"_raw": run.params_json}
        except Exception:
            params = {"_raw": run.params_json}
    else:
        params = {}

    params["post_edit_adoption"] = {
        "choice": body.choice,
        "post_edit_run_id": body.post_edit_run_id,
        "recorded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    run.params_json = json.dumps(params, ensure_ascii=False)
    db.commit()

    return ok_payload(request_id=request_id, data={"ok": True})


@router.delete("/chapters/{chapter_id}")
def delete_chapter(request: Request, db: DbDep, user_id: UserIdDep, chapter_id: str) -> dict:
    request_id = request.state.request_id
    row = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
    db.delete(row)
    _mark_vector_index_dirty(db, project_id=str(row.project_id))
    db.commit()
    schedule_vector_rebuild_task(db=db, project_id=str(row.project_id), actor_user_id=user_id, request_id=request_id, reason="chapter_delete")
    schedule_search_rebuild_task(db=db, project_id=str(row.project_id), actor_user_id=user_id, request_id=request_id, reason="chapter_delete")
    return ok_payload(request_id=request_id, data={})


@router.post("/chapters/{chapter_id}/plan")
def plan_chapter(
    request: Request,
    chapter_id: str,
    body: ChapterPlanRequest,
    user_id: UserIdDep,
    x_llm_provider: str | None = Header(default=None, alias="X-LLM-Provider", max_length=64),
    x_llm_api_key: str | None = Header(default=None, alias="X-LLM-API-Key", max_length=4096),
) -> dict:
    request_id = request.state.request_id
    macro_seed = _resolve_macro_seed(request_id=request_id, body=body)
    resolved_api_key = ""

    prompt_system = ""
    prompt_user = ""
    prompt_render_log_json: str | None = None
    llm_call = None
    project_id = ""

    db = SessionLocal()
    try:
        chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
        project_id = chapter.project_id
        if body.context.require_sequential:
            missing_numbers = _find_missing_prereq_numbers(
                db,
                project_id=project_id,
                outline_id=chapter.outline_id,
                chapter_number=int(chapter.number),
            )
            if missing_numbers:
                raise AppError(
                    code="CHAPTER_PREREQ_MISSING",
                    message=f"缺少前置章节内容：第 {', '.join(str(n) for n in missing_numbers)} 章",
                    status_code=400,
                    details={"missing_numbers": missing_numbers},
                )
        project = db.get(Project, project_id)
        if project is None:
            raise AppError.not_found()

        resolved_plan = _resolve_task_llm_for_call(
            db=db,
            project=project,
            user_id=user_id,
            task_key="plan_chapter",
            x_llm_provider=x_llm_provider,
            x_llm_api_key=x_llm_api_key,
        )
        resolved_api_key = str(resolved_plan.api_key)

        ensure_default_plan_preset(db, project_id=project_id)

        settings_row = db.get(ProjectSettings, project_id)
        outline_row = db.get(Outline, chapter.outline_id)

        world_setting = (settings_row.world_setting if settings_row else "") or ""
        style_guide = (settings_row.style_guide if settings_row else "") or ""
        constraints = (settings_row.constraints if settings_row else "") or ""

        if not body.context.include_world_setting:
            world_setting = ""
        if not body.context.include_style_guide:
            style_guide = ""
        if not body.context.include_constraints:
            constraints = ""

        outline_text = (outline_row.content_md if outline_row else "") or ""
        if not body.context.include_outline:
            outline_text = ""

        chars: list[Character] = []
        if body.context.character_ids:
            chars = (
                db.execute(
                    select(Character).where(
                        Character.project_id == project_id,
                        Character.id.in_(body.context.character_ids),
                    )
                )
                .scalars()
                .all()
            )
        characters_text = format_characters(chars)

        prev_text, prev_ending = _load_previous_chapter_context(
            db,
            project_id=project_id,
            outline_id=chapter.outline_id,
            chapter_number=chapter.number,
            previous_chapter=body.context.previous_chapter,
        )

        values: dict[str, object] = {
            "project_name": project.name or "",
            "genre": project.genre or "",
            "logline": project.logline or "",
            "world_setting": world_setting,
            "style_guide": style_guide,
            "constraints": constraints,
            "characters": characters_text,
            "outline": outline_text,
            "chapter_number": str(chapter.number),
            "chapter_title": (chapter.title or ""),
            "chapter_plan": (chapter.plan or ""),
            "instruction": body.instruction.strip(),
            "previous_chapter": prev_text,
            "previous_chapter_ending": prev_ending,
        }
        values["project"] = {
            "name": project.name or "",
            "genre": project.genre or "",
            "logline": project.logline or "",
            "world_setting": world_setting,
            "style_guide": style_guide,
            "constraints": constraints,
            "characters": characters_text,
        }
        values["story"] = {
            "outline": outline_text,
            "chapter_number": int(chapter.number),
            "chapter_title": (chapter.title or ""),
            "chapter_plan": (chapter.plan or ""),
            "previous_chapter": prev_text,
            "previous_chapter_ending": prev_ending,
        }
        values["user"] = {"instruction": body.instruction.strip()}
        values["context_optimizer_enabled"] = bool(getattr(settings_row, "context_optimizer_enabled", False))

        prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
            db,
            project_id=project_id,
            task="plan_chapter",
            values=values,  # type: ignore[arg-type]
            macro_seed=f"{request_id}:plan",
            provider=resolved_plan.llm_call.provider,
        )
        prompt_render_log_json = json.dumps(render_log, ensure_ascii=False)
        llm_call = resolved_plan.llm_call
    finally:
        db.close()

    if llm_call is None:
        raise AppError(code="INTERNAL_ERROR", message="LLM 调用准备失败", status_code=500)
    if not prompt_system.strip() and not prompt_user.strip():
        raise AppError(code="PROMPT_CONFIG_ERROR", message="缺少 plan_chapter 提示词预设/提示块", status_code=400)

    plan_step = run_plan_llm_step(
        logger=logger,
        request_id=request_id,
        actor_user_id=user_id,
        project_id=project_id,
        chapter_id=chapter_id,
        api_key=str(resolved_api_key),
        llm_call=llm_call,
        prompt_system=prompt_system,
        prompt_user=prompt_user,
        prompt_messages=prompt_messages,
        prompt_render_log_json=prompt_render_log_json,
    )

    data = dict(plan_step.plan_out)
    if plan_step.warnings:
        data["warnings"] = plan_step.warnings
    if plan_step.parse_error is not None:
        data["parse_error"] = plan_step.parse_error
    if plan_step.finish_reason is not None:
        data["finish_reason"] = plan_step.finish_reason
    return ok_payload(request_id=request_id, data=data)


@router.get("/chapters/{chapter_id}/context-estimate")
def estimate_chapter_context(
    request: Request,
    chapter_id: str,
    user_id: UserIdDep,
    db: DbDep,
) -> dict:
    """
    Lightweight endpoint to estimate context token usage for a chapter.
    Used by the frontend to show token budget indicators before generation.
    """
    from app.services.prompt_budget import estimate_tokens

    request_id = request.state.request_id
    chapter = require_chapter_viewer(db, chapter_id=chapter_id, user_id=user_id)
    project_id = str(chapter.project_id)

    # Estimate tokens from key context sources
    project_settings = db.get(ProjectSettings, project_id)
    world_setting = str(getattr(project_settings, "world_setting", "") or "")
    style_guide = str(getattr(project_settings, "style_guide", "") or "")
    constraints = str(getattr(project_settings, "constraints", "") or "")

    # Count previous chapter content
    prev_chapter_tokens = 0
    if chapter.number > 1:
        prev = db.execute(
            select(Chapter)
            .where(
                Chapter.project_id == project_id,
                Chapter.outline_id == chapter.outline_id,
                Chapter.number == chapter.number - 1,
            )
            .limit(1)
        ).scalar_one_or_none()
        if prev and prev.content_md:
            prev_chapter_tokens = estimate_tokens(str(prev.content_md)[-CURRENT_DRAFT_TAIL_CHARS:])

    # Get active outline
    outline_tokens = 0
    project = db.get(Project, project_id)
    if project and project.active_outline_id:
        outline = db.get(Outline, project.active_outline_id)
        if outline and outline.content_md:
            outline_tokens = estimate_tokens(str(outline.content_md))

    # Count characters
    characters = db.execute(
        select(Character).where(Character.project_id == project_id)
    ).scalars().all()
    characters_tokens = sum(
        estimate_tokens(str(c.profile or "") + str(c.notes or ""))
        for c in characters
    )

    # Estimate memory sections (rough, without actual retrieval)
    memory_estimate = 6000  # default estimate for all memory sections combined

    total_context_tokens = (
        estimate_tokens(world_setting)
        + estimate_tokens(style_guide)
        + estimate_tokens(constraints)
        + prev_chapter_tokens
        + outline_tokens
        + characters_tokens
        + memory_estimate
        + 500  # system prompt overhead
    )

    return ok_payload(
        request_id=request_id,
        data={
            "estimated_context_tokens": total_context_tokens,
            "breakdown": {
                "world_setting": estimate_tokens(world_setting),
                "style_guide": estimate_tokens(style_guide),
                "constraints": estimate_tokens(constraints),
                "previous_chapter": prev_chapter_tokens,
                "outline": outline_tokens,
                "characters": characters_tokens,
                "memory_sections": memory_estimate,
                "system_overhead": 500,
            },
        },
    )


@router.post("/chapters/{chapter_id}/generate-precheck")
def generate_chapter_precheck(
    request: Request,
    chapter_id: str,
    body: ChapterGenerateRequest,
    user_id: UserIdDep,
    x_llm_provider: str | None = Header(default=None, alias="X-LLM-Provider", max_length=64),
    x_llm_api_key: str | None = Header(default=None, alias="X-LLM-API-Key", max_length=4096),
) -> dict:
    request_id = request.state.request_id
    if body.plan_first:
        raise AppError.validation(message="生成预检不支持 plan_first（该模式依赖 LLM 产出的 plan）")

    macro_seed = _resolve_macro_seed(request_id=request_id, body=body)

    prompt_system = ""
    prompt_user = ""
    prompt_messages: list[ChatMessage] = []
    render_log: dict | None = None

    memory_pack = None
    memory_retrieval_log_json: dict[str, object] | None = None
    memory_injection_config: dict[str, object] | None = None
    mcp_research: dict[str, object] | None = None

    db = SessionLocal()
    try:
        chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
        project_id = chapter.project_id
        project = db.get(Project, project_id)
        if project is None:
            raise AppError.not_found()

        preset_row, _ = resolve_task_preset(db, project_id=project_id, task_key="chapter_generate")
        if preset_row is None:
            raise AppError(code="LLM_CONFIG_ERROR", message="请先在 Prompts 页保存 LLM 配置", status_code=400)
        chapter_llm_call = prepare_llm_call(preset_row)
        if x_llm_api_key and x_llm_provider and chapter_llm_call.provider != x_llm_provider:
            raise AppError(code="LLM_CONFIG_ERROR", message="当前任务 provider 与请求头不一致，请先保存/切换", status_code=400)

        values, base_instruction, _, style_resolution = build_chapter_generate_render_values(
            db,
            project=project,
            chapter=chapter,
            body=body,
            user_id=user_id,
        )
        settings_row = db.get(ProjectSettings, project_id)
        values["context_optimizer_enabled"] = bool(getattr(settings_row, "context_optimizer_enabled", False))
        memory_preparation = _prepare_chapter_memory_injection(
            db=db,
            project_id=project_id,
            chapter=chapter,
            body=body,
            settings_row=settings_row,
            base_instruction=base_instruction,
            values=values,
        )
        memory_pack = memory_preparation.memory_pack
        memory_injection_config = memory_preparation.memory_injection_config
        memory_retrieval_log_json = memory_preparation.memory_retrieval_log_json

        mcp_cfg = _build_mcp_research_config(body)
        mcp_step = run_mcp_research_step(
            logger=logger,
            request_id=request_id,
            actor_user_id=user_id,
            project_id=project_id,
            chapter_id=chapter_id,
            config=mcp_cfg,
        )
        _inject_mcp_research_into_values(values=values, context_md=mcp_step.context_md)
        if mcp_cfg.enabled or mcp_step.warnings:
            mcp_research = _mcp_research_params(
                cfg=mcp_cfg,
                applied=mcp_step.applied,
                tool_run_ids=[r.run_id for r in mcp_step.tool_runs],
                warnings=mcp_step.warnings,
            )

        prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
            db,
            project_id=project_id,
            task="chapter_generate",
            values=values,  # type: ignore[arg-type]
            macro_seed=macro_seed,
            provider=chapter_llm_call.provider,
        )
        prompt_system, prompt_user, prompt_messages, override_applied = _apply_prompt_override(
            prompt_system=prompt_system,
            prompt_user=prompt_user,
            prompt_messages=prompt_messages,
            body=body,
        )
    finally:
        db.close()

    if render_log is None:
        raise AppError(code="INTERNAL_ERROR", message="提示词渲染失败", status_code=500)
    if not prompt_system.strip() and not prompt_user.strip():
        raise AppError(code="PROMPT_CONFIG_ERROR", message="缺少 chapter_generate 提示词预设/提示块", status_code=400)

    return ok_payload(
        request_id=request_id,
        data={
            "precheck": {
                "task": "chapter_generate",
                "macro_seed": macro_seed,
                "prompt_system": prompt_system,
                "prompt_user": prompt_user,
                "messages": [{"role": m.role, "content": m.content, "name": m.name} for m in prompt_messages],
                "render_log": render_log,
                "style_resolution": style_resolution,
                "memory_pack": memory_pack,
                "memory_injection_config": memory_injection_config,
                "memory_retrieval_log_json": memory_retrieval_log_json,
                "mcp_research": mcp_research,
                "prompt_overridden": bool(override_applied),
            }
        },
    )


@router.post("/chapters/{chapter_id}/generate")
def generate_chapter(
    request: Request,
    chapter_id: str,
    body: ChapterGenerateRequest,
    user_id: UserIdDep,
    x_llm_provider: str | None = Header(default=None, alias="X-LLM-Provider", max_length=64),
    x_llm_api_key: str | None = Header(default=None, alias="X-LLM-API-Key", max_length=4096),
) -> dict:
    request_id = request.state.request_id
    macro_seed = _resolve_macro_seed(request_id=request_id, body=body)
    resolved_api_key = ""

    prompt_system = ""
    prompt_user = ""
    prompt_render_log_json: str | None = None
    render_values: dict[str, object] | None = None
    run_params_extra_json: dict[str, object] | None = None

    plan_prompt_system = ""
    plan_prompt_user = ""
    plan_prompt_render_log_json: str | None = None
    plan_prompt_messages: list[ChatMessage] = []
    plan_out: dict[str, object] | None = None
    plan_warnings: list[str] = []
    plan_parse_error: dict[str, object] | None = None
    plan_llm_call = None
    plan_api_key = ""
    llm_call = None
    project_id = ""

    db = SessionLocal()
    try:
        chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
        project_id = chapter.project_id
        if body.context.require_sequential:
            missing_numbers = _find_missing_prereq_numbers(
                db,
                project_id=project_id,
                outline_id=chapter.outline_id,
                chapter_number=int(chapter.number),
            )
            if missing_numbers:
                raise AppError(
                    code="CHAPTER_PREREQ_MISSING",
                    message=f"缺少前置章节内容：第 {', '.join(str(n) for n in missing_numbers)} 章",
                    status_code=400,
                    details={"missing_numbers": missing_numbers},
                )
        project = db.get(Project, project_id)
        if project is None:
            raise AppError.not_found()

        resolved_chapter = _resolve_task_llm_for_call(
            db=db,
            project=project,
            user_id=user_id,
            task_key="chapter_generate",
            x_llm_provider=x_llm_provider,
            x_llm_api_key=x_llm_api_key,
        )
        resolved_api_key = str(resolved_chapter.api_key)
        llm_call = resolved_chapter.llm_call

        values, base_instruction, requirements_obj, style_resolution = build_chapter_generate_render_values(
            db,
            project=project,
            chapter=chapter,
            body=body,
            user_id=user_id,
        )
        settings_row = db.get(ProjectSettings, project_id)
        values["context_optimizer_enabled"] = bool(getattr(settings_row, "context_optimizer_enabled", False))
        memory_preparation = _prepare_chapter_memory_injection(
            db=db,
            project_id=project_id,
            chapter=chapter,
            body=body,
            settings_row=settings_row,
            base_instruction=base_instruction,
            values=values,
        )
        render_values = values
        run_params_extra_json = _build_memory_run_params_extra_json(
            style_resolution=style_resolution,
            memory_injection_enabled=body.memory_injection_enabled,
            memory_preparation=memory_preparation,
        )

        mcp_cfg = _build_mcp_research_config(body)
        mcp_step = run_mcp_research_step(
            logger=logger,
            request_id=request_id,
            actor_user_id=user_id,
            project_id=project_id,
            chapter_id=chapter_id,
            config=mcp_cfg,
        )
        _inject_mcp_research_into_values(values=values, context_md=mcp_step.context_md)
        if mcp_cfg.enabled or mcp_step.warnings:
            run_params_extra_json = run_params_extra_json or {}
            run_params_extra_json["mcp_research"] = _mcp_research_params(
                cfg=mcp_cfg,
                applied=mcp_step.applied,
                tool_run_ids=[r.run_id for r in mcp_step.tool_runs],
                warnings=mcp_step.warnings,
            )

        if body.plan_first:
            resolved_plan = _resolve_task_llm_for_call(
                db=db,
                project=project,
                user_id=user_id,
                task_key="plan_chapter",
                x_llm_provider=x_llm_provider,
                x_llm_api_key=x_llm_api_key,
            )
            plan_llm_call = resolved_plan.llm_call
            plan_api_key = str(resolved_plan.api_key)
            ensure_default_plan_preset(db, project_id=project_id)
            plan_values = dict(values)
            plan_values["instruction"] = base_instruction
            plan_values["user"] = {"instruction": base_instruction, "requirements": requirements_obj}
            plan_prompt_system, plan_prompt_user, plan_prompt_messages, _, _, _, plan_render_log = render_preset_for_task(
                db,
                project_id=project_id,
                task="plan_chapter",
                values=plan_values,  # type: ignore[arg-type]
                macro_seed=f"{macro_seed}:plan",
                provider=plan_llm_call.provider,
            )
            plan_prompt_render_log_json = json.dumps(plan_render_log, ensure_ascii=False)
        else:
            prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
                db,
                project_id=project_id,
                task="chapter_generate",
                values=values,  # type: ignore[arg-type]
                macro_seed=macro_seed,
                provider=llm_call.provider,
            )
            precheck_prompt_system = prompt_system
            precheck_prompt_user = prompt_user
            precheck_prompt_messages = prompt_messages
            prompt_system, prompt_user, prompt_messages, override_applied = _apply_prompt_override(
                prompt_system=prompt_system,
                prompt_user=prompt_user,
                prompt_messages=prompt_messages,
                body=body,
            )
            prompt_render_log_json = json.dumps(render_log, ensure_ascii=False)
            run_params_extra_json = run_params_extra_json or {}
            run_params_extra_json["prompt_inspector"] = _build_prompt_inspector_params(
                macro_seed=macro_seed,
                prompt_overridden=override_applied,
                body=body,
                precheck_prompt_system=precheck_prompt_system,
                precheck_prompt_user=precheck_prompt_user,
                precheck_prompt_messages=precheck_prompt_messages,
                final_prompt_system=prompt_system,
                final_prompt_user=prompt_user,
                final_prompt_messages=prompt_messages,
            )

    finally:
        db.close()

    if llm_call is None:
        raise AppError(code="INTERNAL_ERROR", message="LLM 调用准备失败", status_code=500)
    if render_values is None:
        raise AppError(code="INTERNAL_ERROR", message="提示词变量准备失败", status_code=500)

    if body.plan_first:
        if not plan_prompt_system.strip() and not plan_prompt_user.strip():
            raise AppError(
                code="PROMPT_CONFIG_ERROR",
                message="缺少 plan_chapter 提示词预设/提示块，请在 Prompt Studio 配置",
                status_code=400,
            )

        plan_step = run_plan_llm_step(
            logger=logger,
            request_id=request_id,
            actor_user_id=user_id,
            project_id=project_id,
            chapter_id=chapter_id,
            api_key=str(plan_api_key or resolved_api_key),
            llm_call=plan_llm_call or llm_call,
            prompt_system=plan_prompt_system,
            prompt_user=plan_prompt_user,
            prompt_messages=plan_prompt_messages,
            prompt_render_log_json=plan_prompt_render_log_json,
            run_params_extra_json=run_params_extra_json,
        )
        plan_out, plan_warnings, plan_parse_error = plan_step.plan_out, plan_step.warnings, plan_step.parse_error
        if plan_step.finish_reason is not None:
            plan_out["finish_reason"] = plan_step.finish_reason

        plan_text = str((plan_out or {}).get("plan") or "").strip()
        if plan_text:
            render_values = inject_plan_into_render_values(render_values, plan_text=plan_text)
            render_values["context_optimizer_enabled"] = bool(getattr(settings_row, "context_optimizer_enabled", False))

        # Render chapter prompt after plan injection.
        with SessionLocal() as db2:
            prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
                db2,
                project_id=project_id,
                task="chapter_generate",
                values=render_values,  # type: ignore[arg-type]
                macro_seed=macro_seed,
                provider=llm_call.provider,
            )
        precheck_prompt_system = prompt_system
        precheck_prompt_user = prompt_user
        precheck_prompt_messages = prompt_messages
        prompt_system, prompt_user, prompt_messages, override_applied = _apply_prompt_override(
            prompt_system=prompt_system,
            prompt_user=prompt_user,
            prompt_messages=prompt_messages,
            body=body,
        )
        prompt_render_log_json = json.dumps(render_log, ensure_ascii=False)
        run_params_extra_json = run_params_extra_json or {}
        run_params_extra_json["prompt_inspector"] = _build_prompt_inspector_params(
            macro_seed=macro_seed,
            prompt_overridden=override_applied,
            body=body,
            precheck_prompt_system=precheck_prompt_system,
            precheck_prompt_user=precheck_prompt_user,
            precheck_prompt_messages=precheck_prompt_messages,
            final_prompt_system=prompt_system,
            final_prompt_user=prompt_user,
            final_prompt_messages=prompt_messages,
        )

    if body.target_word_count is not None:
        llm_call = with_param_overrides(
            llm_call,
            {
                "max_tokens": estimate_max_tokens(
                    target_word_count=body.target_word_count, provider=llm_call.provider, model=llm_call.model
                )
            },
        )

    gen_step = run_chapter_generate_llm_step(
        logger=logger,
        request_id=request_id,
        actor_user_id=user_id,
        project_id=project_id,
        chapter_id=chapter_id,
        run_type="chapter",
        api_key=str(resolved_api_key),
        llm_call=llm_call,
        prompt_system=prompt_system,
        prompt_user=prompt_user,
        prompt_messages=prompt_messages,
        prompt_render_log_json=prompt_render_log_json,
        run_params_extra_json=run_params_extra_json,
    )
    data, warnings, parse_error = gen_step.data, gen_step.warnings, gen_step.parse_error

    if body.post_edit:
        raw_content = str(data.get("content_md") or "").strip()
        post_edit_applied = False
        post_edit_warnings: list[str] = []
        post_edit_parse_error: dict[str, object] | None = None

        if raw_content:
            data["post_edit_raw_content_md"] = raw_content
            step = run_post_edit_step(
                logger=logger,
                request_id=request_id,
                actor_user_id=user_id,
                project_id=project_id,
                chapter_id=chapter_id,
                api_key=str(resolved_api_key),
                llm_call=llm_call,
                render_values=render_values or {},
                raw_content=raw_content,
                macro_seed=f"{macro_seed}:post_edit",
                post_edit_sanitize=bool(body.post_edit_sanitize),
                run_params_extra_json={**(run_params_extra_json or {}), "post_edit_sanitize": bool(body.post_edit_sanitize)},
            )
            post_edit_warnings = step.warnings
            post_edit_parse_error = step.parse_error
            data["post_edit_run_id"] = step.run_id
            data["post_edit_edited_content_md"] = step.edited_content_md
            if step.applied:
                data["content_md"] = step.edited_content_md
                post_edit_applied = True
        else:
            post_edit_warnings.append("post_edit_no_content")

        data["post_edit_applied"] = post_edit_applied
        if post_edit_warnings:
            data["post_edit_warnings"] = post_edit_warnings
        if post_edit_parse_error is not None:
            data["post_edit_parse_error"] = post_edit_parse_error

    if body.content_optimize:
        raw_content = str(data.get("content_md") or "").strip()
        content_optimize_applied = False
        content_optimize_warnings: list[str] = []
        content_optimize_parse_error: dict[str, object] | None = None

        if raw_content:
            data["content_optimize_raw_content_md"] = raw_content
            step = run_content_optimize_step(
                logger=logger,
                request_id=request_id,
                actor_user_id=user_id,
                project_id=project_id,
                chapter_id=chapter_id,
                api_key=str(resolved_api_key),
                llm_call=llm_call,
                render_values=render_values or {},
                raw_content=raw_content,
                macro_seed=f"{macro_seed}:content_optimize",
                run_params_extra_json={**(run_params_extra_json or {}), "content_optimize": True},
            )
            content_optimize_warnings = step.warnings
            content_optimize_parse_error = step.parse_error
            data["content_optimize_run_id"] = step.run_id
            data["content_optimize_optimized_content_md"] = step.optimized_content_md
            if step.applied:
                data["content_md"] = step.optimized_content_md
                content_optimize_applied = True
        else:
            content_optimize_warnings.append("content_optimize_no_content")

        data["content_optimize_applied"] = content_optimize_applied
        if content_optimize_warnings:
            data["content_optimize_warnings"] = content_optimize_warnings
        if content_optimize_parse_error is not None:
            data["content_optimize_parse_error"] = content_optimize_parse_error

    if warnings:
        data["warnings"] = warnings
    if parse_error is not None:
        data["parse_error"] = parse_error
    if body.plan_first:
        data["plan"] = str((plan_out or {}).get("plan") or "")
        if plan_warnings:
            data["plan_warnings"] = plan_warnings
        if plan_parse_error is not None:
            data["plan_parse_error"] = plan_parse_error
    data["generation_run_id"] = gen_step.run_id
    data["latency_ms"] = gen_step.latency_ms
    if gen_step.dropped_params:
        data["dropped_params"] = gen_step.dropped_params
    if gen_step.finish_reason is not None:
        data["finish_reason"] = gen_step.finish_reason
    return ok_payload(request_id=request_id, data=data)


@router.post("/chapters/{chapter_id}/generate-stream")
def generate_chapter_stream(
    request: Request,
    chapter_id: str,
    body: ChapterGenerateRequest,
    user_id: UserIdDep,
    x_llm_provider: str | None = Header(default=None, alias="X-LLM-Provider", max_length=64),
    x_llm_api_key: str | None = Header(default=None, alias="X-LLM-API-Key", max_length=4096),
):
    request_id = request.state.request_id
    macro_seed = _resolve_macro_seed(request_id=request_id, body=body)

    if body.context.require_sequential:
        with SessionLocal() as db:
            chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
            missing_numbers = _find_missing_prereq_numbers(
                db,
                project_id=chapter.project_id,
                outline_id=chapter.outline_id,
                chapter_number=int(chapter.number),
            )
            if missing_numbers:
                raise AppError(
                    code="CHAPTER_PREREQ_MISSING",
                    message=f"缺少前置章节内容：第 {', '.join(str(n) for n in missing_numbers)} 章",
                    status_code=400,
                    details={"missing_numbers": missing_numbers},
                )

    def event_generator():
        yield sse_start(message="开始生成...", progress=0)
        yield sse_progress(message="准备生成...", progress=0)

        prompt_system = ""
        prompt_user = ""
        prompt_messages = []
        prompt_render_log_json: str | None = None
        render_values: dict[str, object] | None = None
        run_params_extra_json: dict[str, object] | None = None
        run_params_json: str | None = None

        plan_prompt_system = ""
        plan_prompt_user = ""
        plan_prompt_messages = []
        plan_prompt_render_log_json: str | None = None
        plan_out: dict[str, object] | None = None
        plan_warnings: list[str] = []
        plan_parse_error: dict[str, object] | None = None
        plan_llm_call = None
        plan_api_key = ""

        llm_call = None
        project_id = ""
        resolved_api_key = ""

        db = SessionLocal()
        try:
            chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
            project_id = chapter.project_id
            project = db.get(Project, project_id)
            if project is None:
                raise AppError.not_found()

            resolved_chapter = _resolve_task_llm_for_call(
                db=db,
                project=project,
                user_id=user_id,
                task_key="chapter_generate",
                x_llm_provider=x_llm_provider,
                x_llm_api_key=x_llm_api_key,
            )
            llm_call = resolved_chapter.llm_call
            resolved_api_key = str(resolved_chapter.api_key)

            values, base_instruction, requirements_obj, style_resolution = build_chapter_generate_render_values(
                db,
                project=project,
                chapter=chapter,
                body=body,
                user_id=user_id,
            )
            settings_row = db.get(ProjectSettings, project_id)
            values["context_optimizer_enabled"] = bool(getattr(settings_row, "context_optimizer_enabled", False))
            memory_preparation = _prepare_chapter_memory_injection(
                db=db,
                project_id=project_id,
                chapter=chapter,
                body=body,
                settings_row=settings_row,
                base_instruction=base_instruction,
                values=values,
            )
            render_values = values
            run_params_extra_json = _build_memory_run_params_extra_json(
                style_resolution=style_resolution,
                memory_injection_enabled=body.memory_injection_enabled,
                memory_preparation=memory_preparation,
            )

            mcp_cfg = _build_mcp_research_config(body)
            mcp_step = run_mcp_research_step(
                logger=logger,
                request_id=request_id,
                actor_user_id=user_id,
                project_id=project_id,
                chapter_id=chapter_id,
                config=mcp_cfg,
            )
            _inject_mcp_research_into_values(values=values, context_md=mcp_step.context_md)
            if mcp_cfg.enabled or mcp_step.warnings:
                run_params_extra_json = run_params_extra_json or {}
                run_params_extra_json["mcp_research"] = _mcp_research_params(
                    cfg=mcp_cfg,
                    applied=mcp_step.applied,
                    tool_run_ids=[r.run_id for r in mcp_step.tool_runs],
                    warnings=mcp_step.warnings,
                )

            if body.plan_first:
                resolved_plan = _resolve_task_llm_for_call(
                    db=db,
                    project=project,
                    user_id=user_id,
                    task_key="plan_chapter",
                    x_llm_provider=x_llm_provider,
                    x_llm_api_key=x_llm_api_key,
                )
                plan_llm_call = resolved_plan.llm_call
                plan_api_key = str(resolved_plan.api_key)
                ensure_default_plan_preset(db, project_id=project_id)
                plan_values = dict(values)
                plan_values["instruction"] = base_instruction
                plan_values["user"] = {"instruction": base_instruction, "requirements": requirements_obj}
                plan_prompt_system, plan_prompt_user, plan_prompt_messages, _, _, _, plan_render_log = render_preset_for_task(
                    db,
                    project_id=project_id,
                    task="plan_chapter",
                    values=plan_values,  # type: ignore[arg-type]
                    macro_seed=f"{macro_seed}:plan",
                    provider=plan_llm_call.provider,
                )
                plan_prompt_render_log_json = json.dumps(plan_render_log, ensure_ascii=False)
            else:
                prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
                    db,
                    project_id=project_id,
                    task="chapter_generate",
                    values=values,  # type: ignore[arg-type]
                    macro_seed=macro_seed,
                    provider=llm_call.provider,
                )
                precheck_prompt_system = prompt_system
                precheck_prompt_user = prompt_user
                precheck_prompt_messages = prompt_messages
                prompt_system, prompt_user, prompt_messages, override_applied = _apply_prompt_override(
                    prompt_system=prompt_system,
                    prompt_user=prompt_user,
                    prompt_messages=prompt_messages,
                    body=body,
                )
                prompt_render_log_json = json.dumps(render_log, ensure_ascii=False)
                run_params_extra_json = run_params_extra_json or {}
                run_params_extra_json["prompt_inspector"] = _build_prompt_inspector_params(
                    macro_seed=macro_seed,
                    prompt_overridden=override_applied,
                    body=body,
                    precheck_prompt_system=precheck_prompt_system,
                    precheck_prompt_user=precheck_prompt_user,
                    precheck_prompt_messages=precheck_prompt_messages,
                    final_prompt_system=prompt_system,
                    final_prompt_user=prompt_user,
                    final_prompt_messages=prompt_messages,
                )

            run_params_json = build_run_params_json(
                params_json=llm_call.params_json,
                memory_retrieval_log_json=None,
                extra_json=run_params_extra_json,
            )
        except GeneratorExit:
            return
        except AppError as exc:
            yield sse_error(error=f"{exc.message} ({exc.code})", code=exc.status_code)
            yield sse_done()
            return
        finally:
            db.close()

        if llm_call is None:
            yield sse_error(error="LLM 调用准备失败", code=500)
            yield sse_done()
            return
        if run_params_json is None:
            run_params_json = build_run_params_json(
                params_json=llm_call.params_json,
                memory_retrieval_log_json=None,
                extra_json=run_params_extra_json,
            )

        if render_values is None:
            yield sse_error(error="提示词变量准备失败", code=500)
            yield sse_done()
            return

        raw_output = ""
        generation_run_id: str | None = None
        finish_reason: str | None = None
        dropped_params: list[str] = []
        latency_ms: int | None = None
        stream_run_written = False
        generation_started = False
        try:
            if body.plan_first:
                if not plan_prompt_system.strip() and not plan_prompt_user.strip():
                    yield sse_error(error="缺少 plan_chapter 提示词预设/提示块，请在 Prompt Studio 配置", code=400)
                    yield sse_done()
                    return

                yield sse_progress(message="生成规划...", progress=5)
                plan_step = run_plan_llm_step(
                    logger=logger,
                    request_id=request_id,
                    actor_user_id=user_id,
                    project_id=project_id,
                    chapter_id=chapter_id,
                    api_key=str(plan_api_key or resolved_api_key),
                    llm_call=plan_llm_call or llm_call,
                    prompt_system=plan_prompt_system,
                    prompt_user=plan_prompt_user,
                    prompt_messages=plan_prompt_messages,
                    prompt_render_log_json=plan_prompt_render_log_json,
                    run_params_extra_json=run_params_extra_json,
                )
                plan_out, plan_warnings, plan_parse_error = plan_step.plan_out, plan_step.warnings, plan_step.parse_error
                if plan_parse_error is not None:
                    err_code = str(plan_parse_error.get("code") or "PLAN_PARSE_ERROR")
                    err_msg = str(plan_parse_error.get("message") or "无法解析规划输出")
                    yield sse_progress(
                        message=f"规划解析失败（{err_code}）：{err_msg}（将继续生成） (request_id={request_id})",
                        progress=6,
                        status="error",
                    )

                plan_text = str((plan_out or {}).get("plan") or "").strip()
                if plan_text:
                    render_values = inject_plan_into_render_values(render_values, plan_text=plan_text)

                yield sse_progress(message="渲染章节提示词...", progress=8)
                with SessionLocal() as db2:
                    prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
                        db2,
                        project_id=project_id,
                        task="chapter_generate",
                        values=render_values,  # type: ignore[arg-type]
                        macro_seed=macro_seed,
                        provider=llm_call.provider,
                    )

                precheck_prompt_system = prompt_system
                precheck_prompt_user = prompt_user
                precheck_prompt_messages = prompt_messages
                prompt_system, prompt_user, prompt_messages, override_applied = _apply_prompt_override(
                    prompt_system=prompt_system,
                    prompt_user=prompt_user,
                    prompt_messages=prompt_messages,
                    body=body,
                )
                prompt_render_log_json = json.dumps(render_log, ensure_ascii=False)
                run_params_extra_json = run_params_extra_json or {}
                run_params_extra_json["prompt_inspector"] = _build_prompt_inspector_params(
                    macro_seed=macro_seed,
                    prompt_overridden=override_applied,
                    body=body,
                    precheck_prompt_system=precheck_prompt_system,
                    precheck_prompt_user=precheck_prompt_user,
                    precheck_prompt_messages=precheck_prompt_messages,
                    final_prompt_system=prompt_system,
                    final_prompt_user=prompt_user,
                    final_prompt_messages=prompt_messages,
                )
                run_params_json = build_run_params_json(
                    params_json=llm_call.params_json,
                    memory_retrieval_log_json=None,
                    extra_json=run_params_extra_json,
                )

            if body.target_word_count is not None:
                llm_call = with_param_overrides(
                    llm_call,
                    {"max_tokens": estimate_max_tokens(target_word_count=body.target_word_count, provider=llm_call.provider, model=llm_call.model)},
                )

            yield sse_progress(message="调用模型...", progress=10)
            generation_started = True

            target = body.target_word_count or 0

            def _chunk_text(text: str, *, chunk_size: int = 2048) -> list[str]:
                raw = str(text or "")
                if not raw:
                    return []
                return [raw[i : i + chunk_size] for i in range(0, len(raw), chunk_size)]

            max_attempts = task_llm_max_attempts(default=2)
            attempts: list[dict[str, object]] = []
            used_stream_fallback = False
            in_non_stream_fallback = False

            for attempt in range(1, max_attempts + 1):
                raw_output = ""
                last_progress = 10
                last_progress_ts = 0.0
                chunk_count = 0

                try:
                    stream_iter, state = call_llm_stream_messages(
                        provider=llm_call.provider,
                        base_url=llm_call.base_url,
                        model=llm_call.model,
                        api_key=str(resolved_api_key),
                        messages=prompt_messages,
                        params=llm_call.params,
                        timeout_seconds=llm_call.timeout_seconds,
                        extra=llm_call.extra,
                    )

                    try:
                        for delta in stream_iter:
                            raw_output += delta
                            yield sse_chunk(delta)
                            chunk_count += 1
                            if chunk_count % 12 == 0:
                                yield sse_heartbeat()
                            now = time.monotonic()
                            if now - last_progress_ts >= 0.8:
                                if target > 0:
                                    next_progress = 10 + int(min(1.0, len(raw_output) / float(target)) * 80)
                                else:
                                    next_progress = 10 + int(min(1.0, len(raw_output) / 12000.0) * 80)
                                next_progress = max(last_progress, min(90, next_progress))
                                if next_progress != last_progress:
                                    last_progress = next_progress
                                    yield sse_progress(message="生成中...", progress=next_progress, char_count=len(raw_output))
                                last_progress_ts = now
                    finally:
                        close = getattr(stream_iter, "close", None)
                        if callable(close):
                            close()

                    finish_reason = state.finish_reason
                    dropped_params = state.dropped_params
                    latency_ms = state.latency_ms

                    # Some OpenAI-compatible gateways do not support SSE and return a non-stream response.
                    # If the upstream sends no stream deltas, fall back to a non-stream call and then emit chunks.
                    if chunk_count == 0 and not raw_output.strip():
                        used_stream_fallback = True
                        in_non_stream_fallback = True
                        yield sse_progress(message="未收到流式分片，回退非流式...", progress=12)

                        non_stream_attempts = task_llm_max_attempts(default=2)
                        for attempt2 in range(1, non_stream_attempts + 1):
                            try:
                                res2 = call_llm_messages(
                                    provider=llm_call.provider,
                                    base_url=llm_call.base_url,
                                    model=llm_call.model,
                                    api_key=str(resolved_api_key),
                                    messages=prompt_messages,
                                    params=llm_call.params,
                                    timeout_seconds=llm_call.timeout_seconds,
                                    extra=llm_call.extra,
                                )
                                raw_output = res2.text or ""
                                finish_reason = res2.finish_reason
                                dropped_params = res2.dropped_params
                                latency_ms = res2.latency_ms

                                parts = _chunk_text(raw_output)
                                for i, part in enumerate(parts, start=1):
                                    yield sse_chunk(part)
                                    if i % 12 == 0:
                                        yield sse_heartbeat()
                                break
                            except AppError as exc2:
                                retryable2 = is_retryable_llm_error(exc2)
                                attempts.append(
                                    {
                                        "attempt": int(attempt2),
                                        "mode": "non_stream",
                                        "error_code": str(exc2.code),
                                        "status_code": int(exc2.status_code),
                                        "retryable": bool(retryable2),
                                    }
                                )
                                if attempt2 >= non_stream_attempts or not retryable2:
                                    if attempts:
                                        exc2.details = {
                                            **(exc2.details or {}),
                                            "attempts": attempts,
                                            "attempt_max": int(non_stream_attempts),
                                        }
                                    raise

                                delay2 = compute_backoff_seconds(
                                    attempt=attempt2 + 1,
                                    base_seconds=task_llm_retry_base_seconds(),
                                    max_seconds=task_llm_retry_max_seconds(),
                                    jitter=task_llm_retry_jitter(),
                                    error_code=str(exc2.code),
                                )
                                attempts[-1]["sleep_seconds"] = float(delay2)
                                yield sse_progress(
                                    message=f"非流式重试中（{attempt2 + 1}/{non_stream_attempts}）...",
                                    progress=12,
                                )
                                if delay2 > 0:
                                    time.sleep(float(delay2))
                        in_non_stream_fallback = False
                        break

                    break
                except AppError as exc:
                    if in_non_stream_fallback:
                        if attempts:
                            exc.details = {
                                **(exc.details or {}),
                                "attempts": attempts,
                                "attempt_max": int(non_stream_attempts),
                            }
                        raise

                    retryable = is_retryable_llm_error(exc)
                    attempts.append(
                        {
                            "attempt": int(attempt),
                            "mode": "stream",
                            "error_code": str(exc.code),
                            "status_code": int(exc.status_code),
                            "retryable": bool(retryable),
                        }
                    )

                    # If we already streamed output, we cannot safely retry without duplicating content.
                    if chunk_count > 0 or attempt >= max_attempts or not retryable:
                        if attempts:
                            exc.details = {**(exc.details or {}), "attempts": attempts, "attempt_max": int(max_attempts)}
                        raise

                    delay = compute_backoff_seconds(
                        attempt=attempt + 1,
                        base_seconds=task_llm_retry_base_seconds(),
                        max_seconds=task_llm_retry_max_seconds(),
                        jitter=task_llm_retry_jitter(),
                        error_code=str(exc.code),
                    )
                    attempts[-1]["sleep_seconds"] = float(delay)
                    yield sse_progress(message=f"上游波动，重试中（{attempt + 1}/{max_attempts}）...", progress=10)
                    if delay > 0:
                        time.sleep(float(delay))
                    continue

            log_event(
                logger,
                "info",
                llm={
                    "provider": llm_call.provider,
                    "model": llm_call.model,
                    "timeout_seconds": llm_call.timeout_seconds,
                    "prompt_chars": len(prompt_system) + len(prompt_user),
                    "output_chars": len(raw_output or ""),
                    "dropped_params": dropped_params,
                    "finish_reason": finish_reason,
                    "stream": True,
                },
            )

            if used_stream_fallback or attempts:
                run_params_extra_json = run_params_extra_json or {}
                if used_stream_fallback:
                    run_params_extra_json["stream_fallback"] = {"used": True}
                if attempts:
                    run_params_extra_json["llm_retry"] = {"attempts": attempts}
                run_params_json = build_run_params_json(
                    params_json=llm_call.params_json,
                    memory_retrieval_log_json=None,
                    extra_json=run_params_extra_json,
                )
            generation_run_id = write_generation_run(
                request_id=request_id,
                actor_user_id=user_id,
                project_id=project_id,
                chapter_id=chapter_id,
                run_type="chapter_stream",
                provider=llm_call.provider,
                model=llm_call.model,
                prompt_system=prompt_system,
                prompt_user=prompt_user,
                prompt_render_log_json=prompt_render_log_json,
                params_json=run_params_json,
                output_text=raw_output,
                error_json=None,
            )
            stream_run_written = True

            yield sse_progress(message="解析输出...", progress=90)
            chapter_contract = contract_for_task("chapter_generate")
            parsed = chapter_contract.parse(raw_output, finish_reason=finish_reason)
            data, warnings, parse_error = parsed.data, parsed.warnings, parsed.parse_error

            if body.post_edit:
                raw_content = str(data.get("content_md") or "").strip()
                post_edit_applied = False
                post_edit_warnings: list[str] = []
                post_edit_parse_error: dict[str, object] | None = None

                if raw_content:
                    data["post_edit_raw_content_md"] = raw_content
                    yield sse_progress(message="润色中...", progress=95)
                    step = run_post_edit_step(
                        logger=logger,
                        request_id=request_id,
                        actor_user_id=user_id,
                        project_id=project_id,
                        chapter_id=chapter_id,
                        api_key=str(resolved_api_key),
                        llm_call=llm_call,
                        render_values=render_values or {},
                        raw_content=raw_content,
                        macro_seed=f"{macro_seed}:post_edit",
                        post_edit_sanitize=bool(body.post_edit_sanitize),
                        run_params_extra_json={**(run_params_extra_json or {}), "post_edit_sanitize": bool(body.post_edit_sanitize)},
                    )
                    post_edit_warnings = step.warnings
                    post_edit_parse_error = step.parse_error
                    data["post_edit_run_id"] = step.run_id
                    data["post_edit_edited_content_md"] = step.edited_content_md
                    if step.applied:
                        data["content_md"] = step.edited_content_md
                        post_edit_applied = True
                else:
                    post_edit_warnings.append("post_edit_no_content")

                data["post_edit_applied"] = post_edit_applied
                if post_edit_warnings:
                    data["post_edit_warnings"] = post_edit_warnings
                if post_edit_parse_error is not None:
                    data["post_edit_parse_error"] = post_edit_parse_error

            if body.content_optimize:
                raw_content = str(data.get("content_md") or "").strip()
                content_optimize_applied = False
                content_optimize_warnings: list[str] = []
                content_optimize_parse_error: dict[str, object] | None = None

                if raw_content:
                    data["content_optimize_raw_content_md"] = raw_content
                    yield sse_progress(message="正文优化中...", progress=97)
                    step = run_content_optimize_step(
                        logger=logger,
                        request_id=request_id,
                        actor_user_id=user_id,
                        project_id=project_id,
                        chapter_id=chapter_id,
                        api_key=str(resolved_api_key),
                        llm_call=llm_call,
                        render_values=render_values or {},
                        raw_content=raw_content,
                        macro_seed=f"{macro_seed}:content_optimize",
                        run_params_extra_json={**(run_params_extra_json or {}), "content_optimize": True},
                    )
                    content_optimize_warnings = step.warnings
                    content_optimize_parse_error = step.parse_error
                    data["content_optimize_run_id"] = step.run_id
                    data["content_optimize_optimized_content_md"] = step.optimized_content_md
                    if step.applied:
                        data["content_md"] = step.optimized_content_md
                        content_optimize_applied = True
                else:
                    content_optimize_warnings.append("content_optimize_no_content")

                data["content_optimize_applied"] = content_optimize_applied
                if content_optimize_warnings:
                    data["content_optimize_warnings"] = content_optimize_warnings
                if content_optimize_parse_error is not None:
                    data["content_optimize_parse_error"] = content_optimize_parse_error

            if warnings:
                data["warnings"] = warnings
            if parse_error is not None:
                data["parse_error"] = parse_error
            if body.plan_first:
                data["plan"] = str((plan_out or {}).get("plan") or "")
                if plan_warnings:
                    data["plan_warnings"] = plan_warnings
                if plan_parse_error is not None:
                    data["plan_parse_error"] = plan_parse_error
            if finish_reason is not None:
                data["finish_reason"] = finish_reason
            if latency_ms is not None:
                data["latency_ms"] = latency_ms
            if dropped_params:
                data["dropped_params"] = dropped_params
            if generation_run_id is not None:
                data["generation_run_id"] = generation_run_id

            yield sse_progress(message="完成", progress=100, status="success")
            yield sse_result(data)
            yield sse_done()
        except GeneratorExit:
            return
        except AppError as exc:
            if (
                generation_started
                and llm_call is not None
                and not stream_run_written
            ):
                write_generation_run(
                    request_id=request_id,
                    actor_user_id=user_id,
                    project_id=project_id,
                    chapter_id=chapter_id,
                    run_type="chapter_stream",
                    provider=llm_call.provider,
                    model=llm_call.model,
                    prompt_system=prompt_system,
                    prompt_user=prompt_user,
                    prompt_render_log_json=prompt_render_log_json,
                    params_json=run_params_json,
                    output_text=raw_output or None,
                    error_json=json.dumps({"code": exc.code, "message": exc.message, "details": exc.details}, ensure_ascii=False),
                )
                stream_run_written = True
            yield sse_error(error=f"{exc.message} ({exc.code})", code=exc.status_code)
            yield sse_done()
        except Exception as exc:
            log_event(
                logger,
                "error",
                error="SSE_STREAM_ERROR",
                path=request.url.path,
                method=request.method,
                chapter_id=chapter_id,
                **exception_log_fields(exc),
            )
            if (
                generation_started
                and llm_call is not None
                and not stream_run_written
            ):
                err_fields = dict(exception_log_fields(exc))
                err_fields.pop("stack", None)
                write_generation_run(
                    request_id=request_id,
                    actor_user_id=user_id,
                    project_id=project_id,
                    chapter_id=chapter_id,
                    run_type="chapter_stream",
                    provider=llm_call.provider,
                    model=llm_call.model,
                    prompt_system=prompt_system,
                    prompt_user=prompt_user,
                    prompt_render_log_json=prompt_render_log_json,
                    params_json=run_params_json,
                    output_text=raw_output or None,
                    error_json=json.dumps(
                        {
                            "code": "INTERNAL_ERROR",
                            "message": "服务器内部错误",
                            "details": err_fields,
                        },
                        ensure_ascii=False,
                    ),
                )
                stream_run_written = True
            yield sse_error(error="服务器内部错误", code=500)
            yield sse_done()

    return create_sse_response(event_generator())
