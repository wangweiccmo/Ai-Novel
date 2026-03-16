from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.schemas.llm import LLMProvider
from app.schemas.llm_profiles import LLMProfileOut
from app.schemas.limits import MAX_JSON_CHARS_SMALL, validate_json_chars


class LLMTaskCatalogItemOut(BaseModel):
    key: str
    label: str
    group: str
    description: str


class LLMTaskPresetOut(BaseModel):
    project_id: str
    task_key: str
    llm_profile_id: str | None = None
    module_slot_id: str | None = None
    module_display_name: str | None = None
    module_profile: LLMProfileOut | None = None
    provider: LLMProvider
    provider_key: str | None = None
    model_key: str | None = None
    known_model: bool = False
    contract_mode: str = "audit"
    pricing: dict[str, Any] = Field(default_factory=dict)
    base_url: str | None = None
    model: str
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    max_tokens_limit: int | None = None
    max_tokens_recommended: int | None = None
    context_window_limit: int | None = None
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    top_k: int | None = None
    stop: list[str] = Field(default_factory=list)
    timeout_seconds: int | None = None
    extra: dict[str, Any] = Field(default_factory=dict)
    source: str = "task_override"


class LLMTaskPresetPutRequest(BaseModel):
    module_slot_id: str | None = Field(default=None, max_length=36)
    llm_profile_id: str | None = Field(default=None, max_length=36)
    provider: LLMProvider | None = None
    base_url: str | None = Field(default=None, max_length=2048)
    model: str | None = Field(default=None, max_length=255)
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    top_k: int | None = None
    stop: list[str] = Field(default_factory=list, max_length=32)
    timeout_seconds: int | None = Field(default=None, ge=1, le=1800)
    extra: dict[str, Any] = Field(default_factory=dict, max_length=200)

    @field_validator("llm_profile_id")
    @classmethod
    def _normalize_profile_id(cls, v: str | None) -> str | None:
        if v is None:
            return None
        norm = v.strip()
        return norm or None

    @field_validator("stop")
    @classmethod
    def _validate_stop(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for item in v or []:
            if not isinstance(item, str):
                raise ValueError("stop must be strings")
            norm = item.strip()
            if not norm:
                raise ValueError("stop cannot contain empty strings")
            if len(norm) > 256:
                raise ValueError("stop item too long")
            out.append(norm)
        return out

    @field_validator("extra")
    @classmethod
    def _validate_extra(cls, v: dict[str, Any]) -> dict[str, Any]:
        for key in (v or {}).keys():
            if not isinstance(key, str):
                raise ValueError("extra keys must be strings")
            if len(key) > 128:
                raise ValueError("extra key too long")
        return validate_json_chars(v, max_chars=MAX_JSON_CHARS_SMALL, field_name="extra") or {}
