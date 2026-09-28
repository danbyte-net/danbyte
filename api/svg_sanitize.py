"""An allowlist SVG sanitizer for drawings the server renders.

The topology PDF (``api/topology_export.py``) renders an SVG the browser
drew - untrusted markup that goes into WeasyPrint. This module rebuilds it
from what the diagram writer (``frontend/src/lib/diagram/svg.ts``) emits:
shapes, paths, text, clip paths, photo symbols and a few presentation
attributes, each value checked against a pattern. Everything else goes:

* a DOCTYPE or an entity declaration is refused outright (XXE, entity
  expansion), and the parser resolves nothing and reads nothing from a
  network;
* scripts, ``foreignObject``, animation, event handlers, ``style=`` and
  ``class`` are dropped; an ``<a>`` is unwrapped (WeasyPrint draws an SVG
  ``<a>`` as text, and a link has no use on paper);
* ``<image>`` keeps only a ``data:image/(png|jpeg|webp)`` URI whose bytes
  Pillow reads as that format within a pixel cap, or a
  ``/media/device-type-images/`` path; ``<use>`` only points at a
  ``<symbol>`` in the same drawing that holds no ``<use>`` itself, so a
  reference can neither loop nor multiply;
* a ``<style>`` keeps plain rules of the same presentation properties;
  ``@font-face`` only when the caller allows fonts (the PDF brings its own).

Caps bound the work: the SVG's size in bytes, its element count and the
characters of text in it. Reused
by any feature that needs to render a client-drawn SVG on the server.
"""

from __future__ import annotations

import base64
import binascii
import io
import re

from lxml import etree

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
XML_NS = "http://www.w3.org/XML/1998/namespace"

MAX_SVG_BYTES = 8 * 1024 * 1024
MAX_ELEMENTS = 60_000
# WeasyPrint lays SVG text out letter by letter (about 0.3 ms a letter), so
# text is what a render's time grows with.
MAX_TEXT_CHARS = 80_000
# One embedded photo: decoded bytes and pixels.
MAX_IMAGE_BYTES = 3 * 1024 * 1024
MAX_IMAGE_PIXELS = 6000 * 6000
# Fonts in a <style> (only with allow_fonts).
MAX_FONT_BYTES = 1024 * 1024
MEDIA_IMAGE_PREFIX = "/media/device-type-images/"


class SvgRejected(ValueError):
    """The SVG can't be rendered; the message says why, for the caller."""

    status = 400


class SvgTooLarge(SvgRejected):
    """Over a size or element cap."""

    status = 413


# ─── Value patterns ─────────────────────────────────────────────────────────

_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
_LEN = rf"{_NUM}(?:px|pt|mm|cm|in|em|ex|%)?"
_NUMBER = re.compile(rf"^\s*{_NUM}\s*$")
_LENGTH = re.compile(rf"^\s*{_LEN}\s*$")
_LENGTHS = re.compile(rf"^\s*{_LEN}(?:[\s,]+{_LEN})*\s*$")
_OPACITY = re.compile(rf"^\s*{_NUM}%?\s*$")
_PATH = re.compile(r"^[MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$")
_POINTS = re.compile(r"^[0-9eE.,+\-\s]*$")
_VIEWBOX = re.compile(rf"^\s*{_NUM}(?:[\s,]+{_NUM}){{3}}\s*$")
_TRANSFORM_FN = re.compile(
    r"(?:matrix|translate|scale|rotate|skewX|skewY)\s*\(\s*[0-9eE.,+\-\s]*\)"
)
_COLOR = re.compile(
    r"^\s*(?:#[0-9a-fA-F]{3,8}|none|currentColor|transparent|[a-zA-Z]{3,24}"
    r"|rgba?\(\s*[0-9.%\s,]+\))\s*$"
)
_DASHES = re.compile(rf"^\s*(?:none|{_LEN}(?:[\s,]+{_LEN})*)\s*$")
_FONT_FAMILY = re.compile(r"""^[A-Za-z0-9 ,'"\-]{1,200}$""")
_FONT_WEIGHT = re.compile(r"^\s*(?:normal|bold|bolder|lighter|[1-9]00)\s*$")
_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_\-.]{0,127}$")
_LOCAL_URL = re.compile(r"^\s*url\(\s*#([A-Za-z_][A-Za-z0-9_\-.]{0,127})\s*\)\s*$")
_ASPECT = re.compile(r"^\s*(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?\s*$")
_DATA_IMAGE = re.compile(r"^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$", re.DOTALL)
_MEDIA_IMAGE = re.compile(
    r"^/media/device-type-images/(?:[A-Za-z0-9_\-][A-Za-z0-9_.\-]*/)*"
    r"[A-Za-z0-9_\-][A-Za-z0-9_.\-]*$"
)
_DOCTYPE = re.compile(rb"<!\s*(?:DOCTYPE|ENTITY)", re.IGNORECASE)


