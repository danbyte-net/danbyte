"""The cable schedule PDF's plan pages: the overview and the close-ups.

The page posts the plan as ``plan-svg.ts`` draws it framed to its content
(``planSvg(... fitContent)``): ``svg`` scaled for the overview and, for each
close-up, the plan drawn for that page's box and scale
(``closeup_svgs``, keyed by label), so hatches and cables are sized for the
paper they print on. The page asks for the close-ups first
(``GET .../cable-schedule/closeups/``, :func:`closeup_layout`); the PDF
works them out again and keeps a posted drawing only for a page whose box
it matches. All are sanitised; what is added here is written here:

* the plan's background image, cut with Pillow to the part each page shows
  (a live view's crop of its source's image), at most :data:`BG_DPI` on
  paper and under the sanitiser's image caps;
* its CAD drawing, as the floor-plan PDF lays it (``floor_plan_pdf.cad_group``,
  the view's part for a live view), clipped to the grid;
* on a close-up, each cable end's tile outlined with its device names, in
  paper millimetres;
* on the overview, a labelled frame for each close-up (A, B, …).

Close-ups are clusters of connected equipment, not tiles of the plan: the
end tiles of the listed cables are clustered, each cluster is framed and
scaled to the page between a readable floor and the raster background's
ceiling, and clusters whose frames would overlap are merged. A cable's
route between clusters shows on the overview. See :func:`closeup_layout`.
"""

from __future__ import annotations

import base64
import copy
import io
import logging
import math
from dataclasses import dataclass, field

from lxml import etree

from .drawing_pdf import MARGIN_MM, PAPERS_MM
from .svg_sanitize import MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, SVG_NS

log = logging.getLogger(__name__)

#: Plan pixels per grid cell - frontend/src/components/floorplan/floor-canvas.tsx.
CELL = 40
#: A close-up prints a cell at least this large (mm), unless its cluster
#: needs less to fit the page, and at most this large.
CLOSEUP_MIN_CELL_MM = 3.0
CLOSEUP_MAX_CELL_MM = 12.0
#: A raster background is not magnified past this many times its native
#: size, a pixel :data:`RASTER_PX_MM` (96 per inch, as on screen at 100%).
RASTER_MAX_ZOOM = 1.5
RASTER_PX_MM = 25.4 / 96
#: Ends closer than this share of the page's shorter side (at the readable
#: floor) are one cluster.
CLUSTER_SHARE = 0.5
#: Round a cluster's ends: this many cells, plus this much paper for names.
FRAME_MARGIN_CELLS = 1.5
FRAME_MARGIN_MM = 12.0
#: ``auto``: close-ups when a cell prints smaller than this on the overview
#: or there are several clusters - each printing at least this many times
#: the overview's scale.
AUTO_BELOW_CELL_MM = 2.0
AUTO_MIN_GAIN = 1.5
MAX_CLOSEUPS = 20
#: An end tile's name on a close-up: type size and outline (paper mm).
END_FONT_MM = 2.3
END_LINE_MM = 0.35
#: A background image is printed at no more than this resolution.
BG_DPI = 200
#: The schedule's bottom page margin (the running footer) - cable_schedule.
BOTTOM_MM = 14.0
#: The overview takes this share of the page's height; a close-up this.
THUMB_SHARE = 0.55
CLOSEUP_SHARE = 0.6
#: The frame round a plan picture: padding + border (mm, each side).
THUMB_PAD_MM = 2.0
CLOSEUP_PAD_MM = 1.0
BORDER_MM = 0.25


@dataclass(frozen=True)
class Box:
    """A rectangle in plan pixels."""

    x: float
    y: float
    w: float
    h: float

    @property
    def x2(self) -> float:
        return self.x + self.w

    @property
    def y2(self) -> float:
        return self.y + self.h

    def view_box(self) -> str:
        return " ".join(_fmt(v) for v in (self.x, self.y, self.w, self.h))


