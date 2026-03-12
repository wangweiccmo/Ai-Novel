from __future__ import annotations

import json
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.chapter import Chapter
from app.models.character import Character
from app.models.outline import Outline
from app.models.project import Project
from app.models.project_settings import ProjectSettings
from app.schemas.chapter_analysis import ChapterAnalyzeRequest, ChapterRewriteRequest
from app.schemas.chapter_generate import ChapterGenerateContext, ChapterGenerateRequest
from app.services.prompt_store import format_characters
from app.services.style_resolution_service import resolve_style_guide
from app.services.canon_audit_service import run_canon_audit, format_warnings_for_render

PREVIOUS_CHAPTER_ENDING_CHARS = 1000
CURRENT_DRAFT_TAIL_CHARS = 1200

SMART_CONTEXT_RECENT_SUMMARIES_MAX = 20
SMART_CONTEXT_RECENT_FULL_MAX = 2
SMART_CONTEXT_RECENT_FULL_HEAD_CHARS = 1200
SMART_CONTEXT_RECENT_FULL_TAIL_CHARS = 1200
SMART_CONTEXT_SKELETON_STRIDE_SMALL = 10
SMART_CONTEXT_SKELETON_STRIDE_LARGE = 20
SMART_CONTEXT_SKELETON_LARGE_THRESHOLD = 80


def build_smart_context(
    db: Session,
    *,
    project_id: str,
    outline_id: str,
    chapter_number: int,
) -> tuple[str, str, str]:
    if chapter_number <= 1:
        return "", "", ""

    summary_rows = db.execute(
        select(Chapter.number, Chapter.title, Chapter.summary)
        .where(
            Chapter.project_id == project_id,
            Chapter.outline_id == outline_id,
            Chapter.number < chapter_number,
        )
        .order_by(Chapter.number.desc())
        .limit(SMART_CONTEXT_RECENT_SUMMARIES_MAX)
    ).all()
    summary_rows.reverse()
    recent_summary_lines: list[str] = []
    for num, title, summary in summary_rows:
        text = (summary or "").strip()
        if not text:
            continue
        title_str = (title or "").strip()
        head = f"第{num}章 {title_str}" if title_str else f"第{num}章"
        recent_summary_lines.append(f"- {head}：{text}")
    recent_summaries = "\n".join(recent_summary_lines).strip()

    full_rows = db.execute(
        select(Chapter.number, Chapter.title, Chapter.content_md)
        .where(
            Chapter.project_id == project_id,
            Chapter.outline_id == outline_id,
            Chapter.number < chapter_number,
        )
        .order_by(Chapter.number.desc())
        .limit(SMART_CONTEXT_RECENT_FULL_MAX)
    ).all()
    full_rows.reverse()
    recent_full_parts: list[str] = []
    for num, title, content_md in full_rows:
        raw = (content_md or "").strip()
        if not raw:
            continue
        title_str = (title or "").strip()
        head = f"第{num}章 {title_str}" if title_str else f"第{num}章"
        if len(raw) <= SMART_CONTEXT_RECENT_FULL_HEAD_CHARS + SMART_CONTEXT_RECENT_FULL_TAIL_CHARS + 80:
            snippet = raw
        else:
            snippet = (
                raw[:SMART_CONTEXT_RECENT_FULL_HEAD_CHARS].rstrip()
                + "\n...\n"
                + raw[-SMART_CONTEXT_RECENT_FULL_TAIL_CHARS :].lstrip()
            )
        recent_full_parts.append(f"【{head} 正文节选】\n{snippet}")
    recent_full = "\n\n".join(recent_full_parts).strip()

    total_prev = max(0, chapter_number - 1)

    # Smart chapter selection: pick the most important chapters for the skeleton
    # instead of fixed-stride. Uses summary richness + proximity as signals.
    skeleton = ""
    if total_prev >= 3:
        skeleton_candidates = db.execute(
            select(Chapter.number, Chapter.title, Chapter.summary, Chapter.plan, Chapter.content_md)
            .where(
                Chapter.project_id == project_id,
                Chapter.outline_id == outline_id,
                Chapter.number < chapter_number,
            )
            .order_by(Chapter.number.asc())
        ).all()

        max_skeleton = 8 if total_prev < SMART_CONTEXT_SKELETON_LARGE_THRESHOLD else 12

        def _importance_score(row: tuple, current: int) -> float:
            num, _title, summary, plan, content_md = row
            # Proximity: closer chapters matter more
            distance = max(1, current - int(num))
            proximity = 1.0 / (1.0 + distance * 0.05)
            # Content richness: longer summary = more happened
            summary_len = len((summary or "").strip())
            plan_len = len((plan or "").strip())
            content_len = len((content_md or "").strip())
            richness = min(1.0, (summary_len / 300.0) * 0.5 + (plan_len / 200.0) * 0.2 + (content_len / 3000.0) * 0.3)
            # Key chapter positions: first, midpoint, chapter before current always included
            position_bonus = 0.0
            if int(num) == 1:
                position_bonus = 0.3  # First chapter always important
            elif int(num) == current - 1:
                position_bonus = 0.5  # Immediately preceding chapter
            elif total_prev > 10 and int(num) == total_prev // 2:
                position_bonus = 0.2  # Midpoint
            return proximity * 0.4 + richness * 0.3 + position_bonus

        scored = [(row, _importance_score(row, chapter_number)) for row in skeleton_candidates]
        scored.sort(key=lambda x: x[1], reverse=True)
        selected = [row for row, _ in scored[:max_skeleton]]
        selected.sort(key=lambda row: row[0])  # Re-sort by chapter number

        skeleton_lines: list[str] = []
        for num, title, summary, plan, _content_md in selected:
            text = (summary or "").strip() or (plan or "").strip()
            if not text:
                continue
            title_str = (title or "").strip()
            head = f"第{num}章 {title_str}" if title_str else f"第{num}章"
            skeleton_lines.append(f"- {head}：{text}")
        skeleton = "\n".join(skeleton_lines).strip()

    return recent_summaries, recent_full, skeleton


