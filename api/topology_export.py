"""Topology diagrams as PDF: ``POST /api/topology/export/pdf/``.

The browser draws the map as an SVG (``frontend/src/lib/diagram/svg.ts``,
the same drawing as the SVG export) and posts it here with the paper and
the title block's text. The server sanitizes it (``api/svg_sanitize.py``)
and lays it out with WeasyPrint on one sheet of real paper: the drawing
fitted to the printable area, under it a title block with the view, the
tenant, the filters, the date, the Danbyte version and the page. A browser
can't be made to print at a paper size - ``@page`` is advisory and the print
dialog wins - so the size is baked into a PDF, as for labels and spec sheets.

WeasyPrint reads nothing from the network or the disk on the caller's
behalf: its URL fetcher serves the posted drawing from memory, decodes
``data:`` URIs, reads device-type photos from ``MEDIA_ROOT`` (public images,
#227) and the vendored Inter faces in ``api/pdf_fonts/`` (SIL OFL, static
instances of the app's variable Inter so every weight embeds), and refuses
everything else.

``?print=1`` keeps the PDF in the cache for five minutes and answers with a
link, ``GET /api/topology/export/pdf/<token>/``, that only the same user in
the same tenant can open - inline, so the browser's viewer prints it; add
``?download=1`` to save it instead.
"""

from __future__ import annotations

import datetime as dt
import mimetypes
import re
import secrets
from functools import lru_cache
from html import escape
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import DataHandler, Request, url2pathname

from django.conf import settings
from django.core.cache import cache
from django.http import HttpResponse
from django.urls import reverse
from django.utils import timezone
from django.utils._os import safe_join
from django.utils.text import slugify
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac

from .svg_sanitize import MAX_SVG_BYTES, SvgRejected, sanitize_svg
from .views import _get_active_tenant

# Paper sizes in mm, landscape (width, height).
PAPERS_MM = {
    "a4": (297.0, 210.0),
    "a3": (420.0, 297.0),
    "letter": (279.4, 215.9),
    "tabloid": (431.8, 279.4),
}
ORIENTATIONS = ("landscape", "portrait")
# The sheet, in mm - mirrored by frontend/src/lib/diagram/sheet.ts.
MARGIN_MM = 10.0
TITLE_MM = 14.0
GAP_MM = 4.0
TITLE_W_MM = 120.0
# CSS px → mm at 96 dpi; a small map is enlarged to at most 1.5x that.
PX_MM = 25.4 / 96
MAX_SCALE = 1.5 * PX_MM

# The whole request, and the finished PDF kept for a print link.
MAX_BODY_BYTES = 10 * 1024 * 1024
MAX_PDF_BYTES = 48 * 1024 * 1024
PRINT_TTL = 300
# One render per user at a time; the lock outlives a stuck worker.
RENDER_LOCK_TTL = 120

FONT_DIR = Path(__file__).resolve().parent / "pdf_fonts"
FONT_WEIGHTS = (400, 500, 600, 700)
# From @fontsource-variable/inter's @font-face rules.
FONT_RANGES = {
    "latin": (
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,"
        "U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,"
        "U+2215,U+FEFF,U+FFFD"
    ),
    "latin-ext": (
        "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,"
        "U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,"
        "U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"
    ),
}

# The origin WeasyPrint resolves against. `.invalid` never resolves; the
# fetcher answers for it without a network.
BASE_URL = "https://danbyte.invalid/"
DIAGRAM_URL = BASE_URL + "_/diagram.svg"
MEDIA_IMAGES_URL = BASE_URL + "media/device-type-images/"
MAX_MEDIA_BYTES = 12 * 1024 * 1024

_TOKEN = re.compile(r"^[A-Za-z0-9_-]{24,64}$")


# ─── The sheet ──────────────────────────────────────────────────────────────


