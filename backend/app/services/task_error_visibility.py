"""Utility for recording user-visible errors on ProjectTask.

Phase 2 optimization: auto-update failure visibility.
When worldbook / characters / graph auto-update tasks fail,
errors are recorded in user_visible_errors_json so the frontend
can surface them to the user instead of silently swallowing failures.
"""

from __future__ import annotations

import json
from typing import Any

from app.db.utils import utc_now
from app.models.project_task import ProjectTask


def record_user_visible_error(
    task: ProjectTask,
    *,
    code: str,
    message: str,
    details: Any = None,
) -> None:
    """Append a user-visible error entry to the task's user_visible_errors_json."""
    errors: list[dict[str, Any]] = []
    raw = getattr(task, "user_visible_errors_json", None)
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                errors = parsed
        except Exception:
            errors = []

    entry: dict[str, Any] = {
        "code": str(code),
        "message": str(message),
        "timestamp": utc_now().isoformat(),
    }
    if details is not None:
        entry["details"] = details

    errors.append(entry)
    # Keep only last 50 errors per task
    if len(errors) > 50:
        errors = errors[-50:]

    task.user_visible_errors_json = json.dumps(errors, ensure_ascii=False)


def get_user_visible_errors(task: ProjectTask) -> list[dict[str, Any]]:
    """Read user-visible errors from a task."""
    raw = getattr(task, "user_visible_errors_json", None)
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return parsed
    except Exception:
        pass
    return []
