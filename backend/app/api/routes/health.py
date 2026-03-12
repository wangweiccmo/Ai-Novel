from __future__ import annotations

import time

from fastapi import APIRouter, Request
from sqlalchemy import text

from app.api.deps import DbDep
from app.core.config import settings
from app.core.errors import ok_payload
from app.services.llm_circuit_breaker import all_circuit_breaker_statuses
from app.services.task_queue import get_queue_status_for_health

router = APIRouter()

_BOOT_TIME = time.monotonic()


@router.get("/health")
def health(request: Request) -> dict:
    request_id = request.state.request_id
    return ok_payload(
        request_id=request_id,
        data={
            "status": "healthy",
            "version": settings.app_version,
            **get_queue_status_for_health(),
        },
    )


@router.get("/health/detailed")
def health_detailed(request: Request, db: DbDep) -> dict:
    """Detailed health check including LLM circuit breakers, DB, and vector store."""
    request_id = request.state.request_id
    cb_statuses = all_circuit_breaker_statuses()

    # DB connectivity check
    db_status = _check_db(db)

    # Vector store check
    vector_status = _check_vector_store()

    uptime_seconds = round(time.monotonic() - _BOOT_TIME, 1)

    return ok_payload(
        request_id=request_id,
        data={
            "status": "healthy" if db_status["ok"] else "degraded",
            "version": settings.app_version,
            "uptime_seconds": uptime_seconds,
            **get_queue_status_for_health(),
            "llm_circuit_breakers": cb_statuses,
            "database": db_status,
            "vector_store": vector_status,
        },
    )


def _check_db(db: object) -> dict:
    try:
        db.execute(text("SELECT 1"))  # type: ignore[union-attr]
        return {"ok": True, "backend": getattr(settings, "database_backend", "unknown")}
    except Exception as exc:
        return {"ok": False, "error": str(type(exc).__name__)}


def _check_vector_store() -> dict:
    try:
        from app.services.vector_rag_service import vector_rag_status
        status = vector_rag_status(project_id="__health_check__")
        return {
            "ok": bool(status.get("enabled")),
            "backend": status.get("backend") or status.get("backend_preferred"),
            "disabled_reason": status.get("disabled_reason"),
        }
    except Exception as exc:
        return {"ok": False, "error": str(type(exc).__name__)}