def _keyword(*words):
    allowed = frozenset(words)
    return lambda v: v.strip() in allowed


def _match(rx):
    return lambda v: bool(rx.match(v))


def _transform(v: str) -> bool:
    if len(v) > 2000:
        return False
    rest = _TRANSFORM_FN.sub("", v)
    return not rest.strip(" ,\t\r\n")


_is_number = _match(_NUMBER)
_is_length = _match(_LENGTH)

# Presentation properties: valid as attributes and inside <style> rules.
PRESENTATION = {
    "fill": _match(_COLOR),
    "stroke": _match(_COLOR),
    "color": _match(_COLOR),
    "fill-opacity": _match(_OPACITY),
    "stroke-opacity": _match(_OPACITY),
    "opacity": _match(_OPACITY),
    "fill-rule": _keyword("nonzero", "evenodd"),
    "clip-rule": _keyword("nonzero", "evenodd"),
    "stroke-width": _is_length,
    "stroke-miterlimit": _is_number,
    "stroke-dashoffset": _is_length,
    "stroke-dasharray": _match(_DASHES),
    "stroke-linecap": _keyword("butt", "round", "square"),
    "stroke-linejoin": _keyword("miter", "round", "bevel", "arcs", "miter-clip"),
    "font-family": _match(_FONT_FAMILY),
    "font-size": _is_length,
    "font-weight": _match(_FONT_WEIGHT),
    "font-style": _keyword("normal", "italic", "oblique"),
    "text-anchor": _keyword("start", "middle", "end"),
    "text-decoration": _keyword("none", "underline", "line-through", "overline"),
    "text-rendering": _keyword("auto", "optimizeSpeed", "optimizeLegibility", "geometricPrecision"),
    "dominant-baseline": _keyword(
        "auto",
        "middle",
        "central",
        "hanging",
        "alphabetic",
        "text-top",
        "text-bottom",
        "mathematical",
        "ideographic",
    ),
    "alignment-baseline": _keyword(
        "auto",
        "baseline",
        "middle",
        "central",
        "hanging",
        "alphabetic",
        "text-before-edge",
        "text-after-edge",
        "mathematical",
        "ideographic",
    ),
    "letter-spacing": _is_length,
    "visibility": _keyword("visible", "hidden", "collapse"),
    "display": _keyword("none", "inline", "block"),
}

_GEOMETRY = {
    name: _is_length
    for name in ("x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height")
}
_COMMON = {
    "id": _match(_ID),
    "transform": _transform,
    "clip-path": _match(_LOCAL_URL),
    **PRESENTATION,
}

