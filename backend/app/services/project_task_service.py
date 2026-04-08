from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.logging import exception_log_fields, log_event, redact_secrets_text
from app.core.secrets import redact_api_keys
from app.db.session import SessionLocal
from app.db.utils import new_id, utc_now
from app.models.project_task import ProjectTask
from app.services.task_error_visibility import get_user_visible_errors, record_user_visible_error
from app.services.project_task_event_service import (
    append_project_task_event,
    mark_project_task_enqueue_failed,
    reset_project_task_to_queued,
)
from app.services.project_task_runtime_service import start_project_task_heartbeat, stop_project_task_heartbeat

logger = logging.getLogger("ainovel")


_ALLOWED_TASK_STATUSES_QUERY = {"queued", "running", "paused", "failed", "done", "succeeded", "canceled"}
_TASK_DONE_ALIASES = {"succeeded", "done"}


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
    s = dt.isoformat()
    return s.replace("+00:00", "Z")


def _parse_dt(value: object) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    s = str(value).strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


def _task_status_to_public(status: str) -> str:
    s = str(status or "").strip().lower()
    return "done" if s in _TASK_DONE_ALIASES else s


def _task_error_fields(task: ProjectTask) -> tuple[str | None, str | None]:
    value = _compact_json_loads(task.error_json) if task.error_json else None
    if not isinstance(value, dict):
        return None, None
    error_type = str(value.get("error_type") or "").strip() or None
    error_message = str(value.get("message") or "").strip() or None
    return error_type, error_message


def project_task_to_dict(*, task: ProjectTask, include_payloads: bool) -> dict[str, Any]:
    error_type, error_message = _task_error_fields(task)

    data: dict[str, Any] = {
        "id": str(task.id),
        "project_id": str(task.project_id),
        "actor_user_id": task.actor_user_id,
        "kind": str(task.kind),
        "status": _task_status_to_public(str(task.status)),
        "idempotency_key": str(getattr(task, "idempotency_key", "") or ""),
        "attempt": int(getattr(task, "attempt", 0) or 0),
        "error_type": error_type,
        "error_message": error_message,
        "timings": {
            "created_at": _iso(task.created_at),
            "started_at": _iso(task.started_at),
            "heartbeat_at": _iso(getattr(task, "heartbeat_at", None)),
            "finished_at": _iso(task.finished_at),
            "updated_at": _iso(task.updated_at),
        },
    }

    if include_payloads:
        params = _compact_json_loads(task.params_json) if task.params_json else None
        result = _compact_json_loads(task.result_json) if task.result_json else None
        err = _compact_json_loads(task.error_json) if task.error_json else None
        data["params"] = redact_api_keys(params) if params is not None else None
        data["result"] = redact_api_keys(result) if result is not None else None
        data["error"] = redact_api_keys(err) if err is not None else None

    data["user_visible_errors"] = get_user_visible_errors(task)

    return data


