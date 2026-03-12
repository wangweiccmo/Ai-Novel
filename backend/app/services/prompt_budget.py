from __future__ import annotations

import logging
import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

logger = logging.getLogger("ainovel.prompt_budget")

# ---------------------------------------------------------------------------
# Tokenizer backend: prefer tiktoken when available, fall back to heuristic.
# ---------------------------------------------------------------------------

_tokenizer = None
_tokenizer_checked = False


def _get_tokenizer():
    """Lazy-load tiktoken cl100k_base encoder (used by GPT-4 / Claude-compatible)."""
    global _tokenizer, _tokenizer_checked
    if _tokenizer_checked:
        return _tokenizer
    _tokenizer_checked = True
    try:
        import tiktoken  # noqa: F401

        _tokenizer = tiktoken.get_encoding("cl100k_base")
        logger.info("prompt_budget: tiktoken cl100k_base encoder loaded")
    except Exception:
        _tokenizer = None
        logger.info("prompt_budget: tiktoken not available, using heuristic estimator")
    return _tokenizer


# ---------------------------------------------------------------------------
# CJK detection helpers
# ---------------------------------------------------------------------------

def _is_cjk(code: int) -> bool:
    """Check if a unicode code point is a CJK ideograph."""
    return (
        (0x4E00 <= code <= 0x9FFF)
        or (0x3400 <= code <= 0x4DBF)
        or (0x20000 <= code <= 0x2A6DF)
        or (0xF900 <= code <= 0xFAFF)
        or (0x2F800 <= code <= 0x2FA1F)
    )


# ---------------------------------------------------------------------------
# Token estimation
# ---------------------------------------------------------------------------

# Safety margin applied to max_tokens budgets to avoid overflows.
TOKEN_BUDGET_SAFETY_MARGIN = 0.1


def estimate_tokens(text: str) -> int:
    """
    Estimate the number of tokens in *text*.

    Uses tiktoken when available for accurate counts; otherwise falls back to
    an improved heuristic:
    - CJK ideographs: ~1 token each (plus overhead for multi-char sequences)
    - Punctuation / whitespace: ~1 token per char
    - Latin text: ~3.5 chars per token (conservative, was 4.0)

    The heuristic intentionally over-estimates slightly so that budget trimming
    is conservative (better to include a bit less than to exceed limits).
    """
    if not text:
        return 0

    enc = _get_tokenizer()
    if enc is not None:
        try:
            return len(enc.encode(text, disallowed_special=()))
        except Exception:
            pass

    # Improved heuristic fallback
    cjk = 0
    punct_ws = 0
    for ch in text:
        code = ord(ch)
        if _is_cjk(code):
            cjk += 1
        elif ch in (' ', '\n', '\t', '\r') or (0x2000 <= code <= 0x206F) or (0x3000 <= code <= 0x303F):
            punct_ws += 1

    other = max(0, len(text) - cjk - punct_ws)
    # CJK: 1 token each + 5% overhead for tokenizer artifacts
    # Punctuation/whitespace: roughly 1 token per char
    # Other (Latin, etc.): ~3.5 chars per token (more conservative than 4.0)
    return int(math.ceil(cjk * 1.05)) + punct_ws + int(math.ceil(other / 3.5))


def estimate_tokens_with_margin(text: str, *, margin: float = TOKEN_BUDGET_SAFETY_MARGIN) -> int:
    """Estimate tokens and add a safety margin."""
    raw = estimate_tokens(text)
    return int(math.ceil(raw * (1.0 + margin)))


def chars_to_token_budget(char_limit: int) -> int:
    """
    Convert a character-based budget to an approximate token budget.

    This is used to bridge the gap where legacy code passes char limits but the
    system now works in token budgets internally.
    """
    if char_limit <= 0:
        return 0
    # Conservative: assume ~2.5 chars per token for mixed CJK/Latin text
    return max(1, int(math.ceil(char_limit / 2.5)))


def token_budget_to_chars(token_budget: int) -> int:
    """Convert a token budget back to approximate character limit."""
    if token_budget <= 0:
        return 0
    return max(1, int(token_budget * 2.5))


def safe_max_tokens(total_budget: int, prompt_tokens: int) -> int:
    """
    Calculate safe max_tokens for generation given total context budget and
    prompt token count. Reserves TOKEN_BUDGET_SAFETY_MARGIN for overhead.
    """
    if total_budget <= 0:
        return 0
    reserved = int(math.ceil(total_budget * TOKEN_BUDGET_SAFETY_MARGIN))
    available = total_budget - prompt_tokens - reserved
    return max(0, available)


def trim_text_to_tokens(text: str, max_tokens: int) -> str:
    """Trim *text* so it fits within *max_tokens*."""
    if max_tokens <= 0:
        return ""
    if not text:
        return ""
    if estimate_tokens(text) <= max_tokens:
        return text

    # Binary search by character length as an approximation.
    lo = 0
    hi = len(text)
    best = 0
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = text[:mid]
        tokens = estimate_tokens(candidate)
        if tokens <= max_tokens:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return text[:best]

