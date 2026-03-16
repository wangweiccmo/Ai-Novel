from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.models.llm_profile import LLMProfile
from app.models.llm_preset import LLMPreset
from app.models.llm_task_preset import LLMTaskPreset
from app.models.project import Project
from app.models.project_module_slot import ProjectModuleSlot
from app.services.generation_service import PreparedLlmCall
from app.services.llm_contract_service import normalize_base_url_for_provider, normalize_max_tokens_for_provider, normalize_provider_model
from app.services.llm_key_resolver import normalize_header_api_key, resolve_api_key_for_profile
from app.services.llm_task_catalog import is_supported_llm_task


@dataclass(frozen=True, slots=True)
class ResolvedTaskPreset:
    project_id: str
    task_key: str
    source: str
    llm_profile_id: str | None
    llm_call: PreparedLlmCall
    api_key: str


def _parse_json_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if item is not None]


def _parse_json_dict(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except Exception:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return parsed


def _to_prepared_llm_call(row: LLMPreset | LLMTaskPreset) -> PreparedLlmCall:
    stop = _parse_json_list(getattr(row, "stop_json", None))
    extra = _parse_json_dict(getattr(row, "extra_json", None))
    provider, model = normalize_provider_model(str(getattr(row, "provider", "") or ""), str(getattr(row, "model", "") or ""))
    params: dict[str, Any] = {
        "temperature": getattr(row, "temperature", None),
        "top_p": getattr(row, "top_p", None),
        "max_tokens": normalize_max_tokens_for_provider(provider, model, getattr(row, "max_tokens", None)),
        "presence_penalty": getattr(row, "presence_penalty", None),
        "frequency_penalty": getattr(row, "frequency_penalty", None),
        "top_k": getattr(row, "top_k", None),
        "stop": stop,
    }
    return PreparedLlmCall(
        provider=provider,
        model=model,
        base_url=str(normalize_base_url_for_provider(provider, getattr(row, "base_url", None)) or ""),
        timeout_seconds=int(getattr(row, "timeout_seconds", 180) or 180),
        params=params,
        params_json=json.dumps(params, ensure_ascii=False),
        extra=extra,
    )


def _to_prepared_llm_call_from_profile(profile: LLMProfile) -> PreparedLlmCall:
    stop = _parse_json_list(getattr(profile, "stop_json", None))
    extra = _parse_json_dict(getattr(profile, "extra_json", None))
    provider, model = normalize_provider_model(str(getattr(profile, "provider", "") or ""), str(getattr(profile, "model", "") or ""))
    params: dict[str, Any] = {
        "temperature": getattr(profile, "temperature", None),
        "top_p": getattr(profile, "top_p", None),
        "max_tokens": normalize_max_tokens_for_provider(provider, model, getattr(profile, "max_tokens", None)),
        "presence_penalty": getattr(profile, "presence_penalty", None),
        "frequency_penalty": getattr(profile, "frequency_penalty", None),
        "top_k": getattr(profile, "top_k", None),
        "stop": stop,
    }
    return PreparedLlmCall(
        provider=provider,
        model=model,
        base_url=str(normalize_base_url_for_provider(provider, getattr(profile, "base_url", None)) or ""),
        timeout_seconds=int(getattr(profile, "timeout_seconds", 180) or 180),
        params=params,
        params_json=json.dumps(params, ensure_ascii=False),
        extra=extra,
    )


def _apply_task_overrides(base_call: PreparedLlmCall, override: LLMTaskPreset) -> PreparedLlmCall:
    params = dict(base_call.params)
    if override.temperature is not None:
        params["temperature"] = override.temperature
    if override.top_p is not None:
        params["top_p"] = override.top_p
    if override.max_tokens is not None:
        params["max_tokens"] = normalize_max_tokens_for_provider(base_call.provider, base_call.model, override.max_tokens)
    if override.presence_penalty is not None:
        params["presence_penalty"] = override.presence_penalty
    if override.frequency_penalty is not None:
        params["frequency_penalty"] = override.frequency_penalty
    if override.top_k is not None:
        params["top_k"] = override.top_k
    if override.stop_json is not None:
        params["stop"] = _parse_json_list(override.stop_json)

    extra = dict(base_call.extra)
    if override.extra_json is not None:
        extra = _parse_json_dict(override.extra_json)

    timeout_seconds = base_call.timeout_seconds
    if override.timeout_seconds is not None:
        timeout_seconds = int(override.timeout_seconds)

    return PreparedLlmCall(
        provider=base_call.provider,
        model=base_call.model,
        base_url=base_call.base_url,
        timeout_seconds=timeout_seconds,
        params=params,
        params_json=json.dumps(params, ensure_ascii=False),
        extra=extra,
    )


def _get_main_slot(db: Session, *, project_id: str) -> ProjectModuleSlot | None:
    return (
        db.execute(
            select(ProjectModuleSlot)
            .where(ProjectModuleSlot.project_id == project_id, ProjectModuleSlot.is_main.is_(True))
            .limit(1)
        )
        .scalars()
        .first()
    )


def get_task_override(db: Session, *, project_id: str, task_key: str) -> LLMTaskPreset | None:
    key = str(task_key or "").strip()
    if not key:
        return None
    if not is_supported_llm_task(key):
        return None
    return db.get(LLMTaskPreset, (project_id, key))


def resolve_task_preset(
    db: Session,
    *,
    project_id: str,
    task_key: str,
) -> tuple[LLMPreset | LLMTaskPreset | None, str]:
    override = get_task_override(db, project_id=project_id, task_key=task_key)
    if override is not None:
        return override, "task_override"
    return db.get(LLMPreset, project_id), "project_default"


def _legacy_resolve(
    db: Session,
    *,
    project: Project,
    user_id: str,
    task_key: str,
    header_api_key: str | None,
) -> ResolvedTaskPreset | None:
    row, source = resolve_task_preset(db, project_id=project.id, task_key=task_key)
    if row is None:
        return None

    header = normalize_header_api_key(header_api_key)
    llm_profile_id = getattr(row, "llm_profile_id", None) if source == "task_override" else None
    profile_id = str(llm_profile_id or "").strip() or (str(project.llm_profile_id or "").strip() or None)

    if header is not None:
        api_key = header
    elif profile_id is not None:
        profile = db.get(LLMProfile, profile_id)
        if profile is None or profile.owner_user_id != user_id:
            raise AppError(code="LLM_KEY_MISSING", message="请先在 Prompts 页面保存 API Key", status_code=401)
        api_key = resolve_api_key_for_profile(profile=profile, header_api_key=None)
    else:
        raise AppError(code="LLM_KEY_MISSING", message="请先在 Prompts 页面保存 API Key", status_code=401)

    llm_call = _to_prepared_llm_call(row)
    return ResolvedTaskPreset(
        project_id=project.id,
        task_key=str(task_key or "").strip(),
        source=source,
        llm_profile_id=profile_id,
        llm_call=llm_call,
        api_key=api_key,
    )


def resolve_task_llm_config(
    db: Session,
    *,
    project: Project,
    user_id: str,
    task_key: str,
    header_api_key: str | None,
) -> ResolvedTaskPreset | None:
    override = get_task_override(db, project_id=project.id, task_key=task_key)

    if override and override.module_slot_id:
        slot = db.get(ProjectModuleSlot, override.module_slot_id)
        if slot is not None and slot.project_id == project.id:
            profile = db.get(LLMProfile, slot.llm_profile_id)
            if profile is None:
                raise AppError.not_found()
            base_call = _to_prepared_llm_call_from_profile(profile)
            final_call = _apply_task_overrides(base_call, override)
            api_key = resolve_api_key_for_profile(
                profile=profile,
                header_api_key=normalize_header_api_key(header_api_key),
            )
            return ResolvedTaskPreset(
                project_id=project.id,
                task_key=str(task_key or "").strip(),
                source="task_override",
                llm_profile_id=profile.id,
                llm_call=final_call,
                api_key=api_key,
            )

    if override:
        return _legacy_resolve(db, project=project, user_id=user_id, task_key=task_key, header_api_key=header_api_key)

    main_slot = _get_main_slot(db, project_id=project.id)
    if main_slot is not None:
        profile = db.get(LLMProfile, main_slot.llm_profile_id)
        if profile is None:
            raise AppError.not_found()
        base_call = _to_prepared_llm_call_from_profile(profile)
        api_key = resolve_api_key_for_profile(
            profile=profile,
            header_api_key=normalize_header_api_key(header_api_key),
        )
        return ResolvedTaskPreset(
            project_id=project.id,
            task_key=str(task_key or "").strip(),
            source="project_default",
            llm_profile_id=profile.id,
            llm_call=base_call,
            api_key=api_key,
        )

    return _legacy_resolve(db, project=project, user_id=user_id, task_key=task_key, header_api_key=header_api_key)
