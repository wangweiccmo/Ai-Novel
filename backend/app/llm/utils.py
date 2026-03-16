from __future__ import annotations

from urllib.parse import urlparse

from app.core.errors import AppError
from app.llm.registry import provider_contract, recommended_max_tokens


def normalize_base_url(value: str) -> str:
    normalized = value.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in ("http", "https"):
        raise AppError(code="LLM_CONFIG_ERROR", message="base_url 必须以 http:// 或 https:// 开头", status_code=400)
    if not parsed.netloc:
        raise AppError(code="LLM_CONFIG_ERROR", message="base_url 不合法", status_code=400)
    return normalized


def default_max_tokens_for_provider(provider: str) -> int:
    try:
        return provider_contract(provider).recommended_max_tokens
    except Exception:
        try:
            return recommended_max_tokens(provider, model=None, mode="audit")
        except Exception:
            return 12000


def default_max_tokens(provider: str, model: str | None = None) -> int:
    try:
        return recommended_max_tokens(provider, model=model, mode="audit")
    except Exception:
        return 12000


def is_default_like_max_tokens(provider: str, value: int | None) -> bool:
    if value is None:
        return True
    p = (provider or "").strip()
    if p in ("openai", "openai_responses", "openai_compatible", "openai_responses_compatible"):
        return value in (32000, 8192)
    if p in ("anthropic", "gemini"):
        return value == 8192
    return False
