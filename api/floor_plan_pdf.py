"""Floor plans as PDF: ``POST /api/floor-plans/{id}/export/pdf/``.

The page draws the plan as an SVG (``frontend/src/components/floorplan/
plan-svg.ts``: tiles, zones, raised floors, walls and trays, light-themed)
and posts it with the paper and the Color by legend. The plan's CAD drawing
is not posted: it is read here from the plan's own rendered file, in vector,
with the layers and text the plan hides left out, and laid under the posted
drawing at its placement - the transform the canvas uses
(``cad_render.transform_mm``). The posted SVG goes through the sanitiser
(``api/svg_sanitize.py``) like every drawing PDF's; the CAD file through its
CAD profile again before WeasyPrint reads it.

The sheet is the drawing PDFs' (``api/drawing_pdf.py``: the same papers,
caps, render slots, deadline and print links), with a floor plan's footer:
the plan fitted to the page above a strip with a scale bar worked out from
the plan's ``cell_mm``, the legend, the drawing's credit line (its source
file), and the title block - the plan, its location, site and tenant, the
date, the Danbyte version and the page. Everything in the footer is written
here from the plan; only the legend's rows come from the page, each checked.

Paper is the light theme: the CAD drawing's default colour (``currentColor``,
see ``api/cad_engine.py``) prints in the light foreground, and any other
colour too faint on white is darkened to 3:1, keeping its hue - as
``frontend/src/components/floorplan/cad-colour.ts`` does on screen.
"""

from __future__ import annotations

import colorsys
import datetime as dt
import logging
import math
import re
from html import escape

from django.http import HttpResponse
from django.urls import reverse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from lxml import etree
from rest_framework import serializers
from rest_framework.response import Response

from . import cad_render
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
    body_too_large,
    deliver,
    detail,
    file_name,
    kept_pdf,
    render_guarded,
    run_with_deadline,
    stamp,
)
from .svg_sanitize import (
    MAX_SVG_BYTES,
    SVG_NS,
    SvgRejected,
    SvgTooLarge,
    sanitize_svg,
)

log = logging.getLogger(__name__)

#: Plan pixels per grid cell - frontend/src/components/floorplan/floor-canvas.tsx.
CELL = 40
#: The footer under the plan: scale bar, legend, credit line and title block.
FOOTER_MM = 22.0
GAP_MM = 4.0
TITLE_W_MM = 110.0

#: Paper is white; the CAD drawing's default colour is the light foreground.
PAPER = "#ffffff"
INK = "#18181b"
MIN_CONTRAST = 3.0
#: A CAD line on paper is its lineweight, kept between these (mm).
MIN_LINE_MM = 0.1
MAX_LINE_MM = 0.7
DEFAULT_LINE_MM = 0.18

#: What of the CAD drawing goes on paper. WeasyPrint lays text out letter by
#: letter, so past the text cap the drawing's text is left out (and the
#: credit line says so); past the others the drawing is refused.
CAD_MAX_BYTES = 12 * 1024 * 1024
CAD_MAX_ELEMENTS = 60_000
CAD_MAX_TEXT_CHARS = 40_000

_HEX = re.compile(r"^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")


# ─── Colour ─────────────────────────────────────────────────────────────────


def _rgb(hex_: str) -> tuple[float, float, float] | None:
    m = _HEX.match(hex_.strip())
    if not m:
        return None
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))


