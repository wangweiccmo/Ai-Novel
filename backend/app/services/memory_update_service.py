from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AppError
from app.core.logging import exception_log_fields, log_event, redact_secrets_text
from app.core.secrets import redact_api_keys
from app.db.session import SessionLocal
from app.db.utils import new_id, utc_now
from app.models.chapter import Chapter
from app.models.generation_run import GenerationRun
from app.models.memory_task import MemoryTask
from app.models.project_table import ProjectTable, ProjectTableRow
from app.models.project_settings import ProjectSettings
from app.models.structured_memory import (
    MemoryChangeSet,
    MemoryChangeSetItem,
    MemoryEntity,
    MemoryEvidence,
    MemoryEvent,
    MemoryForeshadow,
    MemoryRelation,
)
from app.schemas.memory_update import AFTER_MODEL_BY_TABLE, MemoryUpdateV1Request
from app.services.table_executor import TableUpdateV1Request, is_key_value_schema, validate_row_data_for_table
from app.services.memory_conflict_service import detect_memory_update_conflicts
from app.services.fractal_memory_service import rebuild_fractal_memory
from app.services.vector_embedding_overrides import vector_embedding_overrides
from app.services.vector_rag_service import build_project_chunks, rebuild_project, vector_rag_status

logger = logging.getLogger("ainovel")


_MODEL_BY_TABLE: dict[str, type] = {
    "entities": MemoryEntity,
    "relations": MemoryRelation,
    "events": MemoryEvent,
    "foreshadows": MemoryForeshadow,
    "evidence": MemoryEvidence,
    "project_table_rows": ProjectTableRow,
}


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


def _parse_attributes_json(raw: str | None) -> dict[str, Any] | str | None:
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except Exception:
        return raw
    if isinstance(value, dict):
        return value
    return raw


def _row_payload(target_table: str, row: Any) -> dict[str, Any]:
    if target_table == "entities":
        return {
            "id": str(row.id),
            "entity_type": str(row.entity_type or "generic"),
            "name": str(row.name or ""),
            "summary_md": row.summary_md,
            "attributes": _parse_attributes_json(row.attributes_json),
            "deleted_at": _iso(row.deleted_at),
        }
    if target_table == "relations":
        return {
            "id": str(row.id),
            "from_entity_id": str(row.from_entity_id),
            "to_entity_id": str(row.to_entity_id),
            "relation_type": str(row.relation_type or "related_to"),
            "description_md": row.description_md,
            "attributes": _parse_attributes_json(row.attributes_json),
            "deleted_at": _iso(row.deleted_at),
        }
    if target_table == "events":
        return {
            "id": str(row.id),
            "chapter_id": row.chapter_id,
            "event_type": str(row.event_type or "event"),
            "title": row.title,
            "content_md": str(row.content_md or ""),
            "attributes": _parse_attributes_json(row.attributes_json),
            "deleted_at": _iso(row.deleted_at),
        }
    if target_table == "foreshadows":
        return {
            "id": str(row.id),
            "chapter_id": row.chapter_id,
            "resolved_at_chapter_id": row.resolved_at_chapter_id,
            "title": row.title,
            "content_md": str(row.content_md or ""),
            "resolved": int(row.resolved or 0),
            "attributes": _parse_attributes_json(row.attributes_json),
            "deleted_at": _iso(row.deleted_at),
        }
    if target_table == "evidence":
        return {
            "id": str(row.id),
            "source_type": str(row.source_type or "unknown"),
            "source_id": row.source_id,
            "quote_md": str(row.quote_md or ""),
            "attributes": _parse_attributes_json(row.attributes_json),
            "deleted_at": _iso(row.deleted_at),
        }
    if target_table == "project_table_rows":
        data_obj = _compact_json_loads(getattr(row, "data_json", None))
        data = data_obj if isinstance(data_obj, dict) else {}
        return {
            "id": str(row.id),
            "table_id": str(row.table_id),
            "row_index": int(getattr(row, "row_index", 0) or 0),
            "data": data,
        }
    raise AppError.validation(details={"target_table": target_table})


def _load_target_row(db: Session, *, target_table: str, project_id: str, target_id: str) -> Any | None:
    model = _MODEL_BY_TABLE.get(target_table)
    if model is None:
        raise AppError.validation(details={"target_table": target_table})
    return (
        db.execute(
            select(model).where(  # type: ignore[arg-type]
                model.id == target_id,  # type: ignore[attr-defined]
                model.project_id == project_id,  # type: ignore[attr-defined]
            )
        )
        .scalars()
        .first()
    )


def _change_set_to_dict(change_set: MemoryChangeSet) -> dict[str, Any]:
    return {
        "id": str(change_set.id),
        "project_id": str(change_set.project_id),
        "actor_user_id": change_set.actor_user_id,
        "generation_run_id": change_set.generation_run_id,
        "request_id": change_set.request_id,
        "idempotency_key": str(change_set.idempotency_key),
        "title": change_set.title,
        "summary_md": change_set.summary_md,
        "status": str(change_set.status),
        "created_at": _iso(change_set.created_at),
        "applied_at": _iso(change_set.applied_at),
        "rolled_back_at": _iso(change_set.rolled_back_at),
    }


_ALLOWED_CHANGE_SET_STATUSES = {"proposed", "applied", "rolled_back", "failed"}


def _change_set_summary_to_dict(*, change_set: MemoryChangeSet, chapter_id: str | None) -> dict[str, Any]:
    updated_at = change_set.rolled_back_at or change_set.applied_at or change_set.created_at
    return {
        "id": str(change_set.id),
        "chapter_id": chapter_id,
        "request_id": change_set.request_id,
        "idempotency_key": change_set.idempotency_key,
        "title": change_set.title,
        "summary_md": change_set.summary_md,
        "status": str(change_set.status),
        "created_at": _iso(change_set.created_at),
        "updated_at": _iso(updated_at),
    }


