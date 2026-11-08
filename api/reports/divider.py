"""Chapter dividers: where a long report's major parts begin.

A **full** divider is a page of its own: a banner across the top third in
the cover's background (the tenant's waves or colour, cropped to the band),
the chapter's number and title in white on it, and under it a one-line
description and an optional *In this chapter* list. A **compact** divider is
the same banner, shorter, at the top of the chapter's first page, for short
chapters. Both are ``<h1 class='chapter'>`` for the table of contents and
the PDF's bookmarks (``toc.py``).

The background is :func:`api.report_background.background` at the band's
size, so it is cached like a cover's and matches it.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
from html import escape

from ..report_background import background
from .cover import STYLES, Look

#: The banner's height: a third of the page, or a short band.
FULL_SHARE = 1 / 3
COMPACT_MM = 22.0
SIDE_MM = 18.6


@dataclass
class Chapter:
    """One chapter: its anchor, number, title, and what it holds."""

    anchor: str
    number: int
    title: str
    description: str = ""
    items: list[str] = field(default_factory=list)


def _band(look: Look, style: str, pw: float, height: float) -> str:
    """The band's background as a ``data:`` URI, "" for none."""
    if style == "default":
        style = look.style
    if style not in STYLES or style == "upload" and look.image_type == "image/svg+xml":
        style = "plain"
    jpeg = background(style, look, pw, height) if style != "none" else None
    if style == "upload" and jpeg is None:
        jpeg = background("waves", look, pw, height)
    if not jpeg:
        return ""
    return f"data:image/jpeg;base64,{base64.b64encode(jpeg).decode()}"


def divider_css(pw: float, ph: float, margin: float, bottom: float) -> str:
    """The rules for both kinds of divider. A full one is its own named
    page, ``divider``, with no margins and no running header or footer."""
    mm = lambda v: f"{v:.3f}mm"  # noqa: E731
    none = "content:none"
    band = ph * FULL_SHARE
    return (
        f"@page divider{{size:{mm(pw)} {mm(ph)};margin:0;"
        f"@top-left{{{none}}}@top-center{{{none}}}@top-right{{{none}}}"
        f"@bottom-left{{{none}}}@bottom-center{{{none}}}@bottom-right{{{none}}}}}"
        f"section.divider{{page:divider;position:relative;width:{mm(pw)};"
        f"height:{mm(ph - 0.5)};overflow:hidden;break-before:page;break-after:page;margin:0}}"
        f"section.divider .band{{position:absolute;left:0;top:0;width:{mm(pw)};"
        f"height:{mm(band)};background:#f4f4f5}}"
        f"section.divider .band img.bg{{position:absolute;left:0;top:0;width:{mm(pw)};"
        f"height:{mm(band)}}}"
        f"section.divider .mark{{position:absolute;right:{mm(SIDE_MM)};top:{mm(SIDE_MM)}}}"
        f"section.divider .head{{position:absolute;left:{mm(SIDE_MM)};right:{mm(SIDE_MM)};"
        f"bottom:{mm(ph - band + 10)}}}"
        "section.divider .num{font-size:12pt;font-weight:700;letter-spacing:0.14em;"
        "text-transform:uppercase;opacity:0.85;margin:0}"
        "section.divider h1.chapter{font-size:34pt;font-weight:800;line-height:1.05;"
        "letter-spacing:-0.03em;margin:2mm 0 0;overflow-wrap:anywhere}"
        "section.divider.dark .head{color:#ffffff}"
        f"section.divider .body{{position:absolute;left:{mm(SIDE_MM)};right:{mm(SIDE_MM)};"
        f"top:{mm(band + 12)}}}"
        "section.divider .desc{font-size:11pt;color:#3f3f46;margin:0 0 6mm}"
        "section.divider .inside{font-size:7pt;font-weight:700;letter-spacing:0.12em;"
        "text-transform:uppercase;color:#71717a;margin:0 0 2mm}"
        "section.divider ul{margin:0;padding:0;list-style:none;font-size:10pt;color:#27272a}"
        "section.divider li{padding:1.2mm 0;border-bottom:0.15mm solid #e4e4e7}"
        # The compact banner runs over the page's margins at the top.
        f"div.chapter-band{{position:relative;height:{mm(COMPACT_MM)};"
        f"margin:0 0 5mm;break-before:page;break-after:avoid;border-radius:0.6mm;"
        "overflow:hidden;background:#f4f4f5}"
        "div.chapter-band.first{break-before:auto}"
        "div.chapter-band img.bg{position:absolute;left:0;top:0;width:100%;height:100%}"
        "div.chapter-band .head{position:absolute;left:5mm;right:5mm;bottom:3.5mm}"
        "div.chapter-band.dark .head{color:#ffffff}"
        "div.chapter-band .num{font-size:7pt;font-weight:700;letter-spacing:0.14em;"
        "text-transform:uppercase;opacity:0.85;margin:0}"
        "div.chapter-band h1.chapter{font-size:16pt;font-weight:800;margin:0.8mm 0 0;"
        "letter-spacing:-0.02em}"
    )


def divider_html(
    chapter: Chapter,
    look: Look,
    pw: float,
    ph: float,
    *,
    background: str = "default",
    marking=None,
) -> str:
    """A full-page divider for ``chapter``."""
    art = _band(look, background, pw, ph * FULL_SHARE)
    dark = bool(art)
    img = f"<img class='bg' src='{art}' alt=''>" if art else ""
    mark = ""
    if marking is not None:
        from .marking import marking_badge

        mark = f"<div class='mark'>{marking_badge(marking)}</div>"
    items = ""
    if chapter.items:
        rows = "".join(f"<li>{escape(i)}</li>" for i in chapter.items)
        items = f"<p class='inside'>In this chapter</p><ul>{rows}</ul>"
    desc = f"<p class='desc'>{escape(chapter.description)}</p>" if chapter.description else ""
    return (
        f"<section class='divider{' dark' if dark else ''}'>"
        f"<div class='band'>{img}</div>{mark}"
        f"<div class='head'><p class='num'>Chapter {chapter.number}</p>"
        f"<h1 class='chapter' id='{escape(chapter.anchor)}'>{escape(chapter.title)}</h1></div>"
        f"<div class='body'>{desc}{items}</div>"
        "</section>"
    )


def compact_html(
    chapter: Chapter,
    look: Look,
    pw: float,
    *,
    first: bool = False,
    background: str = "default",
) -> str:
    """A compact banner for ``chapter``, starting its first page."""
    art = _band(look, background, pw, COMPACT_MM)
    dark = bool(art)
    img = f"<img class='bg' src='{art}' alt=''>" if art else ""
    cls = "chapter-band" + (" first" if first else "") + (" dark" if dark else "")
    return (
        f"<div class='{cls}'>{img}"
        f"<div class='head'><p class='num'>Chapter {chapter.number}</p>"
        f"<h1 class='chapter' id='{escape(chapter.anchor)}'>{escape(chapter.title)}</h1>"
        "</div></div>"
    )
