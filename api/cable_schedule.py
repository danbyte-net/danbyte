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
floor-plan PDF's, with the plan's background image and CAD drawing laid
under it here - and close-up pages of the cabled parts of a big plan
(``api/cable_schedule_plan.py``).

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
from lxml import etree
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
    _response,
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


def build(plan, crop, user, tenant, *, group: str = "room",
          geometry: dict | None = None) -> dict:
    """The schedule of ``plan`` (the source of a view, ``crop`` its part)
    as ``user`` may see it. See the module docstring. ``geometry``, when
    given, is filled with each listed cable's place on the plan, in cells
    of the plan drawn (the view's for a live view): ``lines`` (its stored
    route's legs, else its trays) and ``boxes`` (the tiles of its ends
    here) - what the PDF's close-ups are cut by."""
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
    tray_by_id = {t.pk: t for t in trays}
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

    def tile_of(dev_id):
        if dev_id is None:
            return None
        if dev_id in device_tile:
            return device_tile[dev_id]
        d = devices.get(dev_id)
        if d is None:
            return None
        return rack_tile.get(d.rack_id) or cabinet_tile.get(d.cabinet_id)

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
        if geometry is not None:
            geometry[str(c.pk)] = _geometry(
                p, [tray_by_id[t] for t in _uuids(p.tray_order) if t in tray_by_id]
                if p is not None else [
                    t for t in c.trays.all() if t.pk in tray_by_id
                ],
                [tile_of(dev) for _end, dev, _port in terms.get(c.pk, [])],
                crop,
            )
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


def _point(v) -> tuple[float, float] | None:
    if isinstance(v, (list, tuple)) and len(v) >= 2 and all(
        isinstance(n, (int, float)) and not isinstance(n, bool) for n in v[:2]
    ):
        return (float(v[0]), float(v[1]))
    return None