def _lum(rgb) -> float:
    def lin(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b) -> float:
    la, lb = _lum(a), _lum(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def contrast_safe(hex_: str, surface: str = PAPER, minimum: float = MIN_CONTRAST) -> str:
    """``hex_`` when it reads on ``surface``; else the same hue and
    saturation at the nearest lightness that does. Not a colour: unchanged."""
    rgb, bg = _rgb(hex_), _rgb(surface)
    if rgb is None or bg is None:
        return hex_
    if contrast(rgb, bg) >= minimum:
        return "#" + "".join(f"{round(c * 255):02x}" for c in rgb)
    h, lightness, s = colorsys.rgb_to_hls(*rgb)
    darker = _lum(bg) > 0.18
    lo, hi = (0.0, lightness) if darker else (lightness, 1.0)
    for _ in range(20):
        mid = (lo + hi) / 2
        ok = contrast(colorsys.hls_to_rgb(h, mid, s), bg) >= minimum
        if darker:
            lo, hi = (mid, hi) if ok else (lo, mid)
        else:
            lo, hi = (lo, mid) if ok else (mid, hi)
    out = colorsys.hls_to_rgb(h, lo if darker else hi, s)
    return "#" + "".join(f"{round(min(1, max(0, c)) * 255):02x}" for c in out)


# ─── The sheet ──────────────────────────────────────────────────────────────


def plan_sheet(width_px: float, height_px: float, paper: str, orientation: str,
               title_block: bool) -> dict:
    """The plan fitted to the page above the footer, centred across it, in
    mm; ``scale`` is paper mm per plan pixel. Fit to page: a small plan is
    enlarged too."""
    pw, ph = PAPERS_MM[paper]
    if orientation == "portrait":
        pw, ph = ph, pw
    aw = pw - 2 * MARGIN_MM
    ah = ph - 2 * MARGIN_MM - (FOOTER_MM + GAP_MM if title_block else 0)
    w, h = max(float(width_px), 1.0), max(float(height_px), 1.0)
    scale = min(aw / w, ah / h)
    dw, dh = w * scale, h * scale
    return {
        "page": (pw, ph),
        "area": (MARGIN_MM, MARGIN_MM, aw, ah),
        "at": (MARGIN_MM + (aw - dw) / 2, MARGIN_MM, dw, dh),
        "scale": scale,
    }


_NICE = (1, 2, 5)


def scale_bar(paper_mm_per_real_mm: float, max_mm: float = 45.0) -> dict:
    """The longest round real length (1, 2 or 5 × 10ⁿ mm) whose bar fits in
    ``max_mm`` of paper: its label, its length on paper and the ratio."""
    best = None
    for exp in range(0, 9):
        for n in _NICE:
            real = n * 10**exp
            paper = real * paper_mm_per_real_mm
            if paper <= max_mm:
                best = (real, paper)
    if best is None:
        best = (1, paper_mm_per_real_mm)
    real, paper = best
    if real >= 1_000_000:
        label = f"{real / 1_000_000:g} km"
    elif real >= 1000:
        label = f"{real / 1000:g} m"
    elif real >= 10:
        label = f"{real / 10:g} cm"
    else:
        label = f"{real:g} mm"
    ratio = 1 / paper_mm_per_real_mm if paper_mm_per_real_mm > 0 else 0
    return {"label": label, "mm": paper, "ratio": f"1:{_round_ratio(ratio):,}"}


def _round_ratio(r: float) -> int:
    if r <= 0 or not math.isfinite(r):
        return 0
    digits = max(0, int(math.floor(math.log10(r))) - 1)
    return int(round(r / 10**digits) * 10**digits)


def _bar_html(bar: dict) -> str:
    seg = bar["mm"] / 4
    cells = "".join(
        f"<span style='width:{seg:.3f}mm;background:{INK if i % 2 == 0 else '#ffffff'}'></span>"
        for i in range(4)
    )
    return (
        "<div class='bar'>"
        f"<div class='ticks' style='width:{bar['mm']:.3f}mm'>{cells}</div>"
        f"<div class='bl'><b>{escape(bar['label'])}</b> · {escape(bar['ratio'])}</div>"
        "</div>"
    )


def _legend_html(legend: dict | None) -> str:
    if not legend or not legend.get("items"):
        return ""
    def swatch(c: str) -> str:
        # Validated #rrggbb (the serializer); the fill at a tile's strength.
        r, g, b = (int(c[i : i + 2], 16) for i in (1, 3, 5))
        return f"background:rgba({r},{g},{b},0.35);border-color:{c}"

    rows = "".join(
        f"<span class='li'><i style='{swatch(row['color'])}'></i>"
        f"{escape(row['label'])}</span>"
        for row in legend["items"]
    )
    return (
        f"<div class='legend'><div class='lt'>{escape(legend.get('title') or '')}</div>"
        f"{rows}</div>"
    )


def sheet_html(sheet: dict, *, title: str, subtitle: str, credit: str, bar: dict | None,
               legend: dict | None, generated: dt.datetime, title_block: bool) -> str:
    from danbyte import __version__

    pw, ph = sheet["page"]
    ax, ay, aw, ah = sheet["area"]
    x, y, w, h = sheet["at"]
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    footer = ""
    if title_block:
        small = " · ".join((stamp(generated), f"Danbyte {__version__}", "Page 1 / 1"))
        left = (_bar_html(bar) if bar else "") + _legend_html(legend)
        if credit:
            left += f"<div class='credit'>{escape(credit)}</div>"
        footer = (
            f"<div class='foot'><div class='left'>{left}</div>"
            "<div class='block'>"
            f"<div class='t'>{escape(title)}</div>"
            f"<div class='s'>{escape(subtitle)}</div>"
            f"<div class='m'>{escape(small)}</div>"
            "</div></div>"
        )
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{escape(title)}</title>"
        f"<meta name='generator' content='Danbyte {escape(__version__)}'>"
        "<style>"
        f"{_font_faces()}"
        f"@page{{size:{mm(pw)} {mm(ph)};margin:{mm(MARGIN_MM)}}}"
        "html,body{margin:0;padding:0}"
        f"body{{font-family:Inter,'DejaVu Sans',sans-serif;color:{INK}}}"
        f".sheet{{position:relative;width:{mm(pw - 2 * MARGIN_MM)};"
        f"height:{mm(ph - 2 * MARGIN_MM - 0.5)};overflow:hidden}}"
        f".drawing{{position:absolute;display:block;left:{mm(x - ax)};"
        f"top:{mm(y - ay)};width:{mm(w)};height:{mm(h)}}}"
        f".foot{{position:absolute;left:0;right:0;bottom:0;height:{mm(FOOTER_MM)}}}"
        f".left{{position:absolute;left:0;bottom:0;right:{mm(min(TITLE_W_MM, aw) + 4)};"
        "font-size:6.5pt;color:#52525b}"
        ".bar{margin-bottom:1.2mm}"
        f".ticks{{display:flex;height:1.6mm;border:0.2mm solid {INK}}}"
        ".ticks span{display:block;height:100%}"
        ".bl{margin-top:0.6mm;white-space:nowrap}"
        ".bl b{color:#18181b;font-weight:600}"
        ".legend{line-height:1.5}"
        ".lt{font-weight:600;color:#18181b}"
        ".li{display:inline-block;margin-right:3mm;white-space:nowrap}"
        ".li i{display:inline-block;width:3.5mm;height:2.2mm;border:0.25mm solid;"
        "border-radius:0.5mm;margin-right:1mm;vertical-align:-0.3mm}"
        ".credit{margin-top:0.8mm;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
        f".block{{position:absolute;right:0;bottom:0;"
        f"width:{mm(min(TITLE_W_MM, aw))};height:{mm(14)};"
        "box-sizing:border-box;border:0.25mm solid #d4d4d8;border-radius:1mm;"
        "padding:1.4mm 2.5mm 0;text-align:right}"
        ".block div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
        ".t{font-size:11pt;font-weight:700;line-height:1.2}"
        ".s{font-size:7.5pt;color:#52525b;line-height:1.35}"
        ".m{font-size:7pt;color:#71717a;line-height:1.35}"
        "</style></head><body><div class='sheet'>"
        f"<img class='drawing' src='{DIAGRAM_URL}' alt=''>"
        f"{footer}</div></body></html>"
    )


