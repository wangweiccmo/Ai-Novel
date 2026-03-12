from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.logging import exception_log_fields, log_event, redact_secrets_text
from app.db.session import SessionLocal
from app.db.utils import new_id, utc_now
from app.models.chapter import Chapter
from app.models.character import Character
from app.models.llm_preset import LLMPreset
from app.models.outline import Outline
from app.models.project import Project
from app.models.project_task import ProjectTask
from app.schemas.characters_auto_update import (
    CharactersAutoUpdateOpV1,
    CharactersAutoUpdateSchemaVersion,
    CharactersAutoUpdateV1Request,
    CharacterPatchV1,
)
from app.services.generation_service import prepare_llm_call
from app.services.json_repair_service import repair_json_once
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
from app.services.output_parsers import extract_json_value, likely_truncated_json
from app.services.project_task_event_service import emit_and_enqueue_project_task
from app.services.task_queue import get_task_queue
from app.services.search_index_service import schedule_search_rebuild_task

logger = logging.getLogger("ainovel")


CHARACTERS_AUTO_UPDATE_KIND = "characters_auto_update"
CHARACTERS_AUTO_UPDATE_SCHEMA_VERSION: CharactersAutoUpdateSchemaVersion = "characters_auto_update_v1"

_MAX_EXISTING_NAMES_IN_PROMPT = 200

# Contradiction detection: pairs of semantically opposing traits
_CONTRADICTION_PAIRS: list[tuple[str, str]] = [
    ("温和", "暴躁"), ("善良", "邪恶"), ("年轻", "年迈"), ("年轻", "老年"),
    ("高大", "矮小"), ("胆大", "胆小"), ("勇敢", "懦弱"), ("外向", "内向"),
    ("乐观", "悲观"), ("冷酷", "热情"), ("沉默", "健谈"), ("忠诚", "背叛"),
    ("温柔", "粗暴"), ("理性", "感性"), ("聪明", "愚笨"), ("自信", "自卑"),
    ("kind", "cruel"), ("young", "old"), ("tall", "short"), ("brave", "cowardly"),
    ("introverted", "extroverted"), ("optimistic", "pessimistic"),
    ("gentle", "violent"), ("loyal", "treacherous"),
]

CHARACTER_PROFILE_COMPRESS_THRESHOLD = 10


def _detect_profile_contradictions(
    existing_profile: str,
    new_profile: str,
) -> list[dict[str, str]]:
    """Detect contradicting trait descriptions between old and new profile text."""
    if not existing_profile or not new_profile:
        return []
    old_lower = existing_profile.lower()
    new_lower = new_profile.lower()
    contradictions: list[dict[str, str]] = []
    for trait_a, trait_b in _CONTRADICTION_PAIRS:
        if (trait_a in old_lower and trait_b in new_lower) or (trait_b in old_lower and trait_a in new_lower):
            contradictions.append({
                "old_trait": trait_a if trait_a in old_lower else trait_b,
                "new_trait": trait_b if trait_b in new_lower else trait_a,
            })
    return contradictions


def _record_profile_version(
    character: Character,
    new_profile: str,
    chapter_id: str | None = None,
) -> None:
    """Record a profile version snapshot before updating."""
    old_profile = (getattr(character, "profile", None) or "").strip()
    if not old_profile:
        return

    history: list[dict[str, Any]] = []
    raw = getattr(character, "profile_history_json", None)
    if raw:
        try:
            history = json.loads(raw)
            if not isinstance(history, list):
                history = []
        except Exception:
            history = []

    version = int(getattr(character, "profile_version", 0) or 0)
    history.append({
        "version": version,
        "profile": old_profile[:2000],
        "chapter_id": chapter_id,
        "timestamp": utc_now().isoformat(),
    })

    # Keep only last 20 versions to prevent unbounded growth
    if len(history) > 20:
        history = history[-20:]

    character.profile_history_json = json.dumps(history, ensure_ascii=False)
    character.profile_version = version + 1


