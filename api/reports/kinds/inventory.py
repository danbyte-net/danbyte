"""The inventory report: ``GET|POST /api/inventory/report/``
(docs/dcim/stock.md → Inventory report).

One PDF of the tenant's inventory - the Inventory page's rows (items and
installed modules), scoped by the page's own filters: site, location,
status, kind, manufacturer, where it is, and the search box. It holds, as
the reader ticks them:

* **Totals** - how many by status, and by kind;
* **Counts** - how many of each part number (else name) per manufacturer,
  kind, site and location;
* **Items** - the appendix: every row with its serial, asset tag, status,
  place and device.

Plus the usual cover (``api.reports.cover``) and sensitivity marking.

**What is read.** The rows come through the Inventory list's own scope
(``api.inventory_list.scoped``): the tenant, and each source - items,
modules - cut to what the reader may view by its own grant, site scope
included. The filters are that list's ``f_<facet>`` and ``search``
parameters; an unknown one is a 400. Nothing is written or audited.

**Limits** are the object reports' (``api/object_report.py``): one render
per user and a few across the server, the render deadline, the print link.
A report past what renders in time is refused with what fits - narrow the
filters or leave out the items.
"""

from __future__ import annotations

import logging
from html import escape

from django.db.models import Count
from django.http import QueryDict
from django.urls import reverse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac

from ... import object_report as rep
from ...drawing_pdf import (
    MAX_BODY_BYTES,
    RenderTimeout,
    body_too_large,
    deliver,
    detail,
    file_name,
    flag,
    kept_pdf,
    reader_now,
    render_guarded,
    run_with_deadline,
    stamp,
)
from ...inventory_list import HOME_LABELS, KIND_LABELS, SPEC, _part, scoped, search
from ...natural import natural
from ...views import _get_active_tenant
from ..blocks import pill
from ..cover import cover_for_request
from ..engine import ReportContext, document_html, render
from ..marking import marking_for
from ..registry import ReportKind, SectionSpec, register_kind, register_section

log = logging.getLogger(__name__)

SLUG = "inventory"
SECTIONS = ("totals", "counts", "items")
PAPERS = ("a4", "letter", "a3")
ORIENTATIONS = ("portrait", "landscape")
#: Rows the items appendix may list.
MAX_ITEMS = rep.MAX_TOTAL_ROWS

for _key, _label in (("totals", "Totals"), ("counts", "Counts per part"), ("items", "Items")):
    register_section(SectionSpec(key=_key, label=_label, applies_to=("inventory",),
                                 rbac=("inventoryitem", "module"), path="/api/inventory/"))
KIND = register_kind(ReportKind(slug=SLUG, label="Inventory report", scope="inventory",
                                sections=SECTIONS, path="/api/inventory/report/"))


class InventoryReportOptionsSerializer(serializers.Serializer):
    paper = serializers.ChoiceField(PAPERS, required=False, default="a4")
    orientation = serializers.ChoiceField(ORIENTATIONS, required=False, default="portrait")
    cover = serializers.BooleanField(required=False, default=False)
    cover_title = serializers.CharField(required=False, allow_blank=True, max_length=200)
    cover_subtitle = serializers.CharField(required=False, allow_blank=True, max_length=200)
    cover_project = serializers.CharField(required=False, allow_blank=True, max_length=200)
    cover_background = serializers.CharField(required=False, allow_blank=True, max_length=32)
    sensitivity_label = serializers.CharField(required=False, allow_blank=True,
                                              allow_null=True, max_length=64)


class InventoryReportRequestSerializer(serializers.Serializer):
    title = serializers.CharField(required=False, allow_blank=True, max_length=200)
    #: The Inventory list's query parameters: ``f_<facet>`` and ``search``.
    filters = serializers.DictField(child=serializers.CharField(allow_blank=True,
                                                                max_length=4000),
                                    required=False, default=dict)
    sections = serializers.ListField(child=serializers.ChoiceField(SECTIONS),
                                     required=False, default=list(SECTIONS))
    options = InventoryReportOptionsSerializer(required=False, default=dict)


