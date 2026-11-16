"""The floor-plan report: ``POST /api/floor-plans/{id}/export/report/``.

One PDF of a part of a floor plan - what the screen shows (``view``), the
whole floor (``floor``), a room or area on it (``area``) or every level of
its building (``building``) - with a title block, the plan sheet(s) and,
as asked, its cable schedule, its inventory (racks, cabinets and devices)
and a summary of its connected ports.

What the scope covers is worked out here, never taken from the page: the
area must be one of this floor's the reader may view, the view's box is
clamped to the plan, a building's levels are the floors of the plan's
floor plan the reader may view, in floor order. The page posts only the
drawings, one per sheet (``sheets``: the floor it draws and its SVG, as
``plan-svg.ts`` draws it for that box and paper, and its legends); a sheet
for a floor outside the scope is refused. Each drawing is sanitised as the
floor-plan PDF's, the plan's background image and CAD drawing laid under it
here (``api/cable_schedule_plan.py``). The tables are built here from the
scope: the cable schedule (``api/cable_schedule.py``) limited to the
cables with an end or a route in the scope, the inventory and the ports,
each filtered by the reader's object permissions - an object the reader may
not view is counted, not listed, and a cable end on one reads Hidden.

``POST .../export/report/tables/`` answers the same tables as JSON, for the
page's CSV and XLSX. The PDF obeys the drawing PDFs' limits
(``api/drawing_pdf.py``): the body cap, one render per user and a few
across the server, the deadline and ``?print=1``'s five-minute link.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from html import escape

from django.db.models import Q
from django.http import HttpResponse
from django.urls import reverse
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from lxml import etree
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from . import cable_schedule as sched
from .drawing_pdf import (
    BASE_URL,
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
from .floor_plan_pdf import _bar_html, _legend_html, _LegendSerializer, _lum, _rgb, scale_bar
from .natural import natural_key
from .svg_sanitize import MAX_SVG_BYTES, SvgRejected, SvgTooLarge, sanitize_svg

log = logging.getLogger(__name__)

SCOPES = ("view", "floor", "area", "building")
INCLUDES = ("plan", "cables", "inventory", "ports")
#: Plan pixels per grid cell - frontend/src/components/floorplan/floor-canvas.tsx.
CELL = 40
#: Cells round a room or area on its sheet.
AREA_MARGIN_CELLS = 2
#: At most this many sheets (a building's levels).
MAX_SHEETS = 24
#: At most this many rows in the ports summary.
MAX_PORT_ROWS = 5000
#: A plan sheet's page: the bottom margin holds the running footer; the
#: sheet's heading and its strip of scale bar and legends take these (mm).
#: Mirrored by frontend/src/components/floorplan/report.ts.
BOTTOM_MM = 14.0
HEAD_MM = 8.0
FOOT_MM = 20.0
NO_ROOM = "No room"
INK = "#18181b"


# ─── The scope ──────────────────────────────────────────────────────────────


@dataclass
class Part:
    """One floor's part of the report: ``view`` the plan drawn (a live view
    or a floor), ``plan`` the one holding its contents, ``crop`` (source
    cells) what the tables cover, ``keep`` the tiles kept (a room's),
    ``box`` (plan px of ``view``) the sheet's frame."""

    view: object
    plan: object
    crop: object
    box: object
    level: str
    keep: object = None
    view_crop: object = None
    area: object = None


def _grid_box(view):
    from .cable_schedule_plan import Box

    return Box(0, 0, view.grid_width * CELL, view.grid_height * CELL)


def _intersect(a, b):
    from .floor_plan_snapshots import Crop

    x, y = max(a.x, b.x), max(a.y, b.y)
    x2, y2 = min(a.x2, b.x2), min(a.y2, b.y2)
    return Crop(x, y, max(0, x2 - x), max(0, y2 - y))


def _cells(box, view_crop, view):
    """The whole source cells under ``box`` (plan px of ``view``)."""
    from .floor_plan_snapshots import Crop

    ox, oy = (view_crop.x, view_crop.y) if view_crop is not None else (0, 0)
    x0 = max(0, math.floor(box.x / CELL + 1e-6))
    y0 = max(0, math.floor(box.y / CELL + 1e-6))
    x1 = min(view.grid_width, math.ceil(box.x2 / CELL - 1e-6))
    y1 = min(view.grid_height, math.ceil(box.y2 / CELL - 1e-6))
    return Crop(x0 + ox, y0 + oy, max(0, x1 - x0), max(0, y1 - y0))


def _inside(outline):
    """A tile test: its centre inside ``outline`` (cells)."""
    def keep(t) -> bool:
        x = t.x + t.width / 2
        y = t.y + t.height / 2
        hit = False
        n = len(outline)
        for i in range(n):
            (ax, ay), (bx, by) = outline[i], outline[(i + 1) % n]
            if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
                hit = not hit
        return hit

    return keep


def floor_label(plan) -> str:
    return plan.name


def resolve_scope(view, data, user, tenant, resolved) -> list[Part]:
    """The parts the report covers, checked; ``resolved(plan)`` is the
    viewset's ``(source, crop)`` of a plan (refusing a live view whose
    source the reader may not view). ``serializers.ValidationError`` for a
    scope that is not this plan's."""
    from auth_api import rbac

    from . import floor_plan_snapshots as snaps
    from .cable_schedule_plan import Box
    from .floor_stacks import ordered_floors
    from .models import FloorPlanArea

    scope = data["scope"]
    if scope == "building":
        stack = view.stack if view.stack_id else None
        if stack is None:
            raise serializers.ValidationError({"scope": "This plan is not in a building."})
        floors = list(rbac.restrict_queryset(
            ordered_floors(stack).filter(tenant=tenant), user, tenant, "floorplan", "view",
        ))
        if len(floors) > MAX_SHEETS:
            raise serializers.ValidationError(
                {"scope": f"A building of at most {MAX_SHEETS} levels."}
            )
        parts = []
        for f in floors:
            try:
                src, crop = resolved(f)
            except PermissionDenied:  # a view whose source the reader may not see
                continue
            snaps.frame(f)
            parts.append(Part(view=f, plan=src, crop=crop, box=_grid_box(f),
                              level=floor_label(f), view_crop=crop))
        if not parts:
            raise serializers.ValidationError({"scope": "No level of this building to show."})
        return parts

    src, crop = resolved(view)
    snaps.frame(view)
    grid = _grid_box(view)
    part = Part(view=view, plan=src, crop=crop, box=grid, level=floor_label(view),
                view_crop=crop)
    if scope == "floor":
        return [part]
    if scope == "view":
        b = data.get("box")
        if not b:
            raise serializers.ValidationError({"box": "The view's box, in plan pixels."})
        x0, y0 = max(grid.x, b[0]), max(grid.y, b[1])
        x1, y1 = min(grid.x2, b[0] + b[2]), min(grid.y2, b[1] + b[3])
        if x1 - x0 < 1 or y1 - y0 < 1:
            raise serializers.ValidationError({"box": "The view shows none of the plan."})
        part.box = Box(x0, y0, x1 - x0, y1 - y0)
        cells = _cells(part.box, crop, view)
        part.crop = _intersect(cells, crop) if crop is not None else cells
        return [part]
    # area
    area_id = data.get("area")
    if not area_id:
        raise serializers.ValidationError({"area": "Pick a room or an area."})
    area = rbac.restrict_queryset(
        FloorPlanArea.objects.filter(floor_plan=src, pk=area_id).select_related(
            "room", "location", "area_type"
        ),
        user, tenant, "floorplanarea", "view",
    ).first()
    if area is None or (crop is not None and snaps.classify("areas", area, crop) is None):
        raise serializers.ValidationError({"area": "Not a room or area of this floor."})
    full = snaps.area_crop(area, 0, src.grid_width, src.grid_height)
    framed = snaps.area_crop(area, AREA_MARGIN_CELLS, src.grid_width, src.grid_height)
    if crop is not None:
        full, framed = _intersect(full, crop), _intersect(framed, crop)
    if full.empty:
        raise serializers.ValidationError({"area": "Not a room or area of this floor."})
    ox, oy = (crop.x, crop.y) if crop is not None else (0, 0)
    part.box = Box((framed.x - ox) * CELL, (framed.y - oy) * CELL,
                   framed.w * CELL, framed.h * CELL)
    part.crop = full
    outline = snaps.area_outline(area)
    if len(outline) >= 3:
        part.keep = _inside(outline)
    part.level = f"{floor_label(view)} · {area}"
    part.area = area
    return [part]


def scope_title(view, parts, scope: str) -> tuple[str, str]:
    """The report's title and what it covers."""
    stack = view.stack if view.stack_id else None
    if scope == "building":
        n = len(parts)
        return (stack.name if stack else view.name,
                f"Building · {n} {'level' if n == 1 else 'levels'}")
    name = f"{stack.name} · {view.name}" if stack and stack.name != view.name else view.name
    if scope == "area":
        area = getattr(parts[0], "area", None)
        kind = "Room" if area is not None and area.room_id else "Area"
        return f"{name} · {area}", kind
    return name, {"view": "This view", "floor": "Whole floor"}[scope]


# ─── The tables ─────────────────────────────────────────────────────────────


def cables(parts, user, tenant) -> dict:
    """The cable schedule of the parts: one row per cable, the first level
    that lists it giving its ends and rooms, its route and computed length
    joined across levels."""
    multi = len(parts) > 1
    rows: dict = {}
    order: list = []
    group_of: dict = {}
    hidden: set = set()
    for part in parts:
        data = sched.build(part.plan, part.crop, user, tenant, keep_tile=part.keep,
                           strict=part.crop is not None, hidden_out=hidden)
        for r in data["rows"]:
            room = (r["rooms"] or [NO_ROOM])[0]
            if r["id"] not in rows:
                r = dict(r)
                if multi and r["route"]:
                    r["route"] = f"{part.level}: {r['route']}"
                rows[r["id"]] = r
                order.append(r["id"])
                group_of[r["id"]] = f"{part.level} · {room}" if multi else room
                continue
            have = rows[r["id"]]
            if r["route"]:
                hop = f"{part.level}: {r['route']}"
                have["route"] = f"{have['route']} | {hop}" if have["route"] else hop
            if r["computed_m"] is not None:
                have["computed_m"] = round((have["computed_m"] or 0) + r["computed_m"], 2)
    hidden -= set(rows)
    groups: dict = {}
    for rid in order:
        groups.setdefault(group_of[rid], []).append(rid)
    ordered = sorted(groups, key=lambda k: (k.endswith(NO_ROOM), natural_key(k)))
    if multi:
        levels = {p.level: i for i, p in enumerate(parts)}
        ordered = sorted(groups, key=lambda k: (
            levels.get(k.split(" · ")[0], 99), k.endswith(NO_ROOM), natural_key(k)))
    totals: dict = {}
    for rid in order:
        r = rows[rid]
        key = r["type"] or ""
        t = totals.setdefault(key, {"type": key, "label": r["type_display"] or sched.NO_TYPE,
                                    "count": 0, "metres": 0.0, "unmeasured": 0})
        t["count"] += 1
        m = r["length_m"] if r["length_m"] is not None else r["computed_m"]
        if m is None:
            t["unmeasured"] += 1
        else:
            t["metres"] += m
    total_rows = sorted(totals.values(),
                        key=lambda t: (t["label"] == sched.NO_TYPE, t["label"].lower()))
    for t in total_rows:
        t["metres"] = round(t["metres"], 2)
    return {
        "group": "room",
        "rows": [rows[rid] for rid in order],
        "groups": [{"name": k, "rows": groups[k]} for k in ordered],
        "totals": total_rows,
        "total": {
            "count": len(order),
            "metres": round(sum(t["metres"] for t in total_rows), 2),
            "unmeasured": sum(t["unmeasured"] for t in total_rows),
        },
        "hidden_count": len(hidden),
    }


def _tiles(part, user, tenant, hidden_tiles=frozenset()):
    from auth_api import rbac

    from . import floor_plan_snapshots as snaps

    tiles = list(rbac.restrict_queryset(
        part.plan.tiles.filter(
            Q(device__isnull=False) | Q(rack__isnull=False) | Q(cabinet__isnull=False)
        ).order_by("y", "x", "id"),
        user, tenant, "floorplantile", "view",
    ))
    if part.crop is not None:
        tiles = [t for t, _e in snaps.in_crop("tiles", tiles, part.crop)]
    if part.keep is not None:
        tiles = [t for t in tiles if part.keep(t)]
    return [t for t in tiles if str(t.pk) not in hidden_tiles]


def _badge(obj) -> dict | None:
    if obj is None:
        return None
    return {"name": obj.name, "color": getattr(obj, "color", "") or "",
            "text_color": getattr(obj, "text_color", "") or ""}


def _room(obj) -> str:
    room = getattr(obj, "room", None) if getattr(obj, "room_id", None) else None
    if room is not None:
        return room.name
    for parent in ("rack", "cabinet"):
        if getattr(obj, f"{parent}_id", None):
            p = getattr(obj, parent)
            if p is not None and p.room_id:
                return p.room.name
    loc = getattr(obj, "location", None) if getattr(obj, "location_id", None) else None
    return loc.name if loc is not None else ""


def _device_row(d, part, names, parent=None) -> dict:
    holder, pos = "", ""
    if d.rack_id:
        holder = names.get(("rack", d.rack_id), "Hidden")
        pos = f"U{d.position}" if d.position else ""
    elif d.cabinet_id:
        holder = names.get(("cabinet", d.cabinet_id), "Hidden")
    dt_ = d.device_type
    return {
        "kind": "device", "id": str(d.pk), "name": d.name, "parent": parent,
        "role": _badge(d.role), "type": str(dt_) if dt_ else "",
        "status": _badge(d.status), "holder": holder, "position": pos,
        "serial": d.serial_number or "", "asset_tag": d.asset_tag or "",
        "room": _room(d), "level": part.level,
    }


def _holder_row(kind, obj, type_, part) -> dict:
    return {
        "kind": kind, "id": str(obj.pk), "name": obj.name, "parent": None,
        "role": _badge(obj.role), "type": str(type_) if type_ else "",
        "status": _badge(obj.status), "holder": "", "position": "",
        "serial": "", "asset_tag": "", "room": _room(obj), "level": part.level,
    }


def _part_inventory(part, user, tenant, hidden_tiles, seen: set):
    """One part's racks, cabinets and devices as rows by room, in order;
    the devices listed; and how many objects are hidden."""
    from auth_api import rbac

    from .models import Cabinet, Device, Rack

    tiles = _tiles(part, user, tenant, hidden_tiles)
    rack_ids = {t.rack_id for t in tiles if t.rack_id}
    cab_ids = {t.cabinet_id for t in tiles if t.cabinet_id}
    dev_ids = {t.device_id for t in tiles if t.device_id}
    racks = list(rbac.restrict_queryset(
        Rack.objects.filter(tenant=tenant, pk__in=rack_ids), user, tenant, "rack", "view",
    ).select_related("role", "status", "rack_type", "room", "location"))
    cabs = list(rbac.restrict_queryset(
        Cabinet.objects.filter(tenant=tenant, pk__in=cab_ids), user, tenant, "cabinet", "view",
    ).select_related("role", "status", "cabinet_type", "room", "location"))
    dev_q = Device.objects.filter(tenant=tenant).filter(
        Q(pk__in=dev_ids) | Q(rack_id__in=rack_ids) | Q(cabinet_id__in=cab_ids)
    )
    devs = list(rbac.restrict_queryset(dev_q, user, tenant, "device", "view").select_related(
        "role", "status", "device_type", "device_type__manufacturer", "room", "location",
        "rack__room", "cabinet__room",
    ))
    hidden = (len(rack_ids) - len(racks)) + (len(cab_ids) - len(cabs)) \
        + (dev_q.count() - len(devs))
    names = {("rack", r.pk): r.name for r in racks}
    names.update({("cabinet", c.pk): c.name for c in cabs})
    inside: dict = {}
    loose = []
    listed = []
    for d in devs:
        if d.pk in seen:
            continue
        seen.add(d.pk)
        listed.append(d)
        if d.rack_id and ("rack", d.rack_id) in names:
            inside.setdefault(("rack", d.rack_id), []).append(d)
        elif d.cabinet_id and ("cabinet", d.cabinet_id) in names:
            inside.setdefault(("cabinet", d.cabinet_id), []).append(d)
        else:
            loose.append(d)
    rooms: dict = {}
    for kind, holders, type_of in (("rack", racks, "rack_type"), ("cabinet", cabs, "cabinet_type")):
        for h in sorted(holders, key=lambda o: natural_key(o.name)):
            rows = rooms.setdefault(_room(h) or NO_ROOM, [])
            rows.append(_holder_row(kind, h, getattr(h, type_of), part))
            ds = inside.get((kind, h.pk), [])
            ds.sort(key=lambda d: (-(d.position or 0), natural_key(d.name)))
            rows.extend(_device_row(d, part, names, str(h.pk)) for d in ds)
    for d in sorted(loose, key=lambda d: natural_key(d.name)):
        rooms.setdefault(_room(d) or NO_ROOM, []).append(_device_row(d, part, names))
    return rooms, listed, hidden


def inventory(parts, user, tenant, hidden_tiles=frozenset()) -> tuple[dict, list]:
    """The racks, cabinets and devices of the parts as the reader may view
    them, grouped by room then rack (by level, then room, for a building);
    and the devices listed (for the ports). Objects the reader may not view
    are counted in ``hidden_count``; the tiles hidden on screen
    (``hidden_tiles``, the floor's own) are left out."""
    multi = len(parts) > 1
    groups = []
    hidden = 0
    listed: list = []
    seen: set = set()
    for part in parts:
        rooms, devs, n = _part_inventory(
            part, user, tenant, frozenset() if multi else hidden_tiles, seen
        )
        hidden += n
        listed.extend(devs)
        for room in sorted(rooms, key=lambda k: (k == NO_ROOM, natural_key(k))):
            name = f"{part.level} · {room}" if multi else room
            groups.append({"name": name, "rows": rooms[room]})
    rows = [r for g in groups for r in g["rows"]]
    counts = {
        "racks": sum(r["kind"] == "rack" for r in rows),
        "cabinets": sum(r["kind"] == "cabinet" for r in rows),
        "devices": sum(r["kind"] == "device" for r in rows),
    }
    return {"groups": groups, "count": counts, "hidden_count": hidden}, listed


def ports(devices, user, tenant) -> dict:
    """Per device listed, its cabled ports and their far ends; a far end on
    a device the reader may not view reads Hidden, a cable the reader may
    not view is counted, not listed."""
    from auth_api import rbac

    from .cable_scope import viewable_cable_ids
    from .models import CableTermination

    by_id = {d.pk: d for d in devices}
    if not by_id:
        return {"rows": [], "hidden_count": 0, "truncated": False}
    fields = [f for f in CableTermination.POINT_FIELDS
              if f not in ("power_feed", "circuit_termination")]
    on = Q()
    for f in fields:
        on |= Q(**{f"{f}__device_id__in": list(by_id)})
    mine = list(CableTermination.objects.filter(on).select_related(
        "cable", *CableTermination.POINT_FIELDS))
    cable_ids = {t.cable_id for t in mine}
    visible = viewable_cable_ids(user, tenant, cable_ids)
    others: dict = {}
    for t in CableTermination.objects.filter(cable_id__in=visible).select_related(
        *CableTermination.POINT_FIELDS
    ).order_by("end", "created_at", "pk"):
        others.setdefault(t.cable_id, []).append(t)
    viewable = None if user.is_superuser else rbac.ViewableRows(user, tenant)
    far_devs = set()
    for ts in others.values():
        for t in ts:
            dev = getattr(t.point, "device_id", None)
            if dev:
                far_devs.add(dev)
    if viewable is not None:
        viewable.prime("device", far_devs)
    from .models import Device

    names = dict(Device.objects.filter(pk__in=far_devs).values_list("pk", "name"))

    def far(t) -> str:
        p = t.point
        dev = getattr(p, "device_id", None)
        if dev is None:
            return str(p or "")
        if viewable is not None and not viewable.may_view("device", dev):
            return "Hidden"
        return " · ".join(x for x in (names.get(dev, ""), getattr(p, "name", "")) if x)

    rows = []
    for t in mine:
        if t.cable_id not in visible:
            continue
        p = t.point
        dev = by_id.get(getattr(p, "device_id", None))
        if dev is None:
            continue
        ends = [far(o) for o in others.get(t.cable_id, []) if o.end != t.end]
        rows.append({
            "device": dev.name, "device_id": str(dev.pk), "port": getattr(p, "name", "") or "",
            "cable": str(t.cable), "cable_color": t.cable.color or "",
            "far": ", ".join(e for e in ends if e),
        })
    rows.sort(key=lambda r: (natural_key(r["device"]), r["device_id"], natural_key(r["port"])))
    truncated = len(rows) > MAX_PORT_ROWS
    return {"rows": rows[:MAX_PORT_ROWS], "hidden_count": len(cable_ids - visible),
            "truncated": truncated}


def tables(parts, include, user, tenant, hidden_tiles=frozenset()) -> dict:
    out: dict = {}
    if "cables" in include:
        out["cables"] = cables(parts, user, tenant)
    if "inventory" in include or "ports" in include:
        inv, devices = inventory(parts, user, tenant, hidden_tiles)
        if "inventory" in include:
            out["inventory"] = inv
        if "ports" in include:
            out["ports"] = ports(devices, user, tenant)
    return out


# ─── Paper ──────────────────────────────────────────────────────────────────


def _page(paper: str, orientation: str) -> tuple[float, float]:
    pw, ph = PAPERS_MM[paper]
    return (ph, pw) if orientation == "portrait" else (pw, ph)


def sheet_area(paper: str, orientation: str) -> tuple[float, float]:
    """The plan's room on a plan sheet (mm)."""
    pw, ph = _page(paper, orientation)
    return pw - 2 * MARGIN_MM, ph - MARGIN_MM - BOTTOM_MM - HEAD_MM - FOOT_MM


def _readable(color: str) -> str:
    rgb = _rgb(color or "")
    if rgb is None:
        return INK
    return INK if _lum(rgb) > 0.36 else "#ffffff"


def _pill(badge: dict | None, cls: str = "pill") -> str:
    if not badge:
        return ""
    c = badge.get("color") or ""
    rgb = _rgb(c)
    if rgb is None:
        return f"<span class='{cls} plain'>{escape(badge['name'])}</span>"
    hex_ = "#" + "".join(f"{round(v * 255):02x}" for v in rgb)
    fg = badge.get("text_color") or ""
    fg = fg if _rgb(fg) is not None else _readable(hex_)
    return (f"<span class='{cls}' style='background:{hex_};color:{fg}'>"
            f"{escape(badge['name'])}</span>")


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _cover_html(*, title, kind, subtitle, parts, data, generated, include, version) -> str:
    rows = [("Scope", kind), ("Floor plan", subtitle)]
    if len(parts) > 1:
        rows.append(("Levels", ", ".join(p.level for p in parts)))
    else:
        rows.append(("Floor", parts[0].level))
    rows += [("Generated", stamp(generated)), ("Danbyte", version)]
    kv = "".join(f"<tr><th>{escape(k)}</th><td>{escape(v)}</td></tr>" for k, v in rows if v)
    contents = []
    if "plan" in include:
        contents.append(("Plan", _plural(len(parts), "sheet")))
    if "cables" in data:
        c = data["cables"]
        line = _plural(c["total"]["count"], "cable")
        if c["total"]["metres"]:
            line += f" · {c['total']['metres']:g} m"
        contents.append(("Cable schedule", line))
    if "inventory" in data:
        n = data["inventory"]["count"]
        contents.append(("Inventory", " · ".join((
            _plural(n["racks"], "rack"), _plural(n["cabinets"], "cabinet"),
            _plural(n["devices"], "device")))))
    if "ports" in data:
        contents.append(("Ports", _plural(len(data["ports"]["rows"]), "connected port")))
    toc = "".join(f"<tr><th>{escape(k)}</th><td>{escape(v)}</td></tr>" for k, v in contents)
    return (
        "<section class='cover'>"
        f"<h1>{escape(title)}</h1>"
        f"<table class='kv'>{kv}</table>"
        "<h3>Contents</h3>"
        f"<table class='kv'>{toc}</table>"
        "</section>"
    )


def _sheet_html(sheet: dict) -> str:
    keys = ("legend", "area_legend") if sheet.get("bundle_legend") else (
        "legend", "cable_legend", "area_legend")
    left = (_bar_html(sheet["bar"]) if sheet.get("bar") else "") + "".join(
        _legend_html(sheet.get(k)) for k in keys
    ) + (sheet.get("bundle_legend") or "")
    if sheet.get("credit"):
        left += f"<div class='credit'>{escape(sheet['credit'])}</div>"
    w, h = sheet["size"]
    return (
        "<section class='sheet'>"
        f"<h2>{escape(sheet['title'])} <span>{escape(sheet['ratio'])}</span></h2>"
        f"<div class='pic'><img src='{escape(sheet['url'])}' alt='' "
        f"style='width:{w:.3f}mm;height:{h:.3f}mm'></div>"
        f"<div class='sfoot'>{left}</div>"
        "</section>"
    )


def _cables_html(data: dict, multi: bool, *, width_mm: float,
                 traces: list[dict] | None = None) -> str:
    """The cable schedule section: the schedule's tables
    (``cable_schedule.schedule_tables``: hoisted values, route bands) under
    the report's headings, its totals, then a trace page per traced cable."""
    traces = traces or []
    on_pages: dict = {}
    for tp in traces:
        on_pages.setdefault(tp["cable"], []).append(tp["label"])
    tables, facts = sched.schedule_tables(
        data, width_mm=width_mm, on_pages=on_pages, heading="h3", detail=bool(traces),
    )
    body = tables or "<p class='muted'>No cables in this scope.</p>"
    n = data["total"]["count"]
    lead = (f"<p class='facts'>All {_plural(n, 'cable')}: {facts}</p>" if facts else "")
    rows = {r["id"]: r for r in data["rows"]}
    pages = "".join(sched.trace_html(tp, rows[tp["cable"]], heading="h2")
                    for tp in traces if tp["cable"] in rows)
    note = ""
    if data.get("trace_note"):
        note = f"<p class='muted'>{escape(data['trace_note'])}</p>"
    return (
        "<section class='part'><h2>Cable schedule</h2>"
        f"{lead}{body}{sched.totals_html(data, heading='h3', note=note)}</section>"
        f"{pages}"
    )


_KIND = {"rack": "Rack", "cabinet": "Cabinet", "device": "Device"}


def _cols(*pcts: int) -> str:
    """One width per column, so every group's table lines up."""
    return "<colgroup>" + "".join(f"<col style='width:{p}%'>" for p in pcts) + "</colgroup>"


_INV_COLS = _cols(15, 7, 11, 18, 9, 12, 7, 11, 10)


def _inventory_html(data: dict) -> str:
    head = (
        "<tr><th>Name</th><th>Kind</th><th>Role</th><th>Type</th><th>Status</th>"
        "<th>Rack / cabinet</th><th>Position</th><th>Serial</th><th>Asset tag</th></tr>"
    )
    body = []
    for g in data["groups"]:
        trs = []
        for r in g["rows"]:
            cls = " class='child'" if r["parent"] else (
                " class='holder'" if r["kind"] != "device" else "")
            trs.append(
                f"<tr{cls}>"
                f"<td class='b'>{escape(r['name'])}</td>"
                f"<td>{_KIND[r['kind']]}</td>"
                f"<td>{_pill(r['role'], 'tag')}</td>"
                f"<td>{escape(r['type'])}</td>"
                f"<td>{_pill(r['status'])}</td>"
                f"<td>{escape(r['holder'])}</td>"
                f"<td>{escape(r['position'])}</td>"
                f"<td class='mono'>{escape(r['serial'])}</td>"
                f"<td class='mono'>{escape(r['asset_tag'])}</td>"
                "</tr>"
            )
        body.append(
            f"<h3>{escape(g['name'])} <span>{_plural(len(g['rows']), 'object')}</span></h3>"
            f"<table class='fixed'>{_INV_COLS}<thead>{head}</thead>"
            f"<tbody>{''.join(trs)}</tbody></table>"
        )
    if not data["groups"]:
        body.append("<p class='muted'>No racks, cabinets or devices in this scope.</p>")
    hidden = data["hidden_count"]
    if hidden:
        body.append(f"<p class='muted'>{_plural(hidden, 'object')} hidden - not listed.</p>")
    return f"<section class='part'><h2>Inventory</h2>{''.join(body)}</section>"


def _ports_html(data: dict) -> str:
    trs = []
    last = None
    for r in data["rows"]:
        first = r["device_id"] != last
        last = r["device_id"]
        trs.append(
            f"<tr{' class=first' if first else ''}>"
            f"<td class='b'>{escape(r['device']) if first else ''}</td>"
            f"<td>{escape(r['port'])}</td>"
            f"<td>{sched._swatch(r['cable_color'])}{escape(r['cable'])}</td>"
            f"<td>{escape(r['far'])}</td>"
            "</tr>"
        )
    body = (
        "<table><thead><tr><th>Device</th><th>Port</th><th>Cable</th><th>Far end</th>"
        f"</tr></thead><tbody>{''.join(trs)}</tbody></table>"
        if trs else "<p class='muted'>No connected ports in this scope.</p>"
    )
    notes = []
    if data["truncated"]:
        notes.append(f"Only the first {MAX_PORT_ROWS:,} ports are listed.")
    if data["hidden_count"]:
        notes.append(f"{_plural(data['hidden_count'], 'cable')} hidden - not listed.")
    extra = "".join(f"<p class='muted'>{escape(n)}</p>" for n in notes)
    return f"<section class='part'><h2>Ports</h2>{body}{extra}</section>"


def _css_str(text: str) -> str:
    return sched._css_str(text)


def report_html(*, title, kind, subtitle, parts, sheets, data, generated, include,
                paper, orientation, traces: list[dict] | None = None) -> str:
    from danbyte import __version__

    from .cable_bundles import BUNDLE_LEGEND_CSS
    from .cable_schedule_plan import closeup_mm

    pw, ph = _page(paper, orientation)
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    _aw, ah = sheet_area(paper, orientation)
    running = f"{title} · {stamp(generated)} · Danbyte {__version__}"
    pages = [_cover_html(title=title, kind=kind, subtitle=subtitle, parts=parts, data=data,
                         generated=generated, include=include, version=__version__)]
    pages += [_sheet_html(s) for s in sheets]
    multi = len(parts) > 1
    if "cables" in data:
        pages.append(_cables_html(data["cables"], multi, width_mm=pw - 2 * MARGIN_MM,
                                  traces=traces))
    if "inventory" in data:
        pages.append(_inventory_html(data["inventory"]))
    if "ports" in data:
        pages.append(_ports_html(data["ports"]))
    font = "font-family:Inter,'DejaVu Sans',sans-serif;font-size:6.5pt;color:#71717a"
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{escape(title)}</title>"
        f"<meta name='generator' content='Danbyte {escape(__version__)}'>"
        "<style>"
        f"{_font_faces()}"
        f"@page{{size:{mm(pw)} {mm(ph)};margin:{mm(MARGIN_MM)} {mm(MARGIN_MM)} {mm(BOTTOM_MM)};"
        f"@bottom-left{{content:'{_css_str(running)}';{font}}}"
        f"@bottom-right{{content:'Page ' counter(page) ' / ' counter(pages);{font}}}}}"
        "html,body{margin:0;padding:0}"
        f"body{{font-family:Inter,'DejaVu Sans',sans-serif;color:{INK};font-size:7pt}}"
        "section.part,section.sheet{break-before:page}"
        ".cover h1{font-size:16pt;font-weight:700;margin:0 0 5mm}"
        ".cover h3{font-size:9pt;margin:7mm 0 1.5mm}"
        ".kv{width:auto;min-width:110mm;border-collapse:collapse;font-size:8.5pt}"
        ".kv th{width:34mm;text-align:left;font-weight:500;color:#52525b;padding:1.2mm 6mm 1.2mm 0;"
        "border-bottom:0.15mm solid #e4e4e7;white-space:nowrap;vertical-align:top}"
        ".kv td{padding:1.2mm 0;border-bottom:0.15mm solid #e4e4e7}"
        f".sheet{{height:{mm(ph - MARGIN_MM - BOTTOM_MM - 0.5)};position:relative}}"
        f".sheet h2{{height:{mm(HEAD_MM - 2)};margin:0 0 2mm}}"
        f".pic{{height:{mm(ah)};display:flex;align-items:flex-start;justify-content:center}}"
        ".pic img{display:block;border:0.2mm solid #d4d4d8}"
        f".sfoot{{position:absolute;left:0;right:0;bottom:0;height:{mm(FOOT_MM - 2)};"
        "font-size:6.5pt;color:#52525b;overflow:hidden}"
        ".bar{margin-bottom:1.2mm}"
        f".ticks{{display:flex;height:1.6mm;border:0.2mm solid {INK}}}"
        ".ticks span{display:block;height:100%}"
        ".bl{margin-top:0.6mm;white-space:nowrap}"
        f".bl b{{color:{INK};font-weight:600}}"
        ".legend{line-height:1.5;display:inline-block;margin-right:6mm;vertical-align:top}"
        f".lt{{font-weight:600;color:{INK}}}"
        ".li{display:inline-block;margin-right:3mm;white-space:nowrap}"
        ".li i{display:inline-block;width:3.5mm;height:2.2mm;border:0.25mm solid;"
        "border-radius:0.5mm;margin-right:1mm;vertical-align:-0.3mm}"
        ".li i.ln{height:0;border:0;border-radius:0;vertical-align:0.6mm}"
        ".credit{margin-top:0.8mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
        "h2{font-size:11pt;font-weight:700;margin:0 0 3mm;break-after:avoid}"
        "h2 span{font-weight:400;font-size:8pt;color:#71717a;margin-left:2mm}"
        "h3{font-size:8.5pt;font-weight:600;margin:4mm 0 1.5mm;break-after:avoid}"
        "h3 span{font-weight:400;color:#71717a;margin-left:2mm}"
        "table{width:100%;border-collapse:collapse;margin-bottom:2mm}"
        "table.fixed{table-layout:fixed}"
        ".keep{break-inside:avoid}"
        "table.fixed td{overflow-wrap:anywhere}"
        "table.fixed td.b{white-space:normal}"
        "thead{display:table-header-group}"
        "th{text-align:left;font-weight:600;color:#52525b;border-bottom:0.3mm solid #a1a1aa;"
        "padding:0.8mm 1.2mm;white-space:nowrap}"
        "td{border-bottom:0.15mm solid #e4e4e7;padding:0.8mm 1.2mm;vertical-align:top}"
        "tr{break-inside:avoid}"
        "tr.holder td{background:#f4f4f5}"
        "tr.child td:first-child{padding-left:4mm}"
        ".n{text-align:right;white-space:nowrap}"
        ".b{font-weight:600;white-space:nowrap}"
        ".mono{font-variant-numeric:tabular-nums}"
        ".notes{color:#52525b}"
        ".muted{color:#71717a}"
        ".sw{display:inline-block;width:2.2mm;height:2.2mm;border-radius:0.4mm;"
        "border:0.15mm solid #a1a1aa;margin-right:1mm;vertical-align:-0.3mm}"
        ".pill,.tag{display:inline-block;padding:0.15mm 1.4mm;font-size:6.3pt;font-weight:500;"
        "white-space:nowrap;line-height:1.35}"
        ".pill{border-radius:0.6mm}"
        ".tag{border-radius:0.6mm}"
        ".plain{background:#f4f4f5;color:#3f3f46}"
        ".totals{width:auto;min-width:90mm}"
        ".totals .sum td{font-weight:600;border-top:0.3mm solid #a1a1aa}"
        ".facts{color:#3f3f46;margin:-1.5mm 0 2mm}"
        f"{sched.TABLE_CSS}{BUNDLE_LEGEND_CSS}"
        ".sfoot .bundle-legend{display:inline-block;vertical-align:top;margin-right:6mm}"
        "section.cu{break-before:page}"
        f".cuimg{{height:{mm(closeup_mm(paper, orientation)[0])};margin-bottom:2mm;"
        "border:0.25mm solid #d4d4d8;border-radius:1mm;padding:1mm;box-sizing:border-box}"
        ".cuimg img{width:100%;height:100%;object-fit:contain;display:block}"
        "</style></head><body>"
        f"{''.join(pages)}"
        "</body></html>"
    )


