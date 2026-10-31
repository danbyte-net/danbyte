"""Auto-routing a cable through a floor plan's tray network.

The Python twin of the frontend's ``cable-route.ts`` (which renders assigned
trays): same half-cell-lattice geometry, same junction rules (shared vertices,
T-splits, mid-segment crossings), same Dijkstra - but this side also reports
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

#: How far (cells) a vertex may sit from another tray and still join it -
#: mirrors cable-route.ts's default `snap`.
SNAP_CELLS = 0.75
#: Extra length allowance for service loops, dressing and termination waste.
SLACK_FACTOR = 0.10
#: Plenum depth under a raised floor when no area records one (mm). The
#: single source for the old hardcoded −300; world.ts mirrors it.
DEFAULT_PLENUM_MM = 300
#: Overhead trays hang this far below the ceiling when elevation is blank.
OVERHEAD_DROP_MM = 300
#: Rack-top math for vertical drops: U pitch + plinth height (mm) - the same
#: constants world.ts renders cabinets with (PANEL_MM.uPitch, RACK_BASE_M).
U_PITCH_MM = 44.45
RACK_PLINTH_MM = 100.0
#: How far (cells) an endpoint may sit from the tray network and still count
#: as routable. The 2D renderer projects unbounded (it draws already-assigned
#: trays); the router DECIDES routability, so a rack 30 cells from any tray
#: must come back unreachable, not "reachable via a 20 m unsupported hop".
MAX_ENTRY_CELLS = 6.0
#: Two trays whose runs cross mid-segment join there only when their resolved
#: elevations are this close (mm): an overhead ladder over an underfloor
#: basket is not a junction. A vertex snapped onto another tray (a drop)
#: always joins. cable-route.ts's LEVEL_JOIN_MM mirrors it.
LEVEL_JOIN_MM = 300.0

#: Node lookup that merges with a node of any level - the cable's own ends.
_ANY = object()


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
    elevations: list[float | None] | None = None,
) -> RouteResult:
    """Best A→B route through the tray network (Dijkstra over tray segments,
    junctions, and entry hops). ``reachable=False`` (with a straight A→B) when
    there are no usable trays, an endpoint sits farther than ``max_entry``
    cells from every tray, or the network doesn't connect the ends.

    ``elevations`` (mm, one per entry of ``tray_polys``; see
    :func:`tray_elevations`) keeps trays at different heights apart: a
    mid-run crossing joins two trays only within ``LEVEL_JOIN_MM`` of each
    other, and points of different heights never merge into one node. A
    vertex snapped onto another tray joins whatever the heights. ``None``
    for a tray (or no list) joins it at every crossing, as before."""
    keep = [i for i, t in enumerate(tray_polys) if len(t) >= 2]
    trays = [tray_polys[i] for i in keep]
    # A node's level: trays at one elevation share nodes, others never do.
    level = [elevations[i] if elevations is not None else 0 for i in keep]
    straight = RouteResult(
        reachable=False, points=[a, b], run_cells=_dist(a, b)
    )
    if not trays:
        return straight

    def joins(ti: int, tj: int) -> bool:
        li, lj = level[ti], level[tj]
        return li is None or lj is None or abs(li - lj) <= LEVEL_JOIN_MM

    # ── Node registry (spatial merge so coincident points of one level share
    # a node) ──
    nodes: list[Pt] = []
    node_level: list = []
    merge_dist = snap * 0.5

    def node_at(p: Pt, lv=_ANY) -> int:
        for i, n in enumerate(nodes):
            if (lv is _ANY or node_level[i] == lv) and _dist(n, p) <= merge_dist:
                return i
        nodes.append(p)
        node_level.append(lv)
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
                    edge(node_at(v, level[ti]), node_at(pt, level[tj]), d, None)

    # Mid-segment crossings → junctions where two trays at one level
    # intersect. A run passing over or under another is not a junction.
    for ti in range(len(trays)):
        for tj in range(ti + 1, len(trays)):
            if not joins(ti, tj):
                continue
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
                    if level[ti] != level[tj]:
                        # Close enough to join, but not one level: link them.
                        edge(node_at(p, level[ti]), node_at(p, level[tj]), 0.0, None)

    # Entry/exit: project A and B onto their nearest tray - but only within
    # max_entry, otherwise the endpoint simply isn't served by the network.
    def entry_point(p: Pt) -> tuple[Pt, int] | None:
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
        return best_pt, best_ti

    entry_a = entry_point(a)
    entry_b = entry_point(b)
    if entry_a is None or entry_b is None:
        return straight

    # Chain each tray's breakpoints in arc order (tray-tagged edges).
    for ti in range(len(trays)):
        bps = sorted(breakpoints[ti], key=lambda x: x[0])
        for i in range(len(bps) - 1):
            edge(
                node_at(bps[i][1], level[ti]),
                node_at(bps[i + 1][1], level[ti]),
                abs(bps[i + 1][0] - bps[i][0]),
                ti,
            )

    # Endpoint hops (straight-line ends outside the network).
    (pa, ta), (pb, tb) = entry_a, entry_b
    na, nb = node_at(a), node_at(b)
    edge(na, node_at(pa, level[ta]), _dist(a, pa), None)
    edge(nb, node_at(pb, level[tb]), _dist(b, pb), None)

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
    trays_used = [keep[t] for t in tray_order if not (t in seen or seen.add(t))]
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
    """A tray's resolved elevation - the Python twin of world.ts's
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


