from __future__ import annotations

import json

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DbDep, UserIdDep, require_project_editor
from app.core.errors import AppError, ok_payload
from app.db.utils import new_id, utc_now
from app.models.prompt_block import PromptBlock
from app.models.prompt_preset import PromptPreset
from app.models.prompt_preset_version import PromptPresetVersion
from app.models.llm_preset import LLMPreset
from app.schemas.prompt_presets import (
    PromptBlockCreate,
    PromptBlockOut,
    PromptBlockReorderRequest,
    PromptBlockUpdate,
    PromptPresetCreate,
    PromptPresetExportAllOut,
    PromptPresetExportOut,
    PromptPresetExportPreset,
    PromptPresetImportAllRequest,
    PromptPresetImportRequest,
    PromptPresetOut,
    PromptPresetResourceOut,
    PromptPresetUpdate,
    PromptPreviewBlock,
    PromptPreviewOut,
    PromptPreviewRequest,
)
from app.services.prompt_preset_resources import list_available_preset_resources, load_preset_resource
from app.services.prompt_presets import (
    ensure_default_content_optimize_preset,
    ensure_default_plan_preset,
    ensure_default_post_edit_preset,
    ensure_default_outline_preset,
    ensure_default_chapter_preset,
    ensure_default_chapter_analyze_preset,
    ensure_default_chapter_rewrite_preset,
    parse_json_dict,
    parse_json_list,
    reset_prompt_block_to_default_resource,
    reset_prompt_preset_to_default_resource,
    render_preset_for_task,
)
from app.services.prompt_version_service import record_prompt_preset_version, rollback_prompt_preset_to_version
from app.services.prompt_task_catalog import PROMPT_TASK_SET

router = APIRouter()


def _preset_to_out(row: PromptPreset) -> dict:
    return PromptPresetOut(
        id=row.id,
        project_id=row.project_id,
        name=row.name,
        resource_key=row.resource_key,
        category=row.category,
        scope=row.scope,
        version=row.version,
        active_for=parse_json_list(row.active_for_json),
        created_at=row.created_at,
        updated_at=row.updated_at,
    ).model_dump()


def _block_to_out(row: PromptBlock) -> dict:
    return PromptBlockOut(
        id=row.id,
        preset_id=row.preset_id,
        identifier=row.identifier,
        name=row.name,
        role=row.role,
        enabled=row.enabled,
        template=row.template,
        marker_key=row.marker_key,
        injection_position=row.injection_position,
        injection_depth=row.injection_depth,
        injection_order=row.injection_order,
        triggers=parse_json_list(row.triggers_json),
        forbid_overrides=row.forbid_overrides,
        budget=parse_json_dict(row.budget_json),
        cache=parse_json_dict(row.cache_json),
        created_at=row.created_at,
        updated_at=row.updated_at,
    ).model_dump()


@router.get("/projects/{project_id}/prompt_presets")
def list_prompt_presets(request: Request, db: DbDep, user_id: UserIdDep, project_id: str) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    # Ensure baseline presets exist (idempotent).
    ensure_default_plan_preset(db, project_id=project_id)
    ensure_default_post_edit_preset(db, project_id=project_id)
    ensure_default_content_optimize_preset(db, project_id=project_id)
    # Recommended presets for learning (not auto-active for existing projects).
    ensure_default_outline_preset(db, project_id=project_id, activate=False)
    ensure_default_chapter_preset(db, project_id=project_id, activate=False)
    ensure_default_chapter_analyze_preset(db, project_id=project_id, activate=False)
    ensure_default_chapter_rewrite_preset(db, project_id=project_id, activate=False)

    presets = (
        db.execute(select(PromptPreset).where(PromptPreset.project_id == project_id).order_by(PromptPreset.updated_at.desc()))
        .scalars()
        .all()
    )

    return ok_payload(request_id=request_id, data={"presets": [_preset_to_out(p) for p in presets]})