def _emit_and_enqueue_project_task(
    *,
    db: Session,
    task: ProjectTask,
    request_id: str | None,
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


def list_project_tasks(
    *,
    db: Session,
    project_id: str,
    status: str | None,
    kind: str | None,
    before: str | None,
    limit: int,
) -> dict[str, Any]:
    status_norm = str(status or "").strip().lower() or None
    if status_norm is not None:
        if status_norm == "succeeded":
            status_norm = "done"
        if status_norm not in _ALLOWED_TASK_STATUSES_QUERY:
            raise AppError.validation(details={"reason": "invalid_status", "status": status})

    kind_norm = str(kind or "").strip() or None

    before_raw = str(before or "").strip()
    before_dt = _parse_dt(before_raw) if before_raw else None
    if before_raw and before_dt is None:
        raise AppError.validation(details={"reason": "invalid_before", "before": before})

    q = select(ProjectTask).where(ProjectTask.project_id == project_id)
    if status_norm is not None:
        if status_norm == "done":
            q = q.where(ProjectTask.status.in_(sorted(_TASK_DONE_ALIASES)))
        else:
            q = q.where(ProjectTask.status == status_norm)
    if kind_norm is not None:
        q = q.where(ProjectTask.kind == kind_norm)
    if before_dt is not None:
        q = q.where(ProjectTask.created_at < before_dt)

    rows = db.execute(q.order_by(ProjectTask.created_at.desc(), ProjectTask.id.desc()).limit(limit + 1)).scalars().all()
    has_more = len(rows) > limit
    rows = rows[:limit]

    items = [project_task_to_dict(task=t, include_payloads=False) for t in rows]
    next_before = _iso(rows[-1].created_at) if (has_more and rows) else None
    return {"items": items, "next_before": next_before}


def schedule_worldbook_auto_update_task(
    *,
    db: Session | None = None,
    project_id: str,
    actor_user_id: str | None,
    request_id: str | None,
    chapter_id: str | None,
    chapter_token: str | None,
    reason: str,
) -> str | None:
    """
    Fail-soft scheduler: ensure/enqueue a ProjectTask(kind=worldbook_auto_update).

    Idempotency key is chapter-scoped when chapter_id is provided, so a chapter can be marked done and re-triggered
    later (with a new token) without creating duplicate tasks for the same chapter version.
    """

    pid = str(project_id or "").strip()
    if not pid:
        return None

    cid = str(chapter_id or "").strip() or None
    token_norm = str(chapter_token or "").strip() or utc_now().isoformat().replace("+00:00", "Z")
    reason_norm = str(reason or "").strip() or "dirty"

    if cid:
        idempotency_key = f"worldbook:chapter:{cid}:since:{token_norm}:v1"
    else:
        idempotency_key = f"worldbook:project:since:{token_norm}:v1"

    owns_session = db is None
    if db is None:
        db = SessionLocal()
    try:
        task = (
            db.execute(
                select(ProjectTask).where(
                    ProjectTask.project_id == pid,
                    ProjectTask.idempotency_key == idempotency_key,
                )
            )
            .scalars()
            .first()
        )

        created_task = False
        if task is None:
            created_task = True
            task = ProjectTask(
                id=new_id(),
                project_id=pid,
                actor_user_id=actor_user_id,
                kind="worldbook_auto_update",
                status="queued",
                idempotency_key=idempotency_key,
                params_json=_compact_json_dumps(
                    {
                        "reason": reason_norm,
                        "request_id": (str(request_id or "").strip() or None),
                        "chapter_id": cid,
                        "chapter_token": token_norm,
                        "triggered_at": utc_now().isoformat().replace("+00:00", "Z"),
                    }
                ),
                result_json=None,
                error_json=None,
            )
            db.add(task)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                task = (
                    db.execute(
                        select(ProjectTask).where(
                            ProjectTask.project_id == pid,
                            ProjectTask.idempotency_key == idempotency_key,
                        )
                    )
                    .scalars()
                    .first()
                )

        if task is None:
            return None

        # Retry policy: allow re-scheduling the same idempotency_key when the previous attempt failed.
        # This keeps "chapter done" and manual triggers idempotent while still allowing a one-click retry.
        status_norm = str(getattr(task, "status", "") or "").strip().lower()
        actor_norm = str(actor_user_id or "").strip() or None
        if status_norm in {"queued", "failed"} and actor_norm and not (str(getattr(task, "actor_user_id", "") or "").strip()):
            # If a user-triggered run provides actor_user_id, fill it for previously system-triggered tasks.
            task.actor_user_id = actor_norm
            db.commit()

        event_type = "queued" if created_task else None
        if status_norm == "failed":
            # Enforce hard retry limit on auto-retry
            try:
                _params = _compact_json_loads(task.params_json) if task.params_json else {}
                _retry_count = int((_params or {}).get("retry_count") or 0) if isinstance(_params, dict) else 0
            except Exception:
                _retry_count = 0
            if _retry_count >= 5:
                return str(task.id)
            reset_project_task_to_queued(task=task, increment_retry_count=True)
            db.commit()
            event_type = "retry"
        elif status_norm in {"running", "succeeded"}:
            # Avoid enqueue storms; worker will no-op anyway.
            return str(task.id)

        return _emit_and_enqueue_project_task(
            db=db,
            task=task,
            request_id=request_id,
            event_type=event_type,
            source="scheduler",
            payload={"reason": reason_norm, "request_id": request_id, "chapter_id": cid, "chapter_token": token_norm},
        )
    finally:
        if owns_session:
            db.close()


def schedule_fractal_rebuild_task(
    *,
    db: Session | None = None,
    project_id: str,
    actor_user_id: str | None,
    request_id: str | None,
    chapter_id: str | None,
    chapter_token: str | None,
    reason: str,
) -> str | None:
    """
    Fail-soft scheduler: ensure/enqueue a ProjectTask(kind=fractal_rebuild).

    Used to avoid blocking request latency on chapter status transition (done) while still allowing dev inline execution.
    """

    pid = str(project_id or "").strip()
    if not pid:
        return None

    cid = str(chapter_id or "").strip() or None
    token_norm = str(chapter_token or "").strip() or utc_now().isoformat().replace("+00:00", "Z")
    reason_norm = str(reason or "").strip() or "dirty"

    if cid:
        idempotency_key = f"fractal:chapter:{cid}:since:{token_norm}:v1"
    else:
        idempotency_key = f"fractal:project:since:{token_norm}:v1"

    owns_session = db is None
    if db is None:
        db = SessionLocal()
    try:
        task = (
            db.execute(
                select(ProjectTask).where(
                    ProjectTask.project_id == pid,
                    ProjectTask.idempotency_key == idempotency_key,
                )
            )
            .scalars()
            .first()
        )

        created_task = False
        if task is None:
            created_task = True
            task = ProjectTask(
                id=new_id(),
                project_id=pid,
                actor_user_id=actor_user_id,
                kind="fractal_rebuild",
                status="queued",
                idempotency_key=idempotency_key,
                params_json=_compact_json_dumps(
                    {
                        "reason": reason_norm,
                        "request_id": (str(request_id or "").strip() or None),
                        "chapter_id": cid,
                        "chapter_token": token_norm,
                        "triggered_at": utc_now().isoformat().replace("+00:00", "Z"),
                    }
                ),
                result_json=None,
                error_json=None,
            )
            db.add(task)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                task = (
                    db.execute(
                        select(ProjectTask).where(
                            ProjectTask.project_id == pid,
                            ProjectTask.idempotency_key == idempotency_key,
                        )
                    )
                    .scalars()
                    .first()
                )

        if task is None:
            return None

        return _emit_and_enqueue_project_task(
            db=db,
            task=task,
            request_id=request_id,
            event_type="queued" if created_task else None,
            source="scheduler",
            payload={"reason": reason_norm, "request_id": request_id, "chapter_id": cid, "chapter_token": token_norm},
        )
    finally:
        if owns_session:
            db.close()


def _task_params_reason(params_json: str | None) -> str:
    if not params_json:
        return ""
    try:
        value = json.loads(params_json)
    except Exception:
        return ""
    if not isinstance(value, dict):
        return ""
    return str(value.get("reason") or "").strip()


def _since_prefix(idempotency_key: str) -> str | None:
    key = str(idempotency_key or "").strip()
    if not key:
        return None
    marker = ":since:"
    if marker not in key:
        return None
    return key.split(marker, 1)[0] + marker


def _dedupe_queued_chapter_tasks(*, db: Session, project_id: str, keep_task: ProjectTask) -> int:
    """
    Reduce task storms for chapter_done triggers:
    keep the latest queued task for a given idempotency prefix (`...:since:`) and cancel older queued tasks.

    Safety:
    - only cancels queued tasks
    - only cancels tasks whose params_json.reason starts with "chapter" (avoid canceling manual tasks)
    """

    pid = str(project_id or "").strip()
    if not pid:
        return 0

    keep_key = str(getattr(keep_task, "idempotency_key", "") or "").strip()
    prefix = _since_prefix(keep_key)
    if not prefix:
        return 0

    rows = (
        db.execute(
            select(ProjectTask).where(
                ProjectTask.project_id == pid,
                ProjectTask.status == "queued",
                ProjectTask.idempotency_key.like(f"{prefix}%"),
            )
        )
        .scalars()
        .all()
    )

    now = utc_now()
    canceled = 0
    for t in rows:
        if str(t.id) == str(getattr(keep_task, "id", "")):
            continue
        if str(getattr(t, "idempotency_key", "") or "").strip() == keep_key:
            continue
        reason = _task_params_reason(t.params_json).lower()
        if not reason.startswith("chapter"):
            continue
        t.status = "canceled"
        t.heartbeat_at = None
        t.finished_at = now
        t.updated_at = now
        t.result_json = _compact_json_dumps({"canceled": True, "reason": "deduped_by_newer_trigger"})
        t.error_json = None
        append_project_task_event(
            db,
            task=t,
            event_type="canceled",
            source="dedupe",
            payload={"reason": "deduped_by_newer_trigger", "replaced_by_task_id": str(getattr(keep_task, "id", "") or "")},
        )
        canceled += 1

    if canceled:
        db.commit()
    return canceled


def _try_dedupe_queued_chapter_tasks(*, db: Session, project_id: str, keep_task_id: str | None) -> None:
    if not keep_task_id:
        return
    try:
        keep = db.get(ProjectTask, str(keep_task_id))
        if keep is None:
            return
        _dedupe_queued_chapter_tasks(db=db, project_id=project_id, keep_task=keep)
    except Exception:
        # fail-soft
        return


def schedule_chapter_done_tasks(
    *,
    db: Session,
    project_id: str,
    actor_user_id: str | None,
    request_id: str | None,
    chapter_id: str,
    chapter_token: str | None,
    reason: str,
) -> dict[str, str | None]:
    """
    Fail-soft scheduler bundle for chapter status transition -> done.

    Schedules:
    - ProjectTask(kind=vector_rebuild)
    - ProjectTask(kind=search_rebuild)
    - ProjectTask(kind=worldbook_auto_update)
    - ProjectTask(kind=characters_auto_update)
    - ProjectTask(kind=plot_auto_update)
    - ProjectTask(kind=table_ai_update)
    - ProjectTask(kind=graph_auto_update)
    - ProjectTask(kind=fractal_rebuild)

    All schedulers are idempotent; this helper never raises.
    """

    pid = str(project_id or "").strip()
    cid = str(chapter_id or "").strip()
    reason_norm = str(reason or "").strip() or "chapter_done"
    token_norm = str(chapter_token or "").strip() or utc_now().isoformat().replace("+00:00", "Z")

    out: dict[str, str | None] = {
        "vector_rebuild": None,
        "search_rebuild": None,
        "worldbook_auto_update": None,
        "characters_auto_update": None,
        "plot_auto_update": None,
        "table_ai_update": None,
        "graph_auto_update": None,
        "fractal_rebuild": None,
    }

    if not pid or not cid:
        return out

    from app.models.project_settings import ProjectSettings

    settings_row = db.get(ProjectSettings, pid)
    auto_worldbook = bool(getattr(settings_row, "auto_update_worldbook_enabled", True)) if settings_row is not None else True
    auto_characters = bool(getattr(settings_row, "auto_update_characters_enabled", True)) if settings_row is not None else True
    auto_story_memory = bool(getattr(settings_row, "auto_update_story_memory_enabled", True)) if settings_row is not None else True
    auto_graph = bool(getattr(settings_row, "auto_update_graph_enabled", True)) if settings_row is not None else True
    auto_vector = bool(getattr(settings_row, "auto_update_vector_enabled", True)) if settings_row is not None else True
    auto_search = bool(getattr(settings_row, "auto_update_search_enabled", True)) if settings_row is not None else True
    auto_fractal = bool(getattr(settings_row, "auto_update_fractal_enabled", True)) if settings_row is not None else True
    auto_tables = bool(getattr(settings_row, "auto_update_tables_enabled", True)) if settings_row is not None else True

    try:
        from app.services.vector_rag_service import schedule_vector_rebuild_task

        if auto_vector:
            out["vector_rebuild"] = schedule_vector_rebuild_task(
                db=db,
                project_id=pid,
                actor_user_id=actor_user_id,
                request_id=request_id,
                reason=reason_norm,
            )
    except Exception as exc:
        log_event(
            logger,
            "warning",
            event="CHAPTER_DONE_TASK_SCHEDULE_ERROR",
            project_id=pid,
            chapter_id=cid,
            kind="vector_rebuild",
            error_type=type(exc).__name__,
            **exception_log_fields(exc),
        )

    try:
        from app.services.search_index_service import schedule_search_rebuild_task

        if auto_search:
            out["search_rebuild"] = schedule_search_rebuild_task(
                db=db,
                project_id=pid,
                actor_user_id=actor_user_id,
                request_id=request_id,
                reason=reason_norm,
            )
    except Exception as exc:
        log_event(
            logger,
            "warning",
            event="CHAPTER_DONE_TASK_SCHEDULE_ERROR",
            project_id=pid,
            chapter_id=cid,
            kind="search_rebuild",
            error_type=type(exc).__name__,
            **exception_log_fields(exc),
        )

    if auto_worldbook:
        try:
            out["worldbook_auto_update"] = schedule_worldbook_auto_update_task(
                db=db,
                project_id=pid,
                actor_user_id=actor_user_id,
                request_id=request_id,
                chapter_id=cid,
                chapter_token=token_norm,
                reason=reason_norm,
            )
            if isinstance(db, Session):
                _try_dedupe_queued_chapter_tasks(db=db, project_id=pid, keep_task_id=out.get("worldbook_auto_update"))
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="CHAPTER_DONE_TASK_SCHEDULE_ERROR",
                project_id=pid,
                chapter_id=cid,
                kind="worldbook_auto_update",
                error_type=type(exc).__name__,
                **exception_log_fields(exc),
            )

    if auto_characters:
        try:
            from app.services.characters_auto_update_service import schedule_characters_auto_update_task

            out["characters_auto_update"] = schedule_characters_auto_update_task(
                db=db,
                project_id=pid,
                actor_user_id=actor_user_id,
                request_id=request_id,
                chapter_id=cid,
                chapter_token=token_norm,
                reason=reason_norm,
            )
            if isinstance(db, Session):
                _try_dedupe_queued_chapter_tasks(db=db, project_id=pid, keep_task_id=out.get("characters_auto_update"))
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="CHAPTER_DONE_TASK_SCHEDULE_ERROR",
                project_id=pid,
                chapter_id=cid,
                kind="characters_auto_update",
                error_type=type(exc).__name__,
                **exception_log_fields(exc),
            )

    if auto_story_memory:
        try:
            from app.services.plot_analysis_service import schedule_plot_auto_update_task

            out["plot_auto_update"] = schedule_plot_auto_update_task(
                db=db,
                project_id=pid,
                actor_user_id=actor_user_id,
                request_id=request_id,
                chapter_id=cid,
                chapter_token=token_norm,
                reason=reason_norm,
            )
            if isinstance(db, Session):
                _try_dedupe_queued_chapter_tasks(db=db, project_id=pid, keep_task_id=out.get("plot_auto_update"))
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="CHAPTER_DONE_TASK_SCHEDULE_ERROR",
                project_id=pid,
                chapter_id=cid,
                kind="plot_auto_update",
                error_type=type(exc).__name__,
                **exception_log_fields(exc),
            )

    if auto_tables:
        try:
            from app.models.project_table import ProjectTable
            from app.services.table_ai_update_service import schedule_table_ai_update_task

            table_rows = (
                db.execute(
                    select(ProjectTable.id, ProjectTable.schema_json, ProjectTable.auto_update_enabled)
                    .where(ProjectTable.project_id == pid)
                    .order_by(ProjectTable.updated_at.desc(), ProjectTable.id.desc())
                    .limit(12)
                )
                .all()
            )
            if not isinstance(table_rows, list):
                table_rows = []

            created: list[str] = []
            for table_id, schema_json, auto_update_enabled in table_rows:
                if not bool(auto_update_enabled):
                    continue
                schema_obj = _compact_json_loads(schema_json)
                if not isinstance(schema_obj, dict):
                    continue
                cols = schema_obj.get("columns") if isinstance(schema_obj.get("columns"), list) else []
                has_number = any(
                    isinstance(c, dict) and str(c.get("type") or "").strip().lower() == "number"
                    for c in cols
                )
                if not has_number:
                    continue

                task_id = schedule_table_ai_update_task(
                    db=db,
                    project_id=pid,
                    actor_user_id=actor_user_id,
                    request_id=request_id,
                    table_id=str(table_id),
                    chapter_id=cid,
                    chapter_token=token_norm,
                    focus=None,
                    reason=reason_norm,
                )
                if task_id:
                    created.append(str(task_id))
                    if isinstance(db, Session):
                        _try_dedupe_queued_chapter_tasks(db=db, project_id=pid, keep_task_id=str(task_id))

            out["table_ai_update"] = created[0] if created else None
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="CHAPTER_DONE_TASK_SCHEDULE_ERROR",
                project_id=pid,
                chapter_id=cid,
                kind="table_ai_update",
                error_type=type(exc).__name__,
                **exception_log_fields(exc),
            )

    try:
        from app.services.graph_auto_update_service import schedule_graph_auto_update_task

        if auto_graph:
            out["graph_auto_update"] = schedule_graph_auto_update_task(
                db=db,
                project_id=pid,
                actor_user_id=actor_user_id,
                request_id=request_id,
                chapter_id=cid,
                chapter_token=token_norm,
                focus=None,
                reason=reason_norm,
            )
            if isinstance(db, Session):
                _try_dedupe_queued_chapter_tasks(db=db, project_id=pid, keep_task_id=out.get("graph_auto_update"))
    except Exception as exc:
        log_event(
            logger,
            "warning",
            event="CHAPTER_DONE_TASK_SCHEDULE_ERROR",
            project_id=pid,
            chapter_id=cid,
            kind="graph_auto_update",
            error_type=type(exc).__name__,
            **exception_log_fields(exc),
        )

    try:
        if auto_fractal:
            out["fractal_rebuild"] = schedule_fractal_rebuild_task(
                db=db,
                project_id=pid,
                actor_user_id=actor_user_id,
                request_id=request_id,
                chapter_id=cid,
                chapter_token=token_norm,
                reason=reason_norm,
            )
            if isinstance(db, Session):
                _try_dedupe_queued_chapter_tasks(db=db, project_id=pid, keep_task_id=out.get("fractal_rebuild"))
    except Exception as exc:
        log_event(
            logger,
            "warning",
            event="CHAPTER_DONE_TASK_SCHEDULE_ERROR",
            project_id=pid,
            chapter_id=cid,
            kind="fractal_rebuild",
            error_type=type(exc).__name__,
            **exception_log_fields(exc),
        )

    return out


