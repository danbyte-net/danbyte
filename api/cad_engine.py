"""Turn a DXF drawing's model space into a layered SVG.

Runs as its own process (``api/cad_render.py`` starts it with ``python -I``,
resource limits and a scrubbed environment), so it imports nothing from
Django or the rest of the project: only the standard library and ezdxf.

    python -I cad_engine.py INPUT.dxf OUT.svg OUT.json [--hidden FILE] [--hide-text]
        [--extents FILE] [--max-bytes N] [--max-elements N] [--max-text N]
        [--deadline SECONDS]

What it writes:

* ``OUT.svg``: ``<svg viewBox="0 0 W H">`` in drawing units, y pointing down
  (drawing y is flipped: ``svg_y = max_y - y``, ``svg_x = x - min_x``), one
  ``<g data-layer="NAME">`` per layer holding that layer's geometry, with
  hatches, dimensions and text in child ``<g data-kind="hatch|dimension|text">``
  groups. Text is ``<text>`` with a ``matrix()`` transform; no fonts, scripts
  or external references. The default colour (ACI 7, near-black and
  near-white) is ``currentColor``, black unless the viewer says otherwise.
* ``OUT.json``: units, extents, the layer list (name, colour, on, frozen,
  counts) and what was skipped or simplified.

``--extents`` fixes the frame to a JSON ``{min_x, min_y, max_x, max_y}``
instead of measuring what is drawn. A render with layers hidden passes the
full drawing's extents, so its viewBox is the full drawing's and it overlays
the full render exactly, even when the hidden layers sat at an edge.

The SVG is kept under the byte and element caps by a simplification ladder:
hatches go first, then dimensions, then text, then the shortest strokes. When
even the last step is over, the exit code is 3 and the JSON says why.

Never read here: IMAGE, underlays, OLE frames, external references (an INSERT
of an xref block) - anything that would point at another file.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time

EXIT_OK = 0
EXIT_UNREADABLE = 2
EXIT_TOO_LARGE = 3
EXIT_EMPTY = 4

#: Entity types never drawn: each references a file outside the drawing.
EXTERNAL_TYPES = frozenset(
    {"IMAGE", "IMAGEDEF", "PDFUNDERLAY", "DWFUNDERLAY", "DGNUNDERLAY", "UNDERLAY",
     "OLE2FRAME", "OLEFRAME", "WIPEOUT"}
)
#: Construction lines without an end: they would stretch the extents forever.
INFINITE_TYPES = frozenset({"XLINE", "RAY"})
DIMENSION_TYPES = frozenset(
    {"DIMENSION", "ARC_DIMENSION", "LARGE_RADIAL_DIMENSION", "LEADER", "MULTILEADER",
     "MLEADER", "TOLERANCE"}
)
TEXT_TYPES = frozenset({"TEXT", "MTEXT", "ATTRIB", "ATTDEF"})
HATCH_TYPES = frozenset({"HATCH", "MPOLYGON"})

#: The ladder: what each step drops on top of the one before.
LADDER = ("hatch", "dimension", "text", "short-1", "short-2")
#: Strokes shorter than the drawing's diagonal over these go at the short steps.
SHORT_FRACTION = {"short-1": 2000.0, "short-2": 400.0}
#: Hard budget of captured primitives - stops a block-reference bomb long
#: before memory does.
MAX_PRIMITIVES = 3_000_000
#: One <path> element holds at most this much path data; strokes of the same
#: layer, colour and weight share elements up to it.
CHUNK_CHARS = 60_000
#: A pattern hatch is drawn as a light fill of its colour.
PATTERN_OPACITY = "0.25"

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f￾￿]")
_SURROGATE = re.compile(r"[\ud800-\udfff]")


class Abort(Exception):
    def __init__(self, code: int, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


def _clean_text(s: str, limit: int = 4000) -> str:
    s = _SURROGATE.sub("", _CTRL.sub("", s))
    return s[:limit]


def _esc(s: str) -> str:
    return (
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )


# ─── capture ────────────────────────────────────────────────────────────────


class Capture:
    """Primitives as the ezdxf drawing frontend emits them, in drawing units,
    tagged with layer and kind. Coordinates are flipped and formatted only at
    write time, once the extents are known."""

    def __init__(self, deadline: float):
        self.deadline = deadline
        self.count = 0
        # [layer, kind, colour, width, coords-list, diag]
        self.strokes: list[tuple] = []
        # [layer, kind, colour, opacity, list-of-paths]
        self.fills: list[tuple] = []
        # [layer, kind, colour, matrix(a,b,c,d,ox,oy), font size, text]
        self.texts: list[tuple] = []
        self.min_x = self.min_y = math.inf
        self.max_x = self.max_y = -math.inf
        self.stack: list = []
        # The resolved layer of each entity on the stack.
        self.layers: list[str] = []

    # bookkeeping
    def tick(self) -> None:
        self.count += 1
        if self.count > MAX_PRIMITIVES:
            raise Abort(EXIT_TOO_LARGE, "The drawing expands to too many shapes to render.")
        if self.count % 2000 == 0 and time.monotonic() > self.deadline:
            raise Abort(EXIT_TOO_LARGE, "The drawing took too long to render.")

    def grow(self, x: float, y: float) -> None:
        if not (math.isfinite(x) and math.isfinite(y)):
            return
        if x < self.min_x:
            self.min_x = x
        if x > self.max_x:
            self.max_x = x
        if y < self.min_y:
            self.min_y = y
        if y > self.max_y:
            self.max_y = y

    def kind(self, base: str = "geometry") -> str:
        types = [e.dxftype() for e in self.stack]
        if any(t in DIMENSION_TYPES for t in types):
            return "dimension"
        if base == "text":
            return "text"
        if types and types[-1] in HATCH_TYPES:
            return "hatch"
        return base

    def pattern_hatch(self) -> bool:
        for e in reversed(self.stack):
            if e.dxftype() == "HATCH":
                return not bool(e.dxf.get("solid_fill", 1))
        return False


def _path_coords(path) -> list:
    """A backend path as ['M', x, y, 'L', x, y, 'C', ...] in drawing units."""
    from ezdxf.path import Command

    out: list = []
    if len(path) == 0:
        s = path.start
        return ["M", s.x, s.y]
    s = path.start
    out += ["M", s.x, s.y]
    for cmd in path.commands():
        e = cmd.end
        if cmd.type == Command.MOVE_TO:
            out += ["M", e.x, e.y]
        elif cmd.type == Command.LINE_TO:
            out += ["L", e.x, e.y]
        elif cmd.type == Command.CURVE3_TO:
            c = cmd.ctrl
            out += ["Q", c.x, c.y, e.x, e.y]
        elif cmd.type == Command.CURVE4_TO:
            c1, c2 = cmd.ctrl1, cmd.ctrl2
            out += ["C", c1.x, c1.y, c2.x, c2.y, e.x, e.y]
    return out


#: Coordinates beyond this are corrupt or hostile, not a building.
MAX_COORD = 1e12


def _sane(coords: list) -> bool:
    return all(
        isinstance(v, str) or (math.isfinite(v) and abs(v) <= MAX_COORD) for v in coords
    )


def _bbox_diag(coords: list, cap: Capture) -> float:
    """Grow the capture's extents by a path's points; the path's own
    bounding-box diagonal."""
    lo_x = lo_y = math.inf
    hi_x = hi_y = -math.inf
    x = None
    for v in coords:
        if isinstance(v, str):
            x = None
            continue
        if x is None:
            x = v
            continue
        y = v
        if math.isfinite(x) and math.isfinite(y):
            lo_x, hi_x = min(lo_x, x), max(hi_x, x)
            lo_y, hi_y = min(lo_y, y), max(hi_y, y)
        x = None
    if lo_x == math.inf:
        return 0.0
    cap.grow(lo_x, lo_y)
    cap.grow(hi_x, hi_y)
    return math.hypot(hi_x - lo_x, hi_y - lo_y)


def make_backend(cap: Capture):
    from ezdxf.addons.drawing.backend import BackendInterface

    class LayeredBackend(BackendInterface):
        def configure(self, config) -> None:
            pass

        def enter_entity(self, entity, properties) -> None:
            cap.stack.append(entity)
            cap.layers.append(properties.layer)

        def exit_entity(self, entity) -> None:
            if cap.stack:
                cap.stack.pop()
                cap.layers.pop()

        def set_background(self, color) -> None:
            pass

        def _stroke(self, coords: list, props) -> None:
            cap.tick()
            if not _sane(coords):
                return
            diag = _bbox_diag(coords, cap)
            cap.strokes.append(
                (props.layer, cap.kind(), _colour(props.color), props.lineweight, coords, diag)
            )

        def draw_point(self, pos, properties) -> None:
            # A point is a zero-length stroke the round cap makes visible.
            self._stroke(["M", pos.x, pos.y, "L", pos.x, pos.y], properties)

        def draw_line(self, start, end, properties) -> None:
            self._stroke(["M", start.x, start.y, "L", end.x, end.y], properties)

        def draw_solid_lines(self, lines, properties) -> None:
            coords: list = []
            for s, e in lines:
                coords += ["M", s.x, s.y, "L", e.x, e.y]
            if coords:
                self._stroke(coords, properties)

        def draw_path(self, path, properties) -> None:
            self._stroke(_path_coords(path), properties)

        def draw_filled_paths(self, paths, properties) -> None:
            cap.tick()
            parts = []
            for p in paths:
                coords = _path_coords(p)
                if not _sane(coords):
                    continue
                _bbox_diag(coords, cap)
                parts.append(coords)
            if parts:
                opacity = PATTERN_OPACITY if cap.pattern_hatch() else ""
                cap.fills.append(
                    (properties.layer, cap.kind(), _colour(properties.color), opacity, parts)
                )

        def draw_filled_polygon(self, points, properties) -> None:
            cap.tick()
            coords: list = []
            for i, v in enumerate(points.vertices()):
                coords += ["M" if i == 0 else "L", v.x, v.y]
            if coords and _sane(coords):
                _bbox_diag(coords, cap)
                cap.fills.append((properties.layer, cap.kind(), _colour(properties.color), "",
                                  [coords + ["Z"]]))

        def draw_image(self, image_data, properties) -> None:
            pass  # images are never drawn

        def clear(self) -> None:
            pass

        def finalize(self) -> None:
            pass

    return LayeredBackend()


def make_pipeline(backend, cap: Capture, hide_text: bool):
    from ezdxf.addons.drawing.pipeline import RenderPipeline2d

    class TextPipeline(RenderPipeline2d):
        """Text as ``<text>`` records instead of glyph outlines."""

        def draw_text(self, text, transform, properties, cap_height, dxftype="TEXT"):
            if hide_text or not text or not text.strip():
                return
            from ezdxf.addons.drawing.pipeline import prepare_string_for_rendering

            cap.tick()
            try:
                text = prepare_string_for_rendering(text, dxftype)
            except (AssertionError, TypeError):
                text = text.replace("\n", " ")
            text = _clean_text(text)
            if not text.strip():
                return
            o = transform.transform((0, 0, 0))
            ex = transform.transform_direction((1, 0, 0))
            ey = transform.transform_direction((0, 1, 0))
            if not _sane([o.x, o.y, ex.x, ex.y, ey.x, ey.y, cap_height]):
                return
            size = cap_height / 0.7 if cap_height > 0 else 0
            if size <= 0:
                return
            cap.grow(o.x, o.y)
            cap.grow(o.x + ex.x * size * 0.6 * len(text), o.y + ex.y * size * 0.6 * len(text))
            cap.grow(o.x + ey.x * cap_height, o.y + ey.y * cap_height)
            props = self.get_backend_properties(properties)
            cap.texts.append(
                (props.layer, cap.kind("text"), _colour(props.color),
                 (ex.x, ex.y, ey.x, ey.y, o.x, o.y), size, text)
            )

    return TextPipeline(backend)


#: Neutrals this close to black or white are the drawing's default colour.
NEUTRAL_SPREAD = 24
NEUTRAL_DARK = 48
NEUTRAL_LIGHT = 207
FOREGROUND = "currentColor"


def _colour(c: str) -> str:
    """ezdxf's ``#rrggbb[aa]`` without the alpha.

    ACI 7 (white on a dark CAD screen, black on paper) resolves to black
    here, and drawings are full of near-black and near-white "default"
    strokes besides; any of them would vanish on one of the two themes. They
    are written as ``currentColor`` so the viewer draws them in its
    foreground colour. Anything odd is the foreground too."""
    if not (isinstance(c, str) and re.fullmatch(r"#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", c)):
        return FOREGROUND
    r, g, b = (int(c[i : i + 2], 16) for i in (1, 3, 5))
    hi, lo = max(r, g, b), min(r, g, b)
    if hi - lo <= NEUTRAL_SPREAD and (hi <= NEUTRAL_DARK or lo >= NEUTRAL_LIGHT):
        return FOREGROUND
    return c[:7].lower()


# ─── read ───────────────────────────────────────────────────────────────────


def load(path: str):
    import ezdxf
    from ezdxf import recover

    try:
        doc, _auditor = recover.readfile(path)
    except OSError as exc:
        raise Abort(EXIT_UNREADABLE, "The file could not be read.") from exc
    except ezdxf.DXFStructureError as exc:
        raise Abort(EXIT_UNREADABLE, "The file is not a readable DXF drawing.") from exc
    except Exception as exc:  # noqa: BLE001 - any parser failure is a bad file
        raise Abort(EXIT_UNREADABLE, "The file is not a readable DXF drawing.") from exc
    return doc


def layer_table(doc) -> dict[str, dict]:
    """The layer table, before every layer is switched on for drawing."""
    from ezdxf import colors

    out: dict[str, dict] = {}
    for layer in doc.layers:
        name = _clean_text(layer.dxf.name, 255)
        try:
            rgb = layer.rgb
        except Exception:  # noqa: BLE001
            rgb = None
        aci = abs(int(layer.dxf.get("color", 7) or 7))
        if rgb is None:
            rgb = (0, 0, 0) if aci in (7, 0, 256) else colors.aci2rgb(aci)
        on = bool(layer.is_on())
        frozen = bool(layer.is_frozen())
        out[name] = {
            "name": name,
            "color": "#{:02x}{:02x}{:02x}".format(*rgb),
            "on": on,
            "frozen": frozen,
        }
        # Draw every layer: the viewer hides them instead.
        layer.on()
        layer.thaw()
    return out


def xref_blocks(doc) -> set[str]:
    names = set()
    for block in doc.blocks:
        rec = block.block
        if rec is not None and (rec.is_xref or rec.is_xref_overlay):
            names.add(block.name)
    return names


def expansion(doc) -> float:
    """How many entities model space expands to with every block reference
    followed - counted, not drawn, so a nested-block bomb is refused in
    milliseconds. A block that references itself counts as unbounded."""
    memo: dict[str, float] = {}
    busy: set[str] = set()

    def cost_of(entities) -> float:
        total = 0.0
        for e in entities:
            if e.dxftype() == "INSERT":
                name = e.dxf.get("name", "")
                reps = max(1, int(e.dxf.get("row_count", 1) or 1)) * max(
                    1, int(e.dxf.get("column_count", 1) or 1)
                )
                total += block(name) * reps + len(getattr(e, "attribs", ()))
            else:
                total += 1
            if total > MAX_PRIMITIVES:
                return total
        return total

    def block(name: str) -> float:
        if name in memo:
            return memo[name]
        if name in busy:
            return math.inf
        layout = doc.blocks.get(name)
        if layout is None:
            return 0.0
        busy.add(name)
        memo[name] = cost_of(layout)
        busy.discard(name)
        return memo[name]

    return cost_of(doc.modelspace())


# ─── render ─────────────────────────────────────────────────────────────────


def render(doc, cap: Capture, hidden: set[str], hide_text: bool) -> dict:
    from ezdxf.addons.drawing import RenderContext
    from ezdxf.addons.drawing.config import (
        BackgroundPolicy,
        ColorPolicy,
        Configuration,
        HatchPolicy,
        ImagePolicy,
        LinePolicy,
        ProxyGraphicPolicy,
    )
    from ezdxf.addons.drawing.frontend import UniversalFrontend

    skipped = {"external": 0, "infinite": 0}
    xrefs = xref_blocks(doc)
    config = Configuration(
        background_policy=BackgroundPolicy.WHITE,
        color_policy=ColorPolicy.COLOR,
        hatch_policy=HatchPolicy.SHOW_SOLID,
        image_policy=ImagePolicy.IGNORE,
        line_policy=LinePolicy.SOLID,
        proxy_graphic_policy=ProxyGraphicPolicy.SHOW,
    )
    ctx = RenderContext(doc)
    backend = make_backend(cap)
    pipeline = make_pipeline(backend, cap, hide_text)
    frontend = UniversalFrontend(ctx, pipeline, config=config)
    frontend.log_message = lambda message: None

    def override(entity, properties) -> None:
        t = entity.dxftype()
        # Layer "0" inside a block or a dimension takes its parent's layer,
        # as CAD tools draw it.
        if properties.layer == "0" and cap.layers:
            properties.layer = cap.layers[-1]
        if t in EXTERNAL_TYPES:
            skipped["external"] += 1
            properties.is_visible = False
        elif t == "INSERT" and entity.dxf.get("name") in xrefs:
            skipped["external"] += 1
            properties.is_visible = False
        elif t in INFINITE_TYPES:
            skipped["infinite"] += 1
            properties.is_visible = False
        elif properties.layer in hidden:
            properties.is_visible = False
        elif hide_text and t in TEXT_TYPES:
            properties.is_visible = False

    frontend.push_property_override_function(override)
    frontend.draw_layout(doc.modelspace(), finalize=True)
    return skipped


# ─── write ──────────────────────────────────────────────────────────────────


class Writer:
    def __init__(self, cap: Capture, layer_order: list[str]):
        self.cap = cap
        self.ox = cap.min_x
        self.oy = cap.max_y
        self.w = max(cap.max_x - cap.min_x, 0.0)
        self.h = max(cap.max_y - cap.min_y, 0.0)
        size = max(self.w, self.h, 1e-9)
        # About a millionth of the drawing: sub-pixel at any zoom the canvas has.
        self.dec = min(6, max(0, math.ceil(-math.log10(size / 1e6))))
        self.diag = math.hypot(self.w, self.h)
        self.order = layer_order

    def n(self, v: float) -> str:
        s = f"{v:.{self.dec}f}"
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s

    def d(self, coords: list) -> str:
        out = []
        i = 0
        n = self.n
        while i < len(coords):
            c = coords[i]
            if c == "Z":
                out.append("Z")
                i += 1
                continue
            arity = {"M": 1, "L": 1, "Q": 2, "C": 3}[c]
            pts = []
            for k in range(arity):
                x = coords[i + 1 + 2 * k]
                y = coords[i + 2 + 2 * k]
                pts.append(f"{n(x - self.ox)} {n(self.oy - y)}")
            out.append(c + " ".join(pts))
            i += 1 + 2 * arity
        return "".join(out)

    def svg(self, drop: set[str], short: float) -> tuple[str, int, dict]:
        """The document with ``drop`` kinds left out and strokes shorter than
        ``short`` dropped; (markup, elements, per-layer counts)."""
        layers: dict[str, dict[str, list[str]]] = {}
        counts: dict[str, dict[str, int]] = {}

        def bucket(layer: str, kind: str) -> list[str]:
            return layers.setdefault(layer, {}).setdefault(kind, [])

        def bump(layer: str, kind: str) -> None:
            c = counts.setdefault(layer, {})
            c[kind] = c.get(kind, 0) + 1

        # Strokes: merged per layer, kind, colour and weight.
        merged: dict[tuple, list[str]] = {}
        for layer, kind, colour, lw, coords, diag in self.cap.strokes:
            if kind in drop or (short and diag < short and kind == "geometry"):
                continue
            merged.setdefault((layer, kind, colour, lw), []).append(self.d(coords))
            bump(layer, kind)
        for (layer, kind, colour, lw), parts in merged.items():
            width = self.n(max(lw, 0.0)) if lw else "0.25"
            chunk: list[str] = []
            size = 0
            out = bucket(layer, kind)

            def flush(chunk=chunk, out=out, colour=colour, width=width):
                if chunk:
                    out.append(
                        f'<path d="{"".join(chunk)}" stroke="{colour}" '
                        f'stroke-width="{width}"/>'
                    )
                    chunk.clear()

            for p in parts:
                if size + len(p) > CHUNK_CHARS and chunk:
                    flush()
                    size = 0
                chunk.append(p)
                size += len(p)
            flush()
        for layer, kind, colour, opacity, paths in self.cap.fills:
            if kind in drop:
                continue
            d = "".join(self.d(p) + ("" if p and p[-1] == "Z" else "Z") for p in paths)
            op = f' fill-opacity="{opacity}"' if opacity else ""
            bucket(layer, kind).append(
                f'<path d="{d}" fill="{colour}" fill-rule="evenodd" stroke="none"{op}/>'
            )
            bump(layer, kind)
        for layer, kind, colour, m, size, text in self.cap.texts:
            if kind in drop or "text" in drop:
                continue
            a, b, c, dd, x, y = m
            # Text-local y points down in SVG, up in the drawing: see the
            # module docstring for the flip.
            matrix = " ".join(
                self.n(v) for v in (a, -b, -c, dd, x - self.ox, self.oy - y)
            )
            bucket(layer, kind).append(
                f'<text transform="matrix({matrix})" font-size="{self.n(size)}" '
                f'fill="{colour}" stroke="none">{_esc(text)}</text>'
            )
            bump(layer, kind)

        parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.n(self.w)} '
            f'{self.n(self.h)}" width="{self.n(self.w)}" height="{self.n(self.h)}" '
            # The default colour when the file is opened on its own; the
            # canvas draws it in the theme's foreground instead.
            'color="#000000">'
        ]
        elements = 1
        ordered = [n for n in self.order if n in layers] + sorted(
            n for n in layers if n not in self.order
        )
        for name in ordered:
            kinds = layers[name]
            parts.append(
                f'<g data-layer="{_esc(name)}" fill="none" stroke-linecap="round" '
                'stroke-linejoin="round">'
            )
            elements += 1
            geo = kinds.get("geometry", [])
            parts.extend(geo)
            elements += len(geo)
            for kind in ("hatch", "dimension", "text"):
                items = kinds.get(kind)
                if not items:
                    continue
                parts.append(f'<g data-kind="{kind}">')
                parts.extend(items)
                parts.append("</g>")
                elements += 1 + len(items)
            parts.append("</g>")
        parts.append("</svg>")
        return "".join(parts), elements, counts


def write(cap: Capture, order: list[str], svg_path: str, max_bytes: int, max_elements: int,
          max_text: int) -> tuple[int, int, list[str], dict]:
    w = Writer(cap, order)
    drop: set[str] = set()
    steps: list[str] = []
    for step in (None, *LADDER):
        short = 0.0
        if step is not None:
            steps.append(step)
            if step in SHORT_FRACTION:
                short = w.diag / SHORT_FRACTION[step]
            else:
                drop.add(step)
        markup, elements, counts = w.svg(drop, short)
        data = markup.encode("utf-8")
        chars = 0 if "text" in drop else sum(len(t[5]) for t in cap.texts)
        if len(data) <= max_bytes and elements <= max_elements and chars <= max_text:
            with open(svg_path, "wb") as fh:
                fh.write(data)
            return len(data), elements, steps, counts
    raise Abort(
        EXIT_TOO_LARGE,
        f"The drawing is too large to show even simplified: over {max_bytes // (1024 * 1024)} "
        f"MB or {max_elements:,} elements.",
    )


def fix_extents(cap: Capture, path: str) -> None:
    """Frame the drawing by the extents in ``path`` instead of what was
    drawn: a render with layers left out keeps the full drawing's viewBox."""
    try:
        with open(path, encoding="utf-8") as fh:
            ext = json.load(fh)
        box = [float(ext[k]) for k in ("min_x", "min_y", "max_x", "max_y")]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise Abort(EXIT_UNREADABLE, "The drawing's extents are unreadable.") from exc
    if not all(math.isfinite(v) and abs(v) <= MAX_COORD for v in box) or (
        box[2] < box[0] or box[3] < box[1]
    ):
        raise Abort(EXIT_UNREADABLE, "The drawing's extents are unreadable.")
    cap.min_x, cap.min_y, cap.max_x, cap.max_y = box


