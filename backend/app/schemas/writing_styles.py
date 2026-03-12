from __future__ import annotations

from datetime import datetime

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.base import RequestModel


class WritingStyleOut(BaseModel):
    id: str
    owner_user_id: str | None = None
    name: str
    description: str | None = None
    prompt_content: str
    scene_overrides: dict[str, str] | None = None
    is_preset: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


class WritingStyleCreateRequest(RequestModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1000)
    prompt_content: str = Field(min_length=1, max_length=8000)
    scene_overrides: dict[str, str] | None = Field(default=None)


class WritingStyleUpdateRequest(RequestModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1000)
    prompt_content: str | None = Field(default=None, min_length=1, max_length=8000)
    scene_overrides: dict[str, str] | None = Field(default=None)


class ProjectDefaultStyleOut(BaseModel):
    project_id: str
    style_id: str | None = None
    updated_at: datetime | None = None


class ProjectDefaultStylePutRequest(RequestModel):
    style_id: str | None = None


class StylePreviewRequest(RequestModel):
    style_id_a: str | None = Field(default=None, description="第一个风格 ID（为空则使用项目默认）")
    style_id_b: str | None = Field(default=None, description="第二个风格 ID 用于对比")
    scene_type: str | None = Field(default=None, max_length=64)
