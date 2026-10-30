"""Cable routes on a floor plan: computing, measuring and storing them.

One service for everything that routes a cable on a plan - the
``cable-plan`` preview, the ``bulk/`` save of cable paths, the cable's
``auto-route`` and ``routing`` actions. It wraps ``pathfinding.py`` (the
tray graph and Dijkstra) and adds what a stored route needs:

- **ends**: each cable end resolves to a tile on the plan - the device's own
  tile, else its rack's or cabinet's - and a port height (a racked device
  sits at its U position; a device on its own tile, or in a cabinet, at the
  tenant's standalone termination height);
- **legs**: one per far tile, so a breakout cable keeps one path row;
- **lengths**, by the tenant's rules (``core.effective_settings.
  cable_length_rules``): horizontal run + both drops + level changes +
  service loops, plus slack, rounded up to the step. A computed length is
  written to the cable only when its length is blank or was computed
  before - never over a length a person entered unless asked;
- **staleness**: a path records the tile each end was routed from and its
  centre then. A tile moved since, a device now in another rack, or a tray
  it rides changing makes the path out of date (:func:`connect_signals`
  stores it; :func:`path_is_stale` derives it on read).

Coordinates are the plan's cell units; lengths are millimetres.
"""
from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Q
from django.utils import timezone

from .pathfinding import (
    RACK_PLINTH_MM,
    U_PITCH_MM,
    route_through_trays,
    tray_elevations,
)

#: A preview or a save routes at most this many cables (as bulk-create).
ROUTE_MAX = 256
#: Two points closer than this (cells) are the same point.
EPS = 1e-3
#: Points one leg may carry.
LEG_POINTS_MAX = 500

#: Millimetres in one of each ``Cable.length_unit``.
UNIT_MM = {"m": 1000.0, "cm": 10.0, "ft": 304.8, "in": 25.4}


def _r(v: float) -> float:
    return round(float(v), 3) + 0.0


def _pt(p) -> list[float]:
    return [_r(p[0]), _r(p[1])]


def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def tile_centre(t) -> tuple[float, float]:
    return (t.x + t.width / 2, t.y + t.height / 2)


def polyline_cells(points) -> float:
    return sum(_dist(p, q) for p, q in zip(points, points[1:], strict=False))


# ─── lengths ────────────────────────────────────────────────────────────────


def length_total(base_mm: float, rules: dict) -> tuple[int, int, int]:
    """``(loops_mm, slack_mm, length_mm)`` for a route whose run, drops and
    level changes come to ``base_mm``: a service loop at each end, then the
    slack percentage, then rounded up to the step (0: to the millimetre)."""
    loops = 2 * max(0, int(rules.get("service_loop_mm") or 0))
    raw = max(0.0, base_mm) + loops
    slack = raw * max(0, int(rules.get("slack_pct") or 0)) / 100
    total = raw + slack
    step = max(0, int(rules.get("step_mm") or 0))
    if step:
        total = math.ceil(total / step - 1e-9) * step
    else:
        total = math.ceil(total - 1e-9)
    return loops, int(round(slack)), int(total)


