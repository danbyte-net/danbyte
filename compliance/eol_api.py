"""End-of-life data endpoints (#8).

Deployment-wide (``can_manage_deployment``):

* ``GET/PATCH /api/eol/settings/``  on/off, sources, warning window, status
* ``POST /api/eol/refresh/``         fetch now (background job)
* ``POST /api/eol/import/``          offline: upload the catalog JSON

Per tenant, on the platform permissions:

* ``GET /api/eol/products/``                     search the cached catalog
                                                 (``?q=``, ``?platform=`` adds
                                                 suggestions)
* ``GET /api/eol/products/<source>/<name>/``     one product's cycles
* ``GET/PUT/DELETE /api/eol/platforms/<id>/``    a platform's mapping

Every tenant endpoint answers 404 while the feature is off.
"""
from __future__ import annotations

from datetime import timedelta

from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.views import _get_active_tenant
from auth_api import rbac
from auth_api.permissions import can_manage_deployment

from . import eol
from .eol_sources import SOURCES, EolSourceError
from .models import EolMapping, EolProduct, EolSettings

_OFF = {"detail": "End-of-life data is off."}
_SEARCH_LIMIT = 50
_JOB_TIMEOUT = 600
#: The picker loads the whole catalog (names only) and filters as you type.
_MAX_LIMIT = 2000


def _settings_dict(row: EolSettings, *, full: bool) -> dict:
    out = {"enabled": row.enabled, "warning_days": row.warning_days}
    if not full:
        return out
    out.update({
        "sources": list(row.sources or []),
        "source_urls": dict(row.source_urls or {}),
        "available_sources": eol.known_sources(),
        "last_refresh_at": row.last_refresh_at,
        "last_refresh_status": row.last_refresh_status,
        "last_refresh_error": row.last_refresh_error,
        "last_refresh_via": row.last_refresh_via,
        "products": EolProduct.objects.count(),
        "mappings": EolMapping.objects.count(),
        "can_manage": True,
    })
    return out


def _validate_settings(data: dict, row: EolSettings) -> dict:
    errors, clean = {}, {}
    if "enabled" in data:
        if not isinstance(data["enabled"], bool):
            errors["enabled"] = "true or false."
        else:
            clean["enabled"] = data["enabled"]
    if "warning_days" in data:
        v = data["warning_days"]
        if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 3650:
            errors["warning_days"] = "A whole number of days, 0 to 3650."
        else:
            clean["warning_days"] = v
    if "sources" in data:
        v = data["sources"]
        if not isinstance(v, list) or any(s not in SOURCES for s in v):
            errors["sources"] = f"Pick from: {', '.join(SOURCES)}."
        else:
            clean["sources"] = list(dict.fromkeys(v))
    if "source_urls" in data:
        v = data["source_urls"]
        if not isinstance(v, dict) or any(k not in SOURCES for k in v):
            errors["source_urls"] = "Keys must be source keys."
        else:
            urls = {}
            for k, url in v.items():
                url = str(url or "").strip()
                if url and not url.lower().startswith("https://"):
                    errors["source_urls"] = "A source URL must use https."
                elif url:
                    urls[k] = url.rstrip("/")[:255]
            clean["source_urls"] = urls
    if errors:
        return {"errors": errors}
    return {"clean": clean}