UNITS = {
    0: "unitless", 1: "in", 2: "ft", 3: "mi", 4: "mm", 5: "cm", 6: "m", 7: "km",
    8: "µin", 9: "mil", 10: "yd", 11: "Å", 12: "nm", 13: "µm", 14: "dm", 15: "dam",
    16: "hm", 17: "Gm", 18: "au", 19: "ly", 20: "pc", 21: "us-ft",
}
MM_PER_UNIT = {
    1: 25.4, 2: 304.8, 3: 1_609_344.0, 4: 1.0, 5: 10.0, 6: 1000.0, 7: 1_000_000.0,
    8: 2.54e-5, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100.0,
    15: 10_000.0, 16: 100_000.0, 17: 1e12, 18: 1.495978707e14, 19: 9.4607304725808e18,
    20: 3.0856775814913673e19, 21: 304.8006096012192,
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("svg")
    ap.add_argument("meta")
    ap.add_argument("--hidden", default="")
    ap.add_argument("--hide-text", action="store_true")
    ap.add_argument("--extents", default="")
    ap.add_argument("--max-bytes", type=int, default=20 * 1024 * 1024)
    ap.add_argument("--max-elements", type=int, default=250_000)
    ap.add_argument("--max-text", type=int, default=2_000_000)
    ap.add_argument("--deadline", type=float, default=540.0)
    args = ap.parse_args(argv)

    meta: dict = {"ok": False}
    try:
        hidden: set[str] = set()
        if args.hidden:
            with open(args.hidden, encoding="utf-8") as fh:
                hidden = {str(x) for x in json.load(fh)}
        cap = Capture(time.monotonic() + args.deadline)
        doc = load(args.input)
        code = int(doc.header.get("$INSUNITS", 0) or 0)
        if expansion(doc) > MAX_PRIMITIVES:
            raise Abort(EXIT_TOO_LARGE, "The drawing expands to too many shapes to render.")
        table = layer_table(doc)
        skipped = render(doc, cap, hidden, args.hide_text)
        if args.extents:
            fix_extents(cap, args.extents)
        if not (math.isfinite(cap.min_x) and math.isfinite(cap.max_x)):
            raise Abort(EXIT_EMPTY, "The drawing's model space has nothing to show.")
        size, elements, steps, counts = write(
            cap, list(table), args.svg, args.max_bytes, args.max_elements, args.max_text
        )
        layers = []
        for name in list(table) + sorted(set(counts) - set(table)):
            c = counts.get(name)
            if not c:
                continue
            row = table.get(name) or {"name": name, "color": "#000000", "on": True,
                                      "frozen": False}
            layers.append({**row, "entity_count": sum(c.values()), "kinds": c})
        meta = {
            "ok": True,
            "units_code": code if code in UNITS else 0,
            "units": UNITS.get(code, "unitless"),
            "mm_per_unit": MM_PER_UNIT.get(code),
            "extents": {"min_x": cap.min_x, "min_y": cap.min_y,
                        "max_x": cap.max_x, "max_y": cap.max_y},
            "layers": layers,
            "bytes": size,
            "elements": elements,
            "simplified": steps,
            "skipped": skipped,
            "dxf_version": str(doc.dxfversion),
        }
        status = EXIT_OK
    except Abort as exc:
        meta = {"ok": False, "error": exc.reason}
        status = exc.code
    except MemoryError:
        meta = {"ok": False, "error": "The drawing needs more memory than allowed to render."}
        status = EXIT_TOO_LARGE
    except Exception:  # noqa: BLE001 - a broken file must still say so
        import traceback

        traceback.print_exc(file=sys.stderr)
        meta = {"ok": False, "error": "The drawing could not be rendered."}
        status = EXIT_UNREADABLE
    with open(args.meta, "w", encoding="utf-8") as fh:
        json.dump(meta, fh)
    return status


if __name__ == "__main__":
    sys.exit(main())
