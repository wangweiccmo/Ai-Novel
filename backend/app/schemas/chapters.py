from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.base import ORMModel
from app.schemas.limits import MAX_BULK_CREATE_CHAPTERS, MAX_MD_CHARS, MAX_TEXT_CHARS


ChapterStatus = Literal["planned", "drafting", "proofreading", "done"]


class ChapterCreate(BaseModel):
    number: int = Field(ge=1)
    title: str | None = Field(default=None, max_length=255)
    plan: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    status: ChapterStatus = "planned"


class ChapterUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    plan: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    content_md: str | None = Field(default=None, max_length=MAX_MD_CHARS)
    summary: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)
    status: ChapterStatus | None = None


class BulkChapter(BaseModel):
    number: int = Field(ge=1)
    title: str | None = Field(default=None, max_length=255)
    plan: str | None = Field(default=None, max_length=MAX_TEXT_CHARS)


class BulkCreateRequest(BaseModel):
    chapters: list[BulkChapter] = Field(min_length=1, max_length=MAX_BULK_CREATE_CHAPTERS)


class ChapterOut(ORMModel):
    id: str
    project_id: str
    outline_id: str
    number: int
    title: str | None = None
    plan: str | None = None
    content_md: str | None = None
    summary: str | None = None
    status: ChapterStatus
    updated_at: datetime


class ChapterDetailOut(ChapterOut):
    pass


class ChapterListItemOut(ORMModel):
    id: str
    project_id: str
    outline_id: str
    number: int
    title: str | None = None
    status: ChapterStatus
    updated_at: datetime
    has_plan: bool
    has_summary: bool
    has_content: bool
    word_count: int = 0
    generation_count: int = 0


class ChapterMetaPageOut(BaseModel):
    chapters: list[ChapterListItemOut]
    next_cursor: int | None = None
    has_more: bool = False
    returned: int = 0
    total: int = 0