def _geometry(path, trays, end_tiles, crop) -> dict:
    """A cable's lines and boxes in plan cells (see :func:`build`)."""
    from . import floor_plan_snapshots as snaps

    dx, dy = (crop.x, crop.y) if crop is not None else (0, 0)
    lines = []
    legs = path.legs if path is not None and isinstance(path.legs, list) else []
    for leg in legs:
        if not isinstance(leg, dict):
            continue
        raw = [(leg.get("from") or {}).get("at"), *(leg.get("points") or []),
               (leg.get("to") or {}).get("at")]
        pts = [p for p in (_point(v) for v in raw) if p is not None]
        if pts:
            lines.append(pts)
    if not lines:
        for t in trays:
            pts = [p for p in (_point(v) for v in t.points or []) if p is not None]
            if pts:
                lines.append(pts)
    boxes = [snaps.tile_box(t) for t in end_tiles if t is not None]
    return {
        "lines": [[(x - dx, y - dy) for x, y in line] for line in lines],
        "boxes": [(x0 - dx, y0 - dy, x1 - dx, y1 - dy) for x0, y0, x1, y1 in boxes],
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
               paper: str, orientation: str, thumbnail: bool,
               closeups: list[dict] | None = None, closeup_note: str = "",
               caption: str = "") -> str:
    """The schedule's pages. ``closeups``: the detail pages after the
    overview, each ``{label, url, rows}`` - its picture's URL and the ids
    of the cables drawn on it; the table then says which pages show each
    cable."""
    from danbyte import __version__

    from .cable_schedule_plan import closeup_mm

    pw, ph = PAPERS_MM[paper]
    if orientation == "portrait":
        pw, ph = ph, pw
    closeups = closeups or []
    rows = {r["id"]: r for r in data["rows"]}
    on_pages: dict = {}
    for cu in closeups:
        for rid in cu["rows"]:
            on_pages.setdefault(rid, []).append(cu["label"])
    group_word = "Room" if data["group"] == "room" else "Tray"
    detail_th = "<th>Detail</th>" if closeups else ""
    head = (
        "<tr><th>Cable</th><th>Type</th><th>Status</th><th>A end</th><th>A room</th>"
        f"<th>B end</th><th>B room</th><th>Route</th>{detail_th}<th class='n'>Computed</th>"
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
                + (f"<td class='ref'>{escape(', '.join(on_pages.get(rid, [])))}</td>"
                   if closeups else "")
                + f"<td class='n'>{escape(computed)}</td>"
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
    note = " · ".join(p for p in (caption, closeup_note) if p)
    if thumbnail and note:
        thumb += f"<div class='cap'>{escape(note)}</div>"
    cu_outer, _cu_w, _cu_h = closeup_mm(paper, orientation)
    pages = []
    for cu in closeups:
        listed = [rows[rid] for rid in cu["rows"] if rid in rows]
        trs = "".join(
            "<tr>"
            f"<td class='b'>{_swatch(r['color'])}{escape(r['label'])}</td>"
            f"<td>{escape(end_text(r['a']))}</td>"
            f"<td>{escape(end_text(r['b']))}</td>"
            f"<td>{escape(r['route'])}</td>"
            f"<td class='n'>{escape(length_text(r)[0] or length_text(r)[1])}</td>"
            "</tr>"
            for r in listed
        )
        n = len(listed)
        pages.append(
            "<section class='cu'>"
            f"<h2>Detail {escape(cu['label'])} "
            f"<span>{n} {'cable' if n == 1 else 'cables'}</span></h2>"
            f"<div class='cuimg'><img src='{escape(cu['url'])}' alt=''></div>"
            "<table><thead><tr><th>Cable</th><th>A end</th><th>B end</th><th>Route</th>"
            f"<th class='n'>Length</th></tr></thead><tbody>{trs}</tbody></table>"
            "</section>"
        )
    if pages:
        body[0:0] = ["".join(pages), "<div class='after'></div>"]
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
        ".cap{color:#71717a;font-size:6.5pt;margin:-3mm 0 3mm}"
        ".cu{break-before:page}"
        f".cuimg{{height:{mm(cu_outer)};margin-bottom:3mm;border:0.25mm solid #d4d4d8;"
        "border-radius:1mm;padding:1mm;box-sizing:border-box}"
        ".cuimg img{width:100%;height:100%;object-fit:contain;display:block}"
        ".after{break-before:page}"
        ".ref{white-space:nowrap}"
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


def render_schedule_pdf(svg: bytes, pages: dict | None = None, **kwargs) -> bytes:
    import weasyprint

    html = sheet_html(**kwargs)
    return weasyprint.HTML(
        string=html, base_url=BASE_URL, url_fetcher=_Fetcher(svg, pages or {})
    ).write_pdf()


class _Fetcher(PdfUrlFetcher):
    """The drawing PDFs' fetcher, plus the close-ups' pictures (made here)."""

    def __init__(self, svg: bytes, pages: dict[str, bytes]):
        super().__init__(svg)
        self.pages = pages

    def __call__(self, url: str):
        if url in self.pages:
            return _response(url, self.pages[url], "image/svg+xml")
        return super().__call__(url)


def _render(svg: bytes, **kwargs) -> bytes:
    # Looked up when called, so the child renders what this module names.
    return render_schedule_pdf(svg, **kwargs)


CLOSEUP_MODES = ("auto", "on", "off")


class CableSchedulePdfRequestSerializer(serializers.Serializer):
    group = serializers.ChoiceField(choices=GROUPS, required=False, default="room")
    paper = DrawingPaperSerializer(required=False, help_text="A4 landscape when absent.")
    svg = serializers.CharField(
        trim_whitespace=False, max_length=MAX_SVG_BYTES, required=False, allow_blank=True,
        help_text="The plan with its routes, as the page draws it, for the first page.",
    )
    detail_svg = serializers.CharField(
        trim_whitespace=False, max_length=MAX_SVG_BYTES, required=False, allow_blank=True,
        help_text="The same plan drawn for the close-ups (a cell 5 mm on paper).",
    )
    closeups = serializers.ChoiceField(
        choices=CLOSEUP_MODES, required=False, default="auto",
        help_text="Close-up pages of the cabled parts: `auto` when a cell would print "
                  "under 2 mm on the overview, `on` whenever they are larger, `off`.",
    )


def _print_key(user_id, tenant_id) -> str:
    return f"cable-schedule-pdf-print:{user_id}:{tenant_id}"


class PlanPages:
    """The overview and close-ups of a schedule PDF, composed from the
    posted drawings (``cable_schedule_plan``): background and CAD drawing
    under them, the close-ups cut where the cables are."""

    def __init__(self, *, view, plan, crop, paper: str, orientation: str, mode: str,
                 geometry: dict):
        from . import cable_schedule_plan as cp
        from .floor_plan_pdf import _ready_drawing

        self.cp = cp
        self.view, self.plan, self.crop = view, plan, crop
        self.paper, self.orientation, self.mode = paper, orientation, mode
        self.geometry = cp.to_px(geometry)
        self.background = cp.Background(plan, crop, view.background_opacity)
        self.drawing = _ready_drawing(view)
        self.closeups: list = []
        self.frames: list = []
        self.dropped = 0
        self.cad_note = ""
        self.pages: dict[str, bytes] = {}

    def _cad(self, mm_per_px: float):
        from .floor_plan_pdf import cad_group
        from .svg_sanitize import SvgRejected, SvgTooLarge

        if self.drawing is None:
            return None
        try:
            g, dropped = cad_group(self.drawing, paper_mm_per_px=mm_per_px,
                                   px_per_mm=self.cp.CELL / self.view.cell_mm)
        except SvgTooLarge:
            self.cad_note = "Drawing left out: too large"
            return None
        except (SvgRejected, OSError, etree.XMLSyntaxError) as exc:
            log.warning("Cable schedule PDF: CAD drawing of %s unreadable: %s",
                        self.view.pk, exc)
            self.cad_note = "Drawing left out: unreadable"
            return None
        if dropped:
            self.cad_note = "Drawing text left out"
        return g

    def caption(self) -> str:
        parts = []
        if self.drawing is not None:
            parts.append(f"Drawing: {self.drawing.source_name or 'CAD drawing'}")
        if self.cad_note:
            parts.append(self.cad_note)
        return " · ".join(parts)

    def compose(self, overview: bytes, detail: bytes | None) -> bytes:
        """The overview SVG; the close-ups go into ``self.pages``."""
        cp = self.cp
        posted = etree.fromstring(overview)
        grid = (self.view.grid_width * cp.CELL, self.view.grid_height * cp.CELL)
        box = cp.view_box(posted) or cp.Box(0, 0, *grid)
        w_mm, h_mm = cp.thumb_mm(self.paper, self.orientation)
        scale = cp.fit_scale(box, w_mm, h_mm)
        if detail is not None and cp.wants_closeups(self.mode, scale):
            dposted = etree.fromstring(detail)
            content = cp.view_box(dposted) or box
            _outer, cw, ch = cp.closeup_mm(self.paper, self.orientation)
            pages, self.dropped = cp.closeup_pages(
                content, self.geometry, cw / cp.CLOSEUP_MM_PER_PX, ch / cp.CLOSEUP_MM_PER_PX,
            )
            dcad = self._cad(cp.CLOSEUP_MM_PER_PX) if pages else None
            for page in pages:
                url = f"{BASE_URL}_/closeup-{page.label}.svg"
                self.pages[url] = cp.compose(
                    dposted, page.box, grid=grid,
                    background=self.background.element(page.box, cp.CLOSEUP_MM_PER_PX),
                    cad=dcad,
                )
                self.closeups.append({"label": page.label, "url": url, "rows": page.cables})
            self.frames = pages
        cad = self._cad(scale)
        return cp.compose(
            posted, box, grid=grid, background=self.background.element(box, scale),
            cad=cad, frames=self.frames, mm_per_px=scale,
        )

    def note(self) -> str:
        if not self.dropped:
            return ""
        n = len(self.closeups)
        return (f"{n} close-ups of the busiest parts; {self.dropped} more "
                f"{'part' if self.dropped == 1 else 'parts'} with cables not shown close up")


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
    geometry: dict = {}
    schedule = build(plan, crop, request.user, tenant, group=data["group"], geometry=geometry)
    snaps.frame(view)
    title, subtitle = plan_title(view, view.tenant.name)
    generated = timezone.now()
    svg_text = data.get("svg") or ""
    detail_text = data.get("detail_svg") or ""
    thumbnail = bool(svg_text.strip())
    planned = PlanPages(
        view=view, plan=plan, crop=crop, paper=size, orientation=orientation,
        mode=data["closeups"], geometry=geometry,
    ) if thumbnail else None

    def sanitize(text: str) -> bytes:
        if not thumbnail:
            return b""
        overview = sanitize_svg(text)
        detail_svg = (
            sanitize_svg(detail_text)
            if detail_text.strip() and data["closeups"] != "off" else None
        )
        return planned.compose(overview, detail_svg)

    def render(svg: bytes) -> bytes:
        return run_with_deadline(
            _render, svg, timeout=RENDER_TIMEOUT,
            pages=planned.pages if planned else {},
            data=schedule, title=title, subtitle=subtitle, generated=generated,
            paper=size, orientation=orientation, thumbnail=thumbnail,
            closeups=planned.closeups if planned else None,
            closeup_note=planned.note() if planned else "",
            caption=planned.caption() if planned else "",
        )

    try:
        pdf = render_guarded(request, svg_text, sanitize=sanitize, render=render)
    except RenderTimeout:
        log.warning("Cable schedule PDF for user %s stopped after %ss", request.user.pk,
                    RENDER_TIMEOUT)
        return detail("The schedule took too long to render. Turn off close-ups, or "
                      "hide some of the drawing's layers.", 413)
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