@extend_schema(
    summary="End-of-life data settings (deployment-wide)",
    tags=["compliance"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def eol_settings(request):
    """Everyone signed in reads ``enabled`` + ``warning_days`` (the UI shows
    the columns by them); the rest, and every write, is deployment-admin."""
    row = EolSettings.load()
    admin = can_manage_deployment(request.user)
    if request.method == "GET":
        return Response(_settings_dict(row, full=admin))
    if not admin:
        return Response({"detail": "users.manage required."}, status=403)
    result = _validate_settings(request.data or {}, row)
    if "errors" in result:
        return Response(result["errors"], status=400)
    clean = result["clean"]
    for k, v in clean.items():
        setattr(row, k, v)
    if row.enabled and not row.sources and "sources" not in clean:
        # Turning it on with nothing picked starts from the first source.
        row.sources = [next(iter(SOURCES))]
    row.save()
    return Response(_settings_dict(row, full=True))


def run_refresh_job() -> None:
    """RQ entry point for Refresh now. Never raises - the outcome lands on
    the settings row."""
    try:
        eol.refresh()
    except Exception as exc:  # noqa: BLE001
        eol._set_status("failed", error=str(exc))


@extend_schema(
    summary="Fetch end-of-life data now (background)",
    tags=["compliance"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def eol_refresh(request):
    if not can_manage_deployment(request.user):
        return Response({"detail": "users.manage required."}, status=403)
    row = EolSettings.load()
    if not row.enabled:
        return Response(_OFF, status=409)
    if not row.sources:
        return Response({"detail": "Pick a source first."}, status=400)
    # A run that has said nothing for longer than the job timeout is dead (a
    # worker killed mid-run); it must not block Refresh now for good.
    fresh = row.updated_at > timezone.now() - timedelta(seconds=_JOB_TIMEOUT * 2)
    if row.last_refresh_status in ("queued", "running") and fresh:
        return Response({"detail": "A refresh is already running."}, status=409)
    try:
        import django_rq

        django_rq.get_queue("low").enqueue(run_refresh_job, job_timeout=_JOB_TIMEOUT)
    except Exception:  # noqa: BLE001 - Redis down: say so, do not fetch inline
        return Response({"detail": "The job queue is not reachable."}, status=503)
    eol._set_status("queued")
    row.refresh_from_db()
    return Response(_settings_dict(row, full=True), status=202)


@extend_schema(
    summary="Import end-of-life data from a downloaded catalog file",
    tags=["compliance"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser])
def eol_import(request):
    """Multipart ``file`` (+ optional ``source``, default the first source):
    the JSON the source's API serves, saved on a machine that can reach it."""
    if not can_manage_deployment(request.user):
        return Response({"detail": "users.manage required."}, status=403)
    row = EolSettings.load()
    if not row.enabled:
        return Response(_OFF, status=409)
    upload = request.FILES.get("file")
    if upload is None:
        return Response({"file": "Upload the catalog JSON as `file`."}, status=400)
    source = str(request.data.get("source") or next(iter(SOURCES)))
    from .eol_sources import MAX_BYTES

    if upload.size > MAX_BYTES:
        return Response({"file": "The file is larger than 64 MB."}, status=400)
    try:
        result = eol.import_payload(source, upload.read())
    except EolSourceError as exc:
        return Response({"file": str(exc)}, status=400)
    return Response(result)


# ─── tenant side ─────────────────────────────────────────────────────────────


def _tenant_gate(request, action: str):
    """(tenant, None) or (None, error response)."""
    if not eol.load_config().enabled:
        return None, Response(_OFF, status=404)
    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, Response({"detail": "No active tenant selected."}, status=403)
    if not rbac.has_action(request.user, tenant, "platform", action):
        return None, Response({"detail": f"platform.{action} required."}, status=403)
    return tenant, None


def _platform(request, tenant, platform_id, action: str = "view"):
    from api.models import Platform

    qs = Platform.objects.filter(tenant=tenant).select_related("manufacturer")
    qs = rbac.restrict_queryset(qs, request.user, tenant, "platform", action)
    return qs.filter(pk=platform_id).first()


def _product_row(p: EolProduct) -> dict:
    return {"source": p.source, "name": p.name, "label": p.label,
            "category": p.category}


@extend_schema(
    summary="Search the cached end-of-life catalog",
    tags=["compliance"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def eol_products(request):
    tenant, err = _tenant_gate(request, "view")
    if err:
        return err
    from django.db.models import Q

    qs = EolProduct.objects.all().only("source", "name", "label", "category")
    source = request.query_params.get("source")
    if source:
        qs = qs.filter(source=source)
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(name__icontains=q) | Q(label__icontains=q)
                       | Q(aliases__contains=[q.lower()]))
    try:
        limit = int(request.query_params.get("limit") or _SEARCH_LIMIT)
        limit = max(1, min(limit, _MAX_LIMIT))
    except ValueError:
        limit = _SEARCH_LIMIT
    out = {"results": [_product_row(p) for p in qs.order_by("label", "name")[:limit]]}
    pid = request.query_params.get("platform")
    if pid:
        platform = _platform(request, tenant, pid)
        if platform is None:
            return Response({"detail": "Not found."}, status=404)
        catalog = EolProduct.objects.only(
            "source", "name", "label", "aliases", "releases")
        out["suggestions"] = eol.suggest_products(platform, catalog)
    return Response(out)


@extend_schema(
    summary="One cached end-of-life product with its cycles",
    tags=["compliance"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def eol_product(request, source, name):
    _tenant, err = _tenant_gate(request, "view")
    if err:
        return err
    p = EolProduct.objects.filter(source=source, name=name).first()
    if p is None:
        return Response({"detail": "Not found."}, status=404)
    return Response({**_product_row(p), "releases": p.releases})


@extend_schema(
    summary="A platform's end-of-life mapping",
    tags=["compliance"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET", "PUT", "DELETE"])
@permission_classes([IsAuthenticated])
def eol_platform_mapping(request, platform_id):
    """``PUT {source?, product, cycle}`` maps the platform; the facts come from
    the cached catalog at once. Writes need ``platform.change`` on that
    platform's row."""
    action = "view" if request.method == "GET" else "change"
    tenant, err = _tenant_gate(request, action)
    if err:
        return err
    platform = _platform(request, tenant, platform_id, action)
    if platform is None:
        return Response({"detail": "Not found."}, status=404)
    mapping = EolMapping.objects.filter(platform=platform, tenant=tenant).first()
    cfg = eol.load_config()

    if request.method == "GET":
        platform._state.fields_cache["eol_mapping"] = mapping
        return Response(eol.payload(platform, cfg))

    if request.method == "DELETE":
        if mapping is not None:
            mapping.delete()
        return Response(status=204)

    data = request.data or {}
    source = str(data.get("source") or next(iter(SOURCES)))
    product_name = str(data.get("product") or "").strip()
    cycle = str(data.get("cycle") or "").strip()
    errors = {}
    if source not in SOURCES:
        errors["source"] = "Unknown source."
    if not product_name:
        errors["product"] = "Pick a product."
    if not cycle:
        errors["cycle"] = "Pick a cycle."
    if errors:
        return Response(errors, status=400)
    product = EolProduct.objects.filter(source=source, name=product_name).first()
    if product is None:
        return Response({"product": "Not in the catalog - refresh or import it."},
                        status=400)
    if eol.find_release(product, cycle) is None:
        return Response({"cycle": f"{product.label} has no cycle '{cycle}'."},
                        status=400)
    if mapping is None:
        mapping = EolMapping(tenant=tenant, platform=platform)
    elif (mapping.source, mapping.product, mapping.cycle) != (source, product_name, cycle):
        mapping.synced_at = None
    mapping.source, mapping.product, mapping.cycle = source, product_name, cycle
    eol.fill_mapping(mapping, product)
    mapping.save()
    platform._state.fields_cache["eol_mapping"] = mapping
    return Response(eol.payload(platform, cfg))