def plan_sheet(
    width_px: float,
    height_px: float,
    paper: str = "a3",
    orientation: str = "landscape",
    title_block: bool = True,
) -> dict:
    """Where a ``width_px``×``height_px`` drawing sits on the page, in mm:
    fitted to the printable area (never enlarged past ``MAX_SCALE``), at its
    top and centred across it, above the title block."""
    pw, ph = PAPERS_MM[paper]
    if orientation == "portrait":
        pw, ph = ph, pw
    aw = pw - 2 * MARGIN_MM
    ah = ph - 2 * MARGIN_MM - (TITLE_MM + GAP_MM if title_block else 0)
    w = max(float(width_px), 1.0)
    h = max(float(height_px), 1.0)
    scale = min(aw / w, ah / h, MAX_SCALE)
    dw, dh = w * scale, h * scale
    return {
        "page": (pw, ph),
        "area": (MARGIN_MM, MARGIN_MM, aw, ah),
        "at": (MARGIN_MM + (aw - dw) / 2, MARGIN_MM, dw, dh),
        "scale": scale,
    }


_ROOT = re.compile(rb"<svg\b[^>]*>")
_ATTR = r'\s{}="([^"]*)"'
_UNITS_PX = {"": 1.0, "px": 1.0, "pt": 96 / 72, "mm": 96 / 25.4, "cm": 96 / 2.54, "in": 96.0}


def svg_size(svg: bytes) -> tuple[float, float]:
    """The drawing's size in CSS px: the root's width and height, else its
    viewBox, else a square."""
    m = _ROOT.search(svg[:16384])
    tag = m.group(0).decode("utf-8", "replace") if m else ""

    def length(name):
        m = re.search(_ATTR.format(name), tag)
        u = m and re.match(r"^\s*([0-9.]+)\s*(px|pt|mm|cm|in)?\s*$", m.group(1))
        return float(u.group(1)) * _UNITS_PX[u.group(2) or ""] if u else None

    w, h = length("width"), length("height")
    if not (w and h):
        m = re.search(_ATTR.format("viewBox"), tag)
        parts = m.group(1).replace(",", " ").split() if m else []
        try:
            w, h = float(parts[2]), float(parts[3])
        except (IndexError, ValueError):
            w = h = 1000.0
    return max(w, 1.0), max(h, 1.0)


@lru_cache(maxsize=1)
def _font_files() -> dict[str, Path]:
    """The vendored faces by resolved path - the only files WeasyPrint may
    read."""
    files = {}
    for subset in FONT_RANGES:
        for weight in FONT_WEIGHTS:
            p = (FONT_DIR / f"inter-{subset}-{weight}.woff2").resolve()
            if p.is_file():
                files[str(p)] = p
    return files


@lru_cache(maxsize=16)
def _font_bytes(path: str) -> bytes:
    """A vendored face as plain TrueType, unpacked once per process: WOFF2
    keeps the repository small, and unpacking all eight on every render
    cost about 0.6 s."""
    from io import BytesIO

    from fontTools.ttLib import TTFont

    font = TTFont(path)
    font.flavor = None
    out = BytesIO()
    font.save(out)
    return out.getvalue()


def _font_faces() -> str:
    faces = []
    for subset, urange in FONT_RANGES.items():
        for weight in FONT_WEIGHTS:
            p = (FONT_DIR / f"inter-{subset}-{weight}.woff2").resolve()
            if str(p) in _font_files():
                faces.append(
                    f'@font-face{{font-family:"Inter";font-style:normal;'
                    f'font-weight:{weight};src:url("{p.as_uri()}");'
                    f"unicode-range:{urange}}}"
                )
    return "".join(faces)


def _stamp(when: dt.datetime) -> str:
    return when.astimezone(dt.UTC).strftime("%Y-%m-%d %H:%M UTC")


