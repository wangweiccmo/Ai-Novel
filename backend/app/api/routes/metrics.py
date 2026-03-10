from __future__ import annotations

from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Query, Request
from sqlalchemy import select

from app.api.deps import DbDep, UserIdDep, require_project_viewer
from app.core.errors import ok_payload
from app.db.utils import utc_now
from app.models.memory_task import MemoryTask
from app.models.project_source_document import ProjectSourceDocument
from app.models.project_task import ProjectTask

router = APIRouter()


def _avg_ms(values: list[int]) -> int | None:
    if not values:
        return None
    return int(sum(values) / len(values))


def _task_metrics(rows: list[Any], *, done_statuses: set[str]) -> dict[str, Any]:
    total = len(rows)
    queued = 0
    running = 0
    done = 0
    failed = 0

    queue_ms: list[int] = []
    run_ms: list[int] = []

    for row in rows:
        status = str(getattr(row, "status", "") or "").strip().lower()
        if status == "queued":
            queued += 1
        elif status == "running":
            running += 1
        elif status == "failed":
            failed += 1
        elif status in done_statuses:
            done += 1

        created_at = getattr(row, "created_at", None)
        started_at = getattr(row, "started_at", None)
        finished_at = getattr(row, "finished_at", None)

        if created_at is not None and started_at is not None:
            queue_ms.append(int((started_at - created_at).total_seconds() * 1000))
        if started_at is not None and finished_at is not None:
            run_ms.append(int((finished_at - started_at).total_seconds() * 1000))

    finished_total = done + failed
    success_rate = (done / finished_total) if finished_total > 0 else None

    return {
        "total": total,
        "queued": queued,
        "running": running,
        "done": done,
        "failed": failed,
        "success_rate": success_rate,
        "avg_queue_ms": _avg_ms(queue_ms),
        "avg_run_ms": _avg_ms(run_ms),
    }


def _import_metrics(rows: list[ProjectSourceDocument]) -> dict[str, Any]:
    total = len(rows)
    queued = 0
    running = 0
    done = 0
    failed = 0
    run_ms: list[int] = []

    for row in rows:
        status = str(getattr(row, "status", "") or "").strip().lower()
        if status == "queued":
            queued += 1
        elif status == "running":
            running += 1
        elif status == "failed":
            failed += 1
        elif status == "done":
            done += 1

        created_at = getattr(row, "created_at", None)
        updated_at = getattr(row, "updated_at", None)
        if created_at is not None and updated_at is not None:
            run_ms.append(int((updated_at - created_at).total_seconds() * 1000))

    finished_total = done + failed
    success_rate = (done / finished_total) if finished_total > 0 else None

    return {
        "total": total,
        "queued": queued,
        "running": running,
        "done": done,
        "failed": failed,
        "success_rate": success_rate,
        "avg_queue_ms": None,
        "avg_run_ms": _avg_ms(run_ms),
    }


@router.get("/projects/{project_id}/metrics/overview")
def get_project_metrics_overview(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    window_hours: int = Query(default=24, ge=1, le=168),
) -> dict:
    request_id = request.state.request_id
    require_project_viewer(db, project_id=project_id, user_id=user_id)

    now = utc_now()
    start = now - timedelta(hours=int(window_hours))

    project_tasks = (
        db.execute(select(ProjectTask).where(ProjectTask.project_id == project_id, ProjectTask.created_at >= start))
        .scalars()
        .all()
    )
    memory_tasks = (
        db.execute(select(MemoryTask).where(MemoryTask.project_id == project_id, MemoryTask.created_at >= start))
        .scalars()
        .all()
    )
    imports = (
        db.execute(
            select(ProjectSourceDocument).where(
                ProjectSourceDocument.project_id == project_id, ProjectSourceDocument.created_at >= start
            )
        )
        .scalars()
        .all()
    )

    data = {
        "window_hours": int(window_hours),
        "window_start": start.isoformat().replace("+00:00", "Z"),
        "as_of": now.isoformat().replace("+00:00", "Z"),
        "project_tasks": _task_metrics(project_tasks, done_statuses={"done", "succeeded"}),
        "memory_tasks": _task_metrics(memory_tasks, done_statuses={"done", "succeeded"}),
        "imports": _import_metrics(imports),
    }
    return ok_payload(request_id=request_id, data=data)
