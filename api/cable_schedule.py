"""A floor plan's cable schedule - the pull sheet.

``GET /api/floor-plans/{id}/cable-schedule/`` lists every cable with a
stored route on the plan or an end on a device placed on it: its label,
type, colour and status, both ends (device · port and the room it stands
in), its route (the trays it rides in order, and the riser it leaves the
floor by), and its length - the route's computed one, the cable's stored
one and where that came from - with its notes. Rows are grouped by the room
of the end on this floor, or by tray (a cable under every tray it rides);
totals per cable type count the cables and add up their metres. The page
turns the rows into CSV or XLSX with the table export.

``POST .../cable-schedule/pdf/`` lays the same schedule out on paper with
WeasyPrint: the drawing PDFs' sheet, fonts, locks and deadline
(``api/drawing_pdf.py``), and optionally a thumbnail of the plan with its
routes on the first page - the plan SVG the page draws, sanitised like the
floor-plan PDF's.

Visibility follows ``cable-paths``: only cables the reader may view are
listed, the others counted in ``hidden_count``; an end on a device the
reader may not view reads **Hidden** (#453); only tiles the reader may view
place a device, and only stored routes they may view are shown.
"""

from __future__ import annotations

import datetime as dt
import logging
from html import escape

from django.db.models import Prefetch, Q
from django.http import HttpResponse
from django.urls import reverse
from django.utils import timezone
from rest_framework import serializers
from rest_framework.response import Response

from .drawing_pdf import (
    BASE_URL,
    DIAGRAM_URL,
    MARGIN_MM,
    MAX_BODY_BYTES,
    PAPERS_MM,
    RENDER_TIMEOUT,
    DrawingPaperSerializer,
    PdfUrlFetcher,
    RenderTimeout,
    _font_faces,
    body_too_large,
    deliver,
    detail,
    file_name,
    kept_pdf,
    render_guarded,
    run_with_deadline,
    stamp,
)
from .svg_sanitize import MAX_SVG_BYTES, sanitize_svg

log = logging.getLogger(__name__)

GROUPS = ("room", "tray")
#: Millimetres in one of each ``Cable.length_unit``.
UNIT_MM = {"m": 1000.0, "cm": 10.0, "ft": 304.8, "in": 25.4}
NO_ROOM = "No room"
NO_TRAY = "No tray"
NO_TYPE = "No type"


def _metres(mm: float | None) -> float | None:
    return None if mm is None else round(mm / 1000, 2)


