"""Object reports: ``GET|POST /api/devices/report/``, ``/api/prefixes/report/``
and ``/api/ips/report/``.

One PDF of devices, prefixes or IP addresses - one object from its detail
page, the rows selected on a list, or every row a list's filters match - in
the floor-plan report's print style (``api/floor_plan_report.py``): a header
block, an optional summary (counts by status, role, site…), a table of the
objects with the columns the reader picks, and optionally details for each
object with the sections the reader picks (overview, interfaces, IP
addresses…), each object starting a new page.

``GET`` answers what can go in a report of that type for this reader: the
list columns (the list page's own column catalog, ``api.list_fields``, plus
the visible custom fields), the group-by and summary keys, and each section
with its columns and whether the reader may view it. ``POST`` makes the PDF.

Everything is read through the lists the app already serves: the objects
through the type's list endpoint (its tenant fence, its RBAC row scope, its
filters - the body's ``filters`` are that list's query parameters), each
table section through its own list endpoint (``/api/interfaces/?device=…``),
each built as the list would be for this reader (``build_list_view``), so a
section the reader may not view is left out with a note and its rows are the
ones the list would show. An id the reader may not view is dropped the way
the list drops it, and never named. Nothing is written or audited.

The PDF obeys the drawing PDFs' limits (``api/drawing_pdf.py``): one render
per user and a few across the server, the render deadline, and ``?print=1``'s
five-minute link. A report lists at most ``MAX_OBJECTS`` objects and gives
details to at most ``MAX_OBJECT_PAGES``; past either it is refused (400) with
the limit. A report whose estimated render time (``estimate_seconds``: table
cells and objects with details) is past ``RENDER_BUDGET`` renders in the
background instead, as an RQ job with a longer deadline (``start_job``,
``run_report_job``; 202 and a status to poll). One estimated past that
deadline's budget is refused (400) before it renders, saying what fits; a
render that still runs past its deadline is 503 (or a failed job).
``?estimate=1`` answers the estimate without rendering, for the dialog's
live line.
A section lists at most ``MAX_SECTION_ROWS`` rows, and the whole
report ``MAX_TOTAL_ROWS``; past those a section says how many it left out.
"""

from __future__ import annotations

import copy
import datetime as dt
import hashlib
import ipaddress
import json
import logging
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from html import escape

from django.conf import settings
from django.core.cache import cache
from django.db.models import Q
from django.http import HttpResponse, QueryDict
from django.urls import reverse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.request import Request
from rest_framework.response import Response

from .drawing_pdf import (
    BASE_URL,
    BUSY_KEY,
    MAX_BODY_BYTES,
    MAX_PDF_BYTES,
    MEDIA_IMAGES_URL,
    PAPERS_MM,
    RENDER_TIMEOUT,
    TOKEN,
    PdfUrlFetcher,
    RenderTimeout,
    _font_faces,
    body_too_large,
    deliver,
    detail,
    file_name,
    flag,
    kept_pdf,
    release,
    render_guarded,
    run_with_deadline,
    stamp,
    take,
)
from .field_labels import humanize
from .floor_plan_report import _pill, _plural

log = logging.getLogger(__name__)

#: Objects a report may list, and give a page each.
MAX_OBJECTS = 2000
MAX_OBJECT_PAGES = 50
#: What a render costs, measured on WeasyPrint with the fixed table layout
#: (#474): about 1.5 ms per table cell and 50 ms per object page on a 2-vCPU
#: box. A report estimated past ``RENDER_BUDGET`` - the deadline less a
#: margin for a busier or slower server - renders in the background.
SECONDS_PER_CELL = 0.0016
SECONDS_PER_PAGE = 0.06
SECONDS_BASE = 0.5
RENDER_BUDGET = RENDER_TIMEOUT * 0.7
#: Rows one section of one object lists, and all sections together.
MAX_SECTION_ROWS = 500
MAX_TOTAL_ROWS = 20000
#: Columns one table may have.
MAX_COLUMNS = 40
#: Journal and change-log entries per object, by default and at most.
DEFAULT_LAST = 20
MAX_LAST = 200
#: Checks listed in a monitoring section.
MAX_CHECKS = 100
PAPERS = ("a4", "letter", "a3")
ORIENTATIONS = ("portrait", "landscape")
MARGIN_MM = 12.0
BOTTOM_MM = 14.0
INK = "#18181b"
# Never offered as a column: the row's plumbing.
_SKIP_KINDS = ("color",)
# Query parameters a body's ``filters`` may not set: paging, rendering and the
# pickers' lean row shapes.
_FILTER_DROP = frozenset(
    {
        "page",
        "page_size",
        "format",
        "print",
        "download",
        "picker",
        "with_vc",
        "detail",
        "fields",
        "limit",
        "offset",
    }
)
_FILTER_KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
#: The viewsets' ``rbac_action_map`` entries: a report reads, whatever its method.
RBAC_ACTIONS = {
    "report": "view",
    "report_file": "view",
    "report_job": "view",
    "report_job_file": "view",
}


# ─── The registry ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Section:
    """One part of an object's page.

    ``kind`` says how it is made: ``kv`` - attributes of the object's own
    list row (``columns`` are keys of the type's column catalog), ``table`` -
    rows of the list at ``path`` with ``params(row)`` and optionally
    ``narrow(qs, row)`` (``columns`` are keys of that list's catalog), or a
    kind of its own (``utilisation``, ``monitoring``, ``photo``). ``last``
    marks a section of the latest N entries."""

    key: str
    label: str
    kind: str
    columns: tuple[str, ...] = ()
    path: str | None = None
    params: Callable[[dict], dict] | None = None
    narrow: Callable | None = None
    custom_fields: bool = False
    last: bool = False
    default: bool = True


@dataclass(frozen=True)
class ReportType:
    slug: str
    path: str
    label: str
    plural: str
    title_key: str
    list_columns: tuple[str, ...]
    groups: tuple[str, ...]
    badges: tuple[str, ...]
    sections: tuple[Section, ...]
    file_stem: str = field(default="report")
    #: The grouping a list report gets when the request names none.
    default_group: str = ""

    def section(self, key: str) -> Section | None:
        return next((s for s in self.sections if s.key == key), None)


def _id(row) -> str:
    return str(row["id"])


def _journal(model_label):
    return Section(
        "journal",
        "Journal",
        "table",
        ("created_at", "kind", "author_name", "comments"),
        path="/api/journal/",
        last=True,
        params=lambda r: {"object_type": model_label, "object_id": _id(r)},
    )


def _history(model_label, default=False):
    return Section(
        "history",
        "Change log",
        "table",
        ("timestamp", "user_name", "action", "change_count", "via"),
        path="/api/changelog/",
        last=True,
        default=default,
        params=lambda r: {"object_type": model_label, "object_id": _id(r)},
    )


def _not_self(qs, row):
    return qs.exclude(pk=row["id"])


def _child_params(row):
    params = {"contained_in": row.get("cidr") or "0.0.0.0/32"}
    vrf = row.get("vrf")
    if isinstance(vrf, dict) and vrf.get("id"):
        params["vrf"] = vrf["id"]
    return params


def _child_narrow(qs, row):
    vrf = row.get("vrf")
    qs = qs.exclude(pk=row["id"])
    return qs.filter(vrf__isnull=True) if not vrf else qs


def _nat_narrow(qs, row):
    return qs.filter(
        Q(external_ip_id=row["id"]) | Q(internal_ip_id=row["id"]) | Q(source_ip_id=row["id"])
    )


def _dns_narrow(qs, row):
    return qs.filter(Q(ip_address_id=row["id"]) | Q(ip=row.get("ip_address") or ""))


DEVICE = ReportType(
    slug="device",
    path="/api/devices/",
    label="Device",
    plural="Devices",
    title_key="name",
    file_stem="devices",
    list_columns=(
        "name",
        "status",
        "role",
        "device_type",
        "site",
        "location",
        "rack",
        "primary_ip",
        "serial_number",
        "tags",
    ),
    groups=("status", "role", "site", "device_type", "platform", "location", "rack"),
    badges=("status", "role"),
    sections=(
        Section(
            "overview",
            "Overview",
            "kv",
            (
                "device_type",
                "device_type.manufacturer",
                "role",
                "platform",
                "site",
                "location",
                "rack",
                "position",
                "face",
                "serial_number",
                "asset_tag",
                "primary_ip",
                "oob_ip",
                "software_version",
                "description",
                "tags",
            ),
            custom_fields=True,
        ),
        Section("photo", "Photo", "photo", default=False),
        Section(
            "interfaces",
            "Interfaces",
            "table",
            (
                "name",
                "type",
                "status",
                "enabled",
                "lag",
                "mode",
                "vlan",
                "tagged_vlans",
                "ip_addresses",
                "link_peer",
            ),
            path="/api/interfaces/",
            params=lambda r: {"device": _id(r)},
        ),
        Section(
            "ip_addresses",
            "IP addresses",
            "table",
            ("ip_address", "status", "role", "assigned_interface", "dns_name", "description"),
            path="/api/ips/",
            params=lambda r: {"device": _id(r)},
        ),
        Section(
            "cables",
            "Cables",
            "table",
            ("label", "type", "status", "a_terminations", "b_terminations", "length"),
            path="/api/cables/",
            params=lambda r: {"device": _id(r)},
        ),
        Section(
            "software",
            "Installed software",
            "table",
            ("application", "version", "cycle", "end_of_support", "effective_license", "source"),
            path="/api/installed-software/",
            params=lambda r: {"device": _id(r)},
        ),
        Section(
            "power_ports",
            "Power ports",
            "table",
            ("name", "type", "maximum_draw", "allocated_draw", "cable"),
            path="/api/power-ports/",
            params=lambda r: {"device": _id(r)},
            default=False,
        ),
        Section(
            "console_ports",
            "Console ports",
            "table",
            ("name", "type", "speed", "cable"),
            path="/api/console-ports/",
            params=lambda r: {"device": _id(r)},
            default=False,
        ),
        Section(
            "lifecycle",
            "Lifecycle",
            "kv",
            (
                "effective_platform",
                "software_version",
                "software_version_source",
                "software_version_seen_at",
                "warranty_end",
                "coverage",
                "lifecycle_next",
                "device_type.end_of_support",
            ),
            default=False,
        ),
        Section("monitoring", "Monitoring", "monitoring"),
        _journal("api.device"),
        _history("api.device"),
    ),
)