def load_previous_chapter_context(
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


def resolve_current_draft_tail(*, chapter: Chapter, request_tail: str | None) -> str:
    if request_tail is not None and request_tail.strip():
        return request_tail.strip()[-CURRENT_DRAFT_TAIL_CHARS:].lstrip()
    raw = (chapter.content_md or "").strip()
    if not raw:
        return ""
    return raw[-CURRENT_DRAFT_TAIL_CHARS:].lstrip()


def _load_project_story_text_context(
    db: Session,
    *,
    project_id: str,
    outline_id: str,
    ctx: ChapterGenerateContext,
) -> tuple[str, str, str, str, str, str]:
    """Returns (world_setting, style_guide, constraints, outline_text, characters_text, arc_phase)."""
    settings_row = db.get(ProjectSettings, project_id)
    outline_row = db.get(Outline, outline_id)

    world_setting = (settings_row.world_setting if settings_row else "") or ""
    style_guide = (settings_row.style_guide if settings_row else "") or ""
    constraints = (settings_row.constraints if settings_row else "") or ""

    if not ctx.include_world_setting:
        world_setting = ""
    if not ctx.include_style_guide:
        style_guide = ""
    if not ctx.include_constraints:
        constraints = ""

    outline_text = (outline_row.content_md if outline_row else "") or ""
    if not ctx.include_outline:
        outline_text = ""

    arc_phase = (getattr(outline_row, "arc_phase", None) or "") if outline_row else ""

    chars: list[Character] = []
    if ctx.character_ids:
        chars = (
            db.execute(
                select(Character).where(
                    Character.project_id == project_id,
                    Character.id.in_(ctx.character_ids),
                )
            )
            .scalars()
            .all()
        )
    characters_text = format_characters(chars)

    return world_setting, style_guide, constraints, outline_text, characters_text, arc_phase


def _format_chapter_generate_instruction(*, mode: Literal["replace", "append"], base_instruction: str) -> str:
    instruction = base_instruction
    if mode == "append":
        instruction = "【追加模式】只输出需要追加到正文末尾的新增片段，不要重复已写内容。\\n" + instruction
    else:
        instruction = "【替换模式】输出完整替换稿（整章）。\\n" + instruction
    return instruction


def assemble_chapter_generate_render_values(
    *,
    project: Project,
    mode: Literal["replace", "append"],
    chapter_number: int,
    chapter_title: str,
    chapter_plan: str,
    world_setting: str,
    style_guide: str,
    constraints: str,
    characters_text: str,
    outline_text: str,
    instruction: str,
    target_word_count: int | None,
    previous_chapter: str,
    previous_chapter_ending: str,
    current_draft_tail: str,
    smart_context_recent_summaries: str,
    smart_context_recent_full: str,
    smart_context_story_skeleton: str,
) -> tuple[dict[str, object], dict[str, object]]:
    requirements_obj: dict[str, object] = {}
    if target_word_count is not None:
        requirements_obj["target_word_count"] = target_word_count
    requirements_text = json.dumps(requirements_obj, ensure_ascii=False, indent=2) if requirements_obj else ""

    values: dict[str, object] = {
        "mode": mode,
        "project_name": project.name or "",
        "genre": project.genre or "",
        "logline": project.logline or "",
        "world_setting": world_setting,
        "style_guide": style_guide,
        "constraints": constraints,
        "characters": characters_text,
        "outline": outline_text,
        "chapter_number": str(chapter_number),
        "chapter_title": chapter_title,
        "chapter_plan": chapter_plan,
        "requirements": requirements_text,
        "target_word_count": str(target_word_count or ""),
        "instruction": instruction,
        "previous_chapter": previous_chapter,
        "previous_chapter_ending": previous_chapter_ending,
        "current_draft_tail": current_draft_tail,
        "smart_context_recent_summaries": smart_context_recent_summaries,
        "smart_context_recent_full": smart_context_recent_full,
        "smart_context_story_skeleton": smart_context_story_skeleton,
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
        "chapter_number": int(chapter_number),
        "chapter_title": chapter_title,
        "chapter_plan": chapter_plan,
        "previous_chapter": previous_chapter,
        "previous_chapter_ending": previous_chapter_ending,
        "mode": mode,
        "current_draft_tail": current_draft_tail,
        "smart_context_recent_summaries": smart_context_recent_summaries,
        "smart_context_recent_full": smart_context_recent_full,
        "smart_context_story_skeleton": smart_context_story_skeleton,
    }
    values["user"] = {"instruction": instruction, "requirements": requirements_obj}
    return values, requirements_obj


def build_chapter_generate_render_values(
    db: Session,
    *,
    project: Project,
    chapter: Chapter,
    body: ChapterGenerateRequest,
    user_id: str,
) -> tuple[dict[str, object], str, dict[str, object], dict[str, object]]:
    world_setting, style_guide, constraints, outline_text, characters_text, arc_phase = _load_project_story_text_context(
        db,
        project_id=chapter.project_id,
        outline_id=chapter.outline_id,
        ctx=body.context,
    )
    resolved_style_guide, style_resolution = resolve_style_guide(
        db,
        project_id=chapter.project_id,
        user_id=user_id,
        requested_style_id=body.style_id,
        include_style_guide=bool(body.context.include_style_guide),
        settings_style_guide=style_guide,
    )

    prev_text, prev_ending = load_previous_chapter_context(
        db,
        project_id=chapter.project_id,
        outline_id=chapter.outline_id,
        chapter_number=int(chapter.number),
        previous_chapter=body.context.previous_chapter,
    )

    current_draft_tail = ""
    if body.mode == "append":
        current_draft_tail = resolve_current_draft_tail(chapter=chapter, request_tail=body.context.current_draft_tail)

    smart_recent_summaries = ""
    smart_recent_full = ""
    smart_story_skeleton = ""
    if body.context.include_smart_context:
        smart_recent_summaries, smart_recent_full, smart_story_skeleton = build_smart_context(
            db,
            project_id=chapter.project_id,
            outline_id=chapter.outline_id,
            chapter_number=int(chapter.number),
        )

    base_instruction = body.instruction.strip()
    instruction = _format_chapter_generate_instruction(mode=body.mode, base_instruction=base_instruction)

    values, requirements_obj = assemble_chapter_generate_render_values(
        project=project,
        mode=body.mode,
        chapter_number=int(chapter.number),
        chapter_title=(chapter.title or ""),
        chapter_plan=(chapter.plan or ""),
        world_setting=world_setting,
        style_guide=resolved_style_guide,
        constraints=constraints,
        characters_text=characters_text,
        outline_text=outline_text,
        instruction=instruction,
        target_word_count=body.target_word_count,
        previous_chapter=prev_text,
        previous_chapter_ending=prev_ending,
        current_draft_tail=current_draft_tail,
        smart_context_recent_summaries=smart_recent_summaries,
        smart_context_recent_full=smart_recent_full,
        smart_context_story_skeleton=smart_story_skeleton,
    )

    # Inject arc_phase for the arc_phase prompt block
    if arc_phase:
        values["arc_phase"] = arc_phase

    # Run canon audit for continuity warnings
    canon_warnings = run_canon_audit(
        db,
        project_id=chapter.project_id,
        chapter_number=int(chapter.number),
        chapter_plan=(chapter.plan or ""),
        character_ids=body.context.character_ids if body.context.character_ids else None,
    )
    if canon_warnings:
        values["continuity_warnings"] = format_warnings_for_render(canon_warnings)

    return values, base_instruction, requirements_obj, style_resolution


def build_chapter_analyze_render_values(
    db: Session,
    *,
    project: Project,
    chapter: Chapter,
    body: ChapterAnalyzeRequest,
) -> dict[str, object]:
    world_setting, style_guide, constraints, outline_text, characters_text, _arc_phase = _load_project_story_text_context(
        db,
        project_id=chapter.project_id,
        outline_id=chapter.outline_id,
        ctx=body.context,
    )

    smart_recent_summaries = ""
    smart_recent_full = ""
    smart_story_skeleton = ""
    if body.context.include_smart_context:
        smart_recent_summaries, smart_recent_full, smart_story_skeleton = build_smart_context(
            db,
            project_id=chapter.project_id,
            outline_id=chapter.outline_id,
            chapter_number=int(chapter.number),
        )

    draft_title = body.draft_title if body.draft_title is not None else (chapter.title or "")
    draft_plan = body.draft_plan if body.draft_plan is not None else (chapter.plan or "")
    draft_summary = body.draft_summary if body.draft_summary is not None else (chapter.summary or "")
    draft_content_md = body.draft_content_md if body.draft_content_md is not None else (chapter.content_md or "")

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
        "chapter_title": draft_title,
        "chapter_plan": draft_plan,
        "chapter_summary": draft_summary,
        "chapter_content_md": draft_content_md,
        "instruction": body.instruction.strip(),
        "smart_context_recent_summaries": smart_recent_summaries,
        "smart_context_recent_full": smart_recent_full,
        "smart_context_story_skeleton": smart_story_skeleton,
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
        "chapter_title": draft_title,
        "chapter_plan": draft_plan,
        "chapter_summary": draft_summary,
        "chapter_content_md": draft_content_md,
        "smart_context_recent_summaries": smart_recent_summaries,
        "smart_context_recent_full": smart_recent_full,
        "smart_context_story_skeleton": smart_story_skeleton,
    }
    values["user"] = {"instruction": body.instruction.strip()}
    return values


