"""Closed shapes of a plan's CAD drawing, for the editor's Detect outline.

A click on the drawing picks the smallest closed shape round it - a closed
polyline, a circle, a hatch's boundary - with the drawing's own corners.

The shapes come from the drawing as processed: the sanitised SVG
``cad_engine`` wrote (``FloorPlanDrawing.rendered``), never the DXF, which
is only ever read by the engine in its own process on the worker. Each
``<path>`` of a layer's lines and hatches is split into its sub-paths; one
that ends where it starts (or with ``Z``) is a loop. Curves are flattened.
Text and dimensions are left out, and so are the layers the plan hides.

The loops of a render are worked out once and cached under the render's
file name, so a new render or a new upload never reuses old loops. Caps
keep a huge drawing from costing more than one bounded pass: at most
``MAX_LOOPS`` loops, ``MAX_LOOP_POINTS`` points each.
"""
from __future__ import annotations

import hashlib
import math
import re

from django.core.cache import cache

#: Loops kept per drawing; past this the rest are ignored.
MAX_LOOPS = 50_000
#: A flattened loop with more points than this is left out (a spline mess,
#: not a room).
MAX_LOOP_POINTS = 5_000
#: Points a curve segment is flattened into.
CURVE_STEPS = 8
#: How long a drawing's loops stay cached (they never go stale: the key
#: names the render).
CACHE_SECONDS = 24 * 3600
#: An area takes at most this many corners.
MAX_AREA_POINTS = 200

SVG_NS = "{http://www.w3.org/2000/svg}"
_TOKEN = re.compile(r"[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_ARITY = {"M": 1, "L": 1, "Q": 2, "C": 3}


def _flatten(cmd: str, start, ctrl: list) -> list:
    """The points of one segment from ``start``: its end for a line, a few
    along the curve for Q and C."""
    if cmd in ("M", "L"):
        return [ctrl[0]]
    out = []
    x0, y0 = start
    for k in range(1, CURVE_STEPS + 1):
        t = k / CURVE_STEPS
        u = 1 - t
        if cmd == "Q":
            (x1, y1), (x2, y2) = ctrl
            x = u * u * x0 + 2 * u * t * x1 + t * t * x2
            y = u * u * y0 + 2 * u * t * y1 + t * t * y2
        else:
            (x1, y1), (x2, y2), (x3, y3) = ctrl
            x = u**3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * x3
            y = u**3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * y3
        out.append((x, y))
    return out


def subpaths(d: str) -> list[tuple[list, bool]]:
    """``(points, closed with Z)`` for each sub-path of path data in the
    engine's absolute M/L/Q/C/Z. A path with anything else is skipped."""
    toks = _TOKEN.findall(d or "")
    out: list[tuple[list, bool]] = []
    cur: list = []
    i = 0
    cmd = None
    try:
        while i < len(toks):
            t = toks[i]
            if t.isalpha():
                cmd = t
                i += 1
                if cmd == "Z":
                    if cur:
                        out.append((cur, True))
                    cur = [cur[0]] if cur else []
                    continue
                if cmd not in _ARITY:
                    return []
            elif cmd is None or cmd == "Z":
                return []
            n = _ARITY[cmd]
            vals = [float(v) for v in toks[i : i + 2 * n]]
            if len(vals) < 2 * n:
                return []
            i += 2 * n
            pts = [(vals[2 * k], vals[2 * k + 1]) for k in range(n)]
            if cmd == "M":
                if len(cur) > 1:
                    out.append((cur, False))
                cur = [pts[0]]
                cmd = "L"  # numbers after an M's pair are line-tos
            elif cur:
                cur.extend(_flatten(cmd, cur[-1], pts))
    except (ValueError, IndexError):
        return []
    if len(cur) > 1:
        out.append((cur, False))
    return out


def _area(pts) -> float:
    s = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1], strict=True):
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def _loop(pts: list, closed: bool, tol: float):
    """The sub-path as a loop (its repeated last point dropped), or None
    when it does not close or encloses nothing."""
    if not closed:
        (x0, y0), (x1, y1) = pts[0], pts[-1]
        if abs(x0 - x1) > tol or abs(y0 - y1) > tol:
            return None
    ring = list(pts)
    while len(ring) > 1 and abs(ring[0][0] - ring[-1][0]) <= tol \
            and abs(ring[0][1] - ring[-1][1]) <= tol:
        ring.pop()
    if len(ring) < 3 or len(ring) > MAX_LOOP_POINTS:
        return None
    if not all(math.isfinite(v) for p in ring for v in p):
        return None
    area = _area(ring)
    if area <= tol * tol:
        return None
    return ring, area


def _cache_key(d) -> str:
    name = d.rendered.name or ""
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:24]
    return f"cad-loops:{d.pk}:{digest}"


