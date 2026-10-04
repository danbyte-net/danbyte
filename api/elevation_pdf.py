"""Rack elevations and cabinet plates as PDF (#248, #277):
``POST /api/racks/{id}/export/pdf/`` and ``POST /api/cabinets/{id}/export/pdf/``.

The page draws the rack's faces, or the cabinet's plate, as an SVG
(``frontend/src/lib/elevation/``, the same drawing as the SVG export) and
posts it with the paper; ``api/drawing_pdf.py`` sanitizes it and lays it out
on one sheet, under the same caps, render slots and deadline as the topology
map's PDF. The viewset's ``get_object`` finds the object first - tenant and
permissions as on its page - and the title block is written here, from it,
never from the request: the name; the site, the location, the type and the
units used and free (a rack) or the plate's size (a cabinet); the date, the
Danbyte version and the page.

``?print=1`` answers with ``{url}``, ``GET /api/{racks|cabinets}/{id}/export/
pdf/<token>/``: the PDF for five minutes, to the same user in the same tenant
while they may still see the object. A user keeps one per tenant and kind: a
newer one replaces it.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass

from django.http import HttpResponse
from django.urls import reverse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.response import Response

from .capacity import rack_space
from .drawing_pdf import (
    MAX_BODY_BYTES,
    RENDER_TIMEOUT,
    DrawingPaperSerializer,
    RenderTimeout,
    body_too_large,
    deliver,
    detail,
    file_name,
    kept_pdf,
    render_guarded,
    render_pdf,
    run_with_deadline,
)
from .svg_sanitize import MAX_SVG_BYTES, sanitize_svg

log = logging.getLogger(__name__)


def _type_name(t) -> str:
    """A rack or cabinet type as its page names it: maker, then model."""
    if t is None:
        return ""
    maker = t.manufacturer.name if t.manufacturer_id else ""
    return f"{maker} {t.name}".strip()


def _where(obj) -> list[str]:
    return [obj.site.name, obj.location.name if obj.location_id else ""]


def rack_title(rack) -> tuple[str, str]:
    """The rack's title block: its name, then its site, location, type and
    the units used and free - counted over every device in it, as its page
    counts them."""
    space = rack_space(rack)
    parts = [
        *_where(rack),
        _type_name(rack.rack_type),
        f"{space['u_used']} U used",
        f"{space['u_free']} U free",
    ]
    return rack.name, " · ".join(p for p in parts if p)


def cabinet_title(cabinet) -> tuple[str, str]:
    """The cabinet's title block: its name, then its site, location, type
    and the size of its mounting plate."""
    parts = [
        *_where(cabinet),
        _type_name(cabinet.cabinet_type),
        f"Plate {cabinet.inner_width_mm} × {cabinet.inner_height_mm} mm",
    ]
    return cabinet.name, " · ".join(p for p in parts if p)


@dataclass(frozen=True)
class Kind:
    """What differs between a rack's PDF and a cabinet's."""

    title: Callable[[object], tuple[str, str]]
    # The paper when the request names none: portrait for a rack, which is
    # tall, landscape for a cabinet.
    size: str
    orientation: str
    # After the name in the file name: `r12-elevation-2026-10-02.pdf`.
    suffix: str
    label: str


KINDS = {
    "rack": Kind(rack_title, "a4", "portrait", "elevation", "Rack"),
    "cabinet": Kind(cabinet_title, "a4", "landscape", "plate", "Cabinet"),
}


class ElevationPdfRequestSerializer(serializers.Serializer):
    svg = serializers.CharField(
        trim_whitespace=False,
        max_length=MAX_SVG_BYTES,
        help_text="The drawing, as the page's SVG export draws it.",
    )
    paper = DrawingPaperSerializer(
        required=False,
        help_text="A4 portrait for a rack and A4 landscape for a cabinet when absent.",
    )
    title_block = serializers.BooleanField(required=False, default=True)


class DrawingPdfLinkSerializer(serializers.Serializer):
    url = serializers.CharField()


def _print_key(kind: str, user_id, tenant_id) -> str:
    """The one print PDF a user keeps per tenant and kind; its token, and
    the object it draws, are inside."""
    return f"{kind}-pdf-print:{user_id}:{tenant_id}"


def _render(svg: bytes, **kwargs) -> bytes:
    # Looked up when called, so the child renders what this module names.
    return render_pdf(svg, **kwargs)


def render_with_deadline(svg: bytes, *, timeout: float = RENDER_TIMEOUT, **kwargs) -> bytes:
    """:func:`api.drawing_pdf.render_pdf` in a forked child, stopped after
    ``timeout`` seconds."""
    return run_with_deadline(_render, svg, timeout=timeout, **kwargs)


def export_pdf(request, obj, kind: str) -> HttpResponse | Response:
    """``obj`` - a rack or a cabinet the caller may view - drawn as the
    posted SVG on one sheet, its title block written from ``obj``."""
    spec = KINDS[kind]
    if body_too_large(request, MAX_BODY_BYTES):
        return detail("The request is over 10 MB.", 413)
    ser = ElevationPdfRequestSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    paper = data.get("paper") or {}
    title, subtitle = spec.title(obj)
    # The server's clock: the date on paper is when the PDF was made.
    generated = timezone.now()

    def render(svg: bytes) -> bytes:
        return render_with_deadline(
            svg,
            title=title,
            subtitle=subtitle,
            generated=generated,
            paper=paper.get("size", spec.size),
            orientation=paper.get("orientation", spec.orientation),
            title_block=data["title_block"],
        )

    try:
        pdf = render_guarded(request, data["svg"], sanitize=sanitize_svg, render=render)
    except RenderTimeout:
        log.warning(
            "%s PDF for user %s stopped after %ss", spec.label, request.user.pk, RENDER_TIMEOUT
        )
        return detail("The drawing took too long to render.", 413)
    if isinstance(pdf, Response):
        return pdf
    return deliver(
        request,
        pdf,
        name=file_name(f"{obj.name} {spec.suffix}", generated, kind),
        key=_print_key(kind, request.user.pk, obj.tenant_id),
        link=lambda token: reverse(
            f"{kind}-export-pdf-file", kwargs={"pk": str(obj.pk), "token": token}
        ),
        label=spec.label,
        extra={"object": str(obj.pk)},
    )


def export_pdf_file(request, obj, kind: str, token: str) -> HttpResponse | Response:
    """The PDF behind a print link for ``obj``, to the user who made it."""
    return kept_pdf(
        request,
        token,
        key=_print_key(kind, request.user.pk, obj.tenant_id),
        match={"object": str(obj.pk)},
    )


# ─── Schema ─────────────────────────────────────────────────────────────────

_WHAT = {"rack": "rack's elevation", "cabinet": "cabinet's plate"}


def pdf_schema(kind: str):
    """``extend_schema`` for a viewset's ``export/pdf/`` action."""
    block = (
        "site, location, type and the units used and free"
        if kind == "rack"
        else "site, location, type and the plate's size"
    )
    paper = "A4 portrait" if KINDS[kind].orientation == "portrait" else "A4 landscape"
    return extend_schema(
        summary=f"The {_WHAT[kind]} as a PDF",
        description=(
            f"Renders the {_WHAT[kind]} SVG (as the page's SVG export draws it) on "
            f"one sheet of A4, A3, Letter or Tabloid ({paper} by default), fitted, "
            f"with a title block written on the server from the {kind}: its name; "
            f"its {block}; the date, the Danbyte version and the page. Needs view on "
            f"the {kind}. The SVG is sanitized as the topology PDF's is, under the "
            "same limits: at most 8 MB, 60,000 elements and 80,000 characters of "
            "text as rendered, the request at most 10 MB, the render at most 30 "
            "seconds. `?print=1` returns `{url}`: a link to the PDF for five "
            "minutes, for the same user and tenant; a newer one replaces it."
        ),
        parameters=[
            OpenApiParameter(
                name="print",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                description="Answer with a short-lived link instead of the file.",
            ),
        ],
        request=ElevationPdfRequestSerializer,
        responses={
            (200, "application/pdf"): OpenApiTypes.BINARY,
            (200, "application/json"): DrawingPdfLinkSerializer,
            400: OpenApiResponse(description="Invalid request or SVG."),
            403: OpenApiResponse(description=f"No view on {kind}s."),
            404: OpenApiResponse(description=f"No such {kind} for this user and tenant."),
            413: OpenApiResponse(description="Over a cap, or too slow to render."),
            429: OpenApiResponse(
                description=(
                    "A PDF for this user is being made, or as many as the server makes at once."
                )
            ),
            503: OpenApiResponse(description="The print link could not be kept."),
        },
    )


def pdf_file_schema(kind: str):
    """``extend_schema`` for a viewset's ``export/pdf/<token>/`` action."""
    return extend_schema(
        summary=f"A {kind} PDF made with ?print=1",
        description=(
            "The PDF behind a print link, for five minutes, to the user and tenant "
            f"that made it while they may view the {kind}, until they make another; "
            "inline, or as a download with `?download=1`."
        ),
        parameters=[
            OpenApiParameter(
                name="token",
                type=OpenApiTypes.STR,
                location=OpenApiParameter.PATH,
                description="The print link's token.",
            ),
            OpenApiParameter(
                name="download",
                type=OpenApiTypes.BOOL,
                location=OpenApiParameter.QUERY,
                description="Save the file instead of opening it.",
            ),
        ],
        request=None,
        responses={
            (200, "application/pdf"): OpenApiTypes.BINARY,
            404: OpenApiResponse(description="No such link for this user, tenant and object."),
            503: OpenApiResponse(description="Print links are unavailable right now."),
        },
    )
