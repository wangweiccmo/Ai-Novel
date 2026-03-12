from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from app.services.chapter_context_service import build_post_edit_render_values
from app.services.generation_service import PreparedLlmCall, call_llm_and_record, with_param_overrides
from app.models.project import Project
from app.services.mcp.service import McpResearchConfig, McpToolCallResult, run_mcp_research_and_record
from app.services.post_edit_validation import validate_content_optimize_output, validate_post_edit_output
from app.services.output_contracts import contract_for_task
from app.services.llm_task_preset_resolver import resolve_task_llm_config
from app.services.prompt_presets import ensure_default_content_optimize_preset, ensure_default_post_edit_preset, render_preset_for_task
from app.db.session import SessionLocal

logger = logging.getLogger("ainovel")


@dataclass(frozen=True, slots=True)
class PostEditStepResult:
    applied: bool
    run_id: str
    edited_content_md: str
    warnings: list[str]
    parse_error: dict[str, object] | None


@dataclass(frozen=True, slots=True)
class ContentOptimizeStepResult:
    applied: bool
    run_id: str
    optimized_content_md: str
    warnings: list[str]
    parse_error: dict[str, object] | None


@dataclass(frozen=True, slots=True)
class PlanStepResult:
    plan_out: dict[str, object]
    warnings: list[str]
    parse_error: dict[str, object] | None
    finish_reason: str | None


@dataclass(frozen=True, slots=True)
class ChapterGenerateStepResult:
    data: dict[str, object]
    warnings: list[str]
    parse_error: dict[str, object] | None
    finish_reason: str | None
    dropped_params: list[str]
    latency_ms: int
    run_id: str


@dataclass(frozen=True, slots=True)
class McpResearchStepResult:
    applied: bool
    context_md: str
    tool_runs: list[McpToolCallResult]
    warnings: list[str]


def run_mcp_research_step(
    *,
    logger: logging.Logger,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    chapter_id: str | None,
    config: McpResearchConfig,
) -> McpResearchStepResult:
    if not config.enabled:
        return McpResearchStepResult(applied=False, context_md="", tool_runs=[], warnings=[])

    try:
        context, results, warnings = run_mcp_research_and_record(
            request_id=request_id,
            actor_user_id=actor_user_id,
            project_id=project_id,
            chapter_id=chapter_id,
            config=config,
        )
        return McpResearchStepResult(
            applied=bool(context.strip()),
            context_md=context,
            tool_runs=results,
            warnings=warnings,
        )
    except Exception:
        logger.exception("mcp_research_step_failed")
        return McpResearchStepResult(
            applied=False,
            context_md="",
            tool_runs=[],
            warnings=["mcp_research_failed"],
        )


