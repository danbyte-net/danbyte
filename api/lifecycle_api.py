"""The Lifecycle page (#436): every device and virtual machine against the end
dates that matter to it - one row per object per source, soonest first.

``GET /api/lifecycle/`` reads three sources:

* ``hardware`` - a device's type: its release date to its end of support;
* ``os`` - a device's or a VM's own platform, by its effective date: what was
  entered, else its end-of-life mapping while that feature is on
  (``compliance.eol.effective_dates``);
* ``coverage`` - a device's support coverage: its contract with the latest
  end, else its warranty (``api.support_coverage``).

``application`` is accepted and lists nothing yet: installed software is a
source still to come.

Every source is cut to what the caller may view. Devices and VMs come
through ``rbac.restrict_queryset`` (site scope included); a source whose
object type the caller cannot view is left out, not refused. A contract
number shows only on a contract the caller may view, else the row reads
``Contract`` - the device's coverage end itself is a device fact. The rows
come from a fixed number of ``values()`` queries, however large the fleet.

Days left, the window and the status are worked out here, in the rules the
rest of Danbyte reads (``compliance.eol.date_status``,
``support_coverage.status_for``), so the page agrees with the badges.
"""
from __future__ import annotations

import uuid
from datetime import date
from types import SimpleNamespace

from django.contrib.contenttypes.models import ContentType
from django.db.models import CharField
from django.db.models.functions import Cast
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac
from compliance.eol import config_for, date_status, effective_dates
from core.models import Tag, TaggedItem

from . import support_coverage as cov
from .models import Device, SupportContract, VirtualMachine
from .views import _get_active_tenant

SOURCES = ("hardware", "os", "coverage", "application")

#: The windows every source is bucketed into - fixed, not the settings, so
#: the page compares sources on one scale. ``none`` has no date.
WINDOWS = ("past", "d90", "d180", "y1", "later", "none")
_RANK = {w: i for i, w in enumerate(WINDOWS)}
_SOURCE_RANK = {s: i for i, s in enumerate(SOURCES)}

_COMMON_FIELDS = ("name", "site__name", "role__name", "role__color")
_PLATFORM_FIELDS = (
    "platform__name", "platform__release_date", "platform__end_of_support",
    "platform__eol_mapping__source", "platform__eol_mapping__release_date",
    "platform__eol_mapping__eol_date", "platform__eol_mapping__eol_reached",
    "platform__eol_mapping__synced_at",
)


def _ids(**paths) -> dict:
    """uuid columns as text, read straight into the answer: building and
    stringifying a UUID object per column per row was a fifth of a
    10,000-device answer."""
    return {alias: Cast(path, output_field=CharField()) for alias, path in paths.items()}


_COMMON_IDS = {"oid": "id", "site_ref": "site_id", "role_ref": "role_id"}
_PLATFORM_IDS = {"platform_ref": "platform_id"}


def window_of(days_left: int | None, past: bool, undated: str = "none") -> str:
    """The bucket of an end ``days_left`` away. ``undated`` is the bucket of
    a row with no date but a known state: a cycle its source marks end of
    life is ``past``, an open-ended contract or a maintained cycle ``later``."""
    if days_left is None:
        return undated
    if past:
        return "past"
    if days_left <= 90:
        return "d90"
    if days_left <= 180:
        return "d180"
    if days_left <= 365:
        return "y1"
    return "later"


def _parse_sources(raw: str | None) -> list[str]:
    wanted = [s.strip() for s in (raw or "").split(",") if s.strip()]
    bad = [s for s in wanted if s not in SOURCES]
    if bad:
        raise ValidationError({"source": f"One of {', '.join(SOURCES)}."})
    return wanted or list(SOURCES)


def _parse_site(raw: str | None):
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise ValidationError({"site": "A valid UUID."}) from None


def _tags(model, ids) -> dict:
    """``{object id: [tag, …]}`` for the rows of ``ids`` (a values() queryset
    of their pks) - one query for every row, one dict per tag."""
    out: dict = {}
    tags: dict = {}
    rows = (
        TaggedItem.objects.filter(
            content_type=ContentType.objects.get_for_model(model), object_id__in=ids
        )
        .values("tag_id", "tag__name", "tag__slug", "tag__color", **_ids(oid="object_id"))
        .order_by("tag__name")
    )
    for r in rows:
        tag = tags.get(r["tag_id"])
        if tag is None:
            tag = tags[r["tag_id"]] = {
                "id": r["tag_id"], "name": r["tag__name"], "slug": r["tag__slug"],
                "color": r["tag__color"],
                "text_color": Tag(color=r["tag__color"]).text_color,
            }
        out.setdefault(r["oid"], []).append(tag)
    return out


