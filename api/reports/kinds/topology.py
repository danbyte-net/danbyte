"""The topology report: ``GET|POST /api/topology/report/``.

One PDF of one or more topology views: an optional cover, the contents, and
for each view its diagram and tables of what is on it - the devices (name,
role, type, site, primary IP, status), their IP addresses, and the cables
between them (both ends with their ports, type, length, label).

**The drawing is the Export's.** The browser draws each view as the map's
**Export ▸ PDF** draws it (``frontend/src/lib/diagram/pdf-drawing.ts``) and
posts the SVG with the devices it shows; the server sanitises it and puts it
on paper with :func:`api.topology_export.topology_sheet`, the function the
Export's PDF uses, so the two never drift apart. The report only adds the
cover, the chapters and the tables around that sheet.

**What is read.** The devices are the ones the drawing shows, read through
the devices list as the reader's list would read them (``list_view``), so a
device the reader may not view is dropped and never named. Their addresses
and cables are read through the IP address and cable lists the same way. A
saved view's id is read through the topology views list; one the reader may
not view is dropped. Nothing is written or audited.

**Limits** are the object reports' (``api/object_report.py``): the render
slots and deadline, the row caps, the estimate (each drawing costs
``SECONDS_PER_DIAGRAM``), and the background job for a report past the
in-request budget. A bulk report holds at most ``MAX_VIEWS`` views, as one
PDF with a chapter a view (the default) or a ZIP of one PDF a view.
"""

from __future__ import annotations

import io
import json
import logging
import secrets
import time
import zipfile
from html import escape

from django.core.cache import cache
from django.db.models import Q
from django.http import HttpResponse
from django.urls import reverse
from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from ... import object_report as rep
from ... import topology_export as tx
from ...drawing_pdf import (
    MARGIN_MM as SHEET_MARGIN_MM,
)
from ...drawing_pdf import (
    MAX_BODY_BYTES,
    MAX_PDF_BYTES,
    SHEET_CSS,
    PdfUrlFetcher,
    RenderTimeout,
    body_too_large,
    deliver,
    detail,
    drawing_url,
    file_mime,
    file_name,
    file_slug,
    flag,
    kept_pdf,
    release,
    render_guarded,
    run_with_deadline,
    stamp,
)
from ...svg_sanitize import MAX_SVG_BYTES, SvgRejected, sanitize_svg
from ..cover import BACKGROUND_CHOICES, cover_for_request, look_for
from ..divider import Chapter, compact_html, divider_css, divider_html
from ..engine import BOTTOM_MM, MARGIN_MM, ReportContext, document_html, page_size
from ..marking import marking_for
from ..registry import ReportKind, SectionSpec, register_kind, register_section, sections_for
from ..toc import TOC_CSS, TocEntry, toc_html

log = logging.getLogger(__name__)

SLUG = "topology"
#: Views one report may hold.
MAX_VIEWS = 20
#: Devices a view's tables may list.
MAX_DEVICES = rep.MAX_OBJECTS
#: About how long WeasyPrint takes for a drawing's page.
SECONDS_PER_DIAGRAM = 0.4
PAPERS = ("a4", "letter", "a3")
OUTPUTS = ("pdf", "zip")
DIVIDERS = ("auto", "full", "compact")

DEVICES = register_section(
    SectionSpec(
        key="devices",
        label="Devices",
        applies_to=("topology_view",),
        rbac=("device",),
        path="/api/devices/",
        columns=("name", "role", "device_type", "site", "primary_ip", "status"),
    )
)
IPS = register_section(
    SectionSpec(
        key="ip_addresses",
        label="IP addresses",
        applies_to=("topology_view",),
        rbac=("ipaddress",),
        path="/api/ips/",
        columns=(
            "ip_address",
            "status",
            "role",
            "assigned_device",
            "assigned_interface",
            "vrf",
            "dns_name",
        ),
    )
)
CABLES = register_section(
    SectionSpec(
        key="cables",
        label="Cabling",
        applies_to=("topology_view",),
        rbac=("cable",),
        path="/api/cables/",
        columns=("label", "a_terminations", "b_terminations", "type", "length", "status"),
    )
)
DIAGRAM = register_section(
    SectionSpec(key="diagram", label="Diagram", applies_to=("topology_view",), rbac=("device",))
)
KIND = register_kind(
    ReportKind(
        slug=SLUG,
        label="Topology report",
        scope="topology_view",
        sections=("diagram", "devices", "ip_addresses", "cables"),
        path="/api/topology/report/",
    )
)
TABLE_SECTIONS = {s.key: s for s in (DEVICES, IPS, CABLES)}


