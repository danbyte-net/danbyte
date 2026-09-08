"""Deployment-wide request middleware."""
from __future__ import annotations

from django.core.cache import cache

_IDLE_CACHE_KEY = "deployment:session_idle_timeout_minutes"
_IDLE_CACHE_TTL = 60  # seconds - a settings change takes effect within a minute


def idle_timeout_minutes() -> int:
    """The configured session idle timeout, cached briefly to keep this off the
    per-request hot path. 0 = disabled."""
    val = cache.get(_IDLE_CACHE_KEY)
    if val is None:
        from core.models import DeploymentSettings

        try:
            val = int(DeploymentSettings.load().session_idle_timeout_minutes or 0)
        except Exception:  # noqa: BLE001 - never let this break a request
            val = 0
        cache.set(_IDLE_CACHE_KEY, val, _IDLE_CACHE_TTL)
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


# Requests that must keep working while a restore holds the site: the
# health probe, the restore-run status the UI polls, and static assets.
_MAINTENANCE_EXEMPT = ("/api/health/", "/api/backups/restore-runs/", "/static/", "/media/")


class MaintenanceMiddleware:
    """503 with ``Retry-After`` while a restore is replacing the database
    (``backups.maintenance``). nginx turns the 503 into the maintenance page
    for browsers; API callers get JSON they can act on."""

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
            from backups.maintenance import active

            state = active()
            if state:
                from django.http import JsonResponse

                resp = JsonResponse(
                    {"detail": f"Danbyte is in maintenance: {state.get('reason') or 'restore in progress'}.",
                     "maintenance": state},
                    status=503,
                )
                resp["Retry-After"] = "30"
                return resp
        return self.get_response(request)
