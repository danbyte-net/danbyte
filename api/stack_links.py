"""Switch stacks in the 3D views (docs/dcim/virtual-chassis.md → In 3D).

A stack is a ``VirtualChassis``; its members are devices with a
``vc_position``. ``stacks`` answers, for the devices one ``/api/device-leds/``
request draws and for one reader, which stack cables to draw between them:

* **recorded** - a cable between two members' stack ports, listed when the
  reader may view both interfaces and the cable. A stack port is an
  interface of a ``STACK_INTERFACE_TYPES`` type (the catalog's Stacking
  group: dedicated stacking ports) or one marked ``stack_port`` (a data
  port the stack runs over, its media type kept);
* **derived** - when no stack port of the stack is cabled at all, the ring
  by member order: a member's stack ports in natural name order, the first
  two its A and B; member *n*'s A to member *n+1*'s B, the last member back
  to the first (a two-member stack gets two cables, A1↔B2 and A2↔B1). A
  ``chain`` stack (``VirtualChassis.stack_topology``) leaves out the closing
  link. No name patterns; a member missing a port skips that link.

Recorded cables always win: one cabled stack port anywhere in the stack and
no ring is derived. A link is listed only when both ends are members drawn
in this request with a ``port:`` anchor for the port (api.port_plugs) -
members the reader may not view are never in the request, so never listed
and never linked to.

A derived link is a drawing aid, not data: it hides the ends' port covers
(``stack_covers``, applied by the client while stacks are shown) and counts
for nothing else - not utilisation, capacity or a port's connected state.

**StackPower** (``kind: "power"``): a member's power ports of a
``STACK_POWER_PORT_TYPES`` type (``cisco-stackpower``), the first two in
natural name order its A and B. Recorded: a cable between two such ports of
the stack's members. Derived, when none is recorded: a ring by member order,
member *n*'s B to member *n+1*'s A and the last back to the first - in
rings of at most four (``POWER_RING_MAX``, Cisco's StackPower limit on the
C9300): members 1-4, 5-8, … each close their own ring, a lone last member
gets none. The data ring and the power ring are decided apart: a recorded
StackPower cable never stops the derived data ring, nor the other way.

Each end seats a stack-cable head when the tenant has one. A dedicated
stacking port takes an accessory type of ``kind: cord`` whose ``fits`` names
its type (export spec §13), the one whose ``parts`` lists a recorded cable's
label first, else the first by vendor and name; a port of a generic
family type (``cisco-stackwise``) without an exact fit takes one that fits
a member of the family (``STACK_TYPE_FAMILIES``). A marked data port takes
what any cabled port of its type takes (api.port_plugs ``stack``): a DAC
head, an optic and its cord, an RJ45 plug. The run is drawn between the heads' ``cable``
empties, or between the port anchors when there is none.

Query cost: nothing when no drawn device is a stack member; otherwise two
queries (the stacks' members, their stack ports and StackPower ports in
one) and one more for the cables when any of them is cabled.
"""
from __future__ import annotations

import re

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _visible(user, tenant, slug):
    """An annotation: whether the reader may view the row (api.led_state's
    pattern - one query, no second scoped one)."""
    from django.db.models import BooleanField, Case, Value, When

    from auth_api import rbac

    q = True if getattr(user, "is_superuser", False) else rbac.row_filter(
        user, tenant, slug, "view")
    if q is None:
        return Value(False, output_field=BooleanField())
    if q is True:
        return Value(True, output_field=BooleanField())
    return Case(When(q, then=Value(True)), default=Value(False),
                output_field=BooleanField())


#: Metres per ``Cable.length_unit``.
_UNIT_M = {"m": 1.0, "cm": 0.01, "ft": 0.3048, "in": 0.0254}


def _metres(length, unit) -> float | None:
    """A cable's length in metres, or None when it has none."""
    if length is None or length <= 0:
        return None
    return round(float(length) * _UNIT_M.get(unit or "m", 1.0), 4)