# ─── The request ────────────────────────────────────────────────────────────


class TopologyReportViewSerializer(serializers.Serializer):
    """One view as the browser drew it."""

    view = serializers.UUIDField(required=False, allow_null=True)
    title = serializers.CharField(max_length=200, required=False, allow_blank=True)
    filters = serializers.CharField(max_length=500, required=False, allow_blank=True)
    svg = serializers.CharField(
        trim_whitespace=False, max_length=MAX_SVG_BYTES, required=False, allow_blank=True
    )
    device_ids = serializers.ListField(
        child=serializers.UUIDField(), max_length=MAX_DEVICES, required=False, default=list
    )


class TopologyReportOptionsSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=200, required=False, allow_blank=True)
    paper = serializers.ChoiceField(choices=PAPERS, required=False, default="a4")
    orientation = serializers.ChoiceField(
        choices=rep.ORIENTATIONS, required=False, default="portrait"
    )
    diagram_orientation = serializers.ChoiceField(
        choices=rep.ORIENTATIONS, required=False, default="landscape"
    )
    title_block = serializers.BooleanField(required=False, default=True)
    toc = serializers.BooleanField(required=False, allow_null=True, default=None)
    dividers = serializers.ChoiceField(choices=DIVIDERS, required=False, default="auto")
    output = serializers.ChoiceField(choices=OUTPUTS, required=False, default="pdf")
    cover = serializers.BooleanField(required=False, default=False)
    cover_title = serializers.CharField(max_length=200, required=False, allow_blank=True)
    cover_subtitle = serializers.CharField(max_length=300, required=False, allow_blank=True)
    cover_project = serializers.CharField(max_length=200, required=False, allow_blank=True)
    cover_background = serializers.ChoiceField(
        choices=BACKGROUND_CHOICES, required=False, default="default"
    )


class TopologyReportRequestSerializer(serializers.Serializer):
    views = TopologyReportViewSerializer(many=True)
    sections = serializers.ListField(
        child=serializers.ChoiceField(choices=list(KIND.sections)), required=False
    )
    columns = serializers.DictField(
        child=serializers.ListField(
            child=serializers.CharField(max_length=80), max_length=rep.MAX_COLUMNS
        ),
        required=False,
    )
    options = TopologyReportOptionsSerializer(required=False)

    def validate_views(self, value):
        if not value:
            raise serializers.ValidationError("Report on at least one view.")
        if len(value) > MAX_VIEWS:
            raise serializers.ValidationError(f"A report holds at most {MAX_VIEWS} views.")
        return value


def validated(raw) -> dict:
    ser = TopologyReportRequestSerializer(data=raw)
    ser.is_valid(raise_exception=True)
    data = dict(ser.validated_data)
    if "options" not in data:
        opts = TopologyReportOptionsSerializer(data={})
        opts.is_valid(raise_exception=True)
        data["options"] = opts.validated_data
    data["options"] = dict(data["options"])
    data["views"] = [dict(v) for v in data["views"]]
    if data.get("sections") is None:
        data["sections"] = [s.key for s in sections_for(KIND) if s.default]
    return data


# ─── Reading ────────────────────────────────────────────────────────────────


def _tenant(request):
    return rep._tenant(request)


def _gate(request):
    """The tenant, when the reader may draw the topology (device.view, as
    the Export's PDF needs)."""
    from auth_api import rbac

    tenant = _tenant(request)
    if rbac.row_filter(request.user, tenant, "device", "view") is None:
        raise PermissionDenied("device.view required.")
    return tenant