def list_memory_change_sets(
    *,
    db: Session,
    project_id: str,
    status: str | None,
    before: str | None,
    limit: int,
) -> dict[str, Any]:
    status_norm = str(status or "").strip().lower() or None
    if status_norm is not None and status_norm not in _ALLOWED_CHANGE_SET_STATUSES:
        raise AppError.validation(details={"reason": "invalid_status", "status": status})

    before_raw = str(before or "").strip()
    before_dt = _parse_dt(before_raw) if before_raw else None
    if before_raw and before_dt is None:
        raise AppError.validation(details={"reason": "invalid_before", "before": before})

    q = (
        select(MemoryChangeSet, GenerationRun.chapter_id)
        .outerjoin(GenerationRun, GenerationRun.id == MemoryChangeSet.generation_run_id)
        .where(MemoryChangeSet.project_id == project_id)
    )
    if status_norm is not None:
        q = q.where(MemoryChangeSet.status == status_norm)
    if before_dt is not None:
        q = q.where(MemoryChangeSet.created_at < before_dt)

    rows = (
        db.execute(q.order_by(MemoryChangeSet.created_at.desc(), MemoryChangeSet.id.desc()).limit(limit + 1))
        .all()
    )
    has_more = len(rows) > limit
    rows = rows[:limit]

    items: list[dict[str, Any]] = []
    for change_set, chapter_id in rows:
        items.append(
            _change_set_summary_to_dict(
                change_set=change_set,
                chapter_id=str(chapter_id) if chapter_id else None,
            )
        )

    next_before = _iso(rows[-1][0].created_at) if (has_more and rows) else None
    return {"items": items, "next_before": next_before}


_ALLOWED_TASK_STATUSES_QUERY = {"queued", "running", "failed", "done", "succeeded"}
_TASK_DONE_ALIASES = {"succeeded", "done"}


def _memory_task_status_to_public(status: str) -> str:
    s = str(status or "").strip().lower()
    return "done" if s in _TASK_DONE_ALIASES else s


def _memory_task_error_fields(task: MemoryTask) -> tuple[str | None, str | None]:
    value = _compact_json_loads(task.error_json) if task.error_json else None
    if not isinstance(value, dict):
        return None, None
    error_type = str(value.get("error_type") or "").strip() or None
    error_message = str(value.get("message") or "").strip() or None
    return error_type, error_message


def _memory_task_timings(task: MemoryTask) -> dict[str, Any]:
    created_at = task.created_at
    started_at = task.started_at
    finished_at = task.finished_at

    run_ms = int((finished_at - started_at).total_seconds() * 1000) if (started_at and finished_at) else None
    queue_delay_ms = int((started_at - created_at).total_seconds() * 1000) if started_at else None
    total_ms = int((finished_at - created_at).total_seconds() * 1000) if finished_at else None

    return {
        "created_at": _iso(created_at),
        "started_at": _iso(started_at),
        "finished_at": _iso(finished_at),
        "updated_at": _iso(task.updated_at),
        "queue_delay_ms": queue_delay_ms,
        "run_ms": run_ms,
        "total_ms": total_ms,
    }


def memory_task_to_dict(*, task: MemoryTask, change_set_request_id: str | None = None) -> dict[str, Any]:
    error_type, error_message = _memory_task_error_fields(task)
    err = _compact_json_loads(task.error_json) if task.error_json else None
    return {
        "id": str(task.id),
        "project_id": str(task.project_id),
        "change_set_id": str(task.change_set_id),
        "request_id": change_set_request_id,
        "actor_user_id": task.actor_user_id,
        "kind": str(task.kind),
        "status": _memory_task_status_to_public(str(task.status)),
        "error_type": error_type,
        "error_message": error_message,
        "error": redact_api_keys(err) if err is not None else None,
        "timings": _memory_task_timings(task),
    }


def list_memory_tasks(
    *,
    db: Session,
    project_id: str,
    status: str | None,
    before: str | None,
    limit: int,
) -> dict[str, Any]:
    status_norm = str(status or "").strip().lower() or None
    if status_norm is not None:
        if status_norm == "succeeded":
            status_norm = "done"
        if status_norm not in _ALLOWED_TASK_STATUSES_QUERY:
            raise AppError.validation(details={"reason": "invalid_status", "status": status})

    before_raw = str(before or "").strip()
    before_dt = _parse_dt(before_raw) if before_raw else None
    if before_raw and before_dt is None:
        raise AppError.validation(details={"reason": "invalid_before", "before": before})

    q = select(MemoryTask, MemoryChangeSet.request_id).join(MemoryChangeSet, MemoryChangeSet.id == MemoryTask.change_set_id).where(
        MemoryTask.project_id == project_id
    )
    if status_norm is not None:
        if status_norm == "done":
            q = q.where(MemoryTask.status.in_(sorted(_TASK_DONE_ALIASES)))
        else:
            q = q.where(MemoryTask.status == status_norm)
    if before_dt is not None:
        q = q.where(MemoryTask.created_at < before_dt)

    rows = db.execute(q.order_by(MemoryTask.created_at.desc(), MemoryTask.id.desc()).limit(limit + 1)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]

    items = [memory_task_to_dict(task=t, change_set_request_id=req_id) for t, req_id in rows]
    next_before = _iso(rows[-1][0].created_at) if (has_more and rows) else None
    return {"items": items, "next_before": next_before}