class _Fetcher(PdfUrlFetcher):
    """The drawing PDFs' fetcher, serving the report's sheets."""

    def __init__(self, pages: dict[str, bytes]):
        super().__init__(b"")
        self.pages = pages

    def __call__(self, url: str):
        if url in self.pages:
            return _response(url, self.pages[url], "image/svg+xml")
        return super().__call__(url)


def render_report_pdf(_svg: bytes, *, pages: dict, **kwargs) -> bytes:
    import weasyprint

    return weasyprint.HTML(
        string=report_html(**kwargs), base_url=BASE_URL, url_fetcher=_Fetcher(pages)
    ).write_pdf()


def _render(svg: bytes, **kwargs) -> bytes:
    # Looked up when called, so the child renders what this module names.
    return render_report_pdf(svg, **kwargs)


def render_with_deadline(*, timeout: float = RENDER_TIMEOUT, **kwargs) -> bytes:
    return run_with_deadline(_render, b"", timeout=timeout, **kwargs)


# ─── Sheets ─────────────────────────────────────────────────────────────────


def compose_sheet(part, posted: bytes | None, paper: str, orientation: str, *,
                  bundles: dict | None = None) -> dict:
    """A plan sheet: the posted drawing (sanitised) framed to the part's
    box, the background image and CAD drawing under it, fitted to the
    sheet; its scale bar and credit line. ``bundles`` (``{user, tenant,
    info}``): the part's cables drawn here as bundles
    (``api/cable_bundles.py``), the page having posted the plan without
    them, with their legend."""
    from . import cable_schedule_plan as cp
    from .floor_plan_pdf import _ready_drawing, cad_group

    view = part.view
    aw, ah = sheet_area(paper, orientation)
    box = part.box
    scale = cp.fit_scale(box, aw, ah)
    grid = (view.grid_width * CELL, view.grid_height * CELL)
    background = cp.Background(part.plan, part.view_crop, view.background_opacity)
    drawing = _ready_drawing(view)
    cad, credit = None, ""
    if drawing is not None:
        credit = f"Drawing: {drawing.source_name or 'CAD drawing'}"
        try:
            cad, dropped = cad_group(drawing, paper_mm_per_px=scale,
                                     px_per_mm=CELL / view.cell_mm)
            if dropped:
                credit += " · text left out"
        except SvgTooLarge:
            credit += " · left out: too large"
        except (SvgRejected, OSError, etree.XMLSyntaxError) as exc:
            log.warning("Floor plan report: CAD drawing of %s unreadable: %s", view.pk, exc)
            credit += " · left out: unreadable"
    root = etree.fromstring(posted) if posted else None
    drawn = None
    tiles: list = []
    if bundles is not None:
        from .cable_bundles import Bundles

        geometry: dict = {}
        cells: list = []
        sched.build(part.plan, part.crop, bundles["user"], bundles["tenant"],
                    keep_tile=part.keep, strict=part.crop is not None, geometry=geometry,
                    routes=True, origin=part.view_crop, tile_boxes=cells)
        drawn = Bundles(cp.to_px(geometry), bundles["info"])
        tiles = [tuple(v * CELL for v in t) for t in cells]
    svg = cp.compose(root, box, grid=grid, background=background.element(box, scale),
                     cad=cad, mm_per_px=scale, bundles=drawn, tiles=tiles, stubs=True)
    px_per_mm = CELL / view.cell_mm
    bar = scale_bar(scale * px_per_mm)
    return {"svg": svg, "size": (box.w * scale, box.h * scale), "bar": bar,
            "ratio": bar["ratio"], "credit": credit,
            "bundle_legend": drawn.legend_html() if drawn is not None else ""}


