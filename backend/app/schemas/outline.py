from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.limits import MAX_OUTLINE_MD_CHARS, MAX_OUTLINE_STRUCTURE_JSON_CHARS, validate_json_chars

ArcPhase = Literal["setup", "rising", "midpoint", "climax", "falling", "resolution"]


class OutlineOut(BaseModel):
    id: str
    project_id: str
    title: str
    content_md: str
    structure: Any | None = None
    arc_phase: ArcPhase | None = None
    created_at: datetime
    updated_at: datetime


class OutlineUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    content_md: str | None = Field(default=None, max_length=MAX_OUTLINE_MD_CHARS)
    structure: Any | None = None
    arc_phase: ArcPhase | None = None

    @field_validator("structure")
    @classmethod
    def _validate_structure(cls, v: Any | None) -> Any | None:
        return validate_json_chars(v, max_chars=MAX_OUTLINE_STRUCTURE_JSON_CHARS, field_name="structure")


class OutlineCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    content_md: str | None = Field(default=None, max_length=MAX_OUTLINE_MD_CHARS)
    structure: Any | None = None

    @field_validator("structure")
    @classmethod
    def _validate_structure(cls, v: Any | None) -> Any | None:
        return validate_json_chars(v, max_chars=MAX_OUTLINE_STRUCTURE_JSON_CHARS, field_name="structure")


class OutlineListItem(BaseModel):
    id: str
    title: str
    updated_at: datetime
    created_at: datetime
    has_chapters: bool = False