def head_for(accessories, port_type: str, label: str = ""):
    """The stack-cable head for a stack port of ``port_type``: a ``kind:
    cord`` part that fits it - the one whose ``parts`` lists ``label`` (a
    recorded cable's) first, else the first by vendor and name - or None.

    A port of a generic family type (``cisco-stackwise``,
    ``STACK_TYPE_FAMILIES``) with no exact fit takes a part that fits a
    member of the family, in the family's order (480 before 1T before
    320…); a part named by ``label`` wins among them too."""
    from .dcim_choices import STACK_TYPE_FAMILIES
    from .port_plugs import _by_name, part_key

    t = (port_type or "").strip().lower()
    cords = [a for a in accessories if a.kind == "cord"]

    def fitting(slug):
        return sorted((a for a in cords if slug in (a.fits or [])), key=_by_name)

    tiers = [fitting(t)]
    if not tiers[0]:
        tiers = [fitting(m) for m in STACK_TYPE_FAMILIES.get(t, ())]
    fit = [a for tier in tiers for a in tier]
    if not fit:
        return None
    key = part_key(label) if label else ""
    if key:
        for a in fit:
            if any(part_key(str(p)) == key for p in (a.parts or [])):
                return a
    return fit[0]


def ring(members: list[tuple[str, list[str]]], *, closed: bool = True,
         ) -> list[tuple[tuple, tuple]]:
    """The derived ring over ``members`` - ``[(device id, [stack port names
    in order])]`` in member order - as ``[((a device, a port), (b device,
    b port))]``: member *n*'s first port (A) to member *n+1*'s second (B),
    and, ``closed``, the last back to the first (a chain stops at the last).
    A member without the port skips that link."""
    out = []
    n = len(members)
    if n < 2:
        return out
    for i in range(n if closed else n - 1):
        a_dev, a_ports = members[i]
        b_dev, b_ports = members[(i + 1) % n]
        if len(a_ports) < 1 or len(b_ports) < 2:
            continue
        out.append(((a_dev, a_ports[0]), (b_dev, b_ports[1])))
    return out


#: The most members one StackPower ring joins (Cisco: four on the C9300).
POWER_RING_MAX = 4


def power_ring(members: list[tuple[str, list[str]]], *, size: int = POWER_RING_MAX,
               ) -> list[tuple[tuple, tuple]]:
    """The derived StackPower rings over ``members`` - ``[(device id,
    [StackPower port names in order])]`` in member order: split into rings
    of at most ``size`` members, each member *n*'s second port (B) to member
    *n+1*'s first (A), the last of a ring back to its first. A ring of one
    gets nothing; a member without the port skips that link."""
    out = []
    for start in range(0, len(members), size):
        group = members[start:start + size]
        n = len(group)
        if n < 2:
            continue
        for i in range(n):
            a_dev, a_ports = group[i]
            b_dev, b_ports = group[(i + 1) % n]
            if len(a_ports) < 2 or len(b_ports) < 1:
                continue
            out.append(((a_dev, a_ports[1]), (b_dev, b_ports[0])))
    return out


def _heads(accessories, maps, port_type: str, cable_type: str, label: str):
    """``(transceiver, cord)`` at one end: a dedicated stacking port's
    stack-cable head (``head_for``), else what a cabled data port of its
    type takes (api.port_plugs ``stack``)."""
    from .dcim_choices import STACK_INTERFACE_TYPES, STACK_POWER_PORT_TYPES
    from .port_plugs import stack

    if port_type in STACK_INTERFACE_TYPES or port_type in STACK_POWER_PORT_TYPES:
        return None, head_for(accessories, port_type, label)
    by_id, by_part = maps
    return stack(accessories, by_id, by_part, "interface", port_type, cable_type, True, None)