def _sheet_html(
    plan: dict,
    *,
    title: str,
    tenant: str,
    filters: str,
    generated: dt.datetime,
    title_block: bool,
) -> str:
    from danbyte import __version__

    pw, ph = plan["page"]
    ax, ay, aw, ah = plan["area"]
    x, y, w, h = plan["at"]
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    block = ""
    if title_block:
        sub = " · ".join(s for s in (tenant, filters) if s)
        small = " · ".join((_stamp(generated), f"Danbyte {__version__}", "Page 1 / 1"))
        block = (
            '<div class="block">'
            f'<div class="t">{escape(title)}</div>'
            f'<div class="s">{escape(sub)}</div>'
            f'<div class="m">{escape(small)}</div>'
            "</div>"
        )
    # Positions are relative to the page area (inside the 10 mm margin).
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{escape(title)}</title>"
        f"<meta name='generator' content='Danbyte {escape(__version__)}'>"
        "<style>"
        f"{_font_faces()}"
        f"@page{{size:{mm(pw)} {mm(ph)};margin:{mm(MARGIN_MM)}}}"
        "html,body{margin:0;padding:0}"
        "body{font-family:Inter,'DejaVu Sans',sans-serif;color:#18181b}"
        f".sheet{{position:relative;width:{mm(pw - 2 * MARGIN_MM)};"
        f"height:{mm(ph - 2 * MARGIN_MM - 0.5)};overflow:hidden}}"
        f".drawing{{position:absolute;display:block;left:{mm(x - ax)};"
        f"top:{mm(y - ay)};width:{mm(w)};height:{mm(h)}}}"
        f".block{{position:absolute;right:0;bottom:0;"
        f"width:{mm(min(TITLE_W_MM, aw))};height:{mm(TITLE_MM)};"
        "box-sizing:border-box;border:0.25mm solid #d4d4d8;border-radius:1mm;"
        "padding:1.4mm 2.5mm 0;text-align:right}"
        ".block div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
        ".t{font-size:11pt;font-weight:700;line-height:1.2}"
        ".s{font-size:7.5pt;color:#52525b;line-height:1.35}"
        ".m{font-size:7pt;color:#71717a;line-height:1.35}"
        "</style></head><body><div class='sheet'>"
        f"<img class='drawing' src='{DIAGRAM_URL}' alt=''>"
        f"{block}</div></body></html>"
    )


# ─── The URL fetcher ────────────────────────────────────────────────────────


def _response(url: str, body: bytes, mime: str):
    """What WeasyPrint's fetchers return: a URLFetcherResponse (69+), else
    the older dict."""
    try:
        from weasyprint.urls import URLFetcherResponse
    except ImportError:  # WeasyPrint < 69
        return {"string": body, "mime_type": mime, "redirected_url": url}
    return URLFetcherResponse(url, body, {"Content-Type": mime})


class PdfUrlFetcher:
    """WeasyPrint's only way out: the posted drawing, ``data:`` URIs, the
    vendored fonts and device-type photos. Anything else - http(s), other
    files, other media - raises, and WeasyPrint leaves it out."""

    def __init__(self, svg: bytes):
        self.svg = svg

    def __call__(self, url: str):
        if url == DIAGRAM_URL:
            return _response(url, self.svg, "image/svg+xml")
        scheme = url.split(":", 1)[0].lower()
        if scheme == "data":
            with DataHandler().data_open(Request(url)) as res:
                return _response(url, res.read(), res.headers.get_content_type())
        if scheme == "file":
            path = str(Path(url2pathname(urlsplit(url).path)).resolve())
            if path not in _font_files():
                raise ValueError("Only the vendored fonts are readable.")
            return _response(url, _font_bytes(path), "font/ttf")
        if url.startswith(MEDIA_IMAGES_URL) and "?" not in url and "#" not in url:
            return self._media(url)
        raise ValueError(f"Refused to fetch {url[:80]}")

    @staticmethod
    def _media(url: str):
        rel = unquote(url[len(MEDIA_IMAGES_URL) :])
        if not rel or ".." in rel.split("/") or rel.startswith("/"):
            raise ValueError("Bad media path.")
        mime = mimetypes.guess_type(rel)[0]
        if mime not in ("image/png", "image/jpeg", "image/webp"):
            raise ValueError("Not a photo.")
        path = Path(safe_join(str(settings.MEDIA_ROOT), "device-type-images", rel))
        if not path.is_file() or path.stat().st_size > MAX_MEDIA_BYTES:
            raise ValueError("No such photo.")
        return _response(url, path.read_bytes(), mime)


