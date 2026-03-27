from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any

from app.core.errors import AppError
from app.core.logging import exception_log_fields, log_event, redact_secrets_text, safe_log_details
from app.llm.client import call_llm, call_llm_messages
from app.llm.messages import ChatMessage
from app.models.llm_preset import LLMPreset
from app.services.memory_retrieval_service import placeholder_memory_retrieval_log
from app.services.run_store import write_generation_run


@dataclass(frozen=True, slots=True)
class PreparedLlmCall:
    provider: str
    model: str
    base_url: str
    timeout_seconds: int
    params: dict[str, Any]
    params_json: str
    extra: dict[str, Any]


@dataclass(frozen=True, slots=True)
class RecordedLlmResult:
    text: str
    finish_reason: str | None
    latency_ms: int
    dropped_params: list[str]
    run_id: str


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


def build_run_params_json(
    *,
    params_json: str,
    memory_retrieval_log_json: dict[str, Any] | None,
    extra_json: dict[str, Any] | None = None,
) -> str:
    params = _parse_json_dict(params_json)
    params["memory_retrieval_log_json"] = memory_retrieval_log_json or placeholder_memory_retrieval_log(enabled=False)
    if extra_json:
        params.update(extra_json)
    return json.dumps(params, ensure_ascii=False)


def prepare_llm_call(preset: LLMPreset) -> PreparedLlmCall:
    stop = _parse_json_list(preset.stop_json)
    extra = _parse_json_dict(preset.extra_json)

    params: dict[str, Any] = {
        "temperature": preset.temperature,
        "top_p": preset.top_p,
        "max_tokens": preset.max_tokens,
        "presence_penalty": preset.presence_penalty,
        "frequency_penalty": preset.frequency_penalty,
        "top_k": preset.top_k,
        "stop": stop,
    }
    params_json = json.dumps(params, ensure_ascii=False)

    return PreparedLlmCall(
        provider=preset.provider,
        model=preset.model,
        base_url=preset.base_url or "",
        timeout_seconds=int(preset.timeout_seconds or 180),
        params=params,
        params_json=params_json,
        extra=extra,
    )


def with_param_overrides(llm_call: PreparedLlmCall, overrides: dict[str, Any] | None) -> PreparedLlmCall:
    if not overrides:
        return llm_call
    params = dict(llm_call.params)
    for key, value in overrides.items():
        if value is None:
            continue
        params[key] = value
    params_json = json.dumps(params, ensure_ascii=False)
    return PreparedLlmCall(
        provider=llm_call.provider,
        model=llm_call.model,
        base_url=llm_call.base_url,
        timeout_seconds=llm_call.timeout_seconds,
        params=params,
        params_json=params_json,
        extra=dict(llm_call.extra),
    )