# ─── The request ────────────────────────────────────────────────────────────


class ReportSheetSerializer(serializers.Serializer):
    floor = serializers.UUIDField(help_text="The floor (plan) the drawing is of.")
    svg = serializers.CharField(trim_whitespace=False, max_length=MAX_SVG_BYTES,
                                help_text="The plan as plan-svg.ts draws it for the sheet.")
    legend = _LegendSerializer(required=False, allow_null=True)
    cable_legend = _LegendSerializer(required=False, allow_null=True)
    area_legend = _LegendSerializer(required=False, allow_null=True)


class ReportScopeSerializer(serializers.Serializer):
    scope = serializers.ChoiceField(choices=SCOPES)
    area = serializers.UUIDField(required=False, allow_null=True,
                                 help_text="The room or area (`scope=area`).")
    box = serializers.ListField(
        child=serializers.FloatField(), min_length=4, max_length=4, required=False,
        help_text="What the screen shows (`scope=view`): x, y, w, h in plan px.",
    )
    include = serializers.ListField(
        child=serializers.ChoiceField(choices=INCLUDES), min_length=1, max_length=4,
        help_text="plan, cables, inventory and/or ports.",
    )
    hidden_tiles = serializers.ListField(
        child=serializers.UUIDField(), required=False, max_length=10000,
        help_text="Tiles hidden on screen, left out of the inventory (this floor only).",
    )

    def validate_box(self, value):
        if not all(math.isfinite(v) for v in value) or value[2] <= 0 or value[3] <= 0:
            raise serializers.ValidationError("A finite box with a size.")
        return value


