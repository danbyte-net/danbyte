"""Auto-routing a cable through a floor plan's tray network.

The Python twin of the frontend's ``cable-route.ts`` (which renders assigned
trays): same half-cell-lattice geometry, same junction rules (shared vertices,
T-splits, mid-segment crossings), same Dijkstra — but this side also reports
*which trays* the winning path rides and estimates the physical cable length,
because the server persists the result (tray M2M + ``Cable.length``) and the
BOM/drawings consume it.

Pure geometry: no Django imports, everything in grid-cell units until the
final length conversion. Coordinates are ``(x, y)`` tuples in cell units.
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field

Pt = tuple[float, float]

#: How far (cells) a vertex may sit from another tray and still join it —
#: mirrors cable-route.ts's default `snap`.
SNAP_CELLS = 0.75
#: Extra length allowance for service loops, dressing and termination waste.
SLACK_FACTOR = 0.10
#: Plenum depth under a raised floor when no area records one (mm). The
#: single source for the old hardcoded −300; world.ts mirrors it.
DEFAULT_PLENUM_MM = 300
#: Overhead trays hang this far below the ceiling when elevation is blank.
OVERHEAD_DROP_MM = 300
#: Rack-top math for vertical drops: U pitch + plinth height (mm) — the same
#: constants world.ts renders cabinets with (PANEL_MM.uPitch, RACK_BASE_M).
U_PITCH_MM = 44.45
RACK_PLINTH_MM = 100.0
#: How far (cells) an endpoint may sit from the tray network and still count
#: as routable. The 2D renderer projects unbounded (it draws already-assigned
#: trays); the router DECIDES routability, so a rack 30 cells from any tray
#: must come back unreachable, not "reachable via a 20 m unsupported hop".
MAX_ENTRY_CELLS = 6.0


def _dist(a: Pt, b: Pt) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _project_segment(p: Pt, s: Pt, e: Pt) -> tuple[Pt, float, float]:
    """Nearest point on segment [s, e] to p → (point, t, distance)."""
    dx, dy = e[0] - s[0], e[1] - s[1]
    len2 = dx * dx + dy * dy or 1e-9
    t = ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / len2
    t = max(0.0, min(1.0, t))
    pt = (s[0] + t * dx, s[1] + t * dy)
    return pt, t, _dist(p, pt)


def _project_polyline(p: Pt, poly: list[Pt]) -> tuple[Pt, float, int, float]:
    """Nearest point on a polyline → (point, distance, segment index, t)."""
    best: tuple[Pt, float, int, float] = (poly[0], math.inf, 0, 0.0)
    for i in range(len(poly) - 1):
        pt, t, d = _project_segment(p, poly[i], poly[i + 1])
        if d < best[1]:
            best = (pt, d, i, t)
    return best


def _segment_intersect(a: Pt, b: Pt, c: Pt, d: Pt):
    """Intersection of segments [a,b] and [c,d] → (point, t, u) or None."""
    rx, ry = b[0] - a[0], b[1] - a[1]
    sx, sy = d[0] - c[0], d[1] - c[1]
    denom = rx * sy - ry * sx
    if abs(denom) < 1e-9:
        return None
    t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom
    u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denom
    if t < -1e-6 or t > 1 + 1e-6 or u < -1e-6 or u > 1 + 1e-6:
        return None
    return (a[0] + t * rx, a[1] + t * ry), t, u


@dataclass
class RouteResult:
    """A computed route. ``points`` in cell units; ``tray_indexes`` index into
    the trays list the caller passed (in path order, deduplicated)."""

    reachable: bool
    points: list[Pt] = field(default_factory=list)
    tray_indexes: list[int] = field(default_factory=list)
    #: Horizontal run along the path, in cells.
    run_cells: float = 0.0


def route_through_trays(
    a: Pt,
    b: Pt,
    tray_polys: list[list[Pt]],
    snap: float = SNAP_CELLS,
    max_entry: float = MAX_ENTRY_CELLS,
) -> RouteResult:
    """Best A→B route through the tray network (Dijkstra over tray segments,
    junctions, and entry hops). ``reachable=False`` (with a straight A→B) when
    there are no usable trays, an endpoint sits farther than ``max_entry``
    cells from every tray, or the network doesn't connect the ends."""
    trays = [t for t in tray_polys if len(t) >= 2]
    straight = RouteResult(
        reachable=False, points=[a, b], run_cells=_dist(a, b)
    )
    if not trays:
        return straight

    # ── Node registry (spatial merge so coincident points share a node) ──
    nodes: list[Pt] = []
    merge_dist = snap * 0.5

    def node_at(p: Pt) -> int:
        for i, n in enumerate(nodes):
            if _dist(n, p) <= merge_dist:
                return i
        nodes.append(p)
        return len(nodes) - 1

    # adjacency: u → {v: (weight, tray_index_or_None)}
    adj: dict[int, dict[int, tuple[float, int | None]]] = {}

    def edge(u: int, v: int, w: float, tray: int | None) -> None:
        if u == v:
            return
        for x, y in ((u, v), (v, u)):
            m = adj.setdefault(x, {})
            cur = m.get(y)
            if cur is None or w < cur[0]:
                m[y] = (w, tray)

    # Arc-length position of each vertex, per tray.
    arcs: list[list[float]] = []
    for poly in trays:
        arc = [0.0]
        for i in range(1, len(poly)):
            arc.append(arc[i - 1] + _dist(poly[i - 1], poly[i]))
        arcs.append(arc)

    def pos_on_tray(ti: int, seg: int, t: float) -> float:
        return arcs[ti][seg] + t * _dist(trays[ti][seg], trays[ti][seg + 1])

    # Breakpoints per tray: start with the vertices.
    breakpoints: list[list[tuple[float, Pt]]] = [
        [(arcs[ti][i], p) for i, p in enumerate(poly)]
        for ti, poly in enumerate(trays)
    ]

    # Cross-tray vertex projections → junctions and T-splits.
    for ti, poly in enumerate(trays):
        for v in poly:
            for tj, other in enumerate(trays):
                if tj == ti:
                    continue
                pt, d, seg, t = _project_polyline(v, other)
                if d <= snap:
                    breakpoints[tj].append((pos_on_tray(tj, seg, t), pt))
                    edge(node_at(v), node_at(pt), d, None)

    # Mid-segment crossings → junctions where two trays intersect.
    for ti in range(len(trays)):
        for tj in range(ti + 1, len(trays)):
            for si in range(len(trays[ti]) - 1):
                for sj in range(len(trays[tj]) - 1):
                    x = _segment_intersect(
                        trays[ti][si], trays[ti][si + 1],
                        trays[tj][sj], trays[tj][sj + 1],
                    )
                    if x is None:
                        continue
                    p, t, u = x
                    breakpoints[ti].append((pos_on_tray(ti, si, t), p))
                    breakpoints[tj].append((pos_on_tray(tj, sj, u), p))

    # Entry/exit: project A and B onto their nearest tray — but only within
    # max_entry, otherwise the endpoint simply isn't served by the network.
    def entry_point(p: Pt) -> Pt | None:
        best_d, best_pt, best_ti, best_seg, best_t = math.inf, p, 0, 0, 0.0
        for ti, poly in enumerate(trays):
            pt, d, seg, t = _project_polyline(p, poly)
            if d < best_d:
                best_d, best_pt, best_ti, best_seg, best_t = d, pt, ti, seg, t
        if best_d > max_entry:
            return None
        breakpoints[best_ti].append(
            (pos_on_tray(best_ti, best_seg, best_t), best_pt)
        )
        return best_pt

    entry_a = entry_point(a)
    entry_b = entry_point(b)
    if entry_a is None or entry_b is None:
        return straight

    # Chain each tray's breakpoints in arc order (tray-tagged edges).
    for ti in range(len(trays)):
        bps = sorted(breakpoints[ti], key=lambda x: x[0])
        for i in range(len(bps) - 1):
            edge(
                node_at(bps[i][1]),
                node_at(bps[i + 1][1]),
                abs(bps[i + 1][0] - bps[i][0]),
                ti,
            )

    # Endpoint hops (straight-line ends outside the network).
    na, nb = node_at(a), node_at(b)
    edge(na, node_at(entry_a), _dist(a, entry_a), None)
    edge(nb, node_at(entry_b), _dist(b, entry_b), None)

    # ── Dijkstra ──
    best = [math.inf] * len(nodes)
    prev: list[tuple[int, int | None]] = [(-1, None)] * len(nodes)
    best[na] = 0.0
    heap: list[tuple[float, int]] = [(0.0, na)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > best[u]:
            continue
        if u == nb:
            break
        for v, (w, tray) in adj.get(u, {}).items():
            nd = d + w
            if nd < best[v]:
                best[v] = nd
                prev[v] = (u, tray)
                heapq.heappush(heap, (nd, v))
    if best[nb] is math.inf or best[nb] == math.inf:
        return straight

    points: list[Pt] = []
    tray_order: list[int] = []
    u = nb
    while u != -1:
        points.append(nodes[u])
        p, tray = prev[u]
        if tray is not None and (not tray_order or tray_order[-1] != tray):
            tray_order.append(tray)
        u = p
    points.reverse()
    tray_order.reverse()
    # Deduplicate while keeping first-use order.
    seen: set[int] = set()
    trays_used = [t for t in tray_order if not (t in seen or seen.add(t))]
    return RouteResult(
        reachable=True,
        points=points,
        tray_indexes=trays_used,
        run_cells=best[nb],
    )


def estimate_length_m(
    run_cells: float,
    cell_mm: int,
    drop_a_mm: float,
    drop_b_mm: float,
    slack: float = SLACK_FACTOR,
) -> float:
    """Physical cable length: horizontal run + both vertical drops + slack."""
    run_mm = run_cells * cell_mm + drop_a_mm + drop_b_mm
    return round(run_mm * (1 + slack) / 1000, 1)


def tray_elevation_mm(
    level: str,
    elevation_mm: int | None,
    ceiling_mm: int,
    plenum_mm: float = DEFAULT_PLENUM_MM,
) -> float:
    """A tray's resolved elevation — the Python twin of world.ts's
    ``trayElevationM`` derivation (overhead → ceiling−300, underfloor →
    −plenum, floor → 0). ``plenum_mm`` comes from the raised-floor area the
    run sits in; callers with no area data get the historical 300."""
    if elevation_mm is not None:
        return float(elevation_mm)
    if level == "underfloor":
        return -float(plenum_mm)
    if level == "floor":
        return 0.0
    return float(ceiling_mm - OVERHEAD_DROP_MM)


def underfloor_plenum_mm(
    areas: list[tuple[float, float, float, float, int]],
    points: list,
) -> float:
    """The plenum depth under a tray run: the deepest raised-floor area any
    of its points sits in, else the default. ``areas`` are
    ``(x, y, width, height, plenum_mm)`` rects in cell units; the max wins
    when a run crosses areas because a cable dressed to the deeper void
    needs the longer drop."""
    best = 0.0
    for px, py in points or []:
        for ax, ay, aw, ah, plenum in areas:
            if ax <= px <= ax + aw and ay <= py <= ay + ah:
                if plenum > best:
                    best = float(plenum)
    return best or float(DEFAULT_PLENUM_MM)


def rack_drop_mm(
    rack_u_height: int | None,
    level: str,
    elevation_mm: int | None,
    ceiling_mm: int,
    plenum_mm: float = DEFAULT_PLENUM_MM,
) -> float:
    """Vertical run between a rack's top and a tray's elevation (mm) — the
    drop term in length estimation. Replaces two identical inline closures
    that each hardcoded the U pitch and plinth. ``abs()`` makes underfloor
    work unchanged: the run goes down instead of up."""
    top = (
        rack_u_height * U_PITCH_MM + RACK_PLINTH_MM
        if rack_u_height is not None
        else 0.0
    )
    elev = tray_elevation_mm(level, elevation_mm, ceiling_mm, plenum_mm)
    return abs(elev - top)