def call_llm_and_record(
    *,
    logger: logging.Logger,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    chapter_id: str | None,
    run_type: str,
    api_key: str,
    prompt_system: str,
    prompt_user: str,
    prompt_messages: list[ChatMessage] | None = None,
    prompt_render_log_json: str | None = None,
    llm_call: PreparedLlmCall,
    memory_retrieval_log_json: dict[str, Any] | None = None,
    run_params_extra_json: dict[str, Any] | None = None,
) -> RecordedLlmResult:
    run_params_json = build_run_params_json(
        params_json=llm_call.params_json,
        memory_retrieval_log_json=memory_retrieval_log_json,
        extra_json=run_params_extra_json,
    )
    safe_base_url = redact_secrets_text(str(llm_call.base_url or ""))
    try:
        if prompt_messages is None:
            result = call_llm(
                provider=llm_call.provider,
                base_url=llm_call.base_url,
                model=llm_call.model,
                api_key=api_key,
                system=prompt_system,
                user=prompt_user,
                params=llm_call.params,
                timeout_seconds=llm_call.timeout_seconds,
                extra=llm_call.extra,
            )
        else:
            result = call_llm_messages(
                provider=llm_call.provider,
                base_url=llm_call.base_url,
                model=llm_call.model,
                api_key=api_key,
                messages=prompt_messages,
                params=llm_call.params,
                timeout_seconds=llm_call.timeout_seconds,
                extra=llm_call.extra,
            )
        raw_output = result.text

        prompt_chars = len(prompt_system) + len(prompt_user)
        if prompt_messages is not None:
            prompt_chars = sum(len(m.content or "") for m in prompt_messages)
        log_event(
            logger,
            "info",
            llm={
                "provider": llm_call.provider,
                "model": llm_call.model,
                "timeout_seconds": llm_call.timeout_seconds,
                "prompt_chars": prompt_chars,
                "output_chars": len(raw_output or ""),
                "dropped_params": result.dropped_params,
                "finish_reason": result.finish_reason,
            },
        )

        run_id = write_generation_run(
            request_id=request_id,
            actor_user_id=actor_user_id,
            project_id=project_id,
            chapter_id=chapter_id,
            run_type=run_type,
            provider=llm_call.provider,
            model=llm_call.model,
            prompt_system=prompt_system,
            prompt_user=prompt_user,
            prompt_render_log_json=prompt_render_log_json,
            params_json=run_params_json,
            output_text=raw_output,
            error_json=None,
        )

        return RecordedLlmResult(
            text=raw_output,
            finish_reason=result.finish_reason,
            latency_ms=result.latency_ms,
            dropped_params=result.dropped_params,
            run_id=run_id,
        )
    except AppError as exc:
        prompt_chars = len(prompt_system) + len(prompt_user)
        if prompt_messages is not None:
            prompt_chars = sum(len(m.content or "") for m in prompt_messages)
        safe_details = safe_log_details(exc.details)
        log_event(
            logger,
            "error",
            llm={
                "provider": llm_call.provider,
                "model": llm_call.model,
                "run_type": run_type,
                "base_url": safe_base_url or None,
                "timeout_seconds": llm_call.timeout_seconds,
                "params": llm_call.params,
                "prompt_chars": prompt_chars,
                "output_chars": 0,
                "error_code": exc.code,
                "error_details": safe_details,
            },
        )
        run_id = write_generation_run(
            request_id=request_id,
            actor_user_id=actor_user_id,
            project_id=project_id,
            chapter_id=chapter_id,
            run_type=run_type,
            provider=llm_call.provider,
            model=llm_call.model,
            prompt_system=prompt_system,
            prompt_user=prompt_user,
            prompt_render_log_json=prompt_render_log_json,
            params_json=run_params_json,
            output_text=None,
            error_json=json.dumps({"code": exc.code, "message": exc.message, "details": exc.details}, ensure_ascii=False),
        )
        try:
            details = exc.details if isinstance(getattr(exc, "details", None), dict) else {}
            if details.get("run_id") != run_id:
                patched = dict(details)
                patched["run_id"] = run_id
                exc.details = patched
        except Exception:
            pass
        raise
    except Exception as exc:
        prompt_chars = len(prompt_system) + len(prompt_user)
        if prompt_messages is not None:
            prompt_chars = sum(len(m.content or "") for m in prompt_messages)

        err_fields = dict(exception_log_fields(exc))
        err_fields.pop("stack", None)

        log_event(
            logger,
            "error",
            llm={
                "provider": llm_call.provider,
                "model": llm_call.model,
                "run_type": run_type,
                "base_url": safe_base_url or None,
                "timeout_seconds": llm_call.timeout_seconds,
                "params": llm_call.params,
                "prompt_chars": prompt_chars,
                "output_chars": 0,
                "error_code": "INTERNAL_ERROR",
                **err_fields,
            },
        )
        run_id = write_generation_run(
            request_id=request_id,
            actor_user_id=actor_user_id,
            project_id=project_id,
            chapter_id=chapter_id,
            run_type=run_type,
            provider=llm_call.provider,
            model=llm_call.model,
            prompt_system=prompt_system,
            prompt_user=prompt_user,
            prompt_render_log_json=prompt_render_log_json,
            params_json=run_params_json,
            output_text=None,
            error_json=json.dumps(
                {"code": "INTERNAL_ERROR", "message": "服务器内部错误", "details": err_fields},
                ensure_ascii=False,
            ),
        )
        try:
            setattr(exc, "run_id", run_id)
        except Exception:
            pass
        raise