class ReportRequestSerializer(ReportScopeSerializer):
    paper = DrawingPaperSerializer(required=False, help_text="A3 landscape when absent.")
    sheets = ReportSheetSerializer(many=True, required=False, max_length=MAX_SHEETS)
    cables = serializers.ChoiceField(
        choices=sched.CABLE_MODES, required=False, default="lines",
        help_text=sched.CABLES_HELP,
    )
    trace = serializers.ListField(
        child=serializers.UUIDField(), required=False, max_length=sched.MAX_TRACE_IDS,
        help_text="With `cables` in `include`: cables of this floor listed in the report "
                  "to give a trace page each (the first 20). Any other id is refused.",
    )
    trace_svgs = serializers.DictField(
        child=serializers.CharField(trim_whitespace=False, max_length=MAX_SVG_BYTES),
        required=False,
        help_text="This floor drawn without cables for each trace page, keyed by cable "
                  "id (`cable-schedule/closeups/?trace=`).",
    )

    def validate_trace(self, value):
        return sched._unique(value)

    def validate_trace_svgs(self, value):
        from .cable_schedule_plan import MAX_TRACES

        if len(value) > MAX_TRACES:
            raise serializers.ValidationError(f"At most {MAX_TRACES} trace pages.")
        return value


def _print_key(user_id, tenant_id) -> str:
    return f"floorplan-report-print:{user_id}:{tenant_id}"


