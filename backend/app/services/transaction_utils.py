"""Transaction safety utilities for multi-step DB operations.

Provides context managers and helpers to ensure atomic multi-step operations
don't leave the database in an inconsistent state on partial failure.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Generator

from sqlalchemy.orm import Session

logger = logging.getLogger("ainovel")


@contextmanager
def safe_transaction(db: Session, *, label: str = "") -> Generator[Session, None, None]:
    """Context manager that commits on success, rolls back on failure.

    Usage:
        with safe_transaction(db, label="update_chapter_and_memory") as tx:
            tx.add(chapter)
            tx.add(memory)
            # auto-commit on success, auto-rollback on exception
    """
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        if label:
            logger.warning("Transaction rolled back: %s", label, exc_info=True)
        raise


@contextmanager
def nested_savepoint(db: Session, *, label: str = "") -> Generator[Session, None, None]:
    """Use a savepoint for partial operations that can fail without
    rolling back the entire transaction.

    Usage:
        with nested_savepoint(db, label="optional_vector_update") as sp:
            # If this fails, only this savepoint is rolled back
            sp.execute(...)
    """
    savepoint = db.begin_nested()
    try:
        yield db
        savepoint.commit()
    except Exception:
        savepoint.rollback()
        if label:
            logger.info("Savepoint rolled back: %s", label, exc_info=True)
        raise


def commit_or_rollback(db: Session, *, label: str = "") -> bool:
    """Attempt commit; on failure, rollback and return False."""
    try:
        db.commit()
        return True
    except Exception:
        db.rollback()
        if label:
            logger.warning("Commit failed, rolled back: %s", label, exc_info=True)
        return False