def retry_memory_task(*, db: Session, request_id: str, task: MemoryTask) -> MemoryTask:
    """
    Idempotent retry for failed MemoryTask.

    - If task is not failed: noop.
    - If failed: reset -> queued, clear error/result/timings, enqueue again.
    """

    status_norm = str(getattr(task, "status", "") or "").strip().lower()
    if status_norm != "failed":
        return task

    task.status = "queued"
    task.started_at = None
    task.finished_at = None
    task.result_json = None
    task.error_json = None

    try:
        value = _compact_json_loads(task.params_json) if task.params_json else {}
        if isinstance(value, dict):
            value["retry_count"] = int(value.get("retry_count") or 0) + 1
            task.params_json = _compact_json_dumps(value)
    except Exception:
        pass

    db.commit()

    from app.services.task_queue import get_task_queue

    queue = get_task_queue()
    try:
        queue.enqueue(kind="memory_task", task_id=str(task.id))
    except Exception as exc:
        safe_message = redact_secrets_text(str(exc)).replace("\n", " ").strip()
        if not safe_message:
            safe_message = type(exc).__name__

        if isinstance(exc, AppError):
            details = exc.details if isinstance(exc.details, dict) else {}
            error_payload = {
                "error_type": type(exc).__name__,
                "code": str(exc.code),
                "message": safe_message[:200],
                "details": redact_api_keys(details),
            }
        else:
            error_payload = {"error_type": type(exc).__name__, "message": safe_message[:200]}

        task.status = "failed"
        task.finished_at = utc_now()
        task.error_json = _compact_json_dumps(error_payload)
        db.commit()
        log_event(
            logger,
            "warning",
            event="MEMORY_TASK_RETRY_ENQUEUE_ERROR",
            project_id=str(task.project_id),
            change_set_id=str(task.change_set_id),
            task_id=str(task.id),
            kind=str(task.kind),
            request_id=request_id,
            error_type=type(exc).__name__,
        )
        raise

    log_event(
        logger,
        "info",
        event="MEMORY_TASK_RETRIED",
        project_id=str(task.project_id),
        change_set_id=str(task.change_set_id),
        task_id=str(task.id),
        kind=str(task.kind),
        request_id=request_id,
    )
    return task


def _item_to_dict(item: MemoryChangeSetItem) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "project_id": str(item.project_id),
        "change_set_id": str(item.change_set_id),
        "item_index": int(item.item_index),
        "target_table": str(item.target_table),
        "target_id": item.target_id,
        "op": str(item.op),
        "before_json": item.before_json,
        "after_json": item.after_json,
        "evidence_ids_json": item.evidence_ids_json,
        "created_at": _iso(item.created_at),
    }


def propose_chapter_memory_change_set(
    *,
    db: Session,
    request_id: str,
    actor_user_id: str,
    chapter: Chapter,
    payload: MemoryUpdateV1Request,
) -> dict[str, Any]:
    project_id = str(chapter.project_id)
    chapter_id = str(chapter.id)

    existing = (
        db.execute(
            select(MemoryChangeSet).where(
                MemoryChangeSet.project_id == project_id,
                MemoryChangeSet.idempotency_key == payload.idempotency_key,
            )
        )
        .scalars()
        .first()
    )
    if existing is not None:
        items = (
            db.execute(
                select(MemoryChangeSetItem)
                .where(MemoryChangeSetItem.change_set_id == existing.id)
                .order_by(MemoryChangeSetItem.item_index.asc())
            )
            .scalars()
            .all()
        )
        return {
            "idempotent": True,
            "change_set": _change_set_to_dict(existing),
            "items": [_item_to_dict(i) for i in items],
            "conflicts": [],
        }

    generation_run_id = new_id()
    db.add(
        GenerationRun(
            id=generation_run_id,
            project_id=project_id,
            actor_user_id=actor_user_id,
            chapter_id=chapter_id,
            type="memory_update_propose",
            provider=None,
            model=None,
            request_id=request_id,
            prompt_system="",
            prompt_user="",
            prompt_render_log_json=None,
            params_json=_compact_json_dumps(
                {
                    "schema_version": payload.schema_version,
                    "idempotency_key": payload.idempotency_key,
                    "ops_count": len(payload.ops),
                }
            ),
            output_text=_compact_json_dumps(payload.model_dump()),
            error_json=None,
        )
    )

    change_set = MemoryChangeSet(
        id=new_id(),
        project_id=project_id,
        actor_user_id=actor_user_id,
        generation_run_id=generation_run_id,
        request_id=request_id,
        idempotency_key=payload.idempotency_key,
        title=payload.title,
        summary_md=payload.summary_md,
        status="proposed",
    )
    db.add(change_set)

    items: list[MemoryChangeSetItem] = []
    proposed_items: list[dict[str, Any]] = []
    for idx, op in enumerate(payload.ops):
        target_table = str(op.target_table)
        target_id = str(op.target_id or "").strip()

        after_dict: dict[str, Any] | None = None
        if op.op == "upsert":
            model_cls = AFTER_MODEL_BY_TABLE.get(target_table)
            if model_cls is None:
                raise AppError.validation(details={"item_index": idx, "reason": "unsupported_target_table"})
            after_obj = model_cls.model_validate(op.after or {})
            after_dict = dict(after_obj.model_dump())
            if target_table in {"events", "foreshadows"} and not (after_dict.get("chapter_id") or "").strip():
                after_dict["chapter_id"] = chapter_id

            # restore-on-create: resolve by unique key when caller omits target_id
            if not target_id and target_table == "entities":
                entity_type = str(after_dict.get("entity_type") or "generic").strip() or "generic"
                name = str(after_dict.get("name") or "").strip()
                existing_id = (
                    db.execute(
                        select(MemoryEntity.id).where(
                            MemoryEntity.project_id == project_id,
                            MemoryEntity.entity_type == entity_type,
                            MemoryEntity.name == name,
                        )
                    )
                    .scalars()
                    .first()
                )
                if existing_id:
                    target_id = str(existing_id)
            if not target_id and target_table == "relations":
                from_entity_id = str(after_dict.get("from_entity_id") or "").strip()
                to_entity_id = str(after_dict.get("to_entity_id") or "").strip()
                relation_type = str(after_dict.get("relation_type") or "related_to").strip() or "related_to"
                existing_id = (
                    db.execute(
                        select(MemoryRelation.id).where(
                            MemoryRelation.project_id == project_id,
                            MemoryRelation.from_entity_id == from_entity_id,
                            MemoryRelation.to_entity_id == to_entity_id,
                            MemoryRelation.relation_type == relation_type,
                        )
                    )
                    .scalars()
                    .first()
                )
                if existing_id:
                    target_id = str(existing_id)

            if not target_id:
                target_id = new_id()

            after_dict["id"] = target_id

        if not target_id:
            raise AppError.validation(details={"item_index": idx, "reason": "target_id_missing"})

        before_row = _load_target_row(db, target_table=target_table, project_id=project_id, target_id=target_id)
        if op.op == "delete" and before_row is None:
            raise AppError.validation(details={"item_index": idx, "reason": "target_not_found"})

        before_dict = _row_payload(target_table, before_row) if before_row is not None else None

        evidence_ids_json = _compact_json_dumps(op.evidence_ids) if op.evidence_ids else None

        item = MemoryChangeSetItem(
            id=new_id(),
            project_id=project_id,
            change_set_id=str(change_set.id),
            item_index=idx,
            target_table=target_table,
            target_id=target_id,
            op=str(op.op),
            before_json=_compact_json_dumps(before_dict) if before_dict is not None else None,
            after_json=_compact_json_dumps(after_dict) if after_dict is not None else None,
            evidence_ids_json=evidence_ids_json,
        )
        items.append(item)
        db.add(item)
        proposed_items.append(
            {
                "item_index": idx,
                "op": str(op.op),
                "target_table": target_table,
                "target_id": target_id,
                "after": dict(after_dict) if after_dict is not None else None,
            }
        )

    conflicts: list[dict[str, Any]] = []
    try:
        conflicts = detect_memory_update_conflicts(db=db, project_id=project_id, items=proposed_items)
    except Exception:
        conflicts = []

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        log_event(
            logger,
            "warning",
            event="MEMORY_CHANGESET_PROPOSE_CONFLICT",
            project_id=project_id,
            idempotency_key=payload.idempotency_key,
            **exception_log_fields(exc),
        )
        existing = (
            db.execute(
                select(MemoryChangeSet).where(
                    MemoryChangeSet.project_id == project_id,
                    MemoryChangeSet.idempotency_key == payload.idempotency_key,
                )
            )
            .scalars()
            .first()
        )
        if existing is not None:
            items2 = (
                db.execute(
                    select(MemoryChangeSetItem)
                    .where(MemoryChangeSetItem.change_set_id == existing.id)
                    .order_by(MemoryChangeSetItem.item_index.asc())
                )
                .scalars()
                .all()
            )
            return {
                "idempotent": True,
                "change_set": _change_set_to_dict(existing),
                "items": [_item_to_dict(i) for i in items2],
                "conflicts": [],
            }
        raise

    log_event(
        logger,
        "info",
        event="MEMORY_CHANGESET_PROPOSED",
        change_set_id=str(change_set.id),
        project_id=project_id,
        items_count=len(items),
    )
    return {
        "idempotent": False,
        "change_set": _change_set_to_dict(change_set),
        "items": [_item_to_dict(i) for i in items],
        "conflicts": conflicts,
    }