def build(plan, crop, user, tenant, *, group: str = "room") -> dict:
    """The schedule of ``plan`` (the source of a view, ``crop`` its part)
    as ``user`` may see it. See the module docstring."""
    from auth_api import rbac

    from . import floor_plan_snapshots as snaps
    from .cable_routing import riser_pairs
    from .cable_scope import viewable_cable_ids
    from .models import Cable, CableTermination, Device, FloorPlanCablePath

    if group not in GROUPS:
        group = "room"
    tiles = list(rbac.restrict_queryset(
        plan.tiles.order_by("y", "x", "id"), user, tenant, "floorplantile", "view"
    ))
    trays = list(plan.trays.order_by("name", "id"))
    if crop is not None:
        tiles = [t for t, _e in snaps.in_crop("tiles", tiles, crop)]
        trays = [t for t, _e in snaps.in_crop("trays", trays, crop)]
    tray_name = {t.pk: t.name for t in trays}
    device_tile, rack_tile, cabinet_tile = {}, {}, {}
    for t in tiles:
        if t.device_id:
            device_tile.setdefault(t.device_id, t)
        if t.rack_id:
            rack_tile.setdefault(t.rack_id, t)
        if t.cabinet_id:
            cabinet_tile.setdefault(t.cabinet_id, t)
    placed = set(device_tile)
    if rack_tile or cabinet_tile:
        placed.update(Device.objects.filter(
            Q(rack_id__in=rack_tile) | Q(cabinet_id__in=cabinet_tile)
        ).values_list("id", flat=True))
    touches = Q()
    for field in CableTermination.POINT_FIELDS:
        if field not in ("power_feed", "circuit_termination"):
            touches |= Q(**{f"terminations__{field}__device_id__in": placed})
    candidates = set(
        Cable.objects.filter(tenant=tenant)
        .filter(Q(floor_plan_paths__floor_plan=plan) | touches)
        .values_list("id", flat=True)
    )
    visible = viewable_cable_ids(user, tenant, candidates)
    cables = list(
        Cable.objects.filter(pk__in=visible)
        .select_related("status")
        .prefetch_related(
            Prefetch("terminations", queryset=CableTermination.objects.select_related(
                *CableTermination.POINT_FIELDS
            ).order_by("end", "created_at", "pk")),
            "trays",
        )
    )
    terms: dict = {}
    dev_ids = set()
    for c in cables:
        rows = []
        for term in c.terminations.all():
            point = term.point
            dev = getattr(point, "device_id", None)
            if dev:
                dev_ids.add(dev)
            rows.append((term.end, dev, getattr(point, "name", "") or str(point or "")))
        terms[c.pk] = rows
    devices = {
        d.pk: d for d in Device.objects.filter(pk__in=dev_ids).select_related(
            "room", "location", "rack__room", "cabinet__room"
        ).only(
            "id", "name", "rack_id", "cabinet_id", "room__name", "location__name",
            "rack__room__name", "cabinet__room__name",
        )
    }
    viewable = None if user.is_superuser else rbac.ViewableRows(user, tenant)
    if viewable is not None:
        viewable.prime("device", dev_ids)

    def on_floor(dev_id) -> bool:
        if dev_id is None:
            return False
        if dev_id in device_tile:
            return True
        d = devices.get(dev_id)
        return d is not None and (
            (d.rack_id is not None and d.rack_id in rack_tile)
            or (d.cabinet_id is not None and d.cabinet_id in cabinet_tile)
        )

    def room_of(d) -> str:
        for r in (d.room, getattr(d.rack, "room", None) if d.rack_id else None,
                  getattr(d.cabinet, "room", None) if d.cabinet_id else None):
            if r is not None:
                return r.name
        return d.location.name if d.location_id else ""

    def end_of(dev_id, port) -> dict:
        if dev_id is None:
            return {"device": "", "port": port, "room": "", "on_floor": False, "hidden": False}
        if viewable is not None and not viewable.may_view("device", dev_id):
            return {"device": None, "port": None, "room": None,
                    "on_floor": on_floor(dev_id), "hidden": True}
        d = devices.get(dev_id)
        return {
            "device": d.name if d else "", "port": port,
            "room": room_of(d) if d else "", "on_floor": on_floor(dev_id), "hidden": False,
        }

    paths = {
        p.cable_id: p for p in rbac.restrict_queryset(
            FloorPlanCablePath.objects.filter(floor_plan=plan, cable_id__in=visible)
            .select_related("riser"),
            user, tenant, "floorplancablepath", "view",
        )
    }
    pairs = riser_pairs(plan, [p.riser for p in paths.values() if p.riser is not None])

    out_rows = []
    for c in sorted(cables, key=lambda c: (str(c).lower(), str(c.pk))):
        ends = {"A": [], "B": []}
        for end, dev, port in terms.get(c.pk, []):
            if end in ends:
                ends[end].append(end_of(dev, port))
        p = paths.get(c.pk)
        if p is not None:
            trays_in = [tray_name[t] for t in _uuids(p.tray_order) if t in tray_name]
            route_source = "stored"
        else:
            trays_in = sorted(
                (t.name for t in c.trays.all() if t.floor_plan_id == plan.pk
                 and t.pk in tray_name), key=str.lower,
            )
            route_source = "trays" if trays_in else ""
        riser = None
        if p is not None and p.riser is not None:
            pair = pairs.get(p.riser.pk)
            riser = {
                "label": p.riser.label or "Riser",
                "floor": pair.floor_plan.name if pair is not None else "",
                "vertical_m": _metres(p.riser_mm),
            }
        route = " → ".join(trays_in)
        if riser is not None:
            hop = f"{riser['label']} to {riser['floor']}" if riser["floor"] else riser["label"]
            route = f"{route} → {hop}" if route else hop
        stored_mm = (
            float(c.length) * UNIT_MM.get(c.length_unit or "m", 1000.0)
            if c.length is not None else None
        )
        here = "A" if any(e["on_floor"] for e in ends["A"]) else (
            "B" if any(e["on_floor"] for e in ends["B"]) else None
        )
        rooms = sorted({
            e["room"] for e in ends[here] if e["on_floor"] and not e["hidden"] and e["room"]
        }) if here else []
        if here and any(e["on_floor"] and e["hidden"] for e in ends[here]) and not rooms:
            rooms = ["Hidden"]
        st = c.status
        out_rows.append({
            "id": str(c.pk),
            "label": str(c),
            "type": c.type,
            "type_display": c.get_type_display() if c.type else "",
            "color": c.color,
            "status": None if st is None else {
                "name": st.name, "color": st.color, "text_color": st.text_color,
            },
            "a": ends["A"],
            "b": ends["B"],
            "trays": trays_in,
            "route": route,
            "route_source": route_source,
            "riser": riser,
            "computed_m": _metres(p.length_mm) if p is not None and p.length_mm else None,
            "length": float(c.length) if c.length is not None else None,
            "length_unit": c.length_unit or "m",
            "length_m": _metres(stored_mm),
            "length_source": (
                ("computed" if c.length_source == "computed" else "entered")
                if c.length is not None else ""
            ),
            "notes": c.description or "",
            "rooms": rooms,
        })

    groups: dict = {}
    for row in out_rows:
        keys = (row["rooms"] or [NO_ROOM]) if group == "room" else (row["trays"] or [NO_TRAY])
        for k in keys[:1] if group == "room" else keys:
            groups.setdefault(k, []).append(row["id"])
    last = {NO_ROOM, NO_TRAY}
    ordered = sorted(groups, key=lambda k: (k in last, k.lower()))

    totals: dict = {}
    for row in out_rows:
        key = row["type"] or ""
        t = totals.setdefault(key, {
            "type": key, "label": row["type_display"] or NO_TYPE,
            "count": 0, "metres": 0.0, "unmeasured": 0,
        })
        t["count"] += 1
        m = row["length_m"] if row["length_m"] is not None else row["computed_m"]
        if m is None:
            t["unmeasured"] += 1
        else:
            t["metres"] += m
    total_rows = sorted(totals.values(), key=lambda t: (t["label"] == NO_TYPE, t["label"].lower()))
    for t in total_rows:
        t["metres"] = round(t["metres"], 2)
    return {
        "group": group,
        "rows": out_rows,
        "groups": [{"name": k, "rows": groups[k]} for k in ordered],
        "totals": total_rows,
        "total": {
            "count": len(out_rows),
            "metres": round(sum(t["metres"] for t in total_rows), 2),
            "unmeasured": sum(t["unmeasured"] for t in total_rows),
        },
        "hidden_count": len(candidates - visible),
    }


