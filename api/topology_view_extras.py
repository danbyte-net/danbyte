"""The saved-view keys the Diagram's virtual chassis and band cable sides
add to a topology view's ``state``, checked the way
``TopologyViewSerializer.validate_state`` checks the other Diagram keys:

* ``chassis`` - per virtual chassis id, how the Diagram draws it:
  ``{orient: "v" | "h", off: true, side: "T" | "B" | "L" | "R"}``, each
  optional (``v`` stacks the members top to bottom, ``h`` left to right;
  ``off`` draws them apart; ``side`` is the side its name strip runs
  along);
* ``filters.chassis`` - the virtual chassis placed on a hand-picked map,
  by id: their members are on it as they are now;
* ``filters.diagram.chassis`` - the view's stacking: ``off``, ``v`` or ``h``;
* ``zones_by_style.diagram[i].exits`` - a row's sides for its cables to
  other bands: ``v`` (top and bottom) or ``h`` (left and right).

A value outside those shapes raises ``ValidationError`` naming the key; the
id lists are de-duplicated in place.
"""
from __future__ import annotations

import re

from rest_framework import serializers

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{12}$"
)

#: How a chassis stacks: top to bottom, or left to right.
ORIENTS = ("v", "h")
#: The view's stacking: none, or the orientation a chassis takes by default.
STACKING = ("off", "v", "h")
#: A row's cables to other bands: top and bottom, or left and right.
EXITS = ("v", "h")
#: The side a stack's name strip runs along.
STRIP_SIDES = ("T", "B", "L", "R")
#: Chassis one view may give its own settings.
MAX_CHASSIS_SETTINGS = 10_000
#: Chassis one hand-picked map may place (the map's ``chassis`` query).
MAX_PLACED_CHASSIS = 1_000
_SETTING_KEYS = frozenset({"orient", "off", "side"})


def _choice(value, allowed, label):
    if value is not None and value not in allowed:
        raise serializers.ValidationError(
            f"{label} must be one of {', '.join(allowed)}"
        )


def _chassis_settings(settings):
    if not isinstance(settings, dict) or len(settings) > MAX_CHASSIS_SETTINGS:
        raise serializers.ValidationError(
            f"chassis must be an object (at most {MAX_CHASSIS_SETTINGS:,} "
            "virtual chassis)"
        )
    for key, entry in settings.items():
        if not _UUID_RE.match(key):
            raise serializers.ValidationError(
                f"chassis: '{key[:100]}' is not a virtual chassis id"
            )
        where = f"chassis.{key}"
        if not isinstance(entry, dict):
            raise serializers.ValidationError(f"{where} must be an object")
        unknown = sorted(set(entry) - _SETTING_KEYS)
        if unknown:
            raise serializers.ValidationError(
                f"{where}: unknown key(s) {', '.join(unknown)}"
            )
        _choice(entry.get("orient"), ORIENTS, f"{where}.orient")
        _choice(entry.get("side"), STRIP_SIDES, f"{where}.side")
        if "off" in entry and not isinstance(entry["off"], bool):
            raise serializers.ValidationError(f"{where}.off must be true or false")


def _placed(ids):
    if (
        not isinstance(ids, list)
        or len(ids) > MAX_PLACED_CHASSIS
        or not all(isinstance(x, str) and _UUID_RE.match(x) for x in ids)
    ):
        raise serializers.ValidationError(
            f"filters.chassis must be a list of at most {MAX_PLACED_CHASSIS:,} "
            "virtual chassis ids"
        )
    return list(dict.fromkeys(ids))


def validate_view_extras(state):
    """Check (and tidy) the virtual chassis and band cable side keys of a
    view's ``state`` - an object the caller has already checked is one."""
    if "chassis" in state:
        _chassis_settings(state["chassis"])
    filters = state.get("filters")
    if isinstance(filters, dict):
        if filters.get("chassis") is not None:
            filters["chassis"] = _placed(filters["chassis"])
        display = filters.get("diagram")
        if isinstance(display, dict):
            _choice(display.get("chassis"), STACKING, "filters.diagram.chassis")
    zones = state.get("zones_by_style")
    regions = zones.get("diagram") if isinstance(zones, dict) else None
    if isinstance(regions, list):
        for i, region in enumerate(regions):
            if isinstance(region, dict):
                _choice(
                    region.get("exits"), EXITS,
                    f"zones_by_style.diagram[{i}].exits",
                )
    return state
