from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError


_CODE_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", flags=re.IGNORECASE)

_CHAPTER_CONTENT_MARKER_RE = re.compile(r"(?mi)^[ \t]*<<<\s*CONTENT\b\s*(?:>{1,3})?\s*")
_CHAPTER_SUMMARY_MARKER_RE = re.compile(r"(?mi)^[ \t]*<<<\s*SUMMARY\b\s*(?:>{1,3})?\s*")
_PLOT_ADVANCEMENT_RE = re.compile(
    r"<!--\s*PLOT_ADVANCEMENT\s*\n"
    r"\s*information_push:\s*(.+?)\n"
    r"\s*consequence_cost:\s*(.+?)\n"
    r"\s*-->",
    re.DOTALL,
)


class OutlineChapterSchema(BaseModel):
    model_config = ConfigDict(extra="ignore")

    number: int
    title: str = ""
    beats: list[str] = Field(default_factory=list)


class OutlineSchema(BaseModel):
    model_config = ConfigDict(extra="ignore")

    outline_md: str = ""
    chapters: list[OutlineChapterSchema] = Field(default_factory=list)


class ChapterAnalysisNoteSchema(BaseModel):
    model_config = ConfigDict(extra="ignore")

    excerpt: str = ""
    note: str = ""


class ChapterAnalysisPlotPointSchema(BaseModel):
    model_config = ConfigDict(extra="ignore")

    beat: str = ""
    excerpt: str = ""