def _cable_narrow(ids):
    """Cables between the drawing's devices: at least one end on one of
    them, and none on a device off the drawing."""
    from ...models import CableTermination

    ends = ("interface", "front_port", "rear_port", "console_port", "console_server_port")
    on = Q()
    for e in ends:
        on |= Q(**{f"{e}__device__in": ids})
    off = Q()
    for e in ends:
        off |= Q(**{f"{e}__isnull": False}) & ~Q(**{f"{e}__device__in": ids})
    elsewhere = CableTermination.objects.filter(off).values("cable_id")

    def narrow(qs):
        mine = CableTermination.objects.filter(on).values("cable_id")
        return qs.filter(pk__in=mine).exclude(pk__in=elsewhere)

    return narrow


def _views_seen(request, ids: list[str]) -> dict[str, str]:
    """``{id: name}`` of the saved views among ``ids`` the reader may view."""
    if not ids:
        return {}
    view = rep.list_view(request, "/api/topology-views/", {"picker": "1"})
    if view is None:
        return {}
    rows, _ = rep.read_rows(
        view, limit=MAX_VIEWS, narrow=lambda qs: qs.filter(pk__in=ids)
    )
    return {str(r["id"]): r.get("name") or "" for r in rows}


def describe(request) -> Response:
    """``GET``: what a topology report can hold for this reader, in the
    object reports' shape, so the same dialog picks it."""
    tenant = _gate(request)
    ctx = rep.Context(request, rep.DEVICE, tenant)
    sections = [
        {
            "key": "diagram",
            "label": "Diagram",
            "kind": "diagram",
            "default": True,
            "available": True,
            "last": False,
            "columns": [],
            "default_columns": [],
        }
    ]
    for spec in (DEVICES, IPS, CABLES):
        cat = ctx.catalog(spec.path)
        ok = cat is not None
        sections.append(
            {
                "key": spec.key,
                "label": spec.label,
                "kind": "table",
                "default": spec.default,
                "available": ok,
                **({} if ok else {"note": f"You may not view {spec.label.lower()}."}),
                "last": False,
                "columns": [c.payload() for c in (cat or {}).values()],
                "default_columns": [k for k in spec.columns if k in (cat or {})],
            }
        )
    return Response(
        {
            "type": SLUG,
            "label": "Topology view",
            "plural": "Topology views",
            "columns": [],
            "default_columns": [],
            "group_by": [],
            "default_group_by": None,
            "sections": sections,
            "papers": list(PAPERS),
            "show_ips": False,
            "cover": rep._cover_info(tenant),
            "limits": {
                "objects": MAX_VIEWS,
                "object_pages": MAX_VIEWS,
                "section_rows": rep.MAX_SECTION_ROWS,
                "total_rows": rep.MAX_TOTAL_ROWS,
                "columns": rep.MAX_COLUMNS,
                "last": rep.MAX_LAST,
                "devices": MAX_DEVICES,
                "cells": rep.cells_that_fit(),
                "background_cells": rep.cells_that_fit(0, rep.job_budget()),
            },
        }
    )


# ─── Building ───────────────────────────────────────────────────────────────


class Report:
    """A topology report, built: each document's body and what it costs."""

    def __init__(self, title: str):
        self.title = title
        #: ``[(title, body html, toc entries, chapters)]``, one a document.
        self.docs: list[dict] = []
        self.cells = 0
        self.diagrams = 0
        self.dividers = 0

    @property
    def shape(self) -> dict:
        return {"pages": self.diagrams + self.dividers, "rows": 0, "list_columns": 0}


def _table_section(ctx, spec: SectionSpec, ids, columns, budget) -> tuple[str, str]:
    """``(html, note)`` of one table section of a view."""
    view = ctx.view(spec.path)
    if view is None:
        return "", f"{spec.label} left out: you may not view them."
    if not ids:
        return "<p class='muted'>None.</p>", ""
    if spec is DEVICES:
        narrow = lambda qs: qs.filter(pk__in=ids)  # noqa: E731
    elif spec is IPS:
        narrow = lambda qs: qs.filter(assigned_device__in=ids)  # noqa: E731
    else:
        narrow = _cable_narrow(ids)
    limit = budget.take(rep.MAX_SECTION_ROWS)
    rows, total = rep.read_rows(view, limit=limit, narrow=narrow)
    cat = ctx.catalog(spec.path) or {}
    cols = rep.pick(cat, columns.get(spec.key), spec.columns)
    html = rep.table_html(rows, cols) if rows else "<p class='muted'>None.</p>"
    return html, rep._left_out(total, len(rows), spec.label.lower())


