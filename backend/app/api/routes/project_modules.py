from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from app.api.deps import DbDep, UserIdDep, require_owned_llm_profile, require_project_editor
from app.api.routes.llm_profiles import _sync_bound_project_presets
from app.core.errors import AppError, ok_payload
from app.core.secrets import SecretCryptoError, encrypt_secret, mask_api_key
from app.db.utils import new_id
from app.models.llm_preset import LLMPreset
from app.models.llm_profile import LLMProfile
from app.models.project import Project
from app.models.project_module_slot import ProjectModuleSlot
from app.schemas.llm_profiles import LLMProfileCreate, LLMProfileOut, LLMProfileUpdate
from app.schemas.project_modules import ModuleSlotCreate, ModuleSlotOut, ModuleSlotUpdate
from app.services.llm_contract_service import (
    contract_metadata,
    normalize_base_url_for_provider as contract_normalize_base_url_for_provider,
    normalize_max_tokens_for_provider,
    normalize_provider_model,
)
from app.services.llm_profile_template import (
    DEFAULT_TIMEOUT_SECONDS,
    apply_profile_template_to_llm_row,
    decode_extra_json,
    decode_stop_json,
    encode_extra_json,
    encode_stop_json,
)

router = APIRouter()


def _normalize_profile(provider: str, base_url: str | None) -> str | None:
    return contract_normalize_base_url_for_provider(provider, base_url)


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


def _slot_to_out(slot: ProjectModuleSlot, profile: LLMProfile) -> dict:
    return ModuleSlotOut(
        id=slot.id,
        display_name=slot.display_name,
        is_main=slot.is_main,
        sort_order=slot.sort_order,
        profile=_profile_to_out(profile),
    ).model_dump()


def _create_profile(db: DbDep, *, user_id: str, body: LLMProfileCreate) -> LLMProfile:
    provider, model = normalize_provider_model(str(body.provider or "").strip(), str(body.model or "").strip())
    row = LLMProfile(
        id=new_id(),
        owner_user_id=user_id,
        name=body.name,
        provider=provider,
        base_url=_normalize_profile(provider, body.base_url),
        model=model,
        temperature=body.temperature,
        top_p=body.top_p,
        max_tokens=normalize_max_tokens_for_provider(provider, model, body.max_tokens),
        presence_penalty=body.presence_penalty,
        frequency_penalty=body.frequency_penalty,
        top_k=body.top_k,
        stop_json=encode_stop_json(body.stop),
        timeout_seconds=int(body.timeout_seconds or DEFAULT_TIMEOUT_SECONDS),
        extra_json=encode_extra_json(body.extra),
    )
    if body.api_key is not None:
        key = body.api_key.strip()
        if key:
            try:
                row.api_key_ciphertext = encrypt_secret(key)
            except SecretCryptoError:
                raise AppError(code="SECRET_CONFIG_ERROR", message="鏈嶅姟绔湭閰嶇疆 SECRET_ENCRYPTION_KEY", status_code=500)
            row.api_key_masked = mask_api_key(key)
    db.add(row)
    return row


def _apply_profile_update(db: DbDep, *, row: LLMProfile, body: LLMProfileUpdate) -> None:
    provider_input = str(body.provider or row.provider).strip()
    model_input = str(body.model or row.model).strip()
    provider, model = normalize_provider_model(provider_input, model_input)
    base_url = body.base_url if "base_url" in body.model_fields_set else row.base_url

    if body.name is not None:
        row.name = body.name
    row.provider = provider
    if "base_url" in body.model_fields_set or provider != str(row.provider or "").strip():
        row.base_url = _normalize_profile(provider, base_url)
    if body.model is not None or model != str(row.model or "").strip():
        row.model = model

    if "temperature" in body.model_fields_set:
        row.temperature = body.temperature
    if "top_p" in body.model_fields_set:
        row.top_p = body.top_p
    if "max_tokens" in body.model_fields_set:
        row.max_tokens = body.max_tokens
    if "presence_penalty" in body.model_fields_set:
        row.presence_penalty = body.presence_penalty
    if "frequency_penalty" in body.model_fields_set:
        row.frequency_penalty = body.frequency_penalty
    if "top_k" in body.model_fields_set:
        row.top_k = body.top_k
    if "stop" in body.model_fields_set:
        row.stop_json = encode_stop_json(body.stop or [])
    if "timeout_seconds" in body.model_fields_set:
        row.timeout_seconds = int(body.timeout_seconds or DEFAULT_TIMEOUT_SECONDS)
    if "extra" in body.model_fields_set:
        row.extra_json = encode_extra_json(body.extra or {})

    if "api_key" in body.model_fields_set:
        key = (body.api_key or "").strip()
        if key:
            try:
                row.api_key_ciphertext = encrypt_secret(key)
            except SecretCryptoError:
                raise AppError(code="SECRET_CONFIG_ERROR", message="鏈嶅姟绔湭閰嶇疆 SECRET_ENCRYPTION_KEY", status_code=500)
            row.api_key_masked = mask_api_key(key)
        else:
            row.api_key_ciphertext = None
            row.api_key_masked = None

    row.provider = provider
    row.base_url = _normalize_profile(provider, base_url)
    row.model = model
    row.max_tokens = normalize_max_tokens_for_provider(provider, model, row.max_tokens)
    row.stop_json = encode_stop_json(decode_stop_json(row.stop_json))
    row.timeout_seconds = int(row.timeout_seconds or DEFAULT_TIMEOUT_SECONDS)
    row.extra_json = encode_extra_json(decode_extra_json(row.extra_json))

    _sync_bound_project_presets(db, row)


