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

Each end seats a stack-cable head when the tenant has one. A dedicated
stacking port takes an accessory type of ``kind: cord`` whose ``fits`` names
its type (export spec §13), the one whose ``parts`` lists a recorded cable's
label first, else the first by vendor and name. A marked data port takes
what any cabled port of its type takes (api.port_plugs ``stack``): a DAC
head, an optic and its cord, an RJ45 plug. The run is drawn between the heads' ``cable``
empties, or between the port anchors when there is none.

Query cost: nothing when no drawn device is a stack member; otherwise two
queries (the stacks' members, their stack ports) and one more for the
cables when a stack port is cabled.
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


def head_for(accessories, port_type: str, label: str = ""):
    """The stack-cable head for a stack port of ``port_type``: a ``kind:
    cord`` part that fits it - the one whose ``parts`` lists ``label`` (a
    recorded cable's) first, else the first by vendor and name - or None."""
    from .port_plugs import _by_name, part_key

    t = (port_type or "").strip().lower()
    fit = sorted((a for a in accessories if a.kind == "cord" and t in (a.fits or [])),
                 key=_by_name)
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


def _heads(accessories, maps, port_type: str, cable_type: str, label: str):
    """``(transceiver, cord)`` at one end: a dedicated stacking port's
    stack-cable head (``head_for``), else what a cabled data port of its
    type takes (api.port_plugs ``stack``)."""
    from .dcim_choices import STACK_INTERFACE_TYPES
    from .port_plugs import stack

    if port_type in STACK_INTERFACE_TYPES:
        return None, head_for(accessories, port_type, label)
    by_id, by_part = maps
    return stack(accessories, by_id, by_part, "interface", port_type, cable_type, True, None)


def stacks(devices, owners: dict, user, tenant, accessories=()) -> tuple[list, dict]:
    """``(stacks, per device)`` for ``devices`` (the request's, scoped to
    the reader; their ``_installed_parts`` loaded):

    ``stacks`` ``[{id, name, master, members: [{device, name, position}],
    links: [{a, b, derived, cable, color, label}]}]`` - each end ``{device,
    port, name}``, ``port`` the anchor as drawn and ``name`` the interface;

    ``per device`` ``{device id: {stack, stack_plugs, stack_ends}}`` -
    ``stack`` ``{id, name, position, master, master_name}``,
    ``stack_plugs`` a plug row per link end (api.port_plugs' shape, the
    head as ``cord_part``, ``end`` the cable's side - ``a`` or ``b``: a
    recorded cable's termination, a derived link's A or B end - for the
    head's ``END_BAND``), ``stack_ends`` ``{interface: derived}``."""
    from django.db.models import OuterRef, Q, Subquery

    from .dcim_choices import STACK_INTERFACE_TYPES
    from .models import Cable, CableTermination, Device, Interface
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
    ifaces = list(
        Interface.objects.filter(Q(type__in=STACK_INTERFACE_TYPES) | Q(stack_port=True),
                                 device_id__in=[r[0] for r in rows])
        .annotate(
            _vis=_visible(user, tenant, "interface"),
            _cable=Subquery(CableTermination.objects.filter(interface=OuterRef("pk"))
                            .order_by().values("cable_id")[:1]),
            _cend=Subquery(CableTermination.objects.filter(interface=OuterRef("pk"))
                           .order_by().values("end")[:1]),
        )
        .order_by()
        .values_list("device_id", "name", "type", "_vis", "_cable", "_cend"))

    ports: dict[str, list] = {}
    # The cable's side at each cabled stack port: which band colour it takes.
    sides: dict[tuple, str] = {}
    for dev_id, name, ptype, vis, cable, cend in ifaces:
        ports.setdefault(str(dev_id), []).append((name, ptype or "", bool(vis), cable))
        if cable is not None and cend:
            sides[(str(dev_id), name)] = cend.lower()
    for v in ports.values():
        v.sort(key=lambda p: natural_key(p[0]))

    cabled = {row[4] for row in ifaces if row[4] is not None}
    cables: dict = {}
    if cabled:
        from auth_api import rbac

        qs = Cable.objects.filter(tenant=tenant, pk__in=cabled)
        if not getattr(user, "is_superuser", False):
            qs = rbac.restrict_queryset(qs, user, tenant, "cable", "view")
        cables = {c: (color, ctype, label) for c, color, ctype, label in
                  qs.order_by().values_list("id", "color", "type", "label")}

    # Where each drawn member's interfaces sit on its model.
    anchors: dict[str, dict] = {}
    for key, d in drawn.items():
        if d.virtual_chassis_id:
            anchors[key] = {comp: name for bay, name, kind, comp
                            in _wanted(d, owners.get(d.id))
                            if bay is None and kind == "interface"}

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
        stack_ports = {m[0]: ports.get(m[0], []) for m in members}

        def end(dev, port, _a=anchors, _ports=stack_ports):
            """``(device, anchor, interface, type)`` when it can be drawn."""
            if dev not in drawn or dev not in _a:
                return None
            hit = next((p for p in _ports.get(dev, []) if p[0] == port), None)
            if hit is None or not hit[2] or port not in _a[dev]:
                return None
            return dev, _a[dev][port], port, hit[1]

        links: list = []
        # Recorded: a cable between two stack ports of this stack's members.
        by_cable: dict = {}
        for m in members:
            for name, _t, _vis, cable in stack_ports[m[0]]:
                if cable is not None:
                    by_cable.setdefault(cable, []).append((m[0], name))
        if any(len(ends) == 2 for ends in by_cable.values()):
            for cable, ends in sorted(by_cable.items(), key=lambda kv: str(kv[0])):
                if len(ends) != 2 or cable not in cables:
                    continue
                a, b = (end(*e) for e in ends)
                if a and b:
                    color, ctype, label = cables[cable]
                    links.append((a, b, False, cable, color, ctype, label or ""))
        else:
            for (ad, ap), (bd, bp) in ring([(m[0], [p[0] for p in stack_ports[m[0]]])
                                            for m in members], closed=s["closed"]):
                a, b = end(ad, ap), end(bd, bp)
                if a and b:
                    links.append((a, b, True, None, "", "", ""))

        if not any(m[0] in drawn for m in visible):
            continue
        out_stacks.append({
            "id": str(vc_id), "name": s["name"], "master": master,
            "members": [{"device": m[0], "name": m[1], "position": m[2]} for m in visible],
            "links": [{
                "a": {"device": a[0], "port": a[1], "name": a[2]},
                "b": {"device": b[0], "port": b[1], "name": b[2]},
                "derived": derived,
                "cable": str(cable) if cable else None,
                "color": color.lower() if _HEX.match(color or "") else None,
                "label": label,
            } for a, b, derived, cable, color, _ct, label in links],
        })
        for m in visible:
            if m[0] in drawn:
                per[m[0]] = {"stack": {
                    "id": str(vc_id), "name": s["name"], "position": m[2],
                    "master": master == m[0],
                    "master_name": names.get(master) if master else None,
                }, "stack_plugs": [], "stack_ends": {}}
        for a, b, derived, _cable, color, ctype, label in links:
            for side, (dev, anchor, iface, ptype) in (("a", a), ("b", b)):
                if not derived:
                    side = sides.get((dev, iface), side)
                module, head = (_heads(accessories, maps, ptype, ctype, label)
                                if accessories else (None, None))
                entry = per[dev]
                entry["stack_ends"][iface] = derived
                entry["stack_plugs"].append({
                    "port": anchor, "bay": None, "name": iface, "port_type": ptype,
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