@router.get("/projects/{project_id}/prompt_preset_resources")
def list_prompt_preset_resources(request: Request, db: DbDep, user_id: UserIdDep, project_id: str) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    presets = db.execute(select(PromptPreset).where(PromptPreset.project_id == project_id)).scalars().all()
    by_resource_key = {str(p.resource_key): p for p in presets if p.resource_key}
    by_name = {str(p.name): p for p in presets if p.name}

    resources: list[dict] = []
    for key in list_available_preset_resources():
        res = load_preset_resource(key)
        preset = by_resource_key.get(key) or by_name.get(res.name)
        resources.append(
            PromptPresetResourceOut(
                key=res.key,
                name=res.name,
                category=res.category,
                scope=res.scope,
                version=res.version,
                activation_tasks=list(res.activation_tasks or []),
                preset_id=(preset.id if preset is not None else None),
                preset_version=(preset.version if preset is not None else None),
                preset_updated_at=(preset.updated_at if preset is not None else None),
            ).model_dump()
        )

    return ok_payload(request_id=request_id, data={"resources": resources})


@router.post("/projects/{project_id}/prompt_presets")
def create_prompt_preset(request: Request, db: DbDep, user_id: UserIdDep, project_id: str, body: PromptPresetCreate) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    row = PromptPreset(
        id=new_id(),
        project_id=project_id,
        name=body.name,
        category=body.category,
        scope=body.scope,
        version=body.version,
        active_for_json=json.dumps(body.active_for or [], ensure_ascii=False),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return ok_payload(request_id=request_id, data={"preset": _preset_to_out(row)})


@router.get("/prompt_presets/{preset_id}")
def get_prompt_preset(request: Request, db: DbDep, user_id: UserIdDep, preset_id: str) -> dict:
    request_id = request.state.request_id
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    blocks = (
        db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset_id).order_by(PromptBlock.injection_order.asc()))
        .scalars()
        .all()
    )
    return ok_payload(
        request_id=request_id,
        data={"preset": _preset_to_out(preset), "blocks": [_block_to_out(b) for b in blocks]},
    )


@router.get("/prompt_presets/{preset_id}/versions")
def list_prompt_preset_versions(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    preset_id: str,
    limit: int = Query(default=30, ge=1, le=200),
) -> dict:
    request_id = request.state.request_id
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    rows = (
        db.execute(
            select(PromptPresetVersion)
            .where(PromptPresetVersion.preset_id == preset_id)
            .order_by(PromptPresetVersion.version.desc(), PromptPresetVersion.created_at.desc())
            .limit(int(limit))
        )
        .scalars()
        .all()
    )
    items = [
        {
            "id": r.id,
            "project_id": r.project_id,
            "preset_id": r.preset_id,
            "actor_user_id": r.actor_user_id,
            "version": int(r.version),
            "preset_version": int(getattr(r, "preset_version", 1) or 1),
            "note": r.note,
            "created_at": r.created_at,
        }
        for r in rows
    ]
    return ok_payload(request_id=request_id, data={"versions": items})


class PromptPresetRollbackRequest(BaseModel):
    version_id: str | None = Field(default=None, max_length=36)
    version: int | None = Field(default=None, ge=1)


@router.post("/prompt_presets/{preset_id}/rollback")
def rollback_prompt_preset(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    preset_id: str,
    body: PromptPresetRollbackRequest,
) -> dict:
    request_id = request.state.request_id
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    version_row = None
    if body.version_id:
        version_row = db.get(PromptPresetVersion, str(body.version_id))
    if version_row is None and body.version is not None:
        version_row = (
            db.execute(
                select(PromptPresetVersion)
                .where(PromptPresetVersion.preset_id == preset_id, PromptPresetVersion.version == int(body.version))
            )
            .scalars()
            .first()
        )
    if version_row is None:
        raise AppError.validation(message="找不到指定的版本")

    rollback_prompt_preset_to_version(db=db, preset=preset, version_row=version_row, actor_user_id=user_id)
    db.commit()

    blocks = (
        db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset_id).order_by(PromptBlock.injection_order.asc()))
        .scalars()
        .all()
    )
    return ok_payload(
        request_id=request_id,
        data={"preset": _preset_to_out(preset), "blocks": [_block_to_out(b) for b in blocks]},
    )