def _tenant(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant.")
    return tenant


def _gate(request):
    """The reader views items or modules, or there is nothing to report."""
    tenant = _tenant(request)
    if not any(rbac.has_action(request.user, tenant, slug, "view")
               for slug in ("inventoryitem", "module")):
        raise PermissionDenied("You may not view the inventory.")
    return tenant


def rows(request, tenant, filters: dict):
    """The Inventory list's rows for ``filters``, as that list reads them."""
    qs = scoped(request, tenant).select_related(
        "status", "manufacturer", "site", "location", "device", "interface", "module_bay")
    params = QueryDict(mutable=True)
    for k, v in filters.items():
        params[k] = v
    for key in params:
        if key == "search":
            continue
        if not key.startswith("f_") or key[2:] not in SPEC.facets:
            raise ValidationError({"filters": f"Unknown filter: {key}."})
        qs = SPEC.facets[key[2:]].filter(qs, request, params.get(key))
    needle = (params.get("search") or "").strip()
    if needle:
        qs = search(qs, needle)
    return qs


# ─── The page ───────────────────────────────────────────────────────────────

def _table(head: list[tuple[str, str]], body: list[list[str]]) -> str:
    ths = "".join(f"<th class='{cls}'>{escape(h)}</th>" for h, cls in head)
    trs = "".join("<tr>" + "".join(f"<td class='{cls}'>{c}</td>"
                                   for c, (_h, cls) in zip(r, head, strict=True)) + "</tr>"
                  for r in body)
    return f"<table class='grid'><thead><tr>{ths}</tr></thead><tbody>{trs}</tbody></table>"


def _e(v) -> str:
    return escape(str(v)) if v not in (None, "") else "-"


def _totals(qs) -> tuple[str, int]:
    by_status = (qs.order_by().values("status__name", "status__color")
                 .annotate(n=Count("pk")).order_by("-n", "status__name"))
    by_kind = qs.order_by().values("kind").annotate(n=Count("pk")).order_by("-n", "kind")
    status_rows = [[pill({"name": r["status__name"], "color": r["status__color"]})
                    if r["status__name"] else "No status", f"{r['n']:,}"] for r in by_status]
    kind_rows = [[_e(KIND_LABELS.get(r["kind"], r["kind"])), f"{r['n']:,}"] for r in by_kind]
    head = [("Status", ""), ("Count", "n")]
    html = (
        "<section class='summary'><h2>Totals</h2>"
        f"<div class='sumblock'><h3>By status</h3>{_table(head, status_rows)}</div>"
        f"<div class='sumblock'><h3>By kind</h3>"
        f"{_table([('Kind', ''), ('Count', 'n')], kind_rows)}</div></section>"
    )
    return html, 2 * (len(status_rows) + len(kind_rows))


def _counts(qs) -> tuple[str, int]:
    grouped = (_part(qs).order_by()
               .values("inv_part", "kind", "manufacturer__name", "site__name",
                       "location__name")
               .annotate(n=Count("pk"))
               .order_by(natural("inv_part"), natural("site__name"),
                         natural("location__name"), "kind"))
    body = [[f"<b>{_e(r['inv_part'])}</b>", _e(r["manufacturer__name"]),
             _e(KIND_LABELS.get(r["kind"], r["kind"])), _e(r["site__name"]),
             _e(r["location__name"]), f"{r['n']:,}"] for r in grouped[:MAX_ITEMS]]
    head = [("Part", ""), ("Manufacturer", ""), ("Kind", ""), ("Site", ""),
            ("Location", ""), ("Count", "n")]
    return (f"<section class='list'><h2>Counts per part</h2>{_table(head, body)}</section>",
            len(body) * len(head))


def _place(e) -> str:
    if e.device_id is None:
        return HOME_LABELS["stock"]
    slot = e.interface if e.interface_id else (e.module_bay if e.module_bay_id else None)
    return escape(" · ".join(x for x in (e.device.name, slot.name if slot else "") if x))


def _items(qs, total: int) -> tuple[str, int]:
    head = [("Name", ""), ("Part", ""), ("Serial", ""), ("Asset tag", ""), ("Status", ""),
            ("Device", ""), ("Site", ""), ("Location", "")]
    body = []
    for e in qs.order_by(natural("name"), "pk")[:MAX_ITEMS]:
        st = e.status if e.status_id else None
        body.append([
            _e(e.name), _e(e.part_id), _e(e.serial_number), _e(e.asset_tag),
            pill({"name": st.name, "color": st.color, "text_color": st.text_color})
            if st else "-",
            _place(e), _e(e.site.name if e.site_id else ""),
            _e(e.location.name if e.location_id else ""),
        ])
    left = total - len(body)
    more = f"<p class='muted'>{left:,} more left out.</p>" if left > 0 else ""
    return (f"<section class='list'><h2>Items</h2>{_table(head, body)}{more}</section>",
            len(body) * len(head))


#: A filter's header label, and the tenant's model its ids name.
_FACT_NAMES = {
    "home": ("Where", None), "kind": ("Kind", None), "status": ("Status", "Status"),
    "site": ("Site", "Site"), "location": ("Location", "Location"),
    "manufacturer": ("Manufacturer", "Manufacturer"), "device": ("Device", "Device"),
    "module_type": ("Module type", "ModuleType"),
}


def _filter_facts(tenant, filters: dict) -> list[tuple[str, str]]:
    """The filters in words, for the header: names, not ids - only the
    tenant's rows are named."""
    import uuid

    from django.apps import apps

    from ...list_table import NONE, decode_list

    facts = []
    for key, value in filters.items():
        if key == "search" and value.strip():
            facts.append(("Search", value.strip()))
            continue
        fid = key[2:]
        if fid not in _FACT_NAMES or not value:
            continue
        label, model_name = _FACT_NAMES[fid]
        wanted = decode_list(value)
        if model_name is None:
            labels = HOME_LABELS if fid == "home" else KIND_LABELS
            words = [labels.get(v, v) for v in wanted]
        else:
            ids = []
            for v in wanted:
                try:
                    ids.append(uuid.UUID(v))
                except ValueError:
                    continue
            names = dict(apps.get_model("api", model_name).objects.filter(
                tenant=tenant, pk__in=ids).values_list("pk", "name"))
            words = [names.get(i, "") for i in ids]
            words = [w for w in words if w] + (["None"] if NONE in wanted else [])
        if words:
            facts.append((label, ", ".join(words)))
    return facts


def build(request, data: dict, tenant) -> dict:
    qs = rows(request, tenant, data["filters"])
    total = qs.count()
    sections = data["sections"]
    parts, cells = [], 0
    if "totals" in sections:
        html, n = _totals(qs)
        parts.append(html)
        cells += n
    if "counts" in sections:
        html, n = _counts(qs)
        parts.append(html)
        cells += n
    if "items" in sections:
        html, n = _items(qs, total)
        parts.append(html)
        cells += n
    title = (data.get("title") or "").strip() or "Inventory report"
    return {"title": title, "body": "".join(parts), "cells": cells, "total": total,
            "generated": reader_now(request, tenant)}


def page_html(request, data: dict, tenant, report: dict) -> str:
    options = data["options"]
    marking = data.get("_marking")
    ctx = ReportContext(title=report["title"], tenant=tenant.name,
                        generated=report["generated"], paper=options.get("paper") or "a4",
                        orientation=options.get("orientation") or "portrait",
                        marking=marking)
    pw, ph = ctx.size
    cover = ""
    if options.get("cover"):
        cover = cover_for_request(
            request, tenant,
            title=(options.get("cover_title") or "").strip() or report["title"],
            pw=pw, ph=ph,
            project=(options.get("cover_project") or "").strip(),
            subtitle=(options.get("cover_subtitle") or "").strip()
            or f"{report['total']:,} parts",
            background=options.get("cover_background") or "default",
            when=report["generated"], marking=marking,
        )
    facts = [("Tenant", tenant.name), ("Generated", stamp(report["generated"])),
             ("Parts", f"{report['total']:,}"), *_filter_facts(tenant, data["filters"])]
    head = rep._header_html(report["title"], facts)
    return document_html(ctx, head + report["body"], cover=cover)


def estimate(report: dict) -> dict:
    seconds = rep.estimate_seconds(report["cells"])
    return {"cells": report["cells"], "rows": report["total"], "seconds": round(seconds, 1),
            "mode": "now" if seconds <= rep.RENDER_BUDGET else "too_large",
            "fits": {"now": rep.cells_that_fit()}}


def too_large(report: dict) -> Response:
    return detail(
        f"This report is too large to render in time: {report['cells']:,} table cells, and "
        f"about {rep.cells_that_fit():,} fit. Narrow the filters, or leave out the items.",
        400,
    )


def _render(_svg: bytes, *, html: str) -> bytes:
    return render(html)


def _print_key(user_id, tenant_id) -> str:
    return f"inventory-report-print:{user_id}:{tenant_id}"


def describe(request) -> Response:
    _gate(request)
    return Response({
        "kind": SLUG,
        "sections": [{"key": k, "label": dict(totals="Totals", counts="Counts per part",
                                              items="Items")[k]} for k in SECTIONS],
        "facets": sorted(SPEC.facets),
        "papers": list(PAPERS),
        "orientations": list(ORIENTATIONS),
        "max_items": MAX_ITEMS,
    })


@extend_schema(methods=["GET"], operation_id="inventory_report_describe",
               summary="What an inventory report can hold", request=None,
               responses={200: OpenApiTypes.OBJECT})
@extend_schema(methods=["POST"], operation_id="inventory_report_create",
               summary="Make the inventory report (PDF)",
               request=InventoryReportRequestSerializer,
               responses={(200, "application/pdf"): OpenApiTypes.BINARY,
                          200: OpenApiTypes.OBJECT})
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def inventory_report_view(request):
    """``GET`` describes, ``POST`` makes the report (``?estimate=1`` says
    what it would cost, ``?print=1`` keeps it for a print link)."""
    if request.method == "GET":
        return describe(request)
    if body_too_large(request, MAX_BODY_BYTES):
        return detail("The request is over 10 MB.", 413)
    tenant = _gate(request)
    ser = InventoryReportRequestSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    data = dict(ser.validated_data)
    data["options"] = dict(data.get("options") or {})
    data["_marking"] = marking_for(request, tenant, data["options"])
    report = build(request, data, tenant)
    cost = estimate(report)
    if flag(request, "estimate"):
        if cost["mode"] == "too_large":
            cost["detail"] = too_large(report).data["detail"]
        return Response(cost)
    if cost["mode"] == "too_large":
        return too_large(report)
    html = page_html(request, data, tenant, report)
    try:
        out = render_guarded(
            request, "", sanitize=lambda _t: b"",
            render=lambda _s: run_with_deadline(_render, b"", timeout=rep.RENDER_TIMEOUT,
                                                html=html))
    except RenderTimeout:
        log.warning("Inventory report for user %s stopped after %ss", request.user.pk,
                    rep.RENDER_TIMEOUT)
        return detail(rep._RENDER_STOPPED, 503)
    if isinstance(out, Response):
        return out
    return deliver(
        request, out,
        name=file_name(report["title"], report["generated"], "inventory"),
        key=_print_key(request.user.pk, tenant.pk),
        link=lambda token: reverse("inventory-report-file", kwargs={"token": token}),
        label="Inventory report",
    )


@extend_schema(operation_id="inventory_report_file", summary="A kept inventory report PDF",
               responses={(200, "application/pdf"): OpenApiTypes.BINARY})
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def inventory_report_file_view(request, token):
    tenant = _tenant(request)
    return kept_pdf(request, token, key=_print_key(request.user.pk, tenant.pk))
