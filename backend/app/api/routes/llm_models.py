from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, Header, Query, Request

from app.api.deps import DbDep, UserIdDep, require_owned_llm_profile, require_project_editor
from app.core.errors import AppError, ok_payload
from app.llm.http_client import get_llm_http_client
from app.models.project import Project
from app.schemas.llm import LLMProvider
from app.services.llm_contract_service import normalize_base_url_for_provider, normalize_provider_model
from app.services.llm_key_resolver import normalize_header_api_key, resolve_api_key_for_profile, resolve_api_key_for_project

router = APIRouter()


def _dedupe_models(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in items:
        model_id = str(item.get("id") or "").strip()
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        out.append(item)
    out.sort(key=lambda x: str(x.get("id") or ""))
    return out


def _list_openai_like_models(*, provider: str, base_url: str, api_key: str, timeout: httpx.Timeout) -> list[dict[str, Any]]:
    client = get_llm_http_client()
    normalized = str(base_url or "").rstrip("/")
    endpoints = [f"{normalized}/models"]
    if not normalized.endswith("/v1"):
        endpoints.append(f"{normalized}/v1/models")

    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    if provider.endswith("_compatible"):
        headers["x-api-key"] = api_key

    last_exc: Exception | None = None
    for url in endpoints:
        try:
            resp = client.get(url, headers=headers, timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            continue
        if resp.status_code == 404:
            continue
        if resp.status_code // 100 != 2:
            raise AppError(code="LLM_UPSTREAM_ERROR", message=f"模型列表获取失败（HTTP {resp.status_code}）", status_code=502)
        data = resp.json() if resp.content else {}
        rows = data.get("data") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return []
        items: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            model_id = str(row.get("id") or "").strip()
            if not model_id:
                continue
            items.append(
                {
                    "id": model_id,
                    "display_name": str(row.get("name") or model_id),
                    "provider": provider,
                }
            )
        return _dedupe_models(items)
    if last_exc is not None:
        raise AppError(code="LLM_UPSTREAM_ERROR", message="模型列表获取失败，请检查 base_url", status_code=502) from last_exc
    return []


def _list_anthropic_models(*, provider: str, base_url: str, api_key: str, timeout: httpx.Timeout) -> list[dict[str, Any]]:
    client = get_llm_http_client()
    url = f"{str(base_url or '').rstrip('/')}/v1/models"
    resp = client.get(
        url,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Accept": "application/json",
        },
        timeout=timeout,
    )
    if resp.status_code // 100 != 2:
        raise AppError(code="LLM_UPSTREAM_ERROR", message=f"模型列表获取失败（HTTP {resp.status_code}）", status_code=502)
    data = resp.json() if resp.content else {}
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    items: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        model_id = str(row.get("id") or "").strip()
        if not model_id:
            continue
        items.append(
            {
                "id": model_id,
                "display_name": str(row.get("display_name") or model_id),
                "provider": provider,
            }
        )
    return _dedupe_models(items)


def _list_gemini_models(*, provider: str, base_url: str, api_key: str, timeout: httpx.Timeout) -> list[dict[str, Any]]:
    client = get_llm_http_client()
    url = f"{str(base_url or '').rstrip('/')}/v1beta/models"
    resp = client.get(
        url,
        headers={"x-goog-api-key": api_key, "Accept": "application/json"},
        params={"pageSize": 200},
        timeout=timeout,
    )
    if resp.status_code // 100 != 2:
        raise AppError(code="LLM_UPSTREAM_ERROR", message=f"模型列表获取失败（HTTP {resp.status_code}）", status_code=502)
    data = resp.json() if resp.content else {}
    rows = data.get("models") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    items: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        full_name = str(row.get("name") or "").strip()
        if not full_name:
            continue
        model_id = full_name.split("/", 1)[1] if full_name.startswith("models/") else full_name
        if not model_id:
            continue
        items.append(
            {
                "id": model_id,
                "display_name": str(row.get("displayName") or model_id),
                "provider": provider,
                "name": full_name,
            }
        )
    return _dedupe_models(items)


@router.get("/llm_models")
def list_llm_models(
    request: Request,
    db: DbDep,
    user_id: UserIdDep,
    provider: LLMProvider = Query(...),
    base_url: str | None = Query(default=None, max_length=2048),
    project_id: str | None = Query(default=None, max_length=64),
    profile_id: str | None = Query(default=None, max_length=36),
    x_llm_api_key: str | None = Header(default=None, alias="X-LLM-API-Key", max_length=4096),
) -> dict:
    request_id = request.state.request_id
    profile = None
    project: Project | None = None
    provider_value = str(provider or "").strip()
    dispatch_provider = provider_value if provider_value in (
        "openai",
        "openai_responses",
        "openai_compatible",
        "openai_responses_compatible",
        "anthropic",
        "gemini",
        "deepseek",
    ) else "openai_compatible"

    header_key = normalize_header_api_key(x_llm_api_key)
    if profile_id:
        profile = require_owned_llm_profile(db, profile_id=profile_id, user_id=user_id)
        profile_provider, _ = normalize_provider_model(profile.provider, profile.model)
        if profile_provider != provider_value:
            raise AppError(code="LLM_CONFIG_ERROR", message="provider 与 profile 不一致", status_code=400)
    elif project_id:
        project = require_project_editor(db, project_id=project_id, user_id=user_id)

    effective_base_url = normalize_base_url_for_provider(
        provider_value,
        base_url or (profile.base_url if profile is not None else None),
    )

    warning: dict[str, str] | None = None
    if header_key is not None:
        api_key = header_key
    else:
        try:
            if profile is not None:
                api_key = resolve_api_key_for_profile(profile=profile, header_api_key=None)
            elif project is not None:
                api_key = resolve_api_key_for_project(db, project=project, user_id=user_id, header_api_key=None)
            else:
                raise AppError.validation(message="请提供 profile_id 或 project_id，或通过请求头传入 X-LLM-API-Key")
        except AppError as exc:
            if exc.code == "LLM_KEY_MISSING":
                warning = {"code": exc.code, "message": exc.message}
                return ok_payload(
                    request_id=request_id,
                    data={"provider": provider, "base_url": effective_base_url, "models": [], "warning": warning},
                )
            raise

    timeout = httpx.Timeout(connect=5.0, read=15.0, write=10.0, pool=5.0)
    if dispatch_provider in ("openai", "openai_responses", "openai_compatible", "openai_responses_compatible", "deepseek"):
        models = _list_openai_like_models(provider=dispatch_provider, base_url=effective_base_url or "", api_key=api_key, timeout=timeout)
    elif dispatch_provider == "anthropic":
        models = _list_anthropic_models(provider=dispatch_provider, base_url=effective_base_url or "", api_key=api_key, timeout=timeout)
    elif dispatch_provider == "gemini":
        models = _list_gemini_models(provider=dispatch_provider, base_url=effective_base_url or "", api_key=api_key, timeout=timeout)
    else:
        models = []

    return ok_payload(
        request_id=request_id,
        data={
            "provider": provider_value,
            "base_url": effective_base_url,
            "models": models,
            "warning": warning,
        },
    )
