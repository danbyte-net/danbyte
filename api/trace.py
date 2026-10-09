"""End-to-end cable trace.

A generic BFS over *termination points* - any of the eight cable-termination
kinds (see api/cable_points.py). Two steps drive it:

  * ``cable_step``   - from a point, find its cable and the opposite-end points
                       (handles breakout fan-out).
  * ``through_step`` - follow an internal pass-through (patch-panel front↔rear,
                       PDU outlet→inlet). Interfaces, console, aux, and PDU
                       inlets are leaves.

Position is carried in the traversal state so multi-strand trunks stay
deterministic. The result is a React-Flow-ready ``{nodes, edges, complete}``
graph that the same canvas renders as the topology map.

A "point" is a tuple ``(kind, obj[, position])`` where ``kind`` is one of
``cable_points.POINT_ATTRS``. ``position`` is the strand: carried for rear
ports and for multi-position front ports (MPO, LC-duplex), where the strand
picks which rear position the connector continues on (#334). A simplex
front port has one strand, so it carries none.
"""
from __future__ import annotations

from .cable_points import NODE_PREFIX, POINT_ATTRS, strands_of, term_point


def _point(kind, obj, position: int = 1):
    """Build a point, keeping the strand only where it selects a path."""
    if kind == "rear_port":
        return ("rear_port", obj, position)
    if kind == "front_port" and obj is not None and (obj.positions or 1) > 1:
        return ("front_port", obj, position)
    return (kind, obj)


def point_from_termination(t, *, position: int = 1):
    kind, obj = term_point(t)
    return _point(kind, obj, position)


def _position(p) -> int:
    return p[2] if len(p) > 2 else 1


def _key(p) -> str:
    if len(p) > 2:
        return f"{NODE_PREFIX[p[0]]}:{p[1].id}:{p[2]}"
    return f"{NODE_PREFIX[p[0]]}:{p[1].id}"


def _node_id(p) -> str:
    return f"{NODE_PREFIX[p[0]]}:{p[1].id}"


def _termination_for(p):
    return p[1].terminations.first()


def _cable_step(p):
    """(cable, [opposite points]) or (None, [])."""
    t = _termination_for(p)
    if t is None:
        return None, []
    cable = t.cable
    pos = _position(p)
    others = []
    for ot in cable.terminations.all():
        if ot.id == t.id or ot.end == t.end:
            continue
        op = point_from_termination(ot, position=pos)
        if op[1] is not None:
            others.append(op)
    return cable, others


def _through_steps(p):
    """Every internal pass-through partner - empty for leaves / unmapped
    strands, one for 1:1 pass-throughs, N for a splitter rear port (the PON
    fan-out). Delegates to the shared strand walker."""
    position = _position(p)
    if p[0] == "front_port" and position > (p[1].positions or 1):
        # A trunk strand beyond the connector's fibres has no rear position
        # of its own - unmapped, never folded onto a neighbour's strand.
        return []
    out = []
    for kind, obj, pos in strands_of(p[0], p[1], position):
        if obj is None:
            continue  # structural mapping but the far port is missing
        out.append(_point(kind, obj, pos))
    return out


def trace(starts):
    """Run the trace from one or more start points. Returns
    ``{nodes, edges, complete}``."""
    from .topology_views import _status_mini

    nodes: dict = {}
    edges: dict = {}
    complete = True
    processed: set = set()

    def add_point(p):
        nid = _node_id(p)
        obj = p[1]
        # Most points hang off a Device; a power_feed hangs off a PowerPanel
        # instead (no `.device`). Group it under whichever container it has.
        d = getattr(obj, "device", None) or getattr(obj, "power_panel", None)
        cid = getattr(obj, "device_id", None) or getattr(obj, "power_panel_id", None)
        # A circuit end has neither: it belongs to a circuit, and the path ends
        # there - the far side of the circuit is the provider's, not ours.
        circuit = getattr(obj, "circuit", None)
        if nid not in nodes:
            nodes[nid] = {
                "id": nid,
                "type": p[0],
                "data": {
                    "name": (
                        f"Side {obj.term_side}" if circuit else obj.name
                    ),
                    "circuit_id": str(obj.circuit_id) if circuit else None,
                    "kind": p[0],
                    "device_name": d.name if d else (circuit.cid if circuit else ""),
                    "device_id": str(cid) if cid else None,
                    # Splitter inputs get a badge on the trace canvas.
                    "is_splitter": bool(getattr(obj, "is_splitter", False)),
                },
            }
        if d is None:
            return
        did = f"dev:{cid}"
        if did not in nodes:
            status = getattr(d, "status", None)
            dtype = getattr(d, "device_type", None)
            site = getattr(d, "site", None)
            nodes[did] = {
                "id": did,
                "type": "device",
                "data": {
                    "device_id": str(d.id),
                    "name": d.name,
                    "status": status.slug if status else None,
                    "status_display": status.name if status else "",
                    "status_mini": _status_mini(status, "device"),
                    "device_type": dtype.name if dtype else None,
                    "site": site.name if site else None,
                },
            }
        meid = f"m:{did}:{nid}"
        if meid not in edges:
            edges[meid] = {"id": meid, "source": did, "target": nid, "type": "membership", "data": {}}

    def add_cable_edge(cable, p, o):
        a, b = _node_id(p), _node_id(o)
        if f"c:{cable.id}:{b}:{a}" in edges:
            return
        eid = f"c:{cable.id}:{a}:{b}"
        edges[eid] = {
            "id": eid, "source": a, "target": b, "type": "cable",
            "data": {"cable_id": str(cable.id), "color": cable.color,
                     "cable_type": cable.type, "cable_label": cable.label,
                     "fiber_count": cable.fiber_count,
                     "status": cable.status.slug if cable.status_id else None},
        }

    def add_through_edge(o, thru):
        a, b = _node_id(o), _node_id(thru)
        if f"t:{b}:{a}" in edges or f"t:{a}:{b}" in edges:
            return
        edges[f"t:{a}:{b}"] = {"id": f"t:{a}:{b}", "source": a, "target": b, "type": "through", "data": {}}

    queue = list(starts)
    while queue:
        p = queue.pop()
        if _key(p) in processed:
            continue
        processed.add(_key(p))
        add_point(p)
        # Expand the popped point's own pass-throughs too. For 1:1 panels
        # this only re-finds where we came from (processed → no-op), but a
        # splitter rear port reached from ONE output must still fan back to
        # every sibling output - the shared-medium PON-tree semantic.
        for thru in _through_steps(p):
            add_point(thru)
            add_through_edge(p, thru)
            if _key(thru) not in processed:
                queue.append(thru)
        cable, others = _cable_step(p)
        if cable is None:
            continue
        for o in others:
            add_point(o)
            add_cable_edge(cable, p, o)
            if _key(o) not in processed:
                queue.append(o)
            thrus = _through_steps(o)
            if not thrus:
                # Both are ends of the path, not dangling strands: an interface
                # is the host side, a circuit end is the provider demarc.
                if o[0] not in ("interface", "circuit_termination"):
                    complete = False  # reached a panel strand with no mapping
                continue
            for thru in thrus:
                add_point(thru)
                add_through_edge(o, thru)
                if _key(thru) not in processed:
                    queue.append(thru)

    return {"nodes": list(nodes.values()), "edges": list(edges.values()), "complete": complete}
