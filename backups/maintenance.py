"""The maintenance flag a restore raises: every request except health and
restore-status answers 503 while it is set (see ``core.middleware``).

Kept in the Django cache (Redis) so every web process and container sees
it; a 6-hour TTL is the safety valve should a worker die mid-restore
without clearing it."""
from __future__ import annotations

from django.core.cache import cache
from django.utils import timezone

KEY = "danbyte:maintenance"
TTL = 6 * 3600


def enter(reason: str, run_id: str = "") -> None:
    cache.set(KEY, {"reason": reason, "run_id": run_id, "since": timezone.now().isoformat()}, TTL)


def leave() -> None:
    cache.delete(KEY)


def active() -> dict | None:
    try:
        value = cache.get(KEY)
    except Exception:  # noqa: BLE001 - a cache outage must not take the site down
        return None
    return value if isinstance(value, dict) else None