@router.put("/prompt_presets/{preset_id}")
def update_prompt_preset(request: Request, db: DbDep, user_id: UserIdDep, preset_id: str, body: PromptPresetUpdate) -> dict:
    request_id = request.state.request_id
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    record_prompt_preset_version(db=db, preset=preset, actor_user_id=user_id, note="update_preset")

    if body.name is not None:
        preset.name = body.name
    if "category" in body.model_fields_set:
        preset.category = body.category
    if body.scope is not None:
        preset.scope = body.scope
    if body.version is not None:
        preset.version = body.version
    if body.active_for is not None:
        preset.active_for_json = json.dumps(body.active_for or [], ensure_ascii=False)

    db.commit()
    db.refresh(preset)
    return ok_payload(request_id=request_id, data={"preset": _preset_to_out(preset)})


@router.post("/prompt_presets/{preset_id}/reset_to_default")
def reset_prompt_preset_to_default(request: Request, db: DbDep, user_id: UserIdDep, preset_id: str) -> dict:
    request_id = request.state.request_id
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    record_prompt_preset_version(db=db, preset=preset, actor_user_id=user_id, note="reset_preset_to_default")
    preset = reset_prompt_preset_to_default_resource(db, preset=preset)
    blocks = (
        db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset.id).order_by(PromptBlock.injection_order.asc()))
        .scalars()
        .all()
    )
    return ok_payload(request_id=request_id, data={"preset": _preset_to_out(preset), "blocks": [_block_to_out(b) for b in blocks]})


@router.delete("/prompt_presets/{preset_id}")
def delete_prompt_preset(request: Request, db: DbDep, user_id: UserIdDep, preset_id: str) -> dict:
    request_id = request.state.request_id
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)
    db.delete(preset)
    db.commit()
    return ok_payload(request_id=request_id, data={})


@router.post("/prompt_presets/{preset_id}/blocks")
def create_prompt_block(request: Request, db: DbDep, user_id: UserIdDep, preset_id: str, body: PromptBlockCreate) -> dict:
    request_id = request.state.request_id
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)
    record_prompt_preset_version(db=db, preset=preset, actor_user_id=user_id, note="create_block")
    row = PromptBlock(
        id=new_id(),
        preset_id=preset_id,
        identifier=body.identifier,
        name=body.name,
        role=body.role,
        enabled=body.enabled,
        template=body.template,
        marker_key=body.marker_key,
        injection_position=body.injection_position,
        injection_depth=body.injection_depth,
        injection_order=body.injection_order,
        triggers_json=json.dumps(body.triggers or [], ensure_ascii=False),
        forbid_overrides=body.forbid_overrides,
        budget_json=json.dumps(body.budget or {}, ensure_ascii=False) if body.budget else None,
        cache_json=json.dumps(body.cache or {}, ensure_ascii=False) if body.cache else None,
    )
    db.add(row)
    preset.updated_at = utc_now()
    db.commit()
    db.refresh(row)
    return ok_payload(request_id=request_id, data={"block": _block_to_out(row)})