def _fmt(v: float) -> str:
    s = f"{v:.6g}"
    return "0" if s in ("-0", "") else s


def _q(tag: str) -> str:
    return f"{{{SVG_NS}}}{tag}"


def view_box(root: etree._Element) -> Box | None:
    vb = (root.get("viewBox") or "").replace(",", " ").split()
    if len(vb) != 4:
        return None
    try:
        x, y, w, h = (float(v) for v in vb)
    except ValueError:
        return None
    if not all(math.isfinite(v) for v in (x, y, w, h)) or w <= 0 or h <= 0:
        return None
    return Box(x, y, w, h)


# ─── Paper ──────────────────────────────────────────────────────────────────


def _page(paper: str, orientation: str) -> tuple[float, float]:
    pw, ph = PAPERS_MM[paper]
    return (ph, pw) if orientation == "portrait" else (pw, ph)


def thumb_mm(paper: str, orientation: str) -> tuple[float, float]:
    """The overview frame's outer height and its picture's inner size (mm)."""
    pw, ph = _page(paper, orientation)
    inset = 2 * (THUMB_PAD_MM + BORDER_MM)
    return (pw - 2 * MARGIN_MM - inset, (ph - 2 * MARGIN_MM) * THUMB_SHARE - inset)


def closeup_mm(paper: str, orientation: str) -> tuple[float, float, float]:
    """A close-up's frame height and its picture's inner width and height (mm)."""
    pw, ph = _page(paper, orientation)
    outer = (ph - MARGIN_MM - BOTTOM_MM) * CLOSEUP_SHARE
    inset = 2 * (CLOSEUP_PAD_MM + BORDER_MM)
    return outer, pw - 2 * MARGIN_MM - inset, outer - inset


def fit_scale(box: Box, w_mm: float, h_mm: float) -> float:
    """Paper mm per plan px for ``box`` contained in ``w_mm`` × ``h_mm``."""
    return min(w_mm / box.w, h_mm / box.h)


# ─── Close-ups: clusters of connected equipment ─────────────────────────────


def row_letters(i: int) -> str:
    """A, B, …, Z, AA, AB, …"""
    out = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        out = chr(65 + r) + out
    return out


def _segment_hits(p, q, b: Box) -> bool:
    """Liang-Barsky: does the segment p-q cross the box?"""
    (x0, y0), (x1, y1) = p, q
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for pv, qv in ((-dx, x0 - b.x), (dx, b.x2 - x0), (-dy, y0 - b.y), (dy, b.y2 - y0)):
        if pv == 0:
            if qv < 0:
                return False
            continue
        t = qv / pv
        if pv < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return False
    return True


def crosses(geo: dict, b: Box) -> bool:
    """Whether a cable's geometry (plan px: ``lines`` of points and
    ``boxes`` of x0, y0, x1, y1) shows on ``b``."""
    for x0, y0, x1, y1 in geo.get("boxes", ()):
        if x0 < b.x2 and x1 > b.x and y0 < b.y2 and y1 > b.y:
            return True
    for line in geo.get("lines", ()):
        if len(line) == 1 and _segment_hits(line[0], line[0], b):
            return True
        for p, q in zip(line, line[1:], strict=False):
            if _segment_hits(p, q, b):
                return True
    return False


def overlaps(a: Box, b: Box) -> bool:
    eps = 1e-6
    return a.x < b.x2 - eps and b.x < a.x2 - eps and a.y < b.y2 - eps and b.y < a.y2 - eps


def intersect(a: Box, b: Box) -> Box | None:
    x0, y0 = max(a.x, b.x), max(a.y, b.y)
    x1, y1 = min(a.x2, b.x2), min(a.y2, b.y2)
    if x1 <= x0 or y1 <= y0:
        return None
    return Box(x0, y0, x1 - x0, y1 - y0)


@dataclass
class End:
    """An end tile of the listed cables (plan px), with the cables ending
    on it and the names of the devices they end on."""

    box: tuple[float, float, float, float]
    cables: list[str] = field(default_factory=list)
    names: list[str] = field(default_factory=list)