# Element → the attributes it may keep (beyond _COMMON). ``href`` is checked
# per element below.
_SHAPE = {**_GEOMETRY}
ELEMENTS: dict[str, dict] = {
    "svg": {
        **_GEOMETRY,
        "viewBox": _match(_VIEWBOX),
        "preserveAspectRatio": _match(_ASPECT),
        "role": _keyword("img", "graphics-document", "presentation"),
    },
    "g": {},
    "defs": {},
    "symbol": {
        **_GEOMETRY,
        "viewBox": _match(_VIEWBOX),
        "preserveAspectRatio": _match(_ASPECT),
    },
    "clipPath": {"clipPathUnits": _keyword("userSpaceOnUse", "objectBoundingBox")},
    "rect": _SHAPE,
    "circle": _SHAPE,
    "ellipse": _SHAPE,
    "line": _SHAPE,
    "path": {"d": _match(_PATH)},
    "polyline": {"points": _match(_POINTS)},
    "polygon": {"points": _match(_POINTS)},
    "text": {
        "x": _match(_LENGTHS),
        "y": _match(_LENGTHS),
        "dx": _match(_LENGTHS),
        "dy": _match(_LENGTHS),
        "rotate": _match(_LENGTHS),
    },
    "tspan": {
        "x": _match(_LENGTHS),
        "y": _match(_LENGTHS),
        "dx": _match(_LENGTHS),
        "dy": _match(_LENGTHS),
    },
    "image": {**_GEOMETRY, "preserveAspectRatio": _match(_ASPECT)},
    "use": {**_GEOMETRY},
    "title": {},
    "desc": {},
    "style": {},
}
# Elements whose own text is content.
_TEXT_ELEMENTS = frozenset({"text", "tspan", "title", "desc", "style"})
# What a clip path may hold: shapes, never a reference.
_CLIP_CHILDREN = frozenset(
    {"rect", "circle", "ellipse", "line", "path", "polyline", "polygon", "text", "tspan"}
)
# Unwrapped: the element goes, its children stay.
_UNWRAP = frozenset({"a", "switch"})


# ─── Images and styles ──────────────────────────────────────────────────────


def _check_data_image(uri: str) -> str:
    """The URI, compacted, when it is a readable PNG/JPEG/WebP within the
    caps; SvgRejected otherwise."""
    m = _DATA_IMAGE.match(uri)
    if not m:
        raise SvgRejected("An embedded image must be a PNG, JPEG or WebP.")
    kind, payload = m.group(1), re.sub(r"\s+", "", m.group(2))
    if len(payload) * 3 // 4 > MAX_IMAGE_BYTES:
        raise SvgTooLarge("An embedded image is too large.")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SvgRejected("An embedded image is not valid base64.") from exc
    from PIL import Image

    try:
        with Image.open(io.BytesIO(raw)) as img:
            fmt = (img.format or "").lower()
            w, h = img.size
    except Exception as exc:  # noqa: BLE001 - any Pillow failure is a bad image
        raise SvgRejected("An embedded image could not be read.") from exc
    if fmt != kind:
        raise SvgRejected("An embedded image is not the type it claims.")
    if w * h > MAX_IMAGE_PIXELS:
        raise SvgTooLarge("An embedded image has too many pixels.")
    return f"data:image/{kind};base64,{payload}"


_FONT_SRC = re.compile(
    r"^url\(\s*[\"']?(data:(?:font/(?:woff2|woff|ttf|otf)|application/font-woff2?)"
    r";base64,[A-Za-z0-9+/=]+)[\"']?\s*\)(?:\s+format\(\s*[\"']?[a-z0-9-]+[\"']?\s*\))?$"
)
_SELECTOR = re.compile(r"^[A-Za-z0-9_\-.#,>*:\s]{1,200}$")
_UNICODE_RANGE = re.compile(r"^[Uu+0-9A-Fa-f?,\s\-]{1,2000}$")


