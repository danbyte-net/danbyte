"""What a rack looks like in 3D (docs/dcim/racks.md → Look, the export spec
§14).

A rack type carries the Look fields: frame, rail depth, doors, hinge side,
side panels, roof, base, colour, the rack kit to build it from and whether
empty units draw blanking panels. A rack carries the same fields as
overrides: null takes its type's value, and a rack with no type takes the
defaults below. ``resolve(rack)`` is what the 3D room draws from.

The blanking fill is draw-only: the panels it draws are never devices and
never count toward utilisation.
"""
from __future__ import annotations

import re

FRAME_CHOICES = [("2-post", "2-post"), ("4-post", "4-post"),
                 ("cabinet", "Cabinet"), ("wall-cabinet", "Wall cabinet")]
DOOR_CHOICES = [("none", "None"), ("perforated", "Perforated"), ("glass", "Glass"),
                ("solid", "Solid"), ("split-perforated", "Split perforated"),
                ("split-solid", "Split solid")]
HINGE_CHOICES = [("left", "Left"), ("right", "Right")]
TOP_CHOICES = [("vented", "Vented"), ("solid", "Solid"), ("fans", "Fans"),
               ("brush", "Brush"), ("none", "None")]
#: ``plate`` is a 2-post frame's floor plate; ``none`` stands on the frame alone.
BASE_CHOICES = [("plinth", "Plinth"), ("casters", "Casters"), ("feet", "Feet"),
                ("plate", "Base plate"), ("none", "None")]

#: The named colours, as the drawn rack paints them.
COLOURS = {"black": "#1b1c1e", "grey": "#c9ccce", "white": "#f2f2f0"}
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")

#: Every Look field, in the order forms and the API list them.
LOOK_FIELDS = ("frame", "rail_depth_mm", "front_door", "rear_door", "hinge",
               "side_panels", "top", "base", "colour", "kit", "blanking_fill")
#: A rack with no type and no override of its own draws these.
DEFAULTS = {"frame": "cabinet", "rail_depth_mm": None, "front_door": "perforated",
            "rear_door": "split-perforated", "hinge": "left", "side_panels": True,
            "top": "vented", "base": "plinth", "colour": "black", "kit": None,
            "blanking_fill": False}
#: Frames with doors and side panels.
ENCLOSED = ("cabinet", "wall-cabinet")
RAIL_DEPTH_RANGE = (100, 2000)


def clean_colour(value) -> str:
    """A colour as stored: a named one, or ``#rrggbb`` in lower case. Raises
    ValueError otherwise."""
    v = str(value or "").strip().lower()
    if v in COLOURS:
        return v
    if _HEX.match(v):
        return v
    raise ValueError(f"One of {', '.join(COLOURS)}, or a hex colour like #1b1c1e.")


def colour_hex(value: str) -> str:
    return COLOURS.get(value, value) if value else COLOURS["black"]


def resolve(rack) -> dict:
    """``{field: value}`` for every Look field of ``rack``: its own value,
    else its type's, else the default - plus ``inherited`` (the fields that
    came from the type or the defaults). ``kit`` is the RackKit row or None."""
    rt = rack.rack_type if rack.rack_type_id else None
    out: dict = {}
    inherited: list[str] = []
    for f in LOOK_FIELDS:
        own = getattr(rack, f)
        if own is not None and own != "":
            out[f] = own
            continue
        inherited.append(f)
        typed = getattr(rt, f) if rt is not None else None
        out[f] = typed if typed is not None and typed != "" else DEFAULTS[f]
    out["inherited"] = inherited
    return out


def look_geo(rack, kit_url=None) -> dict:
    """The resolved Look as the 3D room reads it (api.scene_geo.rack_geo):
    the colour as hex, the kit as its drawing doc (``kit_url(kit)``)."""
    look = resolve(rack)
    kit = look.pop("kit")
    look.pop("inherited")
    look["colour"] = colour_hex(look["colour"])
    look["kit"] = kit_url(kit) if (kit is not None and kit_url is not None) else None
    return look


def validate_rack_colour(value):
    """Model validator for ``colour``: blank (a rack inheriting) or
    ``clean_colour``'s."""
    from django.core.exceptions import ValidationError

    if value in (None, ""):
        return
    try:
        clean_colour(value)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
