"""Raised-floor outlines in cell units - Django-free.

A raised floor is either a whole-cell rectangle (``x``, ``y``, ``width``,
``height``) or, when ``points`` holds three or more ``[x, y]`` pairs, that
polygon (a rotated hall, an L-shaped pad). Everything that asks "is this
point on a raised floor, and how deep is its plenum" goes through
:func:`outline_of` and :func:`contains`, so rectangles and polygons answer
alike. Points on an outline count as inside: trays snap to grid lines, and a
run along the pad's edge is on the pad.
"""

from __future__ import annotations

import math

Pt = tuple[float, float]

#: Distance (cells) within which a point counts as on an edge.
EPS = 1e-6


def rect_outline(x: float, y: float, w: float, h: float) -> list[Pt]:
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


def outline_of(area) -> list[Pt]:
    """The outline of a raised floor (a model row or a mapping): its polygon
    when it has one, else its rectangle's corners."""
    get = area.get if isinstance(area, dict) else lambda k, d=None: getattr(area, k, d)
    pts = get("points") or []
    if len(pts) >= 3:
        return [(float(p[0]), float(p[1])) for p in pts]
    return rect_outline(get("x") or 0, get("y") or 0, get("width") or 1, get("height") or 1)


def _on_segment(p: Pt, a: Pt, b: Pt, eps: float = EPS) -> bool:
    dx, dy = b[0] - a[0], b[1] - a[1]
    len2 = dx * dx + dy * dy
    if len2 < 1e-18:
        return math.hypot(p[0] - a[0], p[1] - a[1]) <= eps
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) <= eps


def strictly_inside(p: Pt, poly) -> bool:
    """Even-odd ray cast; a point on the outline may answer either way."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > p[1]) != (yj > p[1]):
            x = (xj - xi) * (p[1] - yi) / (yj - yi) + xi
            if p[0] < x:
                inside = not inside
        j = i
    return inside


def on_outline(p: Pt, poly, eps: float = EPS) -> bool:
    n = len(poly)
    return any(_on_segment(p, poly[i], poly[(i + 1) % n], eps) for i in range(n))


def contains(poly, p, eps: float = EPS) -> bool:
    """Whether ``p`` lies inside the polygon or on its outline."""
    p = (float(p[0]), float(p[1]))
    return on_outline(p, poly, eps) or strictly_inside(p, poly)


def area_of(poly) -> float:
    """Signed shoelace area (cells²)."""
    n = len(poly)
    return sum(
        poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]
        for i in range(n)
    ) / 2


def _orient(p: Pt, q: Pt, r: Pt) -> int:
    v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return 0 if abs(v) < 1e-12 else (1 if v > 0 else -1)


def _properly_cross(a: Pt, b: Pt, c: Pt, d: Pt) -> bool:
    """Segments ab and cd cross at a point interior to both (touching and
    collinear overlap do not count)."""
    o1, o2, o3, o4 = _orient(a, b, c), _orient(a, b, d), _orient(c, d, a), _orient(c, d, b)
    return o1 * o2 < 0 and o3 * o4 < 0


def _probes(poly):
    """Points just inside ``poly`` beside each edge's midpoint (whichever
    side is inside), so a polygon lying on or within another is caught."""
    n = len(poly)
    out = []
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        if length < 1e-9:
            continue
        mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        nx, ny = -(b[1] - a[1]) / length * 1e-4, (b[0] - a[0]) / length * 1e-4
        for q in ((mx + nx, my + ny), (mx - nx, my - ny)):
            if strictly_inside(q, poly):
                out.append(q)
                break
    return out


def overlaps(a, b) -> bool:
    """Whether two polygons share interior (sharing an edge or a corner is
    fine - adjacent pads)."""
    ax = [p[0] for p in a]
    ay = [p[1] for p in a]
    bx = [p[0] for p in b]
    by = [p[1] for p in b]
    if max(ax) <= min(bx) + EPS or max(bx) <= min(ax) + EPS \
            or max(ay) <= min(by) + EPS or max(by) <= min(ay) + EPS:
        return False
    na, nb = len(a), len(b)
    for i in range(na):
        for j in range(nb):
            if _properly_cross(a[i], a[(i + 1) % na], b[j], b[(j + 1) % nb]):
                return True
    for p in a:
        if strictly_inside(p, b) and not on_outline(p, b):
            return True
    for p in b:
        if strictly_inside(p, a) and not on_outline(p, a):
            return True
    return any(strictly_inside(q, b) for q in _probes(a)) or any(
        strictly_inside(q, a) for q in _probes(b)
    )


def cell_box(poly) -> tuple[int, int, int, int]:
    """The whole cells a polygon covers: ``(x, y, width, height)``."""
    x0 = math.floor(min(p[0] for p in poly) + 1e-9)
    y0 = math.floor(min(p[1] for p in poly) + 1e-9)
    x1 = math.ceil(max(p[0] for p in poly) - 1e-9)
    y1 = math.ceil(max(p[1] for p in poly) - 1e-9)
    return x0, y0, max(1, x1 - x0), max(1, y1 - y0)
