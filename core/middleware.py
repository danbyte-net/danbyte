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


#: How far the idle-timeout expiry may drift before a request writes it again
#: (#486). Writing it on every request was one UPDATE of the session row per
#: API call - 20+ per page load - for a window that only needs minute accuracy.
IDLE_REFRESH_SLACK = 60


class SessionIdleTimeoutMiddleware:
    """Rolling idle timeout for browser sessions. When an admin has configured a
    timeout, an authenticated request moves that session's expiry to "now +
    timeout", so a session that goes untouched for the configured span is
    signed out. The expiry is stored as a date and only rewritten once it has
    drifted by ``IDLE_REFRESH_SLACK`` seconds, so a burst of requests writes
    the session row once; the session may end up to a minute early. Token
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
                _refresh_idle_expiry(request.session, minutes * 60)
        return self.get_response(request)


def _refresh_idle_expiry(session, timeout: int) -> None:
    from datetime import timedelta

    from django.utils import timezone

    # A session from before #486 (or never touched by this middleware) has an
    # age in seconds or no expiry at all; neither says how much is left.
    if isinstance(session.get("_session_expiry"), str):
        left = session.get_expiry_age()
        # Inside the window, and not longer than it (the timeout was lowered).
        if timeout - IDLE_REFRESH_SLACK <= left <= timeout:
            return
    # set_expiry marks the session modified, so the new expiry is persisted.
    session.set_expiry(timezone.now() + timedelta(seconds=timeout))


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


class ApiNoStoreMiddleware:
    """``Cache-Control: private, no-store`` on API responses for a signed-in
    caller (#491), so neither the browser's disk cache nor a shared proxy keeps
    a copy of someone's data after they sign out. A view that sets its own
    ``Cache-Control`` (a download, a thumbnail) keeps it.

    Runs after the view, when DRF has copied a token user onto the request."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if (
            request.path.startswith("/api/")
            and not response.has_header("Cache-Control")
            and (
                getattr(getattr(request, "user", None), "is_authenticated", False)
                or "HTTP_AUTHORIZATION" in request.META
            )
        ):
            response["Cache-Control"] = "private, no-store"
        return response


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


TOKEN_OWNER_TTL = 300


def _token_user_id(key_hash: str) -> int | None:
    """The user behind an API token hash, cached for a few minutes; ``None``
    when no token has that hash."""
    cache_key = f"api:token-user:{key_hash}"
    try:
        hit = cache.get(cache_key)
    except Exception:  # noqa: BLE001 - the cache is down: ask the database
        hit = None
    if hit is not None:
        return hit or None  # 0 caches "no such token"
    from auth_api.models import ApiToken

    user_id = (
        ApiToken.objects.filter(key_hash=key_hash).values_list("user_id", flat=True).first()
    )
    try:
        cache.set(cache_key, user_id or 0, TOKEN_OWNER_TTL)
    except Exception:  # noqa: BLE001
        pass
    return user_id


def _large_page_owner(request) -> str | None:
    """Whose slots a request uses: the user behind the API token it carries,
    else the signed-in user. Every token of one user shares that user's slots,
    so minting more tokens buys no more large pages (#457). A token no user
    owns (stray or forged) is keyed by its hash and only ever competes with
    itself; DRF refuses it right after."""
    from rest_framework.authentication import get_authorization_header

    parts = get_authorization_header(request).split()
    if len(parts) == 2 and parts[0].lower() == b"token":
        from auth_api.models import hash_api_key

        key_hash = hash_api_key(parts[1].decode("latin-1"))
        user_id = _token_user_id(key_hash)
        return f"u:{user_id}" if user_id else "t:" + key_hash
    user = getattr(request, "user", None)
    if user is not None and user.is_authenticated:
        return f"u:{user.pk}"
    return None


class LargePageGuardMiddleware:
    """At most ``API_LARGE_PAGE_CONCURRENCY`` large list pages in flight per
    user, all of their tokens together (#452, #457). A page above ``API_LARGE_PAGE_THRESHOLD`` rows
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