def _uuids(ids) -> list:
    import uuid as _uuid

    out = []
    for i in ids or []:
        try:
            out.append(_uuid.UUID(str(i)))
        except ValueError:
            continue
    return out


# ─── Paper ──────────────────────────────────────────────────────────────────


def end_text(ends: list[dict]) -> str:
    parts = []
    for e in ends:
        if e["hidden"]:
            parts.append("Hidden")
        else:
            parts.append(" · ".join(p for p in (e["device"], e["port"]) if p))
    return ", ".join(p for p in parts if p)


def room_text(ends: list[dict]) -> str:
    return ", ".join(sorted({e["room"] for e in ends if not e["hidden"] and e["room"]}))


def length_text(row: dict) -> tuple[str, str, str]:
    computed = f"{row['computed_m']:g} m" if row["computed_m"] is not None else ""
    stored = f"{row['length']:g} {row['length_unit']}" if row["length"] is not None else ""
    source = {"computed": "Computed", "entered": "Entered"}.get(row["length_source"], "")
    return computed, stored, source


def _swatch(color: str) -> str:
    if not color or len(color) != 7 or not color.startswith("#"):
        return ""
    try:
        int(color[1:], 16)
    except ValueError:
        return ""
    return f"<i class='sw' style='background:{color}'></i>"