def run_post_edit_step(
    *,
    logger: logging.Logger,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    chapter_id: str | None,
    api_key: str,
    llm_call: PreparedLlmCall,
    render_values: dict[str, object],
    raw_content: str,
    macro_seed: str,
    post_edit_sanitize: bool = False,
    run_params_extra_json: dict[str, object] | None = None,
) -> PostEditStepResult:
    effective_llm_call = llm_call
    effective_api_key = str(api_key)
    with SessionLocal() as db:
        project = db.get(Project, project_id)
        if project is not None:
            try:
                resolved = resolve_task_llm_config(
                    db,
                    project=project,
                    user_id=actor_user_id,
                    task_key="post_edit",
                    header_api_key=None,
                )
            except Exception:
                resolved = None
            if resolved is not None:
                effective_llm_call = resolved.llm_call
                effective_api_key = str(resolved.api_key)

        ensure_default_post_edit_preset(db, project_id=project_id)
        post_values = build_post_edit_render_values(render_values, raw_content=raw_content)
        post_values["post_edit_sanitize"] = bool(post_edit_sanitize)

        # Inject custom AI trace words from project settings
        if post_edit_sanitize:
            from app.services.memory_retrieval_service import _get_project_settings_cached
            _ps = _get_project_settings_cached(db, project_id)
            _custom_words_raw = getattr(_ps, "custom_ai_trace_words_json", None) if _ps else None
            if _custom_words_raw:
                try:
                    import json as _json
                    _words = _json.loads(_custom_words_raw)
                    if isinstance(_words, list) and _words:
                        post_values["custom_ai_trace_words"] = [str(w).strip() for w in _words if str(w).strip()]
                except Exception:
                    pass

        post_system, post_user, post_messages, _, _, _, post_render_log = render_preset_for_task(
            db,
            project_id=project_id,
            task="post_edit",
            values=post_values,  # type: ignore[arg-type]
            macro_seed=macro_seed,
            provider=effective_llm_call.provider,
        )
    post_render_log_json = json.dumps(post_render_log, ensure_ascii=False)

    post_call = with_param_overrides(effective_llm_call, {"temperature": 0.4})
    post_result = call_llm_and_record(
        logger=logger,
        request_id=request_id,
        actor_user_id=actor_user_id,
        project_id=project_id,
        chapter_id=chapter_id,
        run_type="post_edit_sanitize" if post_edit_sanitize else "post_edit",
        api_key=effective_api_key,
        prompt_system=post_system,
        prompt_user=post_user,
        prompt_messages=post_messages,
        prompt_render_log_json=post_render_log_json,
        llm_call=post_call,
        run_params_extra_json=run_params_extra_json,
    )

    post_contract = contract_for_task("post_edit")
    post_parsed = post_contract.parse(post_result.text, finish_reason=post_result.finish_reason)
    warnings = list(post_parsed.warnings)
    parse_error = post_parsed.parse_error
    edited = str(post_parsed.data.get("content_md") or "").strip()
    applied = parse_error is None and bool(edited)
    if applied:
        extra_warnings = validate_post_edit_output(raw_content=raw_content, edited_content=edited)
        if extra_warnings:
            warnings.extend(extra_warnings)
            applied = False
    if not applied:
        warnings.append("post_edit_failed")

    return PostEditStepResult(
        applied=applied,
        run_id=post_result.run_id,
        edited_content_md=edited,
        warnings=warnings,
        parse_error=parse_error,
    )


def run_content_optimize_step(
    *,
    logger: logging.Logger,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    chapter_id: str | None,
    api_key: str,
    llm_call: PreparedLlmCall,
    render_values: dict[str, object],
    raw_content: str,
    macro_seed: str,
    run_params_extra_json: dict[str, object] | None = None,
) -> ContentOptimizeStepResult:
    effective_llm_call = llm_call
    effective_api_key = str(api_key)
    with SessionLocal() as db:
        project = db.get(Project, project_id)
        if project is not None:
            try:
                resolved = resolve_task_llm_config(
                    db,
                    project=project,
                    user_id=actor_user_id,
                    task_key="content_optimize",
                    header_api_key=None,
                )
            except Exception:
                resolved = None
            if resolved is not None:
                effective_llm_call = resolved.llm_call
                effective_api_key = str(resolved.api_key)

        ensure_default_content_optimize_preset(db, project_id=project_id)
        values = build_post_edit_render_values(render_values, raw_content=raw_content)

        opt_system, opt_user, opt_messages, _, _, _, opt_render_log = render_preset_for_task(
            db,
            project_id=project_id,
            task="content_optimize",
            values=values,  # type: ignore[arg-type]
            macro_seed=macro_seed,
            provider=effective_llm_call.provider,
        )
    opt_render_log_json = json.dumps(opt_render_log, ensure_ascii=False)

    opt_call = with_param_overrides(effective_llm_call, {"temperature": 0.35})
    opt_result = call_llm_and_record(
        logger=logger,
        request_id=request_id,
        actor_user_id=actor_user_id,
        project_id=project_id,
        chapter_id=chapter_id,
        run_type="content_optimize",
        api_key=effective_api_key,
        prompt_system=opt_system,
        prompt_user=opt_user,
        prompt_messages=opt_messages,
        prompt_render_log_json=opt_render_log_json,
        llm_call=opt_call,
        run_params_extra_json=run_params_extra_json,
    )

    opt_contract = contract_for_task("content_optimize")
    opt_parsed = opt_contract.parse(opt_result.text, finish_reason=opt_result.finish_reason)
    warnings = list(opt_parsed.warnings)
    parse_error = opt_parsed.parse_error
    optimized = str(opt_parsed.data.get("content_md") or "").strip()
    applied = parse_error is None and bool(optimized)
    if applied:
        extra_warnings = validate_content_optimize_output(raw_content=raw_content, optimized_content=optimized)
        if extra_warnings:
            warnings.extend(extra_warnings)
            applied = False
    if not applied:
        warnings.append("content_optimize_failed")

    return ContentOptimizeStepResult(
        applied=applied,
        run_id=opt_result.run_id,
        optimized_content_md=optimized,
        warnings=warnings,
        parse_error=parse_error,
    )


