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
under it here - close-up pages of the cabled parts of a big plan
(``api/cable_schedule_plan.py``) and a trace page per cable asked for. With
``cables=bundles`` the cables are drawn here, as bundles
(``api/cable_bundles.py``). Its tables (:func:`schedule_tables`, shared
with the floor-plan report) say a value shared by a group once, in its
heading, and list cables sharing a route under one band.

Visibility follows ``cable-paths``: only cables the reader may view are
listed, the others counted in ``hidden_count``; an end on a device the
reader may not view reads **Hidden** (#453); only tiles the reader may view
place a device, and only stored routes they may view are shown.
"""

from __future__ import annotations

import datetime as dt
import logging
import math
from html import escape

from django.db.models import Prefetch, Q
from django.http import HttpResponse
from django.urls import reverse
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
    reader_now,
    render_guarded,
    run_with_deadline,
    stamp,
)
from .natural import natural_key
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
          geometry: dict | None = None, keep_tile=None, strict: bool = False,
          hidden_out: set | None = None, routes: bool = False, origin=None,
          tile_boxes: list | None = None) -> dict:
    """The schedule of ``plan`` (the source of a view, ``crop`` its part)
    as ``user`` may see it. See the module docstring. ``geometry``, when
    given, is filled with each listed cable's place on the plan, in cells
    of the plan drawn (the view's for a live view): ``lines`` (its stored
    route's legs, else its trays) and ``boxes`` (the tiles of its ends
    here) - what the PDF's close-ups are cut by.

    For a part of a plan (the floor-plan report, ``api/floor_plan_report.py``):
    ``keep_tile`` keeps only the tiles it accepts (a room's), ``strict``
    lists only the cables with an end on a kept tile or a route or tray
    reaching ``crop``, and ``hidden_out`` collects the ids of the cables
    the reader may not view.

    ``routes`` (with ``geometry``) adds each cable's ``runs`` - its stored
    route's legs (documented), else a route through its trays or an elbow
    between its tiles (inferred) - and ``terms``, its ends' tiles with their
    side, device and port, for the bundles and traces
    (``api/cable_bundles.py``). ``origin`` is the crop the geometry is
    relative to when it is not ``crop`` (a report's part of a live view),
    and ``tile_boxes`` gains the boxes of the tiles drawn (cells, there)."""
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
    if keep_tile is not None:
        tiles = [t for t in tiles if keep_tile(t)]
    if origin is None:
        origin = crop
    if tile_boxes is not None:
        ox, oy = (origin.x, origin.y) if origin is not None else (0, 0)
        for t in tiles:
            x0, y0, x1, y1 = snaps.tile_box(t)
            tile_boxes.append((x0 - ox, y0 - oy, x1 - ox, y1 - oy))
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

    def end_port(dev_id, port) -> str:
        if dev_id is not None and viewable is not None and not viewable.may_view(
                "device", dev_id):
            return ""
        return port or ""

    def end_name(dev_id) -> str:
        if dev_id is None or (viewable is not None and not viewable.may_view("device", dev_id)):
            return ""
        d = devices.get(dev_id)
        return d.name if d is not None and d.name else ""

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
        if strict and crop is not None and not trays_in and not any(
            e["on_floor"] for e in ends["A"] + ends["B"]
        ) and not _route_reaches(p, crop):
            continue
        if geometry is not None:
            geo_trays = (
                [tray_by_id[t] for t in _uuids(p.tray_order) if t in tray_by_id]
                if p is not None else [t for t in c.trays.all() if t.pk in tray_by_id]
            )
            end_tiles = [(end, tile_of(dev), end_name(dev), end_port(dev, port))
                         for end, dev, port in terms.get(c.pk, [])]
            geometry[str(c.pk)] = _geometry(
                p, geo_trays, [(t, n) for _e, t, n, _p in end_tiles], origin,
                routes=routes, end_tiles_ab=end_tiles,
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
    if hidden_out is not None:
        hidden_out.update(candidates - visible)
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


def _route_reaches(path, crop) -> bool:
    """Whether a stored route's legs reach ``crop`` (source cells)."""
    from . import floor_plan_snapshots as snaps

    if path is None or not isinstance(path.legs, list):
        return False
    for leg in path.legs:
        if not isinstance(leg, dict):
            continue
        raw = [(leg.get("from") or {}).get("at"), *(leg.get("points") or []),
               (leg.get("to") or {}).get("at")]
        pts = [p for p in (_point(v) for v in raw) if p is not None]
        if len(pts) == 1:
            pts = pts * 2
        if pts and snaps.classify_line(pts, crop) is not None:
            return True
    return False


def _point(v) -> tuple[float, float] | None:
    if isinstance(v, (list, tuple)) and len(v) >= 2 and all(
        isinstance(n, (int, float)) and not isinstance(n, bool) for n in v[:2]
    ):
        return (float(v[0]), float(v[1]))
    return None


def _geometry(path, trays, end_tiles, crop, *, routes: bool = False,
              end_tiles_ab=None) -> dict:
    """A cable's lines and boxes in plan cells (see :func:`build`):
    ``end_tiles`` are (tile, device name) per end, the name "" when the
    reader may not view the device; ``ends`` keeps the names with the
    boxes. With ``routes``, ``runs`` and ``terms`` too (``end_tiles_ab``:
    (side, tile, name, port) per end)."""
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
    documented = bool(lines)
    if not lines:
        for t in trays:
            pts = [p for p in (_point(v) for v in t.points or []) if p is not None]
            if pts:
                lines.append(pts)
    ends = [(*snaps.tile_box(t), name) for t, name in end_tiles if t is not None]
    out = {
        "lines": [[(x - dx, y - dy) for x, y in line] for line in lines],
        "boxes": [(x0 - dx, y0 - dy, x1 - dx, y1 - dy) for x0, y0, x1, y1, _n in ends],
        "ends": [(x0 - dx, y0 - dy, x1 - dx, y1 - dy, n) for x0, y0, x1, y1, n in ends],
    }
    if routes:
        runs = [{"points": line, "documented": True} for line in lines] if documented \
            else [{"points": pts, "documented": False}
                  for pts in _inferred(trays, end_tiles_ab or [])]
        out["runs"] = [
            {"points": [(x - dx, y - dy) for x, y in r["points"]],
             "documented": r["documented"]} for r in runs
        ]
        terms = []
        for side, t, name, port in end_tiles_ab or []:
            if t is None:
                continue
            x0, y0, x1, y1 = snaps.tile_box(t)
            terms.append((side, x0 - dx, y0 - dy, x1 - dx, y1 - dy, name, port))
        out["terms"] = terms
    return out


def _inferred(trays, end_tiles) -> list[list[tuple[float, float]]]:
    """A cable without a stored route as the plan infers it: from the side
    with fewer tiles to each tile of the other, through its trays when they
    connect the two, else an elbow along x first (``cable_routing``)."""
    from .cable_routing import tile_centre
    from .pathfinding import route_through_trays

    sides: dict[str, list] = {"A": [], "B": []}
    for side, t, _n, _p in end_tiles:
        if t is not None and side in sides and all(t.pk != o.pk for o in sides[side]):
            sides[side].append(t)
    a, b = sides["A"], sides["B"]
    if not a or not b:
        return []
    pairs = [(a[0], far) for far in b] if len(a) <= len(b) else [(near, b[0]) for near in a]
    polys = [[p for p in (_point(v) for v in t.points or []) if p is not None] for t in trays]
    polys = [p for p in polys if len(p) >= 2]
    out = []
    for x, y in pairs:
        if x.pk == y.pk:
            continue
        pa, pb = tile_centre(x), tile_centre(y)
        if polys:
            res = route_through_trays(pa, pb, polys)
            if res.reachable and len(res.points) >= 2:
                out.append([(float(p[0]), float(p[1])) for p in res.points])
                continue
        pts = [pa]
        if abs(pa[0] - pb[0]) > 1e-3 and abs(pa[1] - pb[1]) > 1e-3:
            pts.append((pb[0], pa[1]))
        pts.append(pb)
        out.append(pts)
    return out


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


# ─── The tables ─────────────────────────────────────────────────────────────

#: A character of the table's 7 pt type, and a cell's side padding (mm).
CHAR_MM = 1.5
BOLD_MM = 1.62
PAD_MM = 2.6
#: Values the same for every cable of a group are said once, in its
#: heading, and their column left out (the whole schedule's in its
#: subtitle).
HOISTED = ("type", "status", "source", "a_room", "b_room")
HOIST_LABEL = {"a_room": "A room", "b_room": "B room"}
#: The most a column takes (mm) before its text wraps at a space.
CAPS = {"label": 45, "type": 42, "status": 26, "a": 62, "a_room": 30, "b": 62,
        "b_room": 30, "route": 80, "detail": 20, "computed": 18, "stored": 18,
        "source": 18}
#: A close-up lists its cables when it has no more than this.
CLOSEUP_LIST_MAX = 20


def _cell_text(r: dict, key: str, on_pages: dict) -> str:
    if key == "label":
        return r["label"]
    if key == "type":
        return r["type_display"]
    if key == "status":
        return r["status"]["name"] if r["status"] else ""
    if key in ("a", "b"):
        return end_text(r[key])
    if key in ("a_room", "b_room"):
        return room_text(r[key[0]])
    if key == "route":
        return r["route"]
    if key == "detail":
        return ", ".join(on_pages.get(r["id"], []))
    computed, stored, source = length_text(r)
    return {"computed": computed, "stored": stored, "source": source,
            "notes": r["notes"]}.get(key, "")


COLUMNS = (
    ("label", "Cable", ""), ("type", "Type", ""), ("status", "Status", ""),
    ("a", "A end", ""), ("a_room", "A room", ""), ("b", "B end", ""),
    ("b_room", "B room", ""), ("route", "Route", ""), ("detail", "Detail", "ref"),
    ("computed", "Computed", "n"), ("stored", "Stored", "n"), ("source", "Source", ""),
    ("notes", "Notes", "notes"),
)


def _width(texts, header: str, key: str) -> float:
    """The width (mm) a column's texts need: the longest on one line up to
    the column's cap, never narrower than its longest word or its header."""
    ch = BOLD_MM if key == "label" else CHAR_MM
    longest = max((len(t) for t in texts), default=0)
    word = max((len(w) for t in texts for w in t.split()), default=0)
    want = min(longest * ch, CAPS.get(key, 60))
    return max(want, word * ch, len(header) * BOLD_MM) + PAD_MM + (2.8 if key == "label" else 0)


def _min_width(texts, header: str, key: str) -> float:
    ch = BOLD_MM if key == "label" else CHAR_MM
    word = max((len(w) for t in texts for w in t.split()), default=0)
    return max(word * ch, len(header) * BOLD_MM) + PAD_MM


def _status_html(r: dict) -> str:
    from .floor_plan_report import _pill

    return _pill(r["status"]) if r["status"] else ""


def _cell_html(r: dict, key: str, on_pages: dict) -> str:
    if key == "label":
        return f"{_swatch(r['color'])}{escape(r['label'])}"
    if key == "status":
        return _status_html(r)
    return escape(_cell_text(r, key, on_pages))


def schedule_tables(data: dict, *, width_mm: float, on_pages: dict | None = None,
                    heading: str = "h2", group_word: str | None = None,
                    detail: bool = False) -> tuple[str, str]:
    """The schedule's groups as tables: ``(html, facts)``.

    Per group, a value the same for every cable (type, status, length
    source, a room) is said once in the group's heading and its column left
    out; one the same for the whole schedule goes in ``facts`` (for the
    subtitle) instead. A group where cables share a route lists them under
    one band per route, without a Route column. Columns are as wide as
    their texts need (labels and ends on one line where they fit, wrapped
    only between words); the header repeats on every page."""
    on_pages = on_pages or {}
    rows = {r["id"]: r for r in data["rows"]}
    listed = [rows[rid] for g in data["groups"] for rid in g["rows"] if rid in rows]
    keys = [k for k, _h, _c in COLUMNS if k != "detail" or detail]
    texts = {k: [_cell_text(r, k, on_pages) for r in listed] for k in keys}
    # Empty for every cable: left out everywhere.
    keys = [k for k in keys if k == "label" or any(texts[k])]
    uniform = {k for k in HOISTED if k in keys and len(set(texts[k])) == 1}
    facts = _facts(listed[0], uniform, on_pages) if listed and uniform else ""
    headers_of = {k: h for k, h, _c in COLUMNS}
    widths = {k: _width(texts[k], h, k) for k, h, _c in COLUMNS if k in keys}
    if "notes" in widths:
        widths["notes"] = min(widths["notes"], 60.0)
    # Wider than the page: the long columns give way, down to their words.
    room = width_mm
    over = sum(widths.values()) - room
    if over > 0:
        flex = {k: widths[k] - _min_width(texts[k], headers_of[k], k)
                for k in ("route", "notes", "a", "b") if k in widths}
        give = sum(max(0.0, v) for v in flex.values())
        if give > 0:
            for k, v in flex.items():
                widths[k] -= min(max(0.0, v), over * max(0.0, v) / give)
    # On one line: a column whose longest text fits it (labels and ends).
    whole = {k for k in ("label", "a", "b") if k in widths
             and max((len(t) for t in texts[k]), default=0)
             * (BOLD_MM if k == "label" else CHAR_MM) + PAD_MM <= widths[k]}
    headers = {k: (h, c) for k, h, c in COLUMNS}
    out = []
    for g in data["groups"]:
        grp = [rows[rid] for rid in g["rows"] if rid in rows]
        if not grp:
            continue
        hoist = {k for k in HOISTED if k in keys and k not in uniform
                 and len({_cell_text(r, k, on_pages) for r in grp}) == 1}
        cols = [k for k in keys if k not in uniform and k not in hoist]
        routes: dict[str, list] = {}
        for r in grp:
            routes.setdefault(r["route"], []).append(r)
        banded = "route" in cols and any(len(v) > 1 for k, v in routes.items() if k)
        # Each route's cables of one type: the type goes in its band.
        band_type = banded and "type" in cols and all(
            len({r["type_display"] for r in v}) == 1 for v in routes.values()
        )
        if banded:
            cols = [k for k in cols if k != "route" and not (band_type and k == "type")]
        # The page's width left over goes to the long columns, as they need.
        mine = {k: widths[k] for k in cols}
        spare = width_mm - sum(mine.values())
        grow = [k for k in ("a", "b", "route", "notes") if k in mine] or cols[-1:]
        need = sum(mine[k] for k in grow) or 1.0
        if spare > 0:
            for k in grow:
                mine[k] += spare * mine[k] / need
        colgroup = "<colgroup>" + "".join(
            f"<col style='width:{mine[k]:.1f}mm'>" for k in cols
        ) + "</colgroup>"
        head = "<tr>" + "".join(
            f"<th class='{headers[k][1]}'>{escape(headers[k][0])}</th>"
            if headers[k][1] else f"<th>{escape(headers[k][0])}</th>" for k in cols
        ) + "</tr>"

        def tr(r, cols=cols) -> str:
            cells = []
            for k in cols:
                cls = "b" if k == "label" else headers[k][1]
                if k in whole:
                    cls = f"{cls} nw".strip()
                attr = f" class='{cls}'" if cls else ""
                cells.append(f"<td{attr}>{_cell_html(r, k, on_pages)}</td>")
            return "<tr>" + "".join(cells) + "</tr>"

        body = []
        if banded:
            order = sorted(routes, key=lambda k: (k == "", natural_key(k)))
            for route in order:
                members = sorted(routes[route], key=lambda r: natural_key(r["label"]))
                n = len(members)
                name = (f"Route <b>{escape(route)}</b>" if route else "<b>No route</b>")
                if band_type and members[0]["type_display"]:
                    name += f"<span class='cnt'>{escape(members[0]['type_display'])}</span>"
                body.append(
                    f"<tr class='band'><td colspan='{len(cols)}'>{name}"
                    f"<span class='cnt'>{n} {'cable' if n == 1 else 'cables'}</span></td></tr>"
                )
                body.extend(tr(r) for r in members)
        else:
            body.extend(tr(r) for r in grp)
        n = len(grp)
        word = f"{escape(group_word)}: " if group_word else ""
        # A room the group is named after goes unsaid ("Hall", "B1 · Hall").
        named = {k: _cell_text(grp[0], k, on_pages) for k in ("a_room", "b_room")
                 if group_word in (None, "Room") and _cell_text(grp[0], k, on_pages)
                 and (g["name"] == _cell_text(grp[0], k, on_pages)
                      or g["name"].endswith(" · " + _cell_text(grp[0], k, on_pages)))}
        extra = _facts(grp[0], hoist, on_pages, named)
        out.append(
            f"<{heading} class='grp'>{word}{escape(g['name'])} "
            f"<span>{n} {'cable' if n == 1 else 'cables'}{' · ' + extra if extra else ''}"
            f"</span></{heading}>"
            f"<table class='sched'>{colgroup}<thead>{head}</thead>"
            f"<tbody>{''.join(body)}</tbody></table>"
        )
    return "".join(out), facts


def _facts(r: dict, keys: set, on_pages: dict, skip: dict | None = None) -> str:
    """The hoisted values of ``keys`` (``r``'s), a value in ``skip`` (by
    key; a room the group is named after) left unsaid."""
    skip = skip or {}
    parts = []
    for k in HOISTED:
        if k not in keys:
            continue
        if k == "status":
            if r["status"]:
                parts.append(_status_html(r))
            continue
        text = _cell_text(r, k, on_pages)
        if not text or text == skip.get(k):
            continue
        if k == "source":
            parts.append(f"{escape(text)} lengths")
            continue
        label = HOIST_LABEL.get(k)
        parts.append(f"<span class='k'>{escape(label)}</span> {escape(text)}"
                     if label else escape(text))
    return " · ".join(parts)


def totals_html(data: dict, *, heading: str = "h2", note: str = "") -> str:
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
        f"<p class='muted'>{hidden} {'cable' if hidden == 1 else 'cables'} hidden "
        "- not listed or counted above.</p>" if hidden else ""
    )
    return (
        f"<div class='keep'><{heading}>Totals by type</{heading}>"
        "<table class='totals'><thead><tr><th>Type</th><th class='n'>Cables</th>"
        "<th class='n'>Length</th><th class='n'>Unmeasured</th></tr></thead>"
        f"<tbody>{tot}</tbody></table>{hidden_line}{note}</div>"
    )


def trace_html(page: dict, row: dict, *, heading: str = "h2") -> str:
    """A trace page: the cable's drawing, then its facts."""
    computed, stored, source = length_text(row)
    riser = row.get("riser")
    lengths = " · ".join(p for p in (
        f"Computed {computed}" if computed else "",
        f"Stored {stored}" + (f" ({source})" if source else "") if stored else "",
    ) if p)

    def end(ends) -> str:
        text = end_text(ends)
        room = room_text(ends)
        return f"{escape(text)}{' · ' + escape(room) if room else ''}"

    facts = [
        ("Cable", f"{_swatch(row['color'])}<b>{escape(row['label'])}</b>"),
        ("Type", escape(row["type_display"])),
        ("Status", _status_html(row)),
        ("A end", end(row["a"])),
        ("B end", end(row["b"])),
        ("Trays", escape(" → ".join(row["trays"]))),
        ("Riser", escape(
            f"{riser['label']}{' to ' + riser['floor'] if riser.get('floor') else ''}"
            f"{' · ' + format(riser['vertical_m'], 'g') + ' m' if riser.get('vertical_m') else ''}"
        ) if riser else ""),
        ("Length", escape(lengths)),
        ("Notes", escape(row["notes"])),
    ]
    facts = [(k, v) for k, v in facts if v]
    half = (len(facts) + 1) // 2
    left, right = facts[:half], facts[half:]
    trs = "".join(
        "<tr>" + f"<th>{escape(a[0])}</th><td>{a[1]}</td>"
        + (f"<th>{escape(b[0])}</th><td>{b[1]}</td>" if b else "<th></th><td></td>")
        + "</tr>"
        for a, b in zip(left, right + [None] * (len(left) - len(right)), strict=True)
    )
    size = page.get("style", "")
    ratio = f"1:{page['ratio']}" if page.get("ratio") else ""
    return (
        "<section class='cu trace'>"
        f"<{heading}>Trace {escape(page['label'])} · {escape(row['label'])} "
        f"<span>{escape(ratio)}</span></{heading}>"
        f"<div class='cuimg'><img src='{escape(page['url'])}' alt=''{size}></div>"
        f"<table class='tfacts'>{trs}</table>"
        "</section>"
    )


#: The tables' look, shared by the schedule and the report.
TABLE_CSS = (
    "table.sched{table-layout:fixed;width:100%;border-collapse:collapse;margin-bottom:2mm}"
    "table.sched td{overflow-wrap:break-word;word-break:normal;padding:0.55mm 1.2mm}"
    "table.sched th{padding:0.6mm 1.2mm}"
    ".grp .k,.facts .k{color:#71717a}"
    "table.sched td.b{font-weight:600;white-space:normal}"
    "table.sched td.nw{white-space:nowrap}"
    "table.sched tr.band{break-after:avoid}"
    "table.sched tr.band td{background:#f4f4f5;color:#52525b;padding:0.9mm 1.2mm;"
    "border-bottom:0.15mm solid #d4d4d8}"
    "table.sched tr.band b{color:#18181b;font-weight:600}"
    "table.sched tr.band .cnt{color:#71717a;margin-left:2mm}"
    ".grp span .pill{font-size:6.3pt;vertical-align:0.3pt}"
    "table.tfacts{width:100%;border-collapse:collapse;font-size:7.5pt}"
    "table.tfacts th{width:16mm;text-align:left;font-weight:500;color:#71717a;"
    "padding:1mm 2mm 1mm 0;border-bottom:0.15mm solid #e4e4e7;vertical-align:top}"
    "table.tfacts td{padding:1mm 4mm 1mm 0;border-bottom:0.15mm solid #e4e4e7;"
    "vertical-align:top}"
    ".pill,.tag{display:inline-block;padding:0.15mm 1.4mm;font-size:6.3pt;font-weight:500;"
    "white-space:nowrap;line-height:1.35;border-radius:0.6mm}"
    ".plain{background:#f4f4f5;color:#3f3f46}"
    ".muted{color:#71717a}"
    ".keep{break-inside:avoid}"
)


def sheet_html(data: dict, *, title: str, subtitle: str, generated: dt.datetime,
               paper: str, orientation: str, thumbnail: bool,
               closeups: list[dict] | None = None, closeup_note: str = "",
               caption: str = "", traces: list[dict] | None = None,
               trace_note: str = "", legend: str = "") -> str:
    """The schedule's pages. ``closeups``: the detail pages after the
    overview, each ``{label, url, rows}`` - its picture's URL and the ids
    of the cables drawn on it; the table then says which pages show each
    cable. ``traces``: a page per cable, ``{label, url, cable}``.
    ``legend``: the bundles' key (``cable_bundles``), under the overview
    and on each close-up."""
    from danbyte import __version__

    from .cable_bundles import BUNDLE_LEGEND_CSS
    from .cable_schedule_plan import closeup_mm

    pw, ph = PAPERS_MM[paper]
    if orientation == "portrait":
        pw, ph = ph, pw
    closeups = closeups or []
    traces = traces or []
    rows = {r["id"]: r for r in data["rows"]}
    on_pages: dict = {}
    for cu in closeups:
        for rid in cu["rows"]:
            on_pages.setdefault(rid, []).append(cu["label"])
    for tp in traces:
        on_pages.setdefault(tp["cable"], []).append(tp["label"])
    group_word = "Room" if data["group"] == "room" else "Tray"
    tables, facts = schedule_tables(
        data, width_mm=pw - 2 * MARGIN_MM, on_pages=on_pages, heading="h2",
        group_word=group_word, detail=bool(closeups or traces),
    )
    body = [tables] if tables else ["<p class='empty'>No cables on this floor.</p>"]
    small = " · ".join((stamp(generated), f"Danbyte {__version__}"))
    thumb = (
        f"<div class='thumb'><img src='{DIAGRAM_URL}' alt=''></div>" if thumbnail else ""
    )
    note = " · ".join(p for p in (caption, closeup_note, trace_note) if p)
    if thumbnail and (note or legend):
        thumb += f"<div class='cap'>{legend}{escape(note)}</div>"
    cu_outer, _cu_w, _cu_h = closeup_mm(paper, orientation)

    def sized(cu) -> str:
        # At its own scale: the picture's paper size, centred in the frame.
        if not (cu.get("width_mm") and cu.get("height_mm")):
            return ""
        iw = min(cu["width_mm"], _cu_w)
        ih = min(cu["height_mm"], _cu_h)
        return (f" style='width:{iw:.3f}mm;height:{ih:.3f}mm;"
                f"margin:{(_cu_h - ih) / 2:.3f}mm auto 0'")

    pages = []
    for cu in closeups:
        listed = [rows[rid] for rid in cu["rows"] if rid in rows]
        n = len(listed)
        if n <= CLOSEUP_LIST_MAX:
            trs = "".join(
                "<tr>"
                f"<td class='b'>{_swatch(r['color'])}{escape(r['label'])}</td>"
                f"<td>{escape(end_text(r['a']))}</td>"
                f"<td>{escape(end_text(r['b']))}</td>"
                f"<td class='n'>{escape(length_text(r)[0] or length_text(r)[1])}</td>"
                "</tr>"
                for r in sorted(listed, key=lambda r: natural_key(r["label"]))
            )
            listing = (
                "<table><thead><tr><th>Cable</th><th>A end</th><th>B end</th>"
                f"<th class='n'>Length</th></tr></thead><tbody>{trs}</tbody></table>"
            )
        else:
            listing = (f"<p class='muted'>{n} cables - the schedule's Detail column "
                       f"names {escape(cu['label'])} for each.</p>")
        ratio = f" · 1:{cu['ratio']}" if cu.get("ratio") else ""
        pages.append(
            "<section class='cu'>"
            f"<h2>Detail {escape(cu['label'])} "
            f"<span>{n} {'cable' if n == 1 else 'cables'}{escape(ratio)}</span></h2>"
            f"<div class='cuimg'><img src='{escape(cu['url'])}' alt=''{sized(cu)}></div>"
            f"{cu.get('legend', '')}{listing}"
            "</section>"
        )
    for tp in traces:
        row = rows.get(tp["cable"])
        if row is not None:
            pages.append(trace_html({**tp, "style": sized(tp)}, row))
    if pages:
        body[0:0] = ["".join(pages), "<div class='after'></div>"]
    sub = escape(subtitle)
    if facts:
        n = len(data["rows"])
        sub += f"<span class='facts'>All {n} {'cable' if n == 1 else 'cables'}: {facts}</span>"
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
        ".sub .facts{margin-left:4mm;color:#3f3f46}"
        f".thumb{{height:{mm((ph - 2 * MARGIN_MM) * 0.55)};margin-bottom:4mm;"
        "border:0.25mm solid #d4d4d8;border-radius:1mm;padding:2mm;box-sizing:border-box}"
        ".thumb img{width:100%;height:100%;object-fit:contain;display:block}"
        ".cap{color:#71717a;font-size:6.5pt;margin:-3mm 0 3mm}"
        ".cu{break-before:page}"
        f".cuimg{{height:{mm(cu_outer)};margin-bottom:2mm;border:0.25mm solid #d4d4d8;"
        "border-radius:1mm;padding:1mm;box-sizing:border-box}"
        ".cuimg img{width:100%;height:100%;object-fit:contain;display:block}"
        ".cu .bundle-legend{margin-bottom:2mm}"
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
        f"{TABLE_CSS}{BUNDLE_LEGEND_CSS}"
        "</style></head><body>"
        f"<h1>{escape(title)} - cable schedule</h1>"
        f"<div class='sub'>{sub}</div>"
        f"{thumb}"
        f"{''.join(body)}"
        f"{totals_html(data)}"
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
CLOSEUPS_HELP = (
    "Close-up pages of the clusters of connected equipment: `auto` when a cell "
    "would print under 2 mm on the overview or there are several clusters, `on` "
    "whenever they print larger than the overview, `off`."
)
#: How the cables print: as the page drew them (``lines``), or drawn here
#: as bundles (``bundles``, the page posting the plan without them).
CABLE_MODES = ("lines", "bundles")
CABLES_HELP = (
    "`lines` (the default): the cables as the posted drawing has them. `bundles`: "
    "the drawing is posted without its cables and they are drawn here - one stroke "
    "per stretch, its width stepped by the cables riding it, with counts and a legend."
)
#: Trace ids one request may name; the first MAX_TRACES get a page.
MAX_TRACE_IDS = 200
TRACE_HELP = (
    "Cables to give a trace page each, in order: ids of cables on this schedule the "
    "reader may view (the first 20 get a page). Any other id is refused."
)


def _unique(ids) -> list[str]:
    out: list[str] = []
    for i in ids:
        s = str(i)
        if s not in out:
            out.append(s)
    return out


class CableSchedulePdfRequestSerializer(serializers.Serializer):
    group = serializers.ChoiceField(choices=GROUPS, required=False, default="room")
    paper = DrawingPaperSerializer(required=False, help_text="A4 landscape when absent.")
    svg = serializers.CharField(
        trim_whitespace=False, max_length=MAX_SVG_BYTES, required=False, allow_blank=True,
        help_text="The plan with its routes, as the page draws it, for the first page.",
    )
    closeup_svgs = serializers.DictField(
        child=serializers.CharField(trim_whitespace=False, max_length=MAX_SVG_BYTES),
        required=False,
        help_text="The plan drawn for each close-up, keyed by its label: its box as the "
                  "viewBox, at its scale (`cable-schedule/closeups/`).",
    )
    closeups = serializers.ChoiceField(
        choices=CLOSEUP_MODES, required=False, default="auto", help_text=CLOSEUPS_HELP,
    )
    cables = serializers.ChoiceField(
        choices=CABLE_MODES, required=False, default="lines", help_text=CABLES_HELP,
    )
    trace = serializers.ListField(
        child=serializers.UUIDField(), required=False, max_length=MAX_TRACE_IDS,
        help_text=TRACE_HELP,
    )
    trace_svgs = serializers.DictField(
        child=serializers.CharField(trim_whitespace=False, max_length=MAX_SVG_BYTES),
        required=False,
        help_text="The plan drawn without cables for each trace page, keyed by cable id: "
                  "its box as the viewBox, at its scale (`cable-schedule/closeups/?trace=`).",
    )

    def validate_closeup_svgs(self, value):
        from .cable_schedule_plan import MAX_CLOSEUPS

        if len(value) > MAX_CLOSEUPS:
            raise serializers.ValidationError(f"At most {MAX_CLOSEUPS} close-ups.")
        return value

    def validate_trace(self, value):
        return _unique(value)

    def validate_trace_svgs(self, value):
        from .cable_schedule_plan import MAX_TRACES

        if len(value) > MAX_TRACES:
            raise serializers.ValidationError(f"At most {MAX_TRACES} trace pages.")
        return value


class CloseupLayoutSerializer(serializers.Serializer):
    size = serializers.ChoiceField(choices=tuple(PAPERS_MM), required=False, default="a4")
    orientation = serializers.ChoiceField(
        choices=("landscape", "portrait"), required=False, default="landscape",
    )
    closeups = serializers.ChoiceField(
        choices=CLOSEUP_MODES, required=False, default="auto", help_text=CLOSEUPS_HELP,
    )
    box = serializers.CharField(
        required=False,
        help_text="The overview's viewBox (plan px): x,y,w,h; needed unless `closeups=off`.",
    )
    trace = serializers.CharField(
        required=False, allow_blank=True,
        help_text="Comma-separated cable ids for trace pages (as the PDF's `trace`).",
    )

    def validate_box(self, value):
        from .cable_schedule_plan import Box

        try:
            x, y, w, h = (float(v) for v in value.replace(",", " ").split())
        except ValueError:
            raise serializers.ValidationError("Four numbers: x,y,w,h.") from None
        if not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 0 or h <= 0:
            raise serializers.ValidationError("A finite box with a size.")
        return Box(x, y, w, h)

    def validate(self, attrs):
        if attrs.get("closeups") != "off" and attrs.get("box") is None:
            raise serializers.ValidationError({"box": "The overview's viewBox: x,y,w,h."})
        return attrs

    def validate_trace(self, value):
        import uuid as _uuid

        parts = [p for p in value.replace(" ", "").split(",") if p]
        if len(parts) > MAX_TRACE_IDS:
            raise serializers.ValidationError(f"At most {MAX_TRACE_IDS} cables.")
        try:
            return _unique(_uuid.UUID(p) for p in parts)
        except ValueError:
            raise serializers.ValidationError("Cable ids, comma-separated.") from None


def check_traces(trace: list[str], listed) -> None:
    """Refuse a trace of a cable that is not a listed row of this schedule
    - another tenant's, one not on this plan, one the reader may not view -
    with the same answer for each, so none is told apart."""
    ids = set(listed)
    if any(t not in ids for t in trace):
        raise serializers.ValidationError({"trace": ["Not a cable of this schedule."]})


def cable_info(schedule: dict) -> dict[str, dict]:
    """``{id: {type, type_label}}`` of the listed cables, for the bundles."""
    return {r["id"]: {"type": r["type"], "type_label": r["type_display"]}
            for r in schedule["rows"]}


def _print_key(user_id, tenant_id) -> str:
    return f"cable-schedule-pdf-print:{user_id}:{tenant_id}"


class PlanPages:
    """The overview, close-ups and trace pages of a schedule PDF, composed
    from the posted drawings (``cable_schedule_plan``): background and CAD
    drawing under them, the close-ups framed round the clusters of cable
    ends, a trace page round each traced cable; with ``bundles``, the
    cables drawn here (``cable_bundles``)."""

    def __init__(self, *, view, plan, crop, paper: str, orientation: str, mode: str,
                 geometry: dict, bundles: bool = False, info: dict | None = None,
                 tiles=(), trace: list[str] | None = None):
        from . import cable_schedule_plan as cp
        from .floor_plan_pdf import _ready_drawing

        self.cp = cp
        self.view, self.plan, self.crop = view, plan, crop
        self.paper, self.orientation, self.mode = paper, orientation, mode
        self.geometry = cp.to_px(geometry)
        self.background = cp.Background(plan, crop, view.background_opacity)
        self.drawing = _ready_drawing(view)
        self.info = info or {}
        self.tiles = [tuple(v * cp.CELL for v in t) for t in tiles]
        self.bundles = None
        if bundles:
            from .cable_bundles import Bundles

            self.bundles = Bundles(self.geometry, self.info)
        self.trace = list(trace or [])
        self.closeups: list = []
        self.traces: list = []
        self.frames: list = []
        self.dropped = 0
        self.traces_dropped = 0
        self.cad_note = ""
        self.pages: dict[str, bytes] = {}
        self.overview_legend = ""
        self._cads: dict = {}

    @property
    def grid(self):
        cp = self.cp
        return cp.Box(0, 0, self.view.grid_width * cp.CELL, self.view.grid_height * cp.CELL)

    def layout(self, box) -> tuple[list, float]:
        """The close-up pages for an overview of ``box`` (plan px), and the
        overview's scale."""
        cp = self.cp
        scale = cp.fit_scale(box, *cp.thumb_mm(self.paper, self.orientation))
        _outer, cw, ch = cp.closeup_mm(self.paper, self.orientation)
        if self.mode == "off":
            return [], scale
        pages, self.dropped = cp.closeup_layout(
            self.geometry, content=box, grid=self.grid, page_mm=(cw, ch),
            overview_mm_per_px=scale, mode=self.mode,
            px_per_cell=self.background.px_per_cell(),
        )
        return pages, scale

    def trace_layout(self) -> list:
        """A page per traced cable (the first ``MAX_TRACES``)."""
        cp = self.cp
        if not self.trace:
            return []
        _outer, cw, ch = cp.closeup_mm(self.paper, self.orientation)
        pages, self.traces_dropped = cp.trace_layout(
            self.geometry, self.trace, grid=self.grid, page_mm=(cw, ch),
            px_per_cell=self.background.px_per_cell(),
        )
        return pages

    def _cad(self, mm_per_px: float):
        from .floor_plan_pdf import cad_group
        from .svg_sanitize import SvgRejected, SvgTooLarge

        if self.drawing is None:
            return None
        key = round(mm_per_px, 6)
        if key in self._cads:
            return self._cads[key]
        g = None
        try:
            g, dropped = cad_group(self.drawing, paper_mm_per_px=mm_per_px,
                                   px_per_mm=self.cp.CELL / self.view.cell_mm)
            if dropped:
                self.cad_note = "Drawing text left out"
        except SvgTooLarge:
            self.cad_note = "Drawing left out: too large"
        except (SvgRejected, OSError, etree.XMLSyntaxError) as exc:
            log.warning("Cable schedule PDF: CAD drawing of %s unreadable: %s",
                        self.view.pk, exc)
            self.cad_note = "Drawing left out: unreadable"
        self._cads[key] = g
        return g

    def caption(self) -> str:
        parts = []
        if self.drawing is not None:
            parts.append(f"Drawing: {self.drawing.source_name or 'CAD drawing'}")
        if self.cad_note:
            parts.append(self.cad_note)
        return " · ".join(parts)

    def _posted(self, details: dict, label: str, box):
        """A posted drawing for a page, when its viewBox is the page's box."""
        if label not in details:
            return None
        drawing = etree.fromstring(details[label])
        vb = self.cp.view_box(drawing)
        return drawing if vb is not None and _same_box(vb, box) else None

    def _ratio(self, mm_per_px: float):
        return _ratio(self.view.cell_mm, mm_per_px * self.cp.CELL)

    def compose(self, overview: bytes | None, details: dict[str, bytes],
                traced: dict[str, bytes] | None = None) -> bytes:
        """The overview SVG (b"" without one); the close-ups and trace
        pages go into ``self.pages``. A posted close-up or trace drawing
        (``details`` by label, ``traced`` by cable id, sanitised) is used
        when its viewBox is the page's box - else the page has the
        background, the CAD drawing and the cables but not the plan."""
        cp = self.cp
        grid = (self.view.grid_width * cp.CELL, self.view.grid_height * cp.CELL)
        posted = etree.fromstring(overview) if overview else None
        out = b""
        if posted is not None:
            box = cp.view_box(posted) or cp.Box(0, 0, *grid)
            pages, scale = self.layout(box)
            for page in pages:
                url = f"{BASE_URL}_/closeup-{page.label}.svg"
                self.pages[url] = cp.compose(
                    self._posted(details, page.label, page.box), page.box, grid=grid,
                    background=self.background.element(page.box, page.mm_per_px),
                    cad=self._cad(page.mm_per_px), ends=page.ends, mm_per_px=page.mm_per_px,
                    bundles=self.bundles, tiles=self.tiles,
                )
                w_mm, h_mm = page.size_mm
                self.closeups.append({"label": page.label, "url": url, "rows": page.cables,
                                      "width_mm": w_mm, "height_mm": h_mm,
                                      "ratio": self._ratio(page.mm_per_px),
                                      "legend": self._legend()})
            self.frames = pages
            out = cp.compose(
                posted, box, grid=grid, background=self.background.element(box, scale),
                cad=self._cad(scale), frames=self.frames, mm_per_px=scale,
                bundles=self.bundles, tiles=self.tiles, stubs=True,
            )
            self.overview_legend = self._legend()
        if self.trace:
            from .cable_bundles import Bundles

            for page in self.trace_layout():
                cid = page.cables[0]
                url = f"{BASE_URL}_/trace-{page.label}.svg"
                others = Bundles(self.geometry, self.info, exclude={cid})
                self.pages[url] = cp.compose(
                    self._posted(traced or {}, cid, page.box), page.box, grid=grid,
                    background=self.background.element(page.box, page.mm_per_px),
                    cad=self._cad(page.mm_per_px), mm_per_px=page.mm_per_px,
                    bundles=others, tiles=self.tiles, trace=cid,
                )
                w_mm, h_mm = page.size_mm
                self.traces.append({"label": page.label, "url": url, "cable": cid,
                                    "width_mm": w_mm, "height_mm": h_mm,
                                    "ratio": self._ratio(page.mm_per_px)})
        return out

    def note(self) -> str:
        if not self.dropped:
            return ""
        n = len(self.closeups)
        return (f"{n} close-ups of the busiest parts; {self.dropped} more "
                f"{'part' if self.dropped == 1 else 'parts'} with cables not shown close up")

    def trace_note(self) -> str:
        if not self.traces_dropped:
            return ""
        n = self.traces_dropped
        return f"{n} more {'cable' if n == 1 else 'cables'} asked for a trace page left out"

    def _legend(self) -> str:
        return self.bundles.legend_html() if self.bundles is not None else ""

    def legend(self) -> str:
        """The overview's bundle legend."""
        return self.overview_legend


def _ratio(cell_mm: float, paper_cell_mm: float) -> int | None:
    """The 1:N a cell of ``cell_mm`` printed ``paper_cell_mm`` wide is, N to
    two significant figures."""
    if not cell_mm or paper_cell_mm <= 0:
        return None
    n = cell_mm / paper_cell_mm
    if n < 1:
        return None
    step = 10 ** max(0, math.floor(math.log10(n)) - 1)
    return int(round(n / step) * step)


def _same_box(a, b, tol: float = 0.5) -> bool:
    return all(abs(u - v) <= tol for u, v in ((a.x, b.x), (a.y, b.y), (a.w, b.w), (a.h, b.h)))


def closeup_layout(request, view, plan, crop, tenant) -> Response:
    """``GET .../cable-schedule/closeups/``: the close-up pages the PDF of
    this schedule will have for an overview framed to ``box`` - each page's
    label, plan box (px) and scale (paper mm per plan px) - and, for the
    cables of ``trace``, their trace pages, for the page to draw the plan
    at before it posts the PDF."""
    ser = CloseupLayoutSerializer(data=request.query_params)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    trace = data.get("trace") or []
    geometry: dict = {}
    schedule = build(plan, crop, request.user, tenant, geometry=geometry, routes=bool(trace))
    check_traces(trace, (r["id"] for r in schedule["rows"]))
    planned = PlanPages(view=view, plan=plan, crop=crop, paper=data["size"],
                        orientation=data["orientation"], mode=data["closeups"],
                        geometry=geometry, trace=trace)
    pages, scale = planned.layout(data.get("box") or planned.grid)
    traces = planned.trace_layout()
    return Response({
        "overview_mm_per_px": scale,
        "dropped": planned.dropped,
        "pages": [
            {"label": p.label, "box": [p.box.x, p.box.y, p.box.w, p.box.h],
             "mm_per_px": p.mm_per_px, "cables": len(p.cables)}
            for p in pages
        ],
        "traces": [
            {"label": p.label, "cable": p.cables[0], "box": [p.box.x, p.box.y, p.box.w, p.box.h],
             "mm_per_px": p.mm_per_px}
            for p in traces
        ],
        "traces_dropped": planned.traces_dropped,
    })


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
    trace = data.get("trace") or []
    bundles = data["cables"] == "bundles"
    geometry: dict = {}
    tiles: list = []
    schedule = build(plan, crop, request.user, tenant, group=data["group"], geometry=geometry,
                     routes=bundles or bool(trace), tile_boxes=tiles)
    check_traces(trace, (r["id"] for r in schedule["rows"]))
    snaps.frame(view)
    title, subtitle = plan_title(view, view.tenant.name)
    generated = reader_now(request.user, tenant)
    svg_text = data.get("svg") or ""
    detail_texts = data.get("closeup_svgs") or {}
    trace_texts = {k: v for k, v in (data.get("trace_svgs") or {}).items() if k in trace}
    thumbnail = bool(svg_text.strip())
    planned = PlanPages(
        view=view, plan=plan, crop=crop, paper=size, orientation=orientation,
        mode=data["closeups"], geometry=geometry, bundles=bundles,
        info=cable_info(schedule), tiles=tiles, trace=trace,
    ) if thumbnail or trace else None

    def sanitize(text: str) -> bytes:
        if planned is None:
            return b""
        overview = sanitize_svg(text) if thumbnail else None
        details = {
            label: sanitize_svg(t) for label, t in detail_texts.items()
            if t.strip() and data["closeups"] != "off"
        } if thumbnail else {}
        traced = {cid: sanitize_svg(t) for cid, t in trace_texts.items() if t.strip()}
        return planned.compose(overview, details, traced)

    def render(svg: bytes) -> bytes:
        return run_with_deadline(
            _render, svg, timeout=RENDER_TIMEOUT,
            pages=planned.pages if planned else {},
            data=schedule, title=title, subtitle=subtitle, generated=generated,
            paper=size, orientation=orientation, thumbnail=thumbnail,
            closeups=planned.closeups if planned else None,
            closeup_note=planned.note() if planned else "",
            caption=planned.caption() if planned else "",
            traces=planned.traces if planned else None,
            trace_note=planned.trace_note() if planned else "",
            legend=planned.legend() if planned else "",
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
