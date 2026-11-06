"""A report's marking: the sensitivity label every page shows.

A marking is a short label (``Internal``, ``Confidential``…) in its own
colour, with an optional icon. When a report carries one
(``ReportContext.marking``), the page template prints it in the top band of
every page as a square badge, in the bottom band too, and on the cover and
the chapter dividers. Without one, nothing changes on the page.

:func:`marking_for` is where the label catalog (``api/sensitivity.py``)
plugs in: it answers the marking for the label a report's options name,
checked against the tenant and the reader's view permission. Callers never
build a :class:`Marking` from request data themselves.
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
    """The marking a report made for ``request`` in ``tenant`` carries: the
    sensitivity label ``options["sensitivity_label"]`` names
    (``api/sensitivity.py``), or None for none.

    The label must be the tenant's and one the reader may view; anything
    else is a 400 on ``options.sensitivity_label``
    (:func:`api.sensitivity.label_for_request`)."""
    from .. import sensitivity

    label = sensitivity.label_for_request(
        request, tenant, (options or {}).get("sensitivity_label")
    )
    return Marking.from_dict(sensitivity.marking_for(label))


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
    """The marking as a square badge: its icon, then its name in capitals,
    on its colour."""
    icon = _icon_uri(marking)
    img = f"<img class='marking-icon' src='{icon}' alt=''>" if icon else ""
    return (
        f"<span class='marking{(' ' + cls) if cls else ''}' "
        f"style='background:{marking.color};color:{marking.text_color}'>"
        f"{img}<span class='marking-name'>{escape(marking.name)}</span></span>"
    )


#: The badge's look, wherever it prints: the page bands, the cover's top
#: right and a divider's.
MARKING_CSS = (
    ".marking-top{position:running(marking-top)}"
    ".marking-bottom{position:running(marking-bottom)}"
    ".marking{display:inline-block;padding:0.5mm 2.4mm;border-radius:0.8mm;"
    "font-family:Inter,'DejaVu Sans',sans-serif;font-size:7pt;font-weight:700;"
    "letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;line-height:1.3}"
    ".marking img.marking-icon{height:8pt;width:8pt;vertical-align:-1pt;margin-right:1.2mm}"
    "section.cover .cover-marking{position:absolute;right:18.600mm;top:17.600mm;"
    "font-size:10pt;padding:1.2mm 3.6mm;border-radius:1.2mm;letter-spacing:0.1em}"
    "section.cover .cover-marking img.marking-icon{width:11pt;height:11pt;"
    "vertical-align:-2pt;margin-right:1.8mm}"
)


def running_marking(marking: Marking | None) -> str:
    """The marking's two running elements, first in the body, which the
    page's top and bottom bands show."""
    if marking is None:
        return ""
    return (
        f"<div class='marking-top'>{marking_badge(marking)}</div>"
        f"<div class='marking-bottom'>{marking_badge(marking)}</div>"
    )


def page_marking_rules() -> str:
    """The ``@page`` margin boxes that show the running marking."""
    return (
        "@top-center{content:element(marking-top);vertical-align:middle}"
        "@bottom-center{content:element(marking-bottom);vertical-align:middle}"
    )