def run_plan_llm_step(
    *,
    logger: logging.Logger,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    chapter_id: str | None,
    api_key: str,
    llm_call: PreparedLlmCall,
    prompt_system: str,
    prompt_user: str,
    prompt_messages: list,
    prompt_render_log_json: str | None,
    run_params_extra_json: dict[str, object] | None = None,
) -> PlanStepResult:
    plan_call = with_param_overrides(llm_call, {"temperature": 0.2, "max_tokens": 1024})
    plan_result = call_llm_and_record(
        logger=logger,
        request_id=request_id,
        actor_user_id=actor_user_id,
        project_id=project_id,
        chapter_id=chapter_id,
        run_type="plan_chapter",
        api_key=api_key,
        prompt_system=prompt_system,
        prompt_user=prompt_user,
        prompt_messages=prompt_messages,
        prompt_render_log_json=prompt_render_log_json,
        llm_call=plan_call,
        run_params_extra_json=run_params_extra_json,
    )

    plan_contract = contract_for_task("plan_chapter")
    parsed = plan_contract.parse(plan_result.text, finish_reason=plan_result.finish_reason)
    return PlanStepResult(
        plan_out=parsed.data,
        warnings=list(parsed.warnings),
        parse_error=parsed.parse_error,
        finish_reason=plan_result.finish_reason,
    )


def run_chapter_generate_llm_step(
    *,
    logger: logging.Logger,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    chapter_id: str | None,
    run_type: str,
    api_key: str,
    llm_call: PreparedLlmCall,
    prompt_system: str,
    prompt_user: str,
    prompt_messages: list,
    prompt_render_log_json: str | None,
    run_params_extra_json: dict[str, object] | None = None,
) -> ChapterGenerateStepResult:
    llm_result = call_llm_and_record(
        logger=logger,
        request_id=request_id,
        actor_user_id=actor_user_id,
        project_id=project_id,
        chapter_id=chapter_id,
        run_type=run_type,
        api_key=api_key,
        prompt_system=prompt_system,
        prompt_user=prompt_user,
        prompt_messages=prompt_messages,
        prompt_render_log_json=prompt_render_log_json,
        llm_call=llm_call,
        run_params_extra_json=run_params_extra_json,
    )

    chapter_contract = contract_for_task("chapter_generate")
    parsed = chapter_contract.parse(llm_result.text, finish_reason=llm_result.finish_reason)
    return ChapterGenerateStepResult(
        data=parsed.data,
        warnings=list(parsed.warnings),
        parse_error=parsed.parse_error,
        finish_reason=llm_result.finish_reason,
        dropped_params=list(llm_result.dropped_params),
        latency_ms=int(llm_result.latency_ms),
        run_id=llm_result.run_id,
    )


# ── Pipeline memory optimization ─────────────────────────────────────

# Keys in render_values that can be safely cleared between pipeline steps
# to reduce memory pressure.
_CLEARABLE_RENDER_KEYS = {
    "raw_chapter_text",
    "raw_memory_pack_json",
    "mcp_research_context_md",
    "debug_render_log",
}


