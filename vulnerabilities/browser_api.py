"""Browser-mode endpoints (#451). Deployment admin, session + CSRF only (an
API token cannot drive a browser sync), each post bound to the admin's open
run and rate limited. Bodies are the public services' answers verbatim.

* ``POST /api/vulnerabilities/sync/``                      open or resume the
  run; answers it with its plan and progress.
* ``POST /api/vulnerabilities/sync/<run>/nvd/?product=&start_index=``
  one NVD CVE API page (8 MB at most).
* ``POST /api/vulnerabilities/sync/<run>/epss-plan/``      the EPSS batches.
* ``POST /api/vulnerabilities/sync/<run>/epss/?batch=``    one EPSS answer.
* ``POST /api/vulnerabilities/sync/<run>/osv-ids/``        ``{"vulns": {id:
  modified}}`` from the OSV querybatch rounds; answers what to fetch.
* ``POST /api/vulnerabilities/sync/<run>/osv/``            a JSON list of OSV
  records.
* ``POST /api/vulnerabilities/sync/<run>/finish/``         ``{"errors": [...],
  "stop": false}``; recompute follows.

``GET /api/vulnerabilities/sync/<run>/`` (in :mod:`vulnerabilities.api`)
reads a run for any deployment admin. No endpoint here makes an outbound
request, and none accepts or returns an NVD API key.
"""
from __future__ import annotations

import time

from django.core.cache import cache
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import can_manage_deployment

from . import browser_sync
from .api import run_dict
from .browser_sync import Refused

_ADMIN = {"detail": "users.manage required."}


def _bump(key: str, window: int) -> int:
    cache.add(key, 0, window * 2)
    try:
        return cache.incr(key)
    except ValueError:  # expired between add and incr
        cache.set(key, 1, window * 2)
        return 1


def _body(request, cap: int):
    """The raw request stream after the size checks, or a refusal."""
    if not (request.content_type or "").startswith("application/json"):
        return None, Response({"detail": "Send the answer as application/json."}, status=415)
    try:
        length = int(request.META.get("CONTENT_LENGTH") or "")
    except ValueError:
        return None, Response({"detail": "A Content-Length is required."}, status=411)
    if length > cap:
        return None, Response({"detail": f"The body is larger than {cap // (1024 * 1024)} MB."},
                              status=413)
    # Django's request is a file-like reader bounded by Content-Length; DRF
    # has not touched it (request.data is never read here).
    return request._request, None


def _guard(request):
    if not can_manage_deployment(request.user):
        return Response(_ADMIN, status=403)
    now = int(time.time())
    window = browser_sync.POST_WINDOW
    if _bump(f"vuln:browser-post:{request.user.pk}:{now // window}", window) \
            > browser_sync.POST_LIMIT:
        return Response({"detail": "Too many posts; slow down."}, status=429,
                        headers={"Retry-After": str(window - now % window)})
    return None


def _refused(exc: Refused) -> Response:
    return Response(exc.body(), status=exc.status)


def _run_out(run) -> dict:
    out = run_dict(run)
    out["progress"] = run.progress
    return out


_SCHEMA = {
    "tags": ["vulnerabilities"],
    "request": OpenApiTypes.OBJECT,
    "responses": OpenApiResponse(response=OpenApiTypes.OBJECT),
}


@extend_schema(summary="Open or resume a browser sync run", **_SCHEMA)
@api_view(["POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def sync_start(request):
    if not can_manage_deployment(request.user):
        return Response(_ADMIN, status=403)
    via = request.data.get("via", "browser") if isinstance(request.data, dict) else None
    if via != "browser":
        return Response({"via": "Only browser runs start here; server mode uses Refresh "
                                "now and upload mode Import file."}, status=400)
    try:
        run = browser_sync.start(request.user)
    except Refused as exc:
        return _refused(exc)
    return Response(_run_out(run), status=200)


@extend_schema(summary="Post one NVD CVE API page (browser sync)", **_SCHEMA)
@api_view(["POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def sync_nvd(request, run_id):
    if (r := _guard(request)) is not None:
        return r
    body, r = _body(request, browser_sync.NVD_POST_MAX)
    if r is not None:
        return r
    try:
        return Response(browser_sync.ingest_nvd(
            run_id, request.user, request.query_params.get("product", ""),
            request.query_params.get("start_index"), body))
    except Refused as exc:
        return _refused(exc)


@extend_schema(summary="The EPSS batches of a browser sync run", **_SCHEMA)
@api_view(["POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def sync_epss_plan(request, run_id):
    if (r := _guard(request)) is not None:
        return r
    try:
        return Response(browser_sync.epss_plan(run_id, request.user))
    except Refused as exc:
        return _refused(exc)


@extend_schema(summary="Post one FIRST EPSS answer (browser sync)", **_SCHEMA)
@api_view(["POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def sync_epss(request, run_id):
    if (r := _guard(request)) is not None:
        return r
    body, r = _body(request, browser_sync.EPSS_POST_MAX)
    if r is not None:
        return r
    try:
        return Response(browser_sync.ingest_epss(
            run_id, request.user, request.query_params.get("batch"), body))
    except Refused as exc:
        return _refused(exc)


@extend_schema(summary="Post the OSV advisory ids found (browser sync)", **_SCHEMA)
@api_view(["POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def sync_osv_ids(request, run_id):
    if (r := _guard(request)) is not None:
        return r
    body, r = _body(request, browser_sync.OSV_IDS_POST_MAX)
    if r is not None:
        return r
    try:
        return Response(browser_sync.osv_ids(run_id, request.user, body))
    except Refused as exc:
        return _refused(exc)


@extend_schema(summary="Post OSV records (browser sync)", **_SCHEMA)
@api_view(["POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def sync_osv(request, run_id):
    if (r := _guard(request)) is not None:
        return r
    body, r = _body(request, browser_sync.OSV_POST_MAX)
    if r is not None:
        return r
    try:
        return Response(browser_sync.ingest_osv(run_id, request.user, body))
    except Refused as exc:
        return _refused(exc)


@extend_schema(summary="Finish or stop a browser sync run", **_SCHEMA)
@api_view(["POST"])
@authentication_classes([SessionAuthentication])
@permission_classes([IsAuthenticated])
def sync_finish(request, run_id):
    if not can_manage_deployment(request.user):
        return Response(_ADMIN, status=403)
    data = request.data if isinstance(request.data, dict) else {}
    errors = data.get("errors") or []
    if not isinstance(errors, list):
        return Response({"errors": "A list of messages."}, status=400)
    try:
        run = browser_sync.finish(run_id, request.user, client_errors=errors,
                                  stop=data.get("stop") is True)
    except Refused as exc:
        return _refused(exc)
    return Response(_run_out(run))