def propose_project_table_change_set(
    *,
    db: Session,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    payload: TableUpdateV1Request,
) -> dict[str, Any]:
    existing = (
        db.execute(
            select(MemoryChangeSet).where(
                MemoryChangeSet.project_id == project_id,
                MemoryChangeSet.idempotency_key == payload.idempotency_key,
            )
        )
        .scalars()
        .first()
    )
    if existing is not None:
        items = (
            db.execute(
                select(MemoryChangeSetItem)
                .where(MemoryChangeSetItem.change_set_id == existing.id)
                .order_by(MemoryChangeSetItem.item_index.asc())
            )
            .scalars()
            .all()
        )
        return {
            "idempotent": True,
            "change_set": _change_set_to_dict(existing),
            "items": [_item_to_dict(i) for i in items],
        }

    generation_run_id = new_id()
    db.add(
        GenerationRun(
            id=generation_run_id,
            project_id=project_id,
            actor_user_id=actor_user_id,
            chapter_id=None,
            type="table_update_propose",
            provider=None,
            model=None,
            request_id=request_id,
            prompt_system="",
            prompt_user="",
            prompt_render_log_json=None,
            params_json=_compact_json_dumps(
                {
                    "schema_version": payload.schema_version,
                    "idempotency_key": payload.idempotency_key,
                    "ops_count": len(payload.ops),
                }
            ),
            output_text=_compact_json_dumps(payload.model_dump()),
            error_json=None,
        )
    )

    change_set = MemoryChangeSet(
        id=new_id(),
        project_id=project_id,
        actor_user_id=actor_user_id,
        generation_run_id=generation_run_id,
        request_id=request_id,
        idempotency_key=payload.idempotency_key,
        title=payload.title,
        summary_md=payload.summary_md,
        status="proposed",
    )
    db.add(change_set)

    items: list[MemoryChangeSetItem] = []
    for idx, op in enumerate(payload.ops):
        table_id = str(op.table_id or "").strip()
        if not table_id:
            raise AppError.validation(details={"item_index": idx, "reason": "table_id_missing"})
        table = db.get(ProjectTable, table_id)
        if table is None or str(table.project_id) != str(project_id):
            raise AppError.validation(details={"item_index": idx, "reason": "table_not_found", "table_id": table_id})

        target_table = "project_table_rows"
        after_dict: dict[str, Any] | None = None

        if op.op == "delete":
            target_id = str(op.row_id or "").strip()
            if not target_id:
                raise AppError.validation(details={"item_index": idx, "reason": "row_id_missing"})
            row = db.get(ProjectTableRow, target_id)
            if row is None or str(row.project_id) != str(project_id) or str(row.table_id) != str(table_id):
                raise AppError.validation(details={"item_index": idx, "reason": "target_not_found", "row_id": target_id})
            before_row = row
        else:
            target_id = str(op.row_id or "").strip()
            if not target_id:
                schema_obj = _compact_json_loads(getattr(table, "schema_json", None))
                schema_dict = schema_obj if isinstance(schema_obj, dict) else {}
                if is_key_value_schema(schema_dict) and isinstance(op.data, dict):
                    key_value = str(op.data.get("key") or "").strip()
                    if key_value:
                        candidates = (
                            db.execute(
                                select(ProjectTableRow.id, ProjectTableRow.data_json)
                                .where(
                                    ProjectTableRow.project_id == project_id,
                                    ProjectTableRow.table_id == table_id,
                                )
                                .order_by(ProjectTableRow.updated_at.desc(), ProjectTableRow.id.desc())
                                .limit(2000)
                            )
                            .all()
                        )
                        for row_id, data_json in candidates:
                            data_obj = _compact_json_loads(data_json)
                            if isinstance(data_obj, dict) and str(data_obj.get("key") or "").strip() == key_value:
                                target_id = str(row_id)
                                break
            if not target_id:
                target_id = new_id()
            before_row = db.get(ProjectTableRow, target_id)
            if before_row is not None and (str(before_row.project_id) != str(project_id) or str(before_row.table_id) != str(table_id)):
                raise AppError.validation(details={"item_index": idx, "reason": "row_table_mismatch", "row_id": target_id})

            if op.row_index is not None:
                row_index = int(op.row_index)
            elif before_row is not None:
                row_index = int(getattr(before_row, "row_index", 0) or 0)
            else:
                max_idx = (
                    db.execute(select(func.max(ProjectTableRow.row_index)).where(ProjectTableRow.table_id == table_id)).scalar()
                )
                row_index = int(max_idx or 0) + 1

            data_norm = validate_row_data_for_table(schema_json=str(table.schema_json or "{}"), data=op.data)
            after_dict = {"table_id": table_id, "row_index": int(row_index), "data": data_norm}

        before_dict = _row_payload(target_table, before_row) if before_row is not None else None
        item = MemoryChangeSetItem(
            id=new_id(),
            project_id=project_id,
            change_set_id=str(change_set.id),
            item_index=idx,
            target_table=target_table,
            target_id=target_id,
            op=str(op.op),
            before_json=_compact_json_dumps(before_dict) if before_dict is not None else None,
            after_json=_compact_json_dumps(after_dict) if after_dict is not None else None,
            evidence_ids_json=None,
        )
        items.append(item)
        db.add(item)

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        log_event(
            logger,
            "warning",
            event="MEMORY_CHANGESET_PROPOSE_CONFLICT",
            project_id=project_id,
            idempotency_key=payload.idempotency_key,
            **exception_log_fields(exc),
        )
        existing2 = (
            db.execute(
                select(MemoryChangeSet).where(
                    MemoryChangeSet.project_id == project_id,
                    MemoryChangeSet.idempotency_key == payload.idempotency_key,
                )
            )
            .scalars()
            .first()
        )
        if existing2 is not None:
            items2 = (
                db.execute(
                    select(MemoryChangeSetItem)
                    .where(MemoryChangeSetItem.change_set_id == existing2.id)
                    .order_by(MemoryChangeSetItem.item_index.asc())
                )
                .scalars()
                .all()
            )
            return {
                "idempotent": True,
                "change_set": _change_set_to_dict(existing2),
                "items": [_item_to_dict(i) for i in items2],
            }
        raise

    log_event(
        logger,
        "info",
        event="TABLE_CHANGESET_PROPOSED",
        change_set_id=str(change_set.id),
        project_id=project_id,
        items_count=len(items),
    )
    return {
        "idempotent": False,
        "change_set": _change_set_to_dict(change_set),
        "items": [_item_to_dict(i) for i in items],
    }