def sheet_html(data: dict, *, title: str, subtitle: str, generated: dt.datetime,
               paper: str, orientation: str, thumbnail: bool) -> str:
    from danbyte import __version__

    pw, ph = PAPERS_MM[paper]
    if orientation == "portrait":
        pw, ph = ph, pw
    rows = {r["id"]: r for r in data["rows"]}
    group_word = "Room" if data["group"] == "room" else "Tray"
    head = (
        "<tr><th>Cable</th><th>Type</th><th>Status</th><th>A end</th><th>A room</th>"
        "<th>B end</th><th>B room</th><th>Route</th><th class='n'>Computed</th>"
        "<th class='n'>Stored</th><th>Source</th><th>Notes</th></tr>"
    )
    body = []
    for g in data["groups"]:
        trs = []
        for rid in g["rows"]:
            r = rows[rid]
            computed, stored, source = length_text(r)
            status = escape(r["status"]["name"]) if r["status"] else ""
            trs.append(
                "<tr>"
                f"<td class='b'>{_swatch(r['color'])}{escape(r['label'])}</td>"
                f"<td>{escape(r['type_display'])}</td>"
                f"<td>{status}</td>"
                f"<td>{escape(end_text(r['a']))}</td>"
                f"<td>{escape(room_text(r['a']))}</td>"
                f"<td>{escape(end_text(r['b']))}</td>"
                f"<td>{escape(room_text(r['b']))}</td>"
                f"<td>{escape(r['route'])}</td>"
                f"<td class='n'>{escape(computed)}</td>"
                f"<td class='n'>{escape(stored)}</td>"
                f"<td>{escape(source)}</td>"
                f"<td class='notes'>{escape(r['notes'])}</td>"
                "</tr>"
            )
        n = len(g["rows"])
        body.append(
            f"<h2>{escape(group_word)}: {escape(g['name'])} "
            f"<span>{n} {'cable' if n == 1 else 'cables'}</span></h2>"
            f"<table><thead>{head}</thead><tbody>{''.join(trs)}</tbody></table>"
        )
    if not data["groups"]:
        body.append("<p class='empty'>No cables on this floor.</p>")
    tot = "".join(
        f"<tr><td>{escape(t['label'])}</td><td class='n'>{t['count']}</td>"
        f"<td class='n'>{t['metres']:g} m</td>"
        f"<td class='n'>{t['unmeasured'] or ''}</td></tr>"
        for t in data["totals"]
    )
    total = data["total"]
    tot += (
        f"<tr class='sum'><td>All</td><td class='n'>{total['count']}</td>"
        f"<td class='n'>{total['metres']:g} m</td>"
        f"<td class='n'>{total['unmeasured'] or ''}</td></tr>"
    )
    hidden = data["hidden_count"]
    hidden_line = (
        f"<p class='hidden'>{hidden} {'cable' if hidden == 1 else 'cables'} hidden "
        "- not listed or counted above.</p>" if hidden else ""
    )
    small = " · ".join((stamp(generated), f"Danbyte {__version__}"))
    thumb = (
        f"<div class='thumb'><img src='{DIAGRAM_URL}' alt=''></div>" if thumbnail else ""
    )
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{escape(title)} - cable schedule</title>"
        f"<meta name='generator' content='Danbyte {escape(__version__)}'>"
        "<style>"
        f"{_font_faces()}"
        f"@page{{size:{mm(pw)} {mm(ph)};margin:{mm(MARGIN_MM)} {mm(MARGIN_MM)} 14mm;"
        "@bottom-left{content:'" + _css_str(f"{title} · {small}") + "';"
        "font-family:Inter,'DejaVu Sans',sans-serif;font-size:6.5pt;color:#71717a}"
        "@bottom-right{content:'Page ' counter(page) ' / ' counter(pages);"
        "font-family:Inter,'DejaVu Sans',sans-serif;font-size:6.5pt;color:#71717a}}"
        "html,body{margin:0;padding:0}"
        "body{font-family:Inter,'DejaVu Sans',sans-serif;color:#18181b;font-size:7pt}"
        "h1{font-size:13pt;margin:0 0 0.5mm}"
        ".sub{color:#52525b;font-size:8pt;margin-bottom:4mm}"
        f".thumb{{height:{mm((ph - 2 * MARGIN_MM) * 0.55)};margin-bottom:4mm;"
        "border:0.25mm solid #d4d4d8;border-radius:1mm;padding:2mm;box-sizing:border-box}"
        ".thumb img{width:100%;height:100%;object-fit:contain;display:block}"
        "h2{font-size:9pt;margin:4mm 0 1.5mm;break-after:avoid}"
        "h2 span{font-weight:400;color:#71717a;margin-left:2mm}"
        "table{width:100%;border-collapse:collapse;margin-bottom:2mm}"
        "thead{display:table-header-group}"
        "th{text-align:left;font-weight:600;color:#52525b;border-bottom:0.3mm solid #a1a1aa;"
        "padding:0.8mm 1.2mm;white-space:nowrap}"
        "td{border-bottom:0.15mm solid #e4e4e7;padding:0.8mm 1.2mm;vertical-align:top}"
        "tr{break-inside:avoid}"
        ".n{text-align:right;white-space:nowrap}"
        ".b{font-weight:600;white-space:nowrap}"
        ".notes{color:#52525b}"
        ".sw{display:inline-block;width:2.2mm;height:2.2mm;border-radius:0.4mm;"
        "border:0.15mm solid #a1a1aa;margin-right:1mm;vertical-align:-0.3mm}"
        ".totals{width:auto;min-width:90mm}"
        ".totals .sum td{font-weight:600;border-top:0.3mm solid #a1a1aa}"
        ".hidden,.empty{color:#71717a}"
        "</style></head><body>"
        f"<h1>{escape(title)} - cable schedule</h1>"
        f"<div class='sub'>{escape(subtitle)}</div>"
        f"{thumb}"
        f"{''.join(body)}"
        "<h2>Totals by type</h2>"
        "<table class='totals'><thead><tr><th>Type</th><th class='n'>Cables</th>"
        "<th class='n'>Length</th><th class='n'>Unmeasured</th></tr></thead>"
        f"<tbody>{tot}</tbody></table>"
        f"{hidden_line}"
        "</body></html>"
    )


