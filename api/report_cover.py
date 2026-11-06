"""The cover page of a PDF report, shared by the reports that print one.

A cover is its own page at the report's paper size, with no running header
or footer, on a full-page background: the deployment's logo over a thin
translucent rule at the top; in the middle the tenant or project line in
spaced capitals, the title large and heavy, an optional subtitle and who
prepared it; the date at the bottom left and Danbyte with its version at
the bottom right. The text is white on the background, and ink on a cover
with none.

The background is the tenant's (``core.models.TenantSettings``): rolling
waves coloured with its horizon, wave and crest colours, a plain horizon
colour, its own uploaded image, or none (``api/report_background.py`` makes
the JPEG). A report may pick another background, and its title, subtitle
and project line; everything else is the tenant's, so every report in a
tenant matches. Everything is escaped, and an uploaded SVG is sanitised on
upload and again before it renders (``api/svg_sanitize.py``); images reach
WeasyPrint only as ``data:`` URIs.

Use: :func:`cover_css` goes into the report's ``<style>``, and
:func:`cover_html` (or :func:`cover_for_request`) is the first thing in its
``<body>``.
"""

from __future__ import annotations

import base64
import io
import re
from dataclasses import dataclass, replace
from functools import lru_cache
from html import escape
from pathlib import Path
from zoneinfo import ZoneInfo

from django.conf import settings
from django.utils import timezone

from .report_background import DEFAULT_COLORS, background

#: An uploaded cover image: bytes, and pixels of a photo.
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_PIXELS = 6000 * 6000
IMAGE_TYPES = ("image/png", "image/jpeg", "image/svg+xml")
STYLES = ("waves", "plain", "upload", "none")
#: A report's background: ``default`` is the tenant's.
BACKGROUND_CHOICES = ("default", *STYLES)
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
SIDE_MM = 18.6
INK = "#18181b"
_WHITE_LOGO = (
    Path(settings.BASE_DIR) / "frontend" / "dist" / "branding" / "logo-full-white.png",
    Path(settings.BASE_DIR) / "frontend" / "public" / "branding" / "logo-full-white.png",
)

_DATE_FORMATS = {
    "YYYY-MM-DD": "%Y-%m-%d",
    "DD.MM.YYYY": "%d.%m.%Y",
    "DD/MM/YYYY": "%d/%m/%Y",
    "MM/DD/YYYY": "%m/%d/%Y",
    "DD MMM YYYY": "%d %b %Y",
}


class CoverImageRejected(ValueError):
    """An upload that can't be a cover image; the message says why."""


# ─── The tenant's look ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Look:
    style: str = "waves"
    horizon: str = DEFAULT_COLORS[0]
    wave: str = DEFAULT_COLORS[1]
    crest: str = DEFAULT_COLORS[2]
    image: bytes = b""
    image_type: str = ""


def _hex(value: str, fallback: str) -> str:
    return value.lower() if HEX.match(value or "") else fallback


def look_for(tenant, colors: dict | None = None) -> Look:
    """The tenant's cover settings, or the defaults when it has none.
    ``colors`` (``{horizon, wave, crest}``) overrides its colours for one
    report."""
    from core.models import TenantSettings

    row = TenantSettings.objects.filter(tenant=tenant).first() if tenant else None
    look = Look() if row is None else _look(row)
    return with_colors(look, colors)


def with_colors(look: Look, colors: dict | None) -> Look:
    """``look`` with the valid colours of ``colors`` in place of its own."""
    if not colors:
        return look
    keep = {
        k: _hex(colors.get(k) or "", getattr(look, k)) for k in ("horizon", "wave", "crest")
    }
    return replace(look, **keep)


def _look(row) -> Look:
    return Look(
        style=row.report_cover_style if row.report_cover_style in STYLES else "waves",
        horizon=_hex(row.report_cover_horizon, DEFAULT_COLORS[0]),
        wave=_hex(row.report_cover_wave, DEFAULT_COLORS[1]),
        crest=_hex(row.report_cover_crest, DEFAULT_COLORS[2]),
        image=bytes(row.report_cover_image or b""),
        image_type=row.report_cover_image_type or "",
    )


# ─── The uploaded image ─────────────────────────────────────────────────────