PREFIX = ReportType(
    slug="prefix",
    path="/api/prefixes/",
    label="Prefix",
    plural="Prefixes",
    title_key="cidr",
    file_stem="prefixes",
    # Like the Prefixes list: Global first, then each VRF under its banner.
    default_group="vrf",
    list_columns=(
        "cidr",
        "status",
        "utilisation_pct",
        "ip_count",
        "site",
        "vlan",
        "vrf",
        "description",
        "tags",
    ),
    groups=("status", "site", "vrf", "vlan", "location"),
    badges=("status",),
    sections=(
        Section(
            "overview",
            "Overview",
            "kv",
            (
                "status",
                "site",
                "location",
                "gateway",
                "description",
                "dhcp",
                "auto_discover",
                "monitoring_engine",
                "tags",
            ),
            custom_fields=True,
        ),
        Section("utilisation", "Utilisation", "utilisation"),
        Section("vlan_vrf", "VLAN and VRF", "kv", ("vlan", "vlan.zone", "vrf")),
        Section(
            "child_prefixes",
            "Child prefixes",
            "table",
            ("cidr", "status", "utilisation_pct", "ip_count", "site", "description"),
            path="/api/prefixes/",
            params=_child_params,
            narrow=_child_narrow,
        ),
        Section(
            "ip_addresses",
            "IP addresses",
            "table",
            (
                "ip_address",
                "status",
                "role",
                "dns_name",
                "assigned_device",
                "assigned_interface",
                "description",
            ),
            path="/api/ips/",
            params=lambda r: {"prefix": _id(r)},
        ),
        Section(
            "ranges",
            "IP ranges",
            "table",
            ("start_address", "end_address", "size", "status", "role", "description"),
            path="/api/ip-ranges/",
            params=lambda r: {"prefix": _id(r)},
        ),
        Section("monitoring", "Monitoring", "monitoring", default=False),
        _journal("api.prefix"),
        _history("api.prefix"),
    ),
)

IP = ReportType(
    slug="ipaddress",
    path="/api/ips/",
    label="IP address",
    plural="IP addresses",
    title_key="ip_address",
    file_stem="ip-addresses",
    list_columns=(
        "ip_address",
        "status",
        "role",
        "dns_name",
        "prefix",
        "assigned_device",
        "assigned_interface",
        "description",
        "tags",
    ),
    groups=("status", "role", "site", "prefix", "assigned_device"),
    badges=("status", "role"),
    sections=(
        Section(
            "overview",
            "Overview",
            "kv",
            (
                "cidr",
                "status",
                "role",
                "prefix",
                "prefix.vrf",
                "site",
                "scope",
                "description",
                "reservation_note",
                "tags",
            ),
            custom_fields=True,
        ),
        Section(
            "assignment",
            "Assignment",
            "kv",
            (
                "assigned_device",
                "assigned_interface",
                "assigned_vm",
                "assigned_vm_interface",
                "switch",
                "switch_interface",
                "mac_address",
            ),
        ),
        Section(
            "nat",
            "NAT",
            "table",
            (
                "name",
                "kind",
                "protocol",
                "external_ip",
                "external_ports",
                "internal_ip",
                "internal_ports",
                "status",
            ),
            path="/api/nat-rules/",
            params=lambda r: {},
            narrow=_nat_narrow,
        ),
        Section(
            "dns",
            "DNS",
            "table",
            ("name", "record_type", "data", "zone_name", "ttl", "managed"),
            path="/api/dns-records/",
            params=lambda r: {},
            narrow=_dns_narrow,
        ),
        Section("monitoring", "Monitoring", "monitoring"),
        _journal(
            "api.ipaddress",
        ),
        _history("api.ipaddress", default=True),
    ),
)

REPORT_TYPES = {t.slug: t for t in (DEVICE, PREFIX, IP)}


# ─── Reading through the lists ──────────────────────────────────────────────


def sub_request(request, params: dict) -> Request:
    """``request`` as a GET with ``params`` for its query: what a list
    endpoint reads, for this user and tenant."""
    http = copy.copy(request._request)
    http.method = "GET"
    q = QueryDict(mutable=True)
    for k, v in params.items():
        if isinstance(v, (list, tuple)):
            q.setlist(k, [str(x) for x in v])
        elif v is not None:
            q[k] = str(v)
    http.GET = q
    sub = Request(
        http,
        parsers=request.parsers,
        authenticators=request.authenticators,
        negotiator=request.negotiator,
        parser_context=request.parser_context,
    )
    sub.user = request.user
    sub.auth = request.auth
    return sub


def list_view(request, path: str, params: dict | None = None):
    """The list at ``path`` as the reader's list request would build it, or
    None when the reader may not view it."""
    from .list_fields import build_list_view

    try:
        return build_list_view(sub_request(request, params or {}), path)
    except (PermissionDenied, NotFound):
        return None


def _model(view):
    qs = getattr(view, "queryset", None)
    if qs is not None:
        return qs.model
    meta = getattr(view.get_serializer_class(), "Meta", None)
    return getattr(meta, "model", None)


def _prepare(view, page: list) -> None:
    """What the list does to a page after paging it (the IP list's DHCP
    flags, #372)."""
    from .models import IPAddress

    if page and _model(view) is IPAddress:
        from .viewsets import attach_dhcp_flags

        attach_dhcp_flags(page)


def read_rows(view, *, limit: int, narrow=None) -> tuple[list[dict], int]:
    """At most ``limit`` rows of ``view``'s list, serialised as the list
    serialises them, and how many there are."""
    qs = view.filter_queryset(view.get_queryset())
    if narrow is not None:
        qs = narrow(qs)
    total = qs.count()
    page = list(qs[:limit]) if limit > 0 else []
    _prepare(view, page)
    return list(view.get_serializer(page, many=True).data), total


# ─── Columns ────────────────────────────────────────────────────────────────


@dataclass
class Column:
    key: str
    label: str
    kind: str
    path: str
    options: dict | None = None
    cf: dict | None = None

    def payload(self) -> dict:
        return {"key": self.key, "label": self.label}


def catalog(view, request, tenant) -> dict[str, Column]:
    """The columns of ``view``'s list - the list page's catalog - keyed,
    custom fields as ``cf.<key>``."""
    from .list_fields import catalog_for, visible_custom_fields

    body = catalog_for(view)
    out: dict[str, Column] = {}
    for f in body["fields"]:
        if f["kind"] in _SKIP_KINDS:
            continue
        opts = {o["value"]: o["label"] for o in f.get("options") or []} or None
        out[f["key"]] = Column(
            f["key"], f["label"], f["kind"], f.get("path") or f["key"], options=opts
        )
        if f.get("choices"):
            out[f["key"]].options = _choices(request).get(f["choices"])
    if body.get("cf_model") and tenant is not None:
        for cf in visible_custom_fields(request, tenant, body["cf_model"], body["slug"]):
            key = f"cf.{cf['key']}"
            out[key] = Column(key, cf["label"], "cf", cf["key"], cf=cf)
    _extra_columns(view, out)
    return out


def _extra_columns(view, out: dict) -> None:
    """Fields a row carries that the catalog leaves out but a report reads."""
    from .models import Device

    if _model(view) is Device and "lifecycle_next" not in out:
        out["lifecycle_next"] = Column(
            "lifecycle_next", "Next lifecycle date", "auto", "lifecycle_next"
        )


def _choices(request) -> dict[str, dict]:
    """``/api/dcim/choices/`` as ``{list key: {value: label}}``, once per
    request."""
    memo = getattr(request, "_report_choices", None)
    if memo is None:
        from .dcim_choices import dcim_choices_view

        try:
            data = dcim_choices_view(sub_request(request, {})._request).data
        except Exception:  # noqa: BLE001 - the stored values print instead
            data = {}
        memo = {
            k: {o["value"]: o["label"] for o in v if isinstance(o, dict) and "value" in o}
            for k, v in data.items()
            if isinstance(v, list)
        }
        request._report_choices = memo
    return memo


def pick(cat: dict[str, Column], keys, default) -> list[Column]:
    """The asked columns that exist, in the asked order; ``default`` when
    none is asked."""
    chosen = keys if keys else default
    seen, out = set(), []
    for k in chosen:
        if k in cat and k not in seen:
            seen.add(k)
            out.append(cat[k])
    return out[:MAX_COLUMNS]


def default_columns(s: Section, cat: dict[str, Column]) -> list[str]:
    """A section's columns when none are asked: its own, and every custom
    field for one that takes them."""
    keys = list(s.columns)
    if s.custom_fields:
        keys += [k for k, c in cat.items() if c.kind == "cf"]
    return keys


# ─── Cell values ────────────────────────────────────────────────────────────

_NAME_KEYS = (
    "name",
    "label",
    "display",
    "cidr",
    "ip_address",
    "prefix",
    "address",
    "mac_address",
    "cid",
    "username",
    "slug",
    "asn",
    "status",
)


def dig(row, path: str):
    cur = row
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def _name(v) -> str:
    if v is None:
        return ""
    if isinstance(v, dict):
        for k in ("resolved", "own"):
            if k in v and isinstance(v[k], dict | None):
                return _name(v[k])
        for k in _NAME_KEYS:
            if v.get(k) not in (None, "") and not isinstance(v.get(k), dict | list):
                text = str(v[k])
                parent = v.get("device")
                if isinstance(parent, dict) and parent.get("name") and k != "device":
                    return f"{parent['name']} · {text}"
                if isinstance(parent, str) and parent:
                    port = v.get("port") or text
                    return f"{parent} · {port}"
                return text
        if isinstance(v.get("device"), str):
            return " · ".join(x for x in (v.get("device"), v.get("port")) if x)
        return ""
    if isinstance(v, list):
        return ", ".join(n for n in (_name(x) for x in v) if n)
    return _scalar(v)


def _scalar(v) -> str:
    if v is None or v == "":
        return ""
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def _when(v, with_time: bool) -> str:
    if not v:
        return ""
    try:
        if with_time:
            t = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
            if t.tzinfo is None:
                t = t.replace(tzinfo=dt.UTC)
            return t.astimezone(dt.UTC).strftime("%Y-%m-%d %H:%M")
        return str(v)[:10]
    except ValueError:
        return str(v)


