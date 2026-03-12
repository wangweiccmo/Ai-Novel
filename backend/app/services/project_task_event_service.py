from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.logging import exception_log_fields, log_event, redact_secrets_text
from app.core.secrets import redact_api_keys
from app.db.utils import utc_now
from app.models.project_task import ProjectTask
from app.models.project_task_event import ProjectTaskEvent
from app.services.task_error_visibility import get_user_visible_errors


def _compact_json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _compact_json_loads(value: str | None) -> Any | None:
    if value is None:
        return None
    try:
        return json.loads(value)
    except Exception:
        return None


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def _task_error_fields(task: ProjectTask) -> tuple[str | None, str | None]:
    value = _compact_json_loads(task.error_json) if task.error_json else None
    if not isinstance(value, dict):
        return None, None
    error_type = str(value.get("error_type") or "").strip() or None
    error_message = str(value.get("message") or "").strip() or None
    return error_type, error_message


def project_task_event_task_payload(task: ProjectTask) -> dict[str, Any]:
    error_type, error_message = _task_error_fields(task)
    return {
        "id": str(task.id),
        "project_id": str(task.project_id),
        "actor_user_id": task.actor_user_id,
        "kind": str(task.kind),
        "status": str(task.status),
        "idempotency_key": str(getattr(task, "idempotency_key", "") or ""),
        "attempt": int(getattr(task, "attempt", 0) or 0),
        "error_type": error_type,
        "error_message": error_message,
        "user_visible_errors": get_user_visible_errors(task),
        "timings": {
            "created_at": _iso(task.created_at),
            "started_at": _iso(task.started_at),
            "heartbeat_at": _iso(getattr(task, "heartbeat_at", None)),
            "finished_at": _iso(task.finished_at),
            "updated_at": _iso(task.updated_at),
        },
    }


def append_project_task_event(
    db: Session,
    *,
    task: ProjectTask,
    event_type: str,
    payload: dict[str, Any] | None = None,
    source: str | None = None,
) -> ProjectTaskEvent:
    body = redact_api_keys(dict(payload or {}))
    if source and not body.get("source"):
        body["source"] = source
    if "task" not in body:
        body["task"] = project_task_event_task_payload(task)
    event = ProjectTaskEvent(
        project_id=str(task.project_id),
        task_id=str(task.id),
        kind=str(task.kind),
        event_type=str(event_type),
        payload_json=_compact_json_dumps(body) if body else None,
    )
    db.add(event)
    db.flush()
    return event


def reset_project_task_to_queued(*, task: ProjectTask, increment_retry_count: bool) -> None:
    task.status = "queued"
    task.started_at = None
    task.heartbeat_at = None
    task.finished_at = None
    task.result_json = None
    task.error_json = None
    task.updated_at = utc_now()
    if not increment_retry_count:
        return
    try:
        value = _compact_json_loads(task.params_json) if task.params_json else {}
        if isinstance(value, dict):
            value["retry_count"] = int(value.get("retry_count") or 0) + 1
            task.params_json = _compact_json_dumps(value)
    except Exception:
        return


def mark_project_task_enqueue_failed(
    db: Session,
    *,
    task: ProjectTask,
    exc: Exception,
    logger: Any,
    request_id: str | None,
) -> None:
    fields = exception_log_fields(exc)
    safe_message = redact_secrets_text(str(exc)).replace("\n", " ").strip()
    if not safe_message:
        safe_message = type(exc).__name__

    task.status = "failed"
    task.heartbeat_at = None
    task.finished_at = utc_now()
    if isinstance(exc, AppError):
        details = exc.details if isinstance(exc.details, dict) else {}
        error_payload = {
            "error_type": type(exc).__name__,
            "code": str(exc.code),
            "message": safe_message[:400],
            "details": redact_api_keys(details),
        }
    else:
        error_payload = {"error_type": type(exc).__name__, "message": safe_message[:400]}

    task.error_json = _compact_json_dumps(error_payload)
    append_project_task_event(
        db,
        task=task,
        event_type="failed",
        source="queue_enqueue",
        payload={
            "reason": "enqueue_failed",
            "request_id": request_id,
            "error": error_payload,
        },
    )
    db.commit()
    log_event(
        logger,
        "warning",
        event="PROJECT_TASK_ENQUEUE_ERROR",
        task_id=str(task.id),
        project_id=str(task.project_id),
        kind=str(task.kind),
        error_type=type(exc).__name__,
        request_id=request_id,
        **fields,
    )


def emit_and_enqueue_project_task(
    db: Session,
    *,
    task: ProjectTask,
    request_id: str | None,
    logger: Any,
    event_type: str | None,
    source: str,
    payload: dict[str, Any] | None = None,
) -> str:
    if event_type is not None:
        append_project_task_event(db, task=task, event_type=event_type, source=source, payload=payload)
        db.commit()

    from app.services.task_queue import get_task_queue

    queue = get_task_queue()
    try:
        queue.enqueue(kind="project_task", task_id=str(task.id))
    except Exception as exc:
        mark_project_task_enqueue_failed(db, task=task, exc=exc, logger=logger, request_id=request_id)
    return str(task.id)


def list_project_task_events_after(
    db: Session,
    *,
    project_id: str,
    after_seq: int,
    limit: int = 200,
) -> list[ProjectTaskEvent]:
    return (
        db.execute(
            select(ProjectTaskEvent)
            .where(ProjectTaskEvent.project_id == project_id, ProjectTaskEvent.seq > after_seq)
            .order_by(ProjectTaskEvent.seq.asc())
            .limit(limit)
        )
        .scalars()
        .all()
    )


def latest_project_task_event_seq(db: Session, *, project_id: str) -> int:
    value = db.execute(select(func.max(ProjectTaskEvent.seq)).where(ProjectTaskEvent.project_id == project_id)).scalar_one()
    return int(value or 0)


def build_project_task_active_snapshot(db: Session, *, project_id: str, limit: int = 200) -> dict[str, Any]:
    rows = (
        db.execute(
            select(ProjectTask)
            .where(
                ProjectTask.project_id == project_id,
                ProjectTask.status.in_(["queued", "running"]),
            )
            .order_by(ProjectTask.created_at.desc(), ProjectTask.id.desc())
            .limit(limit)
        )
        .scalars()
        .all()
    )
    return {
        "project_id": project_id,
        "cursor": latest_project_task_event_seq(db, project_id=project_id),
        "snapshot_at": _iso(utc_now()),
        "active_tasks": [project_task_event_task_payload(row) for row in rows],
    }


def project_task_event_to_dict(event: ProjectTaskEvent) -> dict[str, Any]:
    payload = _compact_json_loads(event.payload_json) if event.payload_json else None
    if not isinstance(payload, dict):
        payload = {}
    return {
        "seq": int(event.seq),
        "project_id": str(event.project_id),
        "task_id": str(event.task_id),
        "kind": str(event.kind),
        "event_type": str(event.event_type),
        "created_at": _iso(event.created_at),
        "payload": payload,
    }