@router.put("/prompt_blocks/{block_id}")
def update_prompt_block(request: Request, db: DbDep, user_id: UserIdDep, block_id: str, body: PromptBlockUpdate) -> dict:
    request_id = request.state.request_id
    block = db.get(PromptBlock, block_id)
    if block is None:
        raise AppError.not_found()
    preset = db.get(PromptPreset, block.preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    record_prompt_preset_version(db=db, preset=preset, actor_user_id=user_id, note="update_block")
    if body.identifier is not None:
        block.identifier = body.identifier
    if body.name is not None:
        block.name = body.name
    if body.role is not None:
        block.role = body.role
    if body.enabled is not None:
        block.enabled = body.enabled
    if "template" in body.model_fields_set:
        block.template = body.template
    if "marker_key" in body.model_fields_set:
        block.marker_key = body.marker_key
    if body.injection_position is not None:
        block.injection_position = body.injection_position
    if "injection_depth" in body.model_fields_set:
        block.injection_depth = body.injection_depth
    if body.injection_order is not None:
        block.injection_order = body.injection_order
    if "triggers" in body.model_fields_set:
        block.triggers_json = json.dumps(body.triggers or [], ensure_ascii=False) if body.triggers is not None else None
    if body.forbid_overrides is not None:
        block.forbid_overrides = body.forbid_overrides
    if body.budget is not None:
        block.budget_json = json.dumps(body.budget or {}, ensure_ascii=False) if body.budget else None
    if body.cache is not None:
        block.cache_json = json.dumps(body.cache or {}, ensure_ascii=False) if body.cache else None

    preset.updated_at = utc_now()
    db.commit()
    db.refresh(block)
    return ok_payload(request_id=request_id, data={"block": _block_to_out(block)})


@router.post("/prompt_blocks/{block_id}/reset_to_default")
def reset_prompt_block_to_default(request: Request, db: DbDep, user_id: UserIdDep, block_id: str) -> dict:
    request_id = request.state.request_id
    block = db.get(PromptBlock, block_id)
    if block is None:
        raise AppError.not_found()
    preset = db.get(PromptPreset, block.preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    record_prompt_preset_version(db=db, preset=preset, actor_user_id=user_id, note="reset_block_to_default")
    block = reset_prompt_block_to_default_resource(db, preset=preset, block=block)
    return ok_payload(request_id=request_id, data={"block": _block_to_out(block)})


@router.delete("/prompt_blocks/{block_id}")
def delete_prompt_block(request: Request, db: DbDep, user_id: UserIdDep, block_id: str) -> dict:
    request_id = request.state.request_id
    block = db.get(PromptBlock, block_id)
    if block is None:
        raise AppError.not_found()
    preset = db.get(PromptPreset, block.preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    record_prompt_preset_version(db=db, preset=preset, actor_user_id=user_id, note="delete_block")
    db.delete(block)
    preset.updated_at = utc_now()
    db.commit()
    return ok_payload(request_id=request_id, data={})


@router.post("/prompt_presets/{preset_id}/blocks/reorder")
def reorder_prompt_blocks(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    preset_id: str,
    body: PromptBlockReorderRequest,
) -> dict:
    request_id = request.state.request_id
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    record_prompt_preset_version(db=db, preset=preset, actor_user_id=user_id, note="reorder_blocks")
    blocks = (
        db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset_id).order_by(PromptBlock.injection_order.asc()))
        .scalars()
        .all()
    )
    by_id: dict[str, PromptBlock] = {b.id: b for b in blocks}
    existing_ids = [b.id for b in blocks]
    existing_set = set(existing_ids)
    ordered_ids = list(body.ordered_block_ids or [])

    if len(ordered_ids) != len(existing_ids):
        raise AppError.validation(
            message=f"块顺序（ordered_block_ids）必须包含该 preset 的全部 blocks（expected={len(existing_ids)} got={len(ordered_ids)}）"
        )
    if len(set(ordered_ids)) != len(ordered_ids):
        raise AppError.validation(message="块顺序（ordered_block_ids）包含重复 block_id")

    ordered_set = set(ordered_ids)
    missing = existing_set - ordered_set
    extra = ordered_set - existing_set
    if missing or extra:
        raise AppError.validation(message="块顺序（ordered_block_ids）必须与该 preset 的 blocks 集合完全一致")

    for idx, block_id in enumerate(ordered_ids):
        by_id[block_id].injection_order = idx

    preset.updated_at = utc_now()
    db.commit()
    blocks = (
        db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset_id).order_by(PromptBlock.injection_order.asc()))
        .scalars()
        .all()
    )
    return ok_payload(request_id=request_id, data={"blocks": [_block_to_out(b) for b in blocks]})


@router.get("/prompt_presets/{preset_id}/export")
def export_prompt_preset(request: Request, db: DbDep, user_id: UserIdDep, preset_id: str) -> dict:
    request_id = request.state.request_id
    preset = db.get(PromptPreset, preset_id)
    if preset is None:
        raise AppError.not_found()
    require_project_editor(db, project_id=preset.project_id, user_id=user_id)

    blocks = (
        db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset_id).order_by(PromptBlock.injection_order.asc()))
        .scalars()
        .all()
    )

    export_obj = PromptPresetExportOut(
        preset=PromptPresetExportPreset(
            name=preset.name,
            category=preset.category,
            scope=preset.scope,
            version=preset.version,
            active_for=parse_json_list(preset.active_for_json),
        ),
        blocks=[
            {
                "identifier": b.identifier,
                "name": b.name,
                "role": b.role,
                "enabled": b.enabled,
                "template": b.template,
                "marker_key": b.marker_key,
                "injection_position": b.injection_position,
                "injection_depth": b.injection_depth,
                "injection_order": b.injection_order,
                "triggers": parse_json_list(b.triggers_json),
                "forbid_overrides": b.forbid_overrides,
                "budget": parse_json_dict(b.budget_json),
                "cache": parse_json_dict(b.cache_json),
            }
            for b in blocks
        ],
    ).model_dump()

    return ok_payload(request_id=request_id, data={"export": export_obj})


