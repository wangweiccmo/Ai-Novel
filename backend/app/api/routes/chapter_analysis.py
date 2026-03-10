from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Header, Request
from sqlalchemy import select

from app.api.deps import DbDep, UserIdDep, require_chapter_editor, require_chapter_viewer
from app.core.logging import log_event
from app.core.errors import AppError, ok_payload
from app.db.session import SessionLocal
from app.models.project import Project
from app.models.story_memory import StoryMemory
from app.schemas.chapter_analysis import ChapterAnalyzeRequest, ChapterAnalysisApplyRequest, ChapterRewriteRequest
from app.schemas.memory_update import MemoryUpdateV1Request
from app.services.annotations_service import build_annotations_from_story_memories
from app.services.chapter_context_service import build_chapter_analyze_render_values, build_chapter_rewrite_render_values
from app.services.generation_service import call_llm_and_record, with_param_overrides
from app.services.llm_task_preset_resolver import resolve_task_llm_config
from app.services.memory_update_service import propose_chapter_memory_change_set
from app.services.output_contracts import contract_for_task
from app.services.plot_analysis_service import apply_chapter_analysis as apply_plot_analysis, compute_quality_scores
from app.services.prompt_presets import (
    _ensure_default_preset_from_resource,
    ensure_default_chapter_analyze_preset,
    ensure_default_chapter_rewrite_preset,
    render_preset_for_task,
)

router = APIRouter()
logger = logging.getLogger("ainovel")