def _apply_upsert(
    db: Session, *, target_table: str, project_id: str, target_id: str, after: dict[str, Any]
) -> Any:
    model = _MODEL_BY_TABLE.get(target_table)
    if model is None:
        raise AppError.validation(details={"target_table": target_table})

    row = _load_target_row(db, target_table=target_table, project_id=project_id, target_id=target_id)
    if row is None:
        row = model(id=target_id, project_id=project_id)  # type: ignore[call-arg]
        db.add(row)

    if target_table == "entities":
        row.entity_type = str(after.get("entity_type") or "generic")  # type: ignore[attr-defined]
        row.name = str(after.get("name") or "")  # type: ignore[attr-defined]
        row.summary_md = after.get("summary_md")  # type: ignore[attr-defined]
        attrs = after.get("attributes")
        if isinstance(attrs, dict):
            row.attributes_json = _compact_json_dumps(attrs)  # type: ignore[attr-defined]
        elif isinstance(attrs, str):
            row.attributes_json = attrs  # type: ignore[attr-defined]
        else:
            row.attributes_json = None  # type: ignore[attr-defined]
        row.deleted_at = None  # type: ignore[attr-defined]
        return row

    if target_table == "relations":
        row.from_entity_id = str(after.get("from_entity_id") or "")  # type: ignore[attr-defined]
        row.to_entity_id = str(after.get("to_entity_id") or "")  # type: ignore[attr-defined]
        row.relation_type = str(after.get("relation_type") or "related_to")  # type: ignore[attr-defined]
        row.description_md = after.get("description_md")  # type: ignore[attr-defined]
        attrs = after.get("attributes")
        if isinstance(attrs, dict):
            row.attributes_json = _compact_json_dumps(attrs)  # type: ignore[attr-defined]
        elif isinstance(attrs, str):
            row.attributes_json = attrs  # type: ignore[attr-defined]
        else:
            row.attributes_json = None  # type: ignore[attr-defined]
        row.deleted_at = None  # type: ignore[attr-defined]
        return row

    if target_table == "events":
        row.chapter_id = after.get("chapter_id")  # type: ignore[attr-defined]
        row.event_type = str(after.get("event_type") or "event")  # type: ignore[attr-defined]
        row.title = after.get("title")  # type: ignore[attr-defined]
        row.content_md = str(after.get("content_md") or "")  # type: ignore[attr-defined]
        attrs = after.get("attributes")
        if isinstance(attrs, dict):
            row.attributes_json = _compact_json_dumps(attrs)  # type: ignore[attr-defined]
        elif isinstance(attrs, str):
            row.attributes_json = attrs  # type: ignore[attr-defined]
        else:
            row.attributes_json = None  # type: ignore[attr-defined]
        row.deleted_at = None  # type: ignore[attr-defined]
        return row

    if target_table == "foreshadows":
        row.chapter_id = after.get("chapter_id")  # type: ignore[attr-defined]
        row.resolved_at_chapter_id = after.get("resolved_at_chapter_id")  # type: ignore[attr-defined]
        row.title = after.get("title")  # type: ignore[attr-defined]
        row.content_md = str(after.get("content_md") or "")  # type: ignore[attr-defined]
        row.resolved = int(after.get("resolved") or 0)  # type: ignore[attr-defined]
        attrs = after.get("attributes")
        if isinstance(attrs, dict):
            row.attributes_json = _compact_json_dumps(attrs)  # type: ignore[attr-defined]
        elif isinstance(attrs, str):
            row.attributes_json = attrs  # type: ignore[attr-defined]
        else:
            row.attributes_json = None  # type: ignore[attr-defined]
        row.deleted_at = None  # type: ignore[attr-defined]
        return row

    if target_table == "evidence":
        row.source_type = str(after.get("source_type") or "unknown")  # type: ignore[attr-defined]
        row.source_id = after.get("source_id")  # type: ignore[attr-defined]
        row.quote_md = str(after.get("quote_md") or "")  # type: ignore[attr-defined]
        attrs = after.get("attributes")
        if isinstance(attrs, dict):
            row.attributes_json = _compact_json_dumps(attrs)  # type: ignore[attr-defined]
        elif isinstance(attrs, str):
            row.attributes_json = attrs  # type: ignore[attr-defined]
        else:
            row.attributes_json = None  # type: ignore[attr-defined]
        row.deleted_at = None  # type: ignore[attr-defined]
        return row

    if target_table == "project_table_rows":
        table_id = str(after.get("table_id") or "").strip()
        if not table_id:
            raise AppError.validation(details={"target_table": target_table, "reason": "table_id_missing"})
        table = db.get(ProjectTable, table_id)
        if table is None or str(table.project_id) != str(project_id):
            raise AppError.validation(details={"target_table": target_table, "reason": "table_not_found", "table_id": table_id})

        row_index_raw = after.get("row_index")
        try:
            row_index = int(row_index_raw)  # type: ignore[arg-type]
        except Exception:
            raise AppError.validation(details={"target_table": target_table, "reason": "row_index_invalid"}) from None
        if row_index < 0:
            raise AppError.validation(details={"target_table": target_table, "reason": "row_index_invalid"})

        data_norm = validate_row_data_for_table(schema_json=str(table.schema_json or "{}"), data=after.get("data"))
        if str(getattr(row, "table_id", "") or "") and str(getattr(row, "table_id", "")) != str(table_id):
            raise AppError.conflict(
                message="Row already belongs to another table",
                details={"target_table": target_table, "target_id": target_id, "table_id": table_id},
            )

        row.table_id = table_id  # type: ignore[attr-defined]
        row.row_index = row_index  # type: ignore[attr-defined]
        row.data_json = _compact_json_dumps(data_norm)  # type: ignore[attr-defined]
        return row

    raise AppError.validation(details={"target_table": target_table})