def build_chapter_rewrite_render_values(
    db: Session,
    *,
    project: Project,
    chapter: Chapter,
    body: ChapterRewriteRequest,
    analysis_json: str,
    draft_content_md: str,
) -> dict[str, object]:
    world_setting, style_guide, constraints, outline_text, characters_text, _arc_phase = _load_project_story_text_context(
        db,
        project_id=chapter.project_id,
        outline_id=chapter.outline_id,
        ctx=body.context,
    )

    smart_recent_summaries = ""
    smart_recent_full = ""
    smart_story_skeleton = ""
    if body.context.include_smart_context:
        smart_recent_summaries, smart_recent_full, smart_story_skeleton = build_smart_context(
            db,
            project_id=chapter.project_id,
            outline_id=chapter.outline_id,
            chapter_number=int(chapter.number),
        )

    draft_title = chapter.title or ""
    draft_plan = chapter.plan or ""

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
        "chapter_title": draft_title,
        "chapter_plan": draft_plan,
        "chapter_content_md": draft_content_md,
        "analysis_json": analysis_json,
        "instruction": body.instruction.strip(),
        "smart_context_recent_summaries": smart_recent_summaries,
        "smart_context_recent_full": smart_recent_full,
        "smart_context_story_skeleton": smart_story_skeleton,
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
        "chapter_title": draft_title,
        "chapter_plan": draft_plan,
        "chapter_content_md": draft_content_md,
        "analysis_json": analysis_json,
        "smart_context_recent_summaries": smart_recent_summaries,
        "smart_context_recent_full": smart_recent_full,
        "smart_context_story_skeleton": smart_story_skeleton,
    }
    values["user"] = {"instruction": body.instruction.strip()}
    return values


