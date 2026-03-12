from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from pydantic import Field, model_validator

from app.schemas.base import ORMModel
from app.schemas.limits import MAX_TEXT_CHARS


class CharacterCreate(ORMModel):
    name: str = Field(min_length=1, max_length=255)
    role: str | None = Field(default=None, max_length=255)
    profile: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    notes: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)


class CharacterUpdate(ORMModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    role: str | None = Field(default=None, max_length=255)
    profile: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    notes: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    arc_stages: list[dict[str, Any]] | None = Field(default=None)
    voice_samples: list[str] | None = Field(default=None)


def _parse_json_or_none(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (list, dict)):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return None
    return None


class CharacterOut(ORMModel):
    id: str
    project_id: str
    name: str
    role: str | None = None
    profile: str | None = None
    profile_version: int = 0
    arc_stages: list[dict[str, Any]] | None = None
    voice_samples: list[str] | None = None
    notes: str | None = None
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def _parse_json_fields(cls, data: Any) -> Any:
        """Parse arc_stages_json / voice_samples_json from ORM model."""
        if isinstance(data, dict):
            if "arc_stages" not in data and "arc_stages_json" in data:
                data["arc_stages"] = _parse_json_or_none(data.pop("arc_stages_json"))
            if "voice_samples" not in data and "voice_samples_json" in data:
                data["voice_samples"] = _parse_json_or_none(data.pop("voice_samples_json"))
            return data
        # ORM object
        raw_arc = getattr(data, "arc_stages_json", None)
        raw_voice = getattr(data, "voice_samples_json", None)
        if raw_arc is not None or raw_voice is not None:
            d = {}
            for field_name in cls.model_fields:
                if hasattr(data, field_name):
                    d[field_name] = getattr(data, field_name)
            d["arc_stages"] = _parse_json_or_none(raw_arc)
            d["voice_samples"] = _parse_json_or_none(raw_voice)
            return d
        return data