def diagram_page(
    svg: bytes,
    *,
    entry: dict,
    tenant,
    generated,
    paper: str,
    orientation: str,
    title_block: bool,
    src: str,
    anchor: str,
    bookmark: str,
    level: int,
) -> str:
    """A view's diagram page: the Export's sheet (:func:`api.topology_export.topology_sheet`,
    the same function with the same drawing, title and filters), on a
    named page of the drawing's orientation."""
    sheet = tx.topology_sheet(
        svg,
        title=entry["title"],
        tenant=tenant.name,
        filters=entry.get("filters") or "",
        generated=generated,
        paper=paper,
        orientation=orientation,
        title_block=title_block,
        src=src,
        page_label="",
        attrs=(
            f"id='{escape(anchor)}' style=\"bookmark-level:{level};"
            f"bookmark-label:'{escape(bookmark).replace(chr(39), '')}'\""
        ),
    )
    return f"<section class='diagram-page diagram-{orientation}'>{sheet.html}</section>"


def _diagram_css(paper: str) -> str:
    """Each orientation's named page for the diagram, with the sheet's
    margins, so the Export's sheet fits it exactly."""
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    out = [SHEET_CSS]
    for o in rep.ORIENTATIONS:
        pw, ph = page_size(paper, o)
        out.append(
            f"@page diagram-{o}{{size:{mm(pw)} {mm(ph)};margin:{mm(SHEET_MARGIN_MM)}}}"
            f"section.diagram-{o}{{page:diagram-{o};break-before:page;break-after:page}}"
        )
    return "".join(out)