def inject_plan_into_render_values(render_values: dict[str, object], *, plan_text: str) -> dict[str, object]:
    if not plan_text.strip():
        return render_values

    instruction_with_plan = f"{str(render_values.get('instruction') or '').rstrip()}\n\n<PLAN>\n{plan_text}\n</PLAN>"
    next_values = dict(render_values)
    next_values["instruction"] = instruction_with_plan
    next_values["story_plan"] = plan_text

    story_ns = next_values.get("story")
    if isinstance(story_ns, dict):
        story2 = dict(story_ns)
        story2["plan"] = plan_text
        next_values["story"] = story2
    else:
        next_values["story"] = {"plan": plan_text}

    user_ns = next_values.get("user")
    if isinstance(user_ns, dict):
        user2 = dict(user_ns)
        user2["instruction"] = instruction_with_plan
        next_values["user"] = user2

    return next_values


def build_post_edit_render_values(render_values: dict[str, object], *, raw_content: str) -> dict[str, object]:
    next_values = dict(render_values)
    next_values["raw_content"] = raw_content

    story_ns = next_values.get("story")
    if isinstance(story_ns, dict):
        story2 = dict(story_ns)
        story2["raw_content"] = raw_content
        next_values["story"] = story2
    else:
        next_values["story"] = {"raw_content": raw_content}

    return next_values
