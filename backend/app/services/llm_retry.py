from __future__ import annotations

import os
import random
import time
from dataclasses import dataclass
from typing import Any, Callable

from app.core.errors import AppError
from app.core.logging import redact_secrets_text
from app.llm.messages import ChatMessage, normalize_role
from app.services.generation_service import PreparedLlmCall, RecordedLlmResult, call_llm_and_record, with_param_overrides
from app.services.llm_circuit_breaker import get_circuit_breaker

_MAX_REQUEST_ID_LEN = 64

_TASK_LLM_MAX_ATTEMPTS_ENV = "TASK_LLM_MAX_ATTEMPTS"
_TASK_LLM_RETRY_BASE_SECONDS_ENV = "TASK_LLM_RETRY_BASE_SECONDS"
_TASK_LLM_RETRY_MAX_SECONDS_ENV = "TASK_LLM_RETRY_MAX_SECONDS"
_TASK_LLM_RETRY_JITTER_ENV = "TASK_LLM_RETRY_JITTER"


def _env_int(name: str, *, default: int, min_value: int, max_value: int) -> int:
    raw = str(os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except Exception:
        return default
    return max(min_value, min(max_value, value))


def _env_float(name: str, *, default: float, min_value: float, max_value: float) -> float:
    raw = str(os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except Exception:
        return default
    return max(min_value, min(max_value, value))


def task_llm_max_attempts(*, default: int = 3) -> int:
    return _env_int(_TASK_LLM_MAX_ATTEMPTS_ENV, default=default, min_value=1, max_value=10)


def task_llm_retry_base_seconds(*, default: float = 0.8) -> float:
    return _env_float(_TASK_LLM_RETRY_BASE_SECONDS_ENV, default=default, min_value=0.0, max_value=60.0)


def task_llm_retry_max_seconds(*, default: float = 8.0) -> float:
    return _env_float(_TASK_LLM_RETRY_MAX_SECONDS_ENV, default=default, min_value=0.0, max_value=300.0)


def task_llm_retry_jitter(*, default: float = 0.2) -> float:
    return _env_float(_TASK_LLM_RETRY_JITTER_ENV, default=default, min_value=0.0, max_value=1.0)


def build_retry_request_id(base: str, *, attempt: int) -> str:
    base_norm = str(base or "").strip()
    if attempt <= 1:
        return base_norm[:_MAX_REQUEST_ID_LEN]
    suffix = f"retry{attempt - 1}"
    candidate = f"{base_norm}:{suffix}"
    if len(candidate) <= _MAX_REQUEST_ID_LEN:
        return candidate
    keep = max(0, _MAX_REQUEST_ID_LEN - (len(suffix) + 1))
    return f"{base_norm[:keep]}:{suffix}"


def run_id_from_exc(exc: Exception) -> str | None:
    if isinstance(exc, AppError):
        details = exc.details if isinstance(getattr(exc, "details", None), dict) else {}
        run_id = str(details.get("run_id") or "").strip()
        if run_id:
            return run_id
    run_id2 = str(getattr(exc, "run_id", "") or "").strip()
    return run_id2 or None


def _safe_error_message(exc: Exception, *, limit: int = 400) -> str:
    safe_message = redact_secrets_text(str(exc)).replace("\n", " ").strip()
    if not safe_message:
        safe_message = type(exc).__name__
    return safe_message[:limit]


def _exc_error_code(exc: Exception) -> str | None:
    if isinstance(exc, AppError):
        code = str(getattr(exc, "code", "") or "").strip()
        return code or None
    return None


def _exc_status_code(exc: Exception) -> int | None:
    if isinstance(exc, AppError):
        try:
            value = int(getattr(exc, "status_code", 0) or 0)
        except Exception:
            value = 0
        return value or None
    return None


def is_retryable_llm_error(exc: Exception) -> bool:
    if isinstance(exc, AppError):
        code = str(getattr(exc, "code", "") or "").strip()
        if code in {"LLM_TIMEOUT", "LLM_UPSTREAM_ERROR", "LLM_RATE_LIMIT"}:
            return True
        status = int(getattr(exc, "status_code", 0) or 0)
        return status in {408, 429, 500, 502, 503, 504}
    return isinstance(exc, TimeoutError)


def compute_backoff_seconds(
    *,
    attempt: int,
    base_seconds: float,
    max_seconds: float,
    jitter: float,
    error_code: str | None = None,
) -> float:
    if attempt <= 1:
        return 0.0
    raw = min(float(max_seconds), float(base_seconds) * (2 ** (attempt - 2)))
    if error_code == "LLM_RATE_LIMIT":
        raw = min(float(max_seconds), raw * 2.0)
    if jitter <= 0:
        return raw
    factor = 1.0 + random.uniform(-float(jitter), float(jitter))
    return max(0.0, raw * factor)


def _apply_retry_system_instruction(messages: list[ChatMessage], instruction: str) -> list[ChatMessage]:
    instruction_text = str(instruction or "").strip()
    if not instruction_text:
        return list(messages or [])

    out: list[ChatMessage] = []
    applied = False
    for msg in list(messages or []):
        if not applied and normalize_role(str(getattr(msg, "role", "") or "")) == "system":
            merged = (str(getattr(msg, "content", "") or "") + "\n\n" + instruction_text).strip()
            out.append(ChatMessage(role="system", content=merged, name=getattr(msg, "name", None)))
            applied = True
            continue
        out.append(msg)

    if not applied:
        return [ChatMessage(role="system", content=instruction_text), *out]
    return out


@dataclass(frozen=True, slots=True)
class LlmRetryExhausted(Exception):
    error_type: str
    error_message: str
    error_code: str | None
    status_code: int | None
    run_id: str | None
    attempts: list[dict[str, Any]]
    last_exception: Exception

    def __str__(self) -> str:
        return self.error_message or self.error_type


def call_llm_and_record_with_retries(
    *,
    logger,
    request_id: str,
    actor_user_id: str,
    project_id: str,
    chapter_id: str | None,
    run_type: str,
    api_key: str,
    prompt_system: str,
    prompt_user: str,
    llm_call: PreparedLlmCall,
    prompt_messages: list[ChatMessage] | None = None,
    prompt_render_log_json: str | None = None,
    memory_retrieval_log_json: dict[str, Any] | None = None,
    run_params_extra_json: dict[str, Any] | None = None,
    max_attempts: int = 3,
    retry_prompt_system: str | None = None,
    retry_messages_system_instruction: str | None = None,
    llm_call_overrides_by_attempt: dict[int, dict[str, Any]] | None = None,
    backoff_base_seconds: float = 0.8,
    backoff_max_seconds: float = 8.0,
    jitter: float = 0.2,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[RecordedLlmResult, list[dict[str, Any]]]:
    attempts: list[dict[str, Any]] = []
    base_req = str(request_id or "").strip()[:_MAX_REQUEST_ID_LEN]
    max_attempts2 = max(1, int(max_attempts or 0))

    # --- Circuit breaker check (P0 optimization) ---
    # Extract provider from the llm_call to get the right circuit breaker.
    _provider_name = str(getattr(llm_call, "provider", "") or "unknown").strip()
    _cb = get_circuit_breaker(_provider_name)
    if not _cb.allow_request():
        raise LlmRetryExhausted(
            error_type="CircuitBreakerOpen",
            error_message=f"LLM provider '{_provider_name}' circuit breaker is open due to repeated failures. Please wait and retry.",
            error_code="LLM_CIRCUIT_OPEN",
            status_code=503,
            run_id=None,
            attempts=[{"attempt": 0, "circuit_breaker": "open", "provider": _provider_name}],
            last_exception=AppError(
                code="LLM_CIRCUIT_OPEN",
                message=f"Provider '{_provider_name}' is temporarily unavailable",
                status_code=503,
            ),
        )

    for attempt in range(1, max_attempts2 + 1):
        req2 = build_retry_request_id(base_req, attempt=attempt)
        overrides = (llm_call_overrides_by_attempt or {}).get(attempt) or {}
        llm_call2 = with_param_overrides(llm_call, overrides) if overrides else llm_call

        prompt_system2 = prompt_system
        prompt_messages2 = prompt_messages
        if attempt > 1:
            if isinstance(retry_prompt_system, str) and retry_prompt_system.strip():
                prompt_system2 = retry_prompt_system
            if prompt_messages2 is not None and isinstance(retry_messages_system_instruction, str):
                prompt_messages2 = _apply_retry_system_instruction(prompt_messages2, retry_messages_system_instruction)

        extra = dict(run_params_extra_json or {})
        extra["attempt"] = int(attempt)
        extra["attempt_max"] = int(max_attempts2)
        if isinstance(overrides.get("max_tokens"), int):
            extra["max_tokens"] = int(overrides["max_tokens"])

        try:
            recorded = call_llm_and_record(
                logger=logger,
                request_id=req2,
                actor_user_id=actor_user_id,
                project_id=project_id,
                chapter_id=chapter_id,
                run_type=run_type,
                api_key=api_key,
                prompt_system=prompt_system2,
                prompt_user=prompt_user,
                prompt_messages=prompt_messages2,
                prompt_render_log_json=prompt_render_log_json,
                llm_call=llm_call2,
                memory_retrieval_log_json=memory_retrieval_log_json,
                run_params_extra_json=extra,
            )
            attempts.append(
                {
                    "attempt": int(attempt),
                    "request_id": req2,
                    "run_id": recorded.run_id,
                    "max_tokens": overrides.get("max_tokens"),
                }
            )
            _cb.record_success()
            return recorded, attempts
        except Exception as exc:
            error_code = _exc_error_code(exc)
            status_code = _exc_status_code(exc)
            run_id = run_id_from_exc(exc)
            retryable = is_retryable_llm_error(exc)
            attempts.append(
                {
                    "attempt": int(attempt),
                    "request_id": req2,
                    "run_id": run_id,
                    "max_tokens": overrides.get("max_tokens"),
                    "error_type": type(exc).__name__,
                    "error_code": error_code,
                    "status_code": status_code,
                    "retryable": bool(retryable),
                }
            )

            if attempt >= max_attempts2 or not retryable:
                _cb.record_failure()
                raise LlmRetryExhausted(
                    error_type=type(exc).__name__,
                    error_message=_safe_error_message(exc),
                    error_code=error_code,
                    status_code=status_code,
                    run_id=run_id,
                    attempts=attempts,
                    last_exception=exc,
                ) from exc

            delay = compute_backoff_seconds(
                attempt=attempt + 1,
                base_seconds=backoff_base_seconds,
                max_seconds=backoff_max_seconds,
                jitter=jitter,
                error_code=error_code,
            )
            attempts[-1]["sleep_seconds"] = float(delay)
            if delay > 0:
                sleep(float(delay))
