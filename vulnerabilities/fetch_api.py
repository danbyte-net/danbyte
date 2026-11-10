"""Server-mode endpoints (#451), deployment admin only.

* ``POST /api/vulnerabilities/refresh/``     start (or resume) a server fetch
  now, in the background; answers the run (202).
* ``GET /api/vulnerabilities/cpe/search/?q=`` CPE names for the mapping
  picker: vendor:product pairs already in the store, a typed ``cpe:2.3:``
  name checked for syntax, and - in server mode only - NVD's CPE dictionary
  (``keywordSearch``), cached 24 hours and rate limited.
"""
from __future__ import annotations

import time

from django.core.cache import cache
from django.db.models import Count, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import can_manage_deployment

from . import fetch
from .api import run_dict
from .identifiers import cpe_product
from .models import CveProduct, VulnerabilitySettings

_OFF = {"detail": "Vulnerability data is off."}
_ADMIN = {"detail": "users.manage required."}

CPE_CACHE_TTL = 24 * 3600
#: Searches per user per minute (local and remote together).
USER_LIMIT = 30
#: Remote (NVD) lookups per rolling 30 s for the whole deployment, kept well
#: under NVD's own limit so the picker never starves a running sync.
NVD_BUDGET = 2
NVD_BUDGET_KEY = 20
Q_MIN, Q_MAX = 2, 100
LOCAL_MAX = 25


@extend_schema(
    summary="Fetch vulnerability data from this server now (server mode)",
    tags=["vulnerabilities"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def vulnerability_refresh(request):
    if not can_manage_deployment(request.user):
        return Response(_ADMIN, status=403)
    row = VulnerabilitySettings.load()
    if not row.enabled:
        return Response(_OFF, status=409)
    if row.update_source != "server":
        return Response({"update_source": "Refresh fetches only with update source server."},
                        status=409)
    try:
        run = fetch.start_run(request.user)
    except fetch.Busy as exc:
        return Response({"detail": str(exc)}, status=409)
    except (fetch.Off, fetch.FetchError) as exc:
        return Response({"detail": str(exc)}, status=409)
    try:
        fetch.enqueue(run)
    except Exception:  # noqa: BLE001 - the run is already marked failed
        return Response({"detail": "The job queue is not reachable."}, status=503)
    run.refresh_from_db()
    return Response(run_dict(run), status=202)


def _bump(key: str, window: int) -> int:
    cache.add(key, 0, window * 2)
    try:
        return cache.incr(key)
    except ValueError:  # expired between add and incr
        cache.set(key, 1, window * 2)
        return 1


def _local(q: str, parsed) -> list[dict]:
    qs = CveProduct.objects.filter(kind="cpe")
    if parsed is not None:
        part, vendor, product = parsed
        qs = qs.filter(part=part, vendor=vendor, product=product)
    else:
        for token in q.lower().replace(":", " ").split()[:5]:
            qs =qs.filter(Q(vendor__icontains=token) | Q(product__icontains=token))
    rows = (qs.values("part", "vendor", "product")
            .annotate(cves=Count("cve_id", distinct=True))
            .order_by("-cves", "vendor", "product")[:LOCAL_MAX])
    return [{**r, "cpe": f"cpe:2.3:{r['part']}:{r['vendor']}:{r['product']}"} for r in rows]


@extend_schema(
    summary="Search CPE names for a product mapping",
    tags=["vulnerabilities"],
    parameters=[OpenApiParameter("q", str, description="Words, or a cpe:2.3: name")],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def vulnerability_cpe_search(request):
    """``remote`` is ``ok``, ``cached``, ``off`` (not server mode: NVD is not
    asked), ``limited`` (try again in ``retry_after`` seconds) or ``error``."""
    if not can_manage_deployment(request.user):
        return Response(_ADMIN, status=403)
    row = VulnerabilitySettings.load()
    if not row.enabled:
        return Response(_OFF, status=409)
    q = " ".join(str(request.query_params.get("q") or "").split())
    if not Q_MIN <= len(q) <= Q_MAX:
        return Response({"q": f"Between {Q_MIN} and {Q_MAX} characters."}, status=400)
    now = int(time.time())
    if _bump(f"vuln:cpe-search:user:{request.user.pk}:{now // 60}", 60) > USER_LIMIT:
        return Response({"detail": "Too many searches; wait a minute."}, status=429,
                        headers={"Retry-After": str(60 - now % 60)})
    typed = None
    parsed = None
    if q.lower().startswith("cpe:"):
        parsed = cpe_product(q)
        if parsed is None:
            return Response({"q": "Not a CPE 2.3 name (cpe:2.3:part:vendor:product:…)."},
                            status=400)
        part, vendor, product = parsed
        typed = {"part": part, "vendor": vendor, "product": product,
                 "cpe": f"cpe:2.3:{part}:{vendor}:{product}"}
    out = {"query": q, "typed": typed, "local": _local(q, parsed), "remote": [],
           "remote_status": "off", "remote_error": ""}
    if typed is not None or not fetch.server_mode(row):
        return Response(out)
    try:
        cfg = fetch.config(row)
    except (fetch.Off, fetch.FetchError) as exc:
        out.update(remote_status="error", remote_error=str(exc))
        return Response(out)
    key = fetch.cpe_cache_key(cfg, q)
    hit = cache.get(key)
    if hit is not None:
        out.update(remote=hit, remote_status="cached")
        return Response(out)
    budget = NVD_BUDGET_KEY if cfg.api_key else NVD_BUDGET
    if _bump(f"vuln:cpe-search:nvd:{now // 30}", 30) > budget:
        out.update(remote_status="limited", retry_after=30 - now % 30)
        return Response(out)
    try:
        rows = fetch.search_cpes(cfg, q)
    except (fetch.FetchError, ValueError) as exc:
        out.update(remote_status="error", remote_error=str(exc)[:300])
        return Response(out)
    cache.set(key, rows, CPE_CACHE_TTL)
    out.update(remote=rows, remote_status="ok")
    return Response(out)
