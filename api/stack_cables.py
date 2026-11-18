"""A switch stack's rings outside the 3D views (docs/dcim/virtual-chassis.md).

The ring derived from member order (api.stack_links ``ring`` / ``power_ring``)
is computed here without a drawn model:

* ``derived_for_device`` - a device's stack ports that sit in a derived
  link, with the far end, for the interface and power-port pages and the
  device's port tabs (``/api/devices/<id>/stack-links/``);
* ``reconcile`` - a stack's **auto-connect**: with
  ``VirtualChassis.auto_connect_stack`` / ``auto_connect_power`` on, the
  derived rings are recorded as real cables (``Cable.auto_source`` ``stack``
  / ``stack-power``, ``auto_chassis`` the stack) and kept in step with the
  members. A port that already has another cable is skipped; a cable that
  is not auto is never touched; a switch turned off deletes only the
  cables still auto. Any edit of an auto cable through the API clears its
  mark (api.serializers.CableSerializer) and the stack lets it be.

``schedule`` queues a stack (or a device's stack) for reconcile when the
transaction commits; the receivers below call it on the saves that change
a ring - members, their positions, the stack's switches and topology, the
stack ports. ``manage.py reconcile_stack_cables`` runs every stack.
"""
from __future__ import annotations

import re
import threading
from decimal import Decimal

#: ``Cable.auto_source`` per link kind.
AUTO_SOURCE = {"data": "stack", "power": "stack-power"}

_LENGTH = re.compile(r"(?:^|[-_ ])(\d+(?:\.\d+)?)\s*(CM|M)=?$", re.IGNORECASE)


def part_length(part: str) -> tuple[Decimal, str] | None:
    """A cable part number's length when its suffix says it plainly -
    ``STACK-T1-50CM`` → (50, "cm"), ``STACK-T1-1M`` → (1, "m"),
    ``CAB-SPWR-150CM`` → (150, "cm") - else None."""
    m = _LENGTH.search((part or "").strip())
    if not m:
        return None
    return Decimal(m.group(1)), m.group(2).lower()


def _metres(length: tuple[Decimal, str]) -> Decimal:
    return length[0] / 100 if length[1] == "cm" else length[0]


def shortest_part(parts) -> tuple[str, tuple[Decimal, str] | None]:
    """The part number an auto cable is labelled with: the shortest of
    ``parts`` whose length reads, else the first, else ``""``."""
    parts = [str(p) for p in parts or [] if str(p).strip()]
    sized = [(p, part_length(p)) for p in parts]
    known = [x for x in sized if x[1] is not None]
    if known:
        return min(known, key=lambda x: _metres(x[1]))
    return (parts[0], None) if parts else ("", None)


# ── the members' stack ports ────────────────────────────────────────────────

def _ports(tenant, vc_ids, *, user=None):
    """``{(vc id, kind): [(device id, device name, visible, [(name, type,
    port id, cable id or None, port visible)…])…]}`` by member order, each
    member's ports in natural name order. ``user`` None: everything
    visible (the system's reconcile)."""
    from django.db.models import BooleanField, CharField, OuterRef, Q, Subquery, Value

    from .dcim_choices import STACK_INTERFACE_TYPES, STACK_POWER_PORT_TYPES
    from .models import CableTermination, Device, Interface, PowerPort
    from .natural import natural_key
    from .stack_links import _visible

    def vis(slug):
        if user is None:
            return Value(True, output_field=BooleanField())
        return _visible(user, tenant, slug)

    members = list(
        Device.objects.filter(tenant=tenant, virtual_chassis_id__in=vc_ids,
                              vc_position__isnull=False)
        .annotate(_vis=vis("device")).order_by("vc_position", "name")
        .values_list("id", "name", "virtual_chassis_id", "_vis"))
    ids = [m[0] for m in members]

    def comps(model, field, where, slug, kind):
        term = CableTermination.objects.filter(**{field: OuterRef("pk")}).order_by()
        return (model.objects.filter(where, device_id__in=ids)
                .annotate(_vis=vis(slug), _cable=Subquery(term.values("cable_id")[:1]),
                          _kind=Value(kind, output_field=CharField()))
                .order_by()
                .values_list("device_id", "name", "type", "id", "_cable", "_vis", "_kind"))

    rows = list(
        comps(Interface, "interface", Q(type__in=STACK_INTERFACE_TYPES) | Q(stack_port=True),
              "interface", "data")
        .union(comps(PowerPort, "power_port", Q(type__in=STACK_POWER_PORT_TYPES),
                     "powerport", "power"), all=True)) if ids else []
    by_dev: dict = {}
    for dev, name, ptype, pk, cable, pvis, kind in rows:
        by_dev.setdefault((dev, kind), []).append((name, ptype or "", pk, cable, bool(pvis)))
    for v in by_dev.values():
        v.sort(key=lambda p: natural_key(p[0]))
    out: dict = {}
    for dev, name, vc, dvis in members:
        for kind in ("data", "power"):
            out.setdefault((vc, kind), []).append(
                (dev, name, bool(dvis), by_dev.get((dev, kind), [])))
    return out


