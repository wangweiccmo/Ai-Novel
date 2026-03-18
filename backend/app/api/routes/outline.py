from __future__ import annotations

import concurrent.futures
import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from collections.abc import Callable
import anyio

from fastapi import APIRouter, Header, Request
from sqlalchemy import select

from app.api.deps import DbDep, UserIdDep, require_project_editor, require_project_viewer
from app.core.errors import AppError, ok_payload
from app.core.logging import log_event
from app.db.session import SessionLocal
from app.llm.capabilities import max_output_tokens_limit
from app.llm.client import call_llm_stream_messages
from app.llm.messages import ChatMessage
from app.models.character import Character
from app.models.project_settings import ProjectSettings
from app.schemas.outline_generate import OutlineGenerateRequest
from app.services.generation_service import (
    PreparedLlmCall,
    build_run_params_json,
    call_llm_and_record,
    with_param_overrides,
)
from app.services.llm_task_preset_resolver import resolve_task_llm_config
from app.services.outline_store import ensure_active_outline
from app.services.output_contracts import build_repair_prompt_for_task, contract_for_task
from app.services.output_parsers import extract_json_value, likely_truncated_json
from app.services.prompt_presets import render_preset_for_task
from app.services.prompt_store import format_characters
from app.services.run_store import write_generation_run
from app.services.search_index_service import schedule_search_rebuild_task
from app.services.style_resolution_service import resolve_style_guide
from app.services.vector_rag_service import schedule_vector_rebuild_task
from app.utils.sse_response import (
    create_sse_response,
    sse_chunk,
    sse_done,
    sse_error,
    sse_heartbeat,
    sse_progress,
    sse_result,
)
from app.models.outline import Outline
from app.schemas.outline import OutlineOut, OutlineUpdate
from app.services.outline_payload_normalizer import normalize_outline_content_and_structure, parse_outline_structure_json

router = APIRouter()
logger = logging.getLogger("ainovel")
OUTLINE_FILL_MIN_BATCH_SIZE = 6
OUTLINE_FILL_MAX_BATCH_SIZE = 18
OUTLINE_FILL_STAGNANT_ROUNDS_LIMIT = 3
OUTLINE_FILL_MAX_TOTAL_ATTEMPTS = 48
OUTLINE_FILL_HEARTBEAT_INTERVAL_SECONDS = 1.0
OUTLINE_FILL_POLL_INTERVAL_SECONDS = 0.2
OUTLINE_GAP_REPAIR_MAX_MISSING = 120
OUTLINE_GAP_REPAIR_BATCH_SIZE = 4
OUTLINE_GAP_REPAIR_STAGNANT_LIMIT = 4
OUTLINE_GAP_REPAIR_FINAL_SWEEP_MAX_MISSING = 36
OUTLINE_GAP_REPAIR_FINAL_SWEEP_ATTEMPTS_PER_CHAPTER = 3
OUTLINE_SEGMENT_TRIGGER_CHAPTER_COUNT = 80
OUTLINE_SEGMENT_MIN_BATCH_SIZE = 6
OUTLINE_SEGMENT_MAX_BATCH_SIZE = 12
OUTLINE_SEGMENT_DEFAULT_BATCH_SIZE = 10
OUTLINE_SEGMENT_MAX_ATTEMPTS_PER_BATCH = 6
OUTLINE_SEGMENT_STAGNANT_ATTEMPTS_LIMIT = 3
OUTLINE_SEGMENT_RECENT_CONTEXT_WINDOW = 24
OUTLINE_SEGMENT_INDEX_MAX_ITEMS = 140
OUTLINE_SEGMENT_INDEX_MAX_CHARS = 6000
OUTLINE_SEGMENT_RECENT_WINDOW_MAX_CHARS = 2800
OUTLINE_STREAM_RAW_PREVIEW_MAX_CHARS = 1800
CANCEL_ERROR_CODE = "REQUEST_ABORTED"

OutlineFillProgressHook = Callable[[dict[str, object]], None]
OutlineSegmentProgressHook = Callable[[dict[str, object]], None]


def _raise_request_canceled() -> None:
    raise AppError(code=CANCEL_ERROR_CODE, message="请求已取消", status_code=499)