def _clean_style(css: str, allow_fonts: bool) -> str:
    """Plain rules of presentation properties, plus ``@font-face`` with a
    ``data:`` font when fonts are allowed. Anything else is dropped."""
    import tinycss2

    out: list[str] = []
    rules = tinycss2.parse_stylesheet(css, skip_whitespace=True, skip_comments=True)
    for rule in rules:
        if rule.type == "at-rule":
            if not allow_fonts or rule.lower_at_keyword != "font-face" or not rule.content:
                continue
            decls = _declarations(rule.content)
            face: list[str] = []
            for name, value in decls:
                if name == "src":
                    m = _FONT_SRC.match(value)
                    if not m or len(m.group(1)) * 3 // 4 > MAX_FONT_BYTES:
                        face = []
                        break
                    face.append(f"src:url({m.group(1)})")
                elif name == "font-family" and _FONT_FAMILY.match(value):
                    face.append(f"font-family:{value}")
                elif name == "font-weight" and re.match(r"^[1-9]00(?: [1-9]00)?$", value):
                    face.append(f"font-weight:{value}")
                elif name == "font-style" and value in ("normal", "italic"):
                    face.append(f"font-style:{value}")
                elif name == "unicode-range" and _UNICODE_RANGE.match(value):
                    face.append(f"unicode-range:{value}")
            if any(d.startswith("src:") for d in face) and any(
                d.startswith("font-family:") for d in face
            ):
                out.append("@font-face{" + ";".join(face) + "}")
        elif rule.type == "qualified-rule":
            selector = tinycss2.serialize(rule.prelude).strip()
            if not _SELECTOR.match(selector) or rule.content is None:
                continue
            kept = [
                f"{name}:{value}"
                for name, value in _declarations(rule.content)
                if name in PRESENTATION and PRESENTATION[name](value)
            ]
            if kept:
                out.append(f"{selector}{{{';'.join(kept)}}}")
    return "".join(out)


def _declarations(tokens) -> list[tuple[str, str]]:
    import tinycss2

    out = []
    for decl in tinycss2.parse_declaration_list(tokens, skip_whitespace=True, skip_comments=True):
        if decl.type != "declaration":
            continue
        value = tinycss2.serialize(decl.value).strip()
        if "\\" in value or len(value) > 4 * 1024 * 1024:
            continue
        out.append((decl.lower_name, value))
    return out


# ─── The rebuild ────────────────────────────────────────────────────────────


def _local(tag) -> str | None:
    """The SVG local name of an element tag, None for anything else
    (comments, other namespaces)."""
    if not isinstance(tag, str):
        return None
    if tag.startswith("{"):
        ns, _, name = tag[1:].partition("}")
        return name if ns == SVG_NS else None
    return None


class _Builder:
    def __init__(self, allow_fonts: bool):
        self.allow_fonts = allow_fonts
        self.symbols: dict[str, etree._Element] = {}
        self.clips: set[str] = set()
        self.clipped: list[etree._Element] = []

    def attrs(self, name: str, src: etree._Element, dst: etree._Element, in_clip=False) -> None:
        allowed = ELEMENTS[name]
        for key, value in src.attrib.items():
            if key.startswith("{"):
                ns, _, local = key[1:].partition("}")
                if ns == XLINK_NS and local == "href":
                    self.href(name, value, dst)
                continue
            if key == "href":
                self.href(name, value, dst)
                continue
            check = allowed.get(key) or _COMMON.get(key)
            if check is None or len(value) > 500_000 or not check(value):
                continue
            # A clip path is never clipped itself: no chains, no loops.
            if key == "clip-path" and (in_clip or name == "clipPath"):
                continue
            dst.set(key, value)
        if dst.get("clip-path"):
            self.clipped.append(dst)

    def href(self, name: str, value: str, dst: etree._Element) -> None:
        value = value.strip()
        if name == "use":
            if value.startswith("#") and _ID.match(value[1:]):
                dst.set("href", value)
        elif name == "image":
            if value.startswith("data:"):
                dst.set("href", _check_data_image(value))
            elif _MEDIA_IMAGE.match(value) and ".." not in value:
                dst.set("href", value)

    def copy(self, src: etree._Element, parent: etree._Element, in_clip=False):
        """Copy ``src``'s allowed children under ``parent``."""
        prev = None
        for child in src:
            name = _local(child.tag)
            if name in _UNWRAP:
                self.copy(child, parent, in_clip)
                prev = parent[-1] if len(parent) else None
                self._tail(child, parent, prev)
                continue
            if name is None or name not in ELEMENTS or (in_clip and name not in _CLIP_CHILDREN):
                self._tail(child, parent, prev)
                continue
            node = etree.SubElement(parent, f"{{{SVG_NS}}}{name}")
            self.attrs(name, child, node, in_clip)
            if name == "style":
                node.text = _clean_style(child.text or "", self.allow_fonts)
                if not node.text:
                    parent.remove(node)
                    continue
            elif name in _TEXT_ELEMENTS:
                node.text = child.text
            if name == "symbol" and node.get("id"):
                self.symbols[node.get("id")] = node
            if name == "clipPath" and node.get("id"):
                self.clips.add(node.get("id"))
            if name not in ("style", "title", "desc"):
                self.copy(child, node, in_clip or name == "clipPath")
            node.tail = child.tail if parent.tag.endswith(("}text", "}tspan")) else None
            prev = node

    @staticmethod
    def _tail(child, parent, prev) -> None:
        """Keep a dropped element's trailing text inside text elements."""
        if not child.tail or not parent.tag.endswith(("}text", "}tspan")):
            return
        if prev is not None:
            prev.tail = (prev.tail or "") + child.tail
        else:
            parent.text = (parent.text or "") + child.tail

    def resolve(self, root: etree._Element) -> None:
        """References must land: a <use> on a <symbol> without <use>, a
        clip-path on a <clipPath> in the drawing. A <use> that doesn't
        goes."""
        use_tag = f"{{{SVG_NS}}}use"
        flat = {
            sid for sid, sym in self.symbols.items() if not any(True for _ in sym.iter(use_tag))
        }
        for use in list(root.iter(use_tag)):
            if use.get("href", "")[1:] not in flat:
                use.getparent().remove(use)
        for el in self.clipped:
            m = _LOCAL_URL.match(el.get("clip-path", ""))
            if not m or m.group(1) not in self.clips:
                del el.attrib["clip-path"]


