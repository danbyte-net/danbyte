"""The maintenance flag a restore raises: every request except health and
restore-status answers 503 while it is set (see ``core.middleware``).

Kept in the Django cache (Redis) so every web process and container sees
it; a 6-hour TTL is the safety valve should a worker die mid-restore
without clearing it."""
from __future__ import annotations

from django.core.cache import cache
from django.utils import timezone

KEY = "danbyte:maintenance"
PROGRESS_KEY = "danbyte:restore:{}"
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


def set_progress(run_id: str, data: dict) -> None:
    """Mirror a restore run's state so the dialog can poll it while the
    database itself is being replaced."""
    cache.set(PROGRESS_KEY.format(run_id), data, TTL)


def progress(run_id: str) -> dict | None:
    try:
        value = cache.get(PROGRESS_KEY.format(run_id))
    except Exception:  # noqa: BLE001 - cache down: no mirror, the row is the truth
        return None
    return value if isinstance(value, dict) else None
