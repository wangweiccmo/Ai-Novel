from __future__ import annotations

from typing import Literal

LLMProvider = Literal[
    "openai",
    "openai_responses",
    "openai_compatible",
    "openai_responses_compatible",
    "anthropic",
    "gemini",
    "deepseek",
]