def _ring(members, kind: str, closed: bool) -> list[tuple]:
    """The derived links over ``members`` (``_ports``' rows) as
    ``[(a member, a port), (b member, b port)]``."""
    from .stack_links import power_ring, ring

    order = [(m[0], [p[0] for p in m[3]]) for m in members]
    pairs = ring(order, closed=closed) if kind == "data" else power_ring(order)
    by = {m[0]: m for m in members}
    out = []
    for (ad, ap), (bd, bp) in pairs:
        a = next(p for p in by[ad][3] if p[0] == ap)
        b = next(p for p in by[bd][3] if p[0] == bp)
        out.append(((by[ad], a), (by[bd], b)))
    return out


def _heads(tenant):
    """The tenant's cord parts, with or without a model: their part numbers
    are what a cable is labelled with."""
    from .models import AccessoryType

    return list(AccessoryType.objects.filter(tenant=tenant, kind="cord")
                .only("id", "vendor", "name", "kind", "fits", "parts"))


def _parts_for(accessories, ptype: str) -> list[str]:
    from .dcim_choices import STACK_INTERFACE_TYPES, STACK_POWER_PORT_TYPES
    from .stack_links import head_for

    if ptype not in STACK_INTERFACE_TYPES and ptype not in STACK_POWER_PORT_TYPES:
        return []
    head = head_for(accessories, ptype)
    return [str(p) for p in (head.parts or [])] if head is not None else []


def derived_for_device(device, user, tenant) -> dict:
    """``{port id: {kind, name, far: {device, device_name, port, id}, parts}}``
    for ``device``'s stack ports in a derived link (no stack port of the
    stack cabled for that kind, as the 3D views draw it), the far end one
    the reader may view; ``parts`` the head's part numbers, for Record
    cable. Three queries at most; none when the device is in no stack."""
    vc = device.virtual_chassis
    if vc is None or device.vc_position is None:
        return {}
    ports = _ports(tenant, [vc.pk], user=user)
    accessories = None
    out: dict = {}
    for kind in ("data", "power"):
        members = ports.get((vc.pk, kind), [])
        if any(p[3] is not None for m in members for p in m[3]):
            continue
        for (am, ap), (bm, bp) in _ring(members, kind, vc.stack_topology != "chain"):
            for (mine, mp), (far, fp) in (((am, ap), (bm, bp)), ((bm, bp), (am, ap))):
                if mine[0] != device.pk or not (far[2] and fp[4]):
                    continue
                if accessories is None:
                    accessories = _heads(tenant)
                out[str(mp[2])] = {
                    "kind": kind, "name": mp[0],
                    "far": {"device": str(far[0]), "device_name": far[1],
                            "port": fp[0], "id": str(fp[2])},
                    "parts": _parts_for(accessories, mp[1]) or _parts_for(accessories, fp[1]),
                }
    return out


# ── auto-connect ────────────────────────────────────────────────────────────

_state = threading.local()