def _vlan_badge(v: dict) -> str:
    """A VLAN as the list's badge: ``100 · servers`` in the VLAN's own colour,
    else its zone's, else neutral."""
    zone = v.get("zone") if isinstance(v.get("zone"), dict) else {}
    name = f"{v['vlan_id']} · {v['name']}" if v.get("name") else str(v["vlan_id"])
    return _pill({"name": name, "color": v.get("color") or zone.get("color") or ""})


def _badge(v) -> str:
    """An object with a colour as its square badge; else its name."""
    if isinstance(v, dict) and "vlan_id" in v and "color" in v:
        return _vlan_badge(v)
    if isinstance(v, dict) and "color" in v:
        name = _name({k: x for k, x in v.items() if k != "color"}) or _name(v)
        return _pill(
            {"name": name, "color": v.get("color") or "", "text_color": v.get("text_color") or ""}
        )
    return escape(_name(v))


def cell(row: dict, col: Column) -> str:
    """The HTML of one cell."""
    if col.kind == "cf":
        return _cf_cell((row.get("custom_fields") or {}).get(col.path), col.cf or {})
    v = dig(row, col.path)
    if v is None or v == "" or v == []:
        return ""
    kind = col.kind
    if kind == "tags" or (
        kind == "objects"
        and isinstance(v, list)
        and any(isinstance(x, dict) and "color" in x for x in v)
    ):
        return " ".join(_badge(x) for x in v) if isinstance(v, list) else _badge(v)
    if kind in ("object", "objects", "auto"):
        if isinstance(v, list):
            return escape(_name(v))
        if isinstance(v, dict):
            if "status" in v and "color" not in v and isinstance(v["status"], str):
                return escape(humanize(v["status"]))
            return _badge(v)
        return escape(_scalar(v))
    if kind == "choice":
        return escape((col.options or {}).get(v) or humanize(str(v)))
    if kind == "datetime":
        return escape(_when(v, True))
    if kind == "date":
        return escape(_when(v, False))
    if kind == "bool":
        return "Yes" if v else "No"
    if col.key.endswith("utilisation_pct") and isinstance(v, int | float):
        return f"{v:g}%"
    if isinstance(v, dict | list):
        return escape(_name(v))
    return escape(_scalar(v))


def _cf_cell(v, cf: dict) -> str:
    if v is None or v == "" or v == []:
        return ""
    if cf.get("type") == "boolean" or isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, dict | list):
        return escape(
            _name(v) or ", ".join(str(x) for x in v if not isinstance(x, dict))
            if isinstance(v, list)
            else _name(v)
        )
    return escape(str(v))


def plain(row: dict, col: Column) -> str:
    """A cell as text, for grouping and summaries."""
    v = dig(row, col.path) if col.kind != "cf" else (row.get("custom_fields") or {}).get(col.path)
    return _name(v) if isinstance(v, dict | list) else _scalar(v)


# ─── The request ────────────────────────────────────────────────────────────


class ObjectReportOptionsSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False, allow_blank=True)
    paper = serializers.ChoiceField(choices=PAPERS, required=False, default="a4")
    orientation = serializers.ChoiceField(choices=ORIENTATIONS, required=False)
    group_by = serializers.CharField(
        max_length=80, required=False, allow_blank=True, allow_null=True
    )
    include_summary = serializers.BooleanField(required=False)
    list_table = serializers.BooleanField(required=False)
    per_object = serializers.BooleanField(required=False)
    show_ips = serializers.BooleanField(required=False)
    last = serializers.IntegerField(
        required=False, min_value=1, max_value=MAX_LAST, default=DEFAULT_LAST
    )


def _filters(value):
    if not isinstance(value, dict):
        raise serializers.ValidationError("An object of the list's query parameters.")
    out = {}
    for k, v in value.items():
        if not isinstance(k, str) or not _FILTER_KEY.match(k) or k in _FILTER_DROP:
            continue
        vals = v if isinstance(v, list) else [v]
        if len(vals) > 50:
            raise serializers.ValidationError(f"{k}: at most 50 values.")
        clean = []
        for x in vals:
            if isinstance(x, bool):
                x = "true" if x else "false"
            if not isinstance(x, str | int | float):
                raise serializers.ValidationError(f"{k}: text values only.")
            if len(str(x)) > 500:
                raise serializers.ValidationError(f"{k}: a value is over 500 characters.")
            clean.append(str(x))
        out[k] = clean
    return out


class ObjectReportRequestSerializer(serializers.Serializer):
    ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text="The objects; every row the filters match when absent.",
    )
    filters = serializers.JSONField(
        required=False, validators=[_filters], help_text="The list's query parameters."
    )
    sections = serializers.ListField(
        child=serializers.CharField(max_length=40), required=False, max_length=30
    )
    columns = serializers.DictField(
        child=serializers.ListField(
            child=serializers.CharField(max_length=120), max_length=MAX_COLUMNS * 4
        ),
        required=False,
        help_text="Columns per section, in order; `list` for the objects' table.",
    )
    options = ObjectReportOptionsSerializer(required=False)

    def validate_ids(self, value):
        if len(value) > MAX_OBJECTS:
            raise serializers.ValidationError(
                f"A report lists at most {MAX_OBJECTS:,} objects; {len(value):,} were asked."
            )
        return value

    def validate_sections(self, value):
        rt = self.context["type"]
        bad = [s for s in value if rt.section(s) is None]
        if bad:
            raise serializers.ValidationError(f"No such section: {', '.join(bad)}.")
        return value


# ─── The data ───────────────────────────────────────────────────────────────


@dataclass
class Built:
    """A section of one object, ready to print."""

    key: str
    label: str
    html: str = ""
    note: str = ""


class Budget:
    def __init__(self, rows: int):
        self.left = rows

    def take(self, n: int) -> int:
        n = max(0, min(n, self.left))
        self.left -= n
        return n


class Context:
    """What a report reads once: the type's list, each section's list view
    and catalog (None when the reader may not view it)."""

    def __init__(self, request, rt: ReportType, tenant):
        self.request = request
        self.rt = rt
        self.tenant = tenant
        self._views: dict = {}
        self._cats: dict = {}

    def view(self, path: str, params: dict | None = None):
        if params is None:
            if path not in self._views:
                self._views[path] = list_view(self.request, path)
            return self._views[path]
        if self.view(path) is None:
            return None
        return list_view(self.request, path, params)

    def catalog(self, path: str) -> dict[str, Column] | None:
        if path not in self._cats:
            v = self.view(path)
            self._cats[path] = catalog(v, self.request, self.tenant) if v is not None else None
        return self._cats[path]


def section_columns(ctx: Context, s: Section) -> dict[str, Column] | None:
    if s.kind == "kv":
        cat = ctx.catalog(ctx.rt.path)
        if cat is None:
            return None
        return cat if s.custom_fields else {k: c for k, c in cat.items() if c.kind != "cf"}
    if s.kind == "table":
        return ctx.catalog(s.path)
    return {}


def section_available(ctx: Context, s: Section) -> tuple[bool, str]:
    if s.kind == "table" and ctx.view(s.path) is None:
        return False, f"You may not view {s.label.lower()}."
    if s.kind == "monitoring" and not _can_view_ips(ctx):
        return False, "You may not view IP addresses."
    return True, ""


def _can_view_ips(ctx) -> bool:
    return ctx.view("/api/ips/") is not None


def _kv_html(row, cols: list[Column]) -> str:
    pairs = [(c.label, cell(row, c)) for c in cols]
    pairs = [(k, v) for k, v in pairs if v]
    if not pairs:
        return "<p class='muted'>Nothing recorded.</p>"
    rows = []
    for i in range(0, len(pairs), 2):
        a = pairs[i]
        b = pairs[i + 1] if i + 1 < len(pairs) else ("", "")
        rows.append(
            f"<tr><th>{escape(a[0])}</th><td>{a[1]}</td><th>{escape(b[0])}</th><td>{b[1]}</td></tr>"
        )
    return (
        "<table class='kv'><colgroup><col style='width:16%'><col style='width:34%'>"
        "<col style='width:16%'><col style='width:34%'></colgroup>"
        f"<tbody>{''.join(rows)}</tbody></table>"
    )


#: A column's share of a table's width, by key and then by kind; a fixed
#: layout is far cheaper to render than one sized from every cell (#474).
_WIDE_KEYS = ("description", "comments", "dns_name", "assigned_interface", "tags")
_NARROW_KINDS = ("bool", "date", "choice")


def _weight(c: Column) -> float:
    if c.key in _WIDE_KEYS or c.key.endswith("description"):
        return 1.6
    if c.kind in _NARROW_KINDS or c.key.endswith(("_pct", "_count")):
        return 0.7
    if c.kind == "datetime":
        return 1.1
    return 1.0


def column_widths(cols: list[Column]) -> list[float]:
    """Each column's width in percent of the table."""
    weights = [_weight(c) for c in cols]
    total = sum(weights) or 1.0
    return [100 * w / total for w in weights]


def _head_html(cols: list[Column]) -> str:
    return "".join(
        f"<th style='width:{w:.2f}%'>{escape(c.label)}</th>"
        for c, w in zip(cols, column_widths(cols), strict=True)
    )


def _row_html(row: dict, cols: list[Column], after=None, depth: int = 0) -> str:
    """One row, and ``after``'s full-width row under it. ``depth`` indents the
    prefix cell with one ``↳`` a level, as the Prefixes list does."""
    tds = []
    for i, c in enumerate(cols):
        html = cell(row, c)
        if depth and c.key == "cidr":
            html = f"<span class='tree'>{'↳' * depth}</span>{html}"
        tds.append(f"<td{' class=b' if i == 0 else ''}>{html}</td>")
    return f"<tr>{''.join(tds)}</tr>{_after_row(after, row, len(cols))}"


def table_html(rows: list[dict], cols: list[Column], cls: str = "", after=None) -> str:
    """A grid of ``rows``; ``after(row)``, when given, is HTML for a full-width
    row printed under each one (empty for none)."""
    body = "".join(_row_html(r, cols, after) for r in rows)
    return (
        f"<table class='grid {cls}'><thead><tr>{_head_html(cols)}</tr></thead>"
        f"<tbody>{body}</tbody></table>"
    )