def tray_elevations(trays, ceiling_mm: int, area_rects) -> list[float]:
    """Each tray's resolved elevation (mm), for ``route_through_trays``'s
    ``elevations``: its own ``elevation_mm``, else derived from its level and
    the raised floor under it. ``trays`` carry ``level``, ``elevation_mm``
    and ``points``; ``area_rects`` are ``underfloor_plenum_mm``'s."""
    return [
        tray_elevation_mm(
            t.level, t.elevation_mm, ceiling_mm,
            underfloor_plenum_mm(area_rects, t.points),
        )
        for t in trays
    ]


def rack_drop_mm(
    rack_u_height: int | None,
    level: str,
    elevation_mm: int | None,
    ceiling_mm: int,
    plenum_mm: float = DEFAULT_PLENUM_MM,
) -> float:
    """Vertical run between a rack's top and a tray's elevation (mm) - the
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


# ─── Suggested runs (no tray path) ──────────────────────────────────────────
#
# When no tray connects a cable's ends, the plan can suggest a run: A* on
# the half-cell lattice, orthogonal moves only. Tiles other than the two
# ends are in the way, and so are walls except at their door openings; an
# underfloor run stays inside the raised-floor areas. A step along an
# existing tray (or a run suggested earlier in the batch) costs less, so a
# suggestion extends the network rather than running beside it, and a turn
# costs extra, so runs come out straight and tidy.

#: Lattice pitch (cells) - the half-cell lattice trays and walls snap to.
SUGGEST_STEP = 0.5
#: A step along an existing tray costs this fraction of a plain one.
SUGGEST_TRAY_FACTOR = 0.6
#: A change of direction costs this many cells.
SUGGEST_TURN_CELLS = 1.0
#: What the search reckons a step to the goal costs when there are trays
#: (between SUGGEST_TRAY_FACTOR and 1).
SUGGEST_ESTIMATE = 0.8
#: Lattice states A* may settle before it gives up (a plan too big to search).
SUGGEST_MAX_STATES = 250_000

_DIRS = ((1, 0), (-1, 0), (0, 1), (0, -1))
_E = 1e-6

Rect = tuple[float, float, float, float]
Node = tuple[int, int]


def _strictly_in(p: Pt, r: Rect) -> bool:
    x, y, w, h = r
    return x + _E < p[0] < x + w - _E and y + _E < p[1] < y + h - _E


def _closed_in(p: Pt, r: Rect) -> bool:
    x, y, w, h = r
    return x - _E <= p[0] <= x + w + _E and y - _E <= p[1] <= y + h + _E


def _along(p: Pt, s: Pt, e: Pt) -> float | None:
    """How far along [s, e] (cells from s) the point p lies; None when it
    is not on the segment."""
    _pt, t, d = _project_segment(p, s, e)
    if d > 1e-4:
        return None
    return t * _dist(s, e)


def compress_polyline(points: list[Pt]) -> list[Pt]:
    """Drop repeated points and the middle of straight runs."""
    out: list[Pt] = []
    for p in points:
        if out and _dist(out[-1], p) < _E:
            continue
        if len(out) >= 2:
            a, b = out[-2], out[-1]
            cross = (b[0] - a[0]) * (p[1] - b[1]) - (b[1] - a[1]) * (p[0] - b[0])
            dot = (b[0] - a[0]) * (p[0] - b[0]) + (b[1] - a[1]) * (p[1] - b[1])
            if abs(cross) < _E and dot >= 0:
                out[-1] = p
                continue
        out.append(p)
    return out


def lattice_steps(polylines) -> set[tuple[int, int, int, int]]:
    """The half-cell lattice steps the axis-aligned runs of ``polylines``
    cover, as ``(ix, iy, jx, jy)`` lattice coordinates, both ways."""
    out: set[tuple[int, int, int, int]] = set()
    for poly in polylines:
        for s, e in zip(poly, poly[1:], strict=False):
            sx, sy = round(s[0] / SUGGEST_STEP), round(s[1] / SUGGEST_STEP)
            ex, ey = round(e[0] / SUGGEST_STEP), round(e[1] / SUGGEST_STEP)
            if sx != ex and sy != ey:
                continue
            dx = (ex > sx) - (ex < sx)
            dy = (ey > sy) - (ey < sy)
            x, y = sx, sy
            while (x, y) != (ex, ey):
                out.add((x, y, x + dx, y + dy))
                out.add((x + dx, y + dy, x, y))
                x, y = x + dx, y + dy
    return out


def _on_lattice(v: float, step: float) -> bool:
    return abs(v / step - round(v / step)) < 1e-6


def _wall_nodes(
    walls, step: float
) -> tuple[set[Node], list[tuple[Pt, Pt, list[tuple[float, float]]]]]:
    """The lattice points on a wall outside its door openings, and the
    wall segments a step can cross between two lattice points - slanted
    ones, and straight ones off the lattice lines (a wall made from an
    area's outline) - each with its door spans."""
    on_wall: set[Node] = set()
    doors: set[Node] = set()
    slanted: list[tuple[Pt, Pt, list[tuple[float, float]]]] = []
    for points, openings in walls:
        pts = [(float(p[0]), float(p[1])) for p in points or []]
        for seg, (s, e) in enumerate(zip(pts, pts[1:], strict=False)):
            spans = [
                (float(o.get("from", 0)), float(o.get("to", 0)))
                for o in openings or []
                if isinstance(o, dict) and o.get("seg") == seg
            ]
            vertical = abs(s[0] - e[0]) <= _E
            horizontal = abs(s[1] - e[1]) <= _E
            if not (vertical or horizontal) or (
                vertical and not _on_lattice(s[0], step)
            ) or (horizontal and not _on_lattice(s[1], step)):
                slanted.append((s, e, spans))
            lo_x, hi_x = sorted((s[0], e[0]))
            lo_y, hi_y = sorted((s[1], e[1]))
            for ix in range(math.floor(lo_x / step), math.ceil(hi_x / step) + 1):
                for iy in range(math.floor(lo_y / step), math.ceil(hi_y / step) + 1):
                    at = _along((ix * step, iy * step), s, e)
                    if at is None:
                        continue
                    # Inside the door; a door narrower than a lattice step
                    # lets through at its jambs.
                    door = any(
                        (f + _E < at < t - _E)
                        or (t - f <= step + _E and f - _E <= at <= t + _E)
                        for f, t in spans
                    )
                    (doors if door else on_wall).add((ix, iy))
    return on_wall - doors, slanted


def suggest_run(
    a: Pt,
    b: Pt,
    *,
    width: float,
    height: float,
    obstacles=(),
    walls=(),
    trays=(),
    within=None,
    max_states: int = SUGGEST_MAX_STATES,
) -> list[Pt] | None:
    """A suggested run from ``a`` to ``b`` (cells) on the half-cell lattice
    of a ``width`` × ``height`` plan, or None when nothing gets through.

    ``obstacles`` are rectangles ``(x, y, w, h)`` a run may not cross (the
    tiles other than the two ends); it may run along an edge, but not
    between two that touch. ``walls`` are ``(points, openings)`` with the
    wall's door spans (``{"seg", "from", "to"}``, cells from the segment's
    start): a run crosses a wall only inside an opening. ``trays`` are
    polylines a run is cheaper along. ``within``, when given, are the
    rectangles every point must stay inside (an underfloor run: the raised
    floors). Answers the polyline from ``a`` to ``b``, its middle points on
    the lattice, straight runs as one segment."""
    step = SUGGEST_STEP
    cols = math.ceil(max(width, a[0], b[0]) / step) + 1
    rows = math.ceil(max(height, a[1], b[1]) / step) + 1

    def node_of(p: Pt) -> Node:
        return (
            min(max(round(p[0] / step), 0), cols - 1),
            min(max(round(p[1] / step), 0), rows - 1),
        )

    # Obstacles bucketed by the cells they cover.
    buckets: dict[Node, list[Rect]] = {}
    for r in obstacles:
        x, y, w, h = r
        for bx in range(math.floor(x), math.ceil(x + w) + 1):
            for by in range(math.floor(y), math.ceil(y + h) + 1):
                buckets.setdefault((bx, by), []).append(r)

    def occupied(p: Pt) -> bool:
        return any(
            _strictly_in(p, r)
            for r in buckets.get((math.floor(p[0]), math.floor(p[1])), ())
        )

    on_wall, slanted = _wall_nodes(walls, step)
    count = cols * rows
    # Per node: 0 not looked at yet, 1 free, 2 blocked.
    node_state = bytearray(count)

    def blocked(i: int) -> bool:
        v = node_state[i]
        if not v:
            ix, iy = i % cols, i // cols
            p = (ix * step, iy * step)
            hit = (
                (ix, iy) in on_wall
                or occupied(p)
                or (within is not None and not any(_closed_in(p, r) for r in within))
            )
            v = node_state[i] = 2 if hit else 1
        return v == 2

    def step_ok(i: int, j: int) -> bool:
        ux, uy, vx, vy = i % cols, i // cols, j % cols, j // cols
        mid = ((ux + vx) * step / 2, (uy + vy) * step / 2)
        if occupied(mid):
            return False
        if ux == vx:
            sides = ((mid[0] - step / 2, mid[1]), (mid[0] + step / 2, mid[1]))
        else:
            sides = ((mid[0], mid[1] - step / 2), (mid[0], mid[1] + step / 2))
        if occupied(sides[0]) and occupied(sides[1]):
            return False
        p, q = (ux * step, uy * step), (vx * step, vy * step)
        for s, e, spans in slanted:
            x = _segment_intersect(p, q, s, e)
            # A wall's end counts: a step does not slip past it there.
            if x is not None and _E < x[1] < 1 - _E:
                # Through a door: a step crosses there.
                at = x[2] * _dist(s, e)
                if not any(f - _E <= at <= t + _E for f, t in spans):
                    return False
        return True

    sx, sy = node_of(a)
    gx, gy = node_of(b)
    start, goal = sy * cols + sx, gy * cols + gx
    if blocked(start) or blocked(goal):
        return None
    # The cheaper steps, as (node, direction) - both ways.
    deltas = (1, -1, cols, -cols)
    cheap: set[int] = set()
    for ix, iy, jx, jy in lattice_steps(trays):
        if 0 <= ix < cols and 0 <= iy < rows and 0 <= jx < cols and 0 <= jy < rows:
            k = _DIRS.index((jx - ix, jy - iy))
            cheap.add((iy * cols + ix) * 4 + k)
    factor, turn = SUGGEST_TRAY_FACTOR, SUGGEST_TURN_CELLS
    plain, along = step, step * factor
    # Steps to the goal, priced between a plain step and one along a tray
    # when there are trays: low enough that the search finds a tray close
    # by, high enough that it does not comb the whole floor for one.
    least = step * SUGGEST_ESTIMATE if cheap else plain

    def est(i: int) -> float:
        return (abs(i % cols - gx) + abs(i // cols - gy)) * least

    # One state per node, with the direction its best way in arrived from
    # (-1: the start). A turn is priced against that direction - close to
    # exact, and a quarter of the states of tracking every direction.
    inf = math.inf
    best = [inf] * count
    came = [-1] * count
    prev = [-1] * count
    # Per (node, direction): 0 not looked at, 1 a step there is fine, 2 not.
    steps = bytearray(count * 4)
    best[start] = 0.0
    # Ties go to the state further along (-g), so the many equal-cost
    # staircases of an open floor are not all explored.
    heap = [(est(start), -0.0, start)]
    settled = 0
    found = False
    while heap:
        _f, neg_g, i = heapq.heappop(heap)
        g = -neg_g
        if g > best[i] + _E:
            continue
        if i == goal:
            found = True
            break
        settled += 1
        if settled > max_states:
            return None
        d = came[i]
        ix = i % cols
        for k in range(4):
            if k == 0 and ix == cols - 1 or k == 1 and ix == 0:
                continue
            j = i + deltas[k]
            if j < 0 or j >= count or blocked(j):
                continue
            sk = i * 4 + k
            ok = steps[sk]
            if not ok:
                ok = 1 if step_ok(i, j) else 2
                steps[sk] = ok
                steps[j * 4 + (k ^ 1)] = ok
            if ok == 2:
                continue
            ng = g + (along if sk in cheap else plain) + (turn if d >= 0 and d != k else 0)
            if ng < best[j] - _E:
                best[j] = ng
                came[j] = k
                prev[j] = i
                heapq.heappush(heap, (ng + est(j), -ng, j))
    if not found:
        return None
    nodes: list[Pt] = []
    i = goal
    while i >= 0:
        nodes.append(((i % cols) * step, (i // cols) * step))
        i = prev[i]
    nodes.reverse()
    return compress_polyline([(float(a[0]), float(a[1])), *nodes, (float(b[0]), float(b[1]))])