def build(request, data: dict, tenant, *, svgs: list[bytes] | None = None) -> Report | Response:
    """The report ``data`` asks for, or the refusal. With ``svgs`` (the
    sanitised drawings, one a view) the diagram pages are laid out; without,
    they are only counted (the estimate)."""
    options = data["options"]
    columns = data.get("columns") or {}
    keys = [k for k in data["sections"] if k in KIND.sections]
    ctx = rep.Context(request, rep.DEVICE, tenant)
    if ctx.view("/api/devices/") is None:
        raise PermissionDenied("You may not view devices.")
    seen = _views_seen(request, [str(v["view"]) for v in data["views"] if v.get("view")])
    entries = []
    for i, v in enumerate(data["views"]):
        if v.get("view") and str(v["view"]) not in seen:
            continue  # a saved view the reader may not view: dropped, never named
        title = (v.get("title") or "").strip() or seen.get(str(v.get("view")), "") or "Topology"
        entries.append({**v, "index": i, "title": title})
    if not entries:
        return detail("No topology views to report on.", 400)
    many = len(entries) > 1
    title = (options.get("title") or "").strip() or (
        "Topology report" if many else entries[0]["title"]
    )
    report = Report(title)
    budget = rep.Budget(rep.MAX_TOTAL_ROWS)
    generated = timezone.now()
    look = look_for(tenant)
    paper = options.get("paper") or "a4"
    pw, _ph = page_size(paper, options.get("orientation") or "portrait")
    dividers = options.get("dividers") or "auto"
    split = options.get("output") == "zip" and many
    groups = [[e] for e in entries] if split else [entries]
    for group in groups:
        doc_title = group[0]["title"] if split else title
        body, toc = [], []
        chapter_no = 0
        for e in group:
            ids = [str(x) for x in e.get("device_ids") or []]
            prefix = f"v{e['index'] + 1}"
            per_view_chapter = len(group) > 1
            if per_view_chapter:
                chapter_no += 1
                anchor = f"{prefix}"
                items = [TABLE_SECTIONS[k].label if k != "diagram" else "Diagram" for k in keys]
                ch = Chapter(anchor, chapter_no, e["title"], e.get("filters") or "", items)
                toc.append(TocEntry(anchor, e["title"], 1, str(chapter_no)))
                if dividers == "compact":
                    body.append(compact_html(ch, look, pw, first=not body))
                else:
                    body.append(divider_html(ch, look, pw, _ph, marking=data.get("_marking")))
                    report.dividers += 1
            for key in keys:
                anchor = f"{prefix}-{key}"
                label = "Diagram" if key == "diagram" else TABLE_SECTIONS[key].label
                if per_view_chapter:
                    toc.append(TocEntry(anchor, label, 2))
                else:
                    chapter_no += 1
                    toc.append(TocEntry(anchor, label, 1, str(chapter_no)))
                if key == "diagram":
                    report.diagrams += 1
                    if svgs is not None:
                        body.append(
                            diagram_page(
                                svgs[e["index"]],
                                entry=e,
                                tenant=tenant,
                                generated=generated,
                                paper=paper,
                                orientation=options.get("diagram_orientation") or "landscape",
                                title_block=options.get("title_block", True),
                                src=drawing_url(e["index"]),
                                anchor=anchor,
                                bookmark=label if not per_view_chapter else f"{e['title']}: {label}",
                                level=2 if per_view_chapter else 1,
                            )
                        )
                    continue
                spec = TABLE_SECTIONS[key]
                html, note = _table_section(ctx, spec, ids, columns, budget)
                count = f"<span>{len(ids):,} on the map</span>" if key == "devices" else ""
                if per_view_chapter:
                    head = f"<h2 class='section' id='{anchor}'>{escape(label)}</h2>"
                elif dividers == "full":
                    ch = Chapter(anchor, chapter_no, label)
                    head = divider_html(ch, look, pw, _ph, marking=data.get("_marking"))
                    report.dividers += 1
                else:
                    ch = Chapter(anchor, chapter_no, label)
                    head = compact_html(ch, look, pw, first=not body)
                note_html = f"<p class='muted'>{escape(note)}</p>" if note else ""
                body.append(
                    f"<section class='topo-section'>{head}{count and f'<h3>{count}</h3>'}"
                    f"{html}{note_html}</section>"
                )
        if budget.left == 0:
            body.append(
                f"<p class='muted'>The report reached its {rep.MAX_TOTAL_ROWS:,} rows; "
                "later sections are cut short.</p>"
            )
        html = "".join(body)
        report.cells += html.count("<td")
        report.docs.append(
            {"title": doc_title, "body": html, "toc": toc, "views": group, "generated": generated}
        )
    return report


def wants_toc(options: dict, toc: list) -> bool:
    on = options.get("toc")
    chapters = sum(1 for e in toc if e.level == 1)
    return chapters >= 2 if on is None else bool(on) and bool(toc)


def page_html(request, data: dict, tenant, doc: dict) -> str:
    """One document's whole page: cover, contents, body."""
    options = data["options"]
    paper = options.get("paper") or "a4"
    orientation = options.get("orientation") or "portrait"
    marking = data.get("_marking")
    ctx = ReportContext(
        title=doc["title"],
        tenant=tenant.name,
        generated=doc["generated"],
        paper=paper,
        orientation=orientation,
        marking=marking,
    )
    pw, ph = ctx.size
    ctx.extra_css += [
        _diagram_css(paper),
        divider_css(pw, ph, MARGIN_MM, BOTTOM_MM),
        TOC_CSS,
        "section.topo-section h3{margin:0 0 2mm;font-weight:400;color:#71717a}",
    ]
    cover = ""
    if options.get("cover"):
        n = len(doc["views"])
        subtitle = options.get("cover_subtitle")
        if subtitle is None:
            subtitle = "Topology" if n == 1 else f"{n} topology views"
        cover = cover_for_request(
            request,
            tenant,
            title=(options.get("cover_title") or "").strip() or doc["title"],
            pw=pw,
            ph=ph,
            project=(options.get("cover_project") or "").strip(),
            subtitle=subtitle.strip(),
            background=options.get("cover_background") or "default",
            when=doc["generated"],
            marking=marking,
        )
    head = ""
    if not cover:
        facts = [("Tenant", tenant.name), ("Generated", stamp(doc["generated"]))]
        if len(doc["views"]) > 1:
            facts.append(("Views", f"{len(doc['views']):,}"))
        head = rep._header_html(doc["title"], facts)
    contents = toc_html(doc["toc"]) if wants_toc(options, doc["toc"]) else ""
    return document_html(ctx, f"{head}{contents}{doc['body']}", cover=cover)


