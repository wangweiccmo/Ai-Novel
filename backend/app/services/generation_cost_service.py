"""Generation cost estimation service.

Estimates the token cost and monetary expense of a generation request
based on context size, target word count, and model pricing.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.prompt_budget import estimate_tokens


# Pricing per 1M tokens (USD).  Updated periodically.
# Format: {provider/model_prefix: (input_per_1m, output_per_1m)}
_PRICING_TABLE: dict[str, tuple[float, float]] = {
    # OpenAI
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4-turbo": (10.00, 30.00),
    "gpt-4": (30.00, 60.00),
    "gpt-3.5-turbo": (0.50, 1.50),
    "o1": (15.00, 60.00),
    "o1-mini": (3.00, 12.00),
    "o3-mini": (1.10, 4.40),
    # Anthropic
    "claude-3-5-sonnet": (3.00, 15.00),
    "claude-3-5-haiku": (0.80, 4.00),
    "claude-3-opus": (15.00, 75.00),
    "claude-3-haiku": (0.25, 1.25),
    "claude-sonnet-4": (3.00, 15.00),
    "claude-opus-4": (15.00, 75.00),
    "claude-haiku-4": (0.80, 4.00),
    # DeepSeek
    "deepseek-chat": (0.14, 0.28),
    "deepseek-reasoner": (0.55, 2.19),
    # Google
    "gemini-1.5-pro": (1.25, 5.00),
    "gemini-1.5-flash": (0.075, 0.30),
    "gemini-2.0-flash": (0.10, 0.40),
    # Fallback
    "_default": (3.00, 15.00),
}


@dataclass
class CostEstimate:
    input_tokens: int
    output_tokens: int
    total_tokens: int
    input_cost_usd: float
    output_cost_usd: float
    total_cost_usd: float
    model: str
    pricing_source: str  # "exact" | "prefix_match" | "default"


def _find_pricing(model: str) -> tuple[tuple[float, float], str]:
    """Find the best matching pricing entry for a model."""
    model_lower = (model or "").strip().lower()

    # Exact match first
    if model_lower in _PRICING_TABLE:
        return _PRICING_TABLE[model_lower], "exact"

    # Prefix match (e.g. "gpt-4o-2024-08-06" → "gpt-4o")
    for prefix, pricing in sorted(_PRICING_TABLE.items(), key=lambda x: -len(x[0])):
        if prefix == "_default":
            continue
        if model_lower.startswith(prefix):
            return pricing, "prefix_match"

    return _PRICING_TABLE["_default"], "default"


def estimate_generation_cost(
    *,
    context_text: str = "",
    context_tokens: int | None = None,
    target_words: int = 3000,
    model: str = "",
) -> CostEstimate:
    """Estimate the cost of a generation request.

    Args:
        context_text: The assembled prompt context (system + user + memory).
        context_tokens: Pre-computed token count (if available, used instead of context_text).
        target_words: Target output word count.
        model: Model identifier for pricing lookup.
    """
    if context_tokens is not None:
        input_tokens = int(context_tokens)
    else:
        input_tokens = estimate_tokens(context_text) if context_text else 0

    # Estimate output tokens: Chinese text ≈ 1.5 tokens/char, avg 2 chars/word
    output_tokens = int(target_words * 2 * 1.5)

    pricing, source = _find_pricing(model)
    input_per_1m, output_per_1m = pricing

    input_cost = (input_tokens / 1_000_000) * input_per_1m
    output_cost = (output_tokens / 1_000_000) * output_per_1m

    return CostEstimate(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        input_cost_usd=round(input_cost, 6),
        output_cost_usd=round(output_cost, 6),
        total_cost_usd=round(input_cost + output_cost, 6),
        model=model,
        pricing_source=source,
    )


def format_cost_estimate(est: CostEstimate) -> dict[str, Any]:
    """Format for API response."""
    return {
        "input_tokens": est.input_tokens,
        "output_tokens": est.output_tokens,
        "total_tokens": est.total_tokens,
        "cost_usd": {
            "input": est.input_cost_usd,
            "output": est.output_cost_usd,
            "total": est.total_cost_usd,
        },
        "model": est.model,
        "pricing_source": est.pricing_source,
    }
