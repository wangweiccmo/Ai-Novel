from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.api.deps import DbDep, UserIdDep, require_owned_llm_profile, require_project_editor
from app.core.errors import AppError, ok_payload
from app.models.llm_profile import LLMProfile
from app.models.llm_task_preset import LLMTaskPreset
from app.models.project_module_slot import ProjectModuleSlot
from app.schemas.llm_profiles import LLMProfileOut
from app.schemas.llm_task_presets import LLMTaskPresetOut, LLMTaskPresetPutRequest
from app.services.llm_contract_service import (
    capability_contract,
    contract_metadata,
    normalize_base_url_for_provider,
    normalize_max_tokens_for_provider,
    normalize_provider_model,
)
from app.services.llm_profile_template import (
    DEFAULT_TIMEOUT_SECONDS,
    decode_extra_json,
    decode_stop_json,
    encode_extra_json,
    encode_stop_json,
)
from app.services.llm_task_catalog import LLM_TASK_CATALOG, is_supported_llm_task

router = APIRouter()


def _profile_to_out(row: LLMProfile) -> dict:
    meta = contract_metadata(str(row.provider or "").strip(), str(row.model or "").strip())
    return LLMProfileOut(
        id=row.id,
        owner_user_id=row.owner_user_id,
        name=row.name,
        provider=meta["provider"],
        provider_key=meta["provider_key"],
        model_key=meta["model_key"],
        known_model=bool(meta["known_model"]),
        contract_mode=str(meta["contract_mode"]),
        pricing=dict(meta.get("pricing") or {}),
        base_url=row.base_url,
        model=meta["model"],
        temperature=row.temperature,
        top_p=row.top_p,
        max_tokens=normalize_max_tokens_for_provider(meta["provider"], meta["model"], row.max_tokens),
        presence_penalty=row.presence_penalty,
        frequency_penalty=row.frequency_penalty,
        top_k=row.top_k,
        stop=decode_stop_json(row.stop_json),
        timeout_seconds=int(row.timeout_seconds or DEFAULT_TIMEOUT_SECONDS),
        extra=decode_extra_json(row.extra_json),
        has_api_key=bool(row.api_key_ciphertext),
        masked_api_key=row.api_key_masked,
        created_at=row.created_at,
        updated_at=row.updated_at,
    ).model_dump()


def _to_out(row: LLMTaskPreset, *, module_slot: ProjectModuleSlot | None, module_profile: LLMProfile | None) -> dict:
    provider = str(row.provider or "").strip()
    model = str(row.model or "").strip()
    base_url = row.base_url
    if module_profile is not None:
        provider = str(module_profile.provider or "").strip()
        model = str(module_profile.model or "").strip()
        base_url = module_profile.base_url
    meta = capability_contract(provider, model)
    return LLMTaskPresetOut(
        project_id=row.project_id,
        task_key=row.task_key,
        llm_profile_id=row.llm_profile_id,
        module_slot_id=module_slot.id if module_slot is not None else None,
        module_display_name=module_slot.display_name if module_slot is not None else None,
        module_profile=_profile_to_out(module_profile) if module_profile is not None else None,
        provider=meta["provider"],
        provider_key=meta["provider_key"],
        model_key=meta["model_key"],
        known_model=bool(meta["known_model"]),
        contract_mode=str(meta["contract_mode"]),
        pricing=dict(meta.get("pricing") or {}),
        base_url=base_url,
        model=meta["model"],
        temperature=row.temperature,
        top_p=row.top_p,
        max_tokens=normalize_max_tokens_for_provider(meta["provider"], meta["model"], row.max_tokens),
        max_tokens_limit=meta["max_tokens_limit"],
        max_tokens_recommended=meta["max_tokens_recommended"],
        context_window_limit=meta["context_window_limit"],
        presence_penalty=row.presence_penalty,
        frequency_penalty=row.frequency_penalty,
        top_k=row.top_k,
        stop=decode_stop_json(row.stop_json),
        timeout_seconds=row.timeout_seconds,
        extra=decode_extra_json(row.extra_json),
        source="task_override",
    ).model_dump()


def _catalog_out() -> list[dict]:
    return [
        {
            "key": item.key,
            "label": item.label,
            "group": item.group,
            "description": item.description,
            "recommended_provider": item.recommended_provider,
            "recommended_model": item.recommended_model,
            "recommended_note": item.recommended_note,
            "cost_tier": item.cost_tier,
        }
        for item in LLM_TASK_CATALOG
    ]