@router.post("/projects/{project_id}/prompt_presets/import")
def import_prompt_preset(request: Request, db: DbDep, user_id: UserIdDep, project_id: str, body: PromptPresetImportRequest) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    preset = PromptPreset(
        id=new_id(),
        project_id=project_id,
        name=body.preset.name,
        category=body.preset.category,
        scope=body.preset.scope,
        version=body.preset.version,
        active_for_json=json.dumps(body.preset.active_for or [], ensure_ascii=False),
    )
    db.add(preset)
    db.flush()
    for b in body.blocks:
        db.add(
            PromptBlock(
                id=new_id(),
                preset_id=preset.id,
                identifier=b.identifier,
                name=b.name,
                role=b.role,
                enabled=b.enabled,
                template=b.template,
                marker_key=b.marker_key,
                injection_position=b.injection_position,
                injection_depth=b.injection_depth,
                injection_order=b.injection_order,
                triggers_json=json.dumps(b.triggers or [], ensure_ascii=False),
                forbid_overrides=b.forbid_overrides,
                budget_json=json.dumps(b.budget or {}, ensure_ascii=False) if b.budget else None,
                cache_json=json.dumps(b.cache or {}, ensure_ascii=False) if b.cache else None,
            )
        )
    db.commit()
    db.refresh(preset)
    return ok_payload(request_id=request_id, data={"preset": _preset_to_out(preset)})


@router.get("/projects/{project_id}/prompt_presets/export_all")
def export_all_prompt_presets(request: Request, db: DbDep, user_id: UserIdDep, project_id: str) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    presets = (
        db.execute(select(PromptPreset).where(PromptPreset.project_id == project_id).order_by(PromptPreset.updated_at.desc()))
        .scalars()
        .all()
    )

    export_presets: list[PromptPresetExportOut] = []
    for preset in presets:
        blocks = (
            db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset.id).order_by(PromptBlock.injection_order.asc()))
            .scalars()
            .all()
        )
        export_presets.append(
            PromptPresetExportOut(
                preset=PromptPresetExportPreset(
                    name=preset.name,
                    category=preset.category,
                    scope=preset.scope,
                    version=preset.version,
                    active_for=parse_json_list(preset.active_for_json),
                ),
                blocks=[
                    {
                        "identifier": b.identifier,
                        "name": b.name,
                        "role": b.role,
                        "enabled": b.enabled,
                        "template": b.template,
                        "marker_key": b.marker_key,
                        "injection_position": b.injection_position,
                        "injection_depth": b.injection_depth,
                        "injection_order": b.injection_order,
                        "triggers": parse_json_list(b.triggers_json),
                        "forbid_overrides": b.forbid_overrides,
                        "budget": parse_json_dict(b.budget_json),
                        "cache": parse_json_dict(b.cache_json),
                    }
                    for b in blocks
                ],
            )
        )

    export_obj = PromptPresetExportAllOut(presets=export_presets).model_dump()
    return ok_payload(request_id=request_id, data={"export": export_obj})


