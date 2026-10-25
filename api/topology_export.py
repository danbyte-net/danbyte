"""Diagrams as PDF: ``POST /api/diagram/export/pdf/``.

The browser draws a diagram as an SVG (``frontend/src/lib/diagram/svg.ts``,
the same drawing as the SVG export) and posts it here with the paper and
the title block's text. ``api/drawing_pdf.py`` - which renders every
drawing's PDF - sanitizes it and lays it out with WeasyPrint on one sheet of
real paper: the drawing fitted to the printable area, under it a title block
with the view, the tenant, the filters, the date, the Danbyte version and the
page. There, too: what WeasyPrint may read, the caps, the render slots, the
deadline and the print links.

``kind`` says which diagram it is (:data:`DIAGRAM_KINDS`): ``topology``
(the default) needs ``device.view``, ``application-flows`` (#163)
``applicationflow.view``. ``POST /api/topology/export/pdf/`` is the same
endpoint, kept for the topology.

``?print=1`` keeps the PDF in the cache for five minutes and answers with a
link, ``GET /api/topology/export/pdf/<token>/`` for the topology,
``/api/diagram/export/pdf/<token>/?kind=<kind>`` for the others, that only
the same user in the same tenant can open - inline, so the browser's viewer
prints it; add ``?download=1`` to save it instead. A user keeps one such PDF
per kind and tenant: a new one replaces the last, and its link stops working.
"""

from __future__ import annotations

import datetime as dt
import logging

from django.core.cache import cache  # noqa: F401 - the print links' store
from django.urls import reverse
from django.utils import timezone
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

from .drawing_pdf import (  # noqa: F401 - the sheet's names, as this module always had them
    BASE_URL,
    DIAGRAM_URL,
    FONT_DIR,
    FONT_RANGES,
    FONT_WEIGHTS,
    GAP_MM,
    MARGIN_MM,
    MAX_BODY_BYTES,
    MAX_MEDIA_BYTES,
    MAX_PDF_BYTES,
    MAX_SCALE,
    MEDIA_IMAGES_URL,
    ORIENTATIONS,
    PAPERS_MM,
    PRINT_TTL,
    PX_MM,
    RENDER_LOCK_TTL,
    RENDER_SLOTS,
    RENDER_TIMEOUT,
    TITLE_MM,
    TITLE_W_MM,
    PdfUrlFetcher,
    RenderTimeout,
    body_too_large,
    deliver,
    detail,
    file_name,
    file_slug,
    kept_pdf,
    plan_sheet,
    render_guarded,
    render_pdf,
    run_with_deadline,
    sheet_html,
    svg_size,
)
from .drawing_pdf import font_files as _font_files  # noqa: F401
from .svg_sanitize import MAX_SVG_BYTES, sanitize_svg
from .views import _get_active_tenant

log = logging.getLogger(__name__)


# ─── The sheet ──────────────────────────────────────────────────────────────


def _sheet_html(
    plan: dict,
    *,
    title: str,
    tenant: str,
    filters: str,
    generated: dt.datetime,
    title_block: bool,
) -> str:
    """The topology's sheet: the tenant and the filters under the title."""
    return sheet_html(
        plan,
        title=title,
        subtitle=" · ".join(s for s in (tenant, filters) if s),
        generated=generated,
        title_block=title_block,
    )


def _render(svg: bytes, **kwargs) -> bytes:
    # Looked up when called, so the child renders what this module names.
    return render_topology_pdf(svg, **kwargs)


def render_with_deadline(svg: bytes, *, timeout: float = RENDER_TIMEOUT, **kwargs) -> bytes:
    """:func:`render_topology_pdf` in a forked child that is killed after
    ``timeout`` seconds (:class:`RenderTimeout`) - see
    :func:`api.drawing_pdf.run_with_deadline`."""
    return run_with_deadline(_render, svg, timeout=timeout, **kwargs)


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
    return render_pdf(
        svg,
        title=title,
        subtitle=" · ".join(s for s in (tenant, filters) if s),
        generated=generated,
        paper=paper,
        orientation=orientation,
        title_block=title_block,
    )


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
    generated_at = serializers.DateTimeField(
        required=False,
        allow_null=True,
        help_text="Ignored: the title block is stamped with the server's time.",
    )


#: The diagrams this endpoint renders: ``kind`` → (the object type whose
#: view permission it needs, the file name's stem when the title leaves
#: none, the title when none is given).
DIAGRAM_KINDS: dict[str, tuple[str, str, str]] = {
    "topology": ("device", "topology", "Topology"),
    # An application's flows (#163).
    "application-flows": ("applicationflow", "application-flows", "Application flows"),
}


class TopologyPdfRequestSerializer(serializers.Serializer):
    kind = serializers.ChoiceField(choices=list(DIAGRAM_KINDS), default="topology")
    svg = serializers.CharField(trim_whitespace=False, max_length=MAX_SVG_BYTES)
    title = serializers.CharField(max_length=200, required=False, allow_blank=True)
    paper = _PaperSerializer(required=False)
    meta = _MetaSerializer(required=False)
    title_block = serializers.BooleanField(required=False, default=True)


_detail = detail


def _kind_of(data) -> str | None:
    """The request's diagram kind - ``topology`` when it names none, None
    when it names one this endpoint does not know."""
    raw = data.get("kind") if hasattr(data, "get") else None
    kind = str(raw or "topology")
    return kind if kind in DIAGRAM_KINDS else None


