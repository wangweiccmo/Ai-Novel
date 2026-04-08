from __future__ import annotations

import re
import threading
import time
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.secrets import redact_api_keys
from app.models.chapter import Chapter
from app.models.project_settings import ProjectSettings
from app.models.story_memory import StoryMemory
from app.models.structured_memory import MemoryEntity, MemoryEvent, MemoryForeshadow, MemoryRelation
from app.schemas.memory_pack import MemoryContextPackOut
from app.services.fractal_memory_service import enrich_fractal_context_for_query, get_fractal_context
from app.services.graph_context_service import query_graph_context
from app.services.memory_dedup_service import deduplicate_memory_sections
from app.services.prompt_budget import estimate_tokens
from app.services.table_context_service import build_tables_context_text_md
from app.services.token_budget_allocator import allocate_memory_budgets, BudgetAllocation
from app.services.vector_rerank_overrides import vector_rerank_overrides
from app.services.vector_embedding_overrides import vector_embedding_overrides
from app.services.vector_rag_service import query_project, vector_rag_status
from app.services.worldbook_service import preview_worldbook_trigger


_MEMORY_TEXT_MD_CHAR_LIMIT = 6000
_TRUNCATION_MARK = "\n…(truncated)\n"
_ALLOWED_SECTIONS = {
    "worldbook",
    "story_memory",
    "semantic_history",
    "foreshadow_open_loops",
    "structured",
    "tables",
    "vector_rag",
    "graph",
    "fractal",
}
_MAX_BUDGET_CHAR_LIMIT = 50000

# ── Process-level cache for ProjectSettings (TTL 30s) ──────────────
_SETTINGS_CACHE_TTL = 30.0
_settings_cache: dict[str, tuple[float, ProjectSettings | None]] = {}
_settings_cache_lock = threading.Lock()


def _get_project_settings_cached(db: Session, project_id: str) -> ProjectSettings | None:
    """Fetch ProjectSettings with a process-level TTL cache (30s).

    ProjectSettings changes rarely (only on explicit user edits), so caching
    avoids repeated DB round-trips within the same generation pipeline.
    """
    now = time.monotonic()
    with _settings_cache_lock:
        entry = _settings_cache.get(project_id)
        if entry is not None:
            ts, cached = entry
            if now - ts < _SETTINGS_CACHE_TTL:
                return cached

    row = db.get(ProjectSettings, project_id)
    with _settings_cache_lock:
        _settings_cache[project_id] = (now, row)
    return row


def invalidate_project_settings_cache(project_id: str | None = None) -> None:
    """Call when ProjectSettings is updated to clear the cache."""
    with _settings_cache_lock:
        if project_id is None:
            _settings_cache.clear()
        else:
            _settings_cache.pop(project_id, None)


def _clamp_char_limit(value: object, *, default: int) -> int:
    try:
        raw = int(value)  # type: ignore[arg-type]
    except Exception:
        return int(default)
    if raw < 0:
        return int(default)
    return max(0, min(int(raw), int(_MAX_BUDGET_CHAR_LIMIT)))


def _unwrap_text_md_block(*, text_md: str, tag: str) -> str:
    prefix = f"<{tag}>\n"
    suffix = f"\n</{tag}>"
    if text_md.startswith(prefix) and text_md.endswith(suffix):
        return text_md[len(prefix) : -len(suffix)]
    return text_md


def _wrap_block_with_inner_limit(*, tag: str, inner: str, char_limit: int, ellipsis: bool) -> tuple[str, bool]:
    prefix = f"<{tag}>\n"
    suffix = f"\n</{tag}>"

    body = (inner or "").strip()
    if not body:
        return "", False

    truncated = False
    if char_limit >= 0 and len(body) > char_limit:
        body = body[:char_limit].rstrip()
        if ellipsis and body:
            body = body + "…"
        truncated = True

    return f"{prefix}{body}{suffix}", truncated


def _vector_rerank_config(*, settings_row: ProjectSettings | None) -> dict[str, object]:
    return vector_rerank_overrides(settings_row)


def _wrap_and_truncate_block(*, tag: str, inner: str, char_limit: int) -> tuple[str, bool]:
    prefix = f"<{tag}>\n"
    suffix = f"\n</{tag}>"

    body = (inner or "").strip()
    if not body:
        return "", False

    raw = f"{prefix}{body}{suffix}"
    if char_limit <= 0 or len(raw) <= char_limit:
        return raw, False

    budget = max(0, int(char_limit) - len(prefix) - len(suffix))
    if budget <= 0:
        return "", True

    marker = _TRUNCATION_MARK
    if budget <= len(marker):
        clipped_inner = marker[:budget]
    else:
        clipped_inner = body[: max(0, budget - len(marker))].rstrip() + marker
    clipped = f"{prefix}{clipped_inner}{suffix}"
    if len(clipped) > char_limit:
        clipped = clipped[:char_limit]
    return clipped, True


def _format_story_memory_text_md(*, memories: list[StoryMemory], char_limit: int) -> tuple[str, bool]:
    parts: list[str] = []
    for m in memories:
        mem_type = str(m.memory_type or "").strip() or "memory"
        title = str(m.title or "").strip() or "Untitled"
        content = str(m.content or "").strip()
        if len(content) > 800:
            content = content[:800].rstrip() + "…"
        parts.append(f"### [{mem_type}] {title}\n{content}".rstrip())
    return _wrap_and_truncate_block(tag="StoryMemory", inner="\n\n".join(parts), char_limit=char_limit)


