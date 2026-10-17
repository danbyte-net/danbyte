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