def retry_project_task(*, db: Session, task: ProjectTask) -> ProjectTask:
    """
    Idempotent retry for failed ProjectTask.

    Note: actual enqueue/worker execution is handled by the queue backend / worker entrypoint.
    """
    MAX_RETRY_COUNT = 5

    status_norm = str(getattr(task, "status", "") or "").strip().lower()
    if status_norm != "failed":
        return task

    # Enforce hard retry limit
    try:
        params = _compact_json_loads(task.params_json) if task.params_json else {}
        current_retry = int((params or {}).get("retry_count") or 0) if isinstance(params, dict) else 0
    except Exception:
        current_retry = 0
    if current_retry >= MAX_RETRY_COUNT:
        raise AppError(
            code="TASK_RETRY_LIMIT",
            message=f"任务已重试 {current_retry} 次，达到上限 {MAX_RETRY_COUNT}，请检查配置后重新创建任务",
            status_code=422,
        )
        return task

    reset_project_task_to_queued(task=task, increment_retry_count=True)
    db.commit()

    _emit_and_enqueue_project_task(
        db=db,
        task=task,
        request_id=None,
        event_type="retry",
        source="manual_retry",
        payload={"reason": "manual_retry"},
    )
    return task


def cancel_project_task(*, db: Session, task: ProjectTask) -> ProjectTask:
    """
    Cancel a queued or running ProjectTask.

    Contract:
    - Queued tasks are canceled immediately.
    - Running tasks are marked "canceled" so the worker can detect it
      at the next heartbeat and stop gracefully.
    - Idempotent no-op for other statuses.
    """

    status_norm = str(getattr(task, "status", "") or "").strip().lower()
    if status_norm not in ("queued", "running"):
        return task

    task.status = "canceled"
    if status_norm == "queued":
        task.started_at = None
        task.heartbeat_at = None
    task.finished_at = utc_now()
    task.updated_at = utc_now()
    task.result_json = _compact_json_dumps({"canceled": True})
    task.error_json = None
    append_project_task_event(db, task=task, event_type="canceled", source="manual_cancel", payload={"reason": "manual_cancel"})
    db.commit()
    return task