@router.get("/projects/{project_id}/llm_task_presets")
def list_llm_task_presets(request: Request, db: DbDep, user_id: UserIdDep, project_id: str) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)
    rows = (
        db.execute(select(LLMTaskPreset).where(LLMTaskPreset.project_id == project_id).order_by(LLMTaskPreset.task_key.asc()))
        .scalars()
        .all()
    )
    slot_ids = {row.module_slot_id for row in rows if row.module_slot_id}
    slots = (
        db.execute(select(ProjectModuleSlot).where(ProjectModuleSlot.id.in_(slot_ids)))
        .scalars()
        .all()
        if slot_ids
        else []
    )
    profile_ids = {slot.llm_profile_id for slot in slots}
    profiles = (
        db.execute(select(LLMProfile).where(LLMProfile.id.in_(profile_ids)))
        .scalars()
        .all()
        if profile_ids
        else []
    )
    slot_by_id = {slot.id: slot for slot in slots}
    profile_by_id = {profile.id: profile for profile in profiles}
    return ok_payload(
        request_id=request_id,
        data={
            "catalog": _catalog_out(),
            "task_presets": [
                _to_out(
                    row,
                    module_slot=slot_by_id.get(row.module_slot_id) if row.module_slot_id else None,
                    module_profile=profile_by_id.get(slot_by_id[row.module_slot_id].llm_profile_id)
                    if row.module_slot_id and row.module_slot_id in slot_by_id
                    else None,
                )
                for row in rows
            ],
        },
    )


@router.put("/projects/{project_id}/llm_task_presets/{task_key}")
def put_llm_task_preset(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    task_key: str,
    body: LLMTaskPresetPutRequest,
) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    task_key_norm = str(task_key or "").strip()
    if not task_key_norm or not is_supported_llm_task(task_key_norm):
        raise AppError.validation(message=f"不支持的 task_key: {task_key_norm or '(empty)'}")

    row = db.get(LLMTaskPreset, (project_id, task_key_norm))
    if row is None:
        row = LLMTaskPreset(
            project_id=project_id,
            task_key=task_key_norm,
            provider="openai",
            model="gpt-4o-mini",
        )
        db.add(row)

    if body.module_slot_id:
        slot = db.get(ProjectModuleSlot, body.module_slot_id)
        if slot is None or slot.project_id != project_id:
            raise AppError.not_found()
        profile = db.get(LLMProfile, slot.llm_profile_id)
        if profile is None:
            raise AppError.not_found()

        if "module_slot_id" in body.model_fields_set:
            row.module_slot_id = slot.id
        row.llm_profile_id = None

        provider, model = normalize_provider_model(profile.provider, profile.model)
        if "provider" in body.model_fields_set and body.provider:
            provider, _ = normalize_provider_model(body.provider, body.model or profile.model)
        if "model" in body.model_fields_set and body.model:
            _, model = normalize_provider_model(profile.provider, body.model)

        row.provider = provider
        row.model = model
        row.base_url = normalize_base_url_for_provider(provider, profile.base_url)
    else:
        if body.provider is None or body.model is None:
            raise AppError.validation("provider/model 不能为空")
        provider, model = normalize_provider_model(body.provider, body.model)
        profile_id = body.llm_profile_id
        if profile_id:
            profile = require_owned_llm_profile(db, profile_id=profile_id, user_id=user_id)
            profile_provider, _ = normalize_provider_model(profile.provider, profile.model)
            if profile_provider != provider:
                raise AppError(
                    code="LLM_CONFIG_ERROR",
                    message="任务模块 provider 必须与所选 API 配置 provider 一致",
                    status_code=400,
                )

        row.llm_profile_id = profile_id
        row.module_slot_id = None
        row.provider = provider
        row.base_url = normalize_base_url_for_provider(provider, body.base_url)
        row.model = model

    if "temperature" in body.model_fields_set:
        row.temperature = body.temperature
    if "top_p" in body.model_fields_set:
        row.top_p = body.top_p
    if "max_tokens" in body.model_fields_set:
        row.max_tokens = normalize_max_tokens_for_provider(row.provider, row.model, body.max_tokens)
    if "presence_penalty" in body.model_fields_set:
        row.presence_penalty = body.presence_penalty
    if "frequency_penalty" in body.model_fields_set:
        row.frequency_penalty = body.frequency_penalty
    if "top_k" in body.model_fields_set:
        row.top_k = body.top_k
    if "stop" in body.model_fields_set:
        row.stop_json = encode_stop_json(body.stop)
    if "timeout_seconds" in body.model_fields_set:
        row.timeout_seconds = body.timeout_seconds
    if "extra" in body.model_fields_set:
        row.extra_json = encode_extra_json(body.extra)

    db.commit()
    db.refresh(row)

    module_slot = None
    module_profile = None
    if row.module_slot_id:
        module_slot = db.get(ProjectModuleSlot, row.module_slot_id)
        if module_slot is not None:
            module_profile = db.get(LLMProfile, module_slot.llm_profile_id)

    return ok_payload(
        request_id=request_id,
        data={"task_preset": _to_out(row, module_slot=module_slot, module_profile=module_profile)},
    )


@router.delete("/projects/{project_id}/llm_task_presets/{task_key}")
def delete_llm_task_preset(request: Request, db: DbDep, user_id: UserIdDep, project_id: str, task_key: str) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    task_key_norm = str(task_key or "").strip()
    row = db.get(LLMTaskPreset, (project_id, task_key_norm))
    if row is None:
        raise AppError.not_found()
    db.delete(row)
    db.commit()
    return ok_payload(request_id=request_id, data={})
