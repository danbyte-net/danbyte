"""Drawings as PDF: one sheet of real paper, with a title block.

The browser draws a drawing as an SVG - the topology map
(``frontend/src/lib/diagram/svg.ts``), a rack's elevation or a cabinet's
plate (``frontend/src/lib/elevation/``), each the same drawing as its SVG
export - and posts it to that drawing's endpoint: ``api/topology_export.py``
and ``api/elevation_pdf.py``. This is what they share. The SVG is sanitized
(``api/svg_sanitize.py``) and laid out with WeasyPrint on one sheet of paper:
the drawing fitted to the printable area, under it a title block whose text
the endpoint writes on the server - a title, a line about it, then the date,
the Danbyte version and the page. A browser can't be made to print at a paper
size - ``@page`` is advisory and the print dialog wins - so the size is baked
into a PDF, as for labels and spec sheets.

WeasyPrint reads nothing from the network or the disk on the caller's
behalf: its URL fetcher serves the posted drawing from memory, decodes
``data:`` URIs, reads device-type photos from ``MEDIA_ROOT`` (public images,
#227) and the vendored Inter faces in ``api/pdf_fonts/`` (SIL OFL, static
instances of the app's variable Inter so every weight embeds), and refuses
everything else.

Rendering is bounded three ways, whatever the drawing: the sanitizer's caps
(what a drawing may cost as rendered), one render per user and
``RENDER_SLOTS`` across the deployment at a time (the cache counts them), and
a hard deadline - the render runs in a forked child that is killed after
``RENDER_TIMEOUT`` seconds, well inside gunicorn's worker timeout.

``?print=1`` keeps the PDF in the cache for five minutes and answers with a
link that only the same user in the same tenant can open - inline, so the
browser's viewer prints it; ``?download=1`` saves it instead. A user keeps
one such PDF per tenant and kind of drawing: a new one replaces the last, and
its link stops working.
"""

from __future__ import annotations

import datetime as dt
import logging
import mimetypes
import multiprocessing
import re
import secrets
import unicodedata
from collections.abc import Callable
from functools import lru_cache
from html import escape
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import DataHandler, Request, url2pathname

from django.conf import settings
from django.core.cache import cache
from django.http import HttpResponse
from django.utils import timezone
from django.utils._os import safe_join
from rest_framework import serializers
from rest_framework.response import Response

from .svg_sanitize import SvgRejected

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
# CSS px → mm at 96 dpi; a small drawing is enlarged to at most 1.5x that.
PX_MM = 25.4 / 96
MAX_SCALE = 1.5 * PX_MM

# The whole request, and the finished PDF kept for a print link.
MAX_BODY_BYTES = 10 * 1024 * 1024
MAX_PDF_BYTES = 48 * 1024 * 1024
PRINT_TTL = 300
# A render is killed past this many seconds (gunicorn's timeout is 60).
RENDER_TIMEOUT = 30
# Renders at once across the deployment, and one per user; the locks
# outlive a render that never released them.
RENDER_SLOTS = 2
RENDER_LOCK_TTL = RENDER_TIMEOUT + 60
# The locks' cache keys, shared by every kind of drawing. They keep the
# names they had when the topology was the only drawing, so a deploy in the
# middle of a render still counts the locks it holds.
BUSY_KEY = "topology-pdf-busy:{}"
SLOT_KEY = "topology-pdf-slot:{}"

log = logging.getLogger(__name__)

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

TOKEN = re.compile(r"^[A-Za-z0-9_-]{24,64}$")


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
def font_files() -> dict[str, Path]:
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
def font_bytes(path: str) -> bytes:
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
            if str(p) in font_files():
                faces.append(
                    f'@font-face{{font-family:"Inter";font-style:normal;'
                    f'font-weight:{weight};src:url("{p.as_uri()}");'
                    f"unicode-range:{urange}}}"
                )
    return "".join(faces)


def stamp(when: dt.datetime) -> str:
    """``2026-09-26 12:00 UTC``: when a sheet was made, as it prints."""
    return when.astimezone(dt.UTC).strftime("%Y-%m-%d %H:%M UTC")


