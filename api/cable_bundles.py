"""Cable bundles on paper: the cable schedule's and the report's drawing mode.

A plan with hundreds of cables in a few trays prints as indistinguishable
lines on top of each other. In this mode the page posts the plan without
its cables and the server draws them here, from what it stores:

* every listed cable's **runs** in plan px - its stored route's legs
  (documented), else a route through its trays, else an elbow between its
  tiles (inferred) - from ``cable_schedule.build(routes=True)``;
* the runs cut into **pieces**: segments on one line (one tray stretch, a
  drop, a hop) are swept together, so each piece carries the set of cables
  riding all of it. A cable riding several trays counts on each; a
  breakout's legs share its trunk and count once;
* each piece drawn as **one stroke**, its width stepped by the number of
  cables (:data:`STEPS`), in the cable type's colour when the piece carries
  one type, else a neutral stroke; documented solid, inferred dashed, a
  piece carrying both drawn as two strokes side by side;
* a **count** on a shield where it fits: not on a piece too short on paper,
  not over a tile, a name or another count, and a set of cables already
  counted near by is not counted again. A mixed piece's shield gives the
  count per type in the types' colours;
* a cable with one end on the plan and no run: a short stub out of its
  tile, one per tile and side with its count.

A **trace** draws the others faint, then one cable over them, heavier, its
ends outlined and named (``A · device · port``).

Everything here is written here, never taken from the page, so it needs no
sanitising; the posted plan under it is sanitised as before.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from html import escape

from lxml import etree

from .svg_sanitize import SVG_NS

#: Width steps: at least this many cables → this stroke (paper mm).
STEPS = ((1, 0.3), (2, 0.55), (4, 0.85), (8, 1.2), (16, 1.6), (32, 2.1), (64, 2.6))
#: A mixed piece, and a piece of cables without a type.
NEUTRAL = "#52525b"
NO_TYPE = "#71717a"
#: The plan's type colours (frontend/src/components/topology/edge-style.ts
#: TYPE_PALETTE), handed out as the plan does: most common type first.
TYPE_PALETTE = (
    "#0ea5e9", "#8b5cf6", "#f59e0b", "#10b981", "#ec4899", "#14b8a6",
    "#f97316", "#6366f1", "#84cc16", "#e11d48", "#06b6d4", "#a855f7",
)
#: A count's type and shield (paper mm); a piece shorter than its shield
#: plus this carries none; one set of cables is counted again only this far
#: from its last count.
COUNT_FONT_MM = 1.9
LABEL_ROOM_MM = 3.0
REPEAT_MM = 60.0
#: Two segments are on one line within these (degrees, plan px).
ANGLE_TOL = 0.6
OFFSET_TOL = 1.0
EPS = 0.05
#: Strokes print at full width from this cell size on paper (mm), and
#: never under this share of it.
FULL_CELL_MM = 2.0
MIN_SCALE = 0.5
#: A stub (paper mm).
STUB_MM = 5.0
#: A trace: the cable's stroke and its ends' outline (paper mm).
TRACE_MM = 1.1
TRACE_END_MM = 0.6
FAINT = "#a1a1aa"
INK = "#18181b"


def _q(tag: str) -> str:
    return f"{{{SVG_NS}}}{tag}"


def _fmt(v: float) -> str:
    s = f"{v:.6g}"
    return "0" if s in ("-0", "") else s


def _el(parent, tag: str, text: str | None = None, **attrs):
    el = etree.SubElement(parent, _q(tag))
    for k, v in attrs.items():
        el.set(k.replace("_", "-"), _fmt(v) if isinstance(v, (int, float)) else str(v))
    if text is not None:
        el.text = text
    return el


# ─── Steps and colours ──────────────────────────────────────────────────────


def step_of(n: int) -> int:
    """The index of the width step ``n`` cables fall in."""
    i = 0
    for j, (least, _w) in enumerate(STEPS):
        if n >= least:
            i = j
    return i


def width_mm(n: int) -> float:
    return STEPS[step_of(n)][1]


def step_text(i: int) -> str:
    lo = STEPS[i][0]
    if i + 1 >= len(STEPS):
        return f"{lo}+"
    hi = STEPS[i + 1][0] - 1
    return str(lo) if hi == lo else f"{lo}–{hi}"


def palette(info: dict[str, dict]) -> dict[str, str]:
    """A colour per cable type in ``info`` (``{id: {type, type_label}}``),
    the most common first, ties by name - as the plan's Color by Type."""
    counts: dict[str, list] = {}
    for c in info.values():
        t = c.get("type") or ""
        if not t:
            continue
        counts.setdefault(t, [0, c.get("type_label") or t])[0] += 1
    order = sorted(counts, key=lambda t: (-counts[t][0], counts[t][1].lower()))
    return {t: TYPE_PALETTE[i % len(TYPE_PALETTE)] for i, t in enumerate(order)}