def _css_str(text: str) -> str:
    """``text`` inside a single-quoted CSS string in a <style> element."""
    out = []
    for ch in text:
        if ch in "\\'\"<>&" or ord(ch) < 32:
            out.append(f"\\{ord(ch):x} ")
        else:
            out.append(ch)
    return "".join(out)


def render_schedule_pdf(svg: bytes, **kwargs) -> bytes:
    import weasyprint

    html = sheet_html(**kwargs)
    return weasyprint.HTML(
        string=html, base_url=BASE_URL, url_fetcher=PdfUrlFetcher(svg)
    ).write_pdf()


def _render(svg: bytes, **kwargs) -> bytes:
    # Looked up when called, so the child renders what this module names.
    return render_schedule_pdf(svg, **kwargs)


class CableSchedulePdfRequestSerializer(serializers.Serializer):
    group = serializers.ChoiceField(choices=GROUPS, required=False, default="room")
    paper = DrawingPaperSerializer(required=False, help_text="A4 landscape when absent.")
    svg = serializers.CharField(
        trim_whitespace=False, max_length=MAX_SVG_BYTES, required=False, allow_blank=True,
        help_text="The plan with its routes, as the page draws it, for the first page.",
    )


def _print_key(user_id, tenant_id) -> str:
    return f"cable-schedule-pdf-print:{user_id}:{tenant_id}"


def export_pdf(request, view, plan, crop, tenant) -> HttpResponse | Response:
    """The schedule of ``plan`` (``view`` is the plan the caller opened, a
    live view of it or itself) on paper."""
    from . import floor_plan_snapshots as snaps
    from .floor_plan_pdf import plan_title

    if body_too_large(request, MAX_BODY_BYTES):
        return detail("The request is over 10 MB.", 413)
    ser = CableSchedulePdfRequestSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    paper = data.get("paper") or {}
    size = paper.get("size", "a4")
    orientation = paper.get("orientation", "landscape")
    schedule = build(plan, crop, request.user, tenant, group=data["group"])
    snaps.frame(view)
    title, subtitle = plan_title(view, view.tenant.name)
    generated = timezone.now()
    svg_text = data.get("svg") or ""
    thumbnail = bool(svg_text.strip())

    def sanitize(text: str) -> bytes:
        return sanitize_svg(text) if thumbnail else b""

    def render(svg: bytes) -> bytes:
        return run_with_deadline(
            _render, svg, timeout=RENDER_TIMEOUT,
            data=schedule, title=title, subtitle=subtitle, generated=generated,
            paper=size, orientation=orientation, thumbnail=thumbnail,
        )

    try:
        pdf = render_guarded(request, svg_text, sanitize=sanitize, render=render)
    except RenderTimeout:
        log.warning("Cable schedule PDF for user %s stopped after %ss", request.user.pk,
                    RENDER_TIMEOUT)
        return detail("The schedule took too long to render.", 413)
    if isinstance(pdf, Response):
        return pdf
    return deliver(
        request,
        pdf,
        name=file_name(f"{view.name} cable schedule", generated, "cable-schedule"),
        key=_print_key(request.user.pk, view.tenant_id),
        link=lambda token: reverse(
            "floor-plan-cable-schedule-pdf-file", kwargs={"pk": str(view.pk), "token": token}
        ),
        label="Cable schedule",
        extra={"object": str(view.pk)},
    )


def export_pdf_file(request, view, token: str) -> HttpResponse | Response:
    return kept_pdf(
        request, token, key=_print_key(request.user.pk, view.tenant_id),
        match={"object": str(view.pk)},
    )