def _resolve_task_llm_for_call(
    *,
    db,
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


@router.post("/chapters/{chapter_id}/analyze")
def analyze_chapter(
    request: Request,
    chapter_id: str,
    body: ChapterAnalyzeRequest,
    user_id: UserIdDep,
    x_llm_provider: str | None = Header(default=None, alias="X-LLM-Provider", max_length=64),
    x_llm_api_key: str | None = Header(default=None, alias="X-LLM-API-Key", max_length=4096),
) -> dict:
    request_id = request.state.request_id
    resolved_api_key = ""

    prompt_system = ""
    prompt_user = ""
    prompt_render_log_json: str | None = None
    llm_call = None
    project_id = ""
    quality_content_md = ""

    auto_memupd = bool(getattr(body, "auto_propose_memory_update", False))
    memupd_focus = str(getattr(body, "memory_update_focus", "") or "").strip()
    memupd_idempotency_key = str(getattr(body, "memory_update_idempotency_key", "") or "").strip() or None

    memupd_skip_reason: str | None = None
    memupd_prompt_system = ""
    memupd_prompt_user = ""
    memupd_prompt_render_log_json: str | None = None
    memupd_prompt_messages = None
    memupd_llm_call = None
    memupd_api_key = ""

    db = SessionLocal()
    try:
        chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
        project_id = chapter.project_id
        project = db.get(Project, project_id)
        if project is None:
            raise AppError.not_found()
        quality_content_md = str(body.draft_content_md if body.draft_content_md is not None else (chapter.content_md or ""))

        resolved_analyze = _resolve_task_llm_for_call(
            db=db,
            project=project,
            user_id=user_id,
            task_key="chapter_analyze",
            x_llm_provider=x_llm_provider,
            x_llm_api_key=x_llm_api_key,
        )
        resolved_api_key = str(resolved_analyze.api_key)

        ensure_default_chapter_analyze_preset(db, project_id=project_id, activate=True)
        values = build_chapter_analyze_render_values(db, project=project, chapter=chapter, body=body)

        prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
            db,
            project_id=project_id,
            task="chapter_analyze",
            values=values,  # type: ignore[arg-type]
            macro_seed=f"{request_id}:analyze",
            provider=resolved_analyze.llm_call.provider,
        )
        prompt_render_log_json = json.dumps(render_log, ensure_ascii=False)
        llm_call = resolved_analyze.llm_call

        if auto_memupd:
            # Avoid draft pollution: only run auto-propose against persisted + done chapters.
            if (
                body.draft_title is not None
                or body.draft_plan is not None
                or body.draft_summary is not None
                or body.draft_content_md is not None
            ):
                memupd_skip_reason = "draft_override"
            chapter_status = str(getattr(chapter, "status", "") or "").strip().lower()
            if chapter_status != "done":
                memupd_skip_reason = memupd_skip_reason or "chapter_not_done"

            if memupd_skip_reason is None:
                _ensure_default_preset_from_resource(db, project_id=project_id, resource_key="memory_update_v1", activate=True)
                resolved_memupd = _resolve_task_llm_for_call(
                    db=db,
                    project=project,
                    user_id=user_id,
                    task_key="memory_update",
                    x_llm_provider=x_llm_provider,
                    x_llm_api_key=x_llm_api_key,
                )
                memupd_llm_call = resolved_memupd.llm_call
                memupd_api_key = str(resolved_memupd.api_key)
                memupd_values = {
                    "chapter_id": str(chapter.id),
                    "chapter_number": int(chapter.number),
                    "chapter_title": str(chapter.title or ""),
                    "chapter_plan": str(chapter.plan or ""),
                    "chapter_content_md": str(chapter.content_md or ""),
                    "focus": memupd_focus,
                }
                (
                    memupd_prompt_system,
                    memupd_prompt_user,
                    memupd_prompt_messages,
                    _,
                    _,
                    _,
                    memupd_render_log,
                ) = render_preset_for_task(
                    db,
                    project_id=project_id,
                    task="memory_update",
                    values=memupd_values,
                    macro_seed=f"{request_id}:memory_update",
                    provider=memupd_llm_call.provider,
                )
                memupd_prompt_render_log_json = json.dumps(memupd_render_log, ensure_ascii=False)
    finally:
        db.close()

    if llm_call is None:
        raise AppError(code="INTERNAL_ERROR", message="LLM 调用准备失败", status_code=500)
    if not prompt_system.strip() and not prompt_user.strip():
        raise AppError(code="PROMPT_CONFIG_ERROR", message="缺少 chapter_analyze 提示词预设/提示块", status_code=400)

    llm_call = with_param_overrides(llm_call, {"temperature": 0.2, "max_tokens": 2048})
    llm_result = call_llm_and_record(
        logger=logger,
        request_id=request_id,
        actor_user_id=user_id,
        project_id=project_id,
        chapter_id=chapter_id,
        run_type="chapter_analyze",
        api_key=str(resolved_api_key),
        prompt_system=prompt_system,
        prompt_user=prompt_user,
        prompt_messages=prompt_messages,
        prompt_render_log_json=prompt_render_log_json,
        llm_call=llm_call,
    )

    contract = contract_for_task("chapter_analyze")
    parsed = contract.parse(llm_result.text, finish_reason=llm_result.finish_reason)
    data, warnings, parse_error = parsed.data, parsed.warnings, parsed.parse_error
    data["generation_run_id"] = llm_result.run_id
    data["latency_ms"] = llm_result.latency_ms
    if llm_result.dropped_params:
        data["dropped_params"] = llm_result.dropped_params
    if warnings:
        data["warnings"] = warnings
    if parse_error is not None:
        data["parse_error"] = parse_error
    if parse_error is None and isinstance(data.get("analysis"), dict):
        data["quality_scores"] = compute_quality_scores(analysis=data["analysis"], content_md=quality_content_md)
    if llm_result.finish_reason is not None:
        data["finish_reason"] = llm_result.finish_reason

    if auto_memupd:
        if memupd_skip_reason is not None:
            data["memory_update_auto_propose"] = {"enabled": True, "ok": False, "skipped": True, "reason": memupd_skip_reason}
        elif memupd_llm_call is None:
            data["memory_update_auto_propose"] = {"enabled": True, "ok": False, "skipped": True, "reason": "memupd_prepare_failed"}
        elif not memupd_prompt_system.strip() and not memupd_prompt_user.strip():
            data["memory_update_auto_propose"] = {"enabled": True, "ok": False, "skipped": True, "reason": "memupd_prompt_missing"}
        else:
            try:
                memupd_llm_call2 = with_param_overrides(memupd_llm_call, {"temperature": 0.2, "max_tokens": 2048})
                memupd_llm_result = call_llm_and_record(
                    logger=logger,
                    request_id=request_id,
                    actor_user_id=user_id,
                    project_id=project_id,
                    chapter_id=chapter_id,
                    run_type="memory_update_auto_propose",
                    api_key=str(memupd_api_key or resolved_api_key),
                    prompt_system=memupd_prompt_system,
                    prompt_user=memupd_prompt_user,
                    prompt_messages=memupd_prompt_messages,
                    prompt_render_log_json=memupd_prompt_render_log_json,
                    llm_call=memupd_llm_call2,
                )

                contract2 = contract_for_task("memory_update")
                parsed2 = contract2.parse(memupd_llm_result.text, finish_reason=memupd_llm_result.finish_reason)
                if parsed2.parse_error is not None:
                    data["memory_update_auto_propose"] = {
                        "enabled": True,
                        "ok": False,
                        "skipped": True,
                        "reason": "memupd_parse_error",
                        "llm_generation_run_id": memupd_llm_result.run_id,
                        "finish_reason": memupd_llm_result.finish_reason,
                        "parse_error": parsed2.parse_error,
                        "warnings": parsed2.warnings,
                    }
                else:
                    idempotency_key = memupd_idempotency_key or f"anlz-memupd-{str(llm_result.run_id or '')[:8]}"
                    payload = MemoryUpdateV1Request(
                        schema_version="memory_update_v1",
                        idempotency_key=idempotency_key,
                        title=str(parsed2.data.get("title") or "Memory Update (auto)").strip() or "Memory Update (auto)",
                        summary_md=str(parsed2.data.get("summary_md") or "").strip() or None,
                        ops=list(parsed2.data.get("ops") or []),
                    )

                    db2 = SessionLocal()
                    try:
                        chapter2 = require_chapter_editor(db2, chapter_id=chapter_id, user_id=user_id)
                        status2 = str(getattr(chapter2, "status", "") or "").strip().lower()
                        if status2 != "done":
                            data["memory_update_auto_propose"] = {
                                "enabled": True,
                                "ok": False,
                                "skipped": True,
                                "reason": "chapter_not_done",
                                "llm_generation_run_id": memupd_llm_result.run_id,
                            }
                        else:
                            out = propose_chapter_memory_change_set(
                                db=db2, request_id=request_id, actor_user_id=user_id, chapter=chapter2, payload=payload
                            )
                            change_set = out.get("change_set") if isinstance(out, dict) else None
                            change_set_id = change_set.get("id") if isinstance(change_set, dict) else None
                            data["memory_update_auto_propose"] = {
                                "enabled": True,
                                "ok": True,
                                "skipped": False,
                                "idempotent": bool(out.get("idempotent")) if isinstance(out, dict) else False,
                                "change_set_id": change_set_id,
                                "llm_generation_run_id": memupd_llm_result.run_id,
                            }
                    finally:
                        db2.close()
            except AppError as exc:
                data["memory_update_auto_propose"] = {
                    "enabled": True,
                    "ok": False,
                    "skipped": True,
                    "reason": "memupd_error",
                    "error": {"code": str(exc.code), "message": str(exc.message)},
                }
            except Exception as exc:
                log_event(logger, "warning", event="CHAPTER_ANALYZE_AUTO_MEMUPD_FAILED", chapter_id=chapter_id, error=str(exc))
                data["memory_update_auto_propose"] = {
                    "enabled": True,
                    "ok": False,
                    "skipped": True,
                    "reason": "memupd_error",
                    "error": {"code": "INTERNAL_ERROR", "message": "自动记忆更新生成失败"},
                }
    return ok_payload(request_id=request_id, data=data)