def run_project_task(*, task_id: str) -> str:
    """
    RQ worker entrypoint. Consumes ProjectTask and records result to DB.
    """

    db = SessionLocal()
    try:
        task = db.get(ProjectTask, task_id)
        if task is None:
            log_event(logger, "warning", event="PROJECT_TASK_MISSING", task_id=task_id)
            return task_id

        status_norm = str(getattr(task, "status", "") or "").strip().lower()
        if status_norm in {"succeeded", "done", "failed", "running", "paused"}:
            return task_id
        if status_norm == "canceled":
            if task.finished_at is None:
                task.finished_at = utc_now()
                task.updated_at = utc_now()
                db.commit()
            return task_id

        if status_norm != "queued":
            return task_id

        started_at = utc_now()
        res = db.execute(
            update(ProjectTask)
            .where(ProjectTask.id == task_id, ProjectTask.status == "queued")
            .values(
                status="running",
                started_at=started_at,
                heartbeat_at=started_at,
                attempt=ProjectTask.attempt + 1,
                updated_at=started_at,
            )
        )
        db.commit()
        if not getattr(res, "rowcount", 0):
            return task_id
        task = db.get(ProjectTask, task_id)
        if task is None:
            return task_id
        append_project_task_event(db, task=task, event_type="running", source="worker", payload={"reason": "worker_start"})
        db.commit()
        heartbeat_handle = start_project_task_heartbeat(task_id=task_id)

        kind = str(task.kind)
        project_id = str(task.project_id)

        result: dict[str, Any]
        if kind == "noop":
            result = {"skipped": True, "note": "noop"}
        elif kind == "search_rebuild":
            from app.services.search_index_service import rebuild_project_search_index_async

            result = rebuild_project_search_index_async(project_id=project_id)
        elif kind == "worldbook_auto_update":
            params = _compact_json_loads(task.params_json) if task.params_json else None
            params_dict = params if isinstance(params, dict) else {}
            chapter_id = str(params_dict.get("chapter_id") or "").strip() or None
            request_id2 = str(params_dict.get("request_id") or "").strip() or None
            actor_user_id = str(getattr(task, "actor_user_id", "") or "").strip()
            if not actor_user_id:
                raise AppError(
                    code="PROJECT_TASK_CONFIG_ERROR",
                    message="worldbook_auto_update 缺少 actor_user_id（无法解析 API Key）",
                    status_code=500,
                    details={
                        "task_kind": "worldbook_auto_update",
                        "how_to_fix": [
                            "通过 UI 触发任务时，确保已登录且具备 editor 权限",
                            "如果是系统触发（无 user），请改为传入明确的 actor_user_id 或配置项目级 API Key",
                        ],
                    },
                )

            from app.services.worldbook_auto_update_service import worldbook_auto_update_v1

            res = worldbook_auto_update_v1(
                project_id=project_id,
                actor_user_id=actor_user_id,
                request_id=request_id2 or f"project_task:{task_id}",
                chapter_id=chapter_id,
            )
            if not bool(res.get("ok")):
                reason = str(res.get("reason") or "unknown").strip() or "unknown"
                run_id = str(res.get("run_id") or "").strip() or None
                error_type2 = str(res.get("error_type") or "").strip() or None
                error_message2 = str(res.get("error_message") or "").strip() or None
                parse_error = str(res.get("parse_error") or "").strip() or None
                warnings = res.get("warnings") if isinstance(res.get("warnings"), list) else None
                attempts = res.get("attempts") if isinstance(res.get("attempts"), list) else None
                error_obj = res.get("error") if isinstance(res.get("error"), dict) else None

                how_to_fix: list[str] = []
                if reason == "api_key_missing":
                    how_to_fix = [
                        "在「模型配置/项目设置」中配置可用的 API Key（或检查请求头 X-LLM-API-Key）",
                        "确认当前项目已绑定 LLM Profile / Preset（用于 worldbook_auto_update）",
                    ]
                elif reason == "llm_preset_missing":
                    how_to_fix = ["先在项目中选择/绑定可用的 LLM Profile，并刷新页面后重试任务"]
                elif reason == "llm_call_failed":
                    how_to_fix = ["检查 base_url / 网络连通性（可用「模型配置 → 测试连接」验证）", "确认模型与参数兼容；必要时切换 provider/model 后重试"]
                elif reason == "parse_error":
                    how_to_fix = ["模型输出未满足 JSON 合同：可在任务详情中查看 run_id 并定位输出", "尝试更换模型/降低温度后重试"]
                elif reason == "apply_failed":
                    how_to_fix = ["数据库写入失败：请查看 error.details 或 backend.log；修复后重试任务"]

                details: dict[str, Any] = {
                    "task_kind": "worldbook_auto_update",
                    "reason": reason,
                    "run_id": run_id,
                    "error_type": error_type2,
                    "error_message": error_message2,
                    "parse_error": parse_error,
                    "warnings": warnings,
                }
                if attempts is not None:
                    details["attempts"] = attempts
                if error_obj is not None:
                    details["error"] = error_obj
                if how_to_fix:
                    details["how_to_fix"] = how_to_fix

                msg = f"worldbook_auto_update 失败：{reason}"
                if run_id:
                    msg += f" (run_id={run_id})"
                if error_message2:
                    msg += f" - {error_message2[:160]}"

                raise AppError(code="WORLDBOOK_AUTO_UPDATE_FAILED", message=msg, status_code=500, details=details)
            result = res
        elif kind == "characters_auto_update":
            params = _compact_json_loads(task.params_json) if task.params_json else None
            params_dict = params if isinstance(params, dict) else {}
            chapter_id = str(params_dict.get("chapter_id") or "").strip()
            request_id2 = str(params_dict.get("request_id") or "").strip() or None
            actor_user_id = str(getattr(task, "actor_user_id", "") or "").strip()
            if not actor_user_id:
                raise AppError(
                    code="PROJECT_TASK_CONFIG_ERROR",
                    message="characters_auto_update 缺少 actor_user_id（无法解析 API Key）",
                    status_code=500,
                    details={
                        "task_kind": "characters_auto_update",
                        "how_to_fix": [
                            "通过 UI 触发任务时，确保已登录且具备 editor 权限",
                            "如果是系统触发（无 user），请改为传入明确的 actor_user_id 或配置项目级 API Key",
                        ],
                    },
                )
            if not chapter_id:
                raise ValueError("Missing ProjectTask.params_json.chapter_id for characters_auto_update")

            from app.services.characters_auto_update_service import characters_auto_update_v1

            res = characters_auto_update_v1(
                project_id=project_id,
                actor_user_id=actor_user_id,
                request_id=request_id2 or f"project_task:{task_id}",
                chapter_id=chapter_id,
            )
            if not bool(res.get("ok")):
                reason = str(res.get("reason") or "unknown").strip() or "unknown"
                run_id = str(res.get("run_id") or "").strip() or None
                error_type2 = str(res.get("error_type") or "").strip() or None
                error_message2 = str(res.get("error_message") or "").strip() or None
                parse_error = res.get("parse_error") if isinstance(res.get("parse_error"), dict) else None
                attempts = res.get("attempts") if isinstance(res.get("attempts"), list) else None
                error_obj = res.get("error") if isinstance(res.get("error"), dict) else None

                how_to_fix: list[str] = []
                if reason == "api_key_missing":
                    how_to_fix = [
                        "在「模型配置/项目设置」中配置可用的 API Key（或检查请求头 X-LLM-API-Key）",
                        "确认当前项目已绑定 LLM Profile / Preset（用于 characters_auto_update）",
                    ]
                elif reason == "llm_preset_missing":
                    how_to_fix = ["先在项目中选择/绑定可用的 LLM Profile，并刷新页面后重试任务"]
                elif reason == "llm_call_failed":
                    how_to_fix = ["检查 base_url / 网络连通性（可用「模型配置 → 测试连接」验证）", "确认模型与参数兼容；必要时切换 provider/model 后重试"]
                elif reason == "parse_error":
                    how_to_fix = ["模型输出未满足 JSON 合同：可在任务详情中查看 run_id 并定位输出", "尝试更换模型/降低温度后重试"]
                elif reason == "apply_failed":
                    how_to_fix = ["数据库写入失败：请查看 error.details 或 backend.log；修复后重试任务"]

                details: dict[str, Any] = {
                    "task_kind": "characters_auto_update",
                    "reason": reason,
                    "run_id": run_id,
                    "error_type": error_type2,
                    "error_message": error_message2,
                    "parse_error": parse_error,
                }
                if attempts is not None:
                    details["attempts"] = attempts
                if error_obj is not None:
                    details["error"] = error_obj
                if how_to_fix:
                    details["how_to_fix"] = how_to_fix

                msg = f"characters_auto_update 失败：{reason}"
                if run_id:
                    msg += f" (run_id={run_id})"
                if error_message2:
                    msg += f" - {error_message2[:160]}"

                raise AppError(code="CHARACTERS_AUTO_UPDATE_FAILED", message=msg, status_code=500, details=details)
            result = res
        elif kind == "plot_auto_update":
            params = _compact_json_loads(task.params_json) if task.params_json else None
            params_dict = params if isinstance(params, dict) else {}
            chapter_id = str(params_dict.get("chapter_id") or "").strip()
            request_id2 = str(params_dict.get("request_id") or "").strip() or None
            actor_user_id = str(getattr(task, "actor_user_id", "") or "").strip()
            if not actor_user_id:
                raise AppError(
                    code="PROJECT_TASK_CONFIG_ERROR",
                    message="plot_auto_update 缺少 actor_user_id（无法解析 API Key）",
                    status_code=500,
                    details={
                        "task_kind": "plot_auto_update",
                        "how_to_fix": [
                            "通过 UI 触发任务时，确保已登录且具备 editor 权限",
                            "如果是系统触发（无 user），请改为传入明确的 actor_user_id 或配置项目级 API Key",
                        ],
                    },
                )
            if not chapter_id:
                raise ValueError("Missing ProjectTask.params_json.chapter_id for plot_auto_update")

            from app.services.plot_analysis_service import plot_auto_update_v1

            res = plot_auto_update_v1(
                project_id=project_id,
                actor_user_id=actor_user_id,
                request_id=request_id2 or f"project_task:{task_id}",
                chapter_id=chapter_id,
            )
            if not bool(res.get("ok")):
                reason = str(res.get("reason") or "unknown").strip() or "unknown"
                run_id = str(res.get("run_id") or "").strip() or None
                error_type2 = str(res.get("error_type") or "").strip() or None
                error_message2 = str(res.get("error_message") or "").strip() or None
                parse_error = res.get("parse_error") if isinstance(res.get("parse_error"), dict) else None
                warnings = res.get("warnings") if isinstance(res.get("warnings"), list) else None
                attempts = res.get("attempts") if isinstance(res.get("attempts"), list) else None
                error_obj = res.get("error") if isinstance(res.get("error"), dict) else None

                how_to_fix: list[str] = []
                if reason == "chapter_not_done":
                    how_to_fix = ["仅对 status=done 的章节自动运行；请先将章节标记为「定稿/完成」后重试"]
                elif reason == "api_key_missing":
                    how_to_fix = ["在「模型配置/项目设置」中配置可用的 API Key（或检查请求头 X-LLM-API-Key）"]
                elif reason == "llm_preset_missing":
                    how_to_fix = ["先在项目中选择/绑定可用的 LLM Profile，并刷新页面后重试任务"]
                elif reason == "llm_call_failed":
                    how_to_fix = ["检查 base_url / 网络连通性（可用「模型配置 → 测试连接」验证）", "确认模型与参数兼容；必要时切换 provider/model 后重试"]
                elif reason == "parse_error":
                    how_to_fix = ["模型输出未满足 JSON 合同：可在任务详情中查看 run_id 并定位输出", "尝试更换模型/降低温度后重试"]
                elif reason == "apply_failed":
                    how_to_fix = ["数据库写入失败：请查看 error.details 或 backend.log；修复后重试任务"]

                details: dict[str, Any] = {
                    "task_kind": "plot_auto_update",
                    "reason": reason,
                    "run_id": run_id,
                    "error_type": error_type2,
                    "error_message": error_message2,
                    "parse_error": parse_error,
                    "warnings": warnings,
                }
                if attempts is not None:
                    details["attempts"] = attempts
                if error_obj is not None:
                    details["error"] = error_obj
                if how_to_fix:
                    details["how_to_fix"] = how_to_fix

                msg = f"plot_auto_update 失败：{reason}"
                if run_id:
                    msg += f" (run_id={run_id})"
                if error_message2:
                    msg += f" - {error_message2[:160]}"

                raise AppError(code="PLOT_AUTO_UPDATE_FAILED", message=msg, status_code=500, details=details)
            result = res
        elif kind == "vector_rebuild":
            from app.models.project_settings import ProjectSettings
            from app.services.vector_embedding_overrides import vector_embedding_overrides
            from app.services.vector_kb_service import list_kbs as list_vector_kbs
            from app.services.vector_rag_service import build_project_chunks, rebuild_project, vector_rag_status

            db2 = SessionLocal()
            kb_ids: list[str] = []
            embedding: dict[str, str | None] = {}
            chunks = []
            try:
                settings_row = db2.get(ProjectSettings, project_id)
                embedding = vector_embedding_overrides(settings_row)
                status = vector_rag_status(project_id=project_id, embedding=embedding)
                if not bool(status.get("enabled")):
                    result = {"skipped": True, **status}
                else:
                    kbs = list_vector_kbs(db2, project_id=project_id)
                    kb_ids = [str(r.kb_id) for r in kbs if bool(getattr(r, "enabled", True))]
                    if not kb_ids:
                        kb_ids = ["default"]
                    chunks = build_project_chunks(db=db2, project_id=project_id)
                    result = {}
            finally:
                db2.close()

            if not result:
                per_kb: dict[str, dict[str, Any]] = {}
                for kid in kb_ids:
                    per_kb[kid] = rebuild_project(project_id=project_id, kb_id=kid, chunks=chunks, embedding=embedding)

                results = list(per_kb.values())
                enabled = all(bool(r.get("enabled")) for r in results) if results else False
                skipped = all(bool(r.get("skipped")) for r in results) if results else True
                rebuilt = sum(int(r.get("rebuilt") or 0) for r in results)
                disabled_reason = next((r.get("disabled_reason") for r in results if r.get("disabled_reason")), None)
                backend = next((r.get("backend") for r in results if r.get("backend")), None)
                error = next((r.get("error") for r in results if r.get("error")), None)

                result = {
                    "enabled": bool(enabled),
                    "skipped": bool(skipped),
                    "disabled_reason": disabled_reason,
                    "rebuilt": int(rebuilt),
                    "backend": backend,
                    "error": error,
                    "kbs": {"selected": list(kb_ids), "per_kb": per_kb},
                }

                if bool(enabled) and not bool(skipped):
                    db3 = SessionLocal()
                    try:
                        settings_row2 = db3.get(ProjectSettings, project_id)
                        if settings_row2 is None:
                            settings_row2 = ProjectSettings(project_id=project_id)
                            db3.add(settings_row2)
                        settings_row2.vector_index_dirty = False
                        settings_row2.last_vector_build_at = utc_now()
                        db3.commit()
                    finally:
                        db3.close()
        elif kind == "table_ai_update":
            params = _compact_json_loads(task.params_json) if task.params_json else None
            params_dict = params if isinstance(params, dict) else {}
            table_id = str(params_dict.get("table_id") or "").strip()
            chapter_id = str(params_dict.get("chapter_id") or "").strip() or None
            focus = str(params_dict.get("focus") or "").strip() or None
            request_id2 = str(params_dict.get("request_id") or "").strip() or None
            change_set_idempotency_key = str(params_dict.get("change_set_idempotency_key") or "").strip() or None

            actor_user_id = str(getattr(task, "actor_user_id", "") or "").strip()
            if not actor_user_id:
                raise ValueError("Missing ProjectTask.actor_user_id for table_ai_update")
            if not table_id:
                raise ValueError("Missing ProjectTask.params_json.table_id for table_ai_update")

            from app.services.table_ai_update_service import (
                table_ai_update_v1,
                table_update_changeset_key_from_task_idempotency_key,
            )

            res = table_ai_update_v1(
                project_id=project_id,
                actor_user_id=actor_user_id,
                request_id=request_id2 or f"project_task:{task_id}",
                table_id=table_id,
                change_set_idempotency_key=change_set_idempotency_key
                or table_update_changeset_key_from_task_idempotency_key(str(task.idempotency_key)),
                chapter_id=chapter_id,
                focus=focus,
            )
            if not bool(res.get("ok")):
                reason = str(res.get("reason") or "unknown").strip() or "unknown"
                run_id = str(res.get("run_id") or "").strip() or None
                finish_reason = str(res.get("finish_reason") or "").strip() or None
                error_type2 = str(res.get("error_type") or "").strip() or None
                error_message2 = str(res.get("error_message") or "").strip() or None
                parse_error = res.get("parse_error") if isinstance(res.get("parse_error"), dict) else None
                warnings = res.get("warnings") if isinstance(res.get("warnings"), list) else None
                error_obj = res.get("error") if isinstance(res.get("error"), dict) else None

                how_to_fix: list[str] = []
                if reason in {"project_not_found", "table_not_found", "chapter_not_found"}:
                    how_to_fix = ["确认项目/表格/章节仍存在且属于当前项目", "刷新页面后重试任务"]
                elif reason == "llm_preset_missing":
                    how_to_fix = ["先在项目中选择/绑定可用的 LLM Profile，并刷新页面后重试任务"]
                elif reason in {"llm_call_prepare_failed", "prompt_empty"}:
                    how_to_fix = ["确认项目 Prompt/Preset 配置正确；必要时刷新页面后重试", "确认章节内容非空且已定稿（done）"]
                elif reason == "llm_call_failed":
                    how_to_fix = [
                        "检查 base_url / 网络连通性（可用「模型配置 → 测试连接」验证）",
                        "确认模型与参数兼容；必要时切换 provider/model 后重试",
                    ]
                elif reason == "parse_failed":
                    how_to_fix = ["模型输出未满足 table_update_v1 JSON 合同：可在任务详情中查看 run_id 并定位输出", "尝试更换模型/降低温度后重试"]
                elif reason == "propose_failed":
                    how_to_fix = ["变更集提议失败：请查看 error.details 或后端日志；修复后重试任务"]

                details: dict[str, Any] = {
                    "task_kind": "table_ai_update",
                    "reason": reason,
                    "run_id": run_id,
                    "table_id": table_id,
                    "chapter_id": chapter_id,
                    "finish_reason": finish_reason,
                    "warnings": warnings,
                    "parse_error": parse_error,
                    "error": error_obj,
                    "error_type": error_type2,
                    "error_message": error_message2,
                }
                if how_to_fix:
                    details["how_to_fix"] = how_to_fix

                msg = f"table_ai_update 失败：{reason}"
                if run_id:
                    msg += f" (run_id={run_id})"
                if error_message2:
                    msg += f" - {error_message2[:160]}"

                raise AppError(code="TABLE_AI_UPDATE_FAILED", message=msg, status_code=500, details=details)
            result = res
        elif kind == "graph_auto_update":
            params = _compact_json_loads(task.params_json) if task.params_json else None
            params_dict = params if isinstance(params, dict) else {}
            chapter_id = str(params_dict.get("chapter_id") or "").strip()
            focus = str(params_dict.get("focus") or "").strip() or None
            request_id2 = str(params_dict.get("request_id") or "").strip() or None
            change_set_idempotency_key = str(params_dict.get("change_set_idempotency_key") or "").strip() or None

            actor_user_id = str(getattr(task, "actor_user_id", "") or "").strip()
            if not actor_user_id:
                raise ValueError("Missing ProjectTask.actor_user_id for graph_auto_update")
            if not chapter_id:
                raise ValueError("Missing ProjectTask.params_json.chapter_id for graph_auto_update")

            from app.services.graph_auto_update_service import (
                graph_auto_update_v1,
                memory_update_changeset_key_from_task_idempotency_key,
            )

            res = graph_auto_update_v1(
                project_id=project_id,
                actor_user_id=actor_user_id,
                request_id=request_id2 or f"project_task:{task_id}",
                chapter_id=chapter_id,
                change_set_idempotency_key=change_set_idempotency_key
                or memory_update_changeset_key_from_task_idempotency_key(str(task.idempotency_key)),
                focus=focus,
            )
            if not bool(res.get("ok")):
                reason = str(res.get("reason") or "unknown").strip() or "unknown"
                run_id = str(res.get("run_id") or "").strip() or None
                error_type2 = str(res.get("error_type") or "").strip() or None
                error_message2 = str(res.get("error_message") or "").strip() or None
                parse_error = res.get("parse_error") if isinstance(res.get("parse_error"), dict) else None
                warnings = res.get("warnings") if isinstance(res.get("warnings"), list) else None
                attempts = res.get("attempts") if isinstance(res.get("attempts"), list) else None
                error_obj = res.get("error") if isinstance(res.get("error"), dict) else None

                how_to_fix: list[str] = []
                if reason == "prepare_failed":
                    how_to_fix = [
                        "确认项目已绑定可用的 LLM Profile / Preset（用于 graph_auto_update）",
                        "确认已登录且具备 editor 权限（用于解析 API Key）",
                        "检查章节状态为 done 且章节存在于当前项目",
                    ]
                elif reason in {"llm_call_prepare_failed", "prompt_empty"}:
                    how_to_fix = ["确认项目 Prompt/Preset 配置正确；必要时刷新页面后重试", "确认章节内容非空且已定稿（done）"]
                elif reason == "llm_call_failed":
                    how_to_fix = [
                        "检查 base_url / 网络连通性（可用「模型配置 → 测试连接」验证）",
                        "确认模型与参数兼容；必要时切换 provider/model 后重试",
                    ]
                elif reason == "parse_failed":
                    how_to_fix = ["模型输出未满足 memory_update_v1 JSON 合同：可在任务详情中查看 run_id 并定位输出", "尝试更换模型/降低温度后重试"]
                elif reason in {"unsupported_target_table", "evidence_source_id_mismatch"}:
                    how_to_fix = ["模型输出与合同不一致：可在任务详情中查看 run_id 并定位输出", "尝试更换模型/降低温度后重试"]

                details: dict[str, Any] = {
                    "task_kind": "graph_auto_update",
                    "reason": reason,
                    "run_id": run_id,
                    "error_type": error_type2,
                    "error_message": error_message2,
                    "parse_error": parse_error,
                    "warnings": warnings,
                }
                if attempts is not None:
                    details["attempts"] = attempts
                if error_obj is not None:
                    details["error"] = error_obj
                if how_to_fix:
                    details["how_to_fix"] = how_to_fix

                msg = f"graph_auto_update 失败：{reason}"
                if run_id:
                    msg += f" (run_id={run_id})"
                if error_message2:
                    msg += f" - {error_message2[:160]}"

                raise AppError(code="GRAPH_AUTO_UPDATE_FAILED", message=msg, status_code=500, details=details)
            result = res
        elif kind == "fractal_rebuild":
            params = _compact_json_loads(task.params_json) if task.params_json else None
            params_dict = params if isinstance(params, dict) else {}
            reason2 = str(params_dict.get("reason") or "").strip() or f"project_task:{task_id}"

            from app.services.fractal_memory_service import rebuild_fractal_memory

            result = rebuild_fractal_memory(db=db, project_id=project_id, reason=reason2)
        else:
            raise ValueError(f"Unsupported ProjectTask.kind: {kind!r}")

        # Re-read status before marking succeeded: task may have been canceled mid-execution
        db.refresh(task)
        if str(getattr(task, "status", "") or "").strip().lower() == "canceled":
            log_event(logger, "info", event="PROJECT_TASK_CANCELED_DURING_EXECUTION", task_id=task_id, kind=kind)
            return task_id

        task.status = "succeeded"
        task.result_json = _compact_json_dumps(redact_api_keys(result))
        task.heartbeat_at = utc_now()
        task.finished_at = utc_now()
        append_project_task_event(db, task=task, event_type="succeeded", source="worker", payload={"result": redact_api_keys(result)})
        db.commit()

        log_event(
            logger,
            "info",
            event="PROJECT_TASK_SUCCEEDED",
            task_id=task_id,
            project_id=str(task.project_id),
            kind=kind,
        )
        return task_id
    except Exception as exc:
        try:
            task2 = db.get(ProjectTask, task_id)
            if task2 is not None:
                safe_message = redact_secrets_text(str(exc)).replace("\n", " ").strip()
                if not safe_message:
                    safe_message = type(exc).__name__

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

                task2.status = "failed"
                task2.error_json = _compact_json_dumps(error_payload)
                # Record user-visible error for frontend display
                _user_msg = str(error_payload.get("message") or "自动更新失败")[:200]
                _user_code = str(error_payload.get("code") or "AUTO_UPDATE_FAILED")
                record_user_visible_error(
                    task2, code=_user_code, message=_user_msg,
                    details={"kind": str(task2.kind), "error_type": str(error_payload.get("error_type") or "")},
                )
                task2.heartbeat_at = utc_now()
                task2.finished_at = utc_now()
                append_project_task_event(
                    db,
                    task=task2,
                    event_type="failed",
                    source="worker",
                    payload={"error": redact_api_keys(error_payload)},
                )
                db.commit()
        except Exception:
            db.rollback()

        log_event(
            logger,
            "error",
            event="PROJECT_TASK_FAILED",
            task_id=task_id,
            error_type=type(exc).__name__,
            **exception_log_fields(exc),
        )
        return task_id
    finally:
        stop_project_task_heartbeat(locals().get("heartbeat_handle"))
        db.close()
