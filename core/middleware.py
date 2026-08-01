"""Deployment-wide request middleware."""
from __future__ import annotations

from django.core.cache import cache

_IDLE_CACHE_KEY = "deployment:session_idle_timeout_minutes"
_IDLE_CACHE_TTL = 60  # seconds — a settings change takes effect within a minute


def idle_timeout_minutes() -> int:
    """The configured session idle timeout, cached briefly to keep this off the
    per-request hot path. 0 = disabled."""
    val = cache.get(_IDLE_CACHE_KEY)
    if val is None:
        from core.models import DeploymentSettings

        try:
            val = int(DeploymentSettings.load().session_idle_timeout_minutes or 0)
        except Exception:  # noqa: BLE001 — never let this break a request
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