def sheet_html(
    plan: dict,
    *,
    title: str,
    subtitle: str,
    generated: dt.datetime,
    title_block: bool,
) -> str:
    """The page WeasyPrint lays out: the drawing where ``plan`` puts it and,
    with ``title_block``, the block in the bottom-right corner - the title,
    the subtitle, then the date, the Danbyte version and the page."""
    from danbyte import __version__

    pw, ph = plan["page"]
    ax, ay, aw, ah = plan["area"]
    x, y, w, h = plan["at"]
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    block = ""
    if title_block:
        small = " · ".join((stamp(generated), f"Danbyte {__version__}", "Page 1 / 1"))
        block = (
            '<div class="block">'
            f'<div class="t">{escape(title)}</div>'
            f'<div class="s">{escape(subtitle)}</div>'
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
            if path not in font_files():
                raise ValueError("Only the vendored fonts are readable.")
            return _response(url, font_bytes(path), "font/ttf")
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


# ─── Rendering ──────────────────────────────────────────────────────────────


class RenderTimeout(Exception):
    """The render ran past its deadline and was stopped."""


def _render_child(conn, render: Callable[..., bytes], svg: bytes, kwargs: dict) -> None:
    """The forked renderer: the PDF, or why not, back through ``conn``."""
    try:
        conn.send((True, render(svg, **kwargs)))
    except BaseException as exc:  # noqa: BLE001 - reported to the parent
        conn.send((False, f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def run_with_deadline(
    render: Callable[..., bytes], svg: bytes, *, timeout: float = RENDER_TIMEOUT, **kwargs
) -> bytes:
    """``render(svg, **kwargs)`` in a forked child that is killed after
    ``timeout`` seconds (:class:`RenderTimeout`), so no drawing holds a web
    worker until gunicorn kills it. WeasyPrint and the unpacked fonts are
    loaded here first and the child inherits them. Without ``fork`` (not
    Linux) it renders in place."""
    import weasyprint  # noqa: F401 - loaded once per worker, not per child

    for path in font_files():
        font_bytes(path)
    if "fork" not in multiprocessing.get_all_start_methods():
        return render(svg, **kwargs)
    ctx = multiprocessing.get_context("fork")
    recv, send = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_render_child, args=(send, render, svg, kwargs))
    proc.start()
    send.close()
    try:
        if not recv.poll(timeout):
            raise RenderTimeout
        ok, payload = recv.recv()
    except EOFError as exc:
        raise RuntimeError("The PDF renderer stopped without an answer.") from exc
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join(5)
        recv.close()
    if not ok:
        raise RuntimeError(payload)
    return payload


def render_pdf(
    svg: bytes,
    *,
    title: str,
    subtitle: str = "",
    generated: dt.datetime | None = None,
    paper: str = "a3",
    orientation: str = "landscape",
    title_block: bool = True,
) -> bytes:
    """A sanitized drawing on one sheet of ``paper``, as PDF bytes."""
    import weasyprint

    w, h = svg_size(svg)
    plan = plan_sheet(w, h, paper, orientation, title_block)
    html = sheet_html(
        plan,
        title=title,
        subtitle=subtitle,
        generated=generated or timezone.now(),
        title_block=title_block,
    )
    return weasyprint.HTML(
        string=html, base_url=BASE_URL, url_fetcher=PdfUrlFetcher(svg)
    ).write_pdf()


# ─── Endpoints ──────────────────────────────────────────────────────────────


class DrawingPaperSerializer(serializers.Serializer):
    """The paper; each kind of drawing has its own default."""

    size = serializers.ChoiceField(choices=list(PAPERS_MM), required=False)
    orientation = serializers.ChoiceField(choices=ORIENTATIONS, required=False)


def detail(msg: str, status: int) -> Response:
    return Response({"detail": msg}, status=status)


def flag(request, name: str) -> bool:
    return str(request.query_params.get(name, "")).lower() in ("1", "true", "yes")


def body_too_large(request, limit: int) -> bool:
    """The request says it is over ``limit`` bytes - refused before its body
    is read."""
    try:
        length = int(request.META.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    return length > limit


# Letters with no accent to strip, as the names people read them by.
_FOLD = str.maketrans(
    {
        "ø": "o",
        "Ø": "o",
        "æ": "ae",
        "Æ": "ae",
        "œ": "oe",
        "Œ": "oe",
        "ß": "ss",
        "đ": "d",
        "Đ": "d",
        "ð": "d",
        "Ð": "d",
        "ł": "l",
        "Ł": "l",
        "þ": "th",
        "Þ": "th",
    }
)


def file_slug(title: str, fallback: str) -> str:
    """``title`` as a file name's stem, as the browser names a drawing's
    other exports (``frontend/src/lib/diagram/export-file.ts``
    ``exportFileName``): letters folded to ASCII, anything else a hyphen, at
    most 60 characters. ``København HQ`` → ``kobenhavn-hq``; ``Ethernet1/1``
    → ``ethernet1-1``; ``fallback`` when nothing is left."""
    text = unicodedata.normalize("NFKD", title.translate(_FOLD))
    text = re.sub("[̀-ͯ]", "", text).lower()
    slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:60].rstrip("-")
    return slug or fallback


def file_name(title: str, when: dt.datetime, fallback: str) -> str:
    return f"{file_slug(title, fallback)}-{when.astimezone(dt.UTC):%Y-%m-%d}.pdf"


def take(key: str, ttl: int) -> str | None:
    """A lock in the cache: its token when taken, None when someone holds
    it, "" when there is no cache (the render goes ahead unguarded)."""
    token = secrets.token_hex(8)
    try:
        return token if cache.add(key, token, ttl) else None
    except Exception:  # noqa: BLE001 - no cache: no lock
        return ""


def release(key: str, token: str) -> None:
    if not token:
        return
    try:
        if cache.get(key) == token:
            cache.delete(key)
    except Exception:  # noqa: BLE001, S110 - it expires on its own
        pass


def take_slot() -> tuple[str, str] | None:
    """One of the deployment's RENDER_SLOTS: (key, token), or None when
    every one is taken."""
    for i in range(RENDER_SLOTS):
        key = SLOT_KEY.format(i)
        token = take(key, RENDER_LOCK_TTL)
        if token is not None:
            return key, token
    return None


def render_guarded(
    request,
    svg_text: str,
    *,
    sanitize: Callable[[str], bytes],
    render: Callable[[bytes], bytes],
) -> bytes | Response:
    """The PDF of a posted drawing, made under the locks: the caller's own
    (one at a time per user) and one of the deployment's slots, the drawing
    sanitized inside them. A refusal comes back as its Response - 429 while a
    lock is held, the sanitizer's 400 or 413. :class:`RenderTimeout` reaches
    the caller, the locks given back first."""
    lock = BUSY_KEY.format(request.user.pk)
    mine = take(lock, RENDER_LOCK_TTL)
    if mine is None:
        return detail("A PDF is already being made.", 429)
    slot = None
    try:
        slot = take_slot()
        if slot is None:
            return detail("Other PDFs are being made. Try again in a minute.", 429)
        try:
            svg = sanitize(svg_text)
        except SvgRejected as exc:
            return detail(str(exc), exc.status)
        return render(svg)
    finally:
        if slot:
            release(*slot)
        release(lock, mine)


def deliver(
    request,
    pdf: bytes,
    *,
    name: str,
    key: str,
    link: Callable[[str], str],
    label: str,
    extra: dict | None = None,
) -> HttpResponse | Response:
    """The finished PDF: as a download, or with ``?print=1`` kept in the
    cache under ``key`` (with ``extra``, for :func:`kept_pdf` to match) and
    answered with ``{url: link(token)}``."""
    if flag(request, "print"):
        if len(pdf) > MAX_PDF_BYTES:
            return detail("The PDF is too large to keep for printing.", 413)
        token = secrets.token_urlsafe(32)
        try:
            # One per key: a new print link replaces the last.
            cache.set(key, {**(extra or {}), "token": token, "pdf": pdf, "name": name}, PRINT_TTL)
        except Exception:  # noqa: BLE001 - the cache is down or too slow
            log.warning("%s PDF print link not kept", label, exc_info=True)
            return detail("The PDF could not be kept for its link. Try again in a minute.", 503)
        return Response({"url": link(token)})
    resp = HttpResponse(pdf, content_type="application/pdf")
    resp["Content-Disposition"] = f'attachment; filename="{name}"'
    resp["Cache-Control"] = "private, no-store"
    return resp


def kept_pdf(
    request, token: str, *, key: str, match: dict | None = None
) -> HttpResponse | Response:
    """The PDF a print link names: the one kept under ``key``, when its
    token is ``token`` and it carries ``match``; inline, or as a download
    with ``?download=1``. 404 for anything else, 503 when the cache can't
    say."""
    if not TOKEN.match(token):
        return detail("Not found.", 404)
    try:
        entry = cache.get(key)
    except Exception:  # noqa: BLE001 - the cache is down or too slow
        return detail("Print links are unavailable right now.", 503)
    if (
        not isinstance(entry, dict)
        or not isinstance(entry.get("pdf"), bytes)
        or not isinstance(entry.get("token"), str)
        or not secrets.compare_digest(entry["token"], token)
        or any(entry.get(k) != v for k, v in (match or {}).items())
    ):
        return detail("Not found.", 404)
    resp = HttpResponse(entry["pdf"], content_type="application/pdf")
    how = "attachment" if flag(request, "download") else "inline"
    resp["Content-Disposition"] = f'{how}; filename="{entry["name"]}"'
    resp["Cache-Control"] = "private, no-store"
    resp["X-Content-Type-Options"] = "nosniff"
    return resp
