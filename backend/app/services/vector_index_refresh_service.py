"""Vector index incremental refresh.

Tracks which data sources have changed since the last vector rebuild
and triggers incremental updates.  Leverages both the DB-backed
`ProjectSettings.vector_index_dirty` flag and an in-memory per-source
dirty set for fine-grained tracking.
"""
from __future__ import annotations

import logging
import threading
from typing import Any

from sqlalchemy.orm import Session

from app.models.project_settings import ProjectSettings

logger = logging.getLogger("ainovel")

# In-memory dirty tracking per project (fine-grained by source)
_dirty_lock = threading.Lock()
_dirty_projects: dict[str, set[str]] = {}  # project_id → set of dirty sources


def mark_vector_dirty(project_id: str, source: str) -> None:
    """Mark a source (worldbook, character, outline, chapter, story_memory) as needing vector refresh."""
    with _dirty_lock:
        _dirty_projects.setdefault(project_id, set()).add(source)


def get_dirty_sources(project_id: str) -> set[str]:
    """Get the set of dirty sources for a project."""
    with _dirty_lock:
        return set(_dirty_projects.get(project_id, set()))


def clear_dirty(project_id: str, source: str | None = None) -> None:
    """Clear dirty flag after successful refresh."""
    with _dirty_lock:
        if source is None:
            _dirty_projects.pop(project_id, None)
        elif project_id in _dirty_projects:
            _dirty_projects[project_id].discard(source)
            if not _dirty_projects[project_id]:
                del _dirty_projects[project_id]


def is_project_vector_dirty(db: Session, project_id: str) -> bool:
    """Check both DB-backed and in-memory dirty flags."""
    # In-memory check
    if get_dirty_sources(project_id):
        return True
    # DB-backed check
    row = db.get(ProjectSettings, project_id)
    if row is not None and getattr(row, "vector_index_dirty", False):
        return True
    return False


def _clear_db_dirty(db: Session, project_id: str) -> None:
    """Clear the DB-backed dirty flag."""
    row = db.get(ProjectSettings, project_id)
    if row is not None:
        row.vector_index_dirty = False


def incremental_vector_refresh(
    db: Session,
    *,
    project_id: str,
    force: bool = False,
) -> dict[str, Any]:
    """Refresh vector index for dirty sources only.

    Checks both the in-memory per-source dirty set and the DB-backed
    `vector_index_dirty` flag.  Returns a summary of what was refreshed.
    """
    if force:
        dirty = {"worldbook", "outline", "chapter", "story_memory"}
    else:
        dirty = get_dirty_sources(project_id)
        # Also check DB-backed flag (set by worldbook/character CRUD)
        row = db.get(ProjectSettings, project_id)
        if row is not None and getattr(row, "vector_index_dirty", False):
            dirty = dirty | {"worldbook"}  # Worldbook is the main source tracked via DB flag

    if not dirty:
        return {"project_id": project_id, "refreshed": [], "skipped_reason": "no_dirty_sources"}

    from app.services.vector_rag_service import vector_rag_status, rebuild_project

    status = vector_rag_status(project_id=project_id)
    if not status.get("enabled"):
        return {
            "project_id": project_id,
            "refreshed": [],
            "skipped_reason": "vector_rag_disabled",
            "disabled_reason": status.get("disabled_reason"),
        }

    refreshed: list[str] = []
    errors: list[dict[str, str]] = []

    try:
        rebuild_project(db=db, project_id=project_id, sources=list(dirty))
        refreshed = list(dirty)
        # Clear both in-memory and DB-backed dirty flags
        for src in dirty:
            clear_dirty(project_id, src)
        _clear_db_dirty(db, project_id)
        db.commit()
    except Exception as exc:
        db.rollback()
        logger.warning("vector_refresh_failed project=%s: %s", project_id, exc, exc_info=True)
        errors.append({"source": ",".join(dirty), "error": str(type(exc).__name__)})

    return {
        "project_id": project_id,
        "refreshed": refreshed,
        "errors": errors,
    }


def auto_refresh_if_dirty(
    db: Session,
    *,
    project_id: str,
) -> dict[str, Any] | None:
    """Convenience: check if dirty and refresh if so. Returns None if clean."""
    if not is_project_vector_dirty(db, project_id):
        return None
    return incremental_vector_refresh(db, project_id=project_id)