class ChapterAnalysisSuggestionSchema(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    excerpt: str = ""
    issue: str = ""
    recommendation: str = ""
    priority: str = ""


class ChapterAnalysisSchema(BaseModel):
    model_config = ConfigDict(extra="ignore")

    chapter_summary: str = ""
    hooks: list[ChapterAnalysisNoteSchema] = Field(default_factory=list)
    foreshadows: list[ChapterAnalysisNoteSchema] = Field(default_factory=list)
    plot_points: list[ChapterAnalysisPlotPointSchema] = Field(default_factory=list)
    suggestions: list[ChapterAnalysisSuggestionSchema] = Field(default_factory=list)
    overall_notes: str = ""


def extract_json_value(text: str) -> tuple[Any | None, str | None]:
    if not text:
        return None, None

    for m in _CODE_FENCE_RE.finditer(text):
        candidate = (m.group(1) or "").strip()
        if not candidate:
            continue
        value, raw = _extract_json_value_by_scan(candidate)
        if value is not None and raw is not None:
            return value, raw

    return _extract_json_value_by_scan(text)


def _extract_json_value_by_scan(text: str) -> tuple[Any | None, str | None]:
    decoder = json.JSONDecoder()
    positions = [m.start() for m in re.finditer(r"[\[{]", text)]

    # Avoid pathological O(n^2) for long outputs.
    positions = positions[:80]

    for pos in positions:
        snippet = text[pos:]
        try:
            value, end = decoder.raw_decode(snippet)
        except json.JSONDecodeError:
            continue
        raw = snippet[:end]
        return value, raw

    return None, None


def likely_truncated_json(text: str) -> bool:
    if not text:
        return False
    return text.count("{") > text.count("}") or text.count("[") > text.count("]")


def parse_outline_output(text: str) -> tuple[dict[str, Any], list[str], dict[str, Any] | None]:
    warnings: list[str] = []
    value, raw_json = extract_json_value(text)
    if not isinstance(value, dict):
        parse_error: dict[str, Any] = {"code": "OUTLINE_PARSE_ERROR", "message": "无法从模型输出解析章节结构"}
        if likely_truncated_json(text):
            parse_error["hint"] = "输出疑似被截断（JSON 未闭合），可尝试增大 max_tokens 或降低目标字数/章节数"
        data = {"outline_md": text, "chapters": [], "raw_output": text}
        return data, warnings, parse_error

    outline_md = value.get("outline_md")
    if not isinstance(outline_md, str) or not outline_md.strip():
        outline_md = text

    chapters_out: list[dict[str, Any]] = []

    # Strict schema path first.
    try:
        parsed = OutlineSchema.model_validate(value)
        for c in parsed.chapters:
            chapters_out.append({"number": int(c.number), "title": c.title or "", "beats": list(c.beats or [])})
    except ValidationError:
        warnings.append("outline_json_schema_invalid")

        chapters_raw = value.get("chapters")
        if isinstance(chapters_raw, list):
            for item in chapters_raw:
                if not isinstance(item, dict):
                    continue
                try:
                    number = int(item.get("number"))
                except Exception:
                    continue
                title = str(item.get("title") or "")
                beats_raw = item.get("beats") or []
                beats: list[str] = []
                if isinstance(beats_raw, list):
                    beats = [str(b) for b in beats_raw if b is not None]
                chapters_out.append({"number": number, "title": title, "beats": beats})

    if not chapters_out:
        parse_error = {"code": "OUTLINE_PARSE_ERROR", "message": "无法从模型输出解析章节结构"}
        data = {"outline_md": outline_md, "chapters": [], "raw_output": text}
        return data, warnings, parse_error

    data = {"outline_md": outline_md, "chapters": chapters_out, "raw_output": text}
    if raw_json:
        data["raw_json"] = raw_json
    return data, warnings, None


def _coerce_note_list(value: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if not isinstance(value, list):
        return out
    for item in value:
        if isinstance(item, str):
            text = item.strip()
            if not text:
                continue
            out.append({"excerpt": "", "note": text})
            continue
        if not isinstance(item, dict):
            continue
        excerpt = str(item.get("excerpt") or item.get("quote") or "").strip()
        note = str(item.get("note") or item.get("text") or item.get("desc") or "").strip()
        if not excerpt and not note:
            continue
        out.append({"excerpt": excerpt, "note": note})
    return out


def _coerce_plot_points(value: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if not isinstance(value, list):
        return out
    for item in value:
        if isinstance(item, str):
            text = item.strip()
            if not text:
                continue
            out.append({"beat": text, "excerpt": ""})
            continue
        if not isinstance(item, dict):
            continue
        beat = str(item.get("beat") or item.get("text") or item.get("desc") or "").strip()
        excerpt = str(item.get("excerpt") or item.get("quote") or "").strip()
        if not beat and not excerpt:
            continue
        out.append({"beat": beat, "excerpt": excerpt})
    return out


def _coerce_suggestions(value: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if not isinstance(value, list):
        return out
    for item in value:
        if isinstance(item, str):
            text = item.strip()
            if not text:
                continue
            out.append({"title": "", "excerpt": "", "issue": text, "recommendation": "", "priority": ""})
            continue
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        excerpt = str(item.get("excerpt") or item.get("quote") or "").strip()
        issue = str(item.get("issue") or item.get("problem") or item.get("note") or "").strip()
        recommendation = str(item.get("recommendation") or item.get("action") or item.get("fix") or "").strip()
        priority = str(item.get("priority") or item.get("severity") or "").strip()
        if not title and not excerpt and not issue and not recommendation:
            continue
        out.append(
            {
                "title": title,
                "excerpt": excerpt,
                "issue": issue,
                "recommendation": recommendation,
                "priority": priority,
            }
        )
    return out


def parse_chapter_analysis_output(text: str) -> tuple[dict[str, Any], list[str], dict[str, Any] | None]:
    warnings: list[str] = []
    value, raw_json = extract_json_value(text)
    if not isinstance(value, dict):
        parse_error: dict[str, Any] = {"code": "ANALYSIS_PARSE_ERROR", "message": "无法从模型输出解析章节分析 JSON"}
        if likely_truncated_json(text):
            parse_error["hint"] = "输出疑似被截断（JSON 未闭合），可尝试增大 max_tokens 或减少分析维度/输出长度"
        data = {"analysis": {}, "raw_output": text}
        return data, warnings, parse_error

    analysis: dict[str, Any]
    try:
        parsed = ChapterAnalysisSchema.model_validate(value)
        analysis = parsed.model_dump()
    except ValidationError:
        warnings.append("analysis_json_schema_invalid")
        analysis = {
            "chapter_summary": str(value.get("chapter_summary") or value.get("summary") or "").strip(),
            "hooks": _coerce_note_list(value.get("hooks")),
            "foreshadows": _coerce_note_list(value.get("foreshadows")),
            "plot_points": _coerce_plot_points(value.get("plot_points")),
            "suggestions": _coerce_suggestions(value.get("suggestions")),
            "overall_notes": str(value.get("overall_notes") or value.get("notes") or "").strip(),
        }

    data = {"analysis": analysis, "raw_output": text}
    if raw_json:
        data["raw_json"] = raw_json
    return data, warnings, None


def _split_chapter_markers(text: str) -> tuple[str | None, str | None]:
    if not text:
        return None, None

    # Be tolerant to minor marker drift (e.g. "<<<CONTENT" missing closing ">>>").
    m = _CHAPTER_CONTENT_MARKER_RE.search(text)
    if not m:
        return None, None

    start = m.end()
    s = _CHAPTER_SUMMARY_MARKER_RE.search(text, pos=start)
    if not s:
        return text[start:].strip(), ""

    content = text[start : s.start()].strip()
    summary = text[s.end() :].strip()
    return content, summary


def _extract_plot_advancement(text: str) -> dict[str, str] | None:
    """Extract the PLOT_ADVANCEMENT comment block from chapter output."""
    m = _PLOT_ADVANCEMENT_RE.search(text)
    if m is None:
        return None
    info_push = (m.group(1) or "").strip().strip("（）()")
    consequence = (m.group(2) or "").strip().strip("（）()")
    if not info_push and not consequence:
        return None
    return {"information_push": info_push, "consequence_cost": consequence}


def _strip_plot_advancement_comment(text: str) -> str:
    """Remove the PLOT_ADVANCEMENT HTML comment from content so it doesn't appear in final text."""
    return _PLOT_ADVANCEMENT_RE.sub("", text).rstrip()


def parse_chapter_output(
    text: str, *, finish_reason: str | None = None
) -> tuple[dict[str, Any], list[str], dict[str, Any] | None]:
    warnings: list[str] = []

    # Extract plot advancement self-report before parsing content
    plot_advancement = _extract_plot_advancement(text)

    content, summary = _split_chapter_markers(text)
    if content is not None:
        content = _strip_plot_advancement_comment(content)
        data = {"content_md": content, "summary": summary or "", "raw_output": text}
        if plot_advancement:
            data["plot_advancement"] = plot_advancement
        else:
            warnings.append("plot_advancement_missing")
        if finish_reason == "length":
            warnings.append("output_truncated")
            data["parse_error"] = {
                "code": "OUTPUT_TRUNCATED",
                "message": "输出疑似被截断（finish_reason=length），可尝试增大 max_tokens 或降低目标字数",
            }
        elif summary == "":
            warnings.append("summary_missing")
        return data, warnings, data.get("parse_error")

    value, raw_json = extract_json_value(text)
    if isinstance(value, dict):
        content_md = value.get("content_md")
        if not isinstance(content_md, str) or not content_md.strip():
            content_md = text
        content_md = _strip_plot_advancement_comment(content_md)
        summary_val = value.get("summary")
        summary_text = str(summary_val) if summary_val is not None else ""
        data = {"content_md": content_md, "summary": summary_text, "raw_output": text}
        if plot_advancement:
            data["plot_advancement"] = plot_advancement
        else:
            warnings.append("plot_advancement_missing")
        if raw_json:
            data["raw_json"] = raw_json
        if finish_reason == "length":
            warnings.append("output_truncated")
            data["parse_error"] = {
                "code": "OUTPUT_TRUNCATED",
                "message": "输出疑似被截断（finish_reason=length），可尝试增大 max_tokens 或降低目标字数",
            }
        return data, warnings, data.get("parse_error")

    cleaned_text = _strip_plot_advancement_comment(text)
    data = {"content_md": cleaned_text, "summary": "", "raw_output": text}
    if plot_advancement:
        data["plot_advancement"] = plot_advancement
    else:
        warnings.append("plot_advancement_missing")
    if finish_reason == "length":
        warnings.append("output_truncated")
        data["parse_error"] = {
            "code": "OUTPUT_TRUNCATED",
            "message": "输出疑似被截断（finish_reason=length），可尝试增大 max_tokens 或降低目标字数",
        }
    return data, warnings, data.get("parse_error")


def build_outline_fix_json_prompt(raw_output: str) -> tuple[str, str]:
    system = (
        "你是一个严格的 JSON 修复器。你的任务：把用户提供的模型原始输出修复为一个合法 JSON 对象。"
        "只输出 JSON，不要解释，不要 Markdown，不要代码块。"
    )
    user = (
        "请把下面的内容修复为严格 JSON（对象），并满足以下 schema：\n"
        "{\n"
        '  "outline_md": string,\n'
        '  "chapters": [\n'
        '    {"number": int, "title": string, "beats": [string]}\n'
        "  ]\n"
        "}\n\n"
        "要求：\n"
        "- 必须输出完整可解析的 JSON\n"
        "- 只输出 JSON，不能包含任何额外文本\n"
        "- 若缺字段请补默认值（outline_md 可为空字符串，chapters 不能为空时尽量推断；推断不了则输出空数组）\n\n"
        f"原始输出如下：\n{raw_output}"
    )
    return system, user


def extract_tag_block(text: str, *, tag: str) -> tuple[str | None, dict[str, Any] | None]:
    """
    Extract the last complete <tag>...</tag> block (case-insensitive).
    Returns (inner_text, parse_error).
    """
    if not text:
        return None, {"code": "TAG_PARSE_ERROR", "message": "输出为空"}
    tag_name = tag.strip().strip("<>").lower()
    if not tag_name:
        return None, {"code": "TAG_PARSE_ERROR", "message": "tag 不能为空"}
    pattern = re.compile(rf"(?is)<\s*{re.escape(tag_name)}\b[^>]*>([\s\S]*?)<\s*/\s*{re.escape(tag_name)}\s*>")
    matches = list(pattern.finditer(text))
    if not matches:
        return None, {"code": "TAG_PARSE_ERROR", "message": f"未找到 <{tag_name}>...</{tag_name}> 标签块"}
    m = matches[-1]
    inner = (m.group(1) or "").strip()
    return inner, None


def extract_full_tag_block(text: str, *, tag: str) -> tuple[str | None, dict[str, Any] | None]:
    """
    Extract the last complete <tag ...>...</tag> block (case-insensitive).
    Returns (full_block, parse_error).
    """
    if not text:
        return None, {"code": "TAG_PARSE_ERROR", "message": "输出为空"}
    tag_name = tag.strip().strip("<>").lower()
    if not tag_name:
        return None, {"code": "TAG_PARSE_ERROR", "message": "tag 不能为空"}
    pattern = re.compile(rf"(?is)<\s*{re.escape(tag_name)}\b[^>]*>[\s\S]*?<\s*/\s*{re.escape(tag_name)}\s*>")
    matches = list(pattern.finditer(text))
    if not matches:
        return None, {"code": "TAG_PARSE_ERROR", "message": f"未找到 <{tag_name}>...</{tag_name}> 标签块"}
    m = matches[-1]
    return (m.group(0) or "").strip(), None


def replace_tag_content(text: str, *, tag: str, inner_text: str) -> tuple[str | None, dict[str, Any] | None]:
    """
    Replace the inner text of the last complete <tag ...>...</tag> block (case-insensitive).
    Returns (updated_text, parse_error).
    """
    if not text:
        return None, {"code": "TAG_REPLACE_ERROR", "message": "输入为空"}
    tag_name = tag.strip().strip("<>").lower()
    if not tag_name:
        return None, {"code": "TAG_REPLACE_ERROR", "message": "tag 不能为空"}

    pattern = re.compile(
        rf"(?is)(<\s*{re.escape(tag_name)}\b[^>]*>)([\s\S]*?)(<\s*/\s*{re.escape(tag_name)}\s*>)"
    )
    matches = list(pattern.finditer(text))
    if not matches:
        return None, {"code": "TAG_REPLACE_ERROR", "message": f"未找到 <{tag_name}>...</{tag_name}> 标签块"}
    m = matches[-1]

    next_inner = str(inner_text or "")
    updated = text[: m.start(2)] + next_inner + text[m.end(2) :]
    return updated, None


def parse_tag_output(
    text: str, *, tag: str, output_key: str | None = None
) -> tuple[dict[str, Any], list[str], dict[str, Any] | None]:
    """
    Tag contract: expects at least one <tag>...</tag> block.
    Returns: {<output_key>: inner_text, "raw_output": text}
    """
    warnings: list[str] = []
    key = (output_key or tag or "").strip() or "value"

    inner, err = extract_tag_block(text, tag=tag)
    if err is not None or inner is None:
        data = {key: "", "raw_output": text}
        return data, warnings, err

    tag_name = tag.strip().strip("<>").lower()
    m_all = list(
        re.finditer(
            rf"(?is)<\s*{re.escape(tag_name)}\b[^>]*>[\s\S]*?<\s*/\s*{re.escape(tag_name)}\s*>",
            text,
        )
    )
    if m_all:
        m = m_all[-1]
        outside = (text[: m.start()] + text[m.end() :]).strip()
        if outside:
            warnings.append("tag_outside_text")
        if len(m_all) > 1:
            warnings.append("tag_multiple_blocks")

    data = {key: inner, "raw_output": text}
    return data, warnings, None