def _after_row(after, row: dict, span: int) -> str:
    html = after(row) if after else ""
    return f"<tr class='under'><td colspan='{span}'>{html}</td></tr>" if html else ""


#: The IP columns a prefix list row is followed by with ``show_ips``.
SHOW_IPS_COLUMNS = ("ip_address", "status", "role", "dns_name")


def prefix_ips(ctx: Context, budget: Budget):
    """``after`` for a prefix list's table: each prefix's IP addresses, read
    through the reader's own IP list (so their scope applies) and counted
    against the report's row budget. None when they may not view IPs."""
    if not _can_view_ips(ctx):
        return None
    cat = ctx.catalog("/api/ips/") or {}
    cols = [cat[k] for k in SHOW_IPS_COLUMNS if k in cat]
    device, iface = cat.get("assigned_device"), cat.get("assigned_interface")
    assigned = Column("assigned", "Assigned to", "auto", "assigned")

    def html(prefix: dict) -> str:
        view = ctx.view("/api/ips/", {"prefix": _id(prefix)})
        if view is None:
            return ""
        limit = budget.take(MAX_SECTION_ROWS)
        rows, total = read_rows(view, limit=limit)
        budget.left += limit - len(rows)
        if not rows:
            return ""
        for r in rows:
            parts = [plain(r, c) for c in (device, iface) if c is not None]
            r["assigned"] = " · ".join(x for x in parts if x)
        note = _left_out(total, len(rows), "IP addresses")
        return table_html(rows, [*cols, assigned], "ips") + (
            f"<p class='muted'>{escape(note)}</p>" if note else ""
        )

    return html


def _left_out(total: int, shown: int, what: str) -> str:
    if total <= shown:
        return ""
    return f"Only the first {shown:,} of {total:,} {what} are listed."


def build_section(
    ctx: Context, s: Section, row: dict, columns: dict, options: dict, budget: Budget
) -> Built:
    out = Built(s.key, s.label)
    ok, why = section_available(ctx, s)
    if not ok:
        out.note = f"{s.label} left out: {why[0].lower()}{why[1:]}"
        return out
    if s.kind == "kv":
        cat = section_columns(ctx, s) or {}
        out.html = _kv_html(row, pick(cat, columns.get(s.key), default_columns(s, cat)))
        return out
    if s.kind == "table":
        view = ctx.view(s.path, s.params(row) if s.params else {})
        if view is None:
            out.note = f"{s.label} left out: you may not view them."
            return out
        cap = options["last"] if s.last else MAX_SECTION_ROWS
        limit = budget.take(cap)
        narrow = (lambda qs: s.narrow(qs, row)) if s.narrow else None
        rows, total = read_rows(view, limit=limit, narrow=narrow)
        cat = ctx.catalog(s.path) or {}
        cols = pick(cat, columns.get(s.key), s.columns)
        if not rows:
            out.html = "<p class='muted'>None.</p>"
        else:
            out.html = table_html(rows, cols)
        if s.last and total > len(rows):
            out.note = f"The latest {len(rows):,} of {total:,}."
        else:
            out.note = _left_out(total, len(rows), s.label.lower())
        return out
    if s.kind == "utilisation":
        out.html = _utilisation_html(row)
        return out
    if s.kind == "monitoring":
        out.html = _monitoring_html(ctx, row)
        return out
    if s.kind == "photo":
        out.html = _photo_html(ctx, row)
        return out
    return out


def _utilisation_html(row: dict) -> str:
    from .models import usable_host_count

    try:
        net = ipaddress.ip_network(row.get("cidr") or "", strict=False)
    except ValueError:
        net = None
    alloc = row.get("allocation") if isinstance(row.get("allocation"), dict) else None
    pct = row.get("utilisation_pct")
    used = row.get("ip_count") or 0
    if alloc:
        size, used = alloc.get("size") or 0, alloc.get("used") or 0
        scope = "Allocation ranges"
    else:
        size = usable_host_count(net) if net is not None else 0
        scope = "Usable addresses"
    facts = [(scope, f"{size:,}"), ("Used", f"{used:,}")]
    if size and size >= used:
        facts.append(("Free", f"{size - used:,}"))
    facts.append(("Child prefixes", f"{row.get('child_count') or 0:,}"))
    kv = "".join(f"<tr><th>{escape(k)}</th><td class='n'>{escape(v)}</td></tr>" for k, v in facts)
    if pct is None:
        bar = "<p class='muted'>No utilisation for this prefix (a container, or too large to count).</p>"
    else:
        p = max(0, min(100, float(pct)))
        bar = (
            f"<div class='ubar'><div style='width:{p:.1f}%'></div></div>"
            f"<div class='ulab'>{p:g}% used</div>"
        )
    return f"{bar}<table class='facts'>{kv}</table>"


_MON = {
    "up": ("#16a34a", "#ffffff"),
    "down": ("#dc2626", "#ffffff"),
    "degraded": ("#d97706", "#ffffff"),
    "warning": ("#d97706", "#ffffff"),
}


def _mon_pill(status: str) -> str:
    bg, fg = _MON.get(status, ("", ""))
    return _pill({"name": humanize(status or "unknown"), "color": bg, "text_color": fg})


def _monitoring_html(ctx: Context, row: dict) -> str:
    from auth_api import rbac
    from monitoring.models import CheckState

    from .models import IPAddress

    oid = row["id"]
    ips = IPAddress.objects.filter(tenant=ctx.tenant)
    if ctx.rt is DEVICE:
        ips = ips.filter(Q(assigned_device_id=oid) | Q(assigned_interface__device_id=oid))
    elif ctx.rt is PREFIX:
        ips = ips.filter(prefix_id=oid)
    else:
        ips = ips.filter(pk=oid)
    ips = rbac.restrict_queryset(ips, ctx.request.user, ctx.tenant, "ipaddress", "view")
    states = list(
        CheckState.objects.filter(tenant=ctx.tenant, target_ip__in=ips.values("id"))
        .order_by("target_ip__ip_address", "template__name")
        .values(
            "template__name",
            "kind",
            "target_ip__ip_address",
            "status",
            "since",
            "last_checked",
            "last_latency_ms",
        )[: MAX_CHECKS + 1]
    )
    if not states:
        return "<p class='muted'>No checks.</p>"
    rank = {"down": 0, "degraded": 1, "warning": 1, "unknown": 2, "up": 3}
    states.sort(key=lambda s: (rank.get(s["status"], 2), s["template__name"] or ""))
    counts: dict[str, int] = {}
    for s in states:
        counts[s["status"]] = counts.get(s["status"], 0) + 1
    worst = states[0]["status"]
    head = (
        f"<p>{_mon_pill(worst)} "
        + " · ".join(f"{n} {escape(humanize(k).lower())}" for k, n in sorted(counts.items()))
        + "</p>"
    )
    trs = "".join(
        "<tr>"
        f"<td class='b'>{escape(s['template__name'] or humanize(s['kind'] or ''))}</td>"
        f"<td>{escape(str(s['target_ip__ip_address'] or ''))}</td>"
        f"<td>{_mon_pill(s['status'])}</td>"
        f"<td>{escape(_when(s['since'].isoformat() if s['since'] else '', True))}</td>"
        f"<td>{escape(_when(s['last_checked'].isoformat() if s['last_checked'] else '', True))}</td>"
        f"<td class='n'>{'' if s['last_latency_ms'] is None else f'{s["last_latency_ms"]:.1f} ms'}</td>"
        "</tr>"
        for s in states[:MAX_CHECKS]
    )
    more = (
        f"<p class='muted'>Only the first {MAX_CHECKS} checks are listed.</p>"
        if len(states) > MAX_CHECKS
        else ""
    )
    return (
        head + "<table class='grid'><thead><tr><th>Check</th><th>Address</th>"
        "<th>State</th><th>Since</th><th>Last checked</th><th class='n'>Latency</th>"
        f"</tr></thead><tbody>{trs}</tbody></table>{more}"
    )


def _photo_html(ctx: Context, row: dict) -> str:
    from .models import Device

    if ctx.rt is not DEVICE:
        return ""
    d = Device.objects.filter(pk=row["id"]).select_related("device_type").first()
    imgs = []
    dtype = getattr(d, "device_type", None)
    for attr, label in (("front_image", "Front"), ("rear_image", "Rear")):
        f = getattr(dtype, attr, None) if dtype is not None else None
        name = getattr(f, "name", "") or ""
        if name.startswith("device-type-images/"):
            src = MEDIA_IMAGES_URL + escape(name[len("device-type-images/") :])
            imgs.append(
                f"<figure><img src='{src}' alt=''><figcaption>{label}</figcaption></figure>"
            )
    if not imgs:
        return "<p class='muted'>No photo of this device type.</p>"
    return f"<div class='photos'>{''.join(imgs)}</div>"


# ─── The report ─────────────────────────────────────────────────────────────


def _title(rt: ReportType, rows: list[dict], options: dict, many: bool) -> str:
    if options.get("title"):
        return options["title"].strip()
    if not many and rows:
        return f"{rt.label} {rows[0].get(rt.title_key) or ''}".strip()
    return f"{rt.plural} report"


def _summary_html(rt: ReportType, rows: list[dict], cat: dict[str, Column]) -> str:
    blocks = []
    for key in rt.groups[:3]:
        col = cat.get(key)
        if col is None:
            continue
        counts: dict[str, list] = {}
        for r in rows:
            v = dig(r, col.path)
            name = _name(v) or "None"
            entry = counts.setdefault(name, [0, v if isinstance(v, dict) else None])
            entry[0] += 1
        trs = "".join(
            f"<tr><td>{_badge(obj) if obj else escape(name)}</td><td class='n'>{n:,}</td></tr>"
            for name, (n, obj) in sorted(counts.items(), key=lambda x: (-x[1][0], x[0]))[:30]
        )
        blocks.append(
            f"<div class='sumblock'><h3>By {escape(col.label.lower())}</h3>"
            f"<table class='facts'><tbody>{trs}</tbody></table></div>"
        )
    if not blocks:
        return ""
    return f"<section class='summary'><h2>Summary</h2>{''.join(blocks)}</section>"