def render_topology_pdf(
    svg: bytes,
    *,
    title: str,
    tenant: str = "",
    filters: str = "",
    generated: dt.datetime | None = None,
    paper: str = "a3",
    orientation: str = "landscape",
    title_block: bool = True,
) -> bytes:
    """A sanitized drawing on one sheet of ``paper``, as PDF bytes."""
    import weasyprint

    w, h = svg_size(svg)
    plan = plan_sheet(w, h, paper, orientation, title_block)
    html = _sheet_html(
        plan,
        title=title,
        tenant=tenant,
        filters=filters,
        generated=generated or timezone.now(),
        title_block=title_block,
    )
    return weasyprint.HTML(
        string=html, base_url=BASE_URL, url_fetcher=PdfUrlFetcher(svg)
    ).write_pdf()


# ─── Endpoints ──────────────────────────────────────────────────────────────


class _PaperSerializer(serializers.Serializer):
    size = serializers.ChoiceField(choices=list(PAPERS_MM), default="a3")
    orientation = serializers.ChoiceField(choices=ORIENTATIONS, default="landscape")


class _MetaSerializer(serializers.Serializer):
    view = serializers.CharField(max_length=200, required=False, allow_blank=True)
    tenant = serializers.CharField(
        max_length=200,
        required=False,
        allow_blank=True,
        help_text="Ignored: the title block names the session's tenant.",
    )
    filters = serializers.CharField(max_length=500, required=False, allow_blank=True)
    generated_at = serializers.DateTimeField(required=False, allow_null=True)


class TopologyPdfRequestSerializer(serializers.Serializer):
    svg = serializers.CharField(trim_whitespace=False, max_length=MAX_SVG_BYTES)
    title = serializers.CharField(max_length=200, required=False, allow_blank=True)
    paper = _PaperSerializer(required=False)
    meta = _MetaSerializer(required=False)
    title_block = serializers.BooleanField(required=False, default=True)


def _detail(msg: str, status: int) -> Response:
    return Response({"detail": msg}, status=status)


