"""A report's marking: the sensitivity label every page shows.

A marking is a short label (``Internal``, ``Confidential``…) in its own
colour, with an optional icon. When a report carries one
(``ReportContext.marking``), the page template prints it in the top band of
every page as a square badge, in the bottom band too, and on the cover and
the chapter dividers. Without one, nothing changes on the page.

:func:`marking_for` is the seam the label catalog plugs into: it answers
the marking for a report the request asks for, and answers None until a
catalog fills it in. Callers never build a :class:`Marking` from request
data themselves; only the catalog decides what a page is marked.
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from html import escape

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


@dataclass(frozen=True)
class Marking:
    """A sensitivity label as it prints.

    ``icon_svg`` is the icon's SVG markup (sanitised before it is drawn),
    or "" for none.
    """

    name: str
    color: str = "#52525b"
    text_color: str = "#ffffff"
    icon_svg: str = ""

    @classmethod
    def from_dict(cls, raw) -> Marking | None:
        """A marking from ``{name, color, text_color, icon_svg}``; None for
        anything without a name."""
        if isinstance(raw, Marking):
            return raw
        if not isinstance(raw, dict) or not str(raw.get("name") or "").strip():
            return None
        color = str(raw.get("color") or "")
        text = str(raw.get("text_color") or "")
        return cls(
            name=str(raw["name"]).strip()[:64],
            color=color if _HEX.match(color) else cls.color,
            text_color=text if _HEX.match(text) else cls.text_color,
            icon_svg=str(raw.get("icon_svg") or ""),
        )


def marking_for(request, tenant, options: dict | None = None) -> Marking | None:
    """The marking a report made for ``request`` in ``tenant`` carries.

    None until the label catalog provides one. ``options`` is the report's
    validated options, for a catalog that lets the reader pick a label.
    """
    return None


def _icon_uri(marking: Marking) -> str:
    """The icon as a ``data:`` URI, sanitised; "" when there is none or it
    does not pass."""
    if not marking.icon_svg:
        return ""
    from ..svg_sanitize import sanitize_svg

    try:
        svg = sanitize_svg(marking.icon_svg.encode(), max_bytes=64 * 1024)
    except ValueError:
        return ""
    return f"data:image/svg+xml;base64,{base64.b64encode(svg).decode()}"


def marking_badge(marking: Marking, cls: str = "") -> str:
    """The marking as a square badge: its icon, then its name."""
    icon = _icon_uri(marking)
    img = f"<img src='{icon}' alt=''>" if icon else ""
    return (
        f"<span class='marking{(' ' + cls) if cls else ''}' "
        f"style='background:{marking.color};color:{marking.text_color}'>"
        f"{img}{escape(marking.name)}</span>"
    )


#: The badge's look, wherever it prints.
MARKING_CSS = (
    ".marking{display:inline-block;padding:0.4mm 1.8mm;border-radius:0.6mm;"
    "font-family:Inter,'DejaVu Sans',sans-serif;font-size:6.5pt;font-weight:700;"
    "letter-spacing:0.06em;text-transform:uppercase;line-height:1.35;white-space:nowrap}"
    ".marking img{height:2.6mm;width:auto;vertical-align:-0.5mm;margin-right:1mm}"
    ".marking-top{position:running(marking-top)}"
    ".marking-bottom{position:running(marking-bottom)}"
)


def running_marking(marking: Marking | None) -> str:
    """The marking's two running elements, first in the body, which the
    page's top and bottom bands show."""
    if marking is None:
        return ""
    return marking_badge(marking, "marking-top") + marking_badge(marking, "marking-bottom")


def page_marking_rules() -> str:
    """The ``@page`` margin boxes that show the running marking."""
    return (
        "@top-center{content:element(marking-top);vertical-align:bottom;padding-bottom:1.5mm}"
        "@bottom-center{content:element(marking-bottom);vertical-align:top;padding-top:1.5mm}"
    )
