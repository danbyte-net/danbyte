"""Checker interface + registry.

A *checker* knows how to probe one protocol against a target host and judge the
result. Each kind (icmp, tcp, …) registers an implementation in
``CHECKER_REGISTRY``; the runner looks one up by kind and calls ``run``.

Contract every checker must honour:

* **Honour the timeout** — never run longer than ``timeout_ms`` for a single
  attempt, and never block the event loop (all I/O is ``async``).
* **``unknown`` ≠ ``down``.** Internal/config errors (bad params, missing
  privilege, unexpected exception) return ``unknown`` so misconfiguration never
  looks like an outage. ``down`` is reserved for a genuine reachability failure.
* **Degraded is advisory.** A checker may return ``degraded`` when the target is
  reachable but a quality criterion fails (latency over threshold, unexpected
  HTTP code, SNMP value mismatch). The runner downgrades ``degraded`` → ``up``
  when the template has ``degraded_enabled=False``, so the gate stays central.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

Status = Literal["up", "down", "degraded", "unknown"]


@dataclass
class CheckOutcome:
    """The result of one check attempt."""

    status: Status
    latency_ms: float | None = None
    detail: dict = field(default_factory=dict)

    @classmethod
    def unknown(cls, error: str, **detail) -> "CheckOutcome":
        return cls("unknown", None, {"error": error, **detail})


class CheckConfigError(ValueError):
    """Raised by ``validate_params`` when a template's params are invalid."""


@runtime_checkable
class Checker(Protocol):
    kind: str

    async def run(
        self,
        target: str,
        params: dict,
        secret_params: dict,
        timeout_ms: int,
    ) -> CheckOutcome: ...

    def validate_params(self, params: dict) -> None:
        """Raise ``CheckConfigError`` on invalid config; return None if OK."""
        ...


CHECKER_REGISTRY: dict[str, Checker] = {}


def register(cls: type) -> type:
    """Class decorator — instantiate and register a checker by its ``kind``."""
    instance = cls()
    CHECKER_REGISTRY[instance.kind] = instance
    return cls


def get_checker(kind: str) -> Checker | None:
    return CHECKER_REGISTRY.get(kind)


# ─── shared param helpers ─────────────────────────────────────────────────


def require_port(params: dict, key: str = "port") -> int:
    raw = params.get(key)
    if raw is None:
        raise CheckConfigError(f"'{key}' is required")
    try:
        port = int(raw)
    except (TypeError, ValueError):
        raise CheckConfigError(f"'{key}' must be an integer") from None
    if not (1 <= port <= 65535):
        raise CheckConfigError(f"'{key}' must be between 1 and 65535")
    return port