def _compact_json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _resolve_characters_llm_call(
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
            task_key=CHARACTERS_AUTO_UPDATE_KIND,
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


def _merge_text(old: str | None, new: str | None, mode: str | None) -> str | None:
    old_s = (old or "").strip()
    new_s = (new or "").strip()
    if not new_s:
        return old_s or None

    mode_norm = str(mode or "").strip().lower() or "append_missing"
    if mode_norm == "replace":
        return new_s
    if mode_norm == "append":
        if not old_s:
            return new_s
        return f"{old_s}\n\n---\n\n{new_s}".strip()
    # default: append_missing
    return new_s if not old_s else old_s


def build_characters_auto_update_prompt_v1(
    *,
    project_id: str,
    outline_md: str | None,
    chapter_content_md: str | None,
    existing_characters: list[dict[str, str | None]],
) -> tuple[str, str]:
    """
    Prompt contract (v1):

    The model must output a single JSON object with:
    - schema_version: "characters_auto_update_v1"
    - title?: string
    - summary_md?: string
    - ops: list of {op: upsert|dedupe}
    """

    pid = str(project_id or "").strip()
    outline_text = (outline_md or "").strip()
    chapter_text = (chapter_content_md or "").strip()
    existing = [
        {"name": str(c.get("name") or "").strip() or None, "role": str(c.get("role") or "").strip() or None}
        for c in (existing_characters or [])
        if str(c.get("name") or "").strip()
    ][: _MAX_EXISTING_NAMES_IN_PROMPT]

    system = (
        "你是小说写作助手，负责把最新章节/大纲中的角色信息抽取为「角色卡」的自动更新提议。\n"
        "你必须只输出一个 JSON（允许使用 ```json 代码块包裹）。不要输出任何其它文字。\n"
        f"schema_version 必须是 {json.dumps(CHARACTERS_AUTO_UPDATE_SCHEMA_VERSION, ensure_ascii=False)}。\n"
        "ops 是一个数组，每个 op 必须是以下之一：upsert / dedupe。\n"
        "字段名必须严格使用：name / patch / merge_mode_profile / merge_mode_notes / canonical_name / duplicate_names / reason。\n"
        "严禁输出 character / characters 作为字段名；不要使用 character{...} 嵌套。\n"
        "op schema 示例：\n"
        '- upsert: {"op":"upsert","name":"Alice","patch":{"role":"...","profile":"...","notes":"..."},"merge_mode_profile":"append_missing","merge_mode_notes":"append_missing","reason":"..."}\n'
        '- dedupe: {"op":"dedupe","canonical_name":"Alice","duplicate_names":["Alice ","ALICE"],"reason":"..."}\n'
        "完整输出示例：\n"
        "{\n"
        '  "schema_version": "characters_auto_update_v1",\n'
        '  "title": "Characters Auto Update",\n'
        '  "summary_md": "可选：总结本次更新",\n'
        '  "ops": [\n'
        '    {"op":"upsert","name":"Alice","patch":{"role":"hero","profile":"...","notes":"..."},"merge_mode_profile":"append_missing","merge_mode_notes":"append_missing","reason":"..."}\n'
        "  ]\n"
        "}\n"
        "严格遵守：\n"
        "- 不要捏造不存在的角色；信息不足则宁可少写。\n"
        "- 避免重复：同一角色优先 upsert 到已有角色卡（按 name 匹配）。\n"
        "- 更新内容时默认 merge_mode_* 使用 append_missing（补全缺失信息，不覆盖已有高质量内容）。\n"
        "- profile/notes 尽量精炼、可复用；不要把整章内容粘贴进去。\n"
        "- dedupe 仅用于你确信是同一角色的重复记录（大小写/空格差异等）。\n"
        "- 尽量填写 reason：解释你为何做出 upsert/dedupe，以及你如何避免多/漏/捏造。\n"
    )

    user = (
        f"project_id: {pid}\n\n"
        "=== existing_characters (name/role) ===\n"
        f"{json.dumps(existing, ensure_ascii=False)}\n\n"
        "=== outline_md ===\n"
        f"{outline_text}\n\n"
        "=== chapter_content_md ===\n"
        f"{chapter_text}\n"
    )
    return system, user


def _normalize_name(value: str) -> str:
    return str(value or "").strip().lower()


def apply_characters_auto_update_ops(
    *,
    db: Session,
    project_id: str,
    ops: list[dict[str, Any]],
    chapter_id: str | None = None,
) -> dict[str, Any]:
    pid = str(project_id or "").strip()
    if not pid:
        return {"ok": False, "reason": "project_id_empty", "created": 0, "updated": 0, "deduped": 0, "deleted": 0, "skipped": 0}

    rows = (
        db.execute(select(Character).where(Character.project_id == pid).order_by(Character.updated_at.desc(), Character.id.desc()))
        .scalars()
        .all()
    )

    by_name: dict[str, Character] = {}
    for row in rows:
        key = _normalize_name(str(getattr(row, "name", "") or ""))
        if key and key not in by_name:
            by_name[key] = row

    created = 0
    updated = 0
    deduped = 0
    deleted = 0
    skipped: list[dict[str, Any]] = []
    contradictions: list[dict[str, Any]] = []

    for idx, raw in enumerate(ops or []):
        try:
            op = CharactersAutoUpdateOpV1.model_validate(raw)
        except Exception:
            skipped.append({"index": idx, "reason": "invalid_op_schema"})
            continue

        if op.op == "upsert":
            name = str(op.name or "").strip()
            key = _normalize_name(name)
            if not key:
                skipped.append({"index": idx, "reason": "empty_name"})
                continue

            try:
                patch = CharacterPatchV1.model_validate(op.patch)
            except Exception:
                skipped.append({"index": idx, "reason": "invalid_patch"})
                continue

            row = by_name.get(key)
            if row is None:
                row = Character(
                    id=new_id(),
                    project_id=pid,
                    name=name,
                    role=(patch.role.strip() if isinstance(patch.role, str) and patch.role.strip() else None),
                    profile=(patch.profile.strip() if isinstance(patch.profile, str) and patch.profile.strip() else None),
                    notes=(patch.notes.strip() if isinstance(patch.notes, str) and patch.notes.strip() else None),
                )
                db.add(row)
                by_name[key] = row
                created += 1
                continue

            role_new = (patch.role or "").strip()
            if role_new and not (str(getattr(row, "role", "") or "").strip()):
                row.role = role_new

            # Contradiction detection
            new_profile_text = (patch.profile or "").strip()
            existing_profile_text = (getattr(row, "profile", None) or "").strip()
            if new_profile_text and existing_profile_text:
                detected = _detect_profile_contradictions(existing_profile_text, new_profile_text)
                if detected:
                    contradictions.append({
                        "character_name": name,
                        "character_id": row.id,
                        "conflicts": detected,
                    })

            # Profile versioning before merge
            if new_profile_text and existing_profile_text and op.merge_mode_profile != "append_missing":
                _record_profile_version(row, new_profile_text, chapter_id=chapter_id)

            row.profile = _merge_text(getattr(row, "profile", None), patch.profile, op.merge_mode_profile)
            row.notes = _merge_text(getattr(row, "notes", None), patch.notes, op.merge_mode_notes)
            updated += 1
            continue

        if op.op == "dedupe":
            canonical = str(op.canonical_name or "").strip()
            canonical_key = _normalize_name(canonical)
            if not canonical_key:
                skipped.append({"index": idx, "reason": "empty_canonical_name"})
                continue

            canonical_row = by_name.get(canonical_key)
            if canonical_row is None:
                skipped.append({"index": idx, "reason": "canonical_not_found"})
                continue

            for raw_dup in op.duplicate_names or []:
                dup = str(raw_dup or "").strip()
                dup_key = _normalize_name(dup)
                if not dup_key or dup_key == canonical_key:
                    continue
                dup_row = by_name.get(dup_key)
                if dup_row is None:
                    continue

                canonical_row.role = str(getattr(canonical_row, "role", "") or "").strip() or str(getattr(dup_row, "role", "") or "").strip() or None
                canonical_row.profile = _merge_text(getattr(canonical_row, "profile", None), getattr(dup_row, "profile", None), "append_missing")
                canonical_row.notes = _merge_text(getattr(canonical_row, "notes", None), getattr(dup_row, "notes", None), "append_missing")

                db.delete(dup_row)
                deleted += 1
                deduped += 1
                by_name.pop(dup_key, None)

    # Deterministic safety net: dedupe by normalized name (case-insensitive).
    rows2 = (
        db.execute(select(Character).where(Character.project_id == pid).order_by(Character.updated_at.desc(), Character.id.desc()))
        .scalars()
        .all()
    )
    groups: dict[str, list[Character]] = {}
    for row in rows2:
        key = _normalize_name(str(getattr(row, "name", "") or ""))
        if not key:
            continue
        groups.setdefault(key, []).append(row)

    for key, group in groups.items():
        if len(group) <= 1:
            continue
        canonical_row = group[0]
        for dup_row in group[1:]:
            canonical_row.role = str(getattr(canonical_row, "role", "") or "").strip() or str(getattr(dup_row, "role", "") or "").strip() or None
            canonical_row.profile = _merge_text(getattr(canonical_row, "profile", None), getattr(dup_row, "profile", None), "append_missing")
            canonical_row.notes = _merge_text(getattr(canonical_row, "notes", None), getattr(dup_row, "notes", None), "append_missing")
            db.delete(dup_row)
            deleted += 1
            deduped += 1

    return {
        "ok": True,
        "project_id": pid,
        "created": int(created),
        "updated": int(updated),
        "deduped": int(deduped),
        "deleted": int(deleted),
        "skipped": skipped,
        "contradictions": contradictions,
    }


def characters_auto_update_v1(
    *,
    project_id: str,
    actor_user_id: str,
    request_id: str,
    chapter_id: str,
) -> dict[str, Any]:
    pid = str(project_id or "").strip()
    cid = str(chapter_id or "").strip()
    actor = str(actor_user_id or "").strip()
    req = str(request_id or "").strip() or "characters_auto_update"
    if not pid or not cid:
        return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "invalid_args"}

    db_read = SessionLocal()
    project: Project | None = None
    llm_call = None
    api_key = ""
    chapter_text = ""
    outline_text = ""
    existing_chars: list[dict[str, str | None]] = []
    try:
        project = db_read.get(Project, pid)
        if project is None:
            return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "project_not_found"}

        try:
            resolved = _resolve_characters_llm_call(db=db_read, project=project, actor_user_id=actor)
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
        if resolved is None:
            return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "llm_preset_missing"}
        llm_call, api_key = resolved

        chapter = db_read.get(Chapter, cid)
        if chapter is None or str(getattr(chapter, "project_id", "")) != pid:
            return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "chapter_not_found"}

        chapter_text = (
            str(getattr(chapter, "summary", "") or "").strip() or str(getattr(chapter, "content_md", "") or "").strip()
        )

        outline_id = getattr(project, "active_outline_id", None) if project is not None else None
        outline_row = db_read.get(Outline, str(outline_id)) if outline_id else None
        if outline_row is None:
            outline_row = (
                db_read.execute(select(Outline).where(Outline.project_id == pid).order_by(Outline.updated_at.desc()).limit(1))
                .scalars()
                .first()
            )
        if outline_row is not None:
            outline_text = str(getattr(outline_row, "content_md", "") or "").strip()

        rows = (
            db_read.execute(select(Character).where(Character.project_id == pid).order_by(Character.updated_at.desc()).limit(_MAX_EXISTING_NAMES_IN_PROMPT))
            .scalars()
            .all()
        )
        existing_chars = [{"name": str(r.name), "role": (str(r.role).strip() if r.role else None)} for r in rows if str(r.name or "").strip()]
    finally:
        db_read.close()

    if project is None or llm_call is None:
        return {"ok": False, "project_id": pid, "chapter_id": cid, "reason": "llm_preset_missing"}

    system, user = build_characters_auto_update_prompt_v1(
        project_id=pid,
        outline_md=outline_text,
        chapter_content_md=chapter_text,
        existing_characters=existing_chars,
    )

    try:
        base_max_tokens = llm_call.params.get("max_tokens")

        def _clamp_max_tokens(limit: int) -> int:
            if isinstance(base_max_tokens, int) and base_max_tokens > 0:
                return min(int(limit), int(base_max_tokens))
            return int(limit)

        retry_system = (
            system
            + "\n"
            + "【重试模式】上一轮调用失败/超时。请输出更短、更保守的更新提议：\n"
            + "- 只输出裸 JSON（不要 Markdown，不要代码块）\n"
            + "- ops 数量 <= 12；只提取本章最确定的角色与信息，不要穷举\n"
            + "- 严格遵守 schema_version 与字段名（patch/merge_mode_* 等）\n"
        )

        max_attempts = task_llm_max_attempts(default=3)
        recorded, _attempts = call_llm_and_record_with_retries(
            logger=logger,
            request_id=req,
            actor_user_id=actor,
            project_id=pid,
            chapter_id=cid,
            run_type="characters_auto_update",
            api_key=api_key,
            prompt_system=system,
            prompt_user=user,
            llm_call=llm_call,
            memory_retrieval_log_json=None,
            run_params_extra_json={"task": CHARACTERS_AUTO_UPDATE_KIND, "schema_version": CHARACTERS_AUTO_UPDATE_SCHEMA_VERSION},
            max_attempts=max_attempts,
            retry_prompt_system=retry_system,
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
            event="CHARACTERS_AUTO_UPDATE_LLM_ERROR",
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

    value, raw_json = extract_json_value(recorded.text)

    repair_schema = (
        "{\n"
        '  "schema_version": "characters_auto_update_v1",\n'
        '  "title": string | null,\n'
        '  "summary_md": string | null,\n'
        '  "ops": [\n'
        '    {\n'
        '      "op": "upsert" | "dedupe",\n'
        '      "name": string,\n'
        '      "patch": {"role": string | null, "profile": string | null, "notes": string | null},\n'
        '      "merge_mode_profile": "append_missing" | "append" | "replace" | null,\n'
        '      "merge_mode_notes": "append_missing" | "append" | "replace" | null,\n'
        '      "canonical_name": string,\n'
        '      "duplicate_names": [string],\n'
        '      "reason": string | null\n'
        "    }\n"
        "  ]\n"
        "}\n"
    )

    repair_run_id: str | None = None
    repaired = False

    if not isinstance(value, dict):
        parse_error: dict[str, Any] = {
            "code": "CHARACTERS_AUTO_UPDATE_PARSE_ERROR",
            "message": "无法从模型输出解析 characters_auto_update JSON",
        }
        if likely_truncated_json(recorded.text):
            parse_error["hint"] = "输出疑似被截断（JSON 未闭合），可尝试增大 max_tokens 或减少输出长度"

        repair_req = f"{req}:repair"
        if len(repair_req) > 64:
            repair_req = repair_req[:64]
        repair = repair_json_once(
            request_id=repair_req,
            actor_user_id=actor,
            project_id=pid,
            chapter_id=cid,
            api_key=api_key,
            llm_call=llm_call,
            raw_output=recorded.text,
            schema=repair_schema,
            expected_root="object",
            origin_run_id=recorded.run_id,
            origin_task=CHARACTERS_AUTO_UPDATE_KIND,
        )
        if bool(repair.get("ok")) and isinstance(repair.get("value"), dict):
            repaired = True
            repair_run_id = str(repair.get("repair_run_id") or "").strip() or None
            value = repair.get("value")
            raw_json = str(repair.get("raw_json") or "").strip() or raw_json
        else:
            repair_run_id = str(repair.get("repair_run_id") or "").strip() or None
            if repair_run_id:
                parse_error["repair_run_id"] = repair_run_id
            if repair.get("reason"):
                parse_error["repair_reason"] = repair.get("reason")
            if repair.get("parse_error"):
                parse_error["repair_parse_error"] = repair.get("parse_error")
            if repair.get("error_message"):
                parse_error["repair_error_message"] = repair.get("error_message")
            return {
                "ok": False,
                "project_id": pid,
                "chapter_id": cid,
                "reason": "parse_error",
                "run_id": recorded.run_id,
                "repair_run_id": repair_run_id,
                "parse_error": parse_error,
            }

    try:
        parsed = CharactersAutoUpdateV1Request.model_validate(value)
    except Exception as exc:
        parse_error: dict[str, Any] = {
            "code": "CHARACTERS_AUTO_UPDATE_PARSE_ERROR",
            "message": f"schema invalid:{type(exc).__name__}",
        }
        if raw_json:
            parse_error["raw_json"] = raw_json

        if not repaired:
            repair_req = f"{req}:repair"
            if len(repair_req) > 64:
                repair_req = repair_req[:64]
            repair = repair_json_once(
                request_id=repair_req,
                actor_user_id=actor,
                project_id=pid,
                chapter_id=cid,
                api_key=api_key,
                llm_call=llm_call,
                raw_output=str(raw_json or recorded.text),
                schema=repair_schema,
                expected_root="object",
                origin_run_id=recorded.run_id,
                origin_task=CHARACTERS_AUTO_UPDATE_KIND,
            )
            if bool(repair.get("ok")) and isinstance(repair.get("value"), dict):
                repair_run_id = str(repair.get("repair_run_id") or "").strip() or None
                value2 = repair.get("value")
                raw_json2 = str(repair.get("raw_json") or "").strip() or raw_json
                try:
                    parsed = CharactersAutoUpdateV1Request.model_validate(value2)
                    raw_json = raw_json2
                    repaired = True
                except Exception as exc2:
                    parse_error2: dict[str, Any] = {
                        "code": "CHARACTERS_AUTO_UPDATE_PARSE_ERROR",
                        "message": f"schema invalid after repair:{type(exc2).__name__}",
                    }
                    if raw_json2:
                        parse_error2["raw_json"] = raw_json2
                    if repair_run_id:
                        parse_error2["repair_run_id"] = repair_run_id
                    return {
                        "ok": False,
                        "project_id": pid,
                        "chapter_id": cid,
                        "reason": "parse_error",
                        "run_id": recorded.run_id,
                        "repair_run_id": repair_run_id,
                        "parse_error": parse_error2,
                    }
            else:
                repair_run_id = str(repair.get("repair_run_id") or "").strip() or None
                if repair_run_id:
                    parse_error["repair_run_id"] = repair_run_id
                if repair.get("reason"):
                    parse_error["repair_reason"] = repair.get("reason")
                if repair.get("parse_error"):
                    parse_error["repair_parse_error"] = repair.get("parse_error")
                if repair.get("error_message"):
                    parse_error["repair_error_message"] = repair.get("error_message")
                return {
                    "ok": False,
                    "project_id": pid,
                    "chapter_id": cid,
                    "reason": "parse_error",
                    "run_id": recorded.run_id,
                    "repair_run_id": repair_run_id,
                    "parse_error": parse_error,
                }

        if repair_run_id:
            parse_error["repair_run_id"] = repair_run_id
        return {
            "ok": False,
            "project_id": pid,
            "chapter_id": cid,
            "reason": "parse_error",
            "run_id": recorded.run_id,
            "repair_run_id": repair_run_id,
            "parse_error": parse_error,
        }

    ops_out: list[dict[str, Any]] = [dict(op.model_dump()) for op in parsed.ops]

    db_apply = SessionLocal()
    try:
        out = apply_characters_auto_update_ops(db=db_apply, project_id=pid, ops=ops_out, chapter_id=cid)
        if not bool(out.get("ok")):
            return {
                "ok": False,
                "project_id": pid,
                "chapter_id": cid,
                "run_id": recorded.run_id,
                "repair_run_id": repair_run_id,
                "reason": out.get("reason") or "apply_failed",
            }

        db_apply.commit()

        try:
            schedule_search_rebuild_task(
                db=db_apply,
                project_id=pid,
                actor_user_id=actor,
                request_id=req,
                reason="characters_auto_update",
            )
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="CHARACTERS_AUTO_UPDATE_POST_TASK_ERROR",
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
            "run_id": recorded.run_id,
            "repair_run_id": repair_run_id,
            "finish_reason": recorded.finish_reason,
            "applied": out,
        }
    except Exception as exc:
        log_event(
            logger,
            "warning",
            event="CHARACTERS_AUTO_UPDATE_APPLY_ERROR",
            project_id=pid,
            chapter_id=cid,
            error_type=type(exc).__name__,
            request_id=req,
            **exception_log_fields(exc),
        )
        safe_message = redact_secrets_text(str(exc)).replace("\n", " ").strip()
        if not safe_message:
            safe_message = type(exc).__name__
        return {
            "ok": False,
            "project_id": pid,
            "chapter_id": cid,
            "reason": "apply_failed",
            "run_id": recorded.run_id,
            "repair_run_id": repair_run_id,
            "error_type": type(exc).__name__,
            "error_message": safe_message[:400],
        }
    finally:
        db_apply.close()


def schedule_characters_auto_update_task(
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
    Fail-soft scheduler: ensure/enqueue a ProjectTask(kind=characters_auto_update).
    """

    pid = str(project_id or "").strip()
    cid = str(chapter_id or "").strip()
    if not pid or not cid:
        return None

    token_norm = str(chapter_token or "").strip() or utc_now().isoformat().replace("+00:00", "Z")
    reason_norm = str(reason or "").strip() or "dirty"
    idempotency_key = f"characters:chapter:{cid}:since:{token_norm}:v1"

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
                kind=CHARACTERS_AUTO_UPDATE_KIND,
                status="queued",
                idempotency_key=idempotency_key,
                params_json=_compact_json_dumps(
                    {
                        "reason": reason_norm,
                        "request_id": (str(request_id or "").strip() or None),
                        "chapter_id": cid,
                        "chapter_token": token_norm,
                        "triggered_at": utc_now().isoformat().replace("+00:00", "Z"),
                    }
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