def _default_profile_for_project(project: Project, *, user_id: str) -> LLMProfile:
    provider, model = normalize_provider_model("openai", "gpt-4o-mini")
    return LLMProfile(
        id=new_id(),
        owner_user_id=user_id,
        name="主模块",
        provider=provider,
        base_url=_normalize_profile(provider, "https://api.openai.com/v1"),
        model=model,
        temperature=0.7,
        top_p=1.0,
        max_tokens=normalize_max_tokens_for_provider(provider, model, None),
        presence_penalty=0.0,
        frequency_penalty=0.0,
        top_k=None,
        stop_json="[]",
        timeout_seconds=DEFAULT_TIMEOUT_SECONDS,
        extra_json="{}",
    )


def _ensure_main_slot(db: DbDep, *, project: Project, user_id: str) -> ProjectModuleSlot | None:
    existing = (
        db.execute(
            select(ProjectModuleSlot)
            .where(ProjectModuleSlot.project_id == project.id, ProjectModuleSlot.is_main.is_(True))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if existing is not None:
        return existing

    profile: LLMProfile | None = None
    if project.llm_profile_id:
        profile = db.get(LLMProfile, project.llm_profile_id)

    if profile is None:
        preset = db.get(LLMPreset, project.id)
        if preset is not None:
            profile = LLMProfile(
                id=new_id(),
                owner_user_id=user_id,
                name="主模块",
                provider=preset.provider,
                base_url=_normalize_profile(preset.provider, preset.base_url),
                model=preset.model,
                temperature=preset.temperature,
                top_p=preset.top_p,
                max_tokens=preset.max_tokens,
                presence_penalty=preset.presence_penalty,
                frequency_penalty=preset.frequency_penalty,
                top_k=preset.top_k,
                stop_json=preset.stop_json,
                timeout_seconds=preset.timeout_seconds,
                extra_json=preset.extra_json,
            )
            db.add(profile)
        else:
            profile = _default_profile_for_project(project, user_id=user_id)
            db.add(profile)

    slot = ProjectModuleSlot(
        id=new_id(),
        project_id=project.id,
        llm_profile_id=profile.id,
        display_name="主模块",
        is_main=True,
        sort_order=0,
    )
    db.add(slot)
    project.llm_profile_id = profile.id

    preset = db.get(LLMPreset, project.id)
    if preset is None:
        preset = LLMPreset(
            project_id=project.id,
            provider=profile.provider,
            base_url=_normalize_profile(profile.provider, profile.base_url),
            model=profile.model,
            temperature=0.7,
            top_p=1.0,
            max_tokens=normalize_max_tokens_for_provider(profile.provider, profile.model, None),
            presence_penalty=0.0,
            frequency_penalty=0.0,
            top_k=None,
            stop_json="[]",
            timeout_seconds=DEFAULT_TIMEOUT_SECONDS,
            extra_json="{}",
        )
        db.add(preset)
    apply_profile_template_to_llm_row(row=preset, profile=profile)

    db.commit()
    db.refresh(slot)
    return slot


def _load_slots(db: DbDep, *, project_id: str) -> list[ProjectModuleSlot]:
    return (
        db.execute(
            select(ProjectModuleSlot)
            .where(ProjectModuleSlot.project_id == project_id)
            .order_by(ProjectModuleSlot.sort_order.asc(), ProjectModuleSlot.created_at.asc())
        )
        .scalars()
        .all()
    )


@router.get("/projects/{project_id}/modules")
def list_project_modules(request: Request, db: DbDep, user_id: UserIdDep, project_id: str) -> dict:
    request_id = request.state.request_id
    project = require_project_editor(db, project_id=project_id, user_id=user_id)

    _ensure_main_slot(db, project=project, user_id=user_id)
    slots = _load_slots(db, project_id=project_id)
    if not slots:
        return ok_payload(request_id=request_id, data={"modules": []})

    profile_ids = {s.llm_profile_id for s in slots}
    profiles = (
        db.execute(select(LLMProfile).where(LLMProfile.id.in_(profile_ids)))
        .scalars()
        .all()
    )
    profile_by_id = {p.id: p for p in profiles}

    out = []
    for slot in slots:
        profile = profile_by_id.get(slot.llm_profile_id)
        if profile is None:
            continue
        out.append(_slot_to_out(slot, profile))

    return ok_payload(request_id=request_id, data={"modules": out})


@router.post("/projects/{project_id}/modules")
def create_project_module(request: Request, db: DbDep, user_id: UserIdDep, project_id: str, body: ModuleSlotCreate) -> dict:
    request_id = request.state.request_id
    project = require_project_editor(db, project_id=project_id, user_id=user_id)

    _ensure_main_slot(db, project=project, user_id=user_id)

    if body.llm_profile_id and body.new_profile:
        raise AppError.validation("llm_profile_id 鍜?new_profile 涓嶈兘鍚屾椂浼犲叆")
    if not body.llm_profile_id and body.new_profile is None:
        raise AppError.validation("璇疯缃?llm_profile_id 鎴?new_profile")

    if body.llm_profile_id:
        profile = require_owned_llm_profile(db, profile_id=body.llm_profile_id, user_id=user_id)
    else:
        profile = _create_profile(db, user_id=user_id, body=body.new_profile)  # type: ignore[arg-type]

    next_sort = (
        db.execute(
            select(func.max(ProjectModuleSlot.sort_order)).where(ProjectModuleSlot.project_id == project_id)
        )
        .scalar()
    )
    sort_order = int(next_sort or 0) + 1

    slot = ProjectModuleSlot(
        id=new_id(),
        project_id=project_id,
        llm_profile_id=profile.id,
        display_name=body.display_name,
        is_main=False,
        sort_order=sort_order,
    )
    db.add(slot)
    db.commit()
    db.refresh(slot)

    return ok_payload(request_id=request_id, data={"module": _slot_to_out(slot, profile)})


@router.put("/projects/{project_id}/modules/{slot_id}")
def update_project_module(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    project_id: str,
    slot_id: str,
    body: ModuleSlotUpdate,
) -> dict:
    request_id = request.state.request_id
    project = require_project_editor(db, project_id=project_id, user_id=user_id)

    slot = db.get(ProjectModuleSlot, slot_id)
    if slot is None or slot.project_id != project_id:
        raise AppError.not_found()

    if body.display_name is not None:
        slot.display_name = body.display_name

    if body.llm_profile_id:
        profile = require_owned_llm_profile(db, profile_id=body.llm_profile_id, user_id=user_id)
        slot.llm_profile_id = profile.id
    else:
        profile = db.get(LLMProfile, slot.llm_profile_id)

    if profile is None:
        raise AppError.not_found()

    if body.profile_update is not None:
        if profile.owner_user_id != user_id:
            raise AppError.forbidden()
        _apply_profile_update(db, row=profile, body=body.profile_update)

    if slot.is_main:
        if project.llm_profile_id != slot.llm_profile_id:
            project.llm_profile_id = slot.llm_profile_id

        preset = db.get(LLMPreset, project_id)
        if preset is None:
            preset = LLMPreset(
                project_id=project_id,
                provider=profile.provider,
                base_url=_normalize_profile(profile.provider, profile.base_url),
                model=profile.model,
                temperature=0.7,
                top_p=1.0,
                max_tokens=normalize_max_tokens_for_provider(profile.provider, profile.model, None),
                presence_penalty=0.0,
                frequency_penalty=0.0,
                top_k=None,
                stop_json="[]",
                timeout_seconds=DEFAULT_TIMEOUT_SECONDS,
                extra_json="{}",
            )
            db.add(preset)
        apply_profile_template_to_llm_row(row=preset, profile=profile)

    db.commit()
    db.refresh(slot)
    return ok_payload(request_id=request_id, data={"module": _slot_to_out(slot, profile)})


@router.delete("/projects/{project_id}/modules/{slot_id}")
def delete_project_module(request: Request, db: DbDep, user_id: UserIdDep, project_id: str, slot_id: str) -> dict:
    request_id = request.state.request_id
    require_project_editor(db, project_id=project_id, user_id=user_id)

    slot = db.get(ProjectModuleSlot, slot_id)
    if slot is None or slot.project_id != project_id:
        raise AppError.not_found()
    if slot.is_main:
        raise AppError.forbidden()

    db.delete(slot)
    db.commit()
    return ok_payload(request_id=request_id, data={})