def _list_html(
    rt: ReportType, rows: list[dict], cols: list[Column], group: Column | None, after=None
) -> str:
    if not rows:
        return "<section class='list'><p class='muted'>No objects.</p></section>"
    if group is None:
        return f"<section class='list'><h2>{escape(rt.plural)}</h2>{table_html(rows, cols, after=after)}</section>"
    groups: dict[str, list] = {}
    for r in rows:
        groups.setdefault(plain(r, group) or "None", []).append(r)
    body = "".join(
        f"<h3>{escape(name)} <span>{_plural(len(g), rt.label.lower(), rt.plural.lower())}</span></h3>"
        f"{table_html(g, [c for c in cols if c.key != group.key], after=after)}"
        for name, g in sorted(groups.items(), key=lambda x: (x[0] == "None", x[0].lower()))
    )
    return (
        f"<section class='list'><h2>{escape(rt.plural)} by "
        f"{escape(group.label.lower())}</h2>{body}</section>"
    )


#: The Prefixes list's order between sibling CIDRs (``localeCompare``):
#: ``:`` before ``.`` before ``/``, all before digits and letters.
_CIDR_PUNCT = {":": 0, ".": 1, "/": 2}


def _cidr_key(cidr: str) -> list:
    return [(_CIDR_PUNCT.get(ch, 3), ch.casefold()) for ch in cidr]


def nest_prefixes(rows: list[dict]) -> list[tuple[dict, int]]:
    """One VRF's prefixes in the Prefixes list's tree order - parents before
    their children, siblings by CIDR - each with its depth below its nearest
    listed parent (``annotateNesting``). A CIDR that does not parse ends the
    list at depth 0."""
    parsed, bad = [], []
    for r in rows:
        try:
            parsed.append((ipaddress.ip_network(str(r.get("cidr") or ""), strict=False), r))
        except ValueError:
            bad.append(r)
    parsed.sort(key=lambda x: (x[0].version, int(x[0].network_address), x[0].prefixlen))
    children: dict[int | None, list[int]] = {}
    stack: list[int] = []
    for i, (net, _) in enumerate(parsed):
        while stack:
            top = parsed[stack[-1]][0]
            if top.version == net.version and top.prefixlen < net.prefixlen and net.subnet_of(top):
                break
            stack.pop()
        children.setdefault(stack[-1] if stack else None, []).append(i)
        stack.append(i)
    out: list[tuple[dict, int]] = []

    def walk(parent: int | None, depth: int) -> None:
        kids = sorted(children.get(parent, ()), key=lambda i: _cidr_key(parsed[i][1]["cidr"]))
        for i in kids:
            out.append((parsed[i][1], depth))
            walk(i, depth + 1)

    walk(None, 0)
    return out + [(r, 0) for r in bad]


def vrf_groups(rows: list[dict]) -> list[tuple[dict | None, list[tuple[dict, int]]]]:
    """``rows`` by VRF as the Prefixes list groups them: Global first, then
    each VRF by name in natural order, each nested."""
    from .natural import natural_key

    groups: dict[str, tuple[dict | None, list[dict]]] = {}
    for r in rows:
        vrf = r.get("vrf") if isinstance(r.get("vrf"), dict) else None
        key = str(vrf.get("id")) if vrf else ""
        groups.setdefault(key, (vrf, []))[1].append(r)
    order = sorted(
        groups.items(),
        key=lambda kv: (kv[0] != "", natural_key((kv[1][0] or {}).get("name")), kv[0]),
    )
    return [(vrf, nest_prefixes(g)) for _, (vrf, g) in order]


def _vrf_banner(vrf: dict | None, count: int, span: int) -> str:
    """The list's group header: ``VRF <badge> RD <rd> <n> rows``."""
    vrf = vrf or {}
    badge = _pill({"name": vrf.get("name") or "Global", "color": vrf.get("color") or ""})
    rd = f"<span class='rd'>RD {escape(str(vrf['rd']))}</span>" if vrf.get("rd") else ""
    return (
        f"<tr class='band'><td colspan='{span}'><span class='bl'>VRF</span>{badge}{rd}"
        f"<span class='cnt'>{_plural(count, 'row')}</span></td></tr>"
    )


def _vrf_list_html(rt: ReportType, rows: list[dict], cols: list[Column], after=None) -> str:
    """The prefix list as the Prefixes list shows it: one table, a banner
    row a VRF (Global first), children indented under their parent; no VRF
    column, the banner says it."""
    body = "".join(
        _vrf_banner(vrf, len(g), len(cols))
        + "".join(_row_html(r, cols, after, depth) for r, depth in g)
        for vrf, g in vrf_groups(rows)
    )
    return (
        f"<section class='list'><h2>{escape(rt.plural)}</h2>"
        f"<table class='grid'><thead><tr>{_head_html(cols)}</tr></thead>"
        f"<tbody>{body}</tbody></table></section>"
    )


def _object_html(
    ctx: Context,
    row: dict,
    sections: list[Section],
    columns: dict,
    options: dict,
    budget: Budget,
    first: bool,
) -> str:
    rt = ctx.rt
    cat = ctx.catalog(rt.path) or {}
    badges = " ".join(cell(row, cat[k]) for k in rt.badges if k in cat and cell(row, cat[k]))
    tags = cell(row, cat["tags"]) if "tags" in cat else ""
    parts = []
    for s in sections:
        b = build_section(ctx, s, row, columns, options, budget)
        note = f"<p class='muted'>{escape(b.note)}</p>" if b.note else ""
        if not b.html and b.note:
            parts.append(f"<div class='sec'><h3>{escape(b.label)}</h3>{note}</div>")
        elif b.html:
            parts.append(f"<div class='sec'><h3>{escape(b.label)}</h3>{b.html}{note}</div>")
    return (
        f"<section class='object{' first' if first else ''}'>"
        f"<h2 class='obj'>{escape(str(row.get(rt.title_key) or ''))}"
        f"{(' ' + badges) if badges else ''}</h2>"
        f"{f'<div class=tags>{tags}</div>' if tags else ''}"
        f"{''.join(parts)}</section>"
    )


def _header_html(title: str, facts: list[tuple[str, str]]) -> str:
    kv = " · ".join(f"<span><b>{escape(k)}</b> {escape(v)}</span>" for k, v in facts if v)
    return f"<header><h1>{escape(title)}</h1><div class='meta'>{kv}</div></header>"


def _css_str(text: str) -> str:
    return text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")


def report_html(
    *, title: str, tenant: str, generated, paper: str, orientation: str, body: str
) -> str:
    from danbyte import __version__

    pw, ph = PAPERS_MM[paper]
    if orientation == "portrait":
        pw, ph = ph, pw
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    running = f"{title} · {stamp(generated)} · Danbyte {__version__}"
    font = "font-family:Inter,'DejaVu Sans',sans-serif;font-size:6.5pt;color:#71717a"
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{escape(title)}</title>"
        f"<meta name='generator' content='Danbyte {escape(__version__)}'>"
        "<style>"
        f"{_font_faces()}"
        f"@page{{size:{mm(pw)} {mm(ph)};margin:{mm(MARGIN_MM)} {mm(MARGIN_MM)} {mm(BOTTOM_MM)};"
        f"@top-right{{content:'{_css_str(tenant)}';{font}}}"
        f"@bottom-left{{content:'{_css_str(running)}';{font}}}"
        f"@bottom-right{{content:'Page ' counter(page) ' / ' counter(pages);{font}}}}}"
        "html,body{margin:0;padding:0}"
        f"body{{font-family:Inter,'DejaVu Sans',sans-serif;color:{INK};font-size:7.5pt}}"
        "header{margin-bottom:5mm}"
        "h1{font-size:15pt;font-weight:700;margin:0 0 1.5mm}"
        ".meta{color:#52525b;font-size:7.5pt}"
        ".meta span{margin-right:1mm}"
        ".meta b{font-weight:600;color:#3f3f46}"
        "h2{font-size:11pt;font-weight:700;margin:0 0 3mm;break-after:avoid}"
        "h2 .pill,h2 .tag{font-size:7pt;vertical-align:1.2pt;margin-left:1mm}"
        "h3{font-size:8.5pt;font-weight:600;margin:4.5mm 0 1.5mm;break-after:avoid}"
        "h3 span{font-weight:400;color:#71717a;margin-left:2mm}"
        "section.list,section.summary{margin-bottom:6mm}"
        "section.object{break-before:page}"
        "section.object.first{break-before:auto}"
        ".tags{margin:-1.5mm 0 2mm}"
        ".tags .pill{margin-right:0.8mm}"
        "table{width:100%;border-collapse:collapse;margin-bottom:1.5mm}"
        "thead{display:table-header-group}"
        "tr{break-inside:avoid}"
        "th{text-align:left;font-weight:600;color:#52525b;padding:0.9mm 1.2mm;"
        "vertical-align:bottom}"
        "table.grid{table-layout:fixed}"
        "table.grid th{border-bottom:0.3mm solid #a1a1aa;overflow-wrap:anywhere}"
        "td{padding:0.9mm 1.2mm;vertical-align:top;overflow-wrap:anywhere}"
        "table.grid td{border-bottom:0.15mm solid #e4e4e7}"
        "tr.under>td{padding:0 0 1.5mm 5mm}"
        "tr.band{break-after:avoid}"
        "table.grid tr.band>td{background:#f4f4f5;border-bottom:0.15mm solid #d4d4d8;"
        "padding:1mm 1.2mm;color:#71717a}"
        ".band .bl{font-size:5.5pt;letter-spacing:0.3mm;margin-right:1.5mm}"
        ".band .pill{margin:0}"
        ".band .rd{font-family:'DejaVu Sans Mono',monospace;font-size:6pt;margin-left:1.5mm}"
        ".band .cnt{margin-left:2mm;color:#a1a1aa}"
        ".tree{color:#a1a1aa;font-weight:400;margin-right:0.8mm}"
        "table.ips{margin:0;font-size:6.8pt}"
        "table.ips th{border-bottom-width:0.15mm;padding:0.5mm 1.2mm}"
        "table.ips td{padding:0.5mm 1.2mm}"
        "table.kv{table-layout:fixed}"
        "table.kv th{font-weight:500;color:#71717a;border-bottom:0.15mm solid #e4e4e7}"
        "table.kv td{border-bottom:0.15mm solid #e4e4e7}"
        "table.facts{width:auto;min-width:70mm}"
        "table.facts th{font-weight:500;color:#71717a;border-bottom:0.15mm solid #e4e4e7;"
        "padding-right:8mm}"
        "table.facts td{border-bottom:0.15mm solid #e4e4e7}"
        ".sumblock{display:inline-block;vertical-align:top;margin-right:8mm}"
        ".n{text-align:right;white-space:nowrap}"
        ".b{font-weight:600}"
        ".muted{color:#71717a;margin:1mm 0}"
        ".sec{margin-bottom:2mm}"
        ".pill,.tag{display:inline-block;padding:0.15mm 1.4mm;font-size:6.5pt;font-weight:500;"
        "white-space:nowrap;line-height:1.35;border-radius:0.6mm}"
        "td .pill{margin:0 0.6mm 0.4mm 0}"
        ".plain{background:#f4f4f5;color:#3f3f46}"
        ".ubar{height:3mm;width:120mm;background:#f4f4f5;border:0.2mm solid #d4d4d8;"
        "border-radius:0.6mm;overflow:hidden}"
        ".ubar div{height:100%;background:#52525b}"
        ".ulab{margin:1mm 0 2mm;color:#52525b}"
        ".photos figure{display:inline-block;margin:0 6mm 0 0;vertical-align:top}"
        ".photos img{max-width:110mm;max-height:45mm;border:0.2mm solid #d4d4d8}"
        ".photos figcaption{color:#71717a;font-size:6.5pt;margin-top:0.8mm}"
        "</style></head><body>"
        f"{body}"
        "</body></html>"
    )