def cleanup_render_values(render_values: dict[str, object], *, after_step: str) -> list[str]:
    """Remove large intermediate data from render_values after a step completes.

    Returns a list of keys that were cleared.
    """
    cleared: list[str] = []
    for key in _CLEARABLE_RENDER_KEYS:
        if key in render_values:
            val = render_values[key]
            if isinstance(val, str) and len(val) > 2000:
                render_values[key] = ""
                cleared.append(key)
            elif isinstance(val, dict) and len(str(val)) > 5000:
                render_values[key] = {}
                cleared.append(key)
    if cleared:
        logger.debug("pipeline_memory_cleanup after_step=%s cleared=%s", after_step, cleared)
    return cleared


# ── Pipeline fallback / graceful degradation ──────────────────────────

@dataclass
class PipelineFallbackResult:
    """Result of a pipeline step with fallback information."""
    content_md: str
    applied_steps: list[str]
    skipped_steps: list[str]
    warnings: list[str]


def run_post_pipeline_with_fallback(
    *,
    log: logging.Logger,
    raw_content: str,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    chapter_id: str | None,
    api_key: str,
    llm_call: PreparedLlmCall,
    render_values: dict[str, object],
    macro_seed: str,
    enable_content_optimize: bool = True,
    enable_post_edit: bool = True,
    post_edit_sanitize: bool = False,
    run_params_extra_json: dict[str, object] | None = None,
) -> PipelineFallbackResult:
    """Run content_optimize → post_edit with graceful degradation.

    If content_optimize fails, uses raw_content for post_edit.
    If post_edit fails, returns the best available content.
    Each step's failure doesn't block the others.
    """
    current_content = raw_content
    applied: list[str] = []
    skipped: list[str] = []
    all_warnings: list[str] = []

    # Step 1: Content optimize
    if enable_content_optimize:
        try:
            opt_result = run_content_optimize_step(
                logger=log,
                request_id=request_id,
                actor_user_id=actor_user_id,
                project_id=project_id,
                chapter_id=chapter_id,
                api_key=api_key,
                llm_call=llm_call,
                render_values=render_values,
                raw_content=current_content,
                macro_seed=macro_seed,
                run_params_extra_json=run_params_extra_json,
            )
            all_warnings.extend(opt_result.warnings)
            if opt_result.applied:
                current_content = opt_result.optimized_content_md
                applied.append("content_optimize")
            else:
                skipped.append("content_optimize")
                all_warnings.append("fallback:content_optimize_skipped")
        except Exception:
            log.warning("content_optimize_step_exception, falling back", exc_info=True)
            skipped.append("content_optimize")
            all_warnings.append("fallback:content_optimize_exception")

        # Memory cleanup after optimize step
        cleanup_render_values(render_values, after_step="content_optimize")

    # Step 2: Post edit
    if enable_post_edit:
        try:
            edit_result = run_post_edit_step(
                logger=log,
                request_id=request_id,
                actor_user_id=actor_user_id,
                project_id=project_id,
                chapter_id=chapter_id,
                api_key=api_key,
                llm_call=llm_call,
                render_values=render_values,
                raw_content=current_content,
                macro_seed=macro_seed,
                post_edit_sanitize=post_edit_sanitize,
                run_params_extra_json=run_params_extra_json,
            )
            all_warnings.extend(edit_result.warnings)
            if edit_result.applied:
                current_content = edit_result.edited_content_md
                applied.append("post_edit")
            else:
                skipped.append("post_edit")
                all_warnings.append("fallback:post_edit_skipped")
        except Exception:
            log.warning("post_edit_step_exception, falling back", exc_info=True)
            skipped.append("post_edit")
            all_warnings.append("fallback:post_edit_exception")

        # Memory cleanup after post-edit step
        cleanup_render_values(render_values, after_step="post_edit")

    return PipelineFallbackResult(
        content_md=current_content,
        applied_steps=applied,
        skipped_steps=skipped,
        warnings=all_warnings,
    )
