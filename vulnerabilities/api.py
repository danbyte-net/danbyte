"""Vulnerability data endpoints (#451), deployment-wide.

* ``GET/PATCH /api/vulnerabilities/settings/``   on/off, update source,
  mirror URLs, NVD API key (write-only), last run. Everyone signed in reads
  ``enabled``; the rest, and every write, is deployment-admin
  (``can_manage_deployment``).
* ``POST /api/vulnerabilities/import/``          upload a file (multipart
  ``file`` + ``kind``); parsed by a background job, answers the run (202).
* ``GET /api/vulnerabilities/sync/<run>/``       one run, for polling (a
  browser run with its progress).

The browser-sync posts are in :mod:`vulnerabilities.browser_api`.

No endpoint here makes an outbound request.
"""
from __future__ import annotations

from django.db.models import Count, Max
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, parser_classes, permission_classes
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api.permissions import can_manage_deployment

from . import imports
from .models import (
    UPDATE_SOURCES,
    Cve,
    CveProduct,
    MsrcMonth,
    SyncRun,
    VulnerabilitySettings,
)

_OFF = {"detail": "Vulnerability data is off."}
_ADMIN = {"detail": "users.manage required."}
_URL_FIELDS = ("nvd_url", "epss_url", "kev_url", "osv_url", "msrc_url")
_BOOL_FIELDS = ("enabled", "sync_epss", "sync_kev", "sync_msrc")
_SOURCES = tuple(k for k, _ in UPDATE_SOURCES)
_KEY_MAX = 128


def run_dict(run: SyncRun | None) -> dict | None:
    if run is None:
        return None
    return {
        "id": str(run.pk),
        "via": run.via,
        "status": run.status,
        "started_at": run.started_at,
        "finished_at": run.finished_at,
        "started_by": run.started_by.get_username() if run.started_by_id else None,
        "plan": run.plan,
        "counts": run.counts,
        "error": run.error,
    }


def _msrc_status() -> dict:
    """Microsoft's monthly documents in the store: how many, the newest and
    when one was last read."""
    agg = MsrcMonth.objects.aggregate(n=Count("id"), read=Max("read_at"))
    newest = MsrcMonth.objects.order_by("-starts_on").values_list("month", flat=True).first()
    return {"months": agg["n"], "newest": newest, "last_read_at": agg["read"]}


def _settings_dict(row: VulnerabilitySettings, *, full: bool) -> dict:
    out = {"enabled": row.enabled}
    if not full:
        return out
    by_kind = dict(CveProduct.objects.values_list("kind").annotate(n=Count("cve_id",
                                                                         distinct=True)))
    last = SyncRun.objects.select_related("started_by").order_by("-started_at").first()
    out.update({
        "update_source": row.update_source,
        "update_sources": list(_SOURCES),
        **{f: getattr(row, f) for f in _URL_FIELDS},
        "sync_epss": row.sync_epss,
        "sync_kev": row.sync_kev,
        "sync_msrc": row.sync_msrc,
        "msrc": _msrc_status(),
        "nvd_api_key_set": bool((row.secrets or {}).get("nvd_api_key")),
        "last_sync_at": row.last_sync_at,
        "last_sync_status": row.last_sync_status,
        "last_sync_error": row.last_sync_error,
        "last_sync_via": row.last_sync_via,
        "last_run": run_dict(last),
        "records": Cve.objects.count(),
        "records_by_kind": {"cpe": by_kind.get("cpe", 0), "purl": by_kind.get("purl", 0),
                            "msrc": by_kind.get("msrc", 0)},
        "import_kinds": list(imports.KINDS),
        "import_max_bytes": imports.max_upload_bytes(),
        "can_manage": True,
    })
    return out


