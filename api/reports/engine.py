"""The report document: one HTML page for WeasyPrint, at real paper size.

Every report kind hands :func:`document_html` its body and a
:class:`ReportContext`; the engine adds the page rules (size, margins), the
running header and footer (the tenant on the top right, the title, date and
version on the bottom left, ``Page n / N`` on the bottom right), the blocks'
CSS (``blocks.py``), and when asked the cover (``cover.py``), chapter
dividers (``divider.py``) and the contents page (``toc.py``). The cover and
the full dividers are named pages without the running header and footer.

A context's ``marking`` (``marking.py``) prints in the top and bottom band
of every page and on the cover and dividers; a report without one is laid
out exactly as before markings existed.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from html import escape

from ..drawing_pdf import PAPERS_MM, _font_faces, stamp
from .blocks import BLOCK_CSS
from .cover import cover_css
from .marking import MARKING_CSS, Marking, page_marking_rules, running_marking

MARGIN_MM = 12.0
BOTTOM_MM = 14.0
INK = "#18181b"

#: The running text's look in the page's margin boxes.
RUNNING_FONT = "font-family:Inter,'DejaVu Sans',sans-serif;font-size:6.5pt;color:#71717a"

#: Headings and the sections of an object report.
PAGE_CSS = (
    "html,body{margin:0;padding:0}"
    f"body{{font-family:Inter,'DejaVu Sans',sans-serif;color:{INK};font-size:7.5pt}}"
    "header{margin-bottom:5mm}"
    "h1{font-size:15pt;font-weight:700;margin:0 0 1.5mm}"
    ".meta{color:#52525b;font-size:7.5pt}"
    ".meta span{margin-right:1mm}"
    ".meta b{font-weight:600;color:#3f3f46}"
    "h2{font-size:11pt;font-weight:700;margin:0 0 3mm;break-after:avoid}"
    "h2 .pill,h2 .tag{font-size:7pt;vertical-align:1.2pt;margin-left:1mm}"
    "h3{font-size:8.5pt;font-weight:600;margin:4.5mm 0 1.5mm;break-after:avoid}"
    "h3 span{font-weight:400;color:#71717a;margin-left:2mm}"
    "section.list,section.summary{margin-bottom:6mm}"
    "section.object{break-before:page}"
    "section.object.first{break-before:auto}"
    ".tags{margin:-1.5mm 0 2mm}"
    ".tags .pill{margin-right:0.8mm}"
)


@dataclass
class ReportContext:
    """What every page of one report shares.

    ``marking`` is the sensitivity label (``marking.Marking`` or its dict
    ``{name, color, text_color, icon_svg}``) the page bands and the cover
    show; None prints none.
    """

    title: str
    tenant: str
    generated: dt.datetime
    paper: str = "a4"
    orientation: str = "portrait"
    marking: Marking | dict | None = None
    #: Extra CSS a kind needs (its named pages, its blocks).
    extra_css: list[str] = field(default_factory=list)

    def __post_init__(self):
        self.marking = Marking.from_dict(self.marking) if self.marking is not None else None

    @property
    def size(self) -> tuple[float, float]:
        return page_size(self.paper, self.orientation)


def page_size(paper: str, orientation: str) -> tuple[float, float]:
    """``(width, height)`` of the sheet in mm."""
    pw, ph = PAPERS_MM[paper]
    if orientation == "portrait":
        pw, ph = ph, pw
    return pw, ph


def css_str(text: str) -> str:
    """``text`` inside a CSS string."""
    return text.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ")


def page_rule(ctx: ReportContext) -> str:
    """The ``@page`` rule: size, margins and the running bands."""
    from danbyte import __version__

    pw, ph = ctx.size
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    running = f"{ctx.title} · {stamp(ctx.generated)} · Danbyte {__version__}"
    font = RUNNING_FONT
    return (
        f"@page{{size:{mm(pw)} {mm(ph)};margin:{mm(MARGIN_MM)} {mm(MARGIN_MM)} {mm(BOTTOM_MM)};"
        f"@top-right{{content:'{css_str(ctx.tenant)}';{font}}}"
        f"@bottom-left{{content:'{css_str(running)}';{font}}}"
        f"@bottom-right{{content:'Page ' counter(page) ' / ' counter(pages);{font}}}"
        f"{page_marking_rules() if ctx.marking else ''}}}"
    )


def document_html(ctx: ReportContext, body: str, *, cover: str = "") -> str:
    """The whole page WeasyPrint lays out: ``cover`` (its HTML, from
    :func:`api.reports.cover.cover_for_request`) first when there is one,
    then ``body``."""
    from danbyte import __version__

    pw, ph = ctx.size
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<title>{escape(ctx.title)}</title>"
        f"<meta name='generator' content='Danbyte {escape(__version__)}'>"
        "<style>"
        f"{_font_faces()}"
        f"{page_rule(ctx)}"
        f"{PAGE_CSS}"
        f"{BLOCK_CSS}"
        f"{cover_css(pw, ph) if cover else ''}"
        f"{MARKING_CSS if ctx.marking else ''}"
        f"{''.join(ctx.extra_css)}"
        "</style></head><body>"
        f"{running_marking(ctx.marking)}"
        f"{cover}{body}"
        "</body></html>"
    )


def render(html: str, url_fetcher=None) -> bytes:
    """``html`` as PDF bytes, reading only what ``url_fetcher`` (by default
    :class:`api.drawing_pdf.PdfUrlFetcher` with no drawing) allows."""
    import weasyprint

    from ..drawing_pdf import BASE_URL, PdfUrlFetcher

    return weasyprint.HTML(
        string=html, base_url=BASE_URL, url_fetcher=url_fetcher or PdfUrlFetcher(b"")
    ).write_pdf()