def render_report_pdf(_svg: bytes, *, html: str) -> bytes:
    import weasyprint

    return weasyprint.HTML(
        string=html, base_url=BASE_URL, url_fetcher=PdfUrlFetcher(b"")
    ).write_pdf()


def _render(svg: bytes, **kwargs) -> bytes:
    # Looked up when called, so the child renders what this module names.
    return render_report_pdf(svg, **kwargs)


def render_with_deadline(*, timeout: float = RENDER_TIMEOUT, **kwargs) -> bytes:
    return run_with_deadline(_render, b"", timeout=timeout, **kwargs)


# ─── Endpoints ──────────────────────────────────────────────────────────────


def _tenant(request):
    from .views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    return tenant


def describe(request, rt: ReportType) -> Response:
    """``GET``: what a report of ``rt`` can hold for this reader."""
    tenant = _tenant(request)
    ctx = Context(request, rt, tenant)
    cat = ctx.catalog(rt.path)
    if cat is None:
        raise PermissionDenied(f"You may not view {rt.plural.lower()}.")
    sections = []
    for s in rt.sections:
        ok, why = section_available(ctx, s)
        cols = section_columns(ctx, s) if ok else {}
        sections.append(
            {
                "key": s.key,
                "label": s.label,
                "kind": s.kind,
                "default": s.default,
                "available": ok,
                **({"note": why} if why else {}),
                "last": s.last,
                "columns": [c.payload() for c in (cols or {}).values()],
                "default_columns": [
                    c.key for c in pick(cols or {}, None, default_columns(s, cols or {}))
                ],
            }
        )
    return Response(
        {
            "type": rt.slug,
            "label": rt.label,
            "plural": rt.plural,
            "columns": [c.payload() for c in cat.values()],
            "default_columns": [k for k in rt.list_columns if k in cat],
            "group_by": [cat[k].payload() for k in rt.groups if k in cat],
            "default_group_by": rt.default_group if rt.default_group in cat else None,
            "sections": sections,
            "papers": list(PAPERS),
            "show_ips": rt is PREFIX and _can_view_ips(ctx),
            "limits": {
                "objects": MAX_OBJECTS,
                "object_pages": MAX_OBJECT_PAGES,
                "section_rows": MAX_SECTION_ROWS,
                "total_rows": MAX_TOTAL_ROWS,
                "columns": MAX_COLUMNS,
                "last": MAX_LAST,
                "cells": cells_that_fit(),
                "background_cells": cells_that_fit(0, job_budget()),
            },
        }
    )


def _print_key(slug, user_id, tenant_id) -> str:
    return f"object-report-print:{slug}:{user_id}:{tenant_id}"


def estimate_seconds(cells: int, pages: int = 0) -> float:
    """About how long WeasyPrint takes for ``cells`` table cells and
    ``pages`` objects with details."""
    return SECONDS_BASE + cells * SECONDS_PER_CELL + pages * SECONDS_PER_PAGE


def job_timeout() -> int:
    """A background render's deadline, in seconds."""
    return int(getattr(settings, "REPORT_JOB_TIMEOUT", 300))


def job_keep() -> int:
    """How long a background report's PDF is kept, in seconds."""
    return int(getattr(settings, "REPORT_JOB_KEEP", 3600))


def job_budget() -> float:
    """The estimate past which a report is refused outright."""
    return job_timeout() * 0.7


def cells_that_fit(pages: int = 0, budget: float | None = None) -> int:
    """Table cells a report with ``pages`` objects with details may hold
    within ``budget`` seconds (by default the in-request ``RENDER_BUDGET``)."""
    budget = RENDER_BUDGET if budget is None else budget
    left = budget - SECONDS_BASE - pages * SECONDS_PER_PAGE
    return max(0, int(left / SECONDS_PER_CELL))


def estimate(body: str, shape: dict) -> dict:
    """What rendering ``body`` costs, and where: ``now`` in the request,
    ``background`` as a job, or ``too_large`` for either."""
    cells = body.count("<td")
    pages = shape["pages"]
    seconds = estimate_seconds(cells, pages)
    if seconds <= RENDER_BUDGET:
        mode = "now"
    elif seconds <= job_budget():
        mode = "background"
    else:
        mode = "too_large"
    return {
        "cells": cells,
        "pages": pages,
        "seconds": round(seconds, 1),
        "mode": mode,
        "fits": {
            "now": cells_that_fit(pages),
            "background": cells_that_fit(pages, job_budget()),
        },
    }


def too_slow(body: str, shape: dict, budget: float | None = None) -> Response | None:
    """The 400 for a report that would not render before ``budget`` (by
    default :func:`job_budget`, the background deadline's), saying what
    fits; None when it would."""
    budget = job_budget() if budget is None else budget
    cells = body.count("<td")
    pages = shape["pages"]
    if estimate_seconds(cells, pages) <= budget:
        return None
    fit = cells_that_fit(pages, budget)
    hints, drop = [], []
    rows, cols = shape["rows"], shape["list_columns"]
    other = cells - rows * cols if cols else cells
    if cols and fit > other:
        room = fit - other
        hints.append(f"at most {room // cols:,} rows with these {cols} columns")
        if room // rows:
            hints.append(f"at most {room // rows} columns for these {rows:,} rows")
    if pages:
        drop.append("the details for each object or some of their sections")
    if shape.get("show_ips"):
        drop.append("Show IPs")
    tail = f" Report on {' or '.join(hints)}." if hints else " Report on fewer rows."
    if drop:
        tail += f" Or leave out {' or '.join(drop)}."
    return detail(
        f"This report is too large to render in time: {cells:,} table cells, and "
        f"about {fit:,} fit.{tail}",
        400,
    )


def build_report(request, rt: ReportType, data: dict, tenant) -> tuple[str, str, dict] | Response:
    """``(title, body html, shape)`` of the report ``data`` asks for, or the
    refusal. ``shape`` counts the objects, the list's columns (0 without a
    list) and the pages per object, for :func:`too_slow`."""
    options = {"last": DEFAULT_LAST, "paper": "a4", **(data.get("options") or {})}
    columns = data.get("columns") or {}
    ctx = Context(request, rt, tenant)
    filters = data.get("filters") or {}
    view = ctx.view(rt.path, filters)
    if view is None:
        raise PermissionDenied(f"You may not view {rt.plural.lower()}.")
    ids = data.get("ids")
    narrow = None
    if ids is not None:
        wanted = {str(i) for i in ids}
        narrow = lambda qs: qs.filter(pk__in=wanted)  # noqa: E731
    rows, total = read_rows(view, limit=MAX_OBJECTS, narrow=narrow)
    if total > MAX_OBJECTS:
        return detail(
            f"A report lists at most {MAX_OBJECTS:,} objects; this one has "
            f"{total:,}. Narrow the filters or select fewer rows.",
            400,
        )
    if not rows:
        return detail(f"No {rt.plural.lower()} to report on.", 400)
    many = len(rows) > 1
    per_object = options.get("per_object")
    if per_object is None:
        per_object = not many
    list_table = options.get("list_table")
    if list_table is None:
        list_table = many
    if per_object and len(rows) > MAX_OBJECT_PAGES:
        return detail(
            f"A report gives details for at most {MAX_OBJECT_PAGES} "
            f"{rt.plural.lower()}; this one has {len(rows):,}. Leave out the "
            "details or select fewer rows.",
            400,
        )
    cat = ctx.catalog(rt.path) or {}
    title = _title(rt, rows, options, many)
    budget = Budget(MAX_TOTAL_ROWS)
    shape = {"rows": len(rows), "list_columns": 0, "pages": len(rows) if per_object else 0}
    facts = [("Tenant", tenant.name), ("Generated", stamp(timezone.now()))]
    if many:
        facts += [
            (rt.plural, f"{len(rows):,}"),
            ("Scope", "Selected rows" if ids is not None else "Filtered list"),
        ]
    body = [_header_html(title, facts)]
    if many and options.get("include_summary"):
        body.append(_summary_html(rt, rows, cat))
    if list_table:
        cols = pick(cat, columns.get("list"), rt.list_columns)
        shape["list_columns"] = len(cols)
        # No group_by: the type's own grouping; null or "": the flat table.
        if "group_by" in options:
            group_key = options["group_by"] or ""
        else:
            group_key = rt.default_group
        group = cat.get(group_key) if group_key in rt.groups else None
        after = None
        if rt is PREFIX and options.get("show_ips"):
            after = prefix_ips(ctx, budget)
            shape["show_ips"] = after is not None
        if rt is PREFIX and group is not None and group.key == "vrf":
            cols = [c for c in cols if c.key != "vrf"]
            shape["list_columns"] = len(cols)
            body.append(_vrf_list_html(rt, rows, cols, after))
        else:
            body.append(_list_html(rt, rows, cols, group, after))
    if per_object:
        keys = data.get("sections")
        if keys is None:
            keys = [s.key for s in rt.sections if s.default]
        sections = [s for s in rt.sections if s.key in set(keys)]
        sections.sort(key=lambda s: keys.index(s.key))
        for i, row in enumerate(rows):
            body.append(
                _object_html(
                    ctx,
                    row,
                    sections,
                    columns,
                    options,
                    budget,
                    first=(i == 0 and not list_table and not options.get("include_summary")),
                )
            )
        if budget.left == 0:
            body.append(
                f"<p class='muted'>The report reached its {MAX_TOTAL_ROWS:,} rows; "
                "later sections are cut short.</p>"
            )
    return title, "".join(body), shape