@router.post("/chapters/{chapter_id}/rewrite")
def rewrite_chapter(
    request: Request,
    chapter_id: str,
    body: ChapterRewriteRequest,
    user_id: UserIdDep,
    x_llm_provider: str | None = Header(default=None, alias="X-LLM-Provider", max_length=64),
    x_llm_api_key: str | None = Header(default=None, alias="X-LLM-API-Key", max_length=4096),
) -> dict:
    request_id = request.state.request_id
    resolved_api_key = ""

    prompt_system = ""
    prompt_user = ""
    prompt_render_log_json: str | None = None
    llm_call = None
    project_id = ""

    if not body.analysis:
        raise AppError.validation(message="章节分析结果不能为空（analysis），请先完成章节分析")

    analysis_json = json.dumps(body.analysis, ensure_ascii=False, indent=2)

    db = SessionLocal()
    try:
        chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
        project_id = chapter.project_id
        project = db.get(Project, project_id)
        if project is None:
            raise AppError.not_found()

        resolved_rewrite = _resolve_task_llm_for_call(
            db=db,
            project=project,
            user_id=user_id,
            task_key="chapter_rewrite",
            x_llm_provider=x_llm_provider,
            x_llm_api_key=x_llm_api_key,
        )
        resolved_api_key = str(resolved_rewrite.api_key)

        ensure_default_chapter_rewrite_preset(db, project_id=project_id, activate=True)
        draft_content_md = body.draft_content_md if body.draft_content_md is not None else (chapter.content_md or "")
        if not draft_content_md.strip():
            raise AppError.validation(message="当前章节正文为空，无法重写")

        values = build_chapter_rewrite_render_values(
            db,
            project=project,
            chapter=chapter,
            body=body,
            analysis_json=analysis_json,
            draft_content_md=draft_content_md,
        )

        prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
            db,
            project_id=project_id,
            task="chapter_rewrite",
            values=values,  # type: ignore[arg-type]
            macro_seed=f"{request_id}:rewrite",
            provider=resolved_rewrite.llm_call.provider,
        )
        prompt_render_log_json = json.dumps(render_log, ensure_ascii=False)
        llm_call = resolved_rewrite.llm_call
    finally:
        db.close()

    if llm_call is None:
        raise AppError(code="INTERNAL_ERROR", message="LLM 调用准备失败", status_code=500)
    if not prompt_system.strip() and not prompt_user.strip():
        raise AppError(code="PROMPT_CONFIG_ERROR", message="缺少 chapter_rewrite 提示词预设/提示块", status_code=400)

    llm_call = with_param_overrides(llm_call, {"temperature": 0.35, "max_tokens": 8192})
    llm_result = call_llm_and_record(
        logger=logger,
        request_id=request_id,
        actor_user_id=user_id,
        project_id=project_id,
        chapter_id=chapter_id,
        run_type="chapter_rewrite",
        api_key=str(resolved_api_key),
        prompt_system=prompt_system,
        prompt_user=prompt_user,
        prompt_messages=prompt_messages,
        prompt_render_log_json=prompt_render_log_json,
        llm_call=llm_call,
    )

    contract = contract_for_task("chapter_rewrite")
    parsed = contract.parse(llm_result.text, finish_reason=llm_result.finish_reason)
    data, warnings, parse_error = parsed.data, parsed.warnings, parsed.parse_error
    data["generation_run_id"] = llm_result.run_id
    data["latency_ms"] = llm_result.latency_ms
    if llm_result.dropped_params:
        data["dropped_params"] = llm_result.dropped_params
    if warnings:
        data["warnings"] = warnings
    if parse_error is not None:
        data["parse_error"] = parse_error
    if llm_result.finish_reason is not None:
        data["finish_reason"] = llm_result.finish_reason
    return ok_payload(request_id=request_id, data=data)


