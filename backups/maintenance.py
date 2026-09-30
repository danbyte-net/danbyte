"""The maintenance flag a restore or an upgrade raises: every request except
health, restore-status and upgrade-status answers 503 while it is set (see
``core.middleware``).

Kept in the Django cache (Redis) so every web process and container sees
it; the TTL is the safety valve should the process that set it die without
clearing it - 6 hours for a restore, 15 minutes for an upgrade's start
phase. An upgrade may also name a probe token: a request carrying it in
``X-Danbyte-Probe`` passes, so the upgrade can load a real page before
users can. Only its SHA-256 is stored."""
from __future__ import annotations

import hashlib
import hmac

from django.core.cache import cache
from django.utils import timezone

KEY = "danbyte:maintenance"
PROGRESS_KEY = "danbyte:restore:{}"
TTL = 6 * 3600


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def enter(reason: str, run_id: str = "", ttl: int = TTL, probe: str = "",
          upgrade: bool = False) -> None:
    state = {"reason": reason, "run_id": run_id, "since": timezone.now().isoformat()}
    if probe:
        state["probe_sha256"] = _digest(probe)
    if upgrade:
        state["upgrade"] = True
    cache.set(KEY, state, ttl)


def leave() -> None:
    cache.delete(KEY)


def active() -> dict | None:
    try:
        value = cache.get(KEY)
    except Exception:  # noqa: BLE001 - a cache outage must not take the site down
        return None
    return value if isinstance(value, dict) else None


def probe_matches(state: dict | None, token: str) -> bool:
    """Does ``token`` open the flag? Constant-time; no token never does."""
    want = (state or {}).get("probe_sha256")
    if not want or not token:
        return False
    return hmac.compare_digest(_digest(token), str(want))


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
