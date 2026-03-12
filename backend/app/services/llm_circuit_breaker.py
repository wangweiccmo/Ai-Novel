"""
LLM Circuit Breaker — prevents cascading failures when an LLM provider is down.

State machine:
    CLOSED  →  (failure_threshold consecutive failures)  →  OPEN
    OPEN    →  (recovery_timeout elapsed)                →  HALF_OPEN
    HALF_OPEN → (success_threshold consecutive successes) → CLOSED
    HALF_OPEN → (any failure)                            → OPEN

Each provider gets its own independent circuit breaker so that e.g.
OpenAI being down doesn't block Anthropic calls.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger("ainovel.circuit_breaker")


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass
class CircuitBreakerConfig:
    """Configuration for a circuit breaker instance."""
    failure_threshold: int = 5           # consecutive failures before opening
    recovery_timeout_seconds: float = 60  # how long to stay open before half-open
    success_threshold: int = 2            # consecutive successes in half-open to close


@dataclass
class _CircuitBreakerState:
    """Internal mutable state for one circuit breaker."""
    state: CircuitState = CircuitState.CLOSED
    failure_count: int = 0
    success_count: int = 0
    last_failure_time: float = 0.0
    last_state_change: float = 0.0
    total_failures: int = 0
    total_successes: int = 0
    total_rejected: int = 0


class CircuitBreaker:
    """
    Thread-safe circuit breaker for a single LLM provider.

    Usage:
        cb = CircuitBreaker("openai")
        if not cb.allow_request():
            raise AppError(code="LLM_CIRCUIT_OPEN", ...)
        try:
            result = call_llm(...)
            cb.record_success()
        except Exception as exc:
            cb.record_failure()
            raise
    """

    def __init__(self, name: str, *, config: CircuitBreakerConfig | None = None):
        self.name = name
        self.config = config or CircuitBreakerConfig()
        self._state = _CircuitBreakerState(last_state_change=time.monotonic())
        self._lock = threading.Lock()

    @property
    def state(self) -> CircuitState:
        with self._lock:
            self._maybe_transition_to_half_open()
            return self._state.state

    def allow_request(self) -> bool:
        """Check if a request is allowed. Returns False if circuit is OPEN."""
        with self._lock:
            self._maybe_transition_to_half_open()

            if self._state.state == CircuitState.CLOSED:
                return True

            if self._state.state == CircuitState.HALF_OPEN:
                return True

            # OPEN — reject
            self._state.total_rejected += 1
            return False

    def record_success(self) -> None:
        """Record a successful LLM call."""
        with self._lock:
            self._state.total_successes += 1

            if self._state.state == CircuitState.CLOSED:
                self._state.failure_count = 0
                return

            if self._state.state == CircuitState.HALF_OPEN:
                self._state.success_count += 1
                if self._state.success_count >= self.config.success_threshold:
                    self._transition(CircuitState.CLOSED)
                    logger.info(
                        "circuit_breaker %s: HALF_OPEN → CLOSED (recovered)",
                        self.name,
                    )
                return

    def record_failure(self) -> None:
        """Record a failed LLM call."""
        now = time.monotonic()
        with self._lock:
            self._state.total_failures += 1
            self._state.last_failure_time = now

            if self._state.state == CircuitState.CLOSED:
                self._state.failure_count += 1
                if self._state.failure_count >= self.config.failure_threshold:
                    self._transition(CircuitState.OPEN)
                    logger.warning(
                        "circuit_breaker %s: CLOSED → OPEN (failures=%d)",
                        self.name,
                        self._state.failure_count,
                    )
                return

            if self._state.state == CircuitState.HALF_OPEN:
                self._transition(CircuitState.OPEN)
                logger.warning(
                    "circuit_breaker %s: HALF_OPEN → OPEN (probe failed)",
                    self.name,
                )
                return

    def reset(self) -> None:
        """Manually reset the circuit breaker to CLOSED."""
        with self._lock:
            self._transition(CircuitState.CLOSED)
            logger.info("circuit_breaker %s: manually reset to CLOSED", self.name)

    def status(self) -> dict[str, Any]:
        """Return current status for health check / observability."""
        with self._lock:
            self._maybe_transition_to_half_open()
            return {
                "name": self.name,
                "state": self._state.state.value,
                "failure_count": self._state.failure_count,
                "total_failures": self._state.total_failures,
                "total_successes": self._state.total_successes,
                "total_rejected": self._state.total_rejected,
                "config": {
                    "failure_threshold": self.config.failure_threshold,
                    "recovery_timeout_seconds": self.config.recovery_timeout_seconds,
                    "success_threshold": self.config.success_threshold,
                },
            }

    def _maybe_transition_to_half_open(self) -> None:
        """Called under lock. Check if OPEN → HALF_OPEN transition is due."""
        if self._state.state != CircuitState.OPEN:
            return
        elapsed = time.monotonic() - self._state.last_state_change
        if elapsed >= self.config.recovery_timeout_seconds:
            self._transition(CircuitState.HALF_OPEN)
            logger.info(
                "circuit_breaker %s: OPEN → HALF_OPEN (recovery timeout %.1fs elapsed)",
                self.name,
                elapsed,
            )

    def _transition(self, new_state: CircuitState) -> None:
        """Called under lock. Perform state transition."""
        self._state.state = new_state
        self._state.last_state_change = time.monotonic()
        self._state.failure_count = 0
        self._state.success_count = 0


# ---------------------------------------------------------------------------
# Global registry: one circuit breaker per provider name
# ---------------------------------------------------------------------------

_registry: dict[str, CircuitBreaker] = {}
_registry_lock = threading.Lock()


def get_circuit_breaker(provider: str) -> CircuitBreaker:
    """Get or create a circuit breaker for the given LLM provider."""
    key = str(provider or "unknown").strip().lower()
    with _registry_lock:
        if key not in _registry:
            _registry[key] = CircuitBreaker(key)
        return _registry[key]


def all_circuit_breaker_statuses() -> dict[str, dict[str, Any]]:
    """Return status of all circuit breakers for health endpoint."""
    with _registry_lock:
        return {name: cb.status() for name, cb in _registry.items()}


def reset_all_circuit_breakers() -> None:
    """Reset all circuit breakers (for testing or manual recovery)."""
    with _registry_lock:
        for cb in _registry.values():
            cb.reset()