def render_floor_pdf(svg: bytes, *, sheet: dict, **kwargs) -> bytes:
    """The composed plan on its sheet, as PDF bytes."""
    import weasyprint

    html = sheet_html(sheet, **kwargs)
    return weasyprint.HTML(
        string=html, base_url=BASE_URL, url_fetcher=PdfUrlFetcher(svg)
    ).write_pdf()


def _render(svg: bytes, **kwargs) -> bytes:
    # Looked up when called, so the child renders what this module names.
    return render_floor_pdf(svg, **kwargs)


def render_with_deadline(svg: bytes, *, timeout: float = RENDER_TIMEOUT, **kwargs) -> bytes:
    return run_with_deadline(_render, svg, timeout=timeout, **kwargs)


# ─── The drawing ────────────────────────────────────────────────────────────


def _q(tag: str) -> str:
    return f"{{{SVG_NS}}}{tag}"


def _fmt(v: float) -> str:
    s = f"{v:.6g}"
    return "0" if s in ("-0", "") else s


def cad_group(d, *, paper_mm_per_px: float, px_per_mm: float) -> tuple[etree._Element, bool]:
    """The plan's CAD drawing as a ``<g>`` in plan pixels, ready for paper:
    hidden layers and (when hidden) text left out, default colour in ink,
    faint colours darkened, lines at their lineweight on paper. Second
    value: the drawing's text had to be left out to stay in budget.
    :class:`SvgTooLarge` when even that is over the PDF's caps."""
    with d.rendered.open("rb") as fh:
        raw = fh.read(cad_render.MAX_SVG_BYTES + 1)
    root = etree.fromstring(sanitize_svg(raw, profile="cad"))
    placement = d.placement or {}
    hidden = set(placement.get("hidden_layers") or [])
    hide_text = bool(placement.get("hide_text"))
    for g in list(root.iter(_q("g"))):
        parent = g.getparent()
        if parent is None:
            continue
        if g.get("data-layer") in hidden or (hide_text and g.get("data-kind") == "text"):
            parent.remove(g)
    texts = list(root.iter(_q("text")))
    text_dropped = False
    if sum(len("".join(t.itertext())) for t in texts) > CAD_MAX_TEXT_CHARS:
        for g in list(root.iter(_q("g"))):
            if g.get("data-kind") == "text" and g.getparent() is not None:
                g.getparent().remove(g)
        for t in list(root.iter(_q("text"))):
            t.getparent().remove(t)
        text_dropped = True
    count = sum(1 for _ in root.iter())
    if count > CAD_MAX_ELEMENTS:
        raise SvgTooLarge(
            "The CAD drawing is too large for a PDF. Hide some of its layers, "
            "or export without it."
        )
    # Paper mm per drawing unit: plan px per drawing unit times paper mm per px.
    s = d.mm_per_unit * px_per_mm * paper_mm_per_px
    colours: dict[str, str] = {}
    size = 0
    for el in root.iter():
        for attr in ("stroke", "fill"):
            v = el.get(attr)
            if not v:
                continue
            if v == "currentColor":
                el.set(attr, INK)
            elif v.startswith("#"):
                if v not in colours:
                    colours[v] = contrast_safe(v)
                el.set(attr, colours[v])
        w = el.get("stroke-width")
        if w is not None and s > 0:
            try:
                lw = float(w)
            except ValueError:
                lw = DEFAULT_LINE_MM
            line_mm = min(MAX_LINE_MM, max(MIN_LINE_MM, lw if lw > 0 else DEFAULT_LINE_MM))
            el.set("stroke-width", _fmt(line_mm / s))
        for k in ("data-layer", "data-kind"):
            if k in el.attrib:
                del el.attrib[k]
        size += len(el.get("d") or "") + len(el.text or "")
    if size > CAD_MAX_BYTES:
        raise SvgTooLarge(
            "The CAD drawing is too large for a PDF. Hide some of its layers, "
            "or export without it."
        )
    outer = etree.Element(_q("g"))
    outer.set(
        "transform", f"scale({_fmt(px_per_mm)}) {cad_render.transform_mm(d)}"
    )
    opacity = placement.get("opacity", 60)
    try:
        outer.set("opacity", _fmt(max(0.0, min(100.0, float(opacity))) / 100))
    except (TypeError, ValueError):
        outer.set("opacity", "0.6")
    outer.set("fill", "none")
    for child in list(root):
        outer.append(child)
    return outer, text_dropped


