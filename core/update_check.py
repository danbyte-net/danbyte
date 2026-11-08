"""The release list behind the update check, read from Redis (#478).

``GET /api/system/updates/`` used to fetch the release repo inside the request:
every admin page load paid the GitHub round trip, and a stalled outbound
connection held a gunicorn worker for 20 s. The list is now fetched in the
background - the ``danbyte-update-check`` timer every six hours, and one RQ job
when a request finds the cache cold - and the endpoint only reads the cache.
A slow or unreachable repo makes the cached answer stale, never a request slow.
"""
from __future__ import annotations

import hashlib
import logging

log = logging.getLogger(__name__)

#: How long a fetched list stays readable. The timer refreshes it every 6 h,
#: so this only matters when the timer stops; a day keeps a stale answer
#: rather than flipping back to "checking".
CACHE_TTL = 24 * 3600
#: One enqueued refresh per cold cache, however many page loads see it.
LOCK_TTL = 5 * 60
#: The background fetch may wait longer than a request ever should.
FETCH_TIMEOUT = 15


def _key(repo: str, token: str) -> str:
    # The token is part of the key (a new token can see a private repo), hashed
    # so it never sits in Redis in the clear.
    digest = hashlib.sha256(f"{repo}\n{token}".encode()).hexdigest()[:24]
    return f"danbyte:update-check:{digest}"


def _repo_and_token(dep) -> tuple[str, str]:
    from .version import DEFAULT_RELEASE_REPO

    return (dep.release_repo_url or DEFAULT_RELEASE_REPO,
            (dep.secrets or {}).get("release_repo_token", ""))


def cached(dep) -> dict | None:
    """``{"releases", "checked_at", "error"}`` from the cache, or None when cold
    (or Redis is unreachable)."""
    from django.core.cache import cache

    try:
        return cache.get(_key(*_repo_and_token(dep)))
    except Exception:  # noqa: BLE001 - a cache outage reads as cold, not a 500
        log.warning("update check: cache unreachable", exc_info=True)
        return None


def refresh(dep=None) -> dict | None:
    """Fetch the release list and store it. A failed fetch keeps the releases
    from the last good one and records the error. None when the check is
    disabled (airgapped): nothing is fetched."""
    from django.core.cache import cache
    from django.utils import timezone

    from .errors import NETWORK_ERRORS, public_error
    from .github import list_releases
    from .models import DeploymentSettings

    dep = dep or DeploymentSettings.load()
    if dep.disable_update_check:
        return None
    repo, token = _repo_and_token(dep)
    key = _key(repo, token)
    try:
        entry = {"releases": list_releases(repo, token, timeout=FETCH_TIMEOUT),
                 "checked_at": timezone.now().isoformat(), "error": ""}
    except Exception as e:  # noqa: BLE001 - recorded for the Updates page
        try:
            prev = cache.get(key) or {}
        except Exception:  # noqa: BLE001
            prev = {}
        entry = {"releases": prev.get("releases", []),
                 "checked_at": timezone.now().isoformat(),
                 "error": public_error(e, "The release list could not be read.",
                                       expected=NETWORK_ERRORS)}
    cache.set(key, entry, CACHE_TTL)
    cache.delete(key + ":lock")
    return entry


def refresh_job() -> None:
    """RQ entry point for :func:`request_refresh`."""
    refresh()


def request_refresh(dep) -> None:
    """Enqueue one background refresh; a refresh already queued in the last
    few minutes makes this a no-op."""
    import django_rq
    from django.core.cache import cache

    key = _key(*_repo_and_token(dep)) + ":lock"
    try:
        if not cache.add(key, 1, LOCK_TTL):
            return
        django_rq.get_queue("default").enqueue("core.update_check.refresh_job")
    except Exception:  # noqa: BLE001 - the timer fills the cache anyway
        log.warning("update check: could not enqueue a refresh", exc_info=True)
