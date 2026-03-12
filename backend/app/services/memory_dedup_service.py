"""Cross-module deduplication for memory context.

Prevents the same information from appearing in multiple memory modules
(e.g. worldbook + structured + story_memory) by computing n-gram
fingerprints and removing high-overlap entries from lower-priority modules.
"""
from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger("ainovel")

# Minimum overlap ratio to consider two blocks duplicates
_OVERLAP_THRESHOLD = 0.70
# Minimum text length to bother deduplicating
_MIN_TEXT_LEN = 50
# N-gram size for fingerprinting
_NGRAM_SIZE = 3

# Module priority (higher number = higher priority, kept when duplicated)
_MODULE_PRIORITY: dict[str, int] = {
    "structured": 90,
    "story_memory": 80,
    "worldbook": 70,
    "foreshadow_open_loops": 60,
    "semantic_history": 50,
    "fractal": 40,
    "vector_rag": 35,
    "graph": 30,
    "tables": 20,
}


def _extract_ngrams(text: str, n: int = _NGRAM_SIZE) -> set[str]:
    """Extract character n-grams from text for fingerprinting."""
    cleaned = re.sub(r"\s+", "", text)
    if len(cleaned) < n:
        return {cleaned} if cleaned else set()
    return {cleaned[i: i + n] for i in range(len(cleaned) - n + 1)}


def _jaccard_similarity(set_a: set[str], set_b: set[str]) -> float:
    """Compute Jaccard similarity between two n-gram sets."""
    if not set_a or not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union > 0 else 0.0


def deduplicate_memory_sections(
    sections: dict[str, dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Remove high-overlap text across memory modules.

    Args:
        sections: Dict of section_name → section_dict, each having a "text_md" key.

    Returns:
        (cleaned_sections, dedup_log) — sections with duplicates removed
        from lower-priority modules, and a log of what was removed.
    """
    dedup_log: list[dict[str, Any]] = []

    # Extract text_md and compute fingerprints for enabled sections
    fingerprints: dict[str, set[str]] = {}
    texts: dict[str, str] = {}
    for name, section in sections.items():
        if not isinstance(section, dict):
            continue
        if not section.get("enabled", True):
            continue
        text = str(section.get("text_md") or "").strip()
        if len(text) < _MIN_TEXT_LEN:
            continue
        texts[name] = text
        fingerprints[name] = _extract_ngrams(text)

    if len(fingerprints) < 2:
        return sections, dedup_log

    # Sort modules by priority (high → low)
    sorted_modules = sorted(
        fingerprints.keys(),
        key=lambda m: _MODULE_PRIORITY.get(m, 0),
        reverse=True,
    )

    removed: set[str] = set()
    for i, high_mod in enumerate(sorted_modules):
        if high_mod in removed:
            continue
        for low_mod in sorted_modules[i + 1:]:
            if low_mod in removed:
                continue
            sim = _jaccard_similarity(fingerprints[high_mod], fingerprints[low_mod])
            if sim >= _OVERLAP_THRESHOLD:
                removed.add(low_mod)
                dedup_log.append({
                    "removed_from": low_mod,
                    "overlap_with": high_mod,
                    "similarity": round(sim, 3),
                    "removed_chars": len(texts.get(low_mod, "")),
                })
                logger.info(
                    "memory_dedup: removed %s (%.1f%% overlap with %s)",
                    low_mod, sim * 100, high_mod,
                )

    if not removed:
        return sections, dedup_log

    # Clear text_md for removed sections
    result = dict(sections)
    for mod_name in removed:
        if mod_name in result and isinstance(result[mod_name], dict):
            result[mod_name] = {
                **result[mod_name],
                "text_md": "",
                "dedup_removed": True,
            }

    return result, dedup_log