# ─── Estimating ─────────────────────────────────────────────────────────────


def estimate_seconds(report: Report, cover: bool) -> float:
    pages = report.dividers + (len(report.docs) if cover else 0)
    return rep.estimate_seconds(report.cells, pages) + report.diagrams * SECONDS_PER_DIAGRAM


def estimate(report: Report, cover: bool) -> dict:
    seconds = estimate_seconds(report, cover)
    if seconds <= rep.RENDER_BUDGET:
        mode = "now"
    elif seconds <= rep.job_budget():
        mode = "background"
    else:
        mode = "too_large"
    pages = report.diagrams + report.dividers
    return {
        "cells": report.cells,
        "pages": pages,
        "seconds": round(seconds, 1),
        "mode": mode,
        "fits": {
            "now": rep.cells_that_fit(pages),
            "background": rep.cells_that_fit(pages, rep.job_budget()),
        },
    }


def too_large(report: Report, cover: bool) -> Response:
    fit = rep.cells_that_fit(report.diagrams + report.dividers, rep.job_budget())
    return detail(
        f"This report is too large to render in time: {report.cells:,} table cells and "
        f"{report.diagrams} drawings, and about {fit:,} cells fit. Report on fewer views, "
        "or leave out IP addresses or cabling.",
        400,
    )


# ─── Rendering ──────────────────────────────────────────────────────────────


def render_files(_svg: bytes, *, docs: list[tuple[str, str]], drawings: dict, zipped: bool):
    """The PDF of each ``(name, html)``: the one PDF, or a ZIP of them."""
    import weasyprint

    from ...drawing_pdf import BASE_URL

    fetcher = PdfUrlFetcher(b"", drawings)
    pdfs = [
        (name, weasyprint.HTML(string=html, base_url=BASE_URL, url_fetcher=fetcher).write_pdf())
        for name, html in docs
    ]
    if not zipped:
        return pdfs[0][1]
    buf = io.BytesIO()
    used = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, pdf in pdfs:
            stem, n = name, 2
            while name in used:
                name = stem.replace(".pdf", f"-{n}.pdf")
                n += 1
            used.add(name)
            zf.writestr(name, pdf)
    return buf.getvalue()


def _render(svg: bytes, **kwargs) -> bytes:
    # Looked up when called, so the child renders what this module names.
    return render_files(svg, **kwargs)


def render_with_deadline(*, timeout: float = rep.RENDER_TIMEOUT, **kwargs) -> bytes:
    return run_with_deadline(_render, b"", timeout=timeout, **kwargs)


def sanitized(data: dict) -> list[bytes]:
    """Each view's drawing, sanitised (``SvgRejected`` for one that is not
    a drawing or is past the caps); b"" where the diagram is left out."""
    if "diagram" not in data["sections"]:
        return [b"" for _ in data["views"]]
    out = []
    for v in data["views"]:
        if not (v.get("svg") or "").strip():
            raise SvgRejected("Each view needs its drawing.")
        out.append(sanitize_svg(v["svg"]))
    return out


def _files(request, data, tenant, report: Report, svgs: list[bytes]) -> dict:
    zipped = len(report.docs) > 1
    docs = [
        (
            file_name(d["title"], d["generated"], "topology"),
            page_html(request, data, tenant, d),
        )
        for d in report.docs
    ]
    drawings = {drawing_url(i): s for i, s in enumerate(svgs) if s}
    return {"docs": docs, "drawings": drawings, "zipped": zipped}