# ─── Runs into pieces ───────────────────────────────────────────────────────


@dataclass
class Run:
    cable: str
    points: list[tuple[float, float]]
    documented: bool


@dataclass
class Piece:
    """A stretch of one line and the cables riding all of it."""

    a: tuple[float, float]
    b: tuple[float, float]
    documented: frozenset = frozenset()
    inferred: frozenset = frozenset()

    @property
    def cables(self) -> frozenset:
        return self.documented | self.inferred

    @property
    def length(self) -> float:
        return math.hypot(self.b[0] - self.a[0], self.b[1] - self.a[1])


@dataclass
class _Line:
    angle: float
    d: tuple[float, float]
    n: tuple[float, float]
    offset: float
    spans: list = field(default_factory=list)


def runs_of(geometry: dict[str, dict]) -> list[Run]:
    """The runs of ``geometry`` (plan px, ``cable_schedule_plan.to_px``)."""
    out = []
    for cid, geo in geometry.items():
        for r in geo.get("runs", ()):
            pts = [tuple(p) for p in r["points"]]
            if len(pts) >= 2:
                out.append(Run(cid, pts, bool(r.get("documented"))))
    return out


def _direction(p, q):
    dx, dy = q[0] - p[0], q[1] - p[1]
    ln = math.hypot(dx, dy)
    if ln < EPS:
        return None
    dx, dy = dx / ln, dy / ln
    # One way per line: rightwards, or downwards when vertical.
    if dx < -1e-9 or (abs(dx) <= 1e-9 and dy < 0):
        dx, dy = -dx, -dy
    return dx, dy


def bundle(runs: list[Run], exclude: frozenset | set = frozenset()) -> list[Piece]:
    """``runs`` cut into pieces (see the module docstring). Cables in
    ``exclude`` are left out."""
    lines: dict[tuple[int, int], list[_Line]] = {}

    def line_for(p, d) -> _Line:
        angle = math.degrees(math.atan2(d[1], d[0]))
        n = (-d[1], d[0])
        offset = p[0] * n[0] + p[1] * n[1]
        ka, ko = round(angle / ANGLE_TOL), round(offset / OFFSET_TOL)
        for da in (-1, 0, 1):
            for do in (-1, 0, 1):
                for ln in lines.get((ka + da, ko + do), ()):
                    off = p[0] * ln.n[0] + p[1] * ln.n[1]
                    if abs(ln.angle - angle) <= ANGLE_TOL and abs(off - ln.offset) <= OFFSET_TOL:
                        return ln
        ln = _Line(angle, d, n, offset)
        lines.setdefault((ka, ko), []).append(ln)
        return ln

    for run in runs:
        if run.cable in exclude:
            continue
        for p, q in zip(run.points, run.points[1:], strict=False):
            d = _direction(p, q)
            if d is None:
                continue
            ln = line_for(p, d)
            t0 = p[0] * ln.d[0] + p[1] * ln.d[1]
            t1 = q[0] * ln.d[0] + q[1] * ln.d[1]
            ln.spans.append((min(t0, t1), max(t0, t1), run.cable, run.documented))
    pieces: list[Piece] = []
    seen_lines: set[int] = set()
    for group in lines.values():
        for ln in group:
            if id(ln) in seen_lines:
                continue
            seen_lines.add(id(ln))
            pieces.extend(_sweep(ln))
    return pieces