def mm_in_unit(mm: float, unit: str) -> Decimal:
    """``mm`` in a cable's length unit, to the centimetre the column keeps."""
    per = UNIT_MM.get(unit or "m", 1000.0)
    return Decimal(str(mm / per)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def length_writable(cable, replace: bool = False) -> bool:
    """May a computed length go on ``cable``? When it has none, when its
    length was computed before, or when the caller asks to replace a length
    a person entered."""
    return cable.length is None or cable.length_source == "computed" or bool(replace)


def write_length(cable, length_mm: int, *, replace: bool = False) -> bool:
    """Write a computed length on ``cable`` (an audited edit of the cable),
    in its own unit, when :func:`length_writable` allows. True when written."""
    if not length_mm or not length_writable(cable, replace):
        return False
    unit = cable.length_unit or "m"
    value = mm_in_unit(length_mm, unit)
    if cable.length == value and cable.length_source == "computed" \
            and cable.length_unit == unit:
        return False
    cable.length = value
    cable.length_unit = unit
    cable.length_source = "computed"
    cable.save(update_fields=["length", "length_unit", "length_source", "updated_at"])
    return True


def stored_length_mm(cable) -> float | None:
    if cable.length is None:
        return None
    return float(cable.length) * UNIT_MM.get(cable.length_unit or "m", 1000.0)


# ─── the router ─────────────────────────────────────────────────────────────


class PlanRouter:
    """Routes cables on one plan. The plan's tiles, trays, raised floors and
    the length rules are read once, so routing many cables costs one read.

    ``positions`` overrides tile geometry for a preview of unsaved moves:
    ``{tile_id: {"x", "y", "width"?, "height"?}}`` (tiles of this plan
    only; anything else is ignored)."""

    def __init__(self, plan, *, positions=None, rules=None):
        from core.effective_settings import cable_length_rules

        self.plan = plan
        self.cell_mm = plan.cell_mm or 600
        self.tiles = list(plan.tiles.select_related("rack").order_by("y", "x", "id"))
        for t in self.tiles:
            over = (positions or {}).get(str(t.pk))
            if isinstance(over, dict):
                for key in ("x", "y", "width", "height"):
                    v = over.get(key)
                    if isinstance(v, (int, float)) and not isinstance(v, bool):
                        setattr(t, key, v)
        self.tile_by_id = {str(t.pk): t for t in self.tiles}
        self.trays = list(plan.trays.order_by("name", "id"))
        self.tray_by_id = {str(t.pk): t for t in self.trays}
        areas = [
            (r.x, r.y, r.width, r.height, r.plenum_mm)
            for r in plan.raised_floor_areas.all()
        ]
        self.elevation = {
            str(t.pk): e
            for t, e in zip(
                self.trays, tray_elevations(self.trays, plan.ceiling_mm, areas), strict=True
            )
        }
        self.rules = rules or cable_length_rules(plan.tenant_id)
        self.device_tile: dict = {}
        self.rack_tile: dict = {}
        self.cabinet_tile: dict = {}
        for t in self.tiles:
            if t.device_id:
                self.device_tile.setdefault(t.device_id, t)
            if t.rack_id:
                self.rack_tile.setdefault(t.rack_id, t)
            if t.cabinet_id:
                self.cabinet_tile.setdefault(t.cabinet_id, t)
        self._devices: dict = {}
        self._terms: dict = {}

    # ── ends ──

    def prime(self, cables) -> None:
        """Read the terminations and devices of ``cables`` in two queries."""
        from .models import CableTermination, Device

        ids = [c.pk for c in cables if c.pk not in self._terms]
        if not ids:
            return
        terms = CableTermination.objects.filter(cable_id__in=ids).select_related(
            *CableTermination.POINT_FIELDS
        ).order_by("end", "created_at", "pk")
        wanted = set()
        for cid in ids:
            self._terms[cid] = []
        for term in terms:
            point = term.point
            dev_id = getattr(point, "device_id", None)
            self._terms[term.cable_id].append((term.end, dev_id, getattr(point, "name", "")))
            if dev_id and dev_id not in self._devices:
                wanted.add(dev_id)
        for d in Device.objects.filter(id__in=wanted).select_related("device_type").only(
            "id", "rack_id", "cabinet_id", "position", "device_type", "device_type__u_height"
        ):
            self._devices[d.pk] = d

    def tile_for(self, dev_id):
        """The tile a device is placed by: its own, else its rack's or
        cabinet's. None when it is not on this plan."""
        if dev_id is None:
            return None
        if dev_id in self.device_tile:
            return self.device_tile[dev_id]
        d = self._devices.get(dev_id)
        if d is None:
            return None
        if d.rack_id and d.rack_id in self.rack_tile:
            return self.rack_tile[d.rack_id]
        if d.cabinet_id and d.cabinet_id in self.cabinet_tile:
            return self.cabinet_tile[d.cabinet_id]
        return None

    def port_height_mm(self, dev_id, tile) -> float:
        """Where a device's ports are above the floor: a racked device at the
        middle of its units; a rack's device without a position at the
        rack's top; a device on its own tile or in a cabinet at the tenant's
        standalone termination height."""
        standalone = float(self.rules.get("standalone_height_mm") or 0)
        if tile is None or tile.device_id == dev_id or not tile.rack_id:
            return standalone
        d = self._devices.get(dev_id)
        if d is not None and d.position:
            u = getattr(d.device_type, "u_height", 1) if d.device_type_id else 1
            return RACK_PLINTH_MM + (d.position - 1 + (u or 0) / 2) * U_PITCH_MM
        rack = tile.rack
        if rack is not None and rack.u_height:
            return RACK_PLINTH_MM + rack.u_height * U_PITCH_MM
        return standalone

    def ends(self, cable) -> dict:
        """``{"A": [end, ...], "B": [...]}``, one per distinct tile, where an
        end is ``{"end", "tile", "device", "port", "height_mm"}``."""
        self.prime([cable])
        out: dict = {"A": [], "B": []}
        seen: dict = {"A": set(), "B": set()}
        for end, dev_id, port in self._terms.get(cable.pk, []):
            tile = self.tile_for(dev_id)
            if tile is None or end not in out or tile.pk in seen[end]:
                continue
            seen[end].add(tile.pk)
            out[end].append({
                "end": end, "tile": tile, "device": dev_id, "port": port,
                "height_mm": self.port_height_mm(dev_id, tile),
            })
        return out

    def pairs(self, cable) -> list[tuple[dict, dict]]:
        """The legs to route: from the side with fewer tiles (its first) to
        every tile of the other side, A first in each pair. Ends sharing a
        tile need no leg."""
        e = self.ends(cable)
        a, b = e["A"], e["B"]
        if not a or not b:
            return []
        if len(a) <= len(b):
            out = [(a[0], far) for far in b]
        else:
            out = [(near, b[0]) for near in a]
        return [(x, y) for x, y in out if x["tile"].pk != y["tile"].pk]

    # ── routing ──

    def _anchor(self, end: dict) -> dict:
        return {
            "end": end["end"],
            "tile": str(end["tile"].pk),
            "device": str(end["device"]) if end["device"] else None,
            "at": _pt(tile_centre(end["tile"])),
        }

    def _tray_spans(self, points, trays) -> list[dict]:
        """The trays a polyline rides, in travel order, each with the point
        it enters and leaves it by and its elevation."""
        spans: list[dict] = []
        for p, q in zip(points, points[1:], strict=False):
            hit = None
            for t in trays:
                tp = t.points or []
                for s, e in zip(tp, tp[1:], strict=False):
                    if _on_segment(p, s, e) and _on_segment(q, s, e):
                        hit = t
                        break
                if hit is not None:
                    break
            if hit is None:
                continue
            if spans and spans[-1]["id"] == str(hit.pk):
                spans[-1]["exit"] = _pt(q)
            else:
                spans.append({
                    "id": str(hit.pk), "entry": _pt(p), "exit": _pt(q),
                    "elevation_mm": round(self.elevation.get(str(hit.pk), 0.0)),
                })
        return spans

    def _route_leg(self, a_end, b_end, trays) -> dict:
        a = tile_centre(a_end["tile"])
        b = tile_centre(b_end["tile"])
        res = route_through_trays(
            a, b, [t.points for t in trays],
            elevations=[self.elevation.get(str(t.pk)) for t in trays],
        )
        used = [trays[i] for i in res.tray_indexes] if res.reachable else []
        if used:
            points = [_pt(p) for p in res.points]
            spans = self._tray_spans(points, used)
            return {
                "from": self._anchor(a_end), "to": self._anchor(b_end),
                "points": points, "trays": spans, "waypoints": [],
            }
        return self.direct_leg(a_end, b_end)

    def direct_leg(self, a_end, b_end) -> dict:
        """An orthogonal elbow between the two tiles, along x first."""
        a = tile_centre(a_end["tile"])
        b = tile_centre(b_end["tile"])
        pts = [a]
        if abs(a[0] - b[0]) > EPS and abs(a[1] - b[1]) > EPS:
            pts.append((b[0], a[1]))
        pts.append(b)
        return {
            "from": self._anchor(a_end), "to": self._anchor(b_end),
            "points": [_pt(p) for p in pts], "trays": [], "waypoints": [],
        }

    def measure_leg(self, leg: dict, a_end, b_end) -> dict:
        """The length breakdown of one leg (mm): its horizontal run, the drop
        at each end between the port and the first and last tray, and the
        climbs between trays at different heights. A run with no tray stays
        at the ports' height and climbs only between them."""
        run = polyline_cells(leg["points"]) * self.cell_mm
        ha, hb = a_end["height_mm"], b_end["height_mm"]
        elev = [float(s.get("elevation_mm") or 0) for s in leg.get("trays") or []]
        if elev:
            drop_a = abs(elev[0] - ha)
            drop_b = abs(elev[-1] - hb)
            level = sum(abs(y - x) for x, y in zip(elev, elev[1:], strict=False))
        else:
            drop_a = drop_b = 0.0
            level = abs(ha - hb)
        base = run + drop_a + drop_b + level
        loops, slack, total = length_total(base, self.rules)
        return {
            "run_mm": round(run), "drop_a_mm": round(drop_a), "drop_b_mm": round(drop_b),
            "extra_mm": round(level) + loops, "slack_mm": slack, "length_mm": total,
        }

    def _assemble(self, cable, kind, legs, pairs, tray_order=None) -> dict:
        measures = [self.measure_leg(leg, a, b) for leg, (a, b) in zip(legs, pairs, strict=True)]
        # A breakout is as long as its longest leg.
        best = max(measures, key=lambda m: m["length_mm"])
        if tray_order is None:
            tray_order = []
            for leg in legs:
                for s in leg["trays"]:
                    if s["id"] not in tray_order:
                        tray_order.append(s["id"])
        tile_ids = []
        for leg in legs:
            for side in ("from", "to"):
                if leg[side]["tile"] not in tile_ids:
                    tile_ids.append(leg[side]["tile"])
        return {
            "cable": str(cable.pk),
            "kind": kind,
            "legs": legs,
            "tray_order": list(tray_order),
            "tile_ids": tile_ids,
            **best,
        }

    def route(self, cable, tray_ids=None) -> dict | None:
        """The best route of ``cable`` on this plan: through its trays (all
        of the plan's, or only ``tray_ids``), else a direct elbow (``kind``
        ``direct``, ``reachable`` false). None when an end is not on the
        plan or both ends stand on one tile."""
        pairs = self.pairs(cable)
        if not pairs:
            return None
        trays = (
            self.trays if tray_ids is None
            else [self.tray_by_id[str(i)] for i in tray_ids if str(i) in self.tray_by_id]
        )
        trays = [t for t in trays if len(t.points or []) >= 2]
        legs = [self._route_leg(a, b, trays) for a, b in pairs]
        through = any(leg["trays"] for leg in legs)
        out = self._assemble(cable, "trays" if through else "direct", legs, pairs)
        out["reachable"] = through
        return out

    def from_geometry(self, cable, kind: str, legs_in, tray_order) -> dict:
        """A route a person drew or a preview produced, checked against the
        plan as it is: one leg per pair of tiles (:meth:`pairs`), each from
        its A tile's centre to its far tile's; trays named must be this
        plan's. The ends, tray spans and lengths are worked out here, never
        taken from the payload. Raises ``ValueError`` with the reason."""
        pairs = self.pairs(cable)
        if not pairs:
            raise ValueError("Both ends must be placed on this plan, on different tiles.")
        if kind not in ("trays", "manual", "direct"):
            raise ValueError("kind is trays, manual or direct.")
        if not isinstance(legs_in, list) or len(legs_in) != len(pairs):
            raise ValueError(f"Expected {len(pairs)} leg(s), one per far tile.")
        order = []
        for tid in tray_order or []:
            if str(tid) not in self.tray_by_id:
                raise ValueError(f"Not a tray on this plan: {tid}")
            if str(tid) not in order:
                order.append(str(tid))
        trays = [self.tray_by_id[t] for t in order]
        legs = []
        for raw, (a, b) in zip(legs_in, pairs, strict=True):
            pts = raw.get("points") if isinstance(raw, dict) else None
            if not isinstance(pts, list) or not 2 <= len(pts) <= LEG_POINTS_MAX:
                raise ValueError("Each leg needs 2 to 500 points.")
            clean = []
            for p in pts:
                if not (isinstance(p, (list, tuple)) and len(p) >= 2 and all(
                    isinstance(v, (int, float)) and not isinstance(v, bool)
                    and math.isfinite(v) for v in p[:2]
                )):
                    raise ValueError("A point is [x, y] in cells.")
                clean.append(_pt(p))
            if _dist(clean[0], tile_centre(a["tile"])) > 0.01 or \
                    _dist(clean[-1], tile_centre(b["tile"])) > 0.01:
                raise ValueError("A leg runs from its A tile's centre to its far tile's.")
            spans = self._tray_spans(clean, trays)
            waypoints = clean[1:-1] if kind == "manual" else []
            legs.append({
                "from": self._anchor(a), "to": self._anchor(b),
                "points": clean, "trays": spans, "waypoints": waypoints,
            })
        if kind == "trays" and not any(leg["trays"] for leg in legs):
            raise ValueError("The route rides none of the trays named.")
        return self._assemble(cable, kind, legs, pairs, tray_order=order)

    # ── staleness ──

    def stale(self, path) -> bool:
        """Is a stored path out of date against the plan as it is? Stored
        ``stale`` (a tray it rides changed), or an end's tile moved, gone,
        or no longer the one its device is placed by."""
        if path.stale:
            return True
        for leg in path.legs or []:
            for side in ("from", "to"):
                anchor = leg.get(side) or {}
                tile = self.tile_by_id.get(str(anchor.get("tile")))
                if tile is None:
                    return True
                at = anchor.get("at") or [None, None]
                c = tile_centre(tile)
                if at[0] is None or _dist(c, at) > EPS:
                    return True
                dev = anchor.get("device")
                if dev:
                    import uuid as _uuid

                    try:
                        now = self.tile_for(_uuid.UUID(str(dev)))
                    except ValueError:
                        now = None
                    if now is None or now.pk != tile.pk:
                        return True
        return False

    def prime_paths(self, paths) -> None:
        """Read the devices the stored paths' ends name, for :meth:`stale`."""
        import uuid as _uuid

        from .models import Device

        wanted = set()
        for p in paths:
            for leg in p.legs or []:
                for side in ("from", "to"):
                    dev = (leg.get(side) or {}).get("device")
                    try:
                        dev_id = _uuid.UUID(str(dev)) if dev else None
                    except ValueError:
                        dev_id = None
                    if dev_id and dev_id not in self._devices:
                        wanted.add(dev_id)
        for d in Device.objects.filter(id__in=wanted).select_related("device_type").only(
            "id", "rack_id", "cabinet_id", "position", "device_type", "device_type__u_height"
        ):
            self._devices[d.pk] = d


def _on_segment(p, s, e) -> bool:
    dx, dy = e[0] - s[0], e[1] - s[1]
    len2 = dx * dx + dy * dy
    if len2 < 1e-12:
        return _dist(p, s) < EPS
    t = ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / len2
    if t < -1e-4 or t > 1 + 1e-4:
        return False
    return _dist(p, (s[0] + t * dx, s[1] + t * dy)) < EPS


# ─── storing ────────────────────────────────────────────────────────────────


def save_path(plan, cable, route: dict, *, sync_trays: bool = True):
    """Store ``route`` as ``cable``'s path on ``plan`` (one row per cable
    per plan) and, with ``sync_trays``, make the cable's trays on this plan
    exactly the ones it rides. Call inside a transaction. Returns the row."""
    from .models import FloorPlanCablePath

    if sync_trays:
        set_plan_trays(plan, cable, route["tray_order"])
    fields = {
        "tenant_id": plan.tenant_id,
        "kind": route["kind"],
        "legs": route["legs"],
        "tray_order": route["tray_order"],
        "tile_ids": route["tile_ids"],
        "run_mm": route["run_mm"],
        "drop_a_mm": route["drop_a_mm"],
        "drop_b_mm": route["drop_b_mm"],
        "extra_mm": route["extra_mm"],
        "slack_mm": route["slack_mm"],
        "length_mm": route["length_mm"],
        "computed_at": timezone.now(),
        "stale": False,
    }
    row = FloorPlanCablePath.objects.filter(floor_plan=plan, cable=cable).first()
    if row is None:
        return FloorPlanCablePath.objects.create(floor_plan=plan, cable=cable, **fields)
    for k, v in fields.items():
        setattr(row, k, v)
    row.save()
    return row


def set_plan_trays(plan, cable, tray_ids) -> None:
    """Make ``cable``'s trays on ``plan`` exactly ``tray_ids`` (other plans'
    are kept), touching only what changes."""
    want = {str(t) for t in tray_ids}
    have = {str(t.pk): t for t in cable.trays.filter(floor_plan=plan)}
    gone = [t for k, t in have.items() if k not in want]
    if gone:
        cable.trays.remove(*gone)
    new = [k for k in want if k not in have]
    if new:
        cable.trays.add(*plan.trays.filter(pk__in=new))


def delete_path(plan, cable) -> bool:
    from .models import FloorPlanCablePath

    row = FloorPlanCablePath.objects.filter(floor_plan=plan, cable=cable).first()
    if row is None:
        return False
    row.delete()
    return True


def path_data(path, *, stale: bool | None = None, dx: float = 0.0, dy: float = 0.0) -> dict:
    """A stored path as the API answers it, moved by (dx, dy) for a view."""

    def mv(p):
        return [_r(p[0] + dx), _r(p[1] + dy)]

    legs = []
    for leg in path.legs or []:
        legs.append({
            **leg,
            "from": {**(leg.get("from") or {}), "at": mv((leg.get("from") or {}).get("at") or [0, 0])},
            "to": {**(leg.get("to") or {}), "at": mv((leg.get("to") or {}).get("at") or [0, 0])},
            "points": [mv(p) for p in leg.get("points") or []],
            "waypoints": [mv(p) for p in leg.get("waypoints") or []],
            "trays": [
                {**s, "entry": mv(s.get("entry") or [0, 0]), "exit": mv(s.get("exit") or [0, 0])}
                for s in leg.get("trays") or []
            ],
        })
    return {
        "id": str(path.pk),
        "kind": path.kind,
        "legs": legs,
        "tray_order": list(path.tray_order or []),
        "run_mm": path.run_mm,
        "drop_a_mm": path.drop_a_mm,
        "drop_b_mm": path.drop_b_mm,
        "extra_mm": path.extra_mm,
        "slack_mm": path.slack_mm,
        "length_mm": path.length_mm,
        "computed_at": path.computed_at.isoformat() if path.computed_at else None,
        "stale": path.stale if stale is None else stale,
        "version": path.updated_at.isoformat() if path.updated_at else None,
    }


def route_data(route: dict, *, dx: float = 0.0, dy: float = 0.0) -> dict:
    """A computed (unsaved) route in the same shape, moved by (dx, dy)."""

    class _P:
        pk = None
        kind = route["kind"]
        legs = route["legs"]
        tray_order = route["tray_order"]
        run_mm = route["run_mm"]
        drop_a_mm = route["drop_a_mm"]
        drop_b_mm = route["drop_b_mm"]
        extra_mm = route["extra_mm"]
        slack_mm = route["slack_mm"]
        length_mm = route["length_mm"]
        computed_at = None
        stale = False
        updated_at = None

    out = path_data(_P, dx=dx, dy=dy)
    del out["id"], out["version"], out["computed_at"]
    return out


# ─── keeping paths honest ───────────────────────────────────────────────────


def _mark_stale(q: Q) -> None:
    from .models import FloorPlanCablePath

    # A plain UPDATE: being out of date is derived state, not an edit -
    # nothing to log and no new version for the row.
    FloorPlanCablePath.objects.filter(q, stale=False).update(stale=True)


def _tile_saved(sender, instance, created, **kwargs):
    if created or kwargs.get("raw"):
        return
    from .models import FloorPlanCablePath

    tid = str(instance.pk)
    c = tile_centre(instance)
    moved = []
    for p in FloorPlanCablePath.objects.filter(
        floor_plan_id=instance.floor_plan_id, tile_ids__contains=[tid], stale=False
    ).only("id", "legs"):
        for leg in p.legs or []:
            for side in ("from", "to"):
                anchor = leg.get(side) or {}
                if anchor.get("tile") == tid and _dist(c, anchor.get("at") or [1e9, 1e9]) > EPS:
                    moved.append(p.pk)
    if moved:
        _mark_stale(Q(pk__in=moved))


def _tile_deleted(sender, instance, **kwargs):
    _mark_stale(Q(floor_plan_id=instance.floor_plan_id, tile_ids__contains=[str(instance.pk)]))


_TRAY_SHAPE = ("points", "level", "elevation_mm")


def _tray_before(sender, instance, **kwargs):
    if kwargs.get("raw") or instance._state.adding:
        instance._route_shape = None
        return
    instance._route_shape = sender.objects.filter(pk=instance.pk).values_list(
        *_TRAY_SHAPE
    ).first()


def _tray_saved(sender, instance, created, **kwargs):
    old = getattr(instance, "_route_shape", None)
    if created or old is None:
        return
    if tuple(getattr(instance, f) for f in _TRAY_SHAPE) != tuple(old):
        _mark_stale(Q(floor_plan_id=instance.floor_plan_id,
                      tray_order__contains=[str(instance.pk)]))


def _tray_deleted(sender, instance, **kwargs):
    _mark_stale(Q(floor_plan_id=instance.floor_plan_id,
                  tray_order__contains=[str(instance.pk)]))


def _tray_cables_changed(sender, instance, action, reverse, pk_set, **kwargs):
    """A cable taken out of a tray its path rides: the path is out of date."""
    from .models import FloorPlanTray

    if action == "pre_clear":
        if reverse:
            instance._cleared_trays = list(instance.trays.values_list("pk", "floor_plan_id"))
        else:
            instance._cleared_cables = list(instance.cables.values_list("pk", flat=True))
        return
    if action == "post_clear":
        if reverse:
            pairs = getattr(instance, "_cleared_trays", [])
            cables = [instance.pk]
        else:
            pairs = [(instance.pk, instance.floor_plan_id)]
            cables = getattr(instance, "_cleared_cables", [])
    elif action == "post_remove":
        if reverse:  # cable.trays.remove(...)
            pairs = list(FloorPlanTray.objects.filter(pk__in=pk_set)
                         .values_list("pk", "floor_plan_id"))
            cables = [instance.pk]
        else:
            pairs = [(instance.pk, instance.floor_plan_id)]
            cables = list(pk_set or [])
    else:
        return
    q = Q(pk__in=[])
    for tray_pk, plan_id in pairs:
        q |= Q(floor_plan_id=plan_id, tray_order__contains=[str(tray_pk)])
    if cables and pairs:
        _mark_stale(q & Q(cable_id__in=cables))


def connect_signals() -> None:
    from django.db.models.signals import m2m_changed, post_delete, post_save, pre_save

    from .models import FloorPlanTile, FloorPlanTray

    post_save.connect(_tile_saved, sender=FloorPlanTile, dispatch_uid="cable_routing.tile_saved")
    post_delete.connect(
        _tile_deleted, sender=FloorPlanTile, dispatch_uid="cable_routing.tile_deleted"
    )
    pre_save.connect(_tray_before, sender=FloorPlanTray, dispatch_uid="cable_routing.tray_before")
    post_save.connect(_tray_saved, sender=FloorPlanTray, dispatch_uid="cable_routing.tray_saved")
    post_delete.connect(
        _tray_deleted, sender=FloorPlanTray, dispatch_uid="cable_routing.tray_deleted"
    )
    m2m_changed.connect(
        _tray_cables_changed, sender=FloorPlanTray.cables.through,
        dispatch_uid="cable_routing.tray_cables",
    )
