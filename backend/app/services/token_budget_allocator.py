"""
Global token budget allocator for memory retrieval sections.

Instead of each memory section having an independent character budget,
this allocator distributes a shared token pool across all enabled sections
based on priority weights. Empty sections' budgets are reclaimed and
redistributed to remaining sections.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any

from app.services.prompt_budget import estimate_tokens

logger = logging.getLogger("ainovel.token_budget_allocator")

# ---------------------------------------------------------------------------
# Default section priorities (higher = more important, gets budget first)
# ---------------------------------------------------------------------------

DEFAULT_SECTION_PRIORITIES: dict[str, float] = {
    "worldbook": 0.7,
    "story_memory": 0.7,
    "semantic_history": 0.5,
    "foreshadow_open_loops": 0.5,
    "structured": 0.8,
    "tables": 0.5,
    "vector_rag": 0.5,
    "graph": 0.4,
    "fractal": 0.6,
}

# Minimum token budget per section (won't go below this if enabled)
MIN_SECTION_TOKENS = 200

# Maximum token budget per section (cap even for high-priority sections)
MAX_SECTION_TOKENS = 8000

# Default total token budget for all memory sections combined
DEFAULT_TOTAL_MEMORY_TOKENS = 24000


@dataclass
class SectionBudget:
    """Budget allocation result for a single memory section."""
    section: str
    enabled: bool
    priority: float
    allocated_tokens: int
    allocated_chars: int  # approximate chars for backward compat
    source: str = "allocator"  # "allocator" | "override" | "disabled"


@dataclass
class BudgetAllocation:
    """Complete budget allocation result across all sections."""
    total_budget_tokens: int
    sections: dict[str, SectionBudget] = field(default_factory=dict)
    allocated_tokens: int = 0
    unallocated_tokens: int = 0

    def char_limit_for(self, section: str) -> int:
        """Get the character limit for a section (backward compatible)."""
        sb = self.sections.get(section)
        if sb is None or not sb.enabled:
            return 0
        return sb.allocated_chars

    def token_limit_for(self, section: str) -> int:
        """Get the token limit for a section."""
        sb = self.sections.get(section)
        if sb is None or not sb.enabled:
            return 0
        return sb.allocated_tokens

    def to_log_dict(self) -> dict[str, Any]:
        return {
            "total_budget_tokens": self.total_budget_tokens,
            "allocated_tokens": self.allocated_tokens,
            "unallocated_tokens": self.unallocated_tokens,
            "sections": {
                name: {
                    "enabled": sb.enabled,
                    "priority": sb.priority,
                    "tokens": sb.allocated_tokens,
                    "chars": sb.allocated_chars,
                    "source": sb.source,
                }
                for name, sb in self.sections.items()
            },
        }


def allocate_memory_budgets(
    *,
    enabled_sections: dict[str, bool],
    total_budget_tokens: int = DEFAULT_TOTAL_MEMORY_TOKENS,
    budget_overrides_chars: dict[str, int] | None = None,
    priorities: dict[str, float] | None = None,
) -> BudgetAllocation:
    """
    Allocate a shared token budget across enabled memory sections.

    Args:
        enabled_sections: Which sections are enabled (section_name -> bool).
        total_budget_tokens: Total token pool for all memory sections.
        budget_overrides_chars: Legacy char-based overrides (converted to tokens).
        priorities: Per-section priority weights (default: DEFAULT_SECTION_PRIORITIES).

    Returns:
        BudgetAllocation with per-section token and char budgets.
    """
    prio = priorities or DEFAULT_SECTION_PRIORITIES
    overrides = budget_overrides_chars or {}
    result = BudgetAllocation(total_budget_tokens=total_budget_tokens)

    # Step 1: Handle disabled sections and overrides
    active_sections: list[tuple[str, float]] = []
    override_total = 0

    for section in DEFAULT_SECTION_PRIORITIES:
        enabled = bool(enabled_sections.get(section, False))
        if not enabled:
            result.sections[section] = SectionBudget(
                section=section,
                enabled=False,
                priority=prio.get(section, 0.5),
                allocated_tokens=0,
                allocated_chars=0,
                source="disabled",
            )
            continue

        if section in overrides:
            # Convert char override to token budget
            char_val = max(0, min(int(overrides[section]), 50000))
            token_val = _chars_to_tokens(char_val)
            token_val = min(token_val, MAX_SECTION_TOKENS)
            result.sections[section] = SectionBudget(
                section=section,
                enabled=True,
                priority=prio.get(section, 0.5),
                allocated_tokens=token_val,
                allocated_chars=char_val,
                source="override",
            )
            override_total += token_val
        else:
            active_sections.append((section, prio.get(section, 0.5)))

    # Step 2: Distribute remaining budget by priority weight
    remaining = max(0, total_budget_tokens - override_total)

    if active_sections and remaining > 0:
        total_weight = sum(w for _, w in active_sections)
        if total_weight <= 0:
            total_weight = len(active_sections)

        for section, weight in active_sections:
            share = (weight / total_weight) * remaining
            tokens = max(MIN_SECTION_TOKENS, min(MAX_SECTION_TOKENS, int(math.floor(share))))
            result.sections[section] = SectionBudget(
                section=section,
                enabled=True,
                priority=weight,
                allocated_tokens=tokens,
                allocated_chars=_tokens_to_chars(tokens),
                source="allocator",
            )

    # Step 3: Calculate totals
    result.allocated_tokens = sum(
        sb.allocated_tokens for sb in result.sections.values() if sb.enabled
    )
    result.unallocated_tokens = max(0, total_budget_tokens - result.allocated_tokens)

    logger.debug(
        "token_budget_allocation: total=%d allocated=%d unallocated=%d active_sections=%d",
        total_budget_tokens,
        result.allocated_tokens,
        result.unallocated_tokens,
        len(active_sections),
    )

    return result


def reclaim_unused_budget(
    allocation: BudgetAllocation,
    actual_usage: dict[str, int],
) -> BudgetAllocation:
    """
    After initial retrieval, reclaim unused tokens from sections that used less
    than allocated and redistribute to sections that need more.

    Args:
        allocation: Original allocation.
        actual_usage: Actual token usage per section (section_name -> tokens_used).

    Returns:
        Updated BudgetAllocation with reclaimed tokens redistributed.
    """
    reclaimed = 0
    needy: list[tuple[str, float]] = []

    for name, sb in allocation.sections.items():
        if not sb.enabled:
            continue
        used = actual_usage.get(name, 0)
        if used < sb.allocated_tokens:
            surplus = sb.allocated_tokens - used
            reclaimed += surplus
            sb.allocated_tokens = used
            sb.allocated_chars = _tokens_to_chars(used)
        elif used >= sb.allocated_tokens:
            needy.append((name, sb.priority))

    if reclaimed > 0 and needy:
        total_weight = sum(w for _, w in needy)
        if total_weight > 0:
            for name, weight in needy:
                extra = int((weight / total_weight) * reclaimed)
                sb = allocation.sections[name]
                sb.allocated_tokens = min(sb.allocated_tokens + extra, MAX_SECTION_TOKENS)
                sb.allocated_chars = _tokens_to_chars(sb.allocated_tokens)

    allocation.allocated_tokens = sum(
        sb.allocated_tokens for sb in allocation.sections.values() if sb.enabled
    )
    allocation.unallocated_tokens = max(0, allocation.total_budget_tokens - allocation.allocated_tokens)

    return allocation


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _chars_to_tokens(chars: int) -> int:
    """Approximate char→token conversion for budget purposes.

    Uses a blended ratio that accounts for CJK-heavy content typical
    in this application.  CJK chars ≈ 1 token each, Latin ≈ 3.5 chars/token.
    A weighted average of ~1.8 chars/token is used (conservative for
    mixed CJK/Latin text).
    """
    if chars <= 0:
        return 0
    return max(1, int(math.ceil(chars / 1.8)))


def _tokens_to_chars(tokens: int) -> int:
    """Approximate token→char conversion (inverse of _chars_to_tokens)."""
    if tokens <= 0:
        return 0
    return max(1, int(tokens * 1.8))