def _validate(data) -> tuple[dict, dict, dict]:
    """``(clean fields, secret changes, errors)``."""
    errors, clean, secrets = {}, {}, {}
    if not isinstance(data, dict):
        return {}, {}, {"detail": "A JSON object."}
    for f in _BOOL_FIELDS:
        if f in data:
            if isinstance(data[f], bool):
                clean[f] = data[f]
            else:
                errors[f] = "true or false."
    if "update_source" in data:
        if data["update_source"] in _SOURCES:
            clean["update_source"] = data["update_source"]
        else:
            errors["update_source"] = f"Pick one of: {', '.join(_SOURCES)}."
    for f in _URL_FIELDS:
        if f not in data:
            continue
        v = data[f]
        if v is None:
            v = ""
        if not isinstance(v, str):
            errors[f] = "A URL or blank."
            continue
        v = v.strip()
        if v and not v.lower().startswith("https://"):
            errors[f] = "A mirror URL must use https."
        elif len(v) > 255:
            errors[f] = "At most 255 characters."
        elif any(c.isspace() for c in v):
            errors[f] = "A URL has no spaces."
        else:
            clean[f] = v.rstrip("/")
    if "nvd_api_key" in data:
        v = data["nvd_api_key"]
        if not isinstance(v, str) or len(v) > _KEY_MAX:
            errors["nvd_api_key"] = f"A key of at most {_KEY_MAX} characters."
        elif v.strip():
            # Blank leaves the stored key alone (the form need not re-enter it).
            secrets["nvd_api_key"] = v.strip()
    if data.get("nvd_api_key_clear") is True:
        secrets["nvd_api_key"] = None
    return clean, secrets, errors


@extend_schema(
    summary="Vulnerability data settings (deployment-wide)",
    tags=["vulnerabilities"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET", "PATCH"])
@permission_classes([IsAuthenticated])
def vulnerability_settings(request):
    """The NVD API key is write-only: reads say ``nvd_api_key_set``; a blank
    ``nvd_api_key`` keeps the stored one, ``nvd_api_key_clear: true`` drops
    it."""
    row = VulnerabilitySettings.load()
    admin = can_manage_deployment(request.user)
    if request.method == "GET":
        return Response(_settings_dict(row, full=admin))
    if not admin:
        return Response(_ADMIN, status=403)
    clean, secrets, errors = _validate(request.data)
    if errors:
        return Response(errors, status=400)
    switched_on = clean.get("enabled") is True and not row.enabled
    for k, v in clean.items():
        setattr(row, k, v)
    if switched_on:
        # Matches were not kept up while the feature was off.
        from django.db import transaction

        from .jobs import enqueue_all

        transaction.on_commit(enqueue_all)
    if secrets:
        merged = dict(row.secrets or {})
        for k, v in secrets.items():
            if v is None:
                merged.pop(k, None)
            else:
                merged[k] = v
        row.secrets = merged
    if clean or secrets:
        row.save()
    return Response(_settings_dict(row, full=True))


@extend_schema(
    summary="Import vulnerability data from an uploaded file (background)",
    tags=["vulnerabilities"],
    request=OpenApiTypes.OBJECT,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@parser_classes([MultiPartParser, FormParser])
def vulnerability_import(request):
    """Multipart ``file`` + ``kind`` (``nvd``/``osv``/``kev``/``epss``)."""
    if not can_manage_deployment(request.user):
        return Response(_ADMIN, status=403)
    row = VulnerabilitySettings.load()
    if not row.enabled:
        return Response(_OFF, status=409)
    # Refuse an oversized body by its declared length (nginx caps it too).
    try:
        length = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    limit = imports.max_upload_bytes()
    if length > limit + 64 * 1024:
        return Response({"file": f"The file is larger than {limit // (1024 * 1024)} MB."},
                        status=413)
    upload = request.FILES.get("file")
    if upload is None:
        return Response({"file": "Upload the file as `file`."}, status=400)
    kind = str(request.data.get("kind") or "")
    try:
        run = imports.start_upload(request.user, upload, kind)
        imports.enqueue(run)
    except imports.ImportRefused as exc:
        return Response({exc.field: str(exc)}, status=exc.status)
    run.refresh_from_db()
    return Response(run_dict(run), status=202)


@extend_schema(
    summary="One vulnerability data run",
    tags=["vulnerabilities"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def vulnerability_sync_run(request, run_id):
    if not can_manage_deployment(request.user):
        return Response(_ADMIN, status=403)
    run = SyncRun.objects.select_related("started_by").filter(pk=run_id).first()
    if run is None:
        return Response({"detail": "Not found."}, status=404)
    out = run_dict(run)
    if run.via == "browser":
        # The sync page resumes from it (posted start_index values).
        out["progress"] = run.progress
    return Response(out)