def sanitize_svg(
    svg: str | bytes,
    *,
    max_bytes: int = MAX_SVG_BYTES,
    max_elements: int = MAX_ELEMENTS,
    max_text: int = MAX_TEXT_CHARS,
    allow_fonts: bool = False,
) -> bytes:
    """The SVG rebuilt from the allowlist, as UTF-8 bytes.

    Raises :class:`SvgTooLarge` over a cap and :class:`SvgRejected` for
    markup that isn't a plain SVG drawing (a DOCTYPE, entities, a root that
    isn't ``<svg>``, a malformed or oversized embedded image).
    """
    data = svg.encode("utf-8") if isinstance(svg, str) else bytes(svg)
    if len(data) > max_bytes:
        raise SvgTooLarge(f"The drawing is over {max_bytes // (1024 * 1024)} MB.")
    if _DOCTYPE.search(data):
        raise SvgRejected("DOCTYPE and entity declarations are not allowed.")
    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        dtd_validation=False,
        huge_tree=False,
        remove_comments=True,
        remove_pis=True,
    )
    try:
        root = etree.fromstring(data, parser)
    except etree.XMLSyntaxError as exc:
        raise SvgRejected("The drawing is not well-formed XML.") from exc
    doc = root.getroottree().docinfo
    if doc.doctype or doc.internalDTD is not None:
        raise SvgRejected("DOCTYPE and entity declarations are not allowed.")
    if _local(root.tag) != "svg":
        raise SvgRejected("The drawing is not an SVG document.")
    count = chars = 0
    text_tags = (f"{{{SVG_NS}}}text", f"{{{SVG_NS}}}tspan")
    for el in root.iter():
        count += 1
        if count > max_elements:
            raise SvgTooLarge(f"The drawing has over {max_elements:,} elements.")
        if el.tag in text_tags:
            chars += len(el.text or "") + (len(el.tail or "") if el.tag == text_tags[1] else 0)
            if chars > max_text:
                raise SvgTooLarge(f"The drawing has over {max_text:,} characters of text.")

    b = _Builder(allow_fonts)
    out = etree.Element(f"{{{SVG_NS}}}svg", nsmap={None: SVG_NS})
    b.attrs("svg", root, out)
    b.copy(root, out)
    b.resolve(out)
    return etree.tostring(out, encoding="utf-8")