def _scope(request, view, tenant, resolved, serializer_class):
    ser = serializer_class(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    parts = resolve_scope(view, data, request.user, tenant, resolved)
    hidden = frozenset(str(t) for t in data.get("hidden_tiles") or [])
    return data, parts, hidden


def export_tables(request, view, tenant, resolved) -> Response:
    """The report's tables as JSON, for CSV and XLSX."""
    data, parts, hidden = _scope(request, view, tenant, resolved, ReportScopeSerializer)
    out = tables(parts, set(data["include"]), request.user, tenant, hidden)
    title, kind = scope_title(view, parts, data["scope"])
    return Response({"title": title, "scope": kind,
                     "levels": [p.level for p in parts], **out})


def export_report(request, view, tenant, resolved) -> HttpResponse | Response:
    """The report of ``view`` - a plan the caller may view, found by the
    viewset - as one PDF."""
    from .floor_plan_pdf import plan_title

    if body_too_large(request, MAX_BODY_BYTES):
        return detail("The request is over 10 MB.", 413)
    data, parts, hidden = _scope(request, view, tenant, resolved, ReportRequestSerializer)
    include = set(data["include"])
    paper = data.get("paper") or {}
    size = paper.get("size", "a3")
    orientation = paper.get("orientation", "landscape")
    posted = {}
    allowed = {str(p.view.pk) for p in parts}
    for s in data.get("sheets") or []:
        if str(s["floor"]) not in allowed:
            return Response({"sheets": ["A drawing of a floor outside this export."]}, status=400)
        posted[str(s["floor"])] = s
    if "plan" in include and not posted:
        return Response({"sheets": ["The plan's drawing, one per sheet."]}, status=400)
    trace = data.get("trace") or []
    if trace and "cables" not in include:
        return Response({"trace": ["Trace pages come with the cable schedule."]}, status=400)
    tbl = tables(parts, include, request.user, tenant, hidden)
    traced = None
    if trace:
        traced = _trace_pages(request, view, tenant, resolved, tbl["cables"], trace,
                              size, orientation)
    bundles = None
    if data["cables"] == "bundles" and "plan" in include:
        info = sched.cable_info(tbl["cables"]) if "cables" in tbl else None
        bundles = {"user": request.user, "tenant": tenant, "info": info}
    title, kind = scope_title(view, parts, data["scope"])
    _name, subtitle = plan_title(view, view.tenant.name)
    if view.stack_id:
        subtitle = " · ".join(x for x in (view.stack.name, subtitle) if x)
    generated = reader_now(request.user, tenant)
    sheets: list = []
    pages: dict = {}

    def sanitize(_text: str) -> bytes:
        if "plan" not in include:
            return b""
        for i, part in enumerate(parts):
            s = posted.get(str(part.view.pk))
            clean = sanitize_svg(s["svg"]) if s else None
            part_bundles = bundles
            if bundles is not None and bundles["info"] is None:
                part_bundles = {**bundles, "info": sched.cable_info(sched.build(
                    part.plan, part.crop, request.user, tenant, keep_tile=part.keep,
                    strict=part.crop is not None))}
            sheet = compose_sheet(part, clean, size, orientation, bundles=part_bundles)
            url = f"{BASE_URL}_/sheet-{i}.svg"
            pages[url] = sheet.pop("svg")
            sheet.update(url=url, title=part.level,
                         **{k: (s or {}).get(k) for k in ("legend", "cable_legend",
                                                           "area_legend")})
            sheets.append(sheet)
        return b""

    def sanitize_all(text: str) -> bytes:
        out = sanitize(text)
        if traced is not None:
            svgs = {cid: sanitize_svg(t) for cid, t in (data.get("trace_svgs") or {}).items()
                    if cid in trace and t.strip()}
            traced.compose(None, {}, svgs)
            pages.update(traced.pages)
            tbl["cables"]["trace_note"] = traced.trace_note()
        return out

    def render(_svg: bytes) -> bytes:
        return render_with_deadline(
            pages=pages, title=title, kind=kind, subtitle=subtitle, parts=parts,
            sheets=sheets, data=tbl, generated=generated, include=include,
            paper=size, orientation=orientation,
            traces=traced.traces if traced is not None else None,
        )

    try:
        pdf = render_guarded(request, "", sanitize=sanitize_all, render=render)
    except RenderTimeout:
        log.warning("Floor plan report for user %s stopped after %ss", request.user.pk,
                    RENDER_TIMEOUT)
        return detail("The report took too long to render. Leave out the ports or the "
                      "plan, or export a smaller part.", 413)
    if isinstance(pdf, Response):
        return pdf
    return deliver(
        request,
        pdf,
        name=file_name(f"{title} report", generated, "floor-plan-report"),
        key=_print_key(request.user.pk, view.tenant_id),
        link=lambda token: reverse(
            "floor-plan-export-report-file", kwargs={"pk": str(view.pk), "token": token}
        ),
        label="Floor plan report",
        extra={"object": str(view.pk)},
    )


def _trace_pages(request, view, tenant, resolved, rows: dict, trace: list[str],
                 paper: str, orientation: str):
    """The trace pages of a report: cables listed in it and on this floor's
    schedule (``serializers.ValidationError`` for any other), laid out as
    the schedule's (``cable_schedule.PlanPages``)."""
    src, crop = resolved(view)
    geometry: dict = {}
    tiles: list = []
    floor = sched.build(src, crop, request.user, tenant, geometry=geometry, routes=True,
                        tile_boxes=tiles)
    listed = {r["id"] for r in rows["rows"]} & {r["id"] for r in floor["rows"]}
    sched.check_traces(trace, listed)
    return sched.PlanPages(
        view=view, plan=src, crop=crop, paper=paper, orientation=orientation, mode="off",
        geometry=geometry, info=sched.cable_info(rows), tiles=tiles, trace=trace,
    )


def export_report_file(request, view, token: str) -> HttpResponse | Response:
    return kept_pdf(request, token, key=_print_key(request.user.pk, view.tenant_id),
                    match={"object": str(view.pk)})


# ─── Schema ─────────────────────────────────────────────────────────────────

_ERRORS = {
    400: OpenApiResponse(description="Invalid scope, area, box or drawing."),
    403: OpenApiResponse(description="No view on floor plans, or on a view's source."),
    404: OpenApiResponse(description="No such plan for this user and tenant."),
}

report_schema = extend_schema(
    summary="A floor plan report as a PDF",
    description=(
        "One PDF of `scope` - `view` (the `box` the screen shows, plan px), `floor`, "
        "`area` (a room or area of this floor) or `building` (every level of the "
        "plan's floor plan the reader may view, in floor order) - with a title "
        "block, then, as `include` says, the plan sheet(s) (`plan`; one drawing "
        "per sheet in `sheets`, each the floor it draws and its SVG, sanitised, "
        "with the background image and CAD drawing added here), the cable "
        "schedule (`cables`), the racks, cabinets and devices (`inventory`) and "
        "the connected ports (`ports`), each filtered by the reader's object "
        "permissions. The scope is resolved and checked here; a drawing of a "
        "floor outside it is refused. The floor-plan PDF's limits apply; "
        "`?print=1` returns `{url}`, a five-minute link."
    ),
    tags=["floor-plans"],
    parameters=[OpenApiParameter(name="print", type=OpenApiTypes.BOOL,
                                 location=OpenApiParameter.QUERY,
                                 description="Answer with a short-lived link.")],
    request=ReportRequestSerializer,
    responses={
        (200, "application/pdf"): OpenApiTypes.BINARY,
        (200, "application/json"): OpenApiTypes.OBJECT,
        **_ERRORS,
        413: OpenApiResponse(description="Over a cap, or too slow to render."),
        429: OpenApiResponse(description="A PDF for this user is being made, or the "
                                         "server is making as many as it may."),
    },
)

tables_schema = extend_schema(
    summary="A floor plan report's tables",
    description=(
        "The tables of the report `export/report/` would make, as JSON - "
        "`cables` (the cable schedule's shape), `inventory` (`groups` of rows: "
        "`kind`, `name`, `role`, `type`, `status`, `holder`, `position`, "
        "`serial`, `asset_tag`, `room`, `level`, `parent`; `count`; "
        "`hidden_count`) and `ports` (`rows` of `device`, `port`, `cable`, "
        "`far`; `hidden_count`; `truncated`) - as `include` asks."
    ),
    tags=["floor-plans"],
    request=ReportScopeSerializer,
    responses={200: OpenApiTypes.OBJECT, **_ERRORS},
)

report_file_schema = extend_schema(
    summary="A floor plan report made with ?print=1",
    description=("The PDF behind a print link, for five minutes, to the user and tenant "
                 "that made it; inline, or as a download with `?download=1`."),
    tags=["floor-plans"],
    parameters=[
        OpenApiParameter(name="token", type=OpenApiTypes.STR, location=OpenApiParameter.PATH),
        OpenApiParameter(name="download", type=OpenApiTypes.BOOL,
                         location=OpenApiParameter.QUERY),
    ],
    request=None,
    responses={(200, "application/pdf"): OpenApiTypes.BINARY,
               404: OpenApiResponse(description="No such link.")},
)
