"""The table of contents, with page numbers, and the PDF's bookmarks.

WeasyPrint resolves ``target-counter(attr(href), page)`` when it lays the
pages out, so the contents page needs no second pass: each entry is a link
to its heading's anchor and prints that heading's page. Chapters (``h1``)
and sections (``h2``) go in the table; every one of them, and anything else
a report marks (``bookmark-level``), goes in the PDF's outline.
"""

from __future__ import annotations

from dataclasses import dataclass
from html import escape


@dataclass(frozen=True)
class TocEntry:
    anchor: str
    title: str
    level: int = 1
    number: str = ""


TOC_CSS = (
    "section.toc{break-after:page}"
    "section.toc h1{font-size:15pt;font-weight:700;margin:0 0 5mm}"
    "section.toc ol{list-style:none;margin:0;padding:0}"
    "section.toc li{margin:0;padding:1.1mm 0;border-bottom:0.15mm solid #e4e4e7}"
    "section.toc li.l1{font-size:9pt;font-weight:600;padding-top:2.2mm}"
    "section.toc li.l2{font-size:8pt;padding-left:7mm;color:#3f3f46}"
    "section.toc a{color:inherit;text-decoration:none;display:block}"
    "section.toc a::after{content:leader('.') target-counter(attr(href), page);"
    "color:#71717a;font-weight:400}"
    "section.toc .no{display:inline-block;min-width:7mm;color:#71717a}"
    # Only chapters and sections are bookmarks, not every heading.
    "h1,h2,h3,h4,h5,h6{bookmark-level:none}"
    "h1.chapter{bookmark-level:1}"
    "h2.section{bookmark-level:2}"
)


def toc_html(entries: list[TocEntry], title: str = "Contents") -> str:
    """The contents page for ``entries``; "" for none."""
    if not entries:
        return ""
    rows = []
    for e in entries:
        no = f"<span class='no'>{escape(e.number)}</span>" if e.number else ""
        rows.append(
            f"<li class='l{e.level}'><a href='#{escape(e.anchor)}'>{no}{escape(e.title)}</a></li>"
        )
    return f"<section class='toc'><h1>{escape(title)}</h1><ol>{''.join(rows)}</ol></section>"