def _validated(rt: ReportType, raw) -> dict:
    """The request body, checked."""
    ser = ObjectReportRequestSerializer(data=raw, context={"type": rt})
    ser.is_valid(raise_exception=True)
    data = dict(ser.validated_data)
    if "filters" in data:
        data["filters"] = _filters(data["filters"])
    data["options"] = dict(data.get("options") or {})
    return data


def _page_html(rt: ReportType, data: dict, tenant, title: str, body: str):
    """``(html, generated)``: the whole page around ``body``."""
    opts = data["options"]
    paper = opts.get("paper") or "a4"
    many_cols = len((data.get("columns") or {}).get("list") or rt.list_columns) > 8
    orientation = opts.get("orientation") or ("landscape" if many_cols else "portrait")
    generated = timezone.now()
    html = report_html(
        title=title,
        tenant=tenant.name,
        generated=generated,
        paper=paper,
        orientation=orientation,
        body=body,
    )
    return html, generated


#: An estimate is kept this many seconds per body.
ESTIMATE_TTL = 60


def _estimate_key(rt: ReportType, request, tenant, data: dict) -> str:
    raw = json.dumps(data, sort_keys=True, default=str).encode()
    digest = hashlib.sha256(raw).hexdigest()[:40]
    return f"object-report-estimate:{rt.slug}:{request.user.pk}:{tenant.pk}:{digest}"


def estimate_answer(request, rt: ReportType, data: dict, tenant) -> Response:
    """``?estimate=1``: the report built but not rendered - its table cells,
    objects with details, seconds and where it would render - kept a minute
    per body, user and tenant."""
    key = _estimate_key(rt, request, tenant, data)
    try:
        hit = cache.get(key)
    except Exception:  # noqa: BLE001 - no cache: build it
        hit = None
    if isinstance(hit, dict):
        return Response(hit)
    built = build_report(request, rt, data, tenant)
    if isinstance(built, Response):
        return built
    _title, body, shape = built
    out = estimate(body, shape)
    if out["mode"] == "too_large":
        out["detail"] = too_slow(body, shape).data["detail"]
    try:
        cache.set(key, out, ESTIMATE_TTL)
    except Exception:  # noqa: BLE001, S110 - only a shortcut
        pass
    return Response(out)


def export(request, rt: ReportType):
    """``GET`` describes, ``POST`` makes the PDF: in the request when it is
    small, as a background job (202) when it is not. ``?estimate=1`` says
    what it would cost instead."""
    if request.method == "GET":
        return describe(request, rt)
    if body_too_large(request, MAX_BODY_BYTES):
        return detail("The request is over 10 MB.", 413)
    tenant = _tenant(request)
    data = _validated(rt, request.data)
    if flag(request, "estimate"):
        return estimate_answer(request, rt, data, tenant)
    built = build_report(request, rt, data, tenant)
    if isinstance(built, Response):
        return built
    title, body, shape = built
    cost = estimate(body, shape)
    if cost["mode"] == "too_large":
        return too_slow(body, shape)
    if cost["mode"] == "background":
        return start_job(request, rt, tenant, data, cost["seconds"])
    html, generated = _page_html(rt, data, tenant, title, body)

    def render(_svg: bytes) -> bytes:
        return render_with_deadline(html=html)

    try:
        pdf = render_guarded(request, "", sanitize=lambda _t: b"", render=render)
    except RenderTimeout:
        log.warning(
            "%s report for user %s stopped after %ss", rt.label, request.user.pk, RENDER_TIMEOUT
        )
        return detail(
            "The report took too long to render and was stopped. Try again "
            "when the server is less busy, or report on fewer rows or columns.",
            503,
        )
    if isinstance(pdf, Response):
        return pdf
    return deliver(
        request,
        pdf,
        name=file_name(title, generated, rt.file_stem),
        key=_print_key(rt.slug, request.user.pk, tenant.pk),
        link=lambda token: reverse(f"{_ROUTE[rt.slug]}-report-file", kwargs={"token": token}),
        label=f"{rt.label} report",
    )


_ROUTE = {"device": "device", "prefix": "prefix", "ipaddress": "ip"}


def export_file(request, rt: ReportType, token: str) -> HttpResponse | Response:
    tenant = _tenant(request)
    return kept_pdf(request, token, key=_print_key(rt.slug, request.user.pk, tenant.pk))


# ─── Background reports ─────────────────────────────────────────────────────
#
# A report past the in-request budget renders as an RQ job on the ``low``
# queue (monitoring runs on ``default``), with ``job_timeout()`` for its
# deadline, in the same forked render child. The job rebuilds the report as
# the user who asked - their scoped lists, their tenant, their API token if
# they used one - so a permission or tenant taken away while it waited
# applies. It waits for the user's PDF lock and one of ``JOB_SLOTS``
# background slots, apart from the web renders' slots so a long render never
# holds up a quick one. The PDF is kept in the cache under a random token
# for ``job_keep()`` seconds, readable only by that user in that tenant
# through that type's ``report/job/<token>/`` endpoints.

#: Background renders at once across the deployment.
JOB_SLOTS = 1
JOB_SLOT_KEY = "object-report-job-slot:{}"
#: How long a job waits for its locks, and how often it looks.
JOB_LOCK_WAIT = 120
JOB_LOCK_POLL = 2.0
#: A user's one queued or running background report.
JOB_PENDING_KEY = "object-report-job-pending:{}"
JOB_KEY = "object-report-job:{}"
JOB_PDF_KEY = "object-report-job-pdf:{}"


def _job_lifetime() -> int:
    """Seconds a job may take from its start: the lock wait, the build
    and the render."""
    return JOB_LOCK_WAIT + job_timeout() + 120


def _job_get(token: str) -> dict | None:
    entry = cache.get(JOB_KEY.format(token))
    return entry if isinstance(entry, dict) else None


def _job_update(token: str, **fields) -> None:
    try:
        entry = _job_get(token)
        if entry is None:
            return
        entry.update(fields)
        cache.set(JOB_KEY.format(token), entry, job_keep())
    except Exception:  # noqa: BLE001 - the status is lost with the cache
        log.warning("object report job status not kept", exc_info=True)


def _job_link(rt: ReportType, name: str, token: str) -> str:
    return reverse(f"{_ROUTE[rt.slug]}-{name}", kwargs={"token": token})


def start_job(request, rt: ReportType, tenant, data: dict, seconds: float) -> Response:
    """Queue the report ``data`` asks for: 202 with ``{job, status}``, 429
    while the user already has one queued or running."""
    import django_rq

    from auth_api.models import ApiToken

    token = secrets.token_urlsafe(32)
    pending = JOB_PENDING_KEY.format(request.user.pk)
    try:
        if not cache.add(pending, token, _job_lifetime() + job_timeout()):
            return detail("A report is already being made. Try again when it is ready.", 429)
        cache.set(
            JOB_KEY.format(token),
            {
                "user": request.user.pk,
                "tenant": str(tenant.pk),
                "type": rt.slug,
                "state": "queued",
                "seconds": seconds,
            },
            job_keep(),
        )
    except Exception:  # noqa: BLE001 - the cache is down or too slow
        log.warning("%s report job not kept", rt.label, exc_info=True)
        return detail("The report could not be queued. Try again in a minute.", 503)
    auth = request.auth
    try:
        django_rq.get_queue("low").enqueue(
            run_report_job,
            token,
            rt.slug,
            request.user.pk,
            str(tenant.pk),
            auth.pk if isinstance(auth, ApiToken) else None,
            request.get_host(),
            request.is_secure(),
            json.loads(json.dumps(data, default=str)),
            job_timeout=_job_lifetime(),
            result_ttl=job_keep(),
            failure_ttl=job_keep(),
            description=f"{rt.label} PDF report",
        )
    except Exception:  # noqa: BLE001 - Redis is down
        log.warning("%s report job not queued", rt.label, exc_info=True)
        release(pending, token)
        return detail("The report could not be queued. Try again in a minute.", 503)
    return Response(
        {
            "job": token,
            "state": "queued",
            "status": _job_link(rt, "report-job", token),
            "seconds": seconds,
        },
        status=202,
    )


def job_request(user_id, tenant_id: str, auth_id, host: str, secure: bool):
    """``(request, tenant)``: a request as the user who asked for a report,
    in the tenant they asked in. PermissionDenied when the user, their API
    token or their access to the tenant is gone."""
    from django.contrib.auth import get_user_model
    from rest_framework.test import APIRequestFactory

    from auth_api.models import ApiToken
    from auth_api.token_auth import token_tenant_allowed

    user = get_user_model().objects.filter(pk=user_id, is_active=True).first()
    if user is None:
        raise PermissionDenied("The user who asked for this report is no longer active.")
    token = None
    if auth_id is not None:
        token = ApiToken.objects.select_related("user", "tenant").filter(pk=auth_id).first()
        if (
            token is None
            or token.user_id != user.pk
            or token.is_expired
            or not token_tenant_allowed(token)
        ):
            raise PermissionDenied("The API token that asked for this report is no longer valid.")
    http = APIRequestFactory().get("/", HTTP_HOST=host, secure=secure)
    # The tenant they asked in; the resolver still checks they may use it.
    http.session = {"current_tenant_id": str(tenant_id)}
    http.user = user
    req = Request(http)
    req.user = user
    req.auth = token
    tenant = _tenant(req)
    if str(tenant.pk) != str(tenant_id):
        raise PermissionDenied("You no longer have access to the tenant of this report.")
    return req, tenant