def _raise_if_canceled(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        _raise_request_canceled()


def _is_request_disconnected(request: Request) -> bool:
    try:
        return bool(anyio.from_thread.run(request.is_disconnected))
    except Exception:
        return False


def _start_disconnect_watcher(request: Request, cancel_event: threading.Event) -> threading.Thread:
    def _watch() -> None:
        while not cancel_event.is_set():
            if _is_request_disconnected(request):
                cancel_event.set()
                break
            time.sleep(0.2)

    watcher = threading.Thread(target=_watch, name="outline-cancel-watch", daemon=True)
    watcher.start()
    return watcher


def _outline_out(row: Outline) -> dict[str, object]:
    parsed_structure = parse_outline_structure_json(row.structure_json)
    content_md, structure, _ = normalize_outline_content_and_structure(content_md=row.content_md or "", structure=parsed_structure)
    return OutlineOut(
        id=row.id,
        project_id=row.project_id,
        title=row.title,
        content_md=content_md,
        structure=structure,
        created_at=row.created_at,
        updated_at=row.updated_at,
    ).model_dump()


@dataclass(frozen=True, slots=True)
class _PreparedOutlineGeneration:
    resolved_api_key: str
    prompt_system: str
    prompt_user: str
    prompt_messages: list[ChatMessage]
    prompt_render_log_json: str
    llm_call: PreparedLlmCall
    target_chapter_count: int | None
    run_params_extra_json: dict[str, object]


@dataclass(frozen=True, slots=True)
class _OutlineSegmentGenerationResult:
    data: dict[str, object]
    warnings: list[str]
    parse_error: dict[str, object] | None
    run_ids: list[str]
    latency_ms: int
    dropped_params: list[str]
    finish_reasons: list[str]
    meta: dict[str, object]


def _prepare_outline_generation(
    *,
    db: DbDep,
    project_id: str,
    body: OutlineGenerateRequest,
    user_id: str,
    request_id: str,
    x_llm_provider: str | None,
    x_llm_api_key: str | None,
) -> _PreparedOutlineGeneration:
    project = require_project_editor(db, project_id=project_id, user_id=user_id)
    resolved_outline = resolve_task_llm_config(
        db,
        project=project,
        user_id=user_id,
        task_key="outline_generate",
        header_api_key=x_llm_api_key,
    )
    if resolved_outline is None:
        raise AppError(code="LLM_CONFIG_ERROR", message="请先在 Prompts 页保存 LLM 配置", status_code=400)
    if x_llm_api_key and x_llm_provider and resolved_outline.llm_call.provider != x_llm_provider:
        raise AppError(code="LLM_CONFIG_ERROR", message="当前任务 provider 与请求头不一致，请先保存/切换", status_code=400)
    resolved_api_key = str(resolved_outline.api_key)

    settings_row = db.get(ProjectSettings, project_id)
    world_setting = (settings_row.world_setting if settings_row else "") or ""
    settings_style_guide = (settings_row.style_guide if settings_row else "") or ""
    constraints = (settings_row.constraints if settings_row else "") or ""

    style_resolution: dict[str, object] = {"style_id": None, "source": "disabled"}
    if not body.context.include_world_setting:
        world_setting = ""
        settings_style_guide = ""
        constraints = ""
    else:
        resolved_style_guide, style_resolution = resolve_style_guide(
            db,
            project_id=project_id,
            user_id=user_id,
            requested_style_id=body.style_id,
            include_style_guide=True,
            settings_style_guide=settings_style_guide,
        )
        settings_style_guide = resolved_style_guide

    run_params_extra_json: dict[str, object] = {"style_resolution": style_resolution}

    chars: list[Character] = []
    if body.context.include_characters:
        chars = db.execute(select(Character).where(Character.project_id == project_id)).scalars().all()
    characters_text = format_characters(chars)
    target_chapter_count = _extract_target_chapter_count(body.requirements)
    guidance = _build_outline_generation_guidance(target_chapter_count)

    requirements_text = json.dumps(body.requirements or {}, ensure_ascii=False, indent=2)
    values = {
        "project_name": project.name or "",
        "genre": project.genre or "",
        "logline": project.logline or "",
        "world_setting": world_setting,
        "style_guide": settings_style_guide,
        "constraints": constraints,
        "characters": characters_text,
        "outline": "",
        "chapter_number": "",
        "chapter_title": "",
        "chapter_plan": "",
        "requirements": requirements_text,
        "instruction": "",
        "previous_chapter": "",
        "target_chapter_count": target_chapter_count or "",
        "chapter_count_rule": guidance.get("chapter_count_rule", ""),
        "chapter_detail_rule": guidance.get("chapter_detail_rule", ""),
    }

    prompt_system, prompt_user, prompt_messages, _, _, _, render_log = render_preset_for_task(
        db,
        project_id=project_id,
        task="outline_generate",
        values=values,
        macro_seed=request_id,
        provider=resolved_outline.llm_call.provider,
    )
    prompt_render_log_json = json.dumps(render_log, ensure_ascii=False)

    llm_call = resolved_outline.llm_call
    current_max_tokens = llm_call.params.get("max_tokens")
    current_max_tokens_int = int(current_max_tokens) if isinstance(current_max_tokens, int) else None
    wanted_max_tokens = _recommend_outline_max_tokens(
        target_chapter_count=target_chapter_count,
        provider=llm_call.provider,
        model=llm_call.model,
        current_max_tokens=current_max_tokens_int,
    )
    if isinstance(wanted_max_tokens, int) and wanted_max_tokens > 0:
        llm_call = with_param_overrides(llm_call, {"max_tokens": wanted_max_tokens})
        run_params_extra_json["outline_auto_max_tokens"] = {
            "target_chapter_count": target_chapter_count,
            "from": current_max_tokens_int,
            "to": wanted_max_tokens,
        }

    return _PreparedOutlineGeneration(
        resolved_api_key=resolved_api_key,
        prompt_system=prompt_system,
        prompt_user=prompt_user,
        prompt_messages=prompt_messages,
        prompt_render_log_json=prompt_render_log_json,
        llm_call=llm_call,
        target_chapter_count=target_chapter_count,
        run_params_extra_json=run_params_extra_json,
    )


def _mark_vector_index_dirty(db: DbDep, *, project_id: str) -> None:
    row = db.get(ProjectSettings, project_id)
    if row is None:
        row = ProjectSettings(project_id=project_id)
        db.add(row)
        db.flush()
    row.vector_index_dirty = True


def _extract_target_chapter_count(requirements: dict[str, object] | None) -> int | None:
    if not isinstance(requirements, dict):
        return None
    raw = requirements.get("chapter_count")
    if raw is None or isinstance(raw, bool):
        return None
    try:
        if isinstance(raw, str):
            text = raw.strip()
            if not text:
                return None
            value = int(text)
        else:
            value = int(raw)
    except Exception:
        return None
    if value <= 0:
        return None
    # Keep a sanity cap for prompt safety.
    return min(value, 2000)


def _build_outline_generation_guidance(target_chapter_count: int | None) -> dict[str, str]:
    if not target_chapter_count:
        return {
            "chapter_count_rule": "",
            "chapter_detail_rule": "beats 每章 5~9 条，按发生顺序；每条用短句，明确“发生了什么/造成什么后果”。",
        }
    if target_chapter_count <= 20:
        detail = "beats 每章 5~9 条，按发生顺序；每条用短句，明确“发生了什么/造成什么后果”。"
    elif target_chapter_count <= 40:
        detail = "beats 每章 2~4 条，保持因果推进；每条保持短句，避免冗长。"
    elif target_chapter_count <= 80:
        detail = "beats 每章 1~2 条，仅保留关键推进；优先保证章号覆盖完整。"
    elif target_chapter_count <= 120:
        detail = "beats 每章 1~2 条，只保留主冲突与关键转折，保证节奏连续。"
    else:
        detail = "beats 每章 1 条，极简表达关键推进；若长度受限，优先保留章节覆盖与编号完整。"
    return {
        "chapter_count_rule": (
            f"chapters 必须输出 {target_chapter_count} 章，number 需完整覆盖 1..{target_chapter_count} 且不缺号。"
        ),
        "chapter_detail_rule": detail,
    }


def _chapter_beats_count(chapter: dict[str, object]) -> int:
    beats_raw = chapter.get("beats")
    if not isinstance(beats_raw, list):
        return 0
    count = 0
    for beat in beats_raw:
        if isinstance(beat, str) and beat.strip():
            count += 1
    return count


def _outline_fill_detail_rule(*, target_chapter_count: int, existing_chapters: list[dict[str, object]]) -> str:
    base_rule = _build_outline_generation_guidance(target_chapter_count).get("chapter_detail_rule") or (
        "beats 每章 1~2 条，保持关键推进。"
    )

    beat_counts: list[int] = []
    for chapter in existing_chapters:
        count = _chapter_beats_count(chapter)
        if count > 0:
            beat_counts.append(count)
    beat_counts.sort()
    if not beat_counts:
        return base_rule

    median = beat_counts[len(beat_counts) // 2]
    low = max(1, median - 1)
    high = max(low, median + 1)

    if target_chapter_count > 120:
        low, high = min(low, 2), min(high, 2)
    elif target_chapter_count > 80:
        low, high = min(low, 2), min(high, 3)
    elif target_chapter_count > 40:
        low, high = min(low, 2), min(high, 4)
    else:
        low, high = min(low, 4), min(high, 6)

    consistency = (
        f"补全章节的 beats 粒度需尽量贴近已有章节（当前已生成章节 beats 中位数约 {median} 条）；"
        f"本轮建议每章 {low}~{high} 条。"
    )
    return f"{base_rule} {consistency}"


def _outline_fill_style_samples(existing_chapters: list[dict[str, object]]) -> str:
    if not existing_chapters:
        return "[]"

    total = len(existing_chapters)
    sample_indexes = sorted({0, min(1, total - 1), total // 2, total - 1})
    samples: list[dict[str, object]] = []
    for idx in sample_indexes:
        if idx < 0 or idx >= total:
            continue
        chapter = existing_chapters[idx]
        number = int(chapter.get("number") or 0)
        if number <= 0:
            continue
        title = str(chapter.get("title") or "")[:24]
        beats_raw = chapter.get("beats")
        beats: list[str] = []
        if isinstance(beats_raw, list):
            for beat in beats_raw:
                text = str(beat).strip()
                if text:
                    beats.append(text[:42])
                if len(beats) >= 3:
                    break
        samples.append({"number": number, "title": title, "beats": beats})
        if len(samples) >= 4:
            break
    return json.dumps(samples, ensure_ascii=False)


def _recommend_outline_max_tokens(
    *,
    target_chapter_count: int | None,
    provider: str,
    model: str | None,
    current_max_tokens: int | None,
) -> int | None:
    if not target_chapter_count or target_chapter_count <= 20:
        return None
    if target_chapter_count <= 40:
        wanted = 8192
    else:
        wanted = 12000

    limit = max_output_tokens_limit(provider, model)
    if isinstance(limit, int) and limit > 0:
        wanted = min(wanted, int(limit))

    if isinstance(current_max_tokens, int) and current_max_tokens >= wanted:
        return None
    return wanted if wanted > 0 else None


def _should_use_outline_segmented_mode(target_chapter_count: int | None) -> bool:
    return bool(target_chapter_count and target_chapter_count >= OUTLINE_SEGMENT_TRIGGER_CHAPTER_COUNT)


def _outline_segment_batch_size_for_target(target_chapter_count: int) -> int:
    if target_chapter_count <= 120:
        return OUTLINE_SEGMENT_MAX_BATCH_SIZE
    if target_chapter_count <= 500:
        return OUTLINE_SEGMENT_DEFAULT_BATCH_SIZE
    return max(OUTLINE_SEGMENT_MIN_BATCH_SIZE, OUTLINE_SEGMENT_DEFAULT_BATCH_SIZE - 2)


def _outline_segment_max_attempts_for_batch(requested_count: int) -> int:
    if requested_count <= 0:
        return 1
    estimated = max(3, ((requested_count + 2) // 3) + 1)
    return min(OUTLINE_SEGMENT_MAX_ATTEMPTS_PER_BATCH, estimated)


def _outline_segment_batches(target_chapter_count: int, batch_size: int) -> list[list[int]]:
    size = max(OUTLINE_SEGMENT_MIN_BATCH_SIZE, min(OUTLINE_SEGMENT_MAX_BATCH_SIZE, int(batch_size)))
    out: list[list[int]] = []
    start = 1
    while start <= target_chapter_count:
        end = min(target_chapter_count, start + size - 1)
        out.append(list(range(start, end + 1)))
        start = end + 1
    return out


def _shrink_outline_segment_items(
    items: list[dict[str, object]],
    *,
    max_items: int,
    max_chars: int,
) -> list[dict[str, object]]:
    if not items:
        return []
    sampled = list(items)
    if len(sampled) > max_items:
        head = max(20, max_items // 2)
        tail = max_items - head
        sampled = [*sampled[:head], *sampled[-tail:]]

    payload = json.dumps({"items": sampled}, ensure_ascii=False)
    if len(payload) <= max_chars:
        return sampled

    compact = list(sampled)
    while len(compact) > 32:
        compact = [*compact[: len(compact) // 2], *compact[-max(1, len(compact) // 4) :]]
        payload = json.dumps({"items": compact}, ensure_ascii=False)
        if len(payload) <= max_chars:
            return compact
    return compact


def _strip_segment_conflicting_prompt_sections(text: str) -> str:
    if not text.strip():
        return text
    # Segmented mode should not retain "single response must cover all chapters" instructions.
    without_target = re.sub(r"(?is)<\s*CHAPTER_TARGET\s*>[\s\S]*?<\s*/\s*CHAPTER_TARGET\s*>", "", text)
    return without_target.strip()


def _build_outline_segment_chapter_index(chapters: list[dict[str, object]]) -> str:
    items: list[dict[str, object]] = []
    for chapter in chapters:
        try:
            number = int(chapter.get("number"))
        except Exception:
            continue
        if number <= 0:
            continue
        title = str(chapter.get("title") or "").strip()
        items.append({"number": number, "title": title[:28]})
    items.sort(key=lambda row: int(row.get("number") or 0))
    total = len(items)
    sampled = _shrink_outline_segment_items(
        items,
        max_items=OUTLINE_SEGMENT_INDEX_MAX_ITEMS,
        max_chars=OUTLINE_SEGMENT_INDEX_MAX_CHARS,
    )
    payload: dict[str, object] = {"total": total, "items": sampled}
    omitted = total - len(sampled)
    if omitted > 0:
        payload["omitted"] = omitted
    return json.dumps(payload, ensure_ascii=False)


def _build_outline_segment_recent_window(chapters: list[dict[str, object]]) -> str:
    if not chapters:
        return "[]"
    window = chapters[-OUTLINE_SEGMENT_RECENT_CONTEXT_WINDOW:]
    items: list[dict[str, object]] = []
    for chapter in window:
        try:
            number = int(chapter.get("number"))
        except Exception:
            continue
        if number <= 0:
            continue
        title = str(chapter.get("title") or "").strip()
        beats_raw = chapter.get("beats")
        beats: list[str] = []
        if isinstance(beats_raw, list):
            for beat in beats_raw:
                text = str(beat).strip()
                if text:
                    beats.append(text[:64])
                if len(beats) >= 3:
                    break
        items.append({"number": number, "title": title[:28], "beats": beats})
    text = json.dumps(items, ensure_ascii=False)
    if len(text) <= OUTLINE_SEGMENT_RECENT_WINDOW_MAX_CHARS:
        return text
    compact: list[dict[str, object]] = []
    for row in items:
        compact.append(
            {
                "number": int(row.get("number") or 0),
                "title": str(row.get("title") or "")[:18],
                "beats": [str(x)[:40] for x in (row.get("beats") if isinstance(row.get("beats"), list) else [])[:2]],
            }
        )
    return json.dumps(compact, ensure_ascii=False)


def _recommend_outline_segment_max_tokens(
    *,
    requested_count: int,
    provider: str,
    model: str | None,
    current_max_tokens: int | None,
) -> int | None:
    if requested_count <= 0:
        return None
    wanted = max(1800, min(4200, 1200 + requested_count * 230))
    limit = max_output_tokens_limit(provider, model)
    if isinstance(limit, int) and limit > 0:
        wanted = min(wanted, int(limit))
    if isinstance(current_max_tokens, int) and current_max_tokens >= wanted:
        return None
    return wanted if wanted > 0 else None


def _build_outline_stream_raw_preview(
    text: object,
    *,
    max_chars: int = OUTLINE_STREAM_RAW_PREVIEW_MAX_CHARS,
) -> str:
    if not isinstance(text, str):
        return ""
    cleaned = text.strip()
    if not cleaned:
        return ""
    if len(cleaned) <= max_chars:
        return cleaned
    omitted = len(cleaned) - max_chars
    return f"{cleaned[:max_chars]}\n...(已截断 {omitted} 字符)"


def _parse_outline_batch_output(
    *,
    text: str,
    finish_reason: str | None = None,
    fallback_outline_md: str | None = None,
) -> tuple[dict[str, object], list[str], dict[str, object] | None]:
    warnings: list[str] = []
    value, raw_json = extract_json_value(text)
    if not isinstance(value, dict):
        parse_error: dict[str, object] = {"code": "OUTLINE_PARSE_ERROR", "message": "无法从模型输出解析章节结构"}
        if finish_reason == "length" or likely_truncated_json(text):
            parse_error["hint"] = "输出疑似被截断（JSON 未闭合），将自动重试当前分段"
        data = {"outline_md": str(fallback_outline_md or ""), "chapters": [], "raw_output": text}
        return data, warnings, parse_error

    outline_md_raw = value.get("outline_md")
    outline_md = outline_md_raw.strip() if isinstance(outline_md_raw, str) else ""
    if not outline_md and isinstance(fallback_outline_md, str):
        outline_md = fallback_outline_md.strip()

    chapters_out, chapter_warnings = _normalize_outline_chapters(value.get("chapters"))
    warnings.extend(chapter_warnings)
    if finish_reason == "length":
        warnings.append("output_truncated")

    data: dict[str, object] = {"outline_md": outline_md, "chapters": chapters_out, "raw_output": text}
    if raw_json:
        data["raw_json"] = raw_json
    if chapters_out:
        return data, warnings, None

    parse_error = {"code": "OUTLINE_PARSE_ERROR", "message": "无法从模型输出解析章节结构"}
    if finish_reason == "length" or likely_truncated_json(text):
        parse_error["hint"] = "输出疑似被截断（JSON 未闭合），将自动重试当前分段"
    return data, warnings, parse_error


def _build_outline_segment_prompts(
    *,
    base_prompt_system: str,
    base_prompt_user: str,
    target_chapter_count: int,
    batch_numbers: list[int],
    existing_chapters: list[dict[str, object]],
    existing_outline_md: str,
    attempt: int,
    max_attempts: int,
    previous_output_numbers: list[int] | None = None,
    previous_failure_reason: str | None = None,
) -> tuple[str, str]:
    base_user = _strip_segment_conflicting_prompt_sections(base_prompt_user)
    missing_ranges = _format_chapter_number_ranges(batch_numbers)
    missing_numbers_json = json.dumps(batch_numbers, ensure_ascii=False)
    detail_rule = _outline_fill_detail_rule(
        target_chapter_count=target_chapter_count,
        existing_chapters=existing_chapters,
    )
    existing_numbers_set: set[int] = set()
    for chapter in existing_chapters:
        try:
            number = int(chapter.get("number"))
        except Exception:
            continue
        if number > 0:
            existing_numbers_set.add(number)
    existing_numbers = sorted(existing_numbers_set)
    existing_ranges = _format_chapter_number_ranges(existing_numbers)
    chapter_index = _build_outline_segment_chapter_index(existing_chapters)
    recent_window = _build_outline_segment_recent_window(existing_chapters)
    outline_anchor = (existing_outline_md or "").strip()
    if len(outline_anchor) > 3600:
        outline_anchor = outline_anchor[:3600]
    feedback_block = ""
    if attempt > 1:
        prev_numbers_text = _format_chapter_number_ranges(previous_output_numbers or [])
        if not prev_numbers_text:
            prev_numbers_text = "（无可识别章号）"
        failure_reason = (previous_failure_reason or "上一轮输出未满足当前批次约束").strip()
        feedback_block = (
            "<LAST_ATTEMPT_FEEDBACK>\n"
            f"上一轮失败原因：{failure_reason}\n"
            f"上一轮输出章号：{prev_numbers_text}\n"
            "本轮必须纠正：只输出当前批次章号数组对应的章节。\n"
            "</LAST_ATTEMPT_FEEDBACK>\n"
        )

    system = (
        f"{base_prompt_system}\n\n"
        "[分段生成协议]\n"
        "你现在处于“长篇章节分段生成”模式。\n"
        "你必须只输出一个 JSON 对象，禁止任何解释、Markdown、代码块。\n"
        'JSON 固定为：{"outline_md": string, "chapters":[{"number":int,"title":string,"beats":[string]}]}。\n'
        "本轮只能输出要求章号，不能输出范围外章节。\n"
        "本轮要求的每个章号必须出现且仅出现一次。\n"
        "不得输出占位内容（如 TODO/待补全/略）。\n"
    )
    user = (
        f"{base_user}\n\n"
        "<SEGMENT_TASK>\n"
        f"目标总章数：{target_chapter_count}\n"
        f"当前批次缺失章号：{missing_ranges}\n"
        f"当前批次章号数组（严格按此输出）：{missing_numbers_json}\n"
        f"已完成章号（禁止输出）：{existing_ranges or '（空）'}\n"
        f"当前尝试：第 {attempt}/{max_attempts} 轮（仅补当前批次缺失章号）\n"
        f"已生成章节标题索引（全量，不可改写）：{chapter_index}\n"
        f"最近章节细节（用于衔接语义）：{recent_window}\n"
        f"全书总纲锚点（不可改写）：{outline_anchor}\n"
        f"每章细节规则：{detail_rule}\n"
        f"{feedback_block}"
        "输出要求：\n"
        "- chapters 只能包含当前批次缺失章号，且必须全部覆盖。\n"
        "- number 必须严格等于指定章号，不得跳号/重号。\n"
        "- 若输出任何已完成章号或范围外章号，本轮会被判定失败并重试。\n"
        "- title 简洁明确，beats 使用短句、强调因果推进。\n"
        "- outline_md 可沿用既有总纲，不得输出空对象或额外字段。\n"
        "- 输出前自检：chapters.number 集合必须与当前批次章号数组完全一致。\n"
        "</SEGMENT_TASK>"
    )
    return system, user


def _outline_segment_progress_message(progress: dict[str, object] | None) -> str:
    if not isinstance(progress, dict):
        return "长篇分段生成中..."
    event = str(progress.get("event") or "")
    if event.startswith("fill_"):
        mapped = dict(progress)
        mapped["event"] = event.removeprefix("fill_")
        return _outline_fill_progress_message(mapped)

    batch_index = int(progress.get("batch_index") or 0)
    batch_count = int(progress.get("batch_count") or 0)
    range_text = str(progress.get("range") or "")
    attempt = int(progress.get("attempt") or 0)
    max_attempts = int(progress.get("max_attempts") or 0)
    completed = int(progress.get("completed_count") or 0)
    target = int(progress.get("target_chapter_count") or 0)
    remaining = int(progress.get("remaining_count") or 0)

    if event == "segment_start":
        return f"长篇分段生成启动：共 {batch_count} 批"
    if event == "batch_attempt_start":
        return f"分段生成 第 {batch_index}/{batch_count} 批（章号 {range_text}），尝试 {attempt}/{max_attempts}"
    if event == "batch_call_failed":
        return f"分段生成 第 {batch_index}/{batch_count} 批调用失败，自动重试（{attempt}/{max_attempts}）"
    if event == "batch_parse_failed":
        return f"分段生成 第 {batch_index}/{batch_count} 批解析失败，自动重试（{attempt}/{max_attempts}）"
    if event == "batch_no_progress":
        return f"分段生成 第 {batch_index}/{batch_count} 批无有效新章，自动重试（{attempt}/{max_attempts}）"
    if event == "batch_applied":
        if target > 0:
            return f"分段生成已完成 {completed}/{target} 章，剩余 {remaining} 章"
        return "分段生成已应用一批结果"
    if event == "batch_incomplete":
        return f"分段生成 第 {batch_index}/{batch_count} 批未完全收敛，剩余 {remaining} 章"
    if event == "segment_done":
        return "分段生成完成"
    if target > 0 and completed > 0:
        return f"分段生成中... 已完成 {completed}/{target} 章"
    return "长篇分段生成中..."


def _extract_outline_chapter_numbers(chapters: list[dict[str, object]], *, limit: int = 64) -> list[int]:
    numbers: set[int] = set()
    for chapter in chapters:
        try:
            number = int(chapter.get("number"))
        except Exception:
            continue
        if number <= 0:
            continue
        numbers.add(number)
        if len(numbers) >= limit:
            break
    return sorted(numbers)


def _merge_segment_chapters(
    *,
    by_number: dict[int, dict[str, object]],
    incoming: list[dict[str, object]],
    allowed_numbers: set[int],
) -> tuple[int, list[int]]:
    accepted = 0
    accepted_numbers: list[int] = []
    for chapter in incoming:
        number = int(chapter.get("number") or 0)
        if number <= 0 or number not in allowed_numbers:
            continue
        previous = by_number.get(number)
        if previous is None:
            by_number[number] = chapter
            accepted += 1
            accepted_numbers.append(number)
            continue
        if _chapter_score(chapter) > _chapter_score(previous):
            by_number[number] = chapter
    return accepted, accepted_numbers


def _generate_outline_segmented_with_llm(
    *,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    api_key: str,
    llm_call: PreparedLlmCall,
    prompt_system: str,
    prompt_user: str,
    target_chapter_count: int,
    run_params_extra_json: dict[str, object] | None,
    cancel_event: threading.Event | None = None,
    progress_hook: OutlineSegmentProgressHook | None = None,
) -> _OutlineSegmentGenerationResult:
    _raise_if_canceled(cancel_event)
    warnings: list[str] = ["outline_segment_mode_enabled"]
    run_ids: list[str] = []
    dropped_params: list[str] = []
    finish_reasons: list[str] = []
    latency_ms_total = 0
    outline_md = ""
    chapters_by_number: dict[int, dict[str, object]] = {}
    batch_size = _outline_segment_batch_size_for_target(target_chapter_count)
    batches = _outline_segment_batches(target_chapter_count, batch_size=batch_size)
    batch_count = len(batches)
    parse_error: dict[str, object] | None = None

    def _emit_progress(payload: dict[str, object]) -> None:
        if progress_hook is None:
            return
        try:
            progress_hook(payload)
        except Exception:
            return

    _emit_progress(
        {
            "event": "segment_start",
            "batch_count": batch_count,
            "target_chapter_count": target_chapter_count,
            "completed_count": 0,
            "remaining_count": target_chapter_count,
            "progress_percent": 12,
        }
    )

    for batch_index, batch in enumerate(batches, start=1):
        _raise_if_canceled(cancel_event)
        missing_numbers = [n for n in batch if n not in chapters_by_number]
        if not missing_numbers:
            continue
        max_attempts = _outline_segment_max_attempts_for_batch(len(batch))
        stagnant_attempts = 0
        attempt = 0
        last_failure_reason: str | None = None
        last_output_numbers: list[int] | None = None

        while missing_numbers and attempt < max_attempts:
            _raise_if_canceled(cancel_event)
            attempt += 1
            range_text = _format_chapter_number_ranges(batch)
            _emit_progress(
                {
                    "event": "batch_attempt_start",
                    "batch_index": batch_index,
                    "batch_count": batch_count,
                    "range": range_text,
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "target_chapter_count": target_chapter_count,
                    "completed_count": len(chapters_by_number),
                    "remaining_count": target_chapter_count - len(chapters_by_number),
                    "progress_percent": 12 + int((batch_index - 1) / max(1, batch_count) * 70),
                }
            )
            existing = [chapters_by_number[n] for n in sorted(chapters_by_number.keys())]
            segment_system, segment_user = _build_outline_segment_prompts(
                base_prompt_system=prompt_system,
                base_prompt_user=prompt_user,
                target_chapter_count=target_chapter_count,
                batch_numbers=missing_numbers,
                existing_chapters=existing,
                existing_outline_md=outline_md,
                attempt=attempt,
                max_attempts=max_attempts,
                previous_output_numbers=last_output_numbers,
                previous_failure_reason=last_failure_reason,
            )

            current_max_tokens = llm_call.params.get("max_tokens")
            current_max_tokens_int = int(current_max_tokens) if isinstance(current_max_tokens, int) else None
            segment_max_tokens = _recommend_outline_segment_max_tokens(
                requested_count=len(missing_numbers),
                provider=llm_call.provider,
                model=llm_call.model,
                current_max_tokens=current_max_tokens_int,
            )
            segment_call = with_param_overrides(llm_call, {"max_tokens": segment_max_tokens}) if segment_max_tokens else llm_call

            segment_extra = dict(run_params_extra_json or {})
            segment_extra["outline_segment"] = {
                "batch_index": batch_index,
                "batch_count": batch_count,
                "attempt": attempt,
                "max_attempts": max_attempts,
                "target_chapter_count": target_chapter_count,
                "batch_numbers": missing_numbers,
            }
            try:
                segment_res = call_llm_and_record(
                    logger=logger,
                    request_id=request_id,
                    actor_user_id=actor_user_id,
                    project_id=project_id,
                    chapter_id=None,
                    run_type="outline_segment",
                    api_key=api_key,
                    prompt_system=segment_system,
                    prompt_user=segment_user,
                    llm_call=segment_call,
                    run_params_extra_json=segment_extra,
                )
            except AppError as exc:
                if exc.code == CANCEL_ERROR_CODE:
                    raise
                warnings.append("outline_segment_call_failed")
                if exc.code == "LLM_TIMEOUT":
                    warnings.append("outline_segment_timeout")
                last_failure_reason = f"模型调用失败（{exc.code}）"
                last_output_numbers = None
                stagnant_attempts += 1
                _emit_progress(
                    {
                        "event": "batch_call_failed",
                        "batch_index": batch_index,
                        "batch_count": batch_count,
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "target_chapter_count": target_chapter_count,
                        "completed_count": len(chapters_by_number),
                        "remaining_count": target_chapter_count - len(chapters_by_number),
                        "failure_reason": last_failure_reason,
                        "progress_percent": 12 + int(min(1.0, len(chapters_by_number) / max(1, target_chapter_count)) * 70),
                    }
                )
                if stagnant_attempts >= OUTLINE_SEGMENT_STAGNANT_ATTEMPTS_LIMIT:
                    break
                continue

            if segment_res.run_id not in run_ids:
                run_ids.append(segment_res.run_id)
            latency_ms_total += int(segment_res.latency_ms or 0)
            if segment_res.finish_reason is not None:
                finish_reasons.append(segment_res.finish_reason)
            for item in segment_res.dropped_params:
                if item not in dropped_params:
                    dropped_params.append(item)
            segment_raw_preview = _build_outline_stream_raw_preview(segment_res.text)
            segment_raw_chars = len(segment_res.text or "")

            parsed_data, parsed_warnings, parsed_error = _parse_outline_batch_output(
                text=segment_res.text,
                finish_reason=segment_res.finish_reason,
                fallback_outline_md=outline_md,
            )
            warnings.extend(parsed_warnings)
            if parsed_error is not None:
                warnings.append("outline_segment_parse_failed")
                if segment_res.finish_reason == "length":
                    warnings.append("outline_segment_truncated")
                last_failure_reason = str(parsed_error.get("message") or "输出解析失败")
                last_output_numbers = None
                _emit_progress(
                    {
                        "event": "batch_parse_failed",
                        "batch_index": batch_index,
                        "batch_count": batch_count,
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "range": range_text,
                        "target_chapter_count": target_chapter_count,
                        "completed_count": len(chapters_by_number),
                        "remaining_count": target_chapter_count - len(chapters_by_number),
                        "raw_output_preview": segment_raw_preview,
                        "raw_output_chars": segment_raw_chars,
                        "failure_reason": last_failure_reason,
                        "progress_percent": 12 + int(min(1.0, len(chapters_by_number) / max(1, target_chapter_count)) * 70),
                    }
                )
                stagnant_attempts += 1
                if stagnant_attempts >= OUTLINE_SEGMENT_STAGNANT_ATTEMPTS_LIMIT:
                    break
                continue

            parsed_outline_md = str(parsed_data.get("outline_md") or "").strip()
            if parsed_outline_md and not outline_md:
                outline_md = parsed_outline_md

            incoming = parsed_data.get("chapters")
            incoming_chapters = incoming if isinstance(incoming, list) else []
            incoming_numbers = _extract_outline_chapter_numbers(incoming_chapters, limit=120)
            accepted, accepted_numbers = _merge_segment_chapters(
                by_number=chapters_by_number,
                incoming=incoming_chapters,
                allowed_numbers=set(missing_numbers),
            )
            if accepted <= 0:
                warnings.append("outline_segment_no_progress")
                missing_set = set(missing_numbers)
                overlap_numbers = [n for n in incoming_numbers if n in missing_set]
                if incoming_numbers and not overlap_numbers:
                    last_failure_reason = "输出章号与当前批次不匹配（疑似重复旧章节）"
                elif incoming_numbers:
                    last_failure_reason = "输出章号包含目标范围，但未形成可采纳新章节"
                else:
                    last_failure_reason = "未输出可识别章节"
                last_output_numbers = incoming_numbers
                _emit_progress(
                    {
                        "event": "batch_no_progress",
                        "batch_index": batch_index,
                        "batch_count": batch_count,
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "range": range_text,
                        "incoming_numbers": incoming_numbers,
                        "incoming_numbers_text": _format_chapter_number_ranges(incoming_numbers),
                        "target_chapter_count": target_chapter_count,
                        "completed_count": len(chapters_by_number),
                        "remaining_count": target_chapter_count - len(chapters_by_number),
                        "raw_output_preview": segment_raw_preview,
                        "raw_output_chars": segment_raw_chars,
                        "failure_reason": last_failure_reason,
                        "progress_percent": 12 + int(min(1.0, len(chapters_by_number) / max(1, target_chapter_count)) * 70),
                    }
                )
                stagnant_attempts += 1
                if stagnant_attempts >= OUTLINE_SEGMENT_STAGNANT_ATTEMPTS_LIMIT:
                    break
                continue

            warnings.append("outline_segment_applied")
            last_failure_reason = None
            last_output_numbers = None
            stagnant_attempts = 0
            missing_numbers = [n for n in batch if n not in chapters_by_number]
            chapters_snapshot = _clone_outline_chapters([chapters_by_number[n] for n in sorted(chapters_by_number.keys())])
            _emit_progress(
                {
                    "event": "batch_applied",
                    "batch_index": batch_index,
                    "batch_count": batch_count,
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "range": range_text,
                    "accepted": accepted,
                    "accepted_numbers": accepted_numbers,
                    "chapters_snapshot": chapters_snapshot,
                    "outline_md": outline_md,
                    "target_chapter_count": target_chapter_count,
                    "completed_count": len(chapters_snapshot),
                    "remaining_count": target_chapter_count - len(chapters_snapshot),
                    "raw_output_preview": segment_raw_preview,
                    "raw_output_chars": segment_raw_chars,
                    "progress_percent": 12 + int(min(1.0, len(chapters_snapshot) / max(1, target_chapter_count)) * 80),
                }
            )

        if missing_numbers:
            warnings.append("outline_segment_batch_incomplete")
            chapters_snapshot = _clone_outline_chapters([chapters_by_number[n] for n in sorted(chapters_by_number.keys())])
            _emit_progress(
                {
                    "event": "batch_incomplete",
                    "batch_index": batch_index,
                    "batch_count": batch_count,
                    "range": _format_chapter_number_ranges(batch),
                    "target_chapter_count": target_chapter_count,
                    "completed_count": len(chapters_snapshot),
                    "remaining_count": target_chapter_count - len(chapters_snapshot),
                    "progress_percent": 90,
                }
            )

    chapters_now = [chapters_by_number[n] for n in sorted(chapters_by_number.keys())]
    if not outline_md:
        outline_md = "## AI 大纲\n\n- 分段生成完成，请按需要补充总纲摘要。"
        warnings.append("outline_segment_outline_md_fallback")
    data: dict[str, object] = {"outline_md": outline_md, "chapters": chapters_now}
    data, coverage_warnings = _enforce_outline_chapter_coverage(data=data, target_chapter_count=target_chapter_count)
    warnings.extend(coverage_warnings)

    def _forward_fill_progress(update: dict[str, object]) -> None:
        if not isinstance(update, dict):
            return
        mapped = dict(update)
        mapped["event"] = f"fill_{mapped.get('event')}"
        mapped["target_chapter_count"] = target_chapter_count
        chapters_snapshot = mapped.get("chapters_snapshot")
        if isinstance(chapters_snapshot, list):
            mapped["completed_count"] = len(chapters_snapshot)
        else:
            chapter_count_raw = mapped.get("chapter_count")
            if isinstance(chapter_count_raw, int):
                mapped["completed_count"] = chapter_count_raw
            else:
                mapped["completed_count"] = len(data.get("chapters") or [])
        mapped["progress_percent"] = 94
        _emit_progress(mapped)

    data, fill_warnings, fill_run_ids = _fill_outline_missing_chapters_with_llm(
        data=data,
        target_chapter_count=target_chapter_count,
        request_id=request_id,
        actor_user_id=actor_user_id,
        project_id=project_id,
        api_key=api_key,
        llm_call=llm_call,
        run_params_extra_json=run_params_extra_json,
        cancel_event=cancel_event,
        progress_hook=_forward_fill_progress if progress_hook is not None else None,
    )
    warnings.extend(fill_warnings)
    for rid in fill_run_ids:
        if rid not in run_ids:
            run_ids.append(rid)

    chapters_final = data.get("chapters")
    chapters_final_count = len(chapters_final) if isinstance(chapters_final, list) else 0
    if chapters_final_count <= 0:
        parse_error = {"code": "OUTLINE_PARSE_ERROR", "message": "分段生成未得到可用章节结构"}

    coverage = data.get("chapter_coverage")
    if isinstance(coverage, dict):
        coverage["segment_batch_size"] = batch_size
        coverage["segment_batch_count"] = batch_count
        coverage["segment_run_ids"] = run_ids
        data["chapter_coverage"] = coverage

    _emit_progress(
        {
            "event": "segment_done",
            "batch_count": batch_count,
            "target_chapter_count": target_chapter_count,
            "completed_count": chapters_final_count,
            "remaining_count": max(0, target_chapter_count - chapters_final_count),
            "progress_percent": 98,
        }
    )

    meta: dict[str, object] = {
        "mode": "segmented",
        "target_chapter_count": target_chapter_count,
        "batch_size": batch_size,
        "batch_count": batch_count,
        "run_count": len(run_ids),
    }
    return _OutlineSegmentGenerationResult(
        data=data,
        warnings=_dedupe_warnings(warnings),
        parse_error=parse_error,
        run_ids=run_ids,
        latency_ms=latency_ms_total,
        dropped_params=dropped_params,
        finish_reasons=finish_reasons,
        meta=meta,
    )


def _build_outline_segment_aggregate_output_text(
    *,
    data: dict[str, object],
    warnings: list[str],
    meta: dict[str, object],
) -> str:
    chapters = data.get("chapters")
    chapter_count = len(chapters) if isinstance(chapters, list) else 0
    coverage = data.get("chapter_coverage")
    summary: dict[str, object] = {
        "mode": "segmented",
        "chapter_count": chapter_count,
        "warnings": warnings[:40],
        "segmented_generation": meta,
    }
    if isinstance(coverage, dict):
        summary["chapter_coverage"] = {
            "target_chapter_count": coverage.get("target_chapter_count"),
            "missing_count": coverage.get("missing_count"),
            "missing_numbers_preview": (coverage.get("missing_numbers") or [])[:30]
            if isinstance(coverage.get("missing_numbers"), list)
            else [],
        }
    return json.dumps(summary, ensure_ascii=False)


def _write_outline_segmented_aggregate_run(
    *,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    run_type: str,
    llm_call: PreparedLlmCall,
    prompt_system: str,
    prompt_user: str,
    prompt_render_log_json: str | None,
    run_params_json: str,
    data: dict[str, object],
    warnings: list[str],
    parse_error: dict[str, object] | None,
    segmented_run_ids: list[str],
    meta: dict[str, object],
) -> str:
    output_text = _build_outline_segment_aggregate_output_text(data=data, warnings=warnings, meta=meta)
    error_json: str | None = None
    if parse_error is not None:
        error_payload = {
            "code": str(parse_error.get("code") or "OUTLINE_PARSE_ERROR"),
            "message": str(parse_error.get("message") or "分段生成结果不完整"),
            "details": {
                "segmented_run_ids": segmented_run_ids,
                "segmented_generation": meta,
            },
        }
        error_json = json.dumps(error_payload, ensure_ascii=False)
    return write_generation_run(
        request_id=request_id,
        actor_user_id=actor_user_id,
        project_id=project_id,
        chapter_id=None,
        run_type=run_type,
        provider=llm_call.provider,
        model=llm_call.model,
        prompt_system=prompt_system,
        prompt_user=prompt_user,
        prompt_render_log_json=prompt_render_log_json,
        params_json=run_params_json,
        output_text=output_text,
        error_json=error_json,
    )


def _dedupe_warnings(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for item in values:
        if not isinstance(item, str):
            continue
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _normalize_outline_chapters(chapters: object) -> tuple[list[dict[str, object]], list[str]]:
    if not isinstance(chapters, list):
        return [], []

    warnings: list[str] = []
    by_number: dict[int, dict[str, object]] = {}
    dropped_invalid = 0
    dropped_non_positive = 0
    deduped = 0

    for item in chapters:
        if not isinstance(item, dict):
            dropped_invalid += 1
            continue
        try:
            number = int(item.get("number"))
        except Exception:
            dropped_invalid += 1
            continue
        if number <= 0:
            dropped_non_positive += 1
            continue

        title = str(item.get("title") or "").strip()
        beats_raw = item.get("beats")
        beats: list[str] = []
        if isinstance(beats_raw, list):
            for beat in beats_raw:
                if beat is None:
                    continue
                text = str(beat).strip()
                if text:
                    beats.append(text)
        elif isinstance(beats_raw, str):
            text = beats_raw.strip()
            if text:
                beats.append(text)

        chapter = {"number": number, "title": title, "beats": beats}
        existing = by_number.get(number)
        if existing is None:
            by_number[number] = chapter
            continue

        deduped += 1
        existing_title = str(existing.get("title") or "").strip()
        existing_beats = existing.get("beats")
        existing_beats_count = len(existing_beats) if isinstance(existing_beats, list) else 0
        existing_score = len(existing_title) + existing_beats_count
        next_score = len(title) + len(beats)
        if next_score > existing_score:
            by_number[number] = chapter

    if dropped_invalid:
        warnings.append("outline_chapter_invalid_filtered")
    if dropped_non_positive:
        warnings.append("outline_chapter_non_positive_filtered")
    if deduped:
        warnings.append("outline_chapter_number_deduped")

    normalized = [by_number[n] for n in sorted(by_number.keys())]
    return normalized, warnings


def _clone_outline_chapters(chapters: list[dict[str, object]]) -> list[dict[str, object]]:
    cloned: list[dict[str, object]] = []
    for chapter in chapters:
        try:
            number = int(chapter.get("number"))
        except Exception:
            continue
        title = str(chapter.get("title") or "")
        beats_raw = chapter.get("beats")
        beats: list[str] = []
        if isinstance(beats_raw, list):
            for beat in beats_raw:
                text = str(beat).strip()
                if text:
                    beats.append(text)
        cloned.append({"number": number, "title": title, "beats": beats})
    return cloned


def _chapter_score(chapter: dict[str, object]) -> int:
    title = str(chapter.get("title") or "").strip()
    beats = chapter.get("beats")
    beats_count = len(beats) if isinstance(beats, list) else 0
    return len(title) + beats_count


def _collect_missing_chapter_numbers(chapters: list[dict[str, object]], target_chapter_count: int) -> list[int]:
    existing_numbers: set[int] = set()
    for chapter in chapters:
        try:
            number = int(chapter.get("number"))
        except Exception:
            continue
        if 1 <= number <= target_chapter_count:
            existing_numbers.add(number)
    return [n for n in range(1, target_chapter_count + 1) if n not in existing_numbers]


def _format_chapter_number_ranges(numbers: list[int]) -> str:
    if not numbers:
        return ""
    nums = sorted(set(int(n) for n in numbers))
    ranges: list[str] = []
    start = nums[0]
    prev = nums[0]
    for n in nums[1:]:
        if n == prev + 1:
            prev = n
            continue
        ranges.append(f"{start}-{prev}" if start != prev else str(start))
        start = n
        prev = n
    ranges.append(f"{start}-{prev}" if start != prev else str(start))
    return ", ".join(ranges)


def _compact_neighbor_chapter(chapter: dict[str, object] | None) -> dict[str, object] | None:
    if not isinstance(chapter, dict):
        return None
    try:
        number = int(chapter.get("number"))
    except Exception:
        return None
    if number <= 0:
        return None
    title = str(chapter.get("title") or "")[:28]
    beats_raw = chapter.get("beats")
    beats: list[str] = []
    if isinstance(beats_raw, list):
        for beat in beats_raw:
            text = str(beat).strip()
            if text:
                beats.append(text[:52])
            if len(beats) >= 2:
                break
    return {"number": number, "title": title, "beats": beats}


def _build_missing_neighbor_context(
    existing_chapters: list[dict[str, object]],
    missing_numbers: list[int],
    *,
    max_items: int = 24,
    max_chars: int = 2400,
) -> str:
    if not existing_chapters or not missing_numbers:
        return "[]"

    by_number: dict[int, dict[str, object]] = {}
    for chapter in existing_chapters:
        try:
            number = int(chapter.get("number"))
        except Exception:
            continue
        if number > 0:
            by_number[number] = chapter

    contexts: list[dict[str, object]] = []
    for number in sorted(set(int(n) for n in missing_numbers if int(n) > 0)):
        row: dict[str, object] = {"number": number}
        prev_compact = _compact_neighbor_chapter(by_number.get(number - 1))
        next_compact = _compact_neighbor_chapter(by_number.get(number + 1))
        if prev_compact is not None:
            row["prev"] = prev_compact
        if next_compact is not None:
            row["next"] = next_compact
        contexts.append(row)
        if len(contexts) >= max_items:
            break

    text = json.dumps(contexts, ensure_ascii=False)
    if len(text) <= max_chars:
        return text

    compact_rows: list[dict[str, object]] = []
    for row in contexts:
        slim: dict[str, object] = {"number": int(row.get("number") or 0)}
        prev_row = row.get("prev")
        if isinstance(prev_row, dict):
            slim["prev"] = {
                "number": int(prev_row.get("number") or 0),
                "title": str(prev_row.get("title") or "")[:18],
            }
        next_row = row.get("next")
        if isinstance(next_row, dict):
            slim["next"] = {
                "number": int(next_row.get("number") or 0),
                "title": str(next_row.get("title") or "")[:18],
            }
        compact_rows.append(slim)
    return json.dumps(compact_rows, ensure_ascii=False)


def _outline_fill_batch_size_for_missing(missing_count: int) -> int:
    if missing_count <= 0:
        return OUTLINE_FILL_MIN_BATCH_SIZE
    if missing_count >= 160:
        return OUTLINE_FILL_MAX_BATCH_SIZE
    if missing_count >= 80:
        return 14
    if missing_count >= 40:
        return 12
    if missing_count >= 20:
        return 10
    if missing_count >= 10:
        return 8
    return OUTLINE_FILL_MIN_BATCH_SIZE


def _outline_fill_max_attempts_for_missing(missing_count: int) -> int:
    if missing_count <= 0:
        return 1
    # Weak models may only return ~5 chapters per call; keep enough room for incremental convergence.
    estimated = (missing_count + 4) // 5 + 2
    return max(6, min(OUTLINE_FILL_MAX_TOTAL_ATTEMPTS, estimated))


def _outline_fill_progress_message(progress: dict[str, object] | None) -> str:
    if not isinstance(progress, dict):
        return "补全缺失章节..."
    event = str(progress.get("event") or "")
    remaining_raw = progress.get("remaining_count")
    remaining = int(remaining_raw) if isinstance(remaining_raw, int) else 0
    attempt_raw = progress.get("attempt")
    attempt = int(attempt_raw) if isinstance(attempt_raw, int) else 0
    max_attempts_raw = progress.get("max_attempts")
    max_attempts = int(max_attempts_raw) if isinstance(max_attempts_raw, int) else 0
    if event.startswith("gap_repair"):
        if event == "gap_repair_final_sweep_start":
            return f"终检兜底启动：剩余 {remaining} 章"
        if event == "gap_repair_final_sweep_attempt_start":
            return f"终检兜底中... 第 {attempt}/{max_attempts} 轮，剩余 {remaining} 章"
        if event == "gap_repair_final_sweep_applied":
            return f"终检兜底已插入，剩余 {remaining} 章"
        if event == "gap_repair_final_sweep_done":
            if remaining > 0:
                return f"终检兜底结束，仍缺 {remaining} 章"
            return "终检兜底完成，章节已齐全"
        if event == "gap_repair_start":
            return f"终检补全启动：剩余 {remaining} 章待修复"
        if event == "gap_repair_attempt_start":
            return f"终检补全中... 第 {attempt}/{max_attempts} 轮，剩余 {remaining} 章"
        if event == "gap_repair_applied":
            return f"终检补全已应用，剩余 {remaining} 章"
        if event == "gap_repair_done":
            if remaining > 0:
                return f"终检补全结束，仍缺 {remaining} 章"
            return "终检补全完成，章节已齐全"
    if attempt > 0 and max_attempts > 0 and remaining > 0:
        return f"补全缺失章节... 第 {attempt}/{max_attempts} 轮，剩余 {remaining} 章"
    if remaining > 0:
        return f"补全缺失章节... 剩余 {remaining} 章"
    return "补全缺失章节..."


def _enforce_outline_chapter_coverage(
    *,
    data: dict[str, object],
    target_chapter_count: int | None,
) -> tuple[dict[str, object], list[str]]:
    if not target_chapter_count or target_chapter_count <= 0:
        return data, []

    raw_chapters = data.get("chapters")
    normalized, warnings = _normalize_outline_chapters(raw_chapters)
    if not normalized:
        return data, warnings

    by_number: dict[int, dict[str, object]] = {}
    filtered_beyond_target = 0
    for chapter in normalized:
        number = int(chapter["number"])
        if number > target_chapter_count:
            filtered_beyond_target += 1
            continue
        by_number[number] = chapter

    if filtered_beyond_target:
        warnings.append("outline_chapter_beyond_target_filtered")

    chapters_out = [by_number[n] for n in sorted(by_number.keys())]
    missing_numbers = _collect_missing_chapter_numbers(chapters_out, target_chapter_count=target_chapter_count)
    coverage: dict[str, object] = {
        "target_chapter_count": target_chapter_count,
        "parsed_chapter_count": len(chapters_out),
        "missing_count": len(missing_numbers),
        "missing_numbers": missing_numbers,
    }
    if missing_numbers:
        warnings.append("outline_chapter_coverage_incomplete")
    data["chapter_coverage"] = coverage

    data["chapters"] = chapters_out
    return data, warnings


def _build_outline_missing_chapters_prompts(
    *,
    target_chapter_count: int,
    missing_numbers: list[int],
    existing_chapters: list[dict[str, object]],
    outline_md: str,
) -> tuple[str, str]:
    fill_detail_rule = _outline_fill_detail_rule(
        target_chapter_count=target_chapter_count,
        existing_chapters=existing_chapters,
    )
    missing_numbers_json = json.dumps(sorted(set(int(n) for n in missing_numbers if int(n) > 0)), ensure_ascii=False)
    existing_numbers_set: set[int] = set()
    for chapter in existing_chapters:
        if not isinstance(chapter, dict):
            continue
        try:
            number = int(chapter.get("number"))
        except Exception:
            continue
        if number > 0:
            existing_numbers_set.add(number)
    existing_numbers = sorted(existing_numbers_set)
    existing_ranges = _format_chapter_number_ranges(existing_numbers)
    neighbor_context = _build_missing_neighbor_context(existing_chapters, missing_numbers)
    style_samples = _outline_fill_style_samples(existing_chapters)
    system = (
        "你是严谨的长篇大纲补全器。"
        "你必须只输出一个 JSON 对象，禁止任何解释、Markdown、代码块。"
        '输出格式固定为：{"chapters":[{"number":int,"title":string,"beats":[string]}]}。'
        "仅输出请求的缺失章号，每个章号出现且仅出现一次。"
        "禁止输出‘待补全/自动补齐/占位/TODO’等占位词。"
        "每个 beats 必须是具体事件，避免空泛总结。"
    )
    compact = [{"number": int(c["number"]), "title": str(c.get("title") or "")[:24]} for c in existing_chapters if "number" in c]
    if len(compact) > 60:
        compact = [*compact[:30], *compact[-30:]]
    user = (
        f"目标总章数：{target_chapter_count}\n"
        f"缺失章号：{_format_chapter_number_ranges(missing_numbers)}\n"
        f"缺失章号数组（严格按此输出）：{missing_numbers_json}\n"
        f"已完成章号（禁止输出）：{existing_ranges or '（空）'}\n"
        f"已有章节（仅供连续性参考，不可重写）：{json.dumps(compact, ensure_ascii=False)}\n"
        f"缺失章节邻接上下文（prev/next，仅供衔接）：{neighbor_context}\n"
        f"风格参考样本（模仿细节密度与句式，不得复用剧情）：{style_samples}\n"
        f"整体梗概（节选）：{(outline_md or '')[:2500]}\n\n"
        "请只输出缺失章号对应的 chapters。\n"
        "输出前自检：chapters.number 集合必须与缺失章号数组完全一致。\n"
        f"每章要求：title 简洁；{fill_detail_rule}"
    )
    return system, user


def _outline_gap_repair_max_attempts(missing_count: int) -> int:
    if missing_count <= 0:
        return 1
    estimated = missing_count * 2 + 2
    return max(8, min(OUTLINE_FILL_MAX_TOTAL_ATTEMPTS, estimated))


def _build_outline_gap_repair_prompts(
    *,
    target_chapter_count: int,
    batch_missing: list[int],
    existing_chapters: list[dict[str, object]],
    outline_md: str,
    attempt: int,
    max_attempts: int,
    previous_output_numbers: list[int] | None = None,
    previous_failure_reason: str | None = None,
) -> tuple[str, str]:
    missing_sorted = sorted(set(int(n) for n in batch_missing if int(n) > 0))
    missing_json = json.dumps(missing_sorted, ensure_ascii=False)
    missing_ranges = _format_chapter_number_ranges(missing_sorted)
    index_json = _build_outline_segment_chapter_index(existing_chapters)
    neighbor_context = _build_missing_neighbor_context(existing_chapters, missing_sorted, max_items=12, max_chars=1800)
    style_samples = _outline_fill_style_samples(existing_chapters)
    detail_rule = _outline_fill_detail_rule(target_chapter_count=target_chapter_count, existing_chapters=existing_chapters)
    feedback_block = ""
    if attempt > 1:
        prev_numbers_text = _format_chapter_number_ranges(previous_output_numbers or [])
        if not prev_numbers_text:
            prev_numbers_text = "（无可识别章号）"
        reason = (previous_failure_reason or "上一轮未产生可采纳章节").strip()
        feedback_block = (
            "<LAST_ATTEMPT_FEEDBACK>\n"
            f"上一轮失败原因：{reason}\n"
            f"上一轮输出章号：{prev_numbers_text}\n"
            "本轮必须只输出当前批次缺失章号数组。\n"
            "</LAST_ATTEMPT_FEEDBACK>\n"
        )

    system = (
        "你是长篇大纲终检补全器。"
        "你必须只输出一个 JSON 对象，禁止任何解释、Markdown、代码块。"
        '输出格式固定为：{"chapters":[{"number":int,"title":string,"beats":[string]}]}。'
        "本轮只能输出要求章号，每个章号出现且仅出现一次。"
        "禁止输出范围外章号、禁止输出空 beats、禁止占位词。"
    )
    user = (
        f"目标总章数：{target_chapter_count}\n"
        f"本轮缺失章号：{missing_ranges}\n"
        f"本轮缺失章号数组（严格按此输出）：{missing_json}\n"
        f"全量章节索引（不可改写）：{index_json}\n"
        f"缺失章节邻接上下文（prev/next）：{neighbor_context}\n"
        f"风格参考样本：{style_samples}\n"
        f"整体梗概（节选）：{(outline_md or '')[:2400]}\n"
        f"当前尝试：第 {attempt}/{max_attempts} 轮\n"
        f"{feedback_block}"
        "输出前自检：chapters.number 集合必须与本轮缺失章号数组完全一致。\n"
        f"每章要求：title 简洁；{detail_rule}"
    )
    return system, user


def _repair_outline_remaining_gaps_with_llm(
    *,
    data: dict[str, object],
    target_chapter_count: int | None,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    api_key: str,
    llm_call,
    run_params_extra_json: dict[str, object] | None,
    cancel_event: threading.Event | None = None,
    progress_hook: OutlineFillProgressHook | None = None,
) -> tuple[dict[str, object], list[str], list[str]]:
    _raise_if_canceled(cancel_event)
    if not target_chapter_count or target_chapter_count <= 0:
        return data, [], []
    chapters_now, normalize_warnings = _normalize_outline_chapters(data.get("chapters"))
    if not chapters_now:
        return data, normalize_warnings, []

    missing_numbers = _collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count)
    if not missing_numbers:
        return data, [], []

    warnings: list[str] = list(normalize_warnings)
    run_ids: list[str] = []
    if len(missing_numbers) > OUTLINE_GAP_REPAIR_MAX_MISSING:
        warnings.append("outline_gap_repair_skipped_too_many_missing")
        return data, _dedupe_warnings(warnings), run_ids

    max_attempts = _outline_gap_repair_max_attempts(len(missing_numbers))
    contract = contract_for_task("outline_generate")
    attempt = 0
    stagnant_rounds = 0
    last_failure_reason: str | None = None
    last_output_numbers: list[int] | None = None

    if progress_hook is not None:
        progress_hook(
            {
                "event": "gap_repair_start",
                "attempt": 0,
                "max_attempts": max_attempts,
                "remaining_count": len(missing_numbers),
            }
        )

    while attempt < max_attempts:
        _raise_if_canceled(cancel_event)
        missing_numbers = _collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count)
        if not missing_numbers:
            break
        attempt += 1
        batch_missing = missing_numbers[: OUTLINE_GAP_REPAIR_BATCH_SIZE]
        if progress_hook is not None:
            progress_hook(
                {
                    "event": "gap_repair_attempt_start",
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "batch_size": len(batch_missing),
                    "remaining_count": len(missing_numbers),
                    "range": _format_chapter_number_ranges(batch_missing),
                }
            )

        repair_system, repair_user = _build_outline_gap_repair_prompts(
            target_chapter_count=target_chapter_count,
            batch_missing=batch_missing,
            existing_chapters=chapters_now,
            outline_md=str(data.get("outline_md") or ""),
            attempt=attempt,
            max_attempts=max_attempts,
            previous_output_numbers=last_output_numbers,
            previous_failure_reason=last_failure_reason,
        )

        current_max_tokens = llm_call.params.get("max_tokens")
        current_max_tokens_int = int(current_max_tokens) if isinstance(current_max_tokens, int) else None
        repair_max_tokens = _recommend_outline_segment_max_tokens(
            requested_count=len(batch_missing),
            provider=llm_call.provider,
            model=llm_call.model,
            current_max_tokens=current_max_tokens_int,
        )
        repair_call = with_param_overrides(llm_call, {"max_tokens": repair_max_tokens}) if repair_max_tokens else llm_call
        repair_extra = dict(run_params_extra_json or {})
        repair_extra["outline_gap_repair"] = {
            "attempt": attempt,
            "max_attempts": max_attempts,
            "target_chapter_count": target_chapter_count,
            "batch_missing": batch_missing,
        }
        try:
            repaired = call_llm_and_record(
                logger=logger,
                request_id=request_id,
                actor_user_id=actor_user_id,
                project_id=project_id,
                chapter_id=None,
                run_type="outline_gap_repair",
                api_key=api_key,
                prompt_system=repair_system,
                prompt_user=repair_user,
                llm_call=repair_call,
                run_params_extra_json=repair_extra,
            )
        except AppError as exc:
            if exc.code == CANCEL_ERROR_CODE:
                raise
            warnings.append("outline_gap_repair_call_failed")
            if exc.code == "LLM_TIMEOUT":
                warnings.append("outline_gap_repair_timeout")
            last_failure_reason = f"模型调用失败（{exc.code}）"
            last_output_numbers = None
            stagnant_rounds += 1
            if progress_hook is not None:
                progress_hook(
                    {
                        "event": "gap_repair_call_failed",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "remaining_count": len(missing_numbers),
                    }
                )
            if stagnant_rounds >= OUTLINE_GAP_REPAIR_STAGNANT_LIMIT:
                break
            continue

        run_ids.append(repaired.run_id)
        raw_preview = _build_outline_stream_raw_preview(repaired.text)
        raw_chars = len(repaired.text or "")
        repaired_parsed = contract.parse(repaired.text, finish_reason=repaired.finish_reason)
        repaired_data, repaired_warnings, repaired_error = (
            repaired_parsed.data,
            repaired_parsed.warnings,
            repaired_parsed.parse_error,
        )
        warnings.extend(repaired_warnings)
        if repaired_error is not None:
            warnings.append("outline_gap_repair_parse_failed")
            last_failure_reason = str(repaired_error.get("message") or "输出解析失败")
            last_output_numbers = None
            stagnant_rounds += 1
            if progress_hook is not None:
                progress_hook(
                    {
                        "event": "gap_repair_parse_failed",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "remaining_count": len(missing_numbers),
                        "raw_output_preview": raw_preview,
                        "raw_output_chars": raw_chars,
                    }
                )
            if stagnant_rounds >= OUTLINE_GAP_REPAIR_STAGNANT_LIMIT:
                break
            continue

        incoming, incoming_warnings = _normalize_outline_chapters(repaired_data.get("chapters"))
        warnings.extend(incoming_warnings)
        incoming_numbers = _extract_outline_chapter_numbers(incoming, limit=120)
        if not incoming:
            warnings.append("outline_gap_repair_empty")
            last_failure_reason = "未输出可识别章节"
            last_output_numbers = incoming_numbers
            stagnant_rounds += 1
            if stagnant_rounds >= OUTLINE_GAP_REPAIR_STAGNANT_LIMIT:
                break
            continue

        accepted = 0
        accepted_numbers: list[int] = []
        allowed = set(batch_missing)
        by_number = {int(c["number"]): c for c in chapters_now if int(c["number"]) <= target_chapter_count}
        for chapter in incoming:
            number = int(chapter["number"])
            if number not in allowed:
                continue
            previous = by_number.get(number)
            if previous is None:
                by_number[number] = chapter
                accepted += 1
                accepted_numbers.append(number)
                continue
            if _chapter_score(chapter) > _chapter_score(previous):
                by_number[number] = chapter

        if accepted <= 0:
            warnings.append("outline_gap_repair_no_progress")
            last_output_numbers = incoming_numbers
            if incoming_numbers:
                last_failure_reason = "输出章号与缺失章号不一致"
            else:
                last_failure_reason = "未输出可采纳章节"
            stagnant_rounds += 1
            if progress_hook is not None:
                progress_hook(
                    {
                        "event": "gap_repair_no_progress",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "remaining_count": len(missing_numbers),
                        "raw_output_preview": raw_preview,
                        "raw_output_chars": raw_chars,
                        "incoming_numbers_text": _format_chapter_number_ranges(incoming_numbers),
                    }
                )
            if stagnant_rounds >= OUTLINE_GAP_REPAIR_STAGNANT_LIMIT:
                break
            continue

        warnings.append("outline_gap_repair_applied")
        stagnant_rounds = 0
        last_failure_reason = None
        last_output_numbers = None
        chapters_now = [by_number[n] for n in sorted(by_number.keys())]
        remaining = len(_collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count))
        if progress_hook is not None:
            progress_hook(
                {
                    "event": "gap_repair_applied",
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "accepted": accepted,
                    "accepted_numbers": accepted_numbers,
                    "chapters_snapshot": _clone_outline_chapters(chapters_now),
                    "chapter_count": len(chapters_now),
                    "remaining_count": remaining,
                    "raw_output_preview": raw_preview,
                    "raw_output_chars": raw_chars,
                }
            )

    data["chapters"] = chapters_now
    data, coverage_warnings = _enforce_outline_chapter_coverage(data=data, target_chapter_count=target_chapter_count)
    warnings.extend(coverage_warnings)
    coverage = data.get("chapter_coverage")
    remaining_count = int(coverage.get("missing_count") or 0) if isinstance(coverage, dict) else 0
    if remaining_count > 0:
        warnings.append("outline_gap_repair_remaining")
        chapters_now, final_warnings, final_run_ids = _repair_outline_remaining_gaps_final_sweep_with_llm(
            chapters_now=chapters_now,
            outline_md=str(data.get("outline_md") or ""),
            target_chapter_count=target_chapter_count,
            request_id=request_id,
            actor_user_id=actor_user_id,
            project_id=project_id,
            api_key=api_key,
            llm_call=llm_call,
            run_params_extra_json=run_params_extra_json,
            cancel_event=cancel_event,
            progress_hook=progress_hook,
        )
        warnings.extend(final_warnings)
        for run_id in final_run_ids:
            if run_id not in run_ids:
                run_ids.append(run_id)
        data["chapters"] = chapters_now
        data, final_coverage_warnings = _enforce_outline_chapter_coverage(
            data=data, target_chapter_count=target_chapter_count
        )
        warnings.extend(final_coverage_warnings)
        coverage = data.get("chapter_coverage")
        remaining_count = int(coverage.get("missing_count") or 0) if isinstance(coverage, dict) else 0
        if remaining_count > 0:
            warnings.append("outline_gap_repair_final_sweep_remaining")
        else:
            warnings.extend(["outline_gap_repair_final_sweep_resolved", "outline_gap_repair_resolved"])
    else:
        warnings.append("outline_gap_repair_resolved")

    if progress_hook is not None:
        progress_hook(
            {
                "event": "gap_repair_done",
                "attempt": attempt,
                "max_attempts": max_attempts,
                "remaining_count": remaining_count,
            }
        )
    return data, _dedupe_warnings(warnings), run_ids


def _repair_outline_remaining_gaps_final_sweep_with_llm(
    *,
    chapters_now: list[dict[str, object]],
    outline_md: str,
    target_chapter_count: int,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    api_key: str,
    llm_call,
    run_params_extra_json: dict[str, object] | None,
    cancel_event: threading.Event | None = None,
    progress_hook: OutlineFillProgressHook | None = None,
) -> tuple[list[dict[str, object]], list[str], list[str]]:
    _raise_if_canceled(cancel_event)
    warnings: list[str] = []
    run_ids: list[str] = []
    missing_numbers = _collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count)
    if not missing_numbers:
        return chapters_now, warnings, run_ids
    if len(missing_numbers) > OUTLINE_GAP_REPAIR_FINAL_SWEEP_MAX_MISSING:
        warnings.append("outline_gap_repair_final_sweep_skipped_too_many_missing")
        return chapters_now, warnings, run_ids

    warnings.append("outline_gap_repair_final_sweep_started")
    max_attempts = OUTLINE_GAP_REPAIR_FINAL_SWEEP_ATTEMPTS_PER_CHAPTER
    contract = contract_for_task("outline_generate")
    if progress_hook is not None:
        progress_hook(
            {
                "event": "gap_repair_final_sweep_start",
                "attempt": 0,
                "max_attempts": max_attempts,
                "remaining_count": len(missing_numbers),
            }
        )

    for number in list(missing_numbers):
        _raise_if_canceled(cancel_event)
        chapter_fixed = False
        last_failure_reason: str | None = None
        last_output_numbers: list[int] | None = None
        for attempt in range(1, max_attempts + 1):
            _raise_if_canceled(cancel_event)
            remaining_before = len(_collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count))
            if progress_hook is not None:
                progress_hook(
                    {
                        "event": "gap_repair_final_sweep_attempt_start",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "remaining_count": remaining_before,
                        "range": str(number),
                    }
                )

            repair_system, repair_user = _build_outline_gap_repair_prompts(
                target_chapter_count=target_chapter_count,
                batch_missing=[number],
                existing_chapters=chapters_now,
                outline_md=outline_md,
                attempt=attempt,
                max_attempts=max_attempts,
                previous_output_numbers=last_output_numbers,
                previous_failure_reason=last_failure_reason,
            )
            current_max_tokens = llm_call.params.get("max_tokens")
            current_max_tokens_int = int(current_max_tokens) if isinstance(current_max_tokens, int) else None
            repair_max_tokens = _recommend_outline_segment_max_tokens(
                requested_count=1,
                provider=llm_call.provider,
                model=llm_call.model,
                current_max_tokens=current_max_tokens_int,
            )
            repair_call = with_param_overrides(llm_call, {"max_tokens": repair_max_tokens}) if repair_max_tokens else llm_call
            repair_extra = dict(run_params_extra_json or {})
            repair_extra["outline_gap_repair_final_sweep"] = {
                "attempt": attempt,
                "max_attempts": max_attempts,
                "target_chapter_count": target_chapter_count,
                "chapter_number": number,
            }
            try:
                repaired = call_llm_and_record(
                    logger=logger,
                    request_id=request_id,
                    actor_user_id=actor_user_id,
                    project_id=project_id,
                    chapter_id=None,
                    run_type="outline_gap_repair_final_sweep",
                    api_key=api_key,
                    prompt_system=repair_system,
                    prompt_user=repair_user,
                    llm_call=repair_call,
                    run_params_extra_json=repair_extra,
                )
            except AppError as exc:
                if exc.code == CANCEL_ERROR_CODE:
                    raise
                warnings.append("outline_gap_repair_final_sweep_call_failed")
                if exc.code == "LLM_TIMEOUT":
                    warnings.append("outline_gap_repair_final_sweep_timeout")
                last_failure_reason = f"模型调用失败（{exc.code}）"
                last_output_numbers = None
                continue

            run_ids.append(repaired.run_id)
            raw_preview = _build_outline_stream_raw_preview(repaired.text)
            raw_chars = len(repaired.text or "")
            repaired_parsed = contract.parse(repaired.text, finish_reason=repaired.finish_reason)
            repaired_data, repaired_warnings, repaired_error = (
                repaired_parsed.data,
                repaired_parsed.warnings,
                repaired_parsed.parse_error,
            )
            warnings.extend(repaired_warnings)
            if repaired_error is not None:
                warnings.append("outline_gap_repair_final_sweep_parse_failed")
                last_failure_reason = str(repaired_error.get("message") or "输出解析失败")
                last_output_numbers = None
                continue

            incoming, incoming_warnings = _normalize_outline_chapters(repaired_data.get("chapters"))
            warnings.extend(incoming_warnings)
            incoming_numbers = _extract_outline_chapter_numbers(incoming, limit=120)
            if not incoming:
                warnings.append("outline_gap_repair_final_sweep_empty")
                last_failure_reason = "未输出可识别章节"
                last_output_numbers = incoming_numbers
                continue

            by_number = {int(c["number"]): c for c in chapters_now if int(c["number"]) <= target_chapter_count}
            accepted = 0
            accepted_numbers: list[int] = []
            for chapter in incoming:
                chapter_number = int(chapter["number"])
                if chapter_number != number:
                    continue
                previous = by_number.get(chapter_number)
                if previous is None:
                    by_number[chapter_number] = chapter
                    accepted += 1
                    accepted_numbers.append(chapter_number)
                    continue
                if _chapter_score(chapter) > _chapter_score(previous):
                    by_number[chapter_number] = chapter

            if accepted <= 0:
                warnings.append("outline_gap_repair_final_sweep_no_progress")
                if incoming_numbers:
                    last_failure_reason = "输出章号与目标章号不一致"
                else:
                    last_failure_reason = "未输出可采纳章节"
                last_output_numbers = incoming_numbers
                continue

            warnings.append("outline_gap_repair_final_sweep_applied")
            last_failure_reason = None
            last_output_numbers = None
            chapters_now = [by_number[n] for n in sorted(by_number.keys())]
            chapter_fixed = True
            remaining_after = len(
                _collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count)
            )
            if progress_hook is not None:
                progress_hook(
                    {
                        "event": "gap_repair_final_sweep_applied",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "accepted": accepted,
                        "accepted_numbers": accepted_numbers,
                        "chapters_snapshot": _clone_outline_chapters(chapters_now),
                        "chapter_count": len(chapters_now),
                        "remaining_count": remaining_after,
                        "raw_output_preview": raw_preview,
                        "raw_output_chars": raw_chars,
                    }
                )
            break

        if not chapter_fixed:
            warnings.append("outline_gap_repair_final_sweep_chapter_unresolved")

    remaining_final = len(_collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count))
    if progress_hook is not None:
        progress_hook(
            {
                "event": "gap_repair_final_sweep_done",
                "attempt": max_attempts,
                "max_attempts": max_attempts,
                "remaining_count": remaining_final,
            }
        )
    return chapters_now, _dedupe_warnings(warnings), run_ids


def _fill_outline_missing_chapters_with_llm(
    *,
    data: dict[str, object],
    target_chapter_count: int | None,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    api_key: str,
    llm_call,
    run_params_extra_json: dict[str, object] | None,
    cancel_event: threading.Event | None = None,
    progress_hook: OutlineFillProgressHook | None = None,
) -> tuple[dict[str, object], list[str], list[str]]:
    _raise_if_canceled(cancel_event)
    if not target_chapter_count or target_chapter_count <= 0:
        return data, [], []
    chapters_now, normalize_warnings = _normalize_outline_chapters(data.get("chapters"))
    if not chapters_now:
        return data, normalize_warnings, []

    warnings: list[str] = list(normalize_warnings)
    continue_run_ids: list[str] = []
    contract = contract_for_task("outline_generate")
    missing_numbers = _collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count)
    max_attempts = _outline_fill_max_attempts_for_missing(len(missing_numbers))
    stagnant_rounds = 0
    attempt = 0

    if progress_hook is not None:
        progress_hook(
            {
                "event": "fill_start",
                "attempt": 0,
                "max_attempts": max_attempts,
                "remaining_count": len(missing_numbers),
            }
        )

    while attempt < max_attempts:
        _raise_if_canceled(cancel_event)
        missing_numbers = _collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count)
        if not missing_numbers:
            break
        batch_size = _outline_fill_batch_size_for_missing(len(missing_numbers))
        batch_missing = missing_numbers[:batch_size]
        attempt += 1
        if progress_hook is not None:
            progress_hook(
                {
                    "event": "attempt_start",
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "batch_size": len(batch_missing),
                    "remaining_count": len(missing_numbers),
                }
            )
        fill_system, fill_user = _build_outline_missing_chapters_prompts(
            target_chapter_count=target_chapter_count,
            missing_numbers=batch_missing,
            existing_chapters=chapters_now,
            outline_md=str(data.get("outline_md") or ""),
        )
        current_max_tokens = llm_call.params.get("max_tokens")
        current_max_tokens_int = int(current_max_tokens) if isinstance(current_max_tokens, int) else None
        fill_max_tokens = _recommend_outline_max_tokens(
            target_chapter_count=max(41, len(batch_missing) + 20),
            provider=llm_call.provider,
            model=llm_call.model,
            current_max_tokens=current_max_tokens_int,
        )
        fill_call = with_param_overrides(llm_call, {"max_tokens": fill_max_tokens}) if fill_max_tokens else llm_call
        fill_extra = dict(run_params_extra_json or {})
        fill_extra["outline_fill_missing"] = {
            "attempt": attempt,
            "max_attempts": max_attempts,
            "target_chapter_count": target_chapter_count,
            "batch_missing": batch_missing,
        }
        try:
            filled = call_llm_and_record(
                logger=logger,
                request_id=request_id,
                actor_user_id=actor_user_id,
                project_id=project_id,
                chapter_id=None,
                run_type="outline_fill_missing",
                api_key=api_key,
                prompt_system=fill_system,
                prompt_user=fill_user,
                llm_call=fill_call,
                run_params_extra_json=fill_extra,
            )
        except AppError as exc:
            if exc.code == CANCEL_ERROR_CODE:
                raise
            warnings.append("outline_fill_missing_call_failed")
            if exc.code == "LLM_TIMEOUT":
                warnings.append("outline_fill_missing_timeout")
            stagnant_rounds += 1
            if progress_hook is not None:
                progress_hook(
                    {
                        "event": "attempt_call_failed",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "error_code": exc.code,
                        "remaining_count": len(missing_numbers),
                    }
                )
            if stagnant_rounds >= OUTLINE_FILL_STAGNANT_ROUNDS_LIMIT:
                break
            continue
        continue_run_ids.append(filled.run_id)
        fill_raw_preview = _build_outline_stream_raw_preview(filled.text)
        fill_raw_chars = len(filled.text or "")
        filled_parsed = contract.parse(filled.text, finish_reason=filled.finish_reason)
        filled_data, filled_warnings, filled_error = filled_parsed.data, filled_parsed.warnings, filled_parsed.parse_error
        warnings.extend(filled_warnings)
        if filled_error is not None:
            warnings.append("outline_fill_missing_parse_failed")
            if filled.finish_reason == "length":
                warnings.append("outline_fill_missing_truncated")
            stagnant_rounds += 1
            if progress_hook is not None:
                progress_hook(
                    {
                        "event": "attempt_parse_failed",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "remaining_count": len(missing_numbers),
                        "raw_output_preview": fill_raw_preview,
                        "raw_output_chars": fill_raw_chars,
                    }
                )
            if stagnant_rounds >= OUTLINE_FILL_STAGNANT_ROUNDS_LIMIT:
                break
            continue

        incoming, incoming_warnings = _normalize_outline_chapters(filled_data.get("chapters"))
        warnings.extend(incoming_warnings)
        if not incoming:
            warnings.append("outline_fill_missing_empty")
            stagnant_rounds += 1
            if progress_hook is not None:
                progress_hook(
                    {
                        "event": "attempt_empty",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "remaining_count": len(missing_numbers),
                    }
                )
            if stagnant_rounds >= OUTLINE_FILL_STAGNANT_ROUNDS_LIMIT:
                break
            continue

        accepted = 0
        accepted_numbers: list[int] = []
        allowed = set(batch_missing)
        by_number = {int(c["number"]): c for c in chapters_now if int(c["number"]) <= target_chapter_count}
        for chapter in incoming:
            number = int(chapter["number"])
            if number not in allowed:
                continue
            previous = by_number.get(number)
            if previous is None:
                by_number[number] = chapter
                accepted += 1
                accepted_numbers.append(number)
                continue
            if _chapter_score(chapter) > _chapter_score(previous):
                by_number[number] = chapter

        if accepted <= 0:
            warnings.append("outline_fill_missing_no_progress")
            stagnant_rounds += 1
            if progress_hook is not None:
                progress_hook(
                    {
                        "event": "attempt_no_progress",
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "remaining_count": len(missing_numbers),
                    }
                )
            if stagnant_rounds >= OUTLINE_FILL_STAGNANT_ROUNDS_LIMIT:
                break
            continue

        warnings.append("outline_fill_missing_applied")
        stagnant_rounds = 0
        chapters_now = [by_number[n] for n in sorted(by_number.keys())]
        remaining = len(_collect_missing_chapter_numbers(chapters_now, target_chapter_count=target_chapter_count))
        if progress_hook is not None:
            chapter_snapshot = _clone_outline_chapters(chapters_now)
            progress_hook(
                {
                    "event": "attempt_applied",
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "accepted": accepted,
                    "accepted_numbers": accepted_numbers,
                    "chapters_snapshot": chapter_snapshot,
                    "chapter_count": len(chapter_snapshot),
                    "remaining_count": remaining,
                    "raw_output_preview": fill_raw_preview,
                    "raw_output_chars": fill_raw_chars,
                }
            )

    data["chapters"] = chapters_now
    data, coverage_warnings = _enforce_outline_chapter_coverage(data=data, target_chapter_count=target_chapter_count)
    warnings.extend(coverage_warnings)
    coverage = data.get("chapter_coverage")
    remaining_count = int(coverage.get("missing_count") or 0) if isinstance(coverage, dict) else 0

    gap_repair_run_ids: list[str] = []
    if remaining_count > 0:
        repaired_data, repair_warnings, repair_run_ids = _repair_outline_remaining_gaps_with_llm(
            data=data,
            target_chapter_count=target_chapter_count,
            request_id=request_id,
            actor_user_id=actor_user_id,
            project_id=project_id,
            api_key=api_key,
            llm_call=llm_call,
            run_params_extra_json=run_params_extra_json,
            cancel_event=cancel_event,
            progress_hook=progress_hook,
        )
        data = repaired_data
        warnings.extend(repair_warnings)
        gap_repair_run_ids = repair_run_ids
        for run_id in repair_run_ids:
            if run_id not in continue_run_ids:
                continue_run_ids.append(run_id)

    coverage = data.get("chapter_coverage")
    remaining_count = int(coverage.get("missing_count") or 0) if isinstance(coverage, dict) else 0
    if remaining_count > 0:
        warnings.append("outline_fill_missing_remaining")
    if gap_repair_run_ids and isinstance(coverage, dict):
        coverage["gap_repair_run_ids"] = gap_repair_run_ids
        data["chapter_coverage"] = coverage
    if progress_hook is not None:
        progress_hook(
            {
                "event": "fill_done",
                "attempt": attempt,
                "max_attempts": max_attempts,
                "remaining_count": remaining_count,
            }
        )
    return data, _dedupe_warnings(warnings), continue_run_ids


@router.get("/projects/{project_id}/outline")
def get_outline(request: Request, db: DbDep, user_id: UserIdDep, project_id: str) -> dict:
    request_id = request.state.request_id
    project = require_project_viewer(db, project_id=project_id, user_id=user_id)
    row = db.get(Outline, project.active_outline_id) if project.active_outline_id else None
    if row is None:
        row = (
            db.execute(select(Outline).where(Outline.project_id == project_id).order_by(Outline.updated_at.desc()).limit(1))
            .scalars()
            .first()
        )
    if row is None:
        row = ensure_active_outline(db, project=project)
    payload = _outline_out(row)
    return ok_payload(request_id=request_id, data={"outline": payload})


@router.put("/projects/{project_id}/outline")
def put_outline(request: Request, db: DbDep, user_id: UserIdDep, project_id: str, body: OutlineUpdate) -> dict:
    request_id = request.state.request_id
    project = require_project_editor(db, project_id=project_id, user_id=user_id)
    row = ensure_active_outline(db, project=project)

    if body.title is not None:
        row.title = body.title
    if body.content_md is not None:
        content_md, structure, normalized = normalize_outline_content_and_structure(
            content_md=body.content_md,
            structure=body.structure,
        )
        row.content_md = content_md
        if body.structure is not None or normalized:
            row.structure_json = json.dumps(structure, ensure_ascii=False) if structure is not None else None
    elif body.structure is not None:
        row.structure_json = json.dumps(body.structure, ensure_ascii=False)

    _mark_vector_index_dirty(db, project_id=project_id)
    db.commit()
    db.refresh(row)
    schedule_vector_rebuild_task(db=db, project_id=project_id, actor_user_id=user_id, request_id=request_id, reason="outline_update")
    schedule_search_rebuild_task(db=db, project_id=project_id, actor_user_id=user_id, request_id=request_id, reason="outline_update")
    payload = _outline_out(row)
    return ok_payload(request_id=request_id, data={"outline": payload})


@router.post("/projects/{project_id}/outline/generate")
def generate_outline(
    request: Request,
    project_id: str,
    body: OutlineGenerateRequest,
    user_id: UserIdDep,
    x_llm_provider: str | None = Header(default=None, alias="X-LLM-Provider", max_length=64),
    x_llm_api_key: str | None = Header(default=None, alias="X-LLM-API-Key", max_length=4096),
) -> dict:
    request_id = request.state.request_id
    prepared: _PreparedOutlineGeneration | None = None

    db = SessionLocal()
    try:
        prepared = _prepare_outline_generation(
            db=db,
            project_id=project_id,
            body=body,
            user_id=user_id,
            request_id=request_id,
            x_llm_provider=x_llm_provider,
            x_llm_api_key=x_llm_api_key,
        )
    finally:
        db.close()

    if prepared is None:
        raise AppError(code="INTERNAL_ERROR", message="LLM 调用准备失败", status_code=500)

    cancel_event = threading.Event()
    _start_disconnect_watcher(request, cancel_event)
    try:
        _raise_if_canceled(cancel_event)
        if _should_use_outline_segmented_mode(prepared.target_chapter_count):
            assert prepared.target_chapter_count is not None
            segmented = _generate_outline_segmented_with_llm(
                request_id=request_id,
                actor_user_id=user_id,
                project_id=project_id,
                api_key=str(prepared.resolved_api_key),
                llm_call=prepared.llm_call,
                prompt_system=prepared.prompt_system,
                prompt_user=prepared.prompt_user,
                target_chapter_count=prepared.target_chapter_count,
                run_params_extra_json=prepared.run_params_extra_json,
                cancel_event=cancel_event,
            )
            aggregate_params_json = build_run_params_json(
                params_json=prepared.llm_call.params_json,
                memory_retrieval_log_json=None,
                extra_json=prepared.run_params_extra_json,
            )
            aggregate_run_id = _write_outline_segmented_aggregate_run(
                request_id=request_id,
                actor_user_id=user_id,
                project_id=project_id,
                run_type="outline_segmented",
                llm_call=prepared.llm_call,
                prompt_system=prepared.prompt_system,
                prompt_user=prepared.prompt_user,
                prompt_render_log_json=prepared.prompt_render_log_json,
                run_params_json=aggregate_params_json,
                data=segmented.data,
                warnings=segmented.warnings,
                parse_error=segmented.parse_error,
                segmented_run_ids=segmented.run_ids,
                meta=segmented.meta,
            )
            data = dict(segmented.data)
            warnings = _dedupe_warnings(segmented.warnings)
            if warnings:
                data["warnings"] = warnings
            if segmented.parse_error is not None:
                data["parse_error"] = segmented.parse_error
            data["generation_run_id"] = aggregate_run_id
            if segmented.run_ids:
                data["generation_sub_run_ids"] = segmented.run_ids
                data["generation_run_ids"] = [aggregate_run_id, *segmented.run_ids]
            if segmented.latency_ms > 0:
                data["latency_ms"] = segmented.latency_ms
            if segmented.dropped_params:
                data["dropped_params"] = segmented.dropped_params
            if segmented.finish_reasons:
                data["finish_reason"] = segmented.finish_reasons[-1]
                data["finish_reasons"] = segmented.finish_reasons
            data["segmented_generation"] = segmented.meta
            return ok_payload(request_id=request_id, data=data)

        _raise_if_canceled(cancel_event)
        llm_result = call_llm_and_record(
            logger=logger,
            request_id=request_id,
            actor_user_id=user_id,
            project_id=project_id,
            chapter_id=None,
            run_type="outline",
            api_key=str(prepared.resolved_api_key),
            prompt_system=prepared.prompt_system,
            prompt_user=prepared.prompt_user,
            prompt_messages=prepared.prompt_messages,
            prompt_render_log_json=prepared.prompt_render_log_json,
            llm_call=prepared.llm_call,
            run_params_extra_json=prepared.run_params_extra_json,
        )

        _raise_if_canceled(cancel_event)
        raw_output = llm_result.text
        finish_reason = llm_result.finish_reason
        contract = contract_for_task("outline_generate")
        parsed = contract.parse(raw_output, finish_reason=finish_reason)
        data, warnings, parse_error = parsed.data, parsed.warnings, parsed.parse_error

        if parse_error is not None and prepared.llm_call.provider in (
            "openai",
            "openai_responses",
            "openai_compatible",
            "openai_responses_compatible",
        ):
            try:
                repair = build_repair_prompt_for_task("outline_generate", raw_output=raw_output)
                if repair is None:
                    raise AppError(code="OUTLINE_FIX_UNSUPPORTED", message="该任务不支持输出修复", status_code=400)
                fix_system, fix_user, fix_run_type = repair
                fix_call = with_param_overrides(prepared.llm_call, {"temperature": 0, "max_tokens": 1024})
                fixed = call_llm_and_record(
                    logger=logger,
                    request_id=request_id,
                    actor_user_id=user_id,
                    project_id=project_id,
                    chapter_id=None,
                    run_type=fix_run_type,
                    api_key=str(prepared.resolved_api_key),
                    prompt_system=fix_system,
                    prompt_user=fix_user,
                    llm_call=fix_call,
                    run_params_extra_json=prepared.run_params_extra_json,
                )
                fixed_parsed = contract.parse(fixed.text)
                fixed_data, fixed_warnings, fixed_error = (
                    fixed_parsed.data,
                    fixed_parsed.warnings,
                    fixed_parsed.parse_error,
                )
                if fixed_error is None and fixed_data.get("chapters"):
                    fixed_data["raw_output"] = raw_output
                    fixed_data["fixed_json"] = fixed_data.get("raw_json") or fixed.text
                    data = fixed_data
                    warnings.extend(["json_fixed_via_llm", *fixed_warnings])
                    parse_error = None
            except AppError as exc:
                if exc.code == CANCEL_ERROR_CODE:
                    raise
                warnings.append("outline_fix_json_failed")

        if parse_error is None:
            _raise_if_canceled(cancel_event)
            data, coverage_warnings = _enforce_outline_chapter_coverage(
                data=data,
                target_chapter_count=prepared.target_chapter_count,
            )
            warnings.extend(coverage_warnings)
            data, fill_warnings, fill_run_ids = _fill_outline_missing_chapters_with_llm(
                data=data,
                target_chapter_count=prepared.target_chapter_count,
                request_id=request_id,
                actor_user_id=user_id,
                project_id=project_id,
                api_key=str(prepared.resolved_api_key),
                llm_call=prepared.llm_call,
                run_params_extra_json=prepared.run_params_extra_json,
                cancel_event=cancel_event,
            )
            warnings.extend(fill_warnings)
            if fill_run_ids:
                coverage = data.get("chapter_coverage")
                if isinstance(coverage, dict):
                    coverage["fill_run_ids"] = fill_run_ids
                    data["chapter_coverage"] = coverage

        warnings = _dedupe_warnings(warnings)
        if warnings:
            data["warnings"] = warnings
        if parse_error is not None:
            data["parse_error"] = parse_error
        data["generation_run_id"] = llm_result.run_id
        data["latency_ms"] = llm_result.latency_ms
        if llm_result.dropped_params:
            data["dropped_params"] = llm_result.dropped_params
        if finish_reason is not None:
            data["finish_reason"] = finish_reason
        return ok_payload(request_id=request_id, data=data)
    finally:
        cancel_event.set()


@router.post("/projects/{project_id}/outline/generate-stream")
def generate_outline_stream(
    request: Request,
    project_id: str,
    body: OutlineGenerateRequest,
    user_id: UserIdDep,
    x_llm_provider: str | None = Header(default=None, alias="X-LLM-Provider", max_length=64),
    x_llm_api_key: str | None = Header(default=None, alias="X-LLM-API-Key", max_length=4096),
):
    request_id = request.state.request_id
    cancel_event = threading.Event()

    def event_generator():
        yield sse_progress(message="准备生成...", progress=0)

        prompt_system = ""
        prompt_user = ""
        prompt_messages: list[ChatMessage] = []
        prompt_render_log_json: str | None = None
        run_params_extra_json: dict[str, object] | None = None
        run_params_json: str | None = None
        llm_call = None
        resolved_api_key = ""
        target_chapter_count: int | None = None
        prepared: _PreparedOutlineGeneration | None = None

        db = SessionLocal()
        try:
            prepared = _prepare_outline_generation(
                db=db,
                project_id=project_id,
                body=body,
                user_id=user_id,
                request_id=request_id,
                x_llm_provider=x_llm_provider,
                x_llm_api_key=x_llm_api_key,
            )

            resolved_api_key = prepared.resolved_api_key
            prompt_system = prepared.prompt_system
            prompt_user = prepared.prompt_user
            prompt_messages = prepared.prompt_messages
            prompt_render_log_json = prepared.prompt_render_log_json
            llm_call = prepared.llm_call
            target_chapter_count = prepared.target_chapter_count
            run_params_extra_json = prepared.run_params_extra_json
            run_params_json = build_run_params_json(
                params_json=llm_call.params_json,
                memory_retrieval_log_json=None,
                extra_json=run_params_extra_json,
            )
        except GeneratorExit:
            cancel_event.set()
            return
        except AppError as exc:
            if exc.code == CANCEL_ERROR_CODE:
                cancel_event.set()
                return
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

        if _should_use_outline_segmented_mode(target_chapter_count):
            if target_chapter_count is None:
                yield sse_error(error="长篇分段模式参数异常", code=500)
                yield sse_done()
                return
            yield sse_progress(message="长篇模式：分段生成中...", progress=10)
            segment_progress_lock = threading.Lock()
            segment_progress_events: list[dict[str, object]] = []

            def _on_segment_progress(update: dict[str, object]) -> None:
                if not isinstance(update, dict):
                    return
                with segment_progress_lock:
                    segment_progress_events.append(dict(update))

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(
                    _generate_outline_segmented_with_llm,
                    request_id=request_id,
                    actor_user_id=user_id,
                    project_id=project_id,
                    api_key=str(resolved_api_key),
                    llm_call=llm_call,
                    prompt_system=prompt_system,
                    prompt_user=prompt_user,
                    target_chapter_count=target_chapter_count,
                    run_params_extra_json=run_params_extra_json,
                    cancel_event=cancel_event,
                    progress_hook=_on_segment_progress,
                )

                last_ping = 0.0
                last_message = ""
                last_snapshot_key: tuple[str, int, int, int] | None = None
                last_raw_preview_key: tuple[str, int, int, int] | None = None
                while True:
                    _raise_if_canceled(cancel_event)
                    now = time.monotonic()
                    if now - last_ping >= OUTLINE_FILL_HEARTBEAT_INTERVAL_SECONDS:
                        yield sse_heartbeat()
                        last_ping = now
                    with segment_progress_lock:
                        pending_snapshots = list(segment_progress_events)
                        segment_progress_events.clear()
                    for snapshot in pending_snapshots:
                        event_name = str(snapshot.get("event") or "")
                        batch_idx = int(snapshot.get("batch_index") or 0)
                        attempt = int(snapshot.get("attempt") or 0)
                        completed_count = int(snapshot.get("completed_count") or 0)
                        snapshot_chapters = snapshot.get("chapters_snapshot")
                        snapshot_outline_md = str(snapshot.get("outline_md") or "")
                        if event_name in (
                            "batch_applied",
                            "fill_attempt_applied",
                            "fill_gap_repair_applied",
                            "fill_gap_repair_final_sweep_applied",
                        ) and isinstance(
                            snapshot_chapters, list
                        ):
                            snapshot_key = (event_name, batch_idx, attempt, completed_count)
                            if snapshot_key != last_snapshot_key:
                                yield sse_result({"outline_md": snapshot_outline_md, "chapters": snapshot_chapters})
                                last_snapshot_key = snapshot_key
                        raw_preview = str(snapshot.get("raw_output_preview") or "").strip()
                        raw_chars_raw = snapshot.get("raw_output_chars")
                        try:
                            raw_chars = int(raw_chars_raw) if raw_chars_raw is not None else len(raw_preview)
                        except Exception:
                            raw_chars = len(raw_preview)
                        if raw_preview:
                            raw_key = (event_name, batch_idx, attempt, raw_chars)
                            if raw_key != last_raw_preview_key:
                                batch_count_raw = snapshot.get("batch_count")
                                try:
                                    batch_count = int(batch_count_raw) if batch_count_raw is not None else 0
                                except Exception:
                                    batch_count = 0
                                title_parts = [event_name or "segment"]
                                if batch_idx > 0 and batch_count > 0:
                                    title_parts.append(f"batch {batch_idx}/{batch_count}")
                                elif batch_idx > 0:
                                    title_parts.append(f"batch {batch_idx}")
                                if attempt > 0:
                                    title_parts.append(f"attempt {attempt}")
                                title = " | ".join(title_parts)
                                yield sse_chunk(f"\n\n[{title}]\n{raw_preview}\n")
                                last_raw_preview_key = raw_key
                        progress_percent = snapshot.get("progress_percent")
                        if isinstance(progress_percent, int):
                            progress_num = max(10, min(98, progress_percent))
                        else:
                            progress_num = 10
                        message = _outline_segment_progress_message(snapshot)
                        if message != last_message:
                            yield sse_progress(message=message, progress=progress_num)
                            last_message = message
                    if future.done():
                        break
                    time.sleep(OUTLINE_FILL_POLL_INTERVAL_SECONDS)

                segmented = future.result()

            aggregate_run_id = _write_outline_segmented_aggregate_run(
                request_id=request_id,
                actor_user_id=user_id,
                project_id=project_id,
                run_type="outline_stream_segmented",
                llm_call=llm_call,
                prompt_system=prompt_system,
                prompt_user=prompt_user,
                prompt_render_log_json=prompt_render_log_json,
                run_params_json=run_params_json,
                data=segmented.data,
                warnings=segmented.warnings,
                parse_error=segmented.parse_error,
                segmented_run_ids=segmented.run_ids,
                meta=segmented.meta,
            )
            data = dict(segmented.data)
            warnings = _dedupe_warnings(segmented.warnings)
            if warnings:
                data["warnings"] = warnings
            if segmented.parse_error is not None:
                data["parse_error"] = segmented.parse_error
            data["generation_run_id"] = aggregate_run_id
            if segmented.run_ids:
                data["generation_sub_run_ids"] = segmented.run_ids
                data["generation_run_ids"] = [aggregate_run_id, *segmented.run_ids]
            if segmented.latency_ms > 0:
                data["latency_ms"] = segmented.latency_ms
            if segmented.dropped_params:
                data["dropped_params"] = segmented.dropped_params
            if segmented.finish_reasons:
                data["finish_reason"] = segmented.finish_reasons[-1]
                data["finish_reasons"] = segmented.finish_reasons
            data["segmented_generation"] = segmented.meta

            result_data = dict(data)
            result_data.pop("raw_output", None)
            result_data.pop("raw_json", None)
            result_data.pop("fixed_json", None)

            yield sse_progress(message="完成", progress=100, status="success")
            yield sse_result(result_data)
            yield sse_done()
            return

        yield sse_progress(message="调用模型...", progress=10)

        raw_output = ""
        generation_run_id: str | None = None
        finish_reason: str | None = None
        dropped_params: list[str] = []
        latency_ms: int | None = None
        stream_run_written = False

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

            last_progress = 10
            last_progress_ts = 0.0
            chunk_count = 0
            try:
                for delta in stream_iter:
                    raw_output += delta
                    yield sse_chunk(delta)
                    chunk_count += 1
                    if chunk_count % 12 == 0:
                        yield sse_heartbeat()
                    now = time.monotonic()
                    if now - last_progress_ts >= 0.8:
                        next_progress = 10 + int(min(1.0, len(raw_output) / 6000.0) * 80)
                        next_progress = max(last_progress, min(90, next_progress))
                        if next_progress != last_progress:
                            last_progress = next_progress
                            yield sse_progress(message="生成中...", progress=next_progress)
                        last_progress_ts = now
            finally:
                close = getattr(stream_iter, "close", None)
                if callable(close):
                    close()

            finish_reason = state.finish_reason
            dropped_params = state.dropped_params
            latency_ms = state.latency_ms

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
            generation_run_id = write_generation_run(
                request_id=request_id,
                actor_user_id=user_id,
                project_id=project_id,
                chapter_id=None,
                run_type="outline_stream",
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
            contract = contract_for_task("outline_generate")
            parsed = contract.parse(raw_output, finish_reason=finish_reason)
            data, warnings, parse_error = parsed.data, parsed.warnings, parsed.parse_error

            if parse_error is not None and llm_call.provider in (
                "openai",
                "openai_responses",
                "openai_compatible",
                "openai_responses_compatible",
            ):
                yield sse_progress(message="尝试修复 JSON...", progress=92)
                repair = build_repair_prompt_for_task("outline_generate", raw_output=raw_output)
                if repair is None:
                    warnings.append("outline_fix_json_failed")
                    repair = None
                if repair is None:
                    raise AppError(code="OUTLINE_FIX_UNSUPPORTED", message="该任务不支持输出修复", status_code=400)
                fix_system, fix_user, fix_run_type = repair
                fix_call = with_param_overrides(llm_call, {"temperature": 0, "max_tokens": 1024})
                try:
                    fixed = call_llm_and_record(
                        logger=logger,
                        request_id=request_id,
                        actor_user_id=user_id,
                        project_id=project_id,
                        chapter_id=None,
                        run_type=fix_run_type,
                        api_key=str(resolved_api_key),
                        prompt_system=fix_system,
                        prompt_user=fix_user,
                        llm_call=fix_call,
                        run_params_extra_json=run_params_extra_json,
                    )
                    fixed_parsed = contract.parse(fixed.text)
                    fixed_data, fixed_warnings, fixed_error = fixed_parsed.data, fixed_parsed.warnings, fixed_parsed.parse_error
                    if fixed_error is None and fixed_data.get("chapters"):
                        fixed_data["raw_output"] = raw_output
                        fixed_data["fixed_json"] = fixed_data.get("raw_json") or fixed.text
                        data = fixed_data
                        warnings.extend(["json_fixed_via_llm", *fixed_warnings])
                        parse_error = None
                except AppError as exc:
                    if exc.code == CANCEL_ERROR_CODE:
                        raise
                    warnings.append("outline_fix_json_failed")

            if parse_error is None:
                data, coverage_warnings = _enforce_outline_chapter_coverage(
                    data=data,
                    target_chapter_count=target_chapter_count,
                )
                warnings.extend(coverage_warnings)
                preview_outline_md = str(data.get("outline_md") or "")
                preview_chapters, _preview_warnings = _normalize_outline_chapters(data.get("chapters"))
                if preview_chapters:
                    yield sse_result({"outline_md": preview_outline_md, "chapters": _clone_outline_chapters(preview_chapters)})
                if target_chapter_count:
                    yield sse_progress(message="补全缺失章节...", progress=94)
                fill_progress_lock = threading.Lock()
                fill_progress_events: list[dict[str, object]] = []

                def _on_fill_progress(update: dict[str, object]) -> None:
                    if not isinstance(update, dict):
                        return
                    with fill_progress_lock:
                        fill_progress_events.append(dict(update))

                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    fill_future = executor.submit(
                        _fill_outline_missing_chapters_with_llm,
                        data=data,
                        target_chapter_count=target_chapter_count,
                        request_id=request_id,
                        actor_user_id=user_id,
                        project_id=project_id,
                        api_key=str(resolved_api_key),
                        llm_call=llm_call,
                        run_params_extra_json=run_params_extra_json,
                        cancel_event=cancel_event,
                        progress_hook=_on_fill_progress,
                    )

                    last_ping = 0.0
                    last_message = ""
                    last_snapshot_marker: tuple[str, int] | None = None
                    while True:
                        _raise_if_canceled(cancel_event)
                        now = time.monotonic()
                        if now - last_ping >= OUTLINE_FILL_HEARTBEAT_INTERVAL_SECONDS:
                            yield sse_heartbeat()
                            last_ping = now
                        with fill_progress_lock:
                            pending_fill_snapshots = list(fill_progress_events)
                            fill_progress_events.clear()
                        for snapshot in pending_fill_snapshots:
                            snapshot_event = str(snapshot.get("event") or "")
                            snapshot_attempt_raw = snapshot.get("attempt")
                            if isinstance(snapshot_attempt_raw, int):
                                snapshot_attempt = snapshot_attempt_raw
                            else:
                                try:
                                    snapshot_attempt = int(snapshot_attempt_raw) if snapshot_attempt_raw is not None else 0
                                except Exception:
                                    snapshot_attempt = 0
                            snapshot_chapters = snapshot.get("chapters_snapshot")
                            snapshot_marker = (snapshot_event, snapshot_attempt)
                            if (
                                snapshot_event in (
                                    "attempt_applied",
                                    "gap_repair_applied",
                                    "gap_repair_final_sweep_applied",
                                )
                                and snapshot_marker != last_snapshot_marker
                                and isinstance(snapshot_chapters, list)
                            ):
                                yield sse_result({"outline_md": preview_outline_md, "chapters": snapshot_chapters})
                                last_snapshot_marker = snapshot_marker
                            message = _outline_fill_progress_message(snapshot)
                            if message != last_message:
                                yield sse_progress(message=message, progress=94)
                                last_message = message
                        if fill_future.done():
                            break
                        time.sleep(OUTLINE_FILL_POLL_INTERVAL_SECONDS)

                    data, fill_warnings, fill_run_ids = fill_future.result()
                warnings.extend(fill_warnings)
                if fill_run_ids:
                    coverage = data.get("chapter_coverage")
                    if isinstance(coverage, dict):
                        coverage["fill_run_ids"] = fill_run_ids
                        data["chapter_coverage"] = coverage

            warnings = _dedupe_warnings(warnings)
            if warnings:
                data["warnings"] = warnings
            if parse_error is not None:
                data["parse_error"] = parse_error
            if finish_reason is not None:
                data["finish_reason"] = finish_reason
            if latency_ms is not None:
                data["latency_ms"] = latency_ms
            if dropped_params:
                data["dropped_params"] = dropped_params
            if generation_run_id is not None:
                data["generation_run_id"] = generation_run_id

            # Keep stream result payload compact to reduce client-side SSE parse failures on large outputs.
            result_data = dict(data)
            result_data.pop("raw_output", None)
            result_data.pop("raw_json", None)
            result_data.pop("fixed_json", None)

            yield sse_progress(message="完成", progress=100, status="success")
            yield sse_result(result_data)
            yield sse_done()
        except GeneratorExit:
            cancel_event.set()
            return
        except AppError as exc:
            if exc.code == CANCEL_ERROR_CODE:
                cancel_event.set()
                return
            if (
                llm_call is not None
                and not stream_run_written
            ):
                write_generation_run(
                    request_id=request_id,
                    actor_user_id=user_id,
                    project_id=project_id,
                    chapter_id=None,
                    run_type="outline_stream",
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
        except Exception:
            if llm_call is not None and not stream_run_written:
                write_generation_run(
                    request_id=request_id,
                    actor_user_id=user_id,
                    project_id=project_id,
                    chapter_id=None,
                    run_type="outline_stream",
                    provider=llm_call.provider,
                    model=llm_call.model,
                    prompt_system=prompt_system,
                    prompt_user=prompt_user,
                    prompt_render_log_json=prompt_render_log_json,
                    params_json=run_params_json,
                    output_text=raw_output or None,
                    error_json=json.dumps({"code": "INTERNAL_ERROR", "message": "服务器内部错误"}, ensure_ascii=False),
                )
                stream_run_written = True
            yield sse_error(error="服务器内部错误", code=500)
            yield sse_done()

    return create_sse_response(event_generator())