def compose(plan_svg: bytes, *, width: float, height: float, cad: etree._Element | None) -> bytes:
    """One SVG of the plan: the floor, the CAD drawing clipped to it, then
    the (sanitised) posted plan drawing over both, all in plan pixels."""
    posted = etree.fromstring(plan_svg)
    out = etree.Element(_q("svg"), nsmap={None: SVG_NS})
    for k, v in (("viewBox", f"0 0 {_fmt(width)} {_fmt(height)}"),
                 ("width", _fmt(width)), ("height", _fmt(height))):
        out.set(k, v)
    floor = etree.SubElement(out, _q("rect"))
    for k, v in (("width", _fmt(width)), ("height", _fmt(height)), ("fill", PAPER),
                 ("stroke", "#d4d4d8"), ("stroke-width", "1")):
        floor.set(k, v)
    if cad is not None:
        frame = etree.SubElement(out, _q("svg"))
        for k, v in (("x", "0"), ("y", "0"), ("width", _fmt(width)),
                     ("height", _fmt(height)), ("viewBox", f"0 0 {_fmt(width)} {_fmt(height)}")):
            frame.set(k, v)
        frame.append(cad)
    top = etree.SubElement(out, _q("svg"))
    for k, v in (("x", "0"), ("y", "0"), ("width", _fmt(width)), ("height", _fmt(height)),
                 ("preserveAspectRatio", "none")):
        top.set(k, v)
    top.set("viewBox", posted.get("viewBox") or f"0 0 {_fmt(width)} {_fmt(height)}")
    for k in ("font-family",):
        if posted.get(k):
            top.set(k, posted.get(k))
    for child in list(posted):
        top.append(child)
    return etree.tostring(out, encoding="utf-8")