def _format_semantic_history_text_md(
    *,
    memories: list[StoryMemory],
    chapters_by_id: dict[str, Chapter],
    char_limit: int,
) -> tuple[str, bool]:
    parts: list[str] = []
    for m in memories:
        chapter_id = str(m.chapter_id or "").strip()
        chapter = chapters_by_id.get(chapter_id) if chapter_id else None
        title = str(getattr(chapter, "title", "") or "").strip() or "Untitled"
        number = getattr(chapter, "number", None)
        try:
            number_int = int(number) if number is not None else None
        except Exception:
            number_int = None

        header = f"第 {number_int} 章：{title}".strip("：") if number_int is not None else f"章节：{title}".strip("：")
        content = str(m.content or "").strip()
        if len(content) > 1000:
            content = content[:1000].rstrip() + "…"
        parts.append(f"### {header}\n{content}".rstrip())
    return _wrap_and_truncate_block(tag="SemanticHistory", inner="\n\n".join(parts), char_limit=char_limit)


FORESHADOW_OVERDUE_CHAPTER_THRESHOLD = 15


def _format_foreshadow_open_loops_text_md(
    *,
    foreshadows: list[StoryMemory],
    char_limit: int,
    current_chapter_number: int = 0,
) -> tuple[str, bool]:
    parts: list[str] = []
    for m in foreshadows:
        title = str(m.title or "").strip() or "Untitled"
        content = str(m.content or "").strip()
        if len(content) > 800:
            content = content[:800].rstrip() + "…"
        # Overdue warning for foreshadows open too long
        overdue_tag = ""
        if current_chapter_number > 0:
            planted_at = int(m.story_timeline or 0)
            if planted_at > 0:
                gap = current_chapter_number - planted_at
                if gap >= FORESHADOW_OVERDUE_CHAPTER_THRESHOLD:
                    overdue_tag = f" ⚠[警告：此伏笔已超过{gap}章未兑现，请考虑在近期章节中回收]"
        parts.append(f"### {title}{overdue_tag}\n{content}".rstrip())
    return _wrap_and_truncate_block(tag="ForeshadowOpenLoops", inner="\n\n".join(parts), char_limit=char_limit)


def _extract_query_tokens(query_text: str, *, limit: int) -> list[str]:
    q = (query_text or "").strip()
    if not q:
        return []
    tokens = [t.strip() for t in re.split(r"[^0-9A-Za-z\u4e00-\u9fff]+", q) if t and t.strip()]
    out: list[str] = []
    seen: set[str] = set()
    for t in tokens:
        if len(t) < 2:
            continue
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
        if len(out) >= int(limit):
            break
    return out


def _format_structured_text_md(
    *,
    entities: list[MemoryEntity],
    relations: list[dict[str, Any]],
    events: list[MemoryEvent],
    foreshadows: list[MemoryForeshadow],
    char_limit: int,
) -> tuple[str, bool]:
    sections: list[str] = []
    if entities:
        lines = []
        for e in entities:
            name = str(e.name or "").strip()
            if not name:
                continue
            entity_type = str(e.entity_type or "").strip() or "generic"
            summary = str(e.summary_md or "").strip()
            if len(summary) > 300:
                summary = summary[:300].rstrip() + "…"
            lines.append(f"- [{entity_type}] {name}{f': {summary}' if summary else ''}".rstrip())
        if lines:
            sections.append("## Entities\n" + "\n".join(lines))
    if relations:
        lines = []
        for r in relations:
            from_name = str(r.get("from_name") or "").strip() or str(r.get("from_entity_id") or "")
            to_name = str(r.get("to_name") or "").strip() or str(r.get("to_entity_id") or "")
            rel_type = str(r.get("relation_type") or "").strip() or "related_to"
            desc = str(r.get("description_md") or "").strip()
            if len(desc) > 240:
                desc = desc[:240].rstrip() + "…"
            lines.append(f"- {from_name} --({rel_type})--> {to_name}{f': {desc}' if desc else ''}".rstrip())
        if lines:
            sections.append("## Relations\n" + "\n".join(lines))
    if events:
        lines = []
        for ev in events:
            title = str(ev.title or "").strip() or "Untitled"
            content = str(ev.content_md or "").strip()
            if len(content) > 320:
                content = content[:320].rstrip() + "…"
            lines.append(f"- {title}{f': {content}' if content else ''}".rstrip())
        if lines:
            sections.append("## Events\n" + "\n".join(lines))
    if foreshadows:
        lines = []
        for f in foreshadows:
            title = str(f.title or "").strip() or "Untitled"
            content = str(f.content_md or "").strip()
            if len(content) > 320:
                content = content[:320].rstrip() + "…"
            resolved = bool(getattr(f, "resolved", 0))
            status = str(getattr(f, "status", "") or "").strip() or ("resolved" if resolved else "open")
            status_tag = f"[{status}] " if status != "open" else ""
            lines.append(f"- {status_tag}{title}{f': {content}' if content else ''}".rstrip())
        if lines:
            sections.append("## Foreshadows\n" + "\n".join(lines))

    return _wrap_and_truncate_block(tag="StructuredMemory", inner="\n\n".join(sections), char_limit=char_limit)