def apply_memory_change_set(
    *,
    db: Session,
    request_id: str,
    actor_user_id: str,
    change_set: MemoryChangeSet,
) -> dict[str, Any]:
    project_id = str(change_set.project_id)
    if change_set.status == "applied":
        return {"idempotent": True, "change_set": _change_set_to_dict(change_set), "warnings": []}
    if change_set.status != "proposed":
        raise AppError.conflict(details={"status": change_set.status})

    items = (
        db.execute(
            select(MemoryChangeSetItem)
            .where(MemoryChangeSetItem.change_set_id == change_set.id)
            .order_by(MemoryChangeSetItem.item_index.asc())
        )
        .scalars()
        .all()
    )
    if not items:
        raise AppError.validation(details={"reason": "no_items"})

    warnings: list[dict[str, Any]] = []

    try:
        for item in items:
            target_table = str(item.target_table)
            target_id = str(item.target_id or "")
            if not target_id:
                raise AppError.validation(details={"item_id": str(item.id), "reason": "target_id_missing"})

            before_expected = _compact_json_loads(item.before_json)
            current_row = _load_target_row(db, target_table=target_table, project_id=project_id, target_id=target_id)
            if isinstance(before_expected, dict):
                current_dict = _row_payload(target_table, current_row) if current_row is not None else None
                if current_dict != before_expected:
                    warnings.append(
                        {
                            "code": "MEMORY_CONFLICT",
                            "message": "Target changed since propose; applied anyway",
                            "item_id": str(item.id),
                            "target_table": target_table,
                            "target_id": target_id,
                        }
                    )

            if item.op == "delete":
                if current_row is None:
                    warnings.append(
                        {
                            "code": "MISSING_TARGET",
                            "message": "Target not found during apply delete; skipped",
                            "item_id": str(item.id),
                            "target_table": target_table,
                            "target_id": target_id,
                        }
                    )
                    continue
                if target_table == "project_table_rows":
                    db.delete(current_row)
                else:
                    current_row.deleted_at = utc_now()  # type: ignore[attr-defined]
                continue

            after_value = _compact_json_loads(item.after_json)
            if not isinstance(after_value, dict):
                raise AppError.validation(details={"item_id": str(item.id), "reason": "after_json_invalid"})
            _apply_upsert(db, target_table=target_table, project_id=project_id, target_id=target_id, after=after_value)

        change_set.status = "applied"
        change_set.applied_at = utc_now()

        db.commit()

        try:
            _schedule_memory_tasks_after_apply(db=db, request_id=request_id, actor_user_id=actor_user_id, change_set=change_set)
        except Exception as exc:
            log_event(
                logger,
                "warning",
                event="MEMORY_TASKS_ENQUEUE_FAILED",
                change_set_id=str(change_set.id),
                project_id=project_id,
                error_type=type(exc).__name__,
            )

        log_event(
            logger,
            "info",
            event="MEMORY_CHANGESET_APPLIED",
            change_set_id=str(change_set.id),
            project_id=project_id,
            actor_user_id=actor_user_id,
            warnings_count=len(warnings),
        )
        return {"idempotent": False, "change_set": _change_set_to_dict(change_set), "warnings": warnings}
    except IntegrityError as exc:
        db.rollback()
        log_event(
            logger,
            "warning",
            event="MEMORY_CHANGESET_APPLY_INTEGRITY_ERROR",
            change_set_id=str(change_set.id),
            project_id=project_id,
            **exception_log_fields(exc),
        )
        change_set.status = "failed"
        try:
            db.commit()
        except Exception:
            db.rollback()
        raise AppError.conflict(message="记忆变更集应用失败", details={"reason": "integrity_error"}) from exc
    except Exception:
        db.rollback()
        raise