#: A coverage row whose end is the warranty's, or a contract the caller may
#: not view - named for what it is, no more.
_WARRANTY = {"type": "warranty", "id": None, "name": "Warranty"}
_HIDDEN_CONTRACT = {"type": "supportcontract", "id": None, "name": "Contract"}


class _Rows:
    """The rows of one request: what every row shares, and how one is made.

    A site, a role, a device type's or platform's item and a platform's
    effective dates are made once and shared by every row naming them: tens
    of thousands of rows, a few hundred distinct catalog objects."""

    def __init__(self, tenant, today: date, eol_cfg, coverage_days: int):
        self.today = today
        self.eol = eol_cfg
        self.coverage_days = coverage_days
        self.tenant = {"id": str(tenant.id), "name": tenant.name}
        self.out: list[dict] = []
        self.counts = dict.fromkeys(WINDOWS, 0)
        self._shared: dict = {}

    def shared(self, key, build):
        """The one value for ``key``, built on first use."""
        got = self._shared.get(key)
        if got is None:
            got = self._shared[key] = build()
        return got

    def ref(self, kind: str, ref: str | None, **fields) -> dict | None:
        """The one ``{"id": ref, **fields}`` of a catalog object (``None``
        without one) - a site, a role, a device type's item."""
        if not ref:
            return None
        key = (kind, ref)
        got = self._shared.get(key)
        if got is None:
            got = self._shared[key] = {"id": ref, **fields}
        return got

    def add(self, obj: dict, source: str, item, status: str, start, end,
            past: bool, undated: str = "none") -> None:
        days_left = (end - self.today).days if end is not None else None
        window = window_of(days_left, past, undated)
        self.counts[window] += 1
        self.out.append({
            **obj, "source": source, "item": item, "status": status,
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
            "days_left": days_left, "window": window,
        })

    def os_row(self, obj: dict, r: dict) -> None:
        ref = r["platform_ref"]

        def effective():
            mapping = SimpleNamespace(
                source=r["platform__eol_mapping__source"],
                release_date=r["platform__eol_mapping__release_date"],
                eol_date=r["platform__eol_mapping__eol_date"],
                eol_reached=r["platform__eol_mapping__eol_reached"],
                synced_at=r["platform__eol_mapping__synced_at"],
            )
            e = effective_dates(r["platform__release_date"], r["platform__end_of_support"],
                                mapping, self.eol.enabled)
            item = {"type": "platform", "id": ref, "name": r["platform__name"],
                    "date_source": e.source}
            return e, item

        e, item = self.shared(("platform", ref), effective)
        self.add(
            obj, "os", item,
            date_status(e.end, self.eol.warning_days, self.today, e.eol_reached),
            e.start, e.end, e.end is not None and e.end <= self.today,
            {True: "past", False: "later"}.get(e.eol_reached, "none"),
        )


def _object(rows: _Rows, kind: str, r: dict, tags: dict, manufacturer=None) -> dict:
    """What every row of one device or VM shares."""
    return {
        "object": {"id": r["oid"], "name": r["name"], "kind": kind},
        "site": rows.ref("site", r["site_ref"], name=r["site__name"]),
        "role": rows.ref("role", r["role_ref"], name=r["role__name"],
                         color=r["role__color"]),
        "tenant": rows.tenant,
        "manufacturer": manufacturer,
        "tags": tags.get(r["oid"], []),
    }


def _devices(rows: _Rows, devices, sources: list[str], user, tenant) -> None:
    fields = [*_COMMON_FIELDS, "device_type__name", "device_type__release_date",
              "device_type__end_of_support", "device_type__manufacturer__name"]
    ids = {**_COMMON_IDS, "type_ref": "device_type_id",
           "mfr_ref": "device_type__manufacturer_id"}
    if "os" in sources:
        fields += _PLATFORM_FIELDS
        ids.update(_PLATFORM_IDS)
    coverage = "coverage" in sources
    exprs = _ids(**ids)
    if coverage:
        fields += ["warranty_end", "cov_contract_end"]
        exprs["cov_contract"] = Cast(cov.governing_contract_subquery(),
                                     output_field=CharField())
        devices_qs = devices.annotate(cov_contract_end=cov.contract_end_subquery())
    else:
        devices_qs = devices
    data = list(devices_qs.order_by().values(*fields, **exprs))
    tags = _tags(Device, devices.values("pk"))

    # The governing contracts the caller may view: their numbers and starts.
    contracts: dict = {}
    wanted = {r["cov_contract"] for r in data if coverage and r["cov_contract"]}
    if wanted and rbac.has_action(user, tenant, "supportcontract", "view"):
        contracts = {
            str(c["id"]): c for c in rbac.restrict_queryset(
                SupportContract.objects.filter(tenant=tenant, pk__in=wanted),
                user, tenant, "supportcontract", "view",
            ).values("id", "contract_number", "start_date")
        }

    today, eol = rows.today, rows.eol
    for r in data:
        obj = _object(rows, "device", r, tags, rows.ref(
            "manufacturer", r["mfr_ref"], name=r["device_type__manufacturer__name"]))
        if "hardware" in sources and r["type_ref"]:
            end = r["device_type__end_of_support"]
            rows.add(
                obj, "hardware",
                rows.ref("devicetype", r["type_ref"], type="devicetype",
                         name=r["device_type__name"]),
                date_status(end, eol.warning_days, today),
                r["device_type__release_date"], end, end is not None and end <= today,
            )
        if "os" in sources and r["platform_ref"]:
            rows.os_row(obj, r)
        if coverage:
            _coverage_row(rows, obj, r, contracts)


