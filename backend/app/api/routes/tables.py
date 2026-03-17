from __future__ import annotations

import json
import re
from typing import Any

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.deps import DbDep, UserIdDep, require_project_editor, require_project_viewer
from app.core.errors import AppError, ok_payload
from app.db.utils import new_id, utc_now
from app.models.chapter import Chapter
from app.models.project_table import ProjectTable, ProjectTableRow
from app.services.project_seed_service import ensure_default_numeric_tables
from app.services.table_ai_update_service import schedule_table_ai_update_task

router = APIRouter()

_TABLE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_COLUMN_KEY_RE = re.compile(r"^[A-Za-z0-9_]{1,64}$")
_ALLOWED_TYPES = {"string", "number", "boolean", "md", "json"}


def _compact_json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _safe_json_loads(value: str) -> Any:
    try:
        return json.loads(value)
    except Exception:
        return None


def _require_schema_dict(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise AppError.validation(message="schema 必须是 JSON object")
    return value


def _normalize_schema(schema: object) -> dict[str, Any]:
    raw = _require_schema_dict(schema)
    version = raw.get("version")
    if version is None:
        version = 1
    try:
        version_int = int(version)
    except Exception:
        raise AppError.validation(message="schema.version 必须是整数") from None
    if version_int < 1:
        raise AppError.validation(message="schema.version 必须 >= 1")

    columns_raw = raw.get("columns") if "columns" in raw else []
    if columns_raw is None:
        columns_raw = []
    if not isinstance(columns_raw, list):
        raise AppError.validation(message="schema.columns 必须是数组")

    seen: set[str] = set()
    columns: list[dict[str, Any]] = []
    for idx, c in enumerate(columns_raw):
        if not isinstance(c, dict):
            raise AppError.validation(message="schema.columns[*] 必须是 object", details={"column_index": idx})
        key = str(c.get("key") or "").strip()
        if not key:
            raise AppError.validation(message="schema.columns[*].key 不能为空", details={"column_index": idx})
        if not _COLUMN_KEY_RE.match(key):
            raise AppError.validation(message="schema.columns[*].key 仅允许字母数字与下划线，且长度<=64", details={"column_index": idx})
        if key in seen:
            raise AppError.validation(message="schema.columns[*].key 不能重复", details={"column_key": key})
        seen.add(key)

        col_type = str(c.get("type") or "string").strip().lower() or "string"
        if col_type not in _ALLOWED_TYPES:
            raise AppError.validation(message="schema.columns[*].type 不支持", details={"column_key": key, "type": col_type})

        label = c.get("label")
        label_str = str(label).strip() if label is not None else None
        required = bool(c.get("required")) if "required" in c else False

        columns.append({"key": key, "type": col_type, "label": label_str, "required": required})

    return {"version": version_int, "columns": columns}


def _validate_row_data(*, schema: dict[str, Any], data: object) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise AppError.validation(message="data 必须是 JSON object")

    cols = schema.get("columns") if isinstance(schema.get("columns"), list) else []
    col_by_key = {str(c.get("key")): c for c in cols if isinstance(c, dict) and str(c.get("key") or "").strip()}

    out: dict[str, Any] = {}
    for k, v in data.items():
        key = str(k or "").strip()
        if not key:
            raise AppError.validation(message="data 字段名不能为空")
        col = col_by_key.get(key)
        if col is None:
            raise AppError.validation(message="data 包含未知字段", details={"field": key})
        col_type = str(col.get("type") or "string")

        if v is None:
            out[key] = None
            continue

        if col_type in {"string", "md"}:
            if not isinstance(v, str):
                raise AppError.validation(message="字段类型不匹配（应为 string）", details={"field": key})
            out[key] = v
            continue
        if col_type == "number":
            if not isinstance(v, (int, float)):
                raise AppError.validation(message="字段类型不匹配（应为 number）", details={"field": key})
            num = float(v)
            if not (num == num and num not in (float("inf"), float("-inf"))):
                raise AppError.validation(message="字段类型不匹配（number 非法）", details={"field": key})
            out[key] = v
            continue
        if col_type == "boolean":
            if not isinstance(v, bool):
                raise AppError.validation(message="字段类型不匹配（应为 boolean）", details={"field": key})
            out[key] = v
            continue
        if col_type == "json":
            try:
                _compact_json_dumps(v)
            except Exception:
                raise AppError.validation(message="字段类型不匹配（应为可序列化 JSON）", details={"field": key}) from None
            out[key] = v
            continue

        raise AppError.validation(message="字段类型不支持", details={"field": key, "type": col_type})

    for key, c in col_by_key.items():
        if not bool(c.get("required")):
            continue
        if key not in out:
            raise AppError.validation(message="缺少必填字段", details={"field": key})
        val = out.get(key)
        if val is None:
            raise AppError.validation(message="必填字段不可为 null", details={"field": key})
        if isinstance(val, str) and not val.strip():
            raise AppError.validation(message="必填字段不能为空", details={"field": key})

    return out


def _table_public(row: ProjectTable, *, include_schema: bool, row_count: int | None = None) -> dict[str, Any]:
    schema = _safe_json_loads(row.schema_json) if include_schema else None
    out: dict[str, Any] = {
        "id": row.id,
        "project_id": row.project_id,
        "table_key": row.table_key,
        "name": row.name,
        "auto_update_enabled": bool(getattr(row, "auto_update_enabled", True)),
        "schema_version": int(row.schema_version or 1),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    if include_schema:
        out["schema"] = schema if isinstance(schema, dict) else {}
    if row_count is not None:
        out["row_count"] = int(row_count)
    return out


def _row_public(row: ProjectTableRow, *, include_data: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": row.id,
        "project_id": row.project_id,
        "table_id": row.table_id,
        "row_index": int(row.row_index or 0),
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    if include_data:
        data = _safe_json_loads(row.data_json)
        out["data"] = data if isinstance(data, dict) else {}
    return out


class TableCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    table_key: str | None = Field(default=None, max_length=64)
    name: str = Field(min_length=1, max_length=255)
    auto_update_enabled: bool | None = Field(default=None)
    schema_: dict[str, Any] = Field(default_factory=dict, alias="schema")


class TableUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    name: str | None = Field(default=None, max_length=255)
    auto_update_enabled: bool | None = Field(default=None)
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")


class TableRowCreateRequest(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)


class TableRowUpdateRequest(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)


class TableAiUpdateRequest(BaseModel):
    focus: str | None = Field(default=None, max_length=4000)


@router.get("/projects/{project_id}/tables")
def list_project_tables(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    include_schema: bool = Query(default=False),
) -> dict:
    request_id = request.state.request_id
    require_project_viewer(db, project_id=project_id, user_id=user_id)

    # Seed defaults for empty projects (idempotent).
    existing = (
        db.execute(select(ProjectTable.id).where(ProjectTable.project_id == project_id).limit(1)).scalars().first() is not None
    )
    if not existing:
        try:
            require_project_editor(db, project_id=project_id, user_id=user_id)
        except AppError:
            pass
        else:
            ensure_default_numeric_tables(db, project_id=project_id)

    tables = (
        db.execute(
            select(ProjectTable)
            .where(ProjectTable.project_id == project_id)
            .order_by(ProjectTable.updated_at.desc(), ProjectTable.id.desc())
        )
        .scalars()
        .all()
    )
    counts = dict(
        db.execute(
            select(ProjectTableRow.table_id, func.count())
            .where(ProjectTableRow.project_id == project_id)
            .group_by(ProjectTableRow.table_id)
        )
        .all()
    )

    return ok_payload(
        request_id=request_id,
        data={
            "tables": [_table_public(t, include_schema=include_schema, row_count=int(counts.get(t.id, 0))) for t in tables]
        },
    )


@router.post("/projects/{project_id}/tables/seed_defaults")
def seed_default_project_tables(request: Request, db: DbDep, user_id: UserIdDep, project_id: str) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)
    result = ensure_default_numeric_tables(db, project_id=project_id)
    return ok_payload(request_id=request_id, data={"result": result})


@router.post("/projects/{project_id}/tables")
def create_project_table(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    body: TableCreateRequest,
) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    name = str(body.name or "").strip()
    if not name:
        raise AppError.validation(message="name 不能为空")

    requested = str(body.table_key or "").strip()
    if requested:
        if not _TABLE_KEY_RE.match(requested):
            raise AppError.validation(message="table_key 仅允许字母数字_- 且长度<=64")
        table_key = requested
    else:
        table_key = f"tbl_{new_id()[:8]}"

    schema_norm = _normalize_schema(body.schema_)
    schema_json = _compact_json_dumps(schema_norm)

    row = ProjectTable(
        id=new_id(),
        project_id=project_id,
        table_key=table_key,
        name=name,
        auto_update_enabled=bool(body.auto_update_enabled) if body.auto_update_enabled is not None else True,
        schema_version=1,
        schema_json=schema_json,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise AppError.conflict("table_key 已存在") from None
    db.refresh(row)
    return ok_payload(request_id=request_id, data={"table": _table_public(row, include_schema=True, row_count=0)})


@router.get("/projects/{project_id}/tables/{table_id}")
def get_project_table(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    table_id: str,
    include_schema: bool = Query(default=True),
) -> dict:
    request_id = request.state.request_id
    require_project_viewer(db, project_id=project_id, user_id=user_id)

    table = db.get(ProjectTable, table_id)
    if table is None or str(table.project_id) != str(project_id):
        raise AppError.not_found()
    count = int(
        db.execute(select(func.count()).select_from(ProjectTableRow).where(ProjectTableRow.table_id == table_id)).scalar() or 0
    )
    return ok_payload(request_id=request_id, data={"table": _table_public(table, include_schema=include_schema, row_count=count)})


@router.put("/projects/{project_id}/tables/{table_id}")
def update_project_table(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    table_id: str,
    body: TableUpdateRequest,
) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    table = db.get(ProjectTable, table_id)
    if table is None or str(table.project_id) != str(project_id):
        raise AppError.not_found()

    if body.name is not None:
        name = str(body.name or "").strip()
        if not name:
            raise AppError.validation(message="name 不能为空")
        table.name = name

    if body.auto_update_enabled is not None:
        table.auto_update_enabled = bool(body.auto_update_enabled)

    if body.schema_ is not None:
        schema_norm = _normalize_schema(body.schema_)

        # Ensure existing rows are still compatible (fail-closed).
        rows = (
            db.execute(
                select(ProjectTableRow).where(ProjectTableRow.table_id == table_id).order_by(ProjectTableRow.row_index.asc(), ProjectTableRow.id.asc())
            )
            .scalars()
            .all()
        )
        for r in rows:
            data_obj = _safe_json_loads(r.data_json)
            if not isinstance(data_obj, dict):
                raise AppError.validation(message="存在非法 row.data_json", details={"row_id": r.id})
            try:
                _validate_row_data(schema=schema_norm, data=data_obj)
            except AppError as exc:
                raise AppError.validation(message="schema 更新会导致现有行不兼容", details={"row_id": r.id, "error": exc.details}) from None

        table.schema_json = _compact_json_dumps(schema_norm)
        table.schema_version = int(table.schema_version or 1) + 1

    db.commit()
    db.refresh(table)
    count = int(
        db.execute(select(func.count()).select_from(ProjectTableRow).where(ProjectTableRow.table_id == table_id)).scalar() or 0
    )
    return ok_payload(request_id=request_id, data={"table": _table_public(table, include_schema=True, row_count=count)})


@router.delete("/projects/{project_id}/tables/{table_id}")
def delete_project_table(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    table_id: str,
) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    table = db.get(ProjectTable, table_id)
    if table is None or str(table.project_id) != str(project_id):
        raise AppError.not_found()

    db.delete(table)
    db.commit()
    return ok_payload(request_id=request_id, data={"deleted": True})


@router.get("/projects/{project_id}/tables/{table_id}/rows")
def list_project_table_rows(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    table_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    request_id = request.state.request_id
    require_project_viewer(db, project_id=project_id, user_id=user_id)

    table = db.get(ProjectTable, table_id)
    if table is None or str(table.project_id) != str(project_id):
        raise AppError.not_found()

    total = int(
        db.execute(select(func.count()).select_from(ProjectTableRow).where(ProjectTableRow.table_id == table_id)).scalar() or 0
    )
    rows = (
        db.execute(
            select(ProjectTableRow)
            .where(ProjectTableRow.table_id == table_id)
            .order_by(ProjectTableRow.row_index.asc(), ProjectTableRow.id.asc())
            .offset(int(offset))
            .limit(int(limit))
        )
        .scalars()
        .all()
    )

    return ok_payload(request_id=request_id, data={"rows": [_row_public(r) for r in rows], "total": total, "offset": int(offset), "returned": len(rows)})


@router.post("/projects/{project_id}/tables/{table_id}/rows")
def create_project_table_row(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    table_id: str,
    body: TableRowCreateRequest,
) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    table = db.get(ProjectTable, table_id)
    if table is None or str(table.project_id) != str(project_id):
        raise AppError.not_found()
    schema_obj = _safe_json_loads(table.schema_json)
    if not isinstance(schema_obj, dict):
        raise AppError.validation(message="table.schema_json 非法", details={"table_id": table_id})

    data_norm = _validate_row_data(schema=schema_obj, data=body.data)
    data_json = _compact_json_dumps(data_norm)

    max_idx = (
        db.execute(select(func.max(ProjectTableRow.row_index)).where(ProjectTableRow.table_id == table_id)).scalar()
    )
    next_idx = int(max_idx or 0) + 1

    row = ProjectTableRow(
        id=new_id(),
        project_id=project_id,
        table_id=table_id,
        row_index=next_idx,
        data_json=data_json,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return ok_payload(request_id=request_id, data={"row": _row_public(row)})


@router.put("/projects/{project_id}/tables/{table_id}/rows/{row_id}")
def update_project_table_row(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    table_id: str,
    row_id: str,
    body: TableRowUpdateRequest,
) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    table = db.get(ProjectTable, table_id)
    if table is None or str(table.project_id) != str(project_id):
        raise AppError.not_found()
    row = db.get(ProjectTableRow, row_id)
    if row is None or str(row.project_id) != str(project_id) or str(row.table_id) != str(table_id):
        raise AppError.not_found()

    schema_obj = _safe_json_loads(table.schema_json)
    if not isinstance(schema_obj, dict):
        raise AppError.validation(message="table.schema_json 非法", details={"table_id": table_id})

    data_norm = _validate_row_data(schema=schema_obj, data=body.data)
    row.data_json = _compact_json_dumps(data_norm)

    db.commit()
    db.refresh(row)
    return ok_payload(request_id=request_id, data={"row": _row_public(row)})


@router.delete("/projects/{project_id}/tables/{table_id}/rows/{row_id}")
def delete_project_table_row(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    table_id: str,
    row_id: str,
) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    table = db.get(ProjectTable, table_id)
    if table is None or str(table.project_id) != str(project_id):
        raise AppError.not_found()
    row = db.get(ProjectTableRow, row_id)
    if row is None or str(row.project_id) != str(project_id) or str(row.table_id) != str(table_id):
        raise AppError.not_found()

    db.delete(row)
    db.commit()
    return ok_payload(request_id=request_id, data={"deleted": True})


@router.post("/projects/{project_id}/tables/{table_id}/ai_update")
def schedule_project_table_ai_update(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    table_id: str,
    body: TableAiUpdateRequest,
    chapter_id: str | None = Query(default=None, max_length=36),
) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    table = db.get(ProjectTable, table_id)
    if table is None or str(table.project_id) != str(project_id):
        raise AppError.not_found()

    chapter: Chapter | None = None
    if chapter_id is not None and str(chapter_id).strip():
        chapter = db.get(Chapter, str(chapter_id))
        if chapter is None or str(getattr(chapter, "project_id", "")) != str(project_id):
            raise AppError.not_found("章节不存在")
        if str(getattr(chapter, "status", "") or "") != "done":
            raise AppError.validation(details={"reason": "chapter_not_done"})
    else:
        chapter = (
            db.execute(
                select(Chapter)
                .where(
                    Chapter.project_id == project_id,
                    Chapter.status == "done",
                )
                .order_by(Chapter.updated_at.desc(), Chapter.id.desc())
                .limit(1)
            )
            .scalars()
            .first()
        )

    cid = str(getattr(chapter, "id", "") or "").strip() or None
    updated_at = getattr(chapter, "updated_at", None) if chapter is not None else None
    token = updated_at.isoformat().replace("+00:00", "Z") if updated_at is not None else utc_now().isoformat().replace("+00:00", "Z")

    task_id = schedule_table_ai_update_task(
        db=db,
        project_id=project_id,
        actor_user_id=user_id,
        request_id=request_id,
        table_id=table_id,
        chapter_id=cid,
        chapter_token=token,
        focus=body.focus,
        reason="manual_table_ai_update",
    )
    if not task_id:
        raise AppError.validation(details={"reason": "schedule_failed"})
    return ok_payload(request_id=request_id, data={"task_id": task_id, "chapter_id": cid, "table_id": table_id})
