from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.utils import utc_now


class ProjectModuleSlot(Base):
    __tablename__ = "project_module_slots"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    llm_profile_id: Mapped[str] = mapped_column(
        ForeignKey("llm_profiles.id", ondelete="CASCADE"),
        nullable=False,
    )
    display_name: Mapped[str] = mapped_column(String(64), nullable=False)
    is_main: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)


Index("ix_pms_project_id", ProjectModuleSlot.project_id)
Index("ix_pms_profile_id", ProjectModuleSlot.llm_profile_id)
Index(
    "uq_pms_project_main",
    ProjectModuleSlot.project_id,
    unique=True,
    sqlite_where=ProjectModuleSlot.is_main.is_(True),
    postgresql_where=ProjectModuleSlot.is_main.is_(True),
)