def _gate(request):
    """(tenant, None) when the caller may export the map, else (None, 403)."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, _detail("No active tenant.", 403)
    if rbac.row_filter(request.user, tenant, "device", "view") is None:
        return None, _detail("device.view required.", 403)
    return tenant, None


def _file_name(title: str, when: dt.datetime) -> str:
    slug = slugify(title)[:60].strip("-") or "topology"
    return f"{slug}-{when.astimezone(dt.UTC):%Y-%m-%d}.pdf"


def _cache_key(user_id, tenant_id, token: str) -> str:
    return f"topology-pdf:{user_id}:{tenant_id}:{token}"


def _flag(request, name: str) -> bool:
    return str(request.query_params.get(name, "")).lower() in ("1", "true", "yes")


@extend_schema(
    summary="Topology diagram as a PDF",
    description=(
        "Renders a diagram SVG (as the Diagram's SVG export draws it) on one "
        "sheet of A4, A3, Letter or Tabloid, fitted, with a title block. The "
        "SVG is sanitized to an allowlist; at most 8 MB and 60,000 elements, "
        "the request at most 10 MB. `?print=1` returns `{url}`: a link to the "
        "PDF for five minutes, for the same user and tenant."
    ),
    tags=["topology"],
    parameters=[
        OpenApiParameter(
            name="print",
            type=OpenApiTypes.BOOL,
            location=OpenApiParameter.QUERY,
            description="Answer with a short-lived link instead of the file.",
        ),
    ],
    request=TopologyPdfRequestSerializer,
    responses={
        (200, "application/pdf"): OpenApiTypes.BINARY,
        (200, "application/json"): inline_serializer(
            name="TopologyPdfLink", fields={"url": serializers.CharField()}
        ),
        400: OpenApiResponse(description="Invalid request or SVG."),
        403: OpenApiResponse(description="No tenant or no device.view."),
        413: OpenApiResponse(description="Over a size or element cap."),
        429: OpenApiResponse(description="A PDF for this user is being made."),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def topology_pdf_view(request):
    tenant, denied = _gate(request)
    if denied:
        return denied
    try:
        length = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    if length > MAX_BODY_BYTES:
        return _detail("The request is over 10 MB.", 413)
    ser = TopologyPdfRequestSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    paper = data.get("paper") or {}
    meta = data.get("meta") or {}
    title = (data.get("title") or meta.get("view") or "").strip() or "Topology"
    generated = meta.get("generated_at") or timezone.now()

    lock = f"topology-pdf-busy:{request.user.pk}"
    try:
        locked = cache.add(lock, 1, RENDER_LOCK_TTL)
    except Exception:  # noqa: BLE001 - no cache: render without the lock
        locked = None
    if locked is False:
        return _detail("A PDF is already being made.", 429)
    try:
        try:
            svg = sanitize_svg(data["svg"])
        except SvgRejected as exc:
            return _detail(str(exc), exc.status)
        pdf = render_topology_pdf(
            svg,
            title=title,
            tenant=tenant.name,
            filters=(meta.get("filters") or "").strip(),
            generated=generated,
            paper=paper.get("size", "a3"),
            orientation=paper.get("orientation", "landscape"),
            title_block=data.get("title_block", True),
        )
    finally:
        if locked:
            try:
                cache.delete(lock)
            except Exception:  # noqa: BLE001, S110 - it expires on its own
                pass

    name = _file_name(title, generated)
    if _flag(request, "print"):
        if len(pdf) > MAX_PDF_BYTES:
            return _detail("The PDF is too large to keep for printing.", 413)
        token = secrets.token_urlsafe(32)
        cache.set(
            _cache_key(request.user.pk, tenant.pk, token),
            {"pdf": pdf, "name": name},
            PRINT_TTL,
        )
        return Response({"url": reverse("topology-export-pdf-file", kwargs={"token": token})})
    resp = HttpResponse(pdf, content_type="application/pdf")
    resp["Content-Disposition"] = f'attachment; filename="{name}"'
    resp["Cache-Control"] = "private, no-store"
    return resp


@extend_schema(
    summary="A topology PDF made with ?print=1",
    description=(
        "The PDF behind a print link, for five minutes, to the user and tenant "
        "that made it; inline, or as a download with `?download=1`."
    ),
    tags=["topology"],
    parameters=[
        OpenApiParameter(
            name="download",
            type=OpenApiTypes.BOOL,
            location=OpenApiParameter.QUERY,
            description="Save the file instead of opening it.",
        ),
    ],
    responses={
        (200, "application/pdf"): OpenApiTypes.BINARY,
        404: OpenApiResponse(description="No such link for this user and tenant."),
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_pdf_file_view(request, token):
    tenant = _get_active_tenant(request)
    if (
        tenant is None
        or not _TOKEN.match(token)
        or rbac.row_filter(request.user, tenant, "device", "view") is None
    ):
        return _detail("Not found.", 404)
    entry = cache.get(_cache_key(request.user.pk, tenant.pk, token))
    if not isinstance(entry, dict) or not isinstance(entry.get("pdf"), bytes):
        return _detail("Not found.", 404)
    resp = HttpResponse(entry["pdf"], content_type="application/pdf")
    how = "attachment" if _flag(request, "download") else "inline"
    resp["Content-Disposition"] = f'{how}; filename="{entry["name"]}"'
    resp["Cache-Control"] = "private, no-store"
    resp["X-Content-Type-Options"] = "nosniff"
    return resp