def read_loops(d) -> list[tuple]:
    """Every loop of the drawing's render: ``(layer, min_x, min_y, max_x,
    max_y, area, points)`` in the SVG's viewBox units."""
    from lxml import etree

    ext = d.extents if isinstance(d.extents, dict) else {}
    try:
        diag = math.hypot(ext["max_x"] - ext["min_x"], ext["max_y"] - ext["min_y"])
    except (KeyError, TypeError):
        diag = 0.0
    # The engine writes about a millionth of the drawing's size.
    tol = max(diag, 1.0) * 2e-6
    loops: list[tuple] = []
    with d.rendered.open("rb") as fh:
        parser_args = {"events": ("end",), "tag": f"{SVG_NS}path",
                       "resolve_entities": False, "no_network": True,
                       "huge_tree": True, "load_dtd": False}
        for _event, el in etree.iterparse(fh, **parser_args):
            layer = None
            skip = False
            for anc in el.iterancestors():
                if anc.get("data-kind") in ("text", "dimension"):
                    skip = True
                    break
                if anc.get("data-layer") is not None:
                    layer = anc.get("data-layer")
                    break
            if not skip and layer is not None:
                for pts, closed in subpaths(el.get("d") or ""):
                    found = _loop(pts, closed, tol)
                    if found is None:
                        continue
                    ring, area = found
                    xs = [p[0] for p in ring]
                    ys = [p[1] for p in ring]
                    loops.append((layer, min(xs), min(ys), max(xs), max(ys), area, ring))
                    if len(loops) >= MAX_LOOPS:
                        return loops
            el.clear(keep_tail=False)
    return loops


def loops_of(d) -> list[tuple]:
    """The drawing's loops, from the cache when its render has been read."""
    key = _cache_key(d)
    try:
        hit = cache.get(key)
    except Exception:  # noqa: BLE001 - a cache outage only costs a re-read
        hit = None
    if hit is not None:
        return hit
    loops = read_loops(d)
    try:
        cache.set(key, loops, CACHE_SECONDS)
    except Exception:  # noqa: BLE001
        pass
    return loops


def _inside(x: float, y: float, ring) -> bool:
    hit = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def _seg_dist(p, a, b) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    n = dx * dx + dy * dy
    if not n:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def _rdp(pts: list, eps: float) -> list:
    if len(pts) < 3:
        return list(pts)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    todo = [(0, len(pts) - 1)]
    while todo:
        a, b = todo.pop()
        best, far = -1, eps
        for i in range(a + 1, b):
            dd = _seg_dist(pts[i], pts[a], pts[b])
            if dd > far:
                best, far = i, dd
        if best >= 0:
            keep[best] = True
            todo += [(a, best), (best, b)]
    return [p for p, k in zip(pts, keep, strict=True) if k]


def fit_points(ring: list, limit: int = MAX_AREA_POINTS) -> list:
    """At most ``limit`` corners: a ring with more (a flattened circle) is
    simplified with a growing tolerance."""
    if len(ring) <= limit:
        return list(ring)
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    eps = max(max(xs) - min(xs), max(ys) - min(ys)) * 1e-4
    out = list(ring)
    for _ in range(40):
        closed = _rdp(ring + [ring[0]], eps)[:-1]
        out = closed
        if 3 <= len(out) <= limit:
            return out
        eps *= 1.5
    return out[:limit]


def placement_matrix(d) -> tuple[float, float, float, float, float, float]:
    """viewBox units → plan mm, as ``cad_render.transform_mm`` places the
    drawing: ``(a, b, c, d, e, f)`` with x' = a·x + c·y + e, y' = b·x + d·y + f."""
    from . import cad_render

    w, h = cad_render.size_units(d)
    box = cad_render.placed_box_mm(d)
    s = d.mm_per_unit
    rot = int((d.placement or {}).get("rotation", 0) or 0)
    cos = round(math.cos(math.radians(rot)))
    sin = round(math.sin(math.radians(rot)))
    cx = box["x"] + box["width"] / 2
    cy = box["y"] + box["height"] / 2
    ox, oy = -w / 2, -h / 2
    return (cos * s, sin * s, -sin * s, cos * s,
            cx + s * (cos * ox - sin * oy), cy + s * (sin * ox + cos * oy))


def pick(d, cell_mm: int, x: float, y: float) -> dict | None:
    """The smallest loop of the drawing's shown layers round the plan point
    ``(x, y)`` (in cells): ``{"points": [[x, y], ...] in cells, "layer"}``,
    or None when no closed shape holds the point."""
    a, b, c, dd, e, f = placement_matrix(d)
    det = a * dd - b * c
    if not det:
        return None
    # The click in mm, then in viewBox units.
    mx, my = x * cell_mm - e, y * cell_mm - f
    px = (dd * mx - c * my) / det
    py = (-b * mx + a * my) / det
    hidden = set((d.placement or {}).get("hidden_layers") or [])
    best = None
    for layer, x0, y0, x1, y1, area, ring in loops_of(d):
        if layer in hidden or not (x0 <= px <= x1 and y0 <= py <= y1):
            continue
        if best is not None and area >= best[1]:
            continue
        if _inside(px, py, ring):
            best = (layer, area, ring)
    if best is None:
        return None
    layer, _area_units, ring = best
    pts = []
    for vx, vy in fit_points(ring):
        pts.append([round((a * vx + c * vy + e) / cell_mm, 4),
                    round((b * vx + dd * vy + f) / cell_mm, 4)])
    return {"points": pts, "layer": layer}
