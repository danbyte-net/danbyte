"""The cable schedule PDF's plan pages: the overview and the close-ups.

The page posts the plan as ``plan-svg.ts`` draws it framed to its content
(``planSvg(... fitContent)``): ``svg`` scaled for the overview and, for the
close-ups, ``detail_svg`` drawn at :data:`CLOSEUP_MM_PER_PX` (a cell
:data:`CLOSEUP_CELL_MM` on paper), so hatches and cables are sized for the
page they print on. Both are sanitised; what is added here is written here:

* the plan's background image, cut with Pillow to the part each page shows
  (a live view's crop of its source's image), at most :data:`BG_DPI` on
  paper and under the sanitiser's image caps;
* its CAD drawing, as the floor-plan PDF lays it (``floor_plan_pdf.cad_group``,
  the view's part for a live view), clipped to the grid;
* on the overview, a labelled frame for each close-up (A1, A2, …).

Close-ups tile the content box (the detail SVG's viewBox) with page-sized
rectangles, centred on it; a tile is a page when a cable's stored route,
tray or end tile crosses it. At most :data:`MAX_CLOSEUPS`, the busiest kept.
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
#: A cell on a close-up page (mm) - plan-svg.ts CLOSEUP_MM_PER_PX * CELL.
CLOSEUP_CELL_MM = 5.0
CLOSEUP_MM_PER_PX = CLOSEUP_CELL_MM / CELL
#: ``auto``: close-ups when a cell prints smaller than this on the overview.
AUTO_BELOW_CELL_MM = 2.0
MAX_CLOSEUPS = 20
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


@dataclass
class Page:
    label: str
    box: Box
    cables: list[str] = field(default_factory=list)


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


def wants_closeups(mode: str, overview_mm_per_px: float) -> bool:
    cell = overview_mm_per_px * CELL
    if mode == "off":
        return False
    if mode == "on":
        return cell < CLOSEUP_CELL_MM
    return cell < AUTO_BELOW_CELL_MM


# ─── Tiling ─────────────────────────────────────────────────────────────────


def row_letters(i: int) -> str:
    """A, B, …, Z, AA, AB, …"""
    out = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        out = chr(65 + r) + out
    return out


def tiles(content: Box, tile_w: float, tile_h: float) -> list[Page]:
    """Page-sized rectangles over ``content``, the grid centred on it,
    labelled by row letter and column number, in reading order."""
    cols = max(1, math.ceil(content.w / tile_w - 1e-9))
    rows = max(1, math.ceil(content.h / tile_h - 1e-9))
    x0 = content.x - (cols * tile_w - content.w) / 2
    y0 = content.y - (rows * tile_h - content.h) / 2
    return [
        Page(f"{row_letters(r)}{c + 1}", Box(x0 + c * tile_w, y0 + r * tile_h, tile_w, tile_h))
        for r in range(rows)
        for c in range(cols)
    ]


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


def closeup_pages(content: Box, geometry: dict[str, dict], tile_w: float, tile_h: float,
                  cap: int = MAX_CLOSEUPS) -> tuple[list[Page], int]:
    """The tiles a cable crosses, each with its cables (in ``geometry``'s
    order); over ``cap``, the busiest kept in reading order. Second value:
    how many cabled tiles were left out."""
    pages = []
    for page in tiles(content, tile_w, tile_h):
        page.cables = [cid for cid, geo in geometry.items() if crosses(geo, page.box)]
        if page.cables:
            pages.append(page)
    if len(pages) <= cap:
        return pages, 0
    keep = sorted(range(len(pages)), key=lambda i: (-len(pages[i].cables), i))[:cap]
    return [pages[i] for i in sorted(keep)], len(pages) - cap


def to_px(geometry: dict[str, dict]) -> dict[str, dict]:
    """Cable geometry in plan cells (``cable_schedule.build``) in plan px."""
    out = {}
    for cid, geo in geometry.items():
        out[cid] = {
            "lines": [[(x * CELL, y * CELL) for x, y in line] for line in geo["lines"]],
            "boxes": [tuple(v * CELL for v in b) for b in geo["boxes"]],
        }
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
        for k, v in (
            ("href", href),
            ("x", _fmt((sx0 - ox) * CELL)), ("y", _fmt((sy0 - oy) * CELL)),
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


def compose(posted: etree._Element, box: Box, *, grid: tuple[float, float],
            background: etree._Element | None = None, cad: etree._Element | None = None,
            frames: list[Page] | None = None, mm_per_px: float = 1.0) -> bytes:
    """One SVG of ``box``: paper, the background, the CAD drawing clipped to
    the grid, the (sanitised) posted plan drawing over them, and the
    close-ups' frames, all in plan pixels."""
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
    top = etree.SubElement(out, _q("g"))
    if posted.get("font-family"):
        top.set("font-family", posted.get("font-family"))
    for child in posted:
        top.append(copy.deepcopy(child))
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
