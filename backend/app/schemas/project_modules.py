from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.base import RequestModel
from app.schemas.llm_profiles import LLMProfileCreate, LLMProfileOut, LLMProfileUpdate


class ModuleSlotOut(BaseModel):
    id: str
    display_name: str
    is_main: bool
    sort_order: int
    profile: LLMProfileOut


class ModuleSlotCreate(RequestModel):
    display_name: str = Field(min_length=1, max_length=64)
    llm_profile_id: str | None = Field(default=None, max_length=36)
    new_profile: LLMProfileCreate | None = None


class ModuleSlotUpdate(RequestModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=64)
    llm_profile_id: str | None = Field(default=None, max_length=36)
    profile_update: LLMProfileUpdate | None = None