def cable_ends(geometry: dict[str, dict]) -> list[End]:
    """The end tiles of the cables in ``geometry`` (plan px, :func:`to_px`),
    one per tile, in first-seen order."""
    by_box: dict[tuple, End] = {}
    for cid, geo in geometry.items():
        for x0, y0, x1, y1, name in geo.get("ends", ()):
            key = (round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3))
            end = by_box.setdefault(key, End((x0, y0, x1, y1)))
            if cid not in end.cables:
                end.cables.append(cid)
            if name and name not in end.names:
                end.names.append(name)
    return list(by_box.values())


def _gap(a, b) -> float:
    """The distance between two boxes (x0, y0, x1, y1); 0 when they touch."""
    dx = max(0.0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(dx, dy)


def cluster(ends: list[End], threshold: float) -> list[list[int]]:
    """Single-link clusters of ``ends``: two ends closer than ``threshold``
    (plan px, box to box) are in one cluster. A grid hash keeps it near
    linear. Each cluster lists indices into ``ends``, ascending."""
    parent = list(range(len(ends)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    size = max(threshold, 1.0)
    grid: dict[tuple[int, int], list[int]] = {}
    for i, e in enumerate(ends):
        x0, y0, x1, y1 = e.box
        for gx in range(math.floor(x0 / size), math.floor(x1 / size) + 1):
            for gy in range(math.floor(y0 / size), math.floor(y1 / size) + 1):
                grid.setdefault((gx, gy), []).append(i)
    for (gx, gy), members in grid.items():
        near = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                for j in grid.get((gx + dx, gy + dy), ())]
        for i in members:
            for j in near:
                if j > i and find(i) != find(j) and _gap(ends[i].box, ends[j].box) < threshold:
                    parent[find(j)] = find(i)
    groups: dict[int, list[int]] = {}
    for i in range(len(ends)):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def raster_max_cell_mm(px_per_cell: float | None) -> float | None:
    """The largest cell (mm) at which a raster background with
    ``px_per_cell`` image pixels per cell is magnified no more than
    :data:`RASTER_MAX_ZOOM` × its native size (a pixel :data:`RASTER_PX_MM`)."""
    if not px_per_cell or px_per_cell <= 0:
        return None
    return px_per_cell * RASTER_PX_MM * RASTER_MAX_ZOOM


def scale_limits(px_per_cell: float | None) -> tuple[float, float]:
    """Paper mm per plan px a close-up may print at: the readable floor
    (:data:`CLOSEUP_MIN_CELL_MM` a cell) and the ceiling, the raster's
    (never under the floor) or :data:`CLOSEUP_MAX_CELL_MM`."""
    lo = CLOSEUP_MIN_CELL_MM
    hi = CLOSEUP_MAX_CELL_MM
    raster = raster_max_cell_mm(px_per_cell)
    if raster is not None:
        hi = min(hi, max(lo, raster))
    return lo / CELL, hi / CELL


@dataclass
class Page:
    """A close-up: its label, the plan box it shows (plan px), the scale it
    prints at (paper mm per plan px), the cables drawn on it and the end
    tiles it holds."""

    label: str
    box: Box
    mm_per_px: float = 1.0
    cables: list[str] = field(default_factory=list)
    ends: list[End] = field(default_factory=list)

    @property
    def size_mm(self) -> tuple[float, float]:
        return self.box.w * self.mm_per_px, self.box.h * self.mm_per_px


def _frame(ends: list[End], bounds: Box, w_mm: float, h_mm: float,
           hi: float) -> tuple[Box, float]:
    """The frame and scale of a cluster: its ends' box with a margin
    (:data:`FRAME_MARGIN_CELLS` plus :data:`FRAME_MARGIN_MM` of paper for
    the names), fitted to the page at no more than ``hi`` (a cluster too
    large for the readable floor prints smaller, to fit); the frame is
    the page's shape round its centre, moved inside ``bounds`` and cut to
    them where it is larger."""
    x0 = min(e.box[0] for e in ends)
    y0 = min(e.box[1] for e in ends)
    x1 = max(e.box[2] for e in ends)
    y1 = max(e.box[3] for e in ends)
    pad = FRAME_MARGIN_CELLS * CELL
    m = FRAME_MARGIN_MM
    fit = min((w_mm - 2 * m) / max(x1 - x0 + 2 * pad, 1e-9),
              (h_mm - 2 * m) / max(y1 - y0 + 2 * pad, 1e-9))
    s = max(min(fit, hi), 1e-9)
    fw, fh = w_mm / s, h_mm / s
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    def place(c: float, size: float, lo_b: float, hi_b: float) -> tuple[float, float]:
        if size >= hi_b - lo_b:
            return lo_b, hi_b - lo_b
        start = min(max(c - size / 2, lo_b), hi_b - size)
        return start, size

    fx, fw = place(cx, fw, bounds.x, bounds.x2)
    fy, fh = place(cy, fh, bounds.y, bounds.y2)
    return Box(fx, fy, fw, fh), s


def closeup_layout(geometry: dict[str, dict], *, content: Box, grid: Box,
                   page_mm: tuple[float, float], overview_mm_per_px: float, mode: str,
                   px_per_cell: float | None = None,
                   cap: int = MAX_CLOSEUPS) -> tuple[list[Page], int]:
    """The close-up pages of a schedule: the listed cables' end tiles
    clustered (single link, closer than :data:`CLUSTER_SHARE` of the
    page's shorter side at the readable floor), each cluster framed and
    scaled to the page (:func:`_frame`), clusters whose frames overlap
    merged until none do. ``auto`` keeps them when a cell prints under
    :data:`AUTO_BELOW_CELL_MM` on the overview or there are several, and
    only those that print at least :data:`AUTO_MIN_GAIN` × the overview;
    ``on`` those that print larger at all; ``off`` none. Over ``cap``, the
    clusters with the most cable ends are kept. Pages are labelled A, B,
    … in reading order. Second value: the clusters left out by the cap."""
    if mode == "off":
        return [], 0
    ends = cable_ends(geometry)
    if not ends:
        return [], 0
    bounds = intersect(content, grid) or content
    w_mm, h_mm = page_mm
    lo, hi = scale_limits(px_per_cell)
    threshold = CLUSTER_SHARE * min(w_mm, h_mm) / lo
    groups = cluster(ends, threshold)
    while True:
        framed = [_frame([ends[i] for i in g], bounds, w_mm, h_mm, hi) for g in groups]
        hit = next(((i, j) for i in range(len(framed)) for j in range(i + 1, len(framed))
                    if overlaps(framed[i][0], framed[j][0])), None)
        if hit is None:
            break
        i, j = hit
        groups[i] = sorted(groups[i] + groups[j])
        del groups[j]
    overview_cell = overview_mm_per_px * CELL
    if mode == "auto":
        if overview_cell >= AUTO_BELOW_CELL_MM and len(groups) < 2:
            return [], 0
        gain = AUTO_MIN_GAIN
    else:
        gain = 1.0 + 1e-6
    pages = []
    for g, (box, s) in zip(groups, framed, strict=True):
        if s < overview_mm_per_px * gain:
            continue
        members = [ends[i] for i in g]
        pages.append(Page("", box, s, ends=members))
    dropped = max(0, len(pages) - cap)
    if dropped:
        weight = {id(p): sum(len(e.cables) for e in p.ends) for p in pages}
        keep = sorted(pages, key=lambda p: -weight[id(p)])[:cap]
        pages = [p for p in pages if any(p is k for k in keep)]
    pages.sort(key=lambda p: (p.box.y + p.box.h / 2, p.box.x + p.box.w / 2))
    # Rows of frames read left to right: frames whose centres are within
    # half a frame's height share a row.
    rows: list[list[Page]] = []
    for p in pages:
        cy = p.box.y + p.box.h / 2
        if rows and abs(cy - (rows[-1][0].box.y + rows[-1][0].box.h / 2)) < p.box.h / 2:
            rows[-1].append(p)
        else:
            rows.append([p])
    ordered = [p for row in rows for p in sorted(row, key=lambda p: p.box.x)]
    for n, p in enumerate(ordered):
        p.label = row_letters(n)
        p.cables = [cid for cid, geo in geometry.items() if crosses(geo, p.box)]
    return ordered, dropped


#: At most this many trace pages, one cable each.
MAX_TRACES = 20


def trace_layout(geometry: dict[str, dict], ids: list[str], *, grid: Box,
                 page_mm: tuple[float, float], px_per_cell: float | None = None,
                 cap: int = MAX_TRACES) -> tuple[list[Page], int]:
    """A page per cable of ``ids`` (in order, the first ``cap``): the plan
    framed to the cable's route and end tiles with a margin, page-shaped,
    scaled as a close-up is (:func:`_frame`), labelled T1, T2, … Second
    value: the ids left out by the cap."""
    w_mm, h_mm = page_mm
    _lo, hi = scale_limits(px_per_cell)
    pages = []
    for cid in ids[:cap]:
        geo = geometry.get(cid) or {}
        boxes = list(geo.get("boxes", ()))
        for r in geo.get("runs", ()):
            pts = r["points"]
            if pts:
                xs, ys = [p[0] for p in pts], [p[1] for p in pts]
                boxes.append((min(xs), min(ys), max(xs), max(ys)))
        if not boxes:
            for line in geo.get("lines", ()):
                if line:
                    xs, ys = [p[0] for p in line], [p[1] for p in line]
                    boxes.append((min(xs), min(ys), max(xs), max(ys)))
        if not boxes:
            continue
        box, s = _frame([End(tuple(b)) for b in boxes], grid, w_mm, h_mm, hi)
        pages.append(Page(f"T{len(pages) + 1}", box, s, cables=[cid]))
    return pages, max(0, len(ids) - cap)


def to_px(geometry: dict[str, dict]) -> dict[str, dict]:
    """Cable geometry in plan cells (``cable_schedule.build``) in plan px."""
    out = {}
    for cid, geo in geometry.items():
        out[cid] = {
            "lines": [[(x * CELL, y * CELL) for x, y in line] for line in geo["lines"]],
            "boxes": [tuple(v * CELL for v in b) for b in geo["boxes"]],
            "ends": [(*(v * CELL for v in e[:4]), e[4]) for e in geo.get("ends", ())],
        }
        if "runs" in geo:
            out[cid]["runs"] = [
                {"points": [(x * CELL, y * CELL) for x, y in r["points"]],
                 "documented": r["documented"]} for r in geo["runs"]
            ]
            out[cid]["terms"] = [
                (t[0], *(v * CELL for v in t[1:5]), t[5], t[6]) for t in geo.get("terms", ())
            ]
    return out


# ─── The background image ───────────────────────────────────────────────────


class Background:
    """A plan's background image, opened once and cut per page. ``source``
    is the plan holding the image (a live view's source), ``crop`` the
    view's part of it (None for a plan): the image is stretched over the
    source's grid, as the canvas draws it."""

    def __init__(self, source, crop, opacity: int):
        self.source = source
        self.crop = crop
        self.opacity = max(0, min(100, int(opacity if opacity is not None else 60))) / 100
        self._img = None
        self._tried = False

    def _image(self):
        if self._tried:
            return self._img
        self._tried = True
        if not self.source.background_image:
            return None
        from PIL import Image

        try:
            with self.source.background_image.open("rb") as fh:
                img = Image.open(fh)
                img.load()
        except Exception as exc:  # noqa: BLE001 - an unreadable image is left out
            log.warning("Cable schedule PDF: background of %s unreadable: %s",
                        self.source.pk, exc)
            return None
        self._img = img
        return img

    def px_per_cell(self) -> float | None:
        """The image's pixels per grid cell (the coarser way), or None
        without a readable image."""
        img = self._image()
        if img is None:
            return None
        iw, ih = img.size
        return min(iw / max(1, self.source.grid_width), ih / max(1, self.source.grid_height))

    def element(self, box: Box, mm_per_px: float) -> etree._Element | None:
        """An ``<image>`` of the part of the background under ``box`` (plan
        px of the plan drawn - the view's for a live view), or None."""
        img = self._image()
        if img is None:
            return None
        iw, ih = img.size
        gw, gh = max(1, self.source.grid_width), max(1, self.source.grid_height)
        ox, oy = (self.crop.x, self.crop.y) if self.crop is not None else (0, 0)
        # The box in source cells, clipped to the image (the source grid).
        sx0 = max(0.0, box.x / CELL + ox)
        sy0 = max(0.0, box.y / CELL + oy)
        sx1 = min(float(gw), box.x2 / CELL + ox)
        sy1 = min(float(gh), box.y2 / CELL + oy)
        if self.crop is not None:
            sx0, sy0 = max(sx0, self.crop.x), max(sy0, self.crop.y)
            sx1, sy1 = min(sx1, self.crop.x2), min(sy1, self.crop.y2)
        if sx1 <= sx0 or sy1 <= sy0:
            return None
        left, top = int(math.floor(sx0 / gw * iw)), int(math.floor(sy0 / gh * ih))
        right = min(iw, max(left + 1, int(math.ceil(sx1 / gw * iw))))
        bottom = min(ih, max(top + 1, int(math.ceil(sy1 / gh * ih))))
        part = img.crop((left, top, right, bottom))
        # At most BG_DPI on paper, and under the sanitiser's pixel cap.
        w_mm = (sx1 - sx0) * CELL * mm_per_px
        h_mm = (sy1 - sy0) * CELL * mm_per_px
        part = _shrink(part, max(1, round(w_mm / 25.4 * BG_DPI)),
                       max(1, round(h_mm / 25.4 * BG_DPI)))
        href = encode(part, (img.format or "").upper())
        if href is None:
            return None
        el = etree.Element(_q("image"))
        # Placed by a transform, not x/y: WeasyPrint draws an image with
        # opacity in a group sized to the image at the origin and offsets it
        # inside that group, so an image away from the origin - every
        # close-up's - came out blank.
        for k, v in (
            ("href", href),
            ("transform", f"translate({_fmt((sx0 - ox) * CELL)} {_fmt((sy0 - oy) * CELL)})"),
            ("x", "0"), ("y", "0"),
            ("width", _fmt((sx1 - sx0) * CELL)), ("height", _fmt((sy1 - sy0) * CELL)),
            ("preserveAspectRatio", "none"), ("opacity", _fmt(self.opacity)),
        ):
            el.set(k, v)
        return el


def _shrink(img, max_w: int, max_h: int):
    w, h = img.size
    scale = min(1.0, max_w / w, max_h / h, math.sqrt(MAX_IMAGE_PIXELS / (w * h)))
    if scale >= 1.0:
        return img
    return img.resize((max(1, int(w * scale)), max(1, int(h * scale))))


def encode(img, fmt: str = "") -> str | None:
    """``img`` as a ``data:`` URI under :data:`MAX_IMAGE_BYTES`: PNG when it
    has transparency or came as PNG, else JPEG; past the cap, JPEG on white
    and then smaller, until it fits."""
    from PIL import Image

    def jpeg(im, quality: int) -> bytes:
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            flat = Image.new("RGB", im.size, (255, 255, 255))
            flat.paste(im, mask=im.getchannel("A"))
            im = flat
        elif im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=quality)
        return buf.getvalue()

    if fmt == "JPEG" and img.mode in ("RGB", "L"):
        data, kind = jpeg(img, 85), "jpeg"
    else:
        buf = io.BytesIO()
        im = img if img.mode in ("RGB", "RGBA", "L", "LA", "P") else img.convert("RGBA")
        im.save(buf, format="PNG")
        data, kind = buf.getvalue(), "png"
    tries = 0
    while len(data) > MAX_IMAGE_BYTES and tries < 8:
        tries += 1
        if tries > 1:
            img = img.resize((max(1, img.size[0] * 3 // 4), max(1, img.size[1] * 3 // 4)))
        data, kind = jpeg(img, 70), "jpeg"
    if len(data) > MAX_IMAGE_BYTES:
        return None
    return f"data:image/{kind};base64,{base64.b64encode(data).decode('ascii')}"


# ─── Composing ──────────────────────────────────────────────────────────────


def compose(posted: etree._Element | None, box: Box, *, grid: tuple[float, float],
            background: etree._Element | None = None, cad: etree._Element | None = None,
            frames: list[Page] | None = None, ends: list[End] | None = None,
            mm_per_px: float = 1.0, bundles=None, tiles=(), trace: str | None = None,
            stubs: bool = False) -> bytes:
    """One SVG of ``box``: paper, the background, the CAD drawing clipped to
    the grid, the (sanitised) posted plan drawing over them, then a
    close-up's end tiles with their names (:func:`_end_names`) or the
    overview's close-up frames, all in plan pixels, strokes and type sized
    in paper mm at ``mm_per_px``.

    ``bundles`` (``cable_bundles.Bundles``) draws the cables over the plan
    and under the names, their counts clear of ``tiles`` (plan px boxes),
    the posted drawing's names and the end names; with ``trace``, faint,
    and that one cable over them (:meth:`Bundles.draw_trace`)."""
    out = etree.Element(_q("svg"), nsmap={None: SVG_NS})
    out.set("viewBox", box.view_box())
    out.set("width", _fmt(box.w))
    out.set("height", _fmt(box.h))
    paper = etree.SubElement(out, _q("rect"))
    for k, v in (("x", _fmt(box.x)), ("y", _fmt(box.y)), ("width", _fmt(box.w)),
                 ("height", _fmt(box.h)), ("fill", "#ffffff")):
        paper.set(k, v)
    if background is not None:
        out.append(background)
    gw, gh = grid
    if cad is not None:
        clip = etree.SubElement(out, _q("svg"))
        for k, v in (("x", "0"), ("y", "0"), ("width", _fmt(gw)), ("height", _fmt(gh)),
                     ("viewBox", f"0 0 {_fmt(gw)} {_fmt(gh)}")):
            clip.set(k, v)
        clip.append(copy.deepcopy(cad))
    if posted is not None:
        top = etree.SubElement(out, _q("g"))
        if posted.get("font-family"):
            top.set("font-family", posted.get("font-family"))
        for child in posted:
            top.append(copy.deepcopy(child))
    holder = etree.SubElement(out, _q("g")) if bundles is not None else None
    names: list[Box] = []
    if ends:
        names = _end_names(out, box, ends, mm_per_px)
    if bundles is not None:
        from .cable_bundles import Rect, text_boxes

        taken = [Rect(*t) for t in tiles]
        taken += text_boxes(posted)
        taken += [Rect(b.x, b.y, b.x2, b.y2) for b in names]
        bundles.draw(holder, box, mm_per_px, taken=taken, faint=trace is not None,
                     stubs=stubs and trace is None,
                     centre=(grid[0] / 2, grid[1] / 2))
        if trace is not None:
            bundles.draw_trace(out, trace, box, mm_per_px, avoid=text_boxes(posted))
    if frames:
        line = 0.35 / mm_per_px
        size = 3.2 / mm_per_px
        g = etree.SubElement(out, _q("g"))
        g.set("font-family", "Inter, sans-serif")
        for page in frames:
            b = page.box
            r = etree.SubElement(g, _q("rect"))
            for k, v in (("x", _fmt(b.x)), ("y", _fmt(b.y)), ("width", _fmt(b.w)),
                         ("height", _fmt(b.h)), ("fill", "none"), ("stroke", "#3f3f46"),
                         ("stroke-width", _fmt(line)),
                         ("stroke-dasharray", f"{_fmt(line * 6)} {_fmt(line * 3)}")):
                r.set(k, v)
            tag = etree.SubElement(g, _q("rect"))
            tw = size * (0.75 * len(page.label) + 0.6)
            for k, v in (("x", _fmt(b.x + line)), ("y", _fmt(b.y + line)),
                         ("width", _fmt(tw)), ("height", _fmt(size * 1.35)),
                         ("fill", "#ffffff"), ("stroke", "#3f3f46"),
                         ("stroke-width", _fmt(line))):
                tag.set(k, v)
            t = etree.SubElement(g, _q("text"))
            for k, v in (("x", _fmt(b.x + line + size * 0.3)),
                         ("y", _fmt(b.y + line + size * 1.05)),
                         ("font-size", _fmt(size)), ("font-weight", "700"),
                         ("fill", "#18181b")):
                t.set(k, v)
            t.text = page.label
    return etree.tostring(out, encoding="utf-8")


def _attrs(el: etree._Element, **attrs) -> etree._Element:
    for k, v in attrs.items():
        el.set(k.replace("_", "-"), _fmt(v) if isinstance(v, (int, float)) else str(v))
    return el


def end_label(names: list[str], limit: int = 3) -> str:
    """An end tile's names: the first ``limit``, then how many more."""
    if len(names) <= limit:
        return ", ".join(names)
    return f"{', '.join(names[:limit])} +{len(names) - limit}"


def _end_names(out: etree._Element, box: Box, ends: list[End], mm_per_px: float) -> list[Box]:
    """Each end tile on ``box`` outlined, its device names beside it on a
    white halo: right of the tile, else left, below or above - the first
    place inside the page clear of the tiles and names already there. When
    none is, the name is left out (the table names the ends)."""
    line = END_LINE_MM / mm_per_px
    size = END_FONT_MM / mm_per_px
    gap = 0.8 / mm_per_px
    g = etree.SubElement(out, _q("g"))
    g.set("font-family", "Inter, sans-serif")
    shown = [e for e in ends if e.box[0] < box.x2 and e.box[2] > box.x
             and e.box[1] < box.y2 and e.box[3] > box.y]
    taken: list[Box] = []
    for e in shown:
        x0, y0, x1, y1 = e.box
        _attrs(etree.SubElement(g, _q("rect")), x=x0, y=y0, width=x1 - x0, height=y1 - y0,
               fill="none", stroke="#18181b", stroke_width=line)
        taken.append(Box(x0, y0, x1 - x0, y1 - y0))
    placed: list[Box] = []
    for e in shown:
        name = end_label(e.names)
        if not name:
            continue
        x0, y0, x1, y1 = e.box
        tw, th = len(name) * size * 0.6, size * 1.25
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        for lx, ly in ((x1 + gap, cy - th / 2), (x0 - gap - tw, cy - th / 2),
                       (cx - tw / 2, y1 + gap), (cx - tw / 2, y0 - gap - th)):
            r = Box(lx, ly, tw, th)
            inside = r.x >= box.x and r.y >= box.y and r.x2 <= box.x2 and r.y2 <= box.y2
            if not inside or any(overlaps(r, t) for t in taken):
                continue
            taken.append(r)
            placed.append(r)
            for halo in (True, False):
                t = _attrs(etree.SubElement(g, _q("text")), x=lx, y=ly + size * 0.95,
                           fill="#18181b", font_size=size, font_weight=600)
                if halo:
                    _attrs(t, fill="#ffffff", stroke="#ffffff", stroke_width=size * 0.3,
                           stroke_linejoin="round")
                t.text = name
            break
    return placed
