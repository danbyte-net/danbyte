"""Small DXF drawings built with ezdxf for the CAD tests. Not a test module."""
from __future__ import annotations

import io

import ezdxf
from ezdxf.enums import TextEntityAlignment


def floor_dxf(*, units: int | None = 4, extras=None) -> bytes:
    """A 10 m x 6 m room in millimetres: walls, a door arc, a column, a desk
    block inserted scaled and rotated, a hatch, text, mtext, a dimension, and
    layers that start off and frozen."""
    doc = ezdxf.new("R2018", setup=True)
    if units is not None:
        doc.header["$INSUNITS"] = units
    doc.layers.add("WALLS", color=1)
    doc.layers.add("DOORS", color=3)
    doc.layers.add("FURNITURE", color=5)
    doc.layers.add("HATCH", color=8)
    doc.layers.add("TEXT", color=7)
    doc.layers.add("DIMS", color=2)
    off = doc.layers.add("GRID-OFF", color=4)
    off.off()
    frozen = doc.layers.add("FROZEN", color=6)
    frozen.freeze()

    msp = doc.modelspace()
    msp.add_lwpolyline(
        [(0, 0), (10000, 0), (10000, 6000), (0, 6000)], close=True,
        dxfattribs={"layer": "WALLS"},
    )
    msp.add_line((5000, 0), (5000, 2500), dxfattribs={"layer": "WALLS"})
    msp.add_arc((1000, 0), 900, 0, 90, dxfattribs={"layer": "DOORS"})
    msp.add_circle((5000, 3000), 200, dxfattribs={"layer": "WALLS"})

    desk = doc.blocks.new("DESK")
    desk.add_lwpolyline([(0, 0), (1600, 0), (1600, 800), (0, 800)], close=True)
    msp.add_blockref(
        "DESK", (7000, 4000),
        dxfattribs={"layer": "FURNITURE", "xscale": 0.5, "yscale": 0.5, "rotation": 90},
    )

    hatch = msp.add_hatch(color=8, dxfattribs={"layer": "HATCH"})
    hatch.paths.add_polyline_path([(100, 100), (900, 100), (900, 900), (100, 900)])
    pattern = msp.add_hatch(color=8, dxfattribs={"layer": "HATCH"})
    pattern.set_pattern_fill("ANSI31", scale=10)
    pattern.paths.add_polyline_path([(2000, 100), (2900, 100), (2900, 900), (2000, 900)])

    msp.add_text(
        "Server room", height=250, dxfattribs={"layer": "TEXT"}
    ).set_placement((4000, 5000), align=TextEntityAlignment.LEFT)
    msp.add_mtext("Hall A\\PCold aisle", dxfattribs={"layer": "TEXT", "char_height": 200,
                                                      "insert": (6000, 5500)})
    dim = msp.add_linear_dim(base=(0, -500), p1=(0, 0), p2=(10000, 0),
                             dxfattribs={"layer": "DIMS"})
    dim.render()
    msp.add_line((0, 7000), (10000, 7000), dxfattribs={"layer": "GRID-OFF"})
    msp.add_line((0, 7500), (10000, 7500), dxfattribs={"layer": "FROZEN"})
    if extras:
        extras(doc, msp)
    return to_bytes(doc)


def to_bytes(doc) -> bytes:
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode("utf-8")


def hostile_dxf() -> bytes:
    """External references: an IMAGE at /etc/passwd, a PDF underlay, an xref
    block - next to one honest line so the drawing is not empty."""

    def extras(doc, msp):
        image_def = doc.add_image_def(filename="/etc/passwd", size_in_pixel=(640, 480))
        msp.add_image(image_def, insert=(0, 0), size_in_units=(6.4, 4.8))
        underlay_def = doc.add_underlay_def(filename="/etc/shadow", fmt="pdf", name="1")
        msp.add_underlay(underlay_def, insert=(0, 0, 0), scale=1)
        doc.add_xref_def("/etc/hosts", "REMOTE")
        msp.add_blockref("REMOTE", (0, 0))

    return floor_dxf(extras=extras)


def many_lines_dxf(n: int, *, units: int = 4) -> bytes:
    doc = ezdxf.new("R2018")
    doc.header["$INSUNITS"] = units
    msp = doc.modelspace()
    for i in range(n):
        msp.add_line((i, 0), (i, 1000))
    return to_bytes(doc)


def block_bomb_dxf(depth: int = 8, fan: int = 10) -> bytes:
    """Blocks nested ``depth`` deep, each inserting the next ``fan`` times:
    a few kilobytes that expand to fan**depth lines."""
    doc = ezdxf.new("R2018")
    prev = doc.blocks.new("B0")
    prev.add_line((0, 0), (1, 1))
    for level in range(1, depth + 1):
        blk = doc.blocks.new(f"B{level}")
        for i in range(fan):
            blk.add_blockref(f"B{level - 1}", (i * 2, 0))
        prev = blk
    doc.modelspace().add_blockref(f"B{depth}", (0, 0))
    return to_bytes(doc)