def _sweep(ln: _Line) -> list[Piece]:
    cuts = sorted({round(v, 3) for s in ln.spans for v in s[:2]})
    merged: list[float] = []
    for c in cuts:
        if not merged or c - merged[-1] > EPS:
            merged.append(c)
    out: list[Piece] = []
    last = None
    for u, v in zip(merged, merged[1:], strict=False):
        doc, inf = set(), set()
        for t0, t1, cid, documented in ln.spans:
            if t0 <= u + EPS and t1 >= v - EPS:
                (doc if documented else inf).add(cid)
        inf -= doc
        if not doc and not inf:
            last = None
            continue
        key = (frozenset(doc), frozenset(inf))
        if last is not None and last[0] == key and abs(last[1] - u) <= EPS:
            out[-1].b = _at(ln, v)
            last = (key, v)
            continue
        out.append(Piece(_at(ln, u), _at(ln, v), key[0], key[1]))
        last = (key, v)
    return out


def _at(ln: _Line, t: float) -> tuple[float, float]:
    return (ln.d[0] * t + ln.n[0] * ln.offset, ln.d[1] * t + ln.n[1] * ln.offset)


# ─── Drawing ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Rect:
    x0: float
    y0: float
    x1: float
    y1: float

    def hits(self, o: Rect) -> bool:
        return self.x0 < o.x1 and o.x0 < self.x1 and self.y0 < o.y1 and o.y0 < self.y1


def text_boxes(root) -> list[Rect]:
    """The boxes of the names in a posted drawing (``<text>`` with x, y and
    a font size, not under a rotation), so counts keep off them."""
    out = []
    if root is None:
        return out
    for t in root.iter(_q("text")):
        dx = dy = 0.0
        turned = False
        for anc in t.iterancestors():
            tr = anc.get("transform") or ""
            if not tr:
                continue
            if tr.startswith("translate(") and tr.endswith(")"):
                try:
                    vals = [float(v) for v in tr[10:-1].replace(",", " ").split()]
                except ValueError:
                    turned = True
                    break
                dx += vals[0]
                dy += vals[1] if len(vals) > 1 else 0.0
            else:
                turned = True
                break
        if turned:
            continue
        try:
            x = float(t.get("x", "")) + dx
            y = float(t.get("y", "")) + dy
            fs = float(t.get("font-size", ""))
        except ValueError:
            continue
        text = "".join(t.itertext())
        if not text or not all(math.isfinite(v) for v in (x, y, fs)):
            continue
        w = len(text) * fs * 0.6
        anchor = t.get("text-anchor") or "start"
        x0 = x - w / 2 if anchor == "middle" else (x - w if anchor == "end" else x)
        out.append(Rect(x0, y - fs, x0 + w, y + fs * 0.3))
    return out


@dataclass
class Drawn:
    """What one drawing holds, for its legend: the width steps, the cables
    (for their types), whether a piece was mixed, documented or inferred,
    and the stroke scale."""

    steps: set = field(default_factory=set)
    shown: set = field(default_factory=set)
    mixed: bool = False
    documented: bool = False
    inferred: bool = False
    scale: float = 1.0


def stroke_scale(mm_per_px: float) -> float:
    """Strokes on a small print of a plan narrow with it: full width from
    :data:`FULL_CELL_MM` a cell, down to :data:`MIN_SCALE`."""
    from .cable_schedule_plan import CELL

    return max(MIN_SCALE, min(1.0, CELL * mm_per_px / FULL_CELL_MM))


