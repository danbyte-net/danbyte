"""The saved-view keys the Diagram's virtual chassis and band cable sides,
and the Routing tab, add to a topology view's ``state``, checked the way
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
  other bands: ``v`` (top and bottom) or ``h`` (left and right);
* ``filters.routing`` - the Routing tab's display: ``mode`` (``simple`` |
  ``detailed``), ``layers`` (``{layer: bool}``, the line layers on or off),
  ``fields`` (its card lines, from ``ROUTING_FIELDS``), ``vrf`` (the table
  drawn: ``global``, ``all`` or a VRF id) and ``checks`` (the Checks chip
  on or off);
* ``zones_by_style.routing`` - its AS boxes and zones: plain zones (no
  bands) with a number box, a ``#rrggbb`` colour (or neutral) and, for an
  AS box, the ``asn`` it frames.

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
#: The Routing tab's card modes and card lines.
ROUTING_MODES = ("simple", "detailed")
ROUTING_FIELDS = ("role", "router_id", "asn", "loopback", "site", "primary_ip", "status")
_ROUTING_KEYS = frozenset({"mode", "layers", "fields", "vrf", "checks"})
#: ``filters.routing.vrf`` besides a VRF id.
ROUTING_TABLES = ("global", "all")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
#: Largest coordinate or size a routing box may have (as the Diagram's).
_MAX_COORD = 10_000_000


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


def _routing_display(display):
    from routing.topology_map import LAYERS

    if not isinstance(display, dict):
        raise serializers.ValidationError("filters.routing must be an object")
    unknown = sorted(set(display) - _ROUTING_KEYS)
    if unknown:
        raise serializers.ValidationError(
            f"filters.routing: unknown key(s) {', '.join(unknown)}"
        )
    _choice(display.get("mode"), ROUTING_MODES, "filters.routing.mode")
    layers = display.get("layers")
    if layers is not None and (
        not isinstance(layers, dict)
        or not all(k in LAYERS and isinstance(v, bool) for k, v in layers.items())
    ):
        raise serializers.ValidationError(
            f"filters.routing.layers must map {', '.join(LAYERS)} to true or false"
        )
    fields = display.get("fields")
    if fields is not None:
        if not isinstance(fields, list) or not all(f in ROUTING_FIELDS for f in fields):
            raise serializers.ValidationError(
                f"filters.routing.fields must be a list of {', '.join(ROUTING_FIELDS)}"
            )
        display["fields"] = list(dict.fromkeys(fields))
    vrf = display.get("vrf")
    if vrf is not None and not (
        isinstance(vrf, str) and (vrf in ROUTING_TABLES or _UUID_RE.match(vrf))
    ):
        raise serializers.ValidationError(
            "filters.routing.vrf must be global, all or a VRF id"
        )
    if "checks" in display and not isinstance(display["checks"], bool):
        raise serializers.ValidationError("filters.routing.checks must be true or false")


def _number(value, label, lo=None):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or value != value
        or abs(value) > _MAX_COORD
        or (lo is not None and value < lo)
    ):
        raise serializers.ValidationError(f"{label} must be a number")


def _routing_regions(regions):
    """The Routing tab's AS boxes and zones; the list's length is bounded by
    the per-style check."""
    for i, region in enumerate(regions):
        where = f"zones_by_style.routing[{i}]"
        if not isinstance(region, dict):
            raise serializers.ValidationError(f"{where} must be an object")
        _choice(region.get("kind"), ("zone",), f"{where}.kind")
        for key in ("x", "y"):
            if key in region:
                _number(region[key], f"{where}.{key}")
        for key in ("w", "h"):
            if key in region:
                _number(region[key], f"{where}.{key}", lo=0)
        label = region.get("label")
        if label is not None and (not isinstance(label, str) or len(label) > 200):
            raise serializers.ValidationError(f"{where}.label must be text")
        asn = region.get("asn")
        if asn is not None and (type(asn) is not int or not 1 <= asn <= 4_294_967_295):
            raise serializers.ValidationError(f"{where}.asn must be an AS number")
        color = region.get("color")
        if color not in (None, ""):
            if not isinstance(color, str):
                raise serializers.ValidationError(
                    f"{where}.color must be a #rrggbb colour or null"
                )
            region["color"] = color.lower() if _COLOR_RE.match(color) else None


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
        if "routing" in filters:
            _routing_display(filters["routing"])
    zones = state.get("zones_by_style")
    if isinstance(zones, dict) and isinstance(zones.get("routing"), list):
        _routing_regions(zones["routing"])
    regions = zones.get("diagram") if isinstance(zones, dict) else None
    if isinstance(regions, list):
        for i, region in enumerate(regions):
            if isinstance(region, dict):
                _choice(
                    region.get("exits"), EXITS,
                    f"zones_by_style.diagram[{i}].exits",
                )
    return state