# ─── The request ────────────────────────────────────────────────────────────


class _LegendItemSerializer(serializers.Serializer):
    label = serializers.CharField(max_length=80)
    color = serializers.RegexField(_HEX, max_length=7)

    def validate_color(self, v):
        r, g, b = (round(c * 255) for c in _rgb(v))
        return f"#{r:02x}{g:02x}{b:02x}"


class _LegendSerializer(serializers.Serializer):
    title = serializers.CharField(max_length=80, required=False, allow_blank=True)
    items = _LegendItemSerializer(many=True, max_length=24)


class FloorPlanPdfRequestSerializer(serializers.Serializer):
    svg = serializers.CharField(
        trim_whitespace=False,
        max_length=MAX_SVG_BYTES,
        help_text="The plan, as plan-svg.ts draws it; the CAD drawing is added here.",
    )
    paper = DrawingPaperSerializer(
        required=False, help_text="A3 landscape when absent."
    )
    title_block = serializers.BooleanField(required=False, default=True)
    drawing = serializers.BooleanField(
        required=False, default=True, help_text="Lay the plan's CAD drawing under it."
    )
    legend = _LegendSerializer(required=False, allow_null=True)


class FloorPlanPdfLinkSerializer(serializers.Serializer):
    url = serializers.CharField()


def plan_title(plan, tenant_name: str) -> tuple[str, str]:
    loc = plan.location
    parts = [loc.name, loc.site.name if loc.site_id else "", tenant_name]
    return plan.name, " · ".join(p for p in parts if p)


def _print_key(user_id, tenant_id) -> str:
    return f"floorplan-pdf-print:{user_id}:{tenant_id}"


def _ready_drawing(plan):
    from .models import FloorPlanDrawing

    d = FloorPlanDrawing.objects.filter(floor_plan=plan, tenant_id=plan.tenant_id).first()
    if d is None or d.status != "ready" or not d.rendered:
        return None
    return d


def export_pdf(request, plan) -> HttpResponse | Response:
    """``plan`` - one the caller may view, found by the viewset - on one
    sheet, its CAD drawing under the posted plan drawing."""
    if body_too_large(request, MAX_BODY_BYTES):
        return detail("The request is over 10 MB.", 413)
    ser = FloorPlanPdfRequestSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    paper = data.get("paper") or {}
    size = paper.get("size", "a3")
    orientation = paper.get("orientation", "landscape")
    title_block = data["title_block"]
    title, subtitle = plan_title(plan, plan.tenant.name)
    width = plan.grid_width * CELL
    height = plan.grid_height * CELL
    sheet = plan_sheet(width, height, size, orientation, title_block)
    px_per_mm = CELL / plan.cell_mm
    bar = scale_bar(sheet["scale"] * px_per_mm)
    drawing = _ready_drawing(plan) if data["drawing"] else None
    credit = ""
    generated = timezone.now()
    state = {"text_dropped": False}

    def sanitize(text: str) -> bytes:
        posted = sanitize_svg(text)
        cad = None
        if drawing is not None:
            try:
                cad, state["text_dropped"] = cad_group(
                    drawing, paper_mm_per_px=sheet["scale"], px_per_mm=px_per_mm
                )
            except SvgTooLarge:
                raise
            except (SvgRejected, OSError, etree.XMLSyntaxError) as exc:
                log.warning("Floor plan PDF: CAD drawing of %s unreadable: %s", plan.pk, exc)
                raise SvgRejected("The CAD drawing could not be read.") from exc
        return compose(posted, width=width, height=height, cad=cad)

    if drawing is not None:
        credit = f"Drawing: {drawing.source_name or 'CAD drawing'}"

    def render(svg: bytes) -> bytes:
        line = credit + (" · text left out" if state["text_dropped"] else "")
        return render_with_deadline(
            svg,
            sheet=sheet,
            title=title,
            subtitle=subtitle,
            credit=line,
            bar=bar,
            legend=data.get("legend"),
            generated=generated,
            title_block=title_block,
        )

    try:
        pdf = render_guarded(request, data["svg"], sanitize=sanitize, render=render)
    except RenderTimeout:
        log.warning("Floor plan PDF for user %s stopped after %ss", request.user.pk,
                    RENDER_TIMEOUT)
        return detail("The plan took too long to render. Hide some of the drawing's "
                      "layers, or export without it.", 413)
    if isinstance(pdf, Response):
        return pdf
    return deliver(
        request,
        pdf,
        name=file_name(plan.name, generated, "floor-plan"),
        key=_print_key(request.user.pk, plan.tenant_id),
        link=lambda token: reverse(
            "floor-plan-export-pdf-file", kwargs={"pk": str(plan.pk), "token": token}
        ),
        label="Floor plan",
        extra={"object": str(plan.pk)},
    )