@router.post("/chapters/{chapter_id}/analysis/apply")
def apply_chapter_analysis_route(
    request: Request,
    db: DbDep,
    chapter_id: str,
    body: ChapterAnalysisApplyRequest,
    user_id: UserIdDep,
) -> dict:
    request_id = request.state.request_id
    chapter = require_chapter_editor(db, chapter_id=chapter_id, user_id=user_id)
    content_md = body.draft_content_md if body.draft_content_md is not None else (chapter.content_md or "")

    out = apply_plot_analysis(
        db=db,
        request_id=request_id,
        actor_user_id=user_id,
        project_id=chapter.project_id,
        chapter_id=chapter_id,
        chapter_number=int(chapter.number),
        analysis=body.analysis,
        draft_content_md=content_md,
    )
    return ok_payload(request_id=request_id, data=out)


@router.get("/chapters/{chapter_id}/annotations")
def get_chapter_annotations(
    request: Request,
    db: DbDep,
    chapter_id: str,
    user_id: UserIdDep,
) -> dict:
    request_id = request.state.request_id
    chapter = require_chapter_viewer(db, chapter_id=chapter_id, user_id=user_id)

    memories = (
        db.execute(
            select(StoryMemory)
            .where(StoryMemory.project_id == chapter.project_id, StoryMemory.chapter_id == chapter_id)
            .order_by(StoryMemory.importance_score.desc(), StoryMemory.created_at.asc())
        )
        .scalars()
        .all()
    )

    annotations, stats = build_annotations_from_story_memories(memories, content_md=chapter.content_md or "")
    if stats.get("need_fallback") or stats.get("clamped"):
        log_event(
            logger,
            "info",
            annotations={
                "chapter_id": chapter_id,
                "need_fallback": stats.get("need_fallback", 0),
                "attempted": stats.get("attempted", 0),
                "found": stats.get("found", 0),
                "clamped": stats.get("clamped", 0),
            },
        )

    return ok_payload(request_id=request_id, data={"annotations": annotations})
