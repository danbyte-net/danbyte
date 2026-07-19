"""Shared classification of cable termination *points*, used by both graph
builders (``api/trace.py`` and ``api/topology_views.py``) so they can't drift.

A ``CableTermination`` sets exactly one of eight point FKs. This module names
them once, gives each a stable node-id prefix and a visual family, and models
the internal *pass-through* between the two ends of a device that a cable run
should walk *through* (patch panel front↔rear, PDU outlet→inlet).

Pass-through asymmetry — deliberate, see plan Feature A2:

* ``front_port ↔ rear_port@position`` is 1:1 both ways (fixed index).
* ``power_outlet → power_port`` is deterministic (an outlet names its one
  inlet) so we walk it — a run into a PDU outlet continues upstream.
* ``power_port → power_outlet`` is **not** walked: one inlet feeds many
  outlets with no index to pick "the" one, so auto-picking would fabricate a
  path. The PDU stays a visible node instead (like a panel with a dangling
  strand).
* console / console-server / aux ports are intentional **leaves** — the cable
  terminates into that subsystem; there is nothing further to model.
"""
from __future__ import annotations

# One attr per point FK, in resolution order. Must list ALL of
# CableTermination.POINT_FIELDS — a missing kind makes term_point() return
# (None, None) and blows up _key()/NODE_PREFIX[None] downstream.
POINT_ATTRS = (
    "interface", "front_port", "rear_port", "console_port",
    "console_server_port", "power_port", "power_outlet", "aux_port",
    "power_feed",
)

# Visual family shown on stencil port rows / trace nodes.
KIND_OF = {
    "interface": "interface", "front_port": "front", "rear_port": "rear",
    "console_port": "console", "console_server_port": "console",
    "power_port": "power", "power_outlet": "power", "aux_port": "aux",
    "power_feed": "power",
}

# Stable node-id prefix per kind (keeps trace node ids collision-free).
NODE_PREFIX = {
    "interface": "if", "front_port": "fp", "rear_port": "rp",
    "console_port": "cp", "console_server_port": "csp",
    "power_port": "pp", "power_outlet": "po", "aux_port": "ap",
    "power_feed": "pfd",
}


def term_point(t):
    """(attr, obj) for the one point a termination sets, or (None, None)."""
    for attr in POINT_ATTRS:
        obj = getattr(t, attr)
        if obj is not None:
            return attr, obj
    return None, None


def strands_of(kind, port, position=1):
    """Every opposite side of an internal pass-through — a list of
    ``(partner_kind, partner_obj, partner_position)`` tuples, empty for a
    leaf or an unmapped strand.

    1:1 pass-throughs (patch panels, PDU outlet→inlet) return one partner.
    A **splitter** rear port (``is_splitter``) broadcasts its single input
    position to *every* front port, so it returns them all — the fan-out
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

        if port.is_splitter:
            if position != 1:
                # A splitter input has exactly one position — a trunk strand
                # arriving beyond it is unmapped, not broadcast.
                return []
            # Broadcast: the one input position feeds every output.
            return [
                ("front_port", fp, 1)
                for fp in FrontPort.objects.filter(rear_port=port)
                .select_related("device")
                .order_by("name")
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
    """Single-partner view of :func:`strands_of` — the first partner or
    ``None``. Correct for every 1:1 pass-through; callers that must see a
    splitter's full fan-out use ``strands_of`` (and the topology collapse
    walk never crosses a splitter at all)."""
    strands = strands_of(kind, port, position)
    return strands[0] if strands else None