def _name(report: Report) -> str:
    generated = report.docs[0]["generated"]
    if len(report.docs) > 1:
        return f"{file_slug(report.title, 'topology')}-{generated:%Y-%m-%d}.zip"
    return file_name(report.title, generated, "topology")


def _print_key(user_id, tenant_id) -> str:
    return f"topology-report-print:{user_id}:{tenant_id}"


def _with_marking(request, tenant, data: dict) -> dict:
    data["_marking"] = marking_for(request, tenant, data["options"])
    return data


@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def topology_report_view(request):
    """``GET`` describes, ``POST`` makes the report: in the request when it
    is small, as a background job (202) when it is not; ``?estimate=1``
    says what it would cost."""
    if request.method == "GET":
        return describe(request)
    if body_too_large(request, MAX_BODY_BYTES):
        return detail("The request is over 10 MB.", 413)
    tenant = _gate(request)
    data = _with_marking(request, tenant, validated(request.data))
    cover = bool(data["options"].get("cover"))
    built = build(request, data, tenant)
    if isinstance(built, Response):
        return built
    cost = estimate(built, cover)
    if flag(request, "estimate"):
        if cost["mode"] == "too_large":
            cost["detail"] = too_large(built, cover).data["detail"]
        return Response(cost)
    if cost["mode"] == "too_large":
        return too_large(built, cover)
    if cost["mode"] == "background":
        return start_job(request, tenant, data, cost["seconds"])
    holder: dict = {}

    def sanitize(_text: str) -> bytes:
        holder["svgs"] = sanitized(data)
        return b""

    def render(_svg: bytes) -> bytes:
        report = build(request, data, tenant, svgs=holder["svgs"])
        holder["report"] = report
        return render_with_deadline(**_files(request, data, tenant, report, holder["svgs"]))

    try:
        out = render_guarded(request, "", sanitize=sanitize, render=render)
    except RenderTimeout:
        log.warning("Topology report for user %s stopped after %ss", request.user.pk,
                    rep.RENDER_TIMEOUT)
        return detail(rep._RENDER_STOPPED, 503)
    if isinstance(out, Response):
        return out
    report = holder["report"]
    return deliver(
        request,
        out,
        name=_name(report),
        key=_print_key(request.user.pk, tenant.pk),
        link=lambda token: reverse("topology-report-file", kwargs={"token": token}),
        label="Topology report",
    )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_report_file_view(request, token):
    tenant = _tenant(request)
    return kept_pdf(request, token, key=_print_key(request.user.pk, tenant.pk))


# ─── Background reports ─────────────────────────────────────────────────────
#
# As the object reports' (``api/object_report.py``): an RQ job on ``low``
# rebuilds the report as the user who asked, waits for their PDF lock and a
# background slot, and keeps the file for ``job_keep()`` seconds under a
# random token only that user in that tenant can read.


def start_job(request, tenant, data: dict, seconds: float) -> Response:
    import django_rq

    from auth_api.models import ApiToken

    token = secrets.token_urlsafe(32)
    pending = rep.JOB_PENDING_KEY.format(request.user.pk)
    try:
        if not cache.add(pending, token, rep._job_lifetime() + rep.job_timeout()):
            return detail("A report is already being made. Try again when it is ready.", 429)
        cache.set(
            rep.JOB_KEY.format(token),
            {
                "user": request.user.pk,
                "tenant": str(tenant.pk),
                "type": SLUG,
                "state": "queued",
                "seconds": seconds,
            },
            rep.job_keep(),
        )
    except Exception:  # noqa: BLE001 - the cache is down or too slow
        log.warning("topology report job not kept", exc_info=True)
        return detail("The report could not be queued. Try again in a minute.", 503)
    raw = {k: v for k, v in data.items() if k != "_marking"}
    auth = request.auth
    try:
        django_rq.get_queue("low").enqueue(
            run_job,
            token,
            request.user.pk,
            str(tenant.pk),
            auth.pk if isinstance(auth, ApiToken) else None,
            request.get_host(),
            request.is_secure(),
            json.loads(json.dumps(raw, default=str)),
            job_timeout=rep._job_lifetime(),
            result_ttl=rep.job_keep(),
            failure_ttl=rep.job_keep(),
            description="Topology PDF report",
        )
    except Exception:  # noqa: BLE001 - Redis is down
        log.warning("topology report job not queued", exc_info=True)
        release(pending, token)
        return detail("The report could not be queued. Try again in a minute.", 503)
    return Response(
        {
            "job": token,
            "state": "queued",
            "status": reverse("topology-report-job", kwargs={"token": token}),
            "seconds": seconds,
        },
        status=202,
    )