@router.post("/projects/{project_id}/prompt_presets/import_all")
def import_all_prompt_presets(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    body: PromptPresetImportAllRequest,
) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    if str(body.schema_version or "").strip() != "prompt_presets_export_all_v1":
        raise AppError.validation(details={"reason": "unsupported_schema_version", "schema_version": body.schema_version})

    existing = (
        db.execute(select(PromptPreset).where(PromptPreset.project_id == project_id).order_by(PromptPreset.updated_at.desc()))
        .scalars()
        .all()
    )
    by_key: dict[tuple[str, str], list[PromptPreset]] = {}
    for row in existing:
        key = (str(row.name or "").strip(), str(row.scope or "").strip())
        by_key.setdefault(key, []).append(row)

    actions: list[dict[str, object]] = []
    conflicts: list[dict[str, object]] = []
    created = 0
    updated = 0
    skipped = 0

    for item in body.presets:
        key = (str(item.preset.name or "").strip(), str(item.preset.scope or "").strip())
        matches = by_key.get(key) or []
        if len(matches) > 1:
            skipped += 1
            conflicts.append({"name": key[0], "scope": key[1], "reason": "multiple_existing", "existing_count": len(matches)})
            actions.append({"name": key[0], "scope": key[1], "action": "skip", "reason": "multiple_existing"})
            continue

        if not matches:
            created += 1
            actions.append({"name": key[0], "scope": key[1], "action": "create", "blocks": len(item.blocks)})
            if body.dry_run:
                continue

            preset = PromptPreset(
                id=new_id(),
                project_id=project_id,
                name=item.preset.name,
                category=item.preset.category,
                scope=item.preset.scope,
                version=item.preset.version,
                active_for_json=json.dumps(item.preset.active_for or [], ensure_ascii=False),
            )
            db.add(preset)
            db.flush()
        else:
            updated += 1
            preset = matches[0]
            actions.append({"name": key[0], "scope": key[1], "action": "update", "preset_id": preset.id, "blocks": len(item.blocks)})
            if body.dry_run:
                continue

            preset.category = item.preset.category
            preset.version = item.preset.version
            preset.active_for_json = json.dumps(item.preset.active_for or [], ensure_ascii=False)
            preset.updated_at = utc_now()

            blocks = db.execute(select(PromptBlock).where(PromptBlock.preset_id == preset.id)).scalars().all()
            for b in blocks:
                db.delete(b)
            db.flush()

        if body.dry_run:
            continue

        ordered_blocks = sorted(list(item.blocks or []), key=lambda b: (int(b.injection_order or 0), str(b.identifier or "")))
        for idx, b in enumerate(ordered_blocks):
            db.add(
                PromptBlock(
                    id=new_id(),
                    preset_id=preset.id,
                    identifier=b.identifier,
                    name=b.name,
                    role=b.role,
                    enabled=b.enabled,
                    template=b.template,
                    marker_key=b.marker_key,
                    injection_position=b.injection_position,
                    injection_depth=b.injection_depth,
                    injection_order=int(b.injection_order) if b.injection_order is not None else idx,
                    triggers_json=json.dumps(b.triggers or [], ensure_ascii=False),
                    forbid_overrides=b.forbid_overrides,
                    budget_json=json.dumps(b.budget or {}, ensure_ascii=False) if b.budget else None,
                    cache_json=json.dumps(b.cache or {}, ensure_ascii=False) if b.cache else None,
                )
            )

    if not body.dry_run:
        db.commit()

    return ok_payload(
        request_id=request_id,
        data={
            "dry_run": bool(body.dry_run),
            "created": int(created),
            "updated": int(updated),
            "skipped": int(skipped),
            "conflicts": conflicts,
            "actions": actions,
        },
    )


@router.post("/projects/{project_id}/prompt_preview")
def preview_prompt(request: Request, db: DbDep, user_id: UserIdDep, project_id: str, body: PromptPreviewRequest) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    if body.task not in PROMPT_TASK_SET:
        raise AppError.validation(message="不支持的 task")

    llm_preset = db.get(LLMPreset, project_id)
    provider = llm_preset.provider if llm_preset is not None else None

    system, user, _, missing, blocks, preset_id, render_log = render_preset_for_task(
        db,
        project_id=project_id,
        task=body.task,
        values=body.values,
        preset_id=body.preset_id,
        macro_seed=request_id,
        provider=provider,
        allow_autocreate=False,
    )

    payload = PromptPreviewOut(
        preset_id=preset_id,
        task=body.task,
        system=system,
        user=user,
        prompt_tokens_estimate=int(render_log.get("prompt_tokens_estimate") or 0),
        prompt_budget_tokens=(int(render_log["prompt_budget_tokens"]) if isinstance(render_log.get("prompt_budget_tokens"), int) else None),
        missing=missing,
        blocks=[
            PromptPreviewBlock(
                id=b.id,
                identifier=b.identifier,
                role=b.role,
                enabled=b.enabled,
                text=b.text,
                missing=b.missing,
                token_estimate=b.token_estimate,
            )
            for b in blocks
        ],
    ).model_dump()
    return ok_payload(request_id=request_id, data={"preview": payload, "render_log": render_log})