class Bundles:
    """The pieces of a drawing's cables and how they are drawn.

    ``geometry``: the listed cables' geometry in plan px (``to_px``);
    ``info``: ``{id: {type, type_label}}`` of every listed cable (for the
    colours, the schedule's palette); ``exclude``: cables left out."""

    def __init__(self, geometry: dict[str, dict], info: dict[str, dict],
                 exclude: frozenset | set = frozenset()):
        self.geometry = geometry
        self.info = info
        self.palette = palette(info)
        self.runs = runs_of(geometry)
        self.pieces = bundle(self.runs, exclude)
        self.exclude = frozenset(exclude)
        #: What the last :meth:`draw` drew, for its page's legend.
        self.drawn = Drawn()

    # ── colour ──

    def _type(self, cid: str) -> str:
        return (self.info.get(cid) or {}).get("type") or ""

    def colour(self, cables) -> str:
        types = {self._type(c) for c in cables}
        if len(types) == 1:
            t = next(iter(types))
            return self.palette.get(t, NO_TYPE)
        return NEUTRAL

    def _breakdown(self, cables) -> list[tuple[int, str]]:
        n: dict[str, int] = {}
        for c in cables:
            t = self._type(c)
            n[t] = n.get(t, 0) + 1
        order = sorted(n, key=lambda t: (-n[t], t))
        return [(n[t], self.palette.get(t, NO_TYPE)) for t in order]

    # ── the strokes ──

    def draw(self, parent, box, mm_per_px: float, *, taken: list[Rect] | None = None,
             faint: bool = False, labels: bool = True, stubs: bool = False,
             centre: tuple[float, float] | None = None) -> etree._Element:
        """Every piece on ``box`` (plan px) as a stroke sized in paper mm
        at ``mm_per_px``, the counts placed clear of ``taken`` (which gains
        them). ``faint``: grey, no counts (a trace's others). ``stubs``:
        the cables with one end here and no run, out of their tiles, away
        from ``centre``."""
        s = mm_per_px
        k = stroke_scale(s)
        drawn = self.drawn = Drawn(scale=k)
        g = _el(parent, "g", font_family="Inter, sans-serif")
        g.set("data-bundles", "1")
        casing = _el(g, "g", fill="none", stroke="#ffffff", stroke_linecap="round")
        strokes = _el(g, "g", fill="none", stroke_linecap="round")
        shown = [p for p in self.pieces if _crosses(p, box)]
        counted: list[tuple[frozenset, float, float]] = []
        taken = taken if taken is not None else []
        for p in shown:
            parts = []
            if p.documented:
                parts.append((p.documented, False))
            if p.inferred:
                parts.append((p.inferred, True))
            widths = [max(0.12, width_mm(len(c)) * k) for c, _i in parts]
            shift = (widths[0] + widths[1]) / 2 + 0.25 if len(parts) == 2 else 0.0
            nx, ny = _normal(p)
            for j, ((cables, inferred), w_mm) in enumerate(zip(parts, widths, strict=True)):
                off = shift / s if j == 1 else 0.0
                a = (p.a[0] + nx * off, p.a[1] + ny * off)
                b = (p.b[0] + nx * off, p.b[1] + ny * off)
                colour = FAINT if faint else self.colour(cables)
                d = f"M{_fmt(a[0])} {_fmt(a[1])}L{_fmt(b[0])} {_fmt(b[1])}"
                _el(casing, "path", d=d, stroke_width=(w_mm + 0.35) / s)
                path = _el(strokes, "path", d=d, stroke=colour, stroke_width=w_mm / s)
                if inferred:
                    path.set("stroke-dasharray", f"{_fmt(1.6 / s)} {_fmt(0.9 / s)}")
                    path.set("stroke-linecap", "butt")
                if faint:
                    path.set("opacity", "0.55")
                    continue
                drawn.steps.add(step_of(len(cables)))
                if len({self._type(c) for c in cables}) > 1:
                    drawn.mixed = True
                drawn.shown.update(cables)
                if inferred:
                    drawn.inferred = True
                else:
                    drawn.documented = True
            if labels and not faint and len(p.cables) >= 2:
                self._count(g, p, box, s, taken, counted)
        if stubs:
            self._stubs(g, box, s, centre, taken, faint, k)
        return g

    def _count(self, g, p: Piece, box, s: float, taken: list[Rect], counted) -> None:
        cables = p.cables
        parts = self._breakdown(cables)
        if len(parts) > 3 or len(parts) == 1:
            pieces = [(str(len(cables)), INK)]
        else:
            pieces = []
            for i, (n, colour) in enumerate(parts):
                if i:
                    pieces.append(("·", "#71717a"))
                pieces.append((str(n), colour))
        chars = sum(len(t) for t, _c in pieces)
        fs = COUNT_FONT_MM / s
        w = chars * fs * 0.62 + 1.0 / s
        h = fs * 1.35
        if p.length * s < w * s + LABEL_ROOM_MM:
            return
        for cab, cx, cy in counted:
            if cab == cables:
                mid = ((p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2)
                if math.hypot(mid[0] - cx, mid[1] - cy) * s < REPEAT_MM:
                    return
        for t in (0.5, 0.35, 0.65, 0.2, 0.8):
            cx = p.a[0] + (p.b[0] - p.a[0]) * t
            cy = p.a[1] + (p.b[1] - p.a[1]) * t
            r = Rect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
            inside = (r.x0 >= box.x and r.y0 >= box.y and r.x1 <= box.x + box.w
                      and r.y1 <= box.y + box.h)
            if not inside or any(r.hits(o) for o in taken):
                continue
            taken.append(r)
            counted.append((cables, cx, cy))
            _el(g, "rect", x=r.x0, y=r.y0, width=w, height=h, rx=0.5 / s,
                fill="#ffffff", stroke=self.colour(cables), stroke_width=0.2 / s)
            text = _el(g, "text", x=cx, y=cy + fs * 0.36, font_size=fs, font_weight=700,
                       text_anchor="middle", fill=INK)
            if len(pieces) == 1:
                text.text = pieces[0][0]
            else:
                for t_, colour in pieces:
                    _el(text, "tspan", t_, fill=colour)
            return

    def _stubs(self, g, box, s, centre, taken, faint, k: float = 1.0) -> None:
        """One stub per tile and side for the cables with one end here and
        no run: out of the tile's edge away from ``centre``, with an arrow
        and, for several, their count."""
        by_tile: dict[tuple, list[str]] = {}
        for cid, geo in self.geometry.items():
            if cid in self.exclude or geo.get("runs"):
                continue
            terms = geo.get("terms") or []
            sides = {t[0] for t in terms}
            if len(sides) != 1:
                continue
            for t in terms:
                key = tuple(round(v, 2) for v in t[1:5])
                lst = by_tile.setdefault(key, [])
                if cid not in lst:
                    lst.append(cid)
        cx, cy = centre or (box.x + box.w / 2, box.y + box.h / 2)
        for (x0, y0, x1, y1), cables in by_tile.items():
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            dx, dy = mx - cx, my - cy
            if abs(dx) >= abs(dy):
                ux, uy = (1.0 if dx >= 0 else -1.0), 0.0
                sx, sy = (x1 if ux > 0 else x0), my
            else:
                ux, uy = 0.0, (1.0 if dy >= 0 else -1.0)
                sx, sy = mx, (y1 if uy > 0 else y0)
            ln = STUB_MM / s
            ex, ey = sx + ux * ln, sy + uy * ln
            colour = FAINT if faint else self.colour(cables)
            w = width_mm(len(cables)) * k / s
            _el(g, "path", d=f"M{_fmt(sx)} {_fmt(sy)}L{_fmt(ex)} {_fmt(ey)}", fill="none",
                stroke=colour, stroke_width=w,
                stroke_dasharray=f"{_fmt(1.2 / s)} {_fmt(0.7 / s)}")
            a = 1.2 / s
            px, py = -uy, ux
            _el(g, "path", fill=colour,
                d=(f"M{_fmt(ex + ux * a)} {_fmt(ey + uy * a)}"
                   f"L{_fmt(ex + px * a * 0.6)} {_fmt(ey + py * a * 0.6)}"
                   f"L{_fmt(ex - px * a * 0.6)} {_fmt(ey - py * a * 0.6)}Z"))
            if not faint:
                self.drawn.steps.add(step_of(len(cables)))
                self.drawn.shown.update(cables)
                if len({self._type(c) for c in cables}) > 1:
                    self.drawn.mixed = True
            if len(cables) >= 2 and not faint:
                fs = COUNT_FONT_MM / s
                tx, ty = ex + ux * (a + fs * 0.4), ey + uy * (a + fs * 0.4)
                anchor = "start" if ux > 0 else ("end" if ux < 0 else "middle")
                if uy:
                    ty += fs * (0.9 if uy > 0 else -0.1)
                else:
                    ty += fs * 0.35
                _el(g, "text", str(len(cables)), x=tx, y=ty, font_size=fs, font_weight=700,
                    text_anchor=anchor, fill=INK, stroke="#ffffff", stroke_width=fs * 0.25,
                    paint_order="stroke")

    # ── a trace ──

    def draw_trace(self, parent, cid: str, box, mm_per_px: float,
                   avoid: list[Rect] | None = None) -> None:
        """One cable over the drawing: its runs heavier in its type's
        colour, its ends outlined and named with their side."""
        s = mm_per_px
        geo = self.geometry.get(cid) or {}
        colour = self.colour([cid])
        if colour == NO_TYPE:
            colour = INK
        g = _el(parent, "g", font_family="Inter, sans-serif", fill="none",
                stroke_linecap="round", stroke_linejoin="round")
        for r in geo.get("runs", ()):
            pts = r["points"]
            if len(pts) < 2:
                continue
            d = "M" + "L".join(f"{_fmt(x)} {_fmt(y)}" for x, y in pts)
            _el(g, "path", d=d, stroke="#ffffff", stroke_width=(TRACE_MM + 0.6) / s)
            path = _el(g, "path", d=d, stroke=colour, stroke_width=TRACE_MM / s)
            if not r.get("documented"):
                path.set("stroke-dasharray", f"{_fmt(2.2 / s)} {_fmt(1.2 / s)}")
        names = _el(parent, "g", font_family="Inter, sans-serif")
        taken: list[Rect] = list(avoid or [])
        terms = geo.get("terms") or []
        for _side, x0, y0, x1, y1, _name, _port in terms:
            _el(names, "rect", x=x0, y=y0, width=x1 - x0, height=y1 - y0, fill="none",
                stroke=INK, stroke_width=TRACE_END_MM / s)
            taken.append(Rect(x0, y0, x1, y1))
        fs = 2.4 / s
        gap = 1.0 / s
        done: set = set()
        for side, x0, y0, x1, y1, name, port in terms:
            key = (side, round(x0, 2), round(y0, 2))
            label = " · ".join(v for v in (side, name or "Hidden", port if name else "") if v)
            if key in done:
                continue
            done.add(key)
            tw, th = len(label) * fs * 0.6, fs * 1.3
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            for lx, ly in ((x1 + gap, my - th / 2), (x0 - gap - tw, my - th / 2),
                           (mx - tw / 2, y1 + gap), (mx - tw / 2, y0 - gap - th)):
                r = Rect(lx, ly, lx + tw, ly + th)
                inside = (r.x0 >= box.x and r.y0 >= box.y and r.x1 <= box.x + box.w
                          and r.y1 <= box.y + box.h)
                if not inside or any(r.hits(o) for o in taken):
                    continue
                taken.append(r)
                _el(names, "rect", x=lx - 0.6 / s, y=ly, width=tw + 1.2 / s, height=th,
                    rx=0.5 / s, fill="#ffffff", stroke=INK, stroke_width=0.25 / s)
                _el(names, "text", label, x=lx, y=ly + fs * 0.98, font_size=fs,
                    font_weight=600, fill=INK)
                break

    # ── the legend ──

    def type_counts(self, drawn: Drawn | None = None) -> dict[str, int]:
        """The cables drawn, per type."""
        out: dict[str, int] = {}
        for c in (drawn or self.drawn).shown:
            t = self._type(c)
            out[t] = out.get(t, 0) + 1
        return out

    def legend_html(self, drawn: Drawn | None = None) -> str:
        """The key to what :meth:`draw` drew (``drawn``, else the last
        drawing): the width steps at its scale, the types' colours (and the
        neutral mixed stroke), the line styles."""
        drawn = drawn or self.drawn
        if not drawn.steps and not drawn.shown:
            return ""
        items = []
        for i in sorted(drawn.steps):
            w = max(0.15, STEPS[i][1] * drawn.scale)
            items.append(
                f"<span class='li'><i class='ln' style='border-top:{w:.2f}mm solid {NEUTRAL}'>"
                f"</i>{escape(step_text(i))}</span>"
            )
        widths = "".join(items)
        labels = {}
        for c in self.info.values():
            if c.get("type"):
                labels[c["type"]] = c.get("type_label") or c["type"]
        types = self.type_counts(drawn)
        colours = []
        for t in sorted(types, key=lambda t: (t == "", -types[t], labels.get(t, ""))):
            name = labels.get(t, "No type") if t else "No type"
            colour = self.palette.get(t, NO_TYPE)
            colours.append(
                f"<span class='li'><i class='ln' style='border-top:0.9mm solid {colour}'></i>"
                f"{escape(name)} <b>{types[t]}</b></span>"
            )
        if drawn.mixed:
            colours.append(
                f"<span class='li'><i class='ln' style='border-top:0.9mm solid {NEUTRAL}'></i>"
                "Mixed - a count per type</span>"
            )
        styles = []
        if drawn.documented:
            styles.append(f"<span class='li'><i class='ln' style='border-top:0.6mm solid "
                          f"{NEUTRAL}'></i>Documented</span>")
        if drawn.inferred:
            styles.append(f"<span class='li'><i class='ln' style='border-top:0.6mm dashed "
                          f"{NEUTRAL}'></i>Inferred</span>")
        rows = [("Cables per stroke", widths), ("Type", "".join(colours)),
                ("Route", "".join(styles))]
        body = "".join(
            f"<div class='bl-row'><span class='lt'>{escape(k)}</span>{v}</div>"
            for k, v in rows if v
        )
        return f"<div class='bundle-legend'>{body}</div>"


BUNDLE_LEGEND_CSS = (
    ".bundle-legend{font-size:6.5pt;color:#52525b;line-height:1.6}"
    ".bundle-legend .bl-row{white-space:nowrap}"
    ".bundle-legend .lt{display:inline-block;min-width:26mm;font-weight:600;color:#18181b}"
    ".bundle-legend .li{display:inline-block;margin-right:3.5mm;white-space:nowrap}"
    ".bundle-legend .li i.ln{display:inline-block;width:6mm;height:0;margin-right:1mm;"
    "vertical-align:0.7mm}"
    ".bundle-legend .li b{font-weight:600;color:#18181b}"
)


def _normal(p: Piece) -> tuple[float, float]:
    dx, dy = p.b[0] - p.a[0], p.b[1] - p.a[1]
    ln = math.hypot(dx, dy) or 1.0
    return (-dy / ln, dx / ln)


def _crosses(p: Piece, box) -> bool:
    from .cable_schedule_plan import Box, _segment_hits

    return _segment_hits(p.a, p.b, Box(box.x, box.y, box.w, box.h))
