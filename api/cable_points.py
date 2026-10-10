"""Shared classification of cable termination *points*, used by both graph
builders (``api/trace.py`` and ``api/topology_views.py``) so they can't drift.

A ``CableTermination`` sets exactly one of eight point FKs. This module names
them once, gives each a stable node-id prefix and a visual family, and models
the internal *pass-through* between the two ends of a device that a cable run
should walk *through* (patch panel front↔rear, PDU outlet→inlet).

Pass-through asymmetry - deliberate, see plan Feature A2:

* ``front_port ↔ rear_port@position`` is 1:1 both ways (fixed index).
* ``power_outlet → power_port`` is deterministic (an outlet names its one
  inlet) so we walk it - a run into a PDU outlet continues upstream.
* ``power_port → power_outlet`` is **not** walked: one inlet feeds many
  outlets with no index to pick "the" one, so auto-picking would fabricate a
  path. The PDU stays a visible node instead (like a panel with a dangling
  strand).
* console / console-server / aux ports are intentional **leaves** - the cable
  terminates into that subsystem; there is nothing further to model.
"""
from __future__ import annotations

# One attr per point FK, in resolution order. Must list ALL of
# CableTermination.POINT_FIELDS - a missing kind makes term_point() return
# (None, None) and blows up _key()/NODE_PREFIX[None] downstream.
POINT_ATTRS = (
    "interface", "front_port", "rear_port", "console_port",
    "console_server_port", "power_port", "power_outlet", "aux_port",
    "power_feed", "circuit_termination",
)

# Visual family shown on stencil port rows / trace nodes.
KIND_OF = {
    "interface": "interface", "front_port": "front", "rear_port": "rear",
    "console_port": "console", "console_server_port": "console",
    "power_port": "power", "power_outlet": "power", "aux_port": "aux",
    "power_feed": "power", "circuit_termination": "circuit",
}

# Stable node-id prefix per kind (keeps trace node ids collision-free).
NODE_PREFIX = {
    "interface": "if", "front_port": "fp", "rear_port": "rp",
    "console_port": "cp", "console_server_port": "csp",
    "power_port": "pp", "power_outlet": "po", "aux_port": "ap",
    "power_feed": "pfd", "circuit_termination": "ct",
}


# What a cable may join, end to end (#378): each kind and the kinds its far
# end may be. Patch-panel front/rear ports carry any signal through, power
# only runs outlet or feed into an inlet, and console ports meet console
# server ports. Aux ports (USB, video) meet each other, a panel, and the
# console kinds - a USB console lead.
_SIGNAL_PATCH = frozenset({"front_port", "rear_port"})
COMPATIBLE_ENDS = {
    "interface": frozenset({"interface", "circuit_termination"}) | _SIGNAL_PATCH,
    "front_port": frozenset({
        "interface", "console_port", "console_server_port", "aux_port",
        "circuit_termination",
    }) | _SIGNAL_PATCH,
    "console_port": frozenset({"console_server_port", "aux_port"}) | _SIGNAL_PATCH,
    "console_server_port": frozenset({"console_port", "aux_port"}) | _SIGNAL_PATCH,
    "aux_port": frozenset({"aux_port", "console_port", "console_server_port"})
    | _SIGNAL_PATCH,
    "circuit_termination": frozenset({"interface", "circuit_termination"}) | _SIGNAL_PATCH,
    "power_port": frozenset({"power_outlet", "power_feed"}),
    "power_outlet": frozenset({"power_port"}),
    "power_feed": frozenset({"power_port"}),
}
COMPATIBLE_ENDS["rear_port"] = COMPATIBLE_ENDS["front_port"]


def compatible_ends(a: str, b: str) -> bool:
    """Whether a cable may join a port of kind ``a`` to one of kind ``b``."""
    return b in COMPATIBLE_ENDS.get(a, ())


def term_point(t):
    """(attr, obj) for the one point a termination sets, or (None, None)."""
    for attr in POINT_ATTRS:
        obj = getattr(t, attr)
        if obj is not None:
            return attr, obj
    return None, None


def strands_of(kind, port, position=1):
    """Every opposite side of an internal pass-through - a list of
    ``(partner_kind, partner_obj, partner_position)`` tuples, empty for a
    leaf or an unmapped strand.

    1:1 pass-throughs (patch panels, PDU outlet→inlet) return one partner.
    A **splitter** rear port (``is_splitter``) broadcasts its single input
    position to *every* front port, so it returns them all - the fan-out
    that makes PON trees traceable. The front→rear direction is always
    deterministic (one tuple), splitter or not.
    """
    if kind == "front_port":
        # A connector carries ``positions`` fibres; local fibre ``position``
        # (1-based) maps onto rear position start + (position − 1). Simplex
        # (positions=1, position=1) reduces to the old rear_port_position.
        rp_pos = port.rear_port_position + (position - 1)
        return [("rear_port", port.rear_port, rp_pos)]
    if kind == "rear_port":
        from .models import FrontPort
        from .natural import natural

        if port.is_splitter:
            if position != 1:
                # A splitter input has exactly one position - a trunk strand
                # arriving beyond it is unmapped, not broadcast.
                return []
            # Broadcast: the one input position feeds every output.
            return [
                ("front_port", fp, 1)
                for fp in FrontPort.objects.filter(rear_port=port)
                .select_related("device")
                .order_by(natural("name"))
            ]
        # The front port whose range [start … start+positions−1] covers this
        # rear position; the local fibre index within it continues the run.
        fp = (
            FrontPort.objects.filter(
                rear_port=port, rear_port_position__lte=position
            )
            .select_related("device")
            .order_by("-rear_port_position")
            .first()
        )
        if fp and fp.rear_port_position + (fp.positions or 1) - 1 >= position:
            return [("front_port", fp, position - fp.rear_port_position + 1)]
        return []
    if kind == "power_outlet":
        # Outlet → its named inlet (deterministic). The reverse is not walked.
        if port.power_port_id:
            return [("power_port", port.power_port, 1)]
        return []
    # interface / console / console-server / aux / power_port: leaves.
    return []


def strand_of(kind, port, position=1):
    """Single-partner view of :func:`strands_of` - the first partner or
    ``None``. Correct for every 1:1 pass-through; callers that must see a
    splitter's full fan-out use ``strands_of`` (and the topology collapse
    walk never crosses a splitter at all)."""
    strands = strands_of(kind, port, position)
    return strands[0] if strands else None