def _sniff(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    head = data[:2048].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if head.startswith(b"<?xml") or head.startswith(b"<svg") or b"<svg" in head:
        return "image/svg+xml"
    return ""


def clean_image(data: bytes, content_type: str = "") -> tuple[bytes, str]:
    """``(bytes, mime)`` to store for an upload: a PNG or JPEG that Pillow
    reads as one within the pixel cap, or an SVG rebuilt by the sanitiser.
    Raises :class:`CoverImageRejected` otherwise."""
    if len(data) > MAX_IMAGE_BYTES:
        raise CoverImageRejected(f"The image is over {MAX_IMAGE_BYTES // (1024 * 1024)} MB.")
    if not data:
        raise CoverImageRejected("The file is empty.")
    mime = _sniff(data)
    declared = (content_type or "").split(";")[0].strip().lower()
    if declared == "image/jpg":
        declared = "image/jpeg"
    if not mime or (
        declared and declared not in IMAGE_TYPES and declared != "application/octet-stream"
    ):
        raise CoverImageRejected("Use a PNG, JPEG or SVG image.")
    if declared in IMAGE_TYPES and declared != mime:
        raise CoverImageRejected("The file is not the image type it says it is.")
    if mime == "image/svg+xml":
        from .svg_sanitize import SvgRejected, sanitize_svg

        try:
            return sanitize_svg(data, max_bytes=MAX_IMAGE_BYTES), mime
        except SvgRejected as exc:
            raise CoverImageRejected(str(exc)) from exc
    from PIL import Image

    try:
        img = Image.open(io.BytesIO(data))
        fmt = img.format
        w, h = img.size
        img.verify()
    except Exception as exc:  # noqa: BLE001 - any failure is "not an image"
        raise CoverImageRejected("Not a valid image.") from exc
    if {"image/png": "PNG", "image/jpeg": "JPEG"}[mime] != fmt:
        raise CoverImageRejected("Not a valid image.")
    if w * h > MAX_IMAGE_PIXELS:
        raise CoverImageRejected("The image has too many pixels (at most 36 megapixels).")
    return data, mime


def image_data_uri(look: Look) -> str | None:
    """The tenant's uploaded image as a ``data:`` URI, the SVG sanitised
    again; None when there is none or it no longer passes."""
    if not look.image or look.image_type not in IMAGE_TYPES:
        return None
    data = look.image
    try:
        if look.image_type == "image/svg+xml":
            from .svg_sanitize import sanitize_svg

            data = sanitize_svg(data, max_bytes=MAX_IMAGE_BYTES)
    except ValueError:
        return None
    return f"data:{look.image_type};base64,{base64.b64encode(data).decode()}"


def _uri(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


@lru_cache(maxsize=1)
def _white_wordmark() -> bytes | None:
    for path in _WHITE_LOGO:
        if path.is_file():
            return path.read_bytes()
    return None


def has_branding_logo() -> bool:
    """Whether the deployment has an uploaded login-page logo."""
    from core.models import DeploymentSettings

    try:
        return bool(DeploymentSettings.load().login_logo)
    except Exception:  # noqa: BLE001 - no settings row: the bundled logo
        return False


def logo_data_uri(dark: bool) -> str | None:
    """The logo as a ``data:`` URI: the uploaded branding logo when there
    is one, else Danbyte's wordmark - the white one on a background, the
    colour one on paper. None when none can be read."""
    from core.email import email_logo

    if dark and not has_branding_logo():
        white = _white_wordmark()
        if white:
            return _uri(white, "image/png")
    logo = email_logo()
    return _uri(*logo) if logo else None


# ─── The page ───────────────────────────────────────────────────────────────


@dataclass
class Cover:
    title: str
    project: str = ""
    subtitle: str = ""
    author: str = ""
    date: str = ""
    background: str = "default"
    #: A sensitivity marking (``api/sensitivity.py``): a pill at the top right.
    marking: dict | None = None


def cover_css(pw: float, ph: float) -> str:
    """The cover's rules for the report's ``<style>``: its own page with no
    margins and no running header or footer."""
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    none = "content:none"
    title_pt = 56 if ph >= pw else 46
    return (
        f"@page cover{{size:{mm(pw)} {mm(ph)};margin:0;"
        f"@top-left{{{none}}}@top-center{{{none}}}@top-right{{{none}}}"
        f"@bottom-left{{{none}}}@bottom-center{{{none}}}@bottom-right{{{none}}}}}"
        f"section.cover{{page:cover;position:relative;width:{mm(pw)};height:{mm(ph - 0.5)};"
        "overflow:hidden;break-after:page;margin:0;padding:0;"
        f"font-family:Inter,'DejaVu Sans',sans-serif;color:{INK}}}"
        "section.cover.dark{color:#ffffff}"
        f"section.cover .bg{{position:absolute;left:0;top:0;width:{mm(pw)};height:{mm(ph)}}}"
        "section.cover .art{object-fit:contain}"
        f"section.cover .top{{position:absolute;left:{mm(SIDE_MM)};right:{mm(SIDE_MM)};"
        f"top:{mm(SIDE_MM)};padding-bottom:6mm;border-bottom:0.2mm solid rgba(24,24,27,0.25)}}"
        "section.cover.dark .top{border-bottom-color:rgba(255,255,255,0.35)}"
        "section.cover .top img{height:7.5mm;width:auto;max-width:90mm;display:block}"
        "section.cover .top .word{font-size:16pt;font-weight:800;letter-spacing:0.12em;"
        "line-height:7.5mm}"
        f"section.cover .mid{{position:absolute;left:{mm(SIDE_MM)};right:{mm(SIDE_MM)};"
        f"top:{mm(ph / 2)};transform:translateY(-50%)}}"
        "section.cover .project{font-size:10.5pt;font-weight:700;letter-spacing:0.14em;"
        "text-transform:uppercase;opacity:0.85;margin:0}"
        f"section.cover h1.cover-title{{font-size:{title_pt}pt;font-weight:800;"
        "line-height:1.02;letter-spacing:-0.035em;margin:3.7mm 0 4.4mm;max-width:85%;"
        "overflow-wrap:anywhere}"
        "section.cover .subtitle{font-size:16pt;font-weight:500;opacity:0.9;margin:0;"
        "overflow-wrap:anywhere}"
        "section.cover .author{font-size:11.5pt;opacity:0.85;margin:7.5mm 0 0}"
        "section.cover .author b{font-weight:700}"
        f"section.cover .foot{{position:absolute;left:{mm(SIDE_MM)};right:{mm(SIDE_MM)};"
        f"bottom:{mm(SIDE_MM)};font-size:10.5pt;font-weight:600;opacity:0.85}}"
        "section.cover .foot .made{float:right}"
        f"section.cover .cover-marking{{position:absolute;right:{mm(SIDE_MM)};"
        f"top:{mm(SIDE_MM - 1)};font-size:10pt;padding:1.2mm 3.6mm;border-radius:1.2mm;"
        "letter-spacing:0.1em}"
        "section.cover .cover-marking svg{width:11pt;height:11pt;vertical-align:-2pt;"
        "margin-right:1.8mm}"
    )


def cover_html(cover: Cover, look: Look, pw: float, ph: float, version: str = "") -> str:
    """The cover page, ``pw`` by ``ph`` mm."""
    style = look.style if cover.background == "default" else cover.background
    if style not in STYLES:
        style = "waves"
    art = ""
    if style == "upload" and look.image_type == "image/svg+xml":
        # A drawing is shown whole over the plain colour.
        art = image_data_uri(look) or ""
        style = "plain" if art else "waves"
    elif style == "upload" and not look.image:
        style = "waves"
    jpeg = background(style, look, pw, ph) if style != "none" else None
    if style == "upload" and jpeg is None:
        jpeg = background("waves", look, pw, ph)
    dark = jpeg is not None
    layers = ""
    if jpeg:
        layers += f"<img class='bg' src='{_uri(jpeg, 'image/jpeg')}' alt=''>"
    if art:
        layers += f"<img class='bg art' src='{art}' alt=''>"
    logo = logo_data_uri(dark)
    top = f"<img src='{logo}' alt=''>" if logo else "<div class='word'>DANBYTE</div>"
    lines = [
        f"<p class='project'>{escape(cover.project)}</p>" if cover.project else "",
        f"<h1 class='cover-title'>{escape(cover.title)}</h1>",
        f"<p class='subtitle'>{escape(cover.subtitle)}</p>" if cover.subtitle else "",
        f"<p class='author'>Prepared by <b>{escape(cover.author)}</b></p>" if cover.author else "",
    ]
    made = f"Danbyte {escape(version)}" if version else "Danbyte"
    marking = ""
    if cover.marking:
        from .sensitivity import pill_html

        marking = pill_html(cover.marking, "marking cover-marking")
    return (
        f"<section class='cover cover-{style}{' dark' if dark else ''}'>{layers}"
        f"<div class='top'>{top}</div>{marking}"
        f"<div class='mid'>{''.join(lines)}</div>"
        f"<div class='foot'><span class='made'>{made}</span>"
        f"<span class='date'>{escape(cover.date)}</span></div>"
        "</section>"
    )


# ─── From a request ─────────────────────────────────────────────────────────


def author_of(user) -> str:
    if user is None or not getattr(user, "is_authenticated", False):
        return ""
    return (user.get_full_name() or "").strip() or user.get_username()


def date_for(user, tenant, when=None) -> str:
    """``when`` (now by default) as a date in the reader's date format and
    timezone."""
    from auth_api.user_prefs import datetime_prefs

    when = when or timezone.now()
    try:
        prefs = datetime_prefs(user, tenant)
    except Exception:  # noqa: BLE001 - a broken pref prints the ISO date
        prefs = {}
    try:
        when = when.astimezone(ZoneInfo(prefs.get("timezone") or "UTC"))
    except Exception:  # noqa: BLE001, S110
        pass
    return when.strftime(_DATE_FORMATS.get(prefs.get("date_format"), "%Y-%m-%d"))


def cover_for_request(
    request,
    tenant,
    *,
    title: str,
    pw: float,
    ph: float,
    project: str = "",
    subtitle: str = "",
    background: str = "default",
    when=None,
    marking: dict | None = None,
    colors: dict | None = None,
) -> str:
    """The cover for ``request``'s reader in ``tenant``: their name, their
    date format, the tenant's look - in ``colors`` when the report picks its
    own - and the report's sensitivity ``marking``."""
    from danbyte import __version__

    user = getattr(request, "user", None)
    cover = Cover(
        title=title,
        project=project or getattr(tenant, "name", "") or "",
        subtitle=subtitle,
        author=author_of(user),
        date=date_for(user, tenant, when),
        background=background if background in BACKGROUND_CHOICES else "default",
        marking=marking,
    )
    return cover_html(cover, look_for(tenant, colors), pw, ph, version=__version__)
