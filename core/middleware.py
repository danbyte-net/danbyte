"""Deployment-wide request middleware."""
from __future__ import annotations

from django.core.cache import cache

_IDLE_CACHE_KEY = "deployment:session_idle_timeout_minutes"
_IDLE_CACHE_TTL = 60  # seconds - a settings change takes effect within a minute


def idle_timeout_minutes() -> int:
    """The configured session idle timeout, cached briefly to keep this off the
    per-request hot path. 0 = disabled.

    Every authenticated request reads this, so the cache is only a shortcut:
    if Redis is down or stalled, the value comes from the database and the
    request carries on. It used to fail with it - a Redis restart was a whole
    web outage although sessions live in the database (#230).
    """
    try:
        val = cache.get(_IDLE_CACHE_KEY)
    except Exception:  # noqa: BLE001 - the cache is an optimisation here
        val = None
    if val is None:
        from core.models import DeploymentSettings

        try:
            val = int(DeploymentSettings.load().session_idle_timeout_minutes or 0)
        except Exception:  # noqa: BLE001 - never let this break a request
            val = 0
        try:
            cache.set(_IDLE_CACHE_KEY, val, _IDLE_CACHE_TTL)
        except Exception:  # noqa: BLE001
            pass
    return val


def clear_idle_timeout_cache() -> None:
    cache.delete(_IDLE_CACHE_KEY)


class SessionIdleTimeoutMiddleware:
    """Rolling idle timeout for browser sessions. When an admin has configured a
    timeout, every authenticated request resets that session's expiry window, so
    a session that goes untouched for the configured span is signed out. Token
    (API) requests carry no session and are unaffected.

    Must sit after ``AuthenticationMiddleware`` so ``request.user`` is resolved.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = getattr(request, "user", None)
        if user is not None and user.is_authenticated:
            minutes = idle_timeout_minutes()
            if minutes > 0:
                # Reset the window; set_expiry marks the session modified so the
                # new expiry is persisted (rolling, not absolute).
                request.session.set_expiry(minutes * 60)
        return self.get_response(request)


# Requests that must keep working while a restore or an upgrade holds the
# site: the health probe, the restore-run and upgrade status the UI polls,
# and static assets.
_MAINTENANCE_EXEMPT = ("/api/health/", "/api/backups/restore-runs/",
                       "/api/system/upgrade/status/", "/static/", "/media/")


class MaintenanceMiddleware:
    """503 with ``Retry-After`` while a restore is replacing the database or
    an upgrade is starting the new code (``backups.maintenance``). Callers
    get JSON they can act on; nginx passes the 503 through as it is. A
    request carrying the upgrade's probe token (``X-Danbyte-Probe``) is let
    through, so the upgrade can check a real page before users arrive."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path or ""
        if path.startswith("/api/backups/restore-runs/"):
            # The database may be mid-replacement: answer the active run from
            # its cache mirror instead of letting the view hit the ORM.
            from backups.maintenance import active, progress

            state = active()
            run_id = (state or {}).get("run_id")
            if run_id and path == f"/api/backups/restore-runs/{run_id}/":
                data = progress(run_id)
                if data:
                    from django.http import JsonResponse

                    return JsonResponse(data)
        if not path.startswith(_MAINTENANCE_EXEMPT):
            from backups.maintenance import active, probe_matches

            state = active()
            if state and not probe_matches(state, request.META.get("HTTP_X_DANBYTE_PROBE", "")):
                from django.http import JsonResponse

                resp = JsonResponse(
                    {"detail": f"Danbyte is in maintenance: {state.get('reason') or 'restore in progress'}.",
                     "maintenance": {k: v for k, v in state.items() if k != "probe_sha256"}},
                    status=503,
                )
                resp["Retry-After"] = "30"
                # A planned state, not a server error: django.request would
                # log every one of these at ERROR while an upgrade runs.
                resp._has_been_logged = True
                return resp
        return self.get_response(request)


class RejectNulQueryMiddleware:
    """400 for a query string carrying a NUL byte. PostgreSQL text cannot
    hold one, so a filter that reached the database with it failed as a 500
    (#373); rejecting it here covers every filter, present and future."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if "%00" in request.META.get("QUERY_STRING", "") and any(
            "\x00" in key or any("\x00" in v for v in values)
            for key, values in request.GET.lists()
        ):
            from django.http import JsonResponse

            return JsonResponse(
                {"detail": "Query parameters cannot contain NUL characters."}, status=400
            )
        return self.get_response(request)


# How long a large-page slot outlives a request that never released it (a
# worker killed at its timeout skips the `finally`). Above gunicorn's timeout.
LARGE_PAGE_SLOT_TTL = 120
LARGE_PAGE_RETRY_AFTER = 2


def _large_page_size(request) -> int | None:
    """The ``page_size`` a list request names, when it is above
    ``API_LARGE_PAGE_THRESHOLD``; ``None`` for every other request."""
    if request.method not in ("GET", "HEAD") or not (request.path or "").startswith("/api/"):
        return None
    raw = request.GET.get("page_size")
    if not raw:
        return None
    try:
        size = int(raw)
    except ValueError:
        return None
    from django.conf import settings

    return size if size > settings.API_LARGE_PAGE_THRESHOLD else None


def _large_page_owner(request) -> str | None:
    """Whose slots a request uses: the API token it carries, else the signed-in
    user. The token is keyed by its hash, so a stray or forged one only ever
    competes with itself (DRF refuses it right after)."""
    from rest_framework.authentication import get_authorization_header

    parts = get_authorization_header(request).split()
    if len(parts) == 2 and parts[0].lower() == b"token":
        from auth_api.models import hash_api_key

        return "t:" + hash_api_key(parts[1].decode("latin-1"))
    user = getattr(request, "user", None)
    if user is not None and user.is_authenticated:
        return f"u:{user.pk}"
    return None


class LargePageGuardMiddleware:
    """At most ``API_LARGE_PAGE_CONCURRENCY`` large list pages in flight per
    token or user (#452). A page above ``API_LARGE_PAGE_THRESHOLD`` rows
    (1,000, the most the web app asks for) holds a worker for seconds; a
    handful of them used to hold every worker. Each request
    takes a slot (a Redis key with a TTL, so a request that dies without
    letting go frees it anyway) and gives it back in ``finally``. With every
    slot taken the answer is 429 with ``Retry-After``. Small pages, writes and
    anonymous requests pass untouched, and so does everything when the cache
    is unreachable: the guard protects workers, it is no reason to refuse."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if _large_page_size(request) is None:
            return self.get_response(request)
        owner = _large_page_owner(request)
        if owner is None:
            return self.get_response(request)
        from django.conf import settings

        slot = None
        try:
            for n in range(settings.API_LARGE_PAGE_CONCURRENCY):
                key = f"api:large-page:{owner}:{n}"
                if cache.add(key, 1, LARGE_PAGE_SLOT_TTL):
                    slot = key
                    break
            else:
                return _too_many_large_pages(settings.API_LARGE_PAGE_THRESHOLD)
        except Exception:  # noqa: BLE001 - the cache is down: let it through
            slot = None
        try:
            return self.get_response(request)
        finally:
            if slot is not None:
                try:
                    cache.delete(slot)
                except Exception:  # noqa: BLE001
                    pass


def _too_many_large_pages(page_size: int):
    from django.http import JsonResponse

    resp = JsonResponse(
        {"detail": (
            "Too many large pages at once. Wait for one to finish, or ask for "
            f"{page_size} rows a page and follow `next`."
        )},
        status=429,
    )
    resp["Retry-After"] = str(LARGE_PAGE_RETRY_AFTER)
    return resp