def stacks(devices, owners: dict, user, tenant, accessories=()) -> tuple[list, dict]:
    """``(stacks, per device)`` for ``devices`` (the request's, scoped to
    the reader; their ``_installed_parts`` loaded):

    ``stacks`` ``[{id, name, master, members: [{device, name, position}],
    links: [{a, b, kind, derived, cable, color, label, length_m, parts}]}]`` - each end
    ``{device, port, name, id}``, ``port`` the anchor as drawn, ``name`` and
    ``id`` the interface or power port; ``parts`` the head's part numbers
    (the lengths Record cable offers); ``length_m`` a recorded cable's
    length in metres (the drawn loop is sized to it) or null; ``kind`` ``data`` (a stack port's cable) or
    ``power`` (a StackPower cable);

    ``per device`` ``{device id: {stack, stack_plugs, stack_ends}}`` -
    ``stack`` ``{id, name, position, master, master_name}``,
    ``stack_plugs`` a plug row per link end (api.port_plugs' shape, the
    head as ``cord_part``, ``end`` the cable's side - ``a`` or ``b``: a
    recorded cable's termination, a derived link's A or B end - for the
    head's ``END_BAND``), ``stack_ends`` ``{port name: derived}``."""
    from django.db.models import CharField, OuterRef, Q, Subquery, Value

    from .dcim_choices import STACK_INTERFACE_TYPES, STACK_POWER_PORT_TYPES
    from .models import Cable, CableTermination, Device, Interface, PowerPort
    from .natural import natural_key
    from .port_plugs import _part_doc, _wanted, may_view_types, part_maps

    devices = list(devices)
    vc_ids = {d.virtual_chassis_id for d in devices if d.virtual_chassis_id}
    if not vc_ids:
        return [], {}
    drawn = {str(d.id): d for d in devices}

    # Every member of the stacks, in or out of the request: the order the
    # ring follows; the reader's visibility says who is listed.
    rows = list(
        Device.objects.filter(tenant=tenant, virtual_chassis_id__in=vc_ids,
                              virtual_chassis__tenant=tenant)
        .annotate(_vis=_visible(user, tenant, "device"))
        .order_by()
        .values_list("id", "name", "vc_position", "virtual_chassis_id",
                     "virtual_chassis__name", "virtual_chassis__master_id",
                     "virtual_chassis__stack_topology", "_vis"))
    member_ids = [r[0] for r in rows]

    def stack_ports_of(model, field, where, slug, kind):
        """A component's stack ports as value rows, each with its first
        cable and side; ``kind`` the link kind they make."""
        term = CableTermination.objects.filter(**{field: OuterRef("pk")}).order_by()
        return (model.objects.filter(where, device_id__in=member_ids)
                .annotate(_vis=_visible(user, tenant, slug),
                          _cable=Subquery(term.values("cable_id")[:1]),
                          _cend=Subquery(term.values("end")[:1]),
                          _kind=Value(kind, output_field=CharField()))
                .order_by()
                .values_list("device_id", "name", "type", "_vis", "_cable", "_cend", "_kind",
                             "id"))

    # Data stack ports and StackPower ports in one query (UNION ALL).
    comps = list(
        stack_ports_of(Interface, "interface",
                       Q(type__in=STACK_INTERFACE_TYPES) | Q(stack_port=True),
                       "interface", "data")
        .union(stack_ports_of(PowerPort, "power_port",
                              Q(type__in=STACK_POWER_PORT_TYPES), "powerport", "power"),
               all=True))

    ports: dict[tuple, list] = {}
    # The cable's side at each cabled stack port: which band colour it takes.
    sides: dict[tuple, str] = {}
    for dev_id, name, ptype, vis, cable, cend, kind, pk in comps:
        ports.setdefault((str(dev_id), kind), []).append(
            (name, ptype or "", bool(vis), cable, str(pk)))
        if cable is not None and cend:
            sides[(str(dev_id), kind, name)] = cend.lower()
    for v in ports.values():
        v.sort(key=lambda p: natural_key(p[0]))

    cabled = {row[4] for row in comps if row[4] is not None}
    cables: dict = {}
    if cabled:
        from auth_api import rbac

        qs = Cable.objects.filter(tenant=tenant, pk__in=cabled)
        if not getattr(user, "is_superuser", False):
            qs = rbac.restrict_queryset(qs, user, tenant, "cable", "view")
        cables = {c: (color, ctype, label, _metres(length, unit))
                  for c, color, ctype, label, length, unit in
                  qs.order_by().values_list("id", "color", "type", "label",
                                            "length", "length_unit")}

    # Where each drawn member's stack ports sit on its model: interfaces
    # for data links, power ports for StackPower.
    link_kind = {"interface": "data", "power-port": "power"}
    anchors: dict[str, dict] = {}
    for key, d in drawn.items():
        if d.virtual_chassis_id:
            anchors[key] = {(link_kind[kind], comp): name for bay, name, kind, comp
                            in _wanted(d, owners.get(d.id))
                            if bay is None and kind in link_kind}

    by_vc: dict = {}
    for dev_id, name, pos, vc_id, vc_name, master_id, topology, vis in rows:
        s = by_vc.setdefault(vc_id, {"name": vc_name, "master": master_id,
                                     "closed": topology != "chain", "all": []})
        s["all"].append((str(dev_id), name, pos, bool(vis)))

    shared = may_view_types(user, tenant)
    maps = part_maps(accessories) if accessories else ({}, {})
    out_stacks: list = []
    per: dict = {}
    for vc_id, s in sorted(by_vc.items(), key=lambda kv: natural_key(kv[1]["name"])):
        members = sorted((m for m in s["all"] if m[2] is not None), key=lambda m: m[2])
        # The request's devices are the reader's already.
        visible = [m for m in members if m[3] or m[0] in drawn]
        names = {m[0]: m[1] for m in visible}
        master = str(s["master"]) if s["master"] and str(s["master"]) in names else None

        links: list = []
        for kind in ("data", "power"):
            stack_ports = {m[0]: ports.get((m[0], kind), []) for m in members}

            def end(dev, port, _a=anchors, _ports=stack_ports, _kind=kind):
                """``(device, anchor, port name, type, port id)`` when it can be
                drawn."""
                if dev not in drawn or dev not in _a:
                    return None
                hit = next((p for p in _ports.get(dev, []) if p[0] == port), None)
                anchor = _a[dev].get((_kind, port))
                if hit is None or not hit[2] or anchor is None:
                    return None
                return dev, anchor, port, hit[1], hit[4]

            # Recorded: a cable between two stack ports of this stack's members.
            by_cable: dict = {}
            for m in members:
                for name, _t, _vis, cable, _pk in stack_ports[m[0]]:
                    if cable is not None:
                        by_cable.setdefault(cable, []).append((m[0], name))
            if any(len(ends) == 2 for ends in by_cable.values()):
                for cable, ends in sorted(by_cable.items(), key=lambda kv: str(kv[0])):
                    if len(ends) != 2 or cable not in cables:
                        continue
                    a, b = (end(*e) for e in ends)
                    if a and b:
                        color, ctype, label, metres = cables[cable]
                        links.append((a, b, False, cable, color, ctype, label or "", kind,
                                      metres))
                continue
            order = [(m[0], [p[0] for p in stack_ports[m[0]]]) for m in members]
            derived = (ring(order, closed=s["closed"]) if kind == "data"
                       else power_ring(order))
            for (ad, ap), (bd, bp) in derived:
                a, b = end(ad, ap), end(bd, bp)
                if a and b:
                    links.append((a, b, True, None, "", "", "", kind, None))

        if not any(m[0] in drawn for m in visible):
            continue
        link_docs = [{
                "a": {"device": a[0], "port": a[1], "name": a[2], "id": a[4]},
                "b": {"device": b[0], "port": b[1], "name": b[2], "id": b[4]},
                "kind": kind,
                "derived": derived,
                "cable": str(cable) if cable else None,
                "color": color.lower() if _HEX.match(color or "") else None,
                "label": label,
                "length_m": metres,
                "parts": [],
            } for a, b, derived, cable, color, _ct, label, kind, metres in links]
        out_stacks.append({
            "id": str(vc_id), "name": s["name"], "master": master,
            "members": [{"device": m[0], "name": m[1], "position": m[2]} for m in visible],
            "links": link_docs,
        })
        for m in visible:
            if m[0] in drawn:
                per[m[0]] = {"stack": {
                    "id": str(vc_id), "name": s["name"], "position": m[2],
                    "master": master == m[0],
                    "master_name": names.get(master) if master else None,
                }, "stack_plugs": [], "stack_ends": {}}
        for doc, (a, b, derived, _cable, color, ctype, label, kind, _m) in zip(
                link_docs, links, strict=True):
            for side, (dev, anchor, port, ptype, _pk) in (("a", a), ("b", b)):
                if not derived:
                    side = sides.get((dev, kind, port), side)
                module, head = (_heads(accessories, maps, ptype, ctype, label)
                                if accessories else (None, None))
                if head is not None and not doc["parts"]:
                    doc["parts"] = [str(p) for p in (head.parts or [])]
                entry = per[dev]
                entry["stack_ends"][port] = derived
                entry["stack_plugs"].append({
                    "port": anchor, "bay": None, "name": port, "port_type": ptype,
                    "cabled": not derived,
                    "color": color.lower() if _HEX.match(color or "") else None,
                    "cable_type": ctype or "", "transceiver": None,
                    "transceiver_part": (_part_doc(module, drawn[dev], shared)
                                         if module else None),
                    "cord_part": (_part_doc(head, drawn[dev], shared, cable=True)
                                  if head else None),
                    "derived": derived,
                    "end": side,
                })
    for entry in per.values():
        entry["stack_plugs"].sort(key=lambda r: r["port"])
    return out_stacks, per