def _gate(request, kind: str = "topology"):
    """(tenant, None) when the caller may export the ``kind`` diagram, else
    (None, 403): it needs view on the kind's object type."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return None, _detail("No active tenant.", 403)
    perm = DIAGRAM_KINDS[kind][0]
    if rbac.row_filter(request.user, tenant, perm, "view") is None:
        return None, _detail(f"{perm}.view required.", 403)
    return tenant, None


def _file_slug(title: str, kind: str = "topology") -> str:
    """``title`` as a file name's stem, as the map's other exports are named
    in the browser - :func:`api.drawing_pdf.file_slug`, the kind's stem
    (``topology``) when nothing is left."""
    return file_slug(title, DIAGRAM_KINDS[kind][1])


def _file_name(title: str, when: dt.datetime, kind: str = "topology") -> str:
    return file_name(title, when, DIAGRAM_KINDS[kind][1])


def _print_key(user_id, tenant_id, kind: str = "topology") -> str:
    """The one print PDF a user keeps per kind and tenant; its token is
    inside. The topology's key is the one it always had."""
    if kind == "topology":
        return f"topology-pdf-print:{user_id}:{tenant_id}"
    return f"diagram-pdf-print:{kind}:{user_id}:{tenant_id}"


def _print_link(kind: str, token: str) -> str:
    if kind == "topology":
        return reverse("topology-export-pdf-file", kwargs={"token": token})
    return reverse("diagram-export-pdf-file", kwargs={"token": token}) + f"?kind={kind}"


@extend_schema(
    summary="A diagram as a PDF",
    description=(
        "Renders a diagram SVG (as the diagram's SVG export draws it) on one "
        "sheet of A4, A3, Letter or Tabloid, fitted, with a title block "
        "stamped with the server's time. The SVG is sanitized to an "
        "allowlist; at most 8 MB, 60,000 elements and 80,000 characters of "
        "text as rendered (a reused part counts each time it is drawn), the "
        "request at most 10 MB, the render at most 30 seconds. `?print=1` "
        "returns `{url}`: a link to the PDF for five minutes, for the same "
        "user and tenant; a newer one replaces it. `kind` picks the diagram: "
        "`topology` (the default) needs device.view, `application-flows` "
        "applicationflow.view."
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
        403: OpenApiResponse(description="No tenant, or no view on the kind's type."),
        413: OpenApiResponse(description="Over a cap, or too slow to render."),
        429: OpenApiResponse(
            description="A PDF for this user is being made, or as many as the server makes at once."
        ),
        503: OpenApiResponse(description="The print link could not be kept."),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def topology_pdf_view(request):
    kind = _kind_of(request.data)
    if kind is None:
        return _detail("Unknown diagram kind.", 400)
    tenant, denied = _gate(request, kind)
    if denied:
        return denied
    if body_too_large(request, MAX_BODY_BYTES):
        return _detail("The request is over 10 MB.", 413)
    ser = TopologyPdfRequestSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    paper = data.get("paper") or {}
    meta = data.get("meta") or {}
    title = (data.get("title") or meta.get("view") or "").strip() or DIAGRAM_KINDS[kind][2]
    # The server's clock, never the caller's: the date on paper is when
    # the PDF was made.
    generated = timezone.now()

    def render(svg: bytes) -> bytes:
        return render_with_deadline(
            svg,
            title=title,
            tenant=tenant.name,
            filters=(meta.get("filters") or "").strip(),
            generated=generated,
            paper=paper.get("size", "a3"),
            orientation=paper.get("orientation", "landscape"),
            title_block=data.get("title_block", True),
        )

    try:
        pdf = render_guarded(request, data["svg"], sanitize=sanitize_svg, render=render)
    except RenderTimeout:
        log.warning("%s PDF for user %s stopped after %ss", DIAGRAM_KINDS[kind][2],
                    request.user.pk, RENDER_TIMEOUT)
        return _detail(
            "The drawing took too long to render. Export a smaller part of the map.", 413
        )
    if isinstance(pdf, Response):
        return pdf
    return deliver(
        request,
        pdf,
        name=_file_name(title, generated, kind),
        # One per user, kind and tenant: a new print link replaces the last.
        key=_print_key(request.user.pk, tenant.pk, kind),
        link=lambda token: _print_link(kind, token),
        label=DIAGRAM_KINDS[kind][2],
    )


@extend_schema(
    summary="A diagram PDF made with ?print=1",
    description=(
        "The PDF behind a print link, for five minutes, to the user and tenant "
        "that made it, until they make another; inline, or as a download with "
        "`?download=1`."
    ),
    tags=["topology"],
    parameters=[
        OpenApiParameter(
            name="download",
            type=OpenApiTypes.BOOL,
            location=OpenApiParameter.QUERY,
            description="Save the file instead of opening it.",
        ),
        OpenApiParameter(
            name="kind",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            enum=list(DIAGRAM_KINDS),
            description="The diagram the link is for; `topology` when absent.",
        ),
    ],
    responses={
        (200, "application/pdf"): OpenApiTypes.BINARY,
        404: OpenApiResponse(description="No such link for this user and tenant."),
        503: OpenApiResponse(description="Print links are unavailable right now."),
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_pdf_file_view(request, token):
    kind = _kind_of(request.query_params)
    tenant = _get_active_tenant(request)
    if kind is None or tenant is None or rbac.row_filter(
        request.user, tenant, DIAGRAM_KINDS[kind][0], "view"
    ) is None:
        return _detail("Not found.", 404)
    return kept_pdf(request, token, key=_print_key(request.user.pk, tenant.pk, kind))