def _job_locks(user_id):
    """The user's PDF lock and a background slot, ``[(key, token), …]``,
    waited for up to ``JOB_LOCK_WAIT`` seconds; None when they stay taken."""
    ttl = job_timeout() + 60
    busy = BUSY_KEY.format(user_id)
    deadline = time.monotonic() + JOB_LOCK_WAIT
    while True:
        mine = take(busy, ttl)
        if mine is not None:
            for i in range(JOB_SLOTS):
                key = JOB_SLOT_KEY.format(i)
                slot = take(key, ttl)
                if slot is not None:
                    return [(busy, mine), (key, slot)]
            release(busy, mine)
        if time.monotonic() >= deadline:
            return None
        time.sleep(JOB_LOCK_POLL)


_RENDER_STOPPED = (
    "The report took too long to render and was stopped. Try again "
    "when the server is less busy, or report on fewer rows or columns."
)


def run_report_job(token, slug, user_id, tenant_id, auth_id, host, secure, raw) -> str:
    """The RQ job: the report ``raw`` asks for, rebuilt and rendered as
    ``user_id``, kept under ``token``. Returns the state it ended in."""
    rt = REPORT_TYPES[slug]

    def fail(msg: str) -> str:
        _job_update(token, state="failed", detail=msg)
        return "failed"

    try:
        if _job_get(token) is None:
            return "gone"
        request, tenant = job_request(user_id, tenant_id, auth_id, host, secure)
        data = _validated(rt, raw)
        built = build_report(request, rt, data, tenant)
        if isinstance(built, Response):
            return fail(str(built.data.get("detail") or "The report could not be made."))
        title, body, shape = built
        refused = too_slow(body, shape)
        if refused is not None:
            return fail(refused.data["detail"])
        _job_update(token, state="waiting", seconds=estimate(body, shape)["seconds"])
        locks = _job_locks(user_id)
        if locks is None:
            return fail("Other PDFs are being made. Try again in a few minutes.")
        try:
            _job_update(token, state="running", started=time.time())
            html, generated = _page_html(rt, data, tenant, title, body)
            pdf = render_with_deadline(html=html, timeout=job_timeout())
        finally:
            for lock in locks:
                release(*lock)
        if len(pdf) > MAX_PDF_BYTES:
            return fail("The PDF is too large to keep. Report on fewer rows or columns.")
        cache.set(JOB_PDF_KEY.format(token), pdf, job_keep())
        _job_update(token, state="done", name=file_name(title, generated, rt.file_stem))
        return "done"
    except RenderTimeout:
        log.warning("%s report job for user %s stopped after %ss", rt.label, user_id, job_timeout())
        return fail(_RENDER_STOPPED)
    except PermissionDenied as exc:
        return fail(str(exc.detail))
    except serializers.ValidationError:
        return fail("The report's options are no longer valid.")
    except Exception:  # noqa: BLE001 - told to the dialog, logged here
        log.exception("%s report job failed", rt.label)
        return fail("The report could not be made.")
    finally:
        release(JOB_PENDING_KEY.format(user_id), token)


def _my_job(request, rt: ReportType, token: str) -> dict | None:
    """The job ``token`` names when it is this user's, in this tenant, of
    this type; None otherwise."""
    if not TOKEN.match(token):
        return None
    tenant = _tenant(request)
    entry = _job_get(token)
    if (
        entry is None
        or entry.get("user") != request.user.pk
        or entry.get("tenant") != str(tenant.pk)
        or entry.get("type") != rt.slug
    ):
        return None
    return entry


def job_status(request, rt: ReportType, token: str) -> Response:
    """``{state, progress?, url?, detail?}`` of a background report. The
    state is ``queued``, ``waiting``, ``running``, ``done`` or ``failed``;
    ``progress`` (0-95) is the render's time so far against its estimate."""
    try:
        entry = _my_job(request, rt, token)
    except PermissionDenied:
        raise
    except Exception:  # noqa: BLE001 - the cache is down or too slow
        return detail("Report status is unavailable right now.", 503)
    if entry is None:
        return detail("Not found.", 404)
    state = entry.get("state", "queued")
    out: dict = {"state": state}
    if state == "running" and entry.get("started") and entry.get("seconds"):
        took = time.time() - float(entry["started"])
        out["progress"] = max(0, min(95, int(100 * took / float(entry["seconds"]))))
    if state == "done":
        out["url"] = _job_link(rt, "report-job-file", token)
    if state == "failed":
        out["detail"] = entry.get("detail") or "The report could not be made."
    return Response(out)


def job_file(request, rt: ReportType, token: str) -> HttpResponse | Response:
    """A finished background report's PDF, to the user who asked for it;
    inline, or as a download with ``?download=1``."""
    try:
        entry = _my_job(request, rt, token)
        pdf = cache.get(JOB_PDF_KEY.format(token)) if entry else None
    except PermissionDenied:
        raise
    except Exception:  # noqa: BLE001 - the cache is down or too slow
        return detail("Reports are unavailable right now.", 503)
    if entry is None or entry.get("state") != "done" or not isinstance(pdf, bytes):
        return detail("Not found.", 404)
    resp = HttpResponse(pdf, content_type="application/pdf")
    how = "attachment" if flag(request, "download") else "inline"
    resp["Content-Disposition"] = f'{how}; filename="{entry.get("name") or "report.pdf"}"'
    resp["Cache-Control"] = "private, no-store"
    resp["X-Content-Type-Options"] = "nosniff"
    return resp


# ─── Schema ─────────────────────────────────────────────────────────────────


def report_schema(rt: ReportType):
    return extend_schema(
        methods=["POST"],
        summary=f"A PDF report of {rt.plural.lower()}",
        description=(
            f"One PDF of {rt.plural.lower()}: `ids` (one for a detail page, the "
            "selected rows of a list), or every row `filters` - the list's own query "
            "parameters - match. `options.list_table` prints a table of them with "
            "`columns.list`; `options.include_summary` counts them by status, role and "
            "site; `options.per_object` adds details for each of them: the `sections`, "
            "each with its `columns.<section>`. Read through the lists, so ids and rows "
            f"the reader may not view are left out. At most {MAX_OBJECTS:,} objects and "
            f"{MAX_OBJECT_PAGES} with details (400 past either). A report estimated past "
            f"about {cells_that_fit():,} table cells renders in the background: 202 with "
            "`{job, status}`; poll `status` until `state` is `done` and fetch its `url`. "
            "One estimated past the background deadline is refused with a 400 that says "
            "what fits. `?estimate=1` builds the report without rendering it and answers "
            "`{cells, pages, seconds, mode, fits}`, `mode` being `now`, `background` or "
            "`too_large`. The drawing PDFs' limits apply; `?print=1` returns `{url}`, a "
            "five-minute link."
        ),
        tags=["reports"],
        parameters=[
            OpenApiParameter(
                name="print",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                description="Answer with a short-lived link.",
            ),
            OpenApiParameter(
                name="estimate",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                description="Say what the report would cost instead of making it.",
            ),
        ],
        request=ObjectReportRequestSerializer,
        responses={
            (200, "application/pdf"): OpenApiTypes.BINARY,
            (200, "application/json"): OpenApiTypes.OBJECT,
            202: OpenApiResponse(description="Rendering in the background: `{job, status}`."),
            400: OpenApiResponse(description="Invalid body, nothing to report, or over a limit."),
            403: OpenApiResponse(description=f"No view on {rt.plural.lower()}."),
            413: OpenApiResponse(description="The request is over 10 MB."),
            503: OpenApiResponse(description="The render ran past its deadline."),
            429: OpenApiResponse(
                description="A PDF or background report for this user is being "
                "made, or the server is making as many as it may."
            ),
        },
    )


def describe_schema(rt: ReportType):
    return extend_schema(
        methods=["GET"],
        summary=f"What a {rt.label.lower()} report can hold",
        description=(
            "The list columns (the list's catalog with custom fields), group-by keys, "
            "and each section with its columns and whether the reader may view it."
        ),
        tags=["reports"],
        request=None,
        responses={200: OpenApiTypes.OBJECT},
    )


def file_schema(rt: ReportType):
    return extend_schema(
        summary=f"A {rt.label.lower()} report made with ?print=1",
        description=(
            "The PDF behind a print link, for five minutes, to the user and tenant "
            "that made it; inline, or as a download with `?download=1`."
        ),
        tags=["reports"],
        parameters=[
            OpenApiParameter(
                name="download", type=OpenApiTypes.BOOL, location=OpenApiParameter.QUERY
            )
        ],
        request=None,
        responses={
            (200, "application/pdf"): OpenApiTypes.BINARY,
            404: OpenApiResponse(description="No such link."),
        },
    )


def job_schema(rt: ReportType):
    return extend_schema(
        summary=f"A background {rt.label.lower()} report's state",
        description=(
            "`{state, progress?, url?, detail?}`: `state` is `queued`, `waiting`, "
            "`running`, `done` or `failed`; `progress` (0-95) is the render's time so far "
            "against its estimate; `url` the PDF once done; `detail` why it failed. Only "
            "to the user and tenant that asked for it."
        ),
        tags=["reports"],
        request=None,
        responses={200: OpenApiTypes.OBJECT, 404: OpenApiResponse(description="No such job.")},
    )


def job_file_schema(rt: ReportType):
    return extend_schema(
        summary=f"A background {rt.label.lower()} report's PDF",
        description=(
            "The finished PDF, kept for an hour to the user and tenant that asked for "
            "it; inline, or as a download with `?download=1`."
        ),
        tags=["reports"],
        parameters=[
            OpenApiParameter(
                name="download", type=OpenApiTypes.BOOL, location=OpenApiParameter.QUERY
            )
        ],
        request=None,
        responses={
            (200, "application/pdf"): OpenApiTypes.BINARY,
            404: OpenApiResponse(description="No such report, or not done."),
        },
    )