def _ensure_memory_tasks(
    *,
    db: Session,
    project_id: str,
    change_set_id: str,
    actor_user_id: str,
) -> list[MemoryTask]:
    kinds = ["vector_rebuild", "graph_update", "fractal_rebuild"]
    existing = (
        db.execute(select(MemoryTask).where(MemoryTask.change_set_id == change_set_id).order_by(MemoryTask.kind.asc()))
        .scalars()
        .all()
    )
    by_kind = {str(t.kind): t for t in existing}

    tasks: list[MemoryTask] = []
    for kind in kinds:
        row = by_kind.get(kind)
        if row is None:
            row = MemoryTask(
                id=new_id(),
                project_id=project_id,
                change_set_id=change_set_id,
                actor_user_id=actor_user_id,
                kind=kind,
                status="queued",
            )
            db.add(row)
        tasks.append(row)
    db.commit()
    return tasks


def _schedule_memory_tasks_after_apply(*, db: Session, request_id: str, actor_user_id: str, change_set: MemoryChangeSet) -> None:
    project_id = str(change_set.project_id)
    tasks = _ensure_memory_tasks(db=db, project_id=project_id, change_set_id=str(change_set.id), actor_user_id=actor_user_id)

    from app.services.task_queue import get_task_queue

    queue = get_task_queue()
    for task in tasks:
        if str(task.status) != "queued":
            continue
        try:
            queue.enqueue(kind="memory_task", task_id=str(task.id))
        except Exception as exc:
            safe_message = redact_secrets_text(str(exc)).replace("\n", " ").strip()
            if not safe_message:
                safe_message = type(exc).__name__

            if isinstance(exc, AppError):
                details = exc.details if isinstance(exc.details, dict) else {}
                error_payload = {
                    "error_type": type(exc).__name__,
                    "code": str(exc.code),
                    "message": safe_message[:200],
                    "details": redact_api_keys(details),
                }
            else:
                error_payload = {"error_type": type(exc).__name__, "message": safe_message[:200]}

            task.status = "failed"
            task.finished_at = utc_now()
            task.error_json = _compact_json_dumps(error_payload)
            db.commit()
            log_event(
                logger,
                "warning",
                event="MEMORY_TASK_ENQUEUE_ERROR",
                project_id=project_id,
                change_set_id=str(change_set.id),
                task_id=str(task.id),
                kind=str(task.kind),
                error_type=type(exc).__name__,
            )
            continue

    log_event(
        logger,
        "info",
        event="MEMORY_TASKS_ENQUEUED",
        project_id=project_id,
        change_set_id=str(change_set.id),
        tasks=[{"id": str(t.id), "kind": str(t.kind)} for t in tasks],
        request_id=request_id,
    )