def retrieve_memory_context_pack(
    *,
    db: Session,
    project_id: str,
    query_text: str = "",
    include_deleted: bool = False,
    section_enabled: dict[str, bool] | None = None,
    budget_overrides: dict[str, int] | None = None,
    current_chapter_number: int = 0,
) -> MemoryContextPackOut:
    """
    Must be safe when memory dependencies (vector DB / embeddings / etc.) are missing.
    """
    enabled_map = section_enabled or {}
    budgets_raw = budget_overrides or {}
    budgets = {str(k): v for k, v in budgets_raw.items() if str(k) in _ALLOWED_SECTIONS}
    worldbook_enabled = bool(enabled_map.get("worldbook", True))
    story_memory_enabled = bool(enabled_map.get("story_memory", True))
    semantic_history_enabled = bool(enabled_map.get("semantic_history", False))
    foreshadow_open_loops_enabled = bool(enabled_map.get("foreshadow_open_loops", False))
    structured_enabled = bool(enabled_map.get("structured", True))
    tables_enabled = bool(enabled_map.get("tables", False))
    vector_rag_enabled = bool(enabled_map.get("vector_rag", True))
    graph_enabled = bool(enabled_map.get("graph", True))
    fractal_enabled = bool(enabled_map.get("fractal", True)) and bool(getattr(settings, "fractal_enabled", True))

    # ── Request-scoped: fetch ProjectSettings once for the entire call ──
    _project_settings = _get_project_settings_cached(db, project_id)

    # --- Global token budget allocation (P0 optimization) ---
    # Use the allocator to distribute a shared token pool across sections
    # instead of independent per-section char limits.
    _enabled_sections = {
        "worldbook": worldbook_enabled,
        "story_memory": story_memory_enabled,
        "semantic_history": semantic_history_enabled,
        "foreshadow_open_loops": foreshadow_open_loops_enabled,
        "structured": structured_enabled,
        "tables": tables_enabled,
        "vector_rag": vector_rag_enabled,
        "graph": graph_enabled,
        "fractal": fractal_enabled,
    }
    _budget_allocation = allocate_memory_budgets(
        enabled_sections=_enabled_sections,
        budget_overrides_chars=budgets if budgets else None,
    )

    worldbook_budget = _budget_allocation.char_limit_for("worldbook") or 12000
    story_memory_budget = _budget_allocation.char_limit_for("story_memory") or _MEMORY_TEXT_MD_CHAR_LIMIT
    semantic_history_budget = _budget_allocation.char_limit_for("semantic_history") or _MEMORY_TEXT_MD_CHAR_LIMIT
    foreshadow_open_loops_budget = _budget_allocation.char_limit_for("foreshadow_open_loops") or _MEMORY_TEXT_MD_CHAR_LIMIT
    structured_budget = _budget_allocation.char_limit_for("structured") or _MEMORY_TEXT_MD_CHAR_LIMIT
    tables_budget = _budget_allocation.char_limit_for("tables") or _MEMORY_TEXT_MD_CHAR_LIMIT
    vector_rag_budget = _budget_allocation.char_limit_for("vector_rag") or int(getattr(settings, "vector_final_char_limit", 6000) or 6000)
    graph_budget = _budget_allocation.char_limit_for("graph") or 6000
    fractal_budget = _budget_allocation.char_limit_for("fractal") or int(getattr(settings, "fractal_char_limit", 6000) or 6000)

    if worldbook_enabled:
        worldbook_preview = preview_worldbook_trigger(
            db=db,
            project_id=project_id,
            query_text=query_text,
            include_constant=True,
            enable_recursion=True,
            char_limit=int(worldbook_budget),
        )
        worldbook = {**worldbook_preview.model_dump(), "enabled": True, "disabled_reason": None}
        if not isinstance(worldbook.get("text_md"), str):
            worldbook["text_md"] = str(worldbook_preview.text_md or "")
        triggered = worldbook.get("triggered")
        if isinstance(triggered, list):
            for t in triggered:
                if not isinstance(t, dict):
                    continue
                reason = str(t.get("reason") or "").strip()
                if reason == "constant":
                    t["match_source"] = "constant"
                    t["match_value"] = None
                    continue
                if ":" in reason:
                    src, value = reason.split(":", 1)
                    src = src.strip()
                    value = value.strip()
                    if src:
                        t["match_source"] = src
                        t["match_value"] = value or None
    else:
        worldbook = {"enabled": False, "disabled_reason": "disabled", "triggered": [], "text_md": "", "truncated": False}

    story_memory: dict[str, Any] = {"enabled": False, "disabled_reason": "empty", "items": [], "text_md": ""}
    if not story_memory_enabled:
        story_memory = {"enabled": False, "disabled_reason": "disabled", "items": [], "text_md": ""}
    else:
        try:
            limit_plus_one = 41
            tokens = _extract_query_tokens(query_text, limit=6)
            stmt = (
                select(StoryMemory)
                .where(StoryMemory.project_id == project_id)
                .order_by(StoryMemory.importance_score.desc(), StoryMemory.updated_at.desc())
            )
            if tokens:
                conds = []
                for t in tokens:
                    like_term = f"%{t}%"
                    conds.append(StoryMemory.content.like(like_term))
                    conds.append(StoryMemory.title.like(like_term))
                filtered = db.execute(stmt.where(or_(*conds)).limit(limit_plus_one)).scalars().all()
                rows = filtered if filtered else db.execute(stmt.limit(limit_plus_one)).scalars().all()
            else:
                rows = db.execute(stmt.limit(limit_plus_one)).scalars().all()
            truncated = len(rows) > (limit_plus_one - 1)
            rows = rows[: limit_plus_one - 1]
            enabled = bool(rows)
            items = []
            for m in rows[:20]:
                items.append(
                    {
                        "id": m.id,
                        "chapter_id": m.chapter_id,
                        "memory_type": m.memory_type,
                        "title": m.title,
                        "importance_score": float(m.importance_score or 0.0),
                        "story_timeline": int(m.story_timeline or 0),
                        "is_foreshadow": bool(m.is_foreshadow),
                        "content_preview": (str(m.content or "").strip()[:200] + "…")
                        if len(str(m.content or "").strip()) > 200
                        else str(m.content or "").strip(),
                    }
                )
            text_md, text_truncated = _format_story_memory_text_md(
                memories=rows[:12], char_limit=int(story_memory_budget)
            )
            story_memory = {
                "enabled": enabled,
                "disabled_reason": None if enabled else "empty",
                "query_text": query_text,
                "filter_tokens": tokens,
                "items": items,
                "truncated": bool(truncated or text_truncated),
                "text_md": text_md,
            }
        except Exception:
            story_memory = {
                "enabled": False,
                "disabled_reason": "error",
                "items": [],
                "text_md": "",
                "error": "story_memory_query_failed",
            }

    vector_query_text = (query_text or "").strip()
    embedding_overrides = vector_embedding_overrides(_project_settings)
    rerank_config = _vector_rerank_config(settings_row=_project_settings)

    semantic_history: dict[str, Any] = {"enabled": False, "disabled_reason": "empty", "items": [], "text_md": ""}
    if not semantic_history_enabled:
        semantic_history = {"enabled": False, "disabled_reason": "disabled", "items": [], "text_md": ""}
    elif not vector_query_text:
        semantic_history = {"enabled": False, "disabled_reason": "empty_query", "items": [], "text_md": "", "query_text": ""}
    else:
        vector_out: dict[str, Any] | None = None
        try:
            out = query_project(
                project_id=project_id,
                query_text=vector_query_text,
                sources=["story_memory"],
                embedding=embedding_overrides,
                rerank=rerank_config,
            )
            vector_out = out if isinstance(out, dict) else None
        except Exception as exc:
            vector_out = vector_rag_status(
                project_id=project_id,
                sources=["story_memory"],
                embedding=embedding_overrides,
                rerank=rerank_config,
            )
            vector_out["enabled"] = False
            vector_out["disabled_reason"] = "error"
            vector_out["query_text"] = vector_query_text
            vector_out["error"] = f"semantic_history_vector_query_failed:{type(exc).__name__}"

        if not vector_out or not bool(vector_out.get("enabled")):
            semantic_history = {
                "enabled": False,
                "disabled_reason": (vector_out or {}).get("disabled_reason") or "vector_disabled",
                "items": [],
                "text_md": "",
                "query_text": vector_query_text,
            }
        else:
            candidates = vector_out.get("candidates") if isinstance(vector_out.get("candidates"), list) else []
            picked_memory_ids: list[str] = []
            seen: set[str] = set()
            for c in candidates:
                if not isinstance(c, dict):
                    continue
                meta = c.get("metadata") if isinstance(c.get("metadata"), dict) else {}
                if str(meta.get("source") or "") != "story_memory":
                    continue
                if str(meta.get("memory_type") or "").strip() != "chapter_summary":
                    continue
                mem_id = str(meta.get("source_id") or "").strip()
                chapter_id = str(meta.get("chapter_id") or "").strip()
                if not mem_id or not chapter_id:
                    continue
                if mem_id in seen:
                    continue
                seen.add(mem_id)
                picked_memory_ids.append(mem_id)
                if len(picked_memory_ids) >= 8:
                    break

            if not picked_memory_ids:
                has_any_summary = (
                    db.execute(
                        select(StoryMemory.id)
                        .where(StoryMemory.project_id == project_id)
                        .where(StoryMemory.memory_type == "chapter_summary")
                        .limit(1)
                    ).first()
                    is not None
                )
                semantic_history = {
                    "enabled": False,
                    "disabled_reason": "index_not_built" if has_any_summary else "empty",
                    "items": [],
                    "hits": 0,
                    "query_text": vector_query_text,
                    "text_md": "",
                }
            else:
                mem_rows = (
                    db.execute(select(StoryMemory).where(StoryMemory.id.in_(picked_memory_ids))).scalars().all()
                )
                by_id = {str(m.id): m for m in mem_rows}
                memories = [by_id[mid] for mid in picked_memory_ids if mid in by_id]

                chapter_ids = [str(m.chapter_id) for m in memories if m.chapter_id]
                chapter_rows = db.execute(select(Chapter).where(Chapter.id.in_(chapter_ids))).scalars().all() if chapter_ids else []
                chapters_by_id = {str(c.id): c for c in chapter_rows}

                items: list[dict[str, Any]] = []
                for m in memories[:6]:
                    chapter_id = str(m.chapter_id or "").strip() or None
                    chapter = chapters_by_id.get(str(chapter_id or "")) if chapter_id else None
                    title = str(getattr(chapter, "title", "") or "").strip() or None
                    number = getattr(chapter, "number", None)
                    try:
                        number_int = int(number) if number is not None else None
                    except Exception:
                        number_int = None
                    items.append(
                        {
                            "story_memory_id": m.id,
                            "chapter_id": chapter_id,
                            "chapter_number": number_int,
                            "chapter_title": title,
                            "story_timeline": int(m.story_timeline or 0),
                        }
                    )

                text_md, text_truncated = _format_semantic_history_text_md(
                    memories=memories[:6],
                    chapters_by_id=chapters_by_id,
                    char_limit=int(semantic_history_budget),
                )
                semantic_history = {
                    "enabled": bool(memories),
                    "disabled_reason": None if memories else "empty",
                    "query_text": vector_query_text,
                    "hits": len(memories[:6]),
                    "items": items,
                    "truncated": bool(text_truncated),
                    "text_md": text_md,
                }
                semantic_history["text_chars"] = len(str(text_md or ""))

    foreshadow_open_loops: dict[str, Any] = {"enabled": False, "disabled_reason": "empty", "items": [], "text_md": ""}
    if not foreshadow_open_loops_enabled:
        foreshadow_open_loops = {"enabled": False, "disabled_reason": "disabled", "items": [], "text_md": ""}
    else:
        try:
            limit_plus_one = 41
            rows = (
                db.execute(
                    select(StoryMemory)
                    .where(StoryMemory.project_id == project_id)
                    .where(StoryMemory.is_foreshadow == 1)  # noqa: E712
                    .where(StoryMemory.foreshadow_resolved_at_chapter_id.is_(None))
                    .order_by(StoryMemory.story_timeline.desc(), StoryMemory.importance_score.desc(), StoryMemory.updated_at.desc())
                    .limit(limit_plus_one)
                )
                .scalars()
                .all()
            )
            truncated = len(rows) > (limit_plus_one - 1)
            rows = rows[: limit_plus_one - 1]

            items: list[dict[str, Any]] = []
            for m in rows[:20]:
                content = str(m.content or "").strip()
                preview = (content[:200].rstrip() + "…") if len(content) > 200 else content
                items.append(
                    {
                        "id": m.id,
                        "chapter_id": m.chapter_id,
                        "memory_type": m.memory_type,
                        "title": m.title,
                        "importance_score": float(m.importance_score or 0.0),
                        "story_timeline": int(m.story_timeline or 0),
                        "content_preview": preview,
                    }
                )

            text_md, text_truncated = _format_foreshadow_open_loops_text_md(
                foreshadows=rows[:12],
                char_limit=int(foreshadow_open_loops_budget),
                current_chapter_number=current_chapter_number,
            )
            enabled = bool(rows)
            foreshadow_open_loops = {
                "enabled": enabled,
                "disabled_reason": None if enabled else "empty",
                "open_count": len(rows),
                "items": items,
                "truncated": bool(truncated or text_truncated),
                "text_md": text_md,
            }
            foreshadow_open_loops["text_chars"] = len(str(text_md or ""))
        except Exception:
            foreshadow_open_loops = {
                "enabled": False,
                "disabled_reason": "error",
                "items": [],
                "text_md": "",
                "error": "foreshadow_open_loops_query_failed",
            }

    structured: dict[str, Any] = {"enabled": False, "disabled_reason": "empty", "counts": {}, "text_md": ""}
    if not structured_enabled:
        structured = {"enabled": False, "disabled_reason": "disabled", "counts": {}, "text_md": ""}
    else:
        try:
            entities_stmt = select(MemoryEntity).where(MemoryEntity.project_id == project_id)
            relations_stmt = select(MemoryRelation).where(MemoryRelation.project_id == project_id)
            events_stmt = select(MemoryEvent).where(MemoryEvent.project_id == project_id)
            foreshadows_stmt = select(MemoryForeshadow).where(MemoryForeshadow.project_id == project_id)

            if not include_deleted:
                entities_stmt = entities_stmt.where(MemoryEntity.deleted_at.is_(None))
                relations_stmt = relations_stmt.where(MemoryRelation.deleted_at.is_(None))
                events_stmt = events_stmt.where(MemoryEvent.deleted_at.is_(None))
                foreshadows_stmt = foreshadows_stmt.where(MemoryForeshadow.deleted_at.is_(None))

            entities = db.execute(entities_stmt.order_by(MemoryEntity.updated_at.desc()).limit(21)).scalars().all()
            relations = db.execute(relations_stmt.order_by(MemoryRelation.updated_at.desc()).limit(41)).scalars().all()
            events = db.execute(events_stmt.order_by(MemoryEvent.updated_at.desc()).limit(21)).scalars().all()
            foreshadows = db.execute(foreshadows_stmt.order_by(MemoryForeshadow.updated_at.desc()).limit(21)).scalars().all()
            enabled = bool(entities or relations or events or foreshadows)

            # Build entity name map from already-fetched entities to avoid extra query
            rel_entity_ids: set[str] = set()
            for r in relations[:40]:
                rel_entity_ids.add(str(r.from_entity_id))
                rel_entity_ids.add(str(r.to_entity_id))
            name_by_id = {str(e.id): str(e.name or "") for e in entities if str(e.id) in rel_entity_ids}
            # Only fetch missing entity names not in the initial 21-row batch
            missing_ids = rel_entity_ids - set(name_by_id.keys())
            if missing_ids:
                extra_name_stmt = (
                    select(MemoryEntity.id, MemoryEntity.name)
                    .where(MemoryEntity.project_id == project_id)
                    .where(MemoryEntity.id.in_(list(missing_ids)))
                )
                if not include_deleted:
                    extra_name_stmt = extra_name_stmt.where(MemoryEntity.deleted_at.is_(None))
                for eid, ename in db.execute(extra_name_stmt).all():
                    name_by_id[str(eid)] = str(ename or "")
            relations_preview = []
            for r in relations[:40]:
                relations_preview.append(
                    {
                        "id": r.id,
                        "from_entity_id": r.from_entity_id,
                        "to_entity_id": r.to_entity_id,
                        "from_name": name_by_id.get(str(r.from_entity_id)) or "",
                        "to_name": name_by_id.get(str(r.to_entity_id)) or "",
                        "relation_type": r.relation_type,
                        "description_md": r.description_md,
                    }
                )

            text_md, text_truncated = _format_structured_text_md(
                entities=entities[:20],
                relations=relations_preview,
                events=events[:20],
                foreshadows=foreshadows[:20],
                char_limit=int(structured_budget),
            )
            structured = {
                "enabled": enabled,
                "disabled_reason": None if enabled else "empty",
                "include_deleted": bool(include_deleted),
                "counts": {
                    "entities": len(entities[:20]),
                    "relations": len(relations[:40]),
                    "events": len(events[:20]),
                    "foreshadows": len(foreshadows[:20]),
                },
                "truncated": bool(
                    len(entities) > 20
                    or len(relations) > 40
                    or len(events) > 20
                    or len(foreshadows) > 20
                    or text_truncated
                ),
                "text_md": text_md,
            }
        except Exception:
            structured = {
                "enabled": False,
                "disabled_reason": "error",
                "counts": {},
                "text_md": "",
                "error": "structured_query_failed",
            }

    tables: dict[str, Any] = {"enabled": False, "disabled_reason": "empty", "counts": {"tables": 0, "rows": 0}, "text_md": ""}
    if not tables_enabled:
        tables = {"enabled": False, "disabled_reason": "disabled", "counts": {"tables": 0, "rows": 0}, "text_md": ""}
    else:
        try:
            tables = build_tables_context_text_md(db=db, project_id=project_id, char_limit=int(tables_budget))
        except Exception:
            tables = {
                "enabled": False,
                "disabled_reason": "error",
                "counts": {"tables": 0, "rows": 0},
                "text_md": "",
                "error": "tables_query_failed",
            }

    graph = query_graph_context(db=db, project_id=project_id, query_text=query_text, enabled=graph_enabled)
    if isinstance(graph, dict):
        pb = graph.get("prompt_block") if isinstance(graph.get("prompt_block"), dict) else {}
        if "graph" in budgets and isinstance(pb, dict):
            inner = _unwrap_text_md_block(text_md=str(pb.get("text_md") or ""), tag="GraphContext")
            clipped, was_truncated = _wrap_and_truncate_block(tag="GraphContext", inner=inner, char_limit=int(graph_budget))
            pb = dict(pb)
            pb["text_md"] = clipped
            pb["truncated"] = bool(pb.get("truncated") or was_truncated)
            pb["char_limit"] = int(graph_budget)
            pb["original_chars"] = int(pb.get("original_chars") or len(str(pb.get("text_md") or "")))
            graph["prompt_block"] = pb
        graph["text_md"] = str(pb.get("text_md") or "")

    try:
        if not vector_rag_enabled:
            vector_rag = vector_rag_status(project_id=project_id, embedding=embedding_overrides, rerank=rerank_config)
            vector_rag["enabled"] = False
            vector_rag["disabled_reason"] = "disabled"
            vector_rag["query_text"] = vector_query_text
        elif vector_query_text:
            vector_rag = query_project(
                project_id=project_id, query_text=vector_query_text, embedding=embedding_overrides, rerank=rerank_config
            )
        else:
            vector_rag = vector_rag_status(project_id=project_id, embedding=embedding_overrides, rerank=rerank_config)
    except Exception as exc:
        vector_rag = vector_rag_status(project_id=project_id, embedding=embedding_overrides, rerank=rerank_config)
        vector_rag["enabled"] = False
        vector_rag["disabled_reason"] = "error"
        vector_rag["query_text"] = vector_query_text
        vector_rag["error"] = f"vector_query_failed:{type(exc).__name__}"
    if isinstance(vector_rag, dict):
        vector_rag["query_text"] = vector_query_text
        pb = vector_rag.get("prompt_block") if isinstance(vector_rag.get("prompt_block"), dict) else {}
        text_md = str(pb.get("text_md") or "")
        if "vector_rag" in budgets and text_md:
            inner = _unwrap_text_md_block(text_md=text_md, tag="VECTOR_RAG")
            clipped, was_truncated = _wrap_block_with_inner_limit(
                tag="VECTOR_RAG", inner=inner, char_limit=int(vector_rag_budget), ellipsis=False
            )
            text_md = clipped
            pb = dict(pb) if isinstance(pb, dict) else {}
            pb["text_md"] = text_md
            vector_rag["prompt_block"] = pb
            final = vector_rag.get("final") if isinstance(vector_rag.get("final"), dict) else None
            if isinstance(final, dict):
                final = dict(final)
                final["text_md"] = text_md
                if was_truncated:
                    final["truncated"] = True
                vector_rag["final"] = final
        vector_rag["text_md"] = text_md

    fractal = get_fractal_context(db=db, project_id=project_id, enabled=fractal_enabled)
    if isinstance(fractal, dict):
        if str(query_text or "").strip():
            fractal = enrich_fractal_context_for_query(
                fractal_context=fractal,
                query_text=query_text,
                max_hits=max(1, int(getattr(settings, "fractal_long_retrieval_hits", 3) or 3)),
                char_limit_override=int(fractal_budget),
            )
        pb = fractal.get("prompt_block") if isinstance(fractal.get("prompt_block"), dict) else {}
        text_md = str(pb.get("text_md") or "")
        if "fractal" in budgets and text_md:
            inner = _unwrap_text_md_block(text_md=text_md, tag="FractalMemory")
            clipped, was_truncated = _wrap_block_with_inner_limit(
                tag="FractalMemory", inner=inner, char_limit=int(fractal_budget), ellipsis=True
            )
            text_md = clipped
            pb = dict(pb) if isinstance(pb, dict) else {}
            pb["text_md"] = text_md
            fractal["prompt_block"] = pb
            fractal["truncated"] = bool(fractal.get("truncated") or was_truncated)
        fractal["text_md"] = text_md

    worldbook_triggered = worldbook.get("triggered") if isinstance(worldbook, dict) else None
    worldbook_triggered_list = worldbook_triggered if isinstance(worldbook_triggered, list) else []
    worldbook_triggered_sample: list[dict[str, Any]] = []
    for t in worldbook_triggered_list[:10]:
        if not isinstance(t, dict):
            continue
        title = t.get("title")
        reason = t.get("reason")
        worldbook_triggered_sample.append({"title": title, "reason": reason})

    logs: list[dict[str, Any]] = [
        {
            "section": "worldbook",
            "enabled": bool(worldbook.get("enabled")),
            "disabled_reason": worldbook.get("disabled_reason"),
            "note": "preview_worldbook_trigger",
            "triggered_count": len(worldbook_triggered_list),
            "triggered_sample": worldbook_triggered_sample,
            "token_estimate": estimate_tokens(str(worldbook.get("text_md") or "")),
            "truncated": bool(worldbook.get("truncated")) if "truncated" in worldbook else None,
            "budget_char_limit": int(worldbook_budget),
            "budget_source": "override" if "worldbook" in budgets else "default",
        },
        {
            "section": "story_memory",
            "enabled": bool(story_memory.get("enabled")),
            "disabled_reason": story_memory.get("disabled_reason"),
            "note": "story_memories (top by importance)",
            "token_estimate": estimate_tokens(str(story_memory.get("text_md") or "")),
            "truncated": bool(story_memory.get("truncated")) if "truncated" in story_memory else None,
            "budget_char_limit": int(story_memory_budget),
            "budget_source": "override" if "story_memory" in budgets else "default",
        },
        {
            "section": "semantic_history",
            "enabled": bool(semantic_history.get("enabled")),
            "disabled_reason": semantic_history.get("disabled_reason"),
            "note": "vector_rag_service.query_project(source=story_memory,memory_type=chapter_summary)",
            "hits": int(semantic_history.get("hits") or 0),
            "text_chars": int(semantic_history.get("text_chars") or len(str(semantic_history.get("text_md") or ""))),
            "token_estimate": estimate_tokens(str(semantic_history.get("text_md") or "")),
            "truncated": bool(semantic_history.get("truncated")) if "truncated" in semantic_history else None,
            "budget_char_limit": int(semantic_history_budget),
            "budget_source": "override" if "semantic_history" in budgets else "default",
        },
        {
            "section": "foreshadow_open_loops",
            "enabled": bool(foreshadow_open_loops.get("enabled")),
            "disabled_reason": foreshadow_open_loops.get("disabled_reason"),
            "note": "story_memories (is_foreshadow=1 AND resolved_at IS NULL)",
            "open_count": int(foreshadow_open_loops.get("open_count") or 0),
            "text_chars": int(foreshadow_open_loops.get("text_chars") or len(str(foreshadow_open_loops.get("text_md") or ""))),
            "token_estimate": estimate_tokens(str(foreshadow_open_loops.get("text_md") or "")),
            "truncated": bool(foreshadow_open_loops.get("truncated")) if "truncated" in foreshadow_open_loops else None,
            "budget_char_limit": int(foreshadow_open_loops_budget),
            "budget_source": "override" if "foreshadow_open_loops" in budgets else "default",
        },
        {
            "section": "structured",
            "enabled": bool(structured.get("enabled")),
            "disabled_reason": structured.get("disabled_reason"),
            "note": "entities/relations/events/foreshadows summary",
            "token_estimate": estimate_tokens(str(structured.get("text_md") or "")),
            "truncated": bool(structured.get("truncated")) if "truncated" in structured else None,
            "budget_char_limit": int(structured_budget),
            "budget_source": "override" if "structured" in budgets else "default",
        },
        {
            "section": "tables",
            "enabled": bool(tables.get("enabled")),
            "disabled_reason": tables.get("disabled_reason"),
            "note": "table_context_service.build_tables_context_text_md",
            "counts": tables.get("counts"),
            "token_estimate": estimate_tokens(str(tables.get("text_md") or "")),
            "truncated": bool(tables.get("truncated")) if "truncated" in tables else None,
            "budget_char_limit": int(tables_budget),
            "budget_source": "override" if "tables" in budgets else "default",
        },
        {
            "section": "vector_rag",
            "enabled": bool(vector_rag.get("enabled")),
            "disabled_reason": vector_rag.get("disabled_reason"),
            "note": "vector_rag_service.query_project",
            "timings_ms": vector_rag.get("timings_ms"),
            "counts": vector_rag.get("counts"),
            "budget_observability": vector_rag.get("budget_observability")
            if isinstance(vector_rag.get("budget_observability"), dict)
            else None,
            "rerank": vector_rag.get("rerank"),
            "dropped_total": int(vector_rag.get("counts", {}).get("dropped_total", 0))
            if isinstance(vector_rag.get("counts"), dict)
            else 0,
            "backend": vector_rag.get("backend") or vector_rag.get("backend_preferred"),
            "hybrid_enabled": bool(vector_rag.get("hybrid_enabled"))
            if "hybrid_enabled" in vector_rag
            else bool(vector_rag.get("hybrid", {}).get("enabled")) if isinstance(vector_rag.get("hybrid"), dict) else None,
            "token_estimate": estimate_tokens(str(vector_rag.get("text_md") or "")),
            "truncated": bool(vector_rag.get("truncated")) if "truncated" in vector_rag else None,
            "budget_char_limit": int(vector_rag_budget),
            "budget_source": "override" if "vector_rag" in budgets else "default",
        },
        {
            "section": "graph",
            "enabled": bool(graph.get("enabled")),
            "disabled_reason": graph.get("disabled_reason"),
            "note": "graph_context_service.query_graph_context",
            "budget_observability": graph.get("budget_observability")
            if isinstance(graph.get("budget_observability"), dict)
            else None,
            "token_estimate": estimate_tokens(str(graph.get("text_md") or "")),
            "truncated": bool(graph.get("truncated")) if "truncated" in graph else None,
            "budget_char_limit": int(graph_budget),
            "budget_source": "override" if "graph" in budgets else "default",
        },
        {
            "section": "fractal",
            "enabled": bool(fractal.get("enabled")),
            "disabled_reason": fractal.get("disabled_reason"),
            "note": "Phase 6.2: use /api/projects/{project_id}/fractal/rebuild to rebuild deterministically",
            "budget_observability": fractal.get("budget_observability")
            if isinstance(fractal.get("budget_observability"), dict)
            else None,
            "retrieval": fractal.get("retrieval") if isinstance(fractal.get("retrieval"), dict) else None,
            "retrieval_hit_count": int((fractal.get("retrieval") or {}).get("hit_count") or 0)
            if isinstance(fractal.get("retrieval"), dict)
            else 0,
            "token_estimate": estimate_tokens(str(fractal.get("text_md") or "")),
            "truncated": bool(fractal.get("truncated")) if "truncated" in fractal else None,
            "budget_char_limit": int(fractal_budget),
            "budget_source": "override" if "fractal" in budgets else "default",
        },
    ]

    # ── Cross-module deduplication ────────────────────────────────────
    _dedup_sections = {
        "worldbook": worldbook,
        "story_memory": story_memory,
        "semantic_history": semantic_history,
        "foreshadow_open_loops": foreshadow_open_loops,
        "structured": structured,
        "tables": tables,
        "vector_rag": vector_rag,
        "graph": graph,
        "fractal": fractal,
    }
    try:
        _dedup_result, _dedup_log = deduplicate_memory_sections(_dedup_sections)
    except Exception:
        import logging as _logging
        _logging.getLogger("ainovel").warning("deduplicate_memory_sections failed, using original sections", exc_info=True)
        _dedup_result = _dedup_sections
        _dedup_log = []
    if _dedup_log:
        worldbook = _dedup_result.get("worldbook", worldbook)
        story_memory = _dedup_result.get("story_memory", story_memory)
        semantic_history = _dedup_result.get("semantic_history", semantic_history)
        foreshadow_open_loops = _dedup_result.get("foreshadow_open_loops", foreshadow_open_loops)
        structured = _dedup_result.get("structured", structured)
        tables = _dedup_result.get("tables", tables)
        vector_rag = _dedup_result.get("vector_rag", vector_rag)
        graph = _dedup_result.get("graph", graph)
        fractal = _dedup_result.get("fractal", fractal)
        logs.append({"section": "_dedup", "removed": _dedup_log})

    return MemoryContextPackOut.model_validate(
        redact_api_keys(
            {
                "worldbook": worldbook,
                "story_memory": story_memory,
                "semantic_history": semantic_history,
                "foreshadow_open_loops": foreshadow_open_loops,
                "structured": structured,
                "tables": tables,
                "vector_rag": vector_rag,
                "graph": graph,
                "fractal": fractal,
                "logs": logs,
            }
        )
    )


def placeholder_memory_retrieval_log(*, enabled: bool) -> dict[str, Any]:
    """
    Phase 0 placeholder for `memory_retrieval_log_json`.

    Spec reference: `长期记忆系统完整实现规划.md` §14.2.
    """
    return {
        "phase": "0.1",
        "enabled": bool(enabled),
        "query_text": "",
        "per_section": {},
        "budgets": {},
        "overfilter": {},
        "errors": [],
    }


def build_memory_retrieval_log_json(
    *,
    enabled: bool,
    query_text: str,
    pack: MemoryContextPackOut | None,
    errors: list[str] | None = None,
) -> dict[str, Any]:
    per_section: dict[str, Any] = {}
    if pack is not None:
        for item in pack.logs:
            per_section[str(item.section)] = item.model_dump()

    safe_errors = [str(e).strip() for e in (errors or []) if str(e).strip()]
    return {
        "phase": "1.0",
        "enabled": bool(enabled),
        "query_text": str(query_text or ""),
        "per_section": per_section,
        "budgets": {},
        "overfilter": {},
        "errors": safe_errors,
    }