def _coverage_row(rows: _Rows, obj: dict, r: dict, contracts: dict) -> None:
    contract_end, warranty = r["cov_contract_end"], r["warranty_end"]
    raw_end = cov.coverage_end(contract_end, warranty)
    governed = cov.governed_by(contract_end, warranty)
    item, start = None, None
    if governed == "warranty":
        item = _WARRANTY
    elif governed == "contract":
        c = contracts.get(r["cov_contract"])
        item = rows.ref("contract", r["cov_contract"], type="supportcontract",
                        name=c["contract_number"]) if c else _HIDDEN_CONTRACT
        start = c["start_date"] if c else None
    end = cov.public_end(raw_end)
    rows.add(
        obj, "coverage", item,
        cov.status_for(raw_end, rows.coverage_days, rows.today),
        start, end, end is not None and end < rows.today,
        "later" if raw_end == cov.OPEN_ENDED else "none",
    )


def _vms(rows: _Rows, vms) -> None:
    data = list(vms.order_by().values(
        *_COMMON_FIELDS, *_PLATFORM_FIELDS, **_ids(**_COMMON_IDS, **_PLATFORM_IDS)))
    tags = _tags(VirtualMachine, vms.values("pk"))
    for r in data:
        if r["platform_ref"]:
            rows.os_row(_object(rows, "virtualmachine", r, tags), r)


def _sort_key(row: dict):
    days = row["days_left"]
    if days is None:
        days = float("-inf") if row["window"] == "past" else float("inf")
    return (_RANK[row["window"]], days, row["object"]["name"], _SOURCE_RANK[row["source"]])


@extend_schema(
    summary="Devices and virtual machines by the end dates that matter to them",
    tags=["devices"],
    parameters=[
        OpenApiParameter(
            "source", OpenApiTypes.STR, OpenApiParameter.QUERY,
            description="Comma-separated: hardware, os, coverage, application. "
                        "Default: all.",
        ),
        OpenApiParameter("site", OpenApiTypes.UUID, OpenApiParameter.QUERY),
        OpenApiParameter(
            "undated", OpenApiTypes.BOOL, OpenApiParameter.QUERY,
            description="1 also lists the rows with no end date; they are "
                        "counted either way.",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{results: [{object: {id, name, kind}, source, item, status, "
                    "start, end, days_left, window, site, role, tenant, manufacturer, "
                    "tags}], counts: {past, d90, d180, y1, later, none}, windows: "
                    "{eol_warning_days, coverage_warning_days}, eol_enabled}",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def lifecycle_overview(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    params = request.query_params
    sources = _parse_sources(params.get("source"))
    site = _parse_site(params.get("site"))
    undated = params.get("undated") in ("1", "true")
    user = request.user

    eol_cfg = config_for(request)
    rows = _Rows(tenant, timezone.localdate(), eol_cfg, cov.warning_days_for(request, tenant))

    device_sources = [s for s in sources if s in ("hardware", "os", "coverage")]
    if device_sources and rbac.has_action(user, tenant, "device", "view"):
        devices = rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant), user, tenant, "device", "view"
        )
        if site:
            devices = devices.filter(site_id=site)
        _devices(rows, devices, device_sources, user, tenant)
    if "os" in sources and rbac.has_action(user, tenant, "virtualmachine", "view"):
        vms = rbac.restrict_queryset(
            VirtualMachine.objects.filter(tenant=tenant), user, tenant, "virtualmachine", "view"
        )
        if site:
            vms = vms.filter(site_id=site)
        _vms(rows, vms)

    results = rows.out if undated else [r for r in rows.out if r["window"] != "none"]
    results.sort(key=_sort_key)
    return Response({
        "results": results,
        "counts": rows.counts,
        "windows": {
            "eol_warning_days": eol_cfg.warning_days,
            "coverage_warning_days": rows.coverage_days,
        },
        "eol_enabled": eol_cfg.enabled,
    })
