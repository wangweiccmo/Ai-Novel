"""Style compliance scoring: rule-based checks to evaluate if generated content
matches the project's style guide.

No LLM call — uses pattern matching and statistical analysis for speed.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class StyleComplianceResult:
    overall_score: float  # 0.0 ~ 1.0
    checks: list[dict[str, Any]] = field(default_factory=list)


# Common AI-like phrases in Chinese fiction generation
_DEFAULT_AI_TRACES_ZH = [
    "不禁", "仿佛", "犹如", "宛如", "似乎", "不由自主",
    "内心深处", "一抹", "一丝", "淡淡的", "微微", "缓缓",
    "心中暗想", "眉头微蹙", "嘴角微扬", "眼眸", "薄唇",
    "不由得", "心中一震", "脑海中浮现",
]

_SENTENCE_END_PATTERN = re.compile(r"[。！？…]+")


def score_style_compliance(
    *,
    content: str,
    style_guide: str = "",
    custom_trace_words: list[str] | None = None,
) -> StyleComplianceResult:
    """Evaluate generated content against style rules. Returns 0.0~1.0 score."""
    checks: list[dict[str, Any]] = []
    content = (content or "").strip()
    if not content:
        return StyleComplianceResult(overall_score=1.0, checks=checks)

    # 1. AI trace word density
    trace_words = list(_DEFAULT_AI_TRACES_ZH)
    if custom_trace_words:
        trace_words.extend(custom_trace_words)
    trace_count = sum(content.count(w) for w in trace_words)
    content_len = max(1, len(content))
    trace_density = trace_count / (content_len / 1000.0)  # per 1000 chars
    trace_score = max(0.0, 1.0 - trace_density * 0.1)  # Penalty: each trace/1000chars = -0.1
    checks.append({
        "name": "ai_trace_density",
        "score": round(trace_score, 3),
        "trace_count": trace_count,
        "density_per_1k": round(trace_density, 2),
    })

    # 2. Sentence length variance (good writing has varied rhythm)
    sentences = [s.strip() for s in _SENTENCE_END_PATTERN.split(content) if s.strip()]
    if len(sentences) >= 3:
        lengths = [len(s) for s in sentences]
        avg_len = sum(lengths) / len(lengths)
        variance = sum((l - avg_len) ** 2 for l in lengths) / len(lengths)
        std_dev = variance ** 0.5
        # Good variance: std_dev/avg_len between 0.3 and 1.5
        cv = std_dev / max(1, avg_len)
        if cv < 0.15:
            rhythm_score = 0.5  # Too uniform
        elif cv > 2.0:
            rhythm_score = 0.6  # Too chaotic
        else:
            rhythm_score = min(1.0, 0.5 + cv * 0.5)
        checks.append({
            "name": "sentence_rhythm",
            "score": round(rhythm_score, 3),
            "avg_sentence_len": round(avg_len, 1),
            "cv": round(cv, 3),
        })
    else:
        rhythm_score = 0.8
        checks.append({"name": "sentence_rhythm", "score": 0.8, "note": "too_few_sentences"})

    # 3. Dialogue ratio check (if style guide mentions dialogue preferences)
    dialogue_chars = sum(len(m) for m in re.findall(r"[""「」『』].*?[""「」『』]", content))
    dialogue_ratio = dialogue_chars / max(1, content_len)
    dialogue_score = 1.0
    if "多对话" in style_guide or "dialogue-heavy" in style_guide.lower():
        dialogue_score = min(1.0, dialogue_ratio * 5)  # Expect >= 20%
    elif "少对话" in style_guide or "narrative-heavy" in style_guide.lower():
        dialogue_score = max(0.0, 1.0 - dialogue_ratio * 3)  # Expect <= 33%
    checks.append({
        "name": "dialogue_ratio",
        "score": round(dialogue_score, 3),
        "ratio": round(dialogue_ratio, 3),
    })

    # 4. Paragraph length consistency
    paragraphs = [p.strip() for p in content.split("\n") if p.strip()]
    if len(paragraphs) >= 2:
        para_lengths = [len(p) for p in paragraphs]
        avg_para = sum(para_lengths) / len(para_lengths)
        too_long = sum(1 for l in para_lengths if l > 500)
        too_short = sum(1 for l in para_lengths if l < 10)
        para_score = max(0.0, 1.0 - (too_long + too_short) * 0.05)
        checks.append({
            "name": "paragraph_balance",
            "score": round(para_score, 3),
            "avg_para_len": round(avg_para, 1),
            "too_long_count": too_long,
            "too_short_count": too_short,
        })
    else:
        para_score = 0.8
        checks.append({"name": "paragraph_balance", "score": 0.8, "note": "single_paragraph"})

    # Weighted average
    weights = {
        "ai_trace_density": 0.35,
        "sentence_rhythm": 0.25,
        "dialogue_ratio": 0.15,
        "paragraph_balance": 0.25,
    }
    total_weight = sum(weights.get(c["name"], 0) for c in checks)
    if total_weight > 0:
        overall = sum(c["score"] * weights.get(c["name"], 0) for c in checks) / total_weight
    else:
        overall = 0.8

    return StyleComplianceResult(overall_score=round(max(0.0, min(1.0, overall)), 3), checks=checks)