def run_memory_task(*, task_id: str) -> str:
    """
    RQ worker entrypoint. Consumes MemoryTask and records result to DB.
    """

    db = SessionLocal()
    try:
        task = db.get(MemoryTask, task_id)
        if task is None:
            log_event(logger, "warning", event="MEMORY_TASK_MISSING", task_id=task_id)
            return task_id

        if str(task.status) in {"succeeded", "failed", "running"}:
            return task_id

        task.status = "running"
        task.started_at = utc_now()
        db.commit()

        kind = str(task.kind)
        project_id = str(task.project_id)

        result: dict[str, Any]
        if kind == "graph_update":
            result = {"skipped": True, "note": "graph context is computed on query; no rebuild required"}
        elif kind == "fractal_rebuild":
            if not bool(getattr(settings, "fractal_enabled", True)):
                result = {"skipped": True, "disabled_reason": "disabled"}
            else:
                result = rebuild_fractal_memory(db=db, project_id=project_id, reason=f"memory_task:{task_id[:8]}")
        elif kind == "vector_rebuild":
            db2 = SessionLocal()
            try:
                embedding = vector_embedding_overrides(db2.get(ProjectSettings, project_id))
                status = vector_rag_status(project_id=project_id, embedding=embedding)
                if not bool(status.get("enabled")):
                    result = {"skipped": True, **status}
                else:
                    chunks = build_project_chunks(db=db2, project_id=project_id)
                    result = rebuild_project(project_id=project_id, chunks=chunks, embedding=embedding)
                    if bool(result.get("enabled")) and not bool(result.get("skipped")):
                        settings_row = db2.get(ProjectSettings, project_id)
                        if settings_row is None:
                            settings_row = ProjectSettings(project_id=project_id)
                            db2.add(settings_row)
                        settings_row.vector_index_dirty = False
                        settings_row.last_vector_build_at = utc_now()
                        db2.commit()
            finally:
                db2.close()
        else:
            raise ValueError(f"Unsupported MemoryTask.kind: {kind!r}")

        task.status = "succeeded"
        task.result_json = _compact_json_dumps(result)
        task.finished_at = utc_now()
        db.commit()

        log_event(
            logger,
            "info",
            event="MEMORY_TASK_SUCCEEDED",
            task_id=task_id,
            project_id=str(task.project_id),
            kind=kind,
        )
        return task_id
    except Exception as exc:
        try:
            task2 = db.get(MemoryTask, task_id)
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
                task2.finished_at = utc_now()
                db.commit()
        except Exception:
            db.rollback()

        log_event(
            logger,
            "error",
            event="MEMORY_TASK_FAILED",
            task_id=task_id,
            error_type=type(exc).__name__,
            **exception_log_fields(exc),
        )
        return task_id
    finally:
        db.close()


def rollback_memory_change_set(
    *,
    db: Session,
    request_id: str,
    actor_user_id: str,
    change_set: MemoryChangeSet,
) -> dict[str, Any]:
    project_id = str(change_set.project_id)
    if change_set.status == "rolled_back":
        return {"idempotent": True, "change_set": _change_set_to_dict(change_set), "warnings": []}
    if change_set.status != "applied":
        raise AppError.conflict(details={"status": change_set.status})

    items = (
        db.execute(
            select(MemoryChangeSetItem)
            .where(MemoryChangeSetItem.change_set_id == change_set.id)
            .order_by(MemoryChangeSetItem.item_index.desc())
        )
        .scalars()
        .all()
    )
    if not items:
        raise AppError.validation(details={"reason": "no_items"})

    warnings: list[dict[str, Any]] = []
    try:
        for item in items:
            target_table = str(item.target_table)
            target_id = str(item.target_id or "")
            if not target_id:
                continue

            before_value = _compact_json_loads(item.before_json)
            current_row = _load_target_row(db, target_table=target_table, project_id=project_id, target_id=target_id)

            if item.op == "delete":
                if target_table == "project_table_rows":
                    if not isinstance(before_value, dict):
                        warnings.append(
                            {
                                "code": "MISSING_BEFORE",
                                "message": "Missing before_json for table row rollback; skipped",
                                "item_id": str(item.id),
                                "target_table": target_table,
                                "target_id": target_id,
                            }
                        )
                        continue
                    after_restore = dict(before_value)
                    after_restore.pop("id", None)
                    _apply_upsert(
                        db,
                        target_table=target_table,
                        project_id=project_id,
                        target_id=target_id,
                        after=after_restore,
                    )
                    continue
                if current_row is None:
                    warnings.append(
                        {
                            "code": "MISSING_TARGET",
                            "message": "Target not found during rollback delete; skipped",
                            "item_id": str(item.id),
                            "target_table": target_table,
                            "target_id": target_id,
                        }
                    )
                    continue
                if isinstance(before_value, dict):
                    current_row.deleted_at = _parse_dt(before_value.get("deleted_at"))  # type: ignore[attr-defined]
                else:
                    current_row.deleted_at = None  # type: ignore[attr-defined]
                continue

            # upsert rollback
            if current_row is None:
                warnings.append(
                    {
                        "code": "MISSING_TARGET",
                        "message": "Target not found during rollback upsert; skipped",
                        "item_id": str(item.id),
                        "target_table": target_table,
                        "target_id": target_id,
                    }
                )
                continue

            if not isinstance(before_value, dict):
                if target_table == "project_table_rows":
                    db.delete(current_row)
                else:
                    # Created during apply: soft-delete it.
                    current_row.deleted_at = utc_now()  # type: ignore[attr-defined]
                continue

            # Restore fields.
            after_restore = dict(before_value)
            after_restore.pop("id", None)
            if target_table != "project_table_rows":
                after_restore["deleted_at"] = before_value.get("deleted_at")
            _apply_upsert(
                db,
                target_table=target_table,
                project_id=project_id,
                target_id=target_id,
                after=after_restore,
            )
            if target_table != "project_table_rows":
                current_row.deleted_at = _parse_dt(before_value.get("deleted_at"))  # type: ignore[attr-defined]

        change_set.status = "rolled_back"
        change_set.rolled_back_at = utc_now()

        db.commit()

        log_event(
            logger,
            "info",
            event="MEMORY_CHANGESET_ROLLED_BACK",
            change_set_id=str(change_set.id),
            project_id=project_id,
            actor_user_id=actor_user_id,
            warnings_count=len(warnings),
        )
        return {"idempotent": False, "change_set": _change_set_to_dict(change_set), "warnings": warnings}
    except AppError:
        raise
    except Exception as exc:
        db.rollback()
        log_event(
            logger,
            "error",
            event="MEMORY_CHANGESET_ROLLBACK_ERROR",
            change_set_id=str(change_set.id),
            project_id=project_id,
            **exception_log_fields(exc),
        )
        raise
