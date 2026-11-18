"""How a device type sits on a rack's rails (docs/dcim/device-catalog.md →
Rack mounting, the export spec §3 and §8 "Rack mounting").

``DeviceType.rack_mount`` holds the YAML ``rack_mount:`` block, normalised::

    {"ears": true,
     "positions": {"front": 0, "mid": 220, "rear": 430},
     "default": "front",
     "rails": "none",
     "ear_mm": 2}

Each position is where the faceplate sits in front of the ear plane, in mm,
positive toward the rack front (a recessed front fitting is negative).
``reversed`` (spec v1.15) is the box turned round in its U, its rear panel
toward the rack front: its offset is the rear face's distance in front of
the ear plane. ``ear_mm``, optional, is the ear plate's thickness (0.5-10;
left out, the room takes 2). A type without ears has no positions. Null means not recorded: ears in the
front position, flush with the faceplate - how every type was drawn before.

``Device.ear_position`` picks one of the type's positions; blank takes the
type's default. ``mount_of(device)`` answers what the 3D rack needs: whether
the device has ears and how far its faceplate stands in front of the rail.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError

POSITIONS = ("front", "mid", "rear", "reversed")
RAILS = ("none", "fixed", "sliding")
#: The largest offset a position may give, either way (mm).
OFFSET_MAX_MM = 2000
#: An ear plate's thickness the block may give (mm), and the room's default.
EAR_MM_MIN, EAR_MM_MAX, EAR_MM_DEFAULT = 0.5, 10, 2


def normalise(raw) -> dict | None:
    """The stored shape of a ``rack_mount`` block, or None for none. Raises
    ValidationError (keyed by sub-field) for a block that can't be used."""
    if raw in (None, "", {}):
        return None
    if not isinstance(raw, dict):
        raise ValidationError("A mapping: ears, positions, default, rails, ear_mm.")
    errors: dict[str, str] = {}
    unknown = sorted(set(map(str, raw)) - {"ears", "positions", "default", "rails", "ear_mm"})
    if unknown:
        errors["rack_mount"] = f"Not a key Danbyte reads: {', '.join(unknown)}."
    ears = raw.get("ears", True)
    if not isinstance(ears, bool):
        errors["ears"] = "True or false."
        ears = True
    rails = raw.get("rails") or "none"
    if rails not in RAILS:
        errors["rails"] = f"One of {', '.join(RAILS)}."
    positions: dict[str, int] = {}
    got = raw.get("positions")
    if got not in (None, {}):
        if not isinstance(got, dict):
            errors["positions"] = "A mapping of front, mid, rear, reversed to mm."
        else:
            for k, v in got.items():
                if k not in POSITIONS:
                    errors["positions"] = f"{k!r} is not one of {', '.join(POSITIONS)}."
                    continue
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not (
                        -OFFSET_MAX_MM <= v <= OFFSET_MAX_MM):
                    errors["positions"] = (f"{k}: a distance in mm within "
                                           f"±{OFFSET_MAX_MM}.")
                    continue
                positions[k] = round(v)
    ear_mm = raw.get("ear_mm")
    if ear_mm is not None:
        if isinstance(ear_mm, bool) or not isinstance(ear_mm, (int, float)) or not (
                EAR_MM_MIN <= ear_mm <= EAR_MM_MAX):
            errors["ear_mm"] = f"A plate thickness of {EAR_MM_MIN}-{EAR_MM_MAX} mm."
        elif not ears:
            errors["ear_mm"] = "A type without ears has no ear plates."
        else:
            ear_mm = round(float(ear_mm), 1)
    if not ears and positions:
        errors["positions"] = "A type without ears has no ear positions."
    if ears and not positions:
        positions = {"front": 0}
    default = raw.get("default")
    if default in (None, ""):
        default = next((p for p in POSITIONS if p in positions), "") if ears else ""
    elif not ears:
        errors["default"] = "A type without ears has no default position."
    elif default not in positions:
        errors["default"] = f"Pick one of its positions: {', '.join(order(positions))}."
    if errors:
        raise ValidationError(errors)
    out = {"ears": ears, "positions": {p: positions[p] for p in order(positions)},
           "default": default, "rails": rails}
    if ear_mm is not None:
        out["ear_mm"] = ear_mm
    return out


def order(positions) -> list[str]:
    return [p for p in POSITIONS if p in positions]


def positions_of(dt) -> list[str]:
    """The ear positions a type offers (front only when not recorded)."""
    block = getattr(dt, "rack_mount", None) if dt is not None else None
    if not block:
        return ["front"]
    if not block.get("ears", True):
        return []
    return order(block.get("positions") or {})


def check_ear_position(dt, value: str) -> str | None:
    """Why ``value`` can't be a device's ear position on type ``dt``, or None."""
    if not value:
        return None
    if value not in POSITIONS:
        return f"One of {', '.join(POSITIONS)}, or blank for the type's default."
    offered = positions_of(dt)
    if not offered:
        return "This device type has no rack ears."
    if value not in offered:
        return f"This device type mounts {', '.join(offered)}."
    return None


def mount_of(dt, ear_position: str = "") -> dict:
    """``{ears, position, offset_mm, shift_mm, rails, reversed, ear_mm}`` for
    a device of type ``dt`` fitted at ``ear_position`` (blank: the type's
    default). ``offset_mm`` is the faceplate in front of the ear plane - for
    ``reversed`` the rear face, the box turned round; ``shift_mm`` how far
    the model's origin (the front of its ears in the front position, export
    spec §3) stands in front of the rail: the fitted position's offset less
    the front one's (0 reversed, which the room places by its rear face).
    ``ear_mm`` is the ear plate's thickness. An earless device's faceplate
    is the origin, on the rail plane (0), as is an unrecorded type's."""
    block = getattr(dt, "rack_mount", None) if dt is not None else None
    if not block:
        return {"ears": True, "position": "front", "offset_mm": 0, "shift_mm": 0,
                "rails": "none", "reversed": False, "ear_mm": EAR_MM_DEFAULT}
    if not block.get("ears", True):
        return {"ears": False, "position": "", "offset_mm": 0, "shift_mm": 0,
                "rails": block.get("rails") or "none", "reversed": False, "ear_mm": 0}
    positions = block.get("positions") or {"front": 0}
    pos = ear_position if ear_position in positions else (
        block.get("default") if block.get("default") in positions else order(positions)[0])
    front = int(positions.get("front", 0))
    reversed_ = pos == "reversed"
    return {"ears": True, "position": pos, "offset_mm": int(positions[pos]),
            "shift_mm": 0 if reversed_ else int(positions[pos]) - front,
            "rails": block.get("rails") or "none", "reversed": reversed_,
            "ear_mm": block.get("ear_mm") or EAR_MM_DEFAULT}


def device_mount(device) -> dict:
    return mount_of(device.device_type, getattr(device, "ear_position", "") or "")


def read_yaml(raw, notes: list[str]) -> dict | None:
    """A device type YAML's ``rack_mount:`` block for an import: the stored
    shape, or None (noted) when it can't be used."""
    try:
        return normalise(raw)
    except ValidationError as exc:
        detail = exc.message_dict if hasattr(exc, "error_dict") else {"": exc.messages}
        why = "; ".join(f"{k}: {' '.join(v)}" if k else " ".join(v) for k, v in detail.items())
        notes.append(f"rack_mount: {why} - dropped")
        return None
