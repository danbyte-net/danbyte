"""PRTG's "Execute HTTP Action" notification, as a hint.

PRTG can POST to a URL when a sensor changes state. Danbyte takes that as a
reason to look sooner - never as the state itself: the receiver reads the
sensor and device ids, ignores everything else, and queues a re-read of that
one device from PRTG. A forged call can at most make Danbyte ask PRTG sooner.

The URL carries a per-connection token. Only its SHA-256 is stored; the
token is shown once, when it is made. Unknown token, push off, the connection
or tenant inactive, or the integration off are all the same 404 - the
receiver says nothing about which connections exist.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

from django.core.cache import cache
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import BaseThrottle
from rest_framework.views import APIView

from integrations.toggles import integration_enabled

from .models import PrtgConnection

#: Hints accepted per connection per minute. PRTG sends one per state change;
#: a storm beyond this is not worth a read each.
RATE_PER_MINUTE = 60
#: A second hint for the same device inside this window rides the first.
DEBOUNCE_SECONDS = 5


def _digest(token: str) -> str:
    return hashlib.sha256((token or "").encode()).hexdigest()


def new_token(conn: PrtgConnection) -> str:
    """A fresh token for ``conn``; the old one stops working at once."""
    token = secrets.token_urlsafe(32)
    conn.hook_token_hash = _digest(token)
    conn.save(update_fields=["hook_token_hash"])
    return token


def connection_for(token: str):
    """The connection a token belongs to, or None. Looked up by digest and
    then compared in constant time."""
    if not token or len(token) > 128:
        return None
    digest = _digest(token)
    conn = (
        PrtgConnection.objects.filter(hook_token_hash=digest)
        .select_related("tenant").first()
    )
    if conn is None or not hmac.compare_digest(conn.hook_token_hash, digest):
        return None
    return conn


def _int(value):
    try:
        value = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


class _NoThrottle(BaseThrottle):
    def allow_request(self, request, view):
        return True


class PrtgHookView(APIView):
    """``POST /api/prtg/hook/<token>/`` - form-encoded, as PRTG sends it."""

    authentication_classes = []
    permission_classes = [AllowAny]
    # The per-connection limit below is the one that matters; the global
    # anonymous throttle would share one budget across every PRTG.
    throttle_classes = [_NoThrottle]

    def post(self, request, token=None):
        conn = connection_for(token or "")
        if (
            conn is None or not conn.enabled or not conn.push_enabled
            or not conn.tenant.is_active or not integration_enabled(conn.tenant, "prtg")
        ):
            return Response({"detail": "Not found."}, status=404)

        window = f"prtg-hook-rate:{conn.id}"
        cache.add(window, 0, 60)
        try:
            count = cache.incr(window)
        except ValueError:
            cache.set(window, 1, 60)
            count = 1
        if count > RATE_PER_MINUTE:
            return Response({"detail": "Too many notifications."}, status=429)

        data = request.data if hasattr(request.data, "get") else {}
        sensor = _int(data.get("sensorid") or request.query_params.get("sensorid"))
        device = _int(data.get("deviceid") or request.query_params.get("deviceid"))
        if sensor is None and device is None:
            return Response({"detail": "sensorid or deviceid is required."}, status=400)

        key = f"prtg-hook:{conn.id}:{device or ''}:{sensor or ''}"
        queued = False
        if cache.add(key, 1, DEBOUNCE_SECONDS):
            import django_rq

            from .reader import refresh_device

            django_rq.get_queue("low").enqueue(
                refresh_device, str(conn.id), sensor, device, job_timeout=120
            )
            queued = True
        return Response({"ok": True, "queued": queued}, status=202)