def run_job(token, user_id, tenant_id, auth_id, host, secure, raw) -> str:
    """The RQ job: the report ``raw`` asks for, rebuilt and rendered as
    ``user_id``, kept under ``token``."""

    def fail(msg: str) -> str:
        rep._job_update(token, state="failed", detail=msg)
        return "failed"

    try:
        if rep._job_get(token) is None:
            return "gone"
        request, tenant = rep.job_request(user_id, tenant_id, auth_id, host, secure)
        _gate(request)
        data = _with_marking(request, tenant, validated(raw))
        cover = bool(data["options"].get("cover"))
        try:
            svgs = sanitized(data)
        except SvgRejected as exc:
            return fail(str(exc))
        report = build(request, data, tenant, svgs=svgs)
        if isinstance(report, Response):
            return fail(str(report.data.get("detail") or "The report could not be made."))
        cost = estimate(report, cover)
        if cost["mode"] == "too_large":
            return fail(too_large(report, cover).data["detail"])
        rep._job_update(token, state="waiting", seconds=cost["seconds"])
        locks = rep._job_locks(user_id)
        if locks is None:
            return fail("Other PDFs are being made. Try again in a few minutes.")
        try:
            rep._job_update(token, state="running", started=time.time())
            out = render_with_deadline(
                timeout=rep.job_timeout(), **_files(request, data, tenant, report, svgs)
            )
        finally:
            for lock in locks:
                release(*lock)
        if len(out) > MAX_PDF_BYTES:
            return fail("The PDF is too large to keep. Report on fewer views.")
        cache.set(rep.JOB_PDF_KEY.format(token), out, rep.job_keep())
        rep._job_update(token, state="done", name=_name(report))
        return "done"
    except RenderTimeout:
        return fail(rep._RENDER_STOPPED)
    except PermissionDenied as exc:
        return fail(str(exc.detail))
    except serializers.ValidationError:
        return fail("The report's options are no longer valid.")
    except Exception:  # noqa: BLE001 - told to the dialog, logged here
        log.exception("topology report job failed")
        return fail("The report could not be made.")
    finally:
        release(rep.JOB_PENDING_KEY.format(user_id), token)


def _my_job(request, token: str) -> dict | None:
    from ...drawing_pdf import TOKEN

    if not TOKEN.match(token):
        return None
    tenant = _tenant(request)
    entry = rep._job_get(token)
    if (
        entry is None
        or entry.get("user") != request.user.pk
        or entry.get("tenant") != str(tenant.pk)
        or entry.get("type") != SLUG
    ):
        return None
    return entry


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_report_job_view(request, token):
    try:
        entry = _my_job(request, token)
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
        out["url"] = reverse("topology-report-job-file", kwargs={"token": token})
    if state == "failed":
        out["detail"] = entry.get("detail") or "The report could not be made."
    return Response(out)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_report_job_file_view(request, token):
    try:
        entry = _my_job(request, token)
        data = cache.get(rep.JOB_PDF_KEY.format(token)) if entry else None
    except PermissionDenied:
        raise
    except Exception:  # noqa: BLE001 - the cache is down or too slow
        return detail("Reports are unavailable right now.", 503)
    if entry is None or entry.get("state") != "done" or not isinstance(data, bytes):
        return detail("Not found.", 404)
    name = entry.get("name") or "topology.pdf"
    resp = HttpResponse(data, content_type=file_mime(name))
    how = "attachment" if flag(request, "download") else "inline"
    resp["Content-Disposition"] = f'{how}; filename="{name}"'
    resp["Cache-Control"] = "private, no-store"
    resp["X-Content-Type-Options"] = "nosniff"
    return resp