def export_pdf_file(request, plan, token: str) -> HttpResponse | Response:
    return kept_pdf(
        request, token, key=_print_key(request.user.pk, plan.tenant_id),
        match={"object": str(plan.pk)},
    )


# ─── Schema ─────────────────────────────────────────────────────────────────

pdf_schema = extend_schema(
    summary="The floor plan as a PDF",
    description=(
        "Renders the plan SVG the page draws on one sheet of A4, A3, Letter or "
        "Tabloid (A3 landscape by default), fitted to the page, with the plan's "
        "CAD drawing laid under it in vector (unless `drawing` is false) and a "
        "footer written on the server: a scale bar from the plan's cell size, "
        "the posted Color by legend, the drawing's source file, and a title "
        "block with the plan, its location, site and tenant, the date, the "
        "Danbyte version and the page. Needs view on floor plans. The SVG is "
        "sanitized as the topology PDF's is, under the same limits; the CAD "
        "drawing is capped at 60,000 elements on paper. `?print=1` returns "
        "`{url}`: a link to the PDF for five minutes, for the same user and "
        "tenant; a newer one replaces it."
    ),
    tags=["floor-plans"],
    parameters=[
        OpenApiParameter(
            name="print",
            type=OpenApiTypes.BOOL,
            location=OpenApiParameter.QUERY,
            description="Answer with a short-lived link instead of the file.",
        ),
    ],
    request=FloorPlanPdfRequestSerializer,
    responses={
        (200, "application/pdf"): OpenApiTypes.BINARY,
        (200, "application/json"): FloorPlanPdfLinkSerializer,
        400: OpenApiResponse(description="Invalid request or SVG."),
        403: OpenApiResponse(description="No view on floor plans."),
        404: OpenApiResponse(description="No such plan for this user and tenant."),
        413: OpenApiResponse(description="Over a cap, or too slow to render."),
        429: OpenApiResponse(
            description="A PDF for this user is being made, or as many as the server makes at once."
        ),
        503: OpenApiResponse(description="The print link could not be kept."),
    },
)

pdf_file_schema = extend_schema(
    summary="A floor plan PDF made with ?print=1",
    description=(
        "The PDF behind a print link, for five minutes, to the user and tenant "
        "that made it while they may view the plan, until they make another; "
        "inline, or as a download with `?download=1`."
    ),
    tags=["floor-plans"],
    parameters=[
        OpenApiParameter(name="token", type=OpenApiTypes.STR, location=OpenApiParameter.PATH,
                         description="The print link's token."),
        OpenApiParameter(name="download", type=OpenApiTypes.BOOL,
                         location=OpenApiParameter.QUERY,
                         description="Save the file instead of opening it."),
    ],
    request=None,
    responses={
        (200, "application/pdf"): OpenApiTypes.BINARY,
        404: OpenApiResponse(description="No such link for this user, tenant and plan."),
        503: OpenApiResponse(description="Print links are unavailable right now."),
    },
)