def reconcile(vc) -> dict:
    """Bring ``vc``'s auto cables in line with its switches and members:
    ``{created, deleted}``. Idempotent; runs as the system within the
    stack's tenant, audited with the stack as the cause."""
    from django.db import transaction

    from audit.context import cause

    from .models import Cable, CableTermination

    created = deleted = 0
    _state.busy = True
    try:
        with cause(f"Auto-connect: stack {vc.name}"), transaction.atomic():
            ports = _ports(vc.tenant, [vc.pk])
            accessories = None
            for kind, on in (("data", vc.auto_connect_stack),
                             ("power", vc.auto_connect_power)):
                source = AUTO_SOURCE[kind]
                field = "interface" if kind == "data" else "power_port"
                auto = list(Cable.objects.filter(tenant=vc.tenant, auto_chassis=vc,
                                                 auto_source=source)
                            .prefetch_related("terminations"))
                have: dict = {}
                for c in auto:
                    ends = {t.end: getattr(t, f"{field}_id") for t in c.terminations.all()}
                    key = (ends.get("A"), ends.get("B"))
                    if on and None not in key and key not in have:
                        have[key] = c
                want = []
                if on:
                    for (_am, ap), (_bm, bp) in _ring(ports.get((vc.pk, kind), []), kind,
                                                      vc.stack_topology != "chain"):
                        want.append((ap, bp))
                keys = {(a[2], b[2]) for a, b in want}
                have = {k: c for k, c in have.items() if k in keys}
                kept = {c.pk for c in have.values()}
                for c in auto:
                    if c.pk not in kept:
                        c.delete()
                        deleted += 1
                for a, b in want:
                    if (a[2], b[2]) in have:
                        continue
                    if CableTermination.objects.filter(
                            **{f"{field}_id__in": [a[2], b[2]]}).exists():
                        continue  # a port with another cable is left as it is
                    if accessories is None:
                        accessories = _heads(vc.tenant)
                    label, length = shortest_part(
                        _parts_for(accessories, a[1]) or _parts_for(accessories, b[1]))
                    cable = Cable.objects.create(
                        tenant=vc.tenant, label=label,
                        type="power" if kind == "power" else "",
                        length=length[0] if length else None,
                        length_unit=length[1] if length else "m",
                        auto_source=source, auto_chassis=vc)
                    CableTermination.objects.create(cable=cable, end="A",
                                                    **{f"{field}_id": a[2]})
                    CableTermination.objects.create(cable=cable, end="B",
                                                    **{f"{field}_id": b[2]})
                    created += 1
    finally:
        _state.busy = False
    return {"created": created, "deleted": deleted}


def _pending() -> dict:
    p = getattr(_state, "pending", None)
    if p is None:
        p = _state.pending = {"vcs": set(), "devices": set()}
    return p


def schedule(*, vc_id=None, device_id=None) -> None:
    """Queue a reconcile of ``vc_id`` (or the stack ``device_id`` is or was
    in) for when the transaction commits; one run per stack per commit."""
    from django.db import transaction

    if getattr(_state, "busy", False):
        return
    p = _pending()
    if vc_id is not None:
        p["vcs"].add(vc_id)
    if device_id is not None:
        p["devices"].add(device_id)
    # One callback per call: ``_flush`` with nothing pending costs nothing,
    # and a rolled-back block drops its own callbacks.
    transaction.on_commit(_flush)


def _flush() -> None:
    from django.db.models import Q

    from .models import CableTermination, Device, VirtualChassis

    p = _pending()
    vcs, devices = set(p["vcs"]), set(p["devices"])
    p["vcs"].clear()
    p["devices"].clear()
    if not vcs and not devices:
        return
    if devices:
        vcs |= set(Device.objects.filter(pk__in=devices, virtual_chassis__isnull=False)
                   .values_list("virtual_chassis_id", flat=True))
        # A member that left: its old stack's auto cables still end on it.
        term = CableTermination.objects.filter(
            cable__auto_chassis__isnull=False, cable__auto_source__in=AUTO_SOURCE.values())
        vcs |= set(term.filter(Q(interface__device_id__in=devices)
                               | Q(power_port__device_id__in=devices))
                   .values_list("cable__auto_chassis_id", flat=True))
    stacks = (VirtualChassis.objects.filter(pk__in=vcs)
              .filter(Q(auto_connect_stack=True) | Q(auto_connect_power=True)
                      | Q(auto_cables__isnull=False))
              .distinct().select_related("tenant"))
    for vc in stacks:
        reconcile(vc)


# ── the saves that change a ring ────────────────────────────────────────────

def _on_chassis(sender, instance, **kwargs):
    schedule(vc_id=instance.pk)


def _on_device(sender, instance, **kwargs):
    schedule(vc_id=instance.virtual_chassis_id, device_id=instance.pk)


def _on_port(sender, instance, **kwargs):
    schedule(device_id=instance.device_id)


def _on_chassis_delete(sender, instance, **kwargs):
    """A stack going away leaves its auto cables as ordinary cables."""
    from .models import Cable

    Cable.objects.filter(auto_chassis=instance).update(auto_source="", auto_chassis=None)


def connect_signals() -> None:
    from django.db.models.signals import post_delete, post_save, pre_delete

    from .models import Device, Interface, PowerPort, VirtualChassis

    post_save.connect(_on_chassis, sender=VirtualChassis, dispatch_uid="stack_cables.vc")
    pre_delete.connect(_on_chassis_delete, sender=VirtualChassis,
                       dispatch_uid="stack_cables.vc.delete")
    for model in (Device, Interface, PowerPort):
        uid = f"stack_cables.{model.__name__}"
        handler = _on_device if model is Device else _on_port
        post_save.connect(handler, sender=model, dispatch_uid=f"{uid}.save")
        post_delete.connect(handler, sender=model, dispatch_uid=f"{uid}.delete")
