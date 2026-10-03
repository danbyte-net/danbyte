"""What a port's cable says, and the face-ports payload for many devices.

``cable_state`` is the utilization card's per-port vocabulary - free,
connected, reserved, marked - and ``far_end`` names what the cable reaches.
The faceplates, the 3D room and the rack's Rack view (#248) read both, so a
port reads the same everywhere.

``FacePortLoader`` resolves the photo-port markers (``api.face_ports``) of
many devices at once: each component relation is loaded once for every device
that needs it, with terminations, cable status, holds and far ends
prefetched, so a rack costs the same number of queries as one device. It
computes no SNMP drift - every entry's ``drift`` is null - because drift
costs queries per device; the single-device face-ports endpoint adds it.

``PeerScope`` blanks the far ends a caller may not see, and
``interface_state`` is one interface as the drawn faceplate reads it.
``FaceplateParts`` loads what else the drawn faceplate composes - installed
modules and the components a saved layout places - for many devices at once,
and ``snmp_observed`` says whose ports SNMP may have seen.
"""
from __future__ import annotations

from collections import defaultdict

from .face_ports import (
    FACE_PORT_KINDS,
    ComponentIndex,
    effective_image_ports,
    render_marker_name,
)

_TERMINATION_COMPONENTS = (
    "interface", "front_port", "rear_port", "console_port", "console_server_port",
    "power_port", "power_outlet", "aux_port", "power_feed", "circuit_termination",
)


def termination_component(term):
    """The component a cable termination sits on (exactly one FK is set)."""
    for name in _TERMINATION_COMPONENTS:
        comp = getattr(term, name, None)
        if comp is not None:
            return comp
    return None


def far_end_component(term):
    """The component at the other end of ``term``'s cable, or None when the
    cable ends nowhere yet. Reads the prefetched terminations."""
    if term is None:
        return None
    for other in term.cable.terminations.all():
        if other.pk == term.pk:
            continue
        return termination_component(other)
    return None


def far_end(term):
    """``{"device": name, "port": name}`` for the other end of ``term``'s
    cable, or None when the cable ends nowhere yet. Reads the prefetched
    terminations, so a list costs no query per row."""
    comp = far_end_component(term)
    if comp is None:
        return None
    device = getattr(comp, "device", None)
    return {
        "device": device.name if device is not None else "",
        "port": getattr(comp, "name", "") or "",
        # The far port's own printed label - what a marker prints for
        # "far-end port"; its name is never printed as a label.
        "port_label": getattr(comp, "label", "") or "",
    }


# Prefetch that lets ``far_end`` read the other end without a query per
# row, for the kinds a faceplate marker can carry.
FAR_END_PREFETCH = (
    "terminations__cable__terminations__interface__device",
    "terminations__cable__terminations__front_port__device",
    "terminations__cable__terminations__rear_port__device",
)

# Every kind a cable can end on: a PSU corded to a PDU outlet, a PDU inlet on
# a feed. A loader that must stay at a fixed number of queries needs them all;
# a kind no loaded cable reaches costs no query.
ALL_FAR_END_PREFETCH = (
    *FAR_END_PREFETCH,
    "terminations__cable__terminations__console_port__device",
    "terminations__cable__terminations__console_server_port__device",
    "terminations__cable__terminations__power_port__device",
    "terminations__cable__terminations__power_outlet__device",
    "terminations__cable__terminations__aux_port__device",
    "terminations__cable__terminations__power_feed",
    "terminations__cable__terminations__circuit_termination",
)

# What ``cable_state`` and a face-ports entry read on a cable-able component.
CABLED_PREFETCH = ("terminations__cable__status", "reservations", *ALL_FAR_END_PREFETCH)


def cable_state(comp, term) -> str:
    """free | connected | reserved | marked - the utilization card's
    vocabulary, per port, for the face-panel glow. Reserved covers both a
    planned cable and a direct PortReservation on an uncabled port; a real
    cable (or mark_connected) outranks the hold."""
    if term is not None:
        status = term.cable.status if term.cable_id else None
        if status is not None and status.slug == "planned":
            return "reserved"
        return "connected"
    if getattr(comp, "mark_connected", False):
        return "marked"
    if any(True for _ in comp.reservations.all()):
        return "reserved"
    return "free"


# ── face ports for many devices ─────────────────────────────────────────────

# Component relations whose rows terminate cables.
_CABLED_RELATIONS = frozenset(
    relation for relation, term_kind in FACE_PORT_KINDS.values() if term_kind is not None
)

# Power components no marker covers still resolve, as synthetic rear entries.
_SYNTHETIC_KINDS = ("power-port", "power-outlet")

_NO_COMPONENTS = ComponentIndex(())


def component_queryset(relation, device_ids):
    """The components of ``relation`` (``"interfaces"``, ``"power_ports"``…)
    on the given devices, with what a face-ports entry reads. Default (name)
    order, so each device's rows come in the order its own related manager
    gives them - the order the marker matching depends on."""
    from .models import Device

    model = Device._meta.get_field(relation).related_model
    qs = model.objects.filter(device_id__in=device_ids)
    if relation in _CABLED_RELATIONS:
        return qs.prefetch_related(*CABLED_PREFETCH)
    # A module bay's occupancy is the reverse Module relation; a part carries
    # a lifecycle status. Antennas carry neither.
    if relation == "module_bays":
        return qs.select_related("module__module_type")
    if any(f.name == "status" for f in model._meta.fields):
        return qs.select_related("status")
    return qs


def _markers(layout, side):
    markers = layout.get(side)
    return markers if isinstance(markers, list) else []


class FacePortLoader:
    """The resolved photo-port markers of ``devices`` - see the module
    docstring. Each device needs its ``device_type`` loaded.

    ``rows`` hands in relations the caller already loaded for every one of
    ``devices`` (``{"interfaces": [...]}``, built on ``component_queryset``),
    so a caller that reads the same rows for more does not load them twice.
    """

    def __init__(self, devices, rows=None):
        self.devices = list(devices)
        self._rows = dict(rows or {})
        needed = {FACE_PORT_KINDS[k][0] for k in _SYNTHETIC_KINDS}
        for device in self.devices:
            layout = effective_image_ports(device) or {}
            for marker in _markers(layout, "front") + _markers(layout, "rear"):
                kind = marker.get("kind", "interface") if isinstance(marker, dict) else ""
                if kind in FACE_PORT_KINDS:
                    needed.add(FACE_PORT_KINDS[kind][0])
        ids = [d.id for d in self.devices]
        self._indexes: dict[str, dict] = {}
        for relation in sorted(needed):
            if relation not in self._rows:
                self._rows[relation] = list(component_queryset(relation, ids)) if ids else []
            by_device: dict = defaultdict(list)
            for comp in self._rows[relation]:
                by_device[comp.device_id].append(comp)
            self._indexes[relation] = {
                device_id: ComponentIndex(comps) for device_id, comps in by_device.items()
            }

    def _index(self, relation, device_id) -> ComponentIndex:
        return self._indexes.get(relation, {}).get(device_id, _NO_COMPONENTS)

    def far_components(self):
        """The far end of every cabled row loaded - what a ``PeerScope``
        checks."""
        for relation, rows in self._rows.items():
            if relation not in _CABLED_RELATIONS:
                continue
            for comp in rows:
                far = far_end_component(next(iter(comp.terminations.all()), None))
                if far is not None:
                    yield far

    def payload(self, device, peer=far_end) -> dict:
        """``{"front": [...], "rear": [...]}`` for one device: every marker
        resolved to the device's real component, then the power components no
        marker covers as synthetic rear entries. ``peer`` turns a termination
        into its far end (``PeerScope.far_end`` blanks hidden ones)."""
        layout = effective_image_ports(device) or {}
        front = self._resolve(device, _markers(layout, "front"), peer)
        rear = self._resolve(device, _markers(layout, "rear"), peer)
        # Power components no photo marker covers still have to be clickable
        # and cable-able in the 3D room (a PDU strip has no photo at all, and
        # many rear photos never got their inlets marked). Emit them as
        # SYNTHETIC entries under "rear" - power lives on the back - keyed by
        # the component's own name, which is exactly the name the room's
        # synthetic quads carry. Component ids already claimed by a marker
        # (exact or tolerant) are skipped, so nothing resolves twice.
        claimed = {e["id"] for e in front + rear if e["id"]}
        for marker_kind in _SYNTHETIC_KINDS:
            relation, term_kind = FACE_PORT_KINDS[marker_kind]
            for comp in self._index(relation, device.id).components:
                if str(comp.id) in claimed:
                    continue
                term = next(iter(comp.terminations.all()), None)
                ctype = getattr(comp, "type", "")
                rear.append({
                    "marker": comp.name, "name": comp.name,
                    "kind": term_kind, "id": str(comp.id),
                    "connected": term is not None,
                    "cable_state": cable_state(comp, term),
                    "cable_id": str(term.cable_id) if term else None,
                    "enabled": True, "speed": "",
                    "type": ctype if isinstance(ctype, str) else "",
                    "status": None, "module": None,
                    "drift": None,
                })
        return {"front": front, "rear": rear}

    def _resolve(self, device, markers, peer) -> list:
        pos = device.vc_position
        out = []
        for m in markers:
            raw = m.get("name", "") if isinstance(m, dict) else ""
            kind = m.get("kind", "interface") if isinstance(m, dict) else ""
            name = render_marker_name(raw, pos)
            entry = {
                "marker": raw, "name": name, "kind": None, "id": None,
                "connected": False, "cable_id": None,
                # Enough for the shared port-state colouring (portState):
                # interfaces carry enabled/speed/type; others default on.
                "enabled": True, "speed": "", "type": "",
                # Hardware markers (inventory items): lifecycle status.
                "status": None,
                # Module-bay markers: the installed module, or null for an
                # empty slot. Occupancy is the whole point of drawing a bay
                # on the photo, so it rides along rather than costing the
                # client a request per bay.
                "module": None,
                # What SNMP saw differently, or null when they agree. Never
                # computed here; the single-device endpoint fills it in.
                "drift": None,
            }
            mapping = FACE_PORT_KINDS.get(kind)
            if mapping:
                relation, term_kind = mapping
                comp = self._index(relation, device.id).match(name)
                if comp is not None and kind == "module-bay":
                    # Module bay - reads occupied/empty, never cable-able.
                    # The reverse OneToOne raises (an AttributeError
                    # subclass) when the bay is free, so getattr → None.
                    mod = getattr(comp, "module", None)
                    entry.update({
                        "id": str(comp.id),
                        "module": {
                            "id": str(mod.id),
                            "module_type": {
                                "id": str(mod.module_type_id),
                                "name": mod.module_type.name,
                            },
                            "serial_number": mod.serial_number,
                        } if mod else None,
                    })
                elif comp is not None and term_kind is None:
                    # Inventory item (or antenna) - status-coloured, never
                    # cable-able. An antenna has no status.
                    s = getattr(comp, "status", None)
                    entry.update({
                        "name": comp.name,
                        "id": str(comp.id),
                        "status": {"id": str(s.id), "name": s.name, "color": s.color}
                        if s else None,
                    })
                elif comp is not None:
                    term = next(iter(comp.terminations.all()), None)
                    # Only interfaces carry a network-speed string; other
                    # kinds may have an int `speed` (power draw) - ignore it.
                    speed = getattr(comp, "speed", "")
                    ctype = getattr(comp, "type", "")
                    entry.update({
                        # The component's REAL name - after a rename the
                        # marker still resolves via marker_key, and the
                        # hover must say what the port is called NOW.
                        "name": comp.name,
                        "kind": term_kind,
                        "id": str(comp.id),
                        "connected": term is not None,
                        "cable_state": cable_state(comp, term),
                        "cable_id": str(term.cable_id) if term else None,
                        "enabled": bool(getattr(comp, "enabled", True)),
                        "speed": speed if isinstance(speed, str) else "",
                        "type": ctype if isinstance(ctype, str) else "",
                        # Real-world name, when it differs from the
                        # template-matching name ("X1-P1" on "Port 1").
                        "label": getattr(comp, "label", "") or "",
                        # What a port marker may print instead of the
                        # label: the cable's label or the far end.
                        "cable_label": (term.cable.label if term else "") or "",
                        "peer": peer(term),
                        "label_hidden": bool(getattr(comp, "hide_label", False)),
                        "label_color": getattr(comp, "label_color", "") or "",
                    })
            out.append(entry)
        return out


# ── who may see a far end ────────────────────────────────────────────────────

class PeerScope:
    """The far ends a caller may see, for one response.

    A peer names the device and port at the other end of a cable. It is kept
    when that device - or, for a PDU inlet on a feed, that power feed - is one
    the caller may view in the active tenant, and blanked otherwise (a circuit
    end, which names nothing, is blanked too). One query per kind, over every
    far end the response reaches.
    """

    def __init__(self, user, tenant, far_components):
        from auth_api import rbac

        from .models import Device, PowerFeed

        device_ids, feed_ids = set(), set()
        for comp in far_components:
            if isinstance(comp, PowerFeed):
                feed_ids.add(comp.pk)
            elif getattr(comp, "device_id", None) is not None:
                device_ids.add(comp.device_id)
        self._devices = self._visible(
            rbac, user, tenant, Device, "device", device_ids
        )
        self._feeds = self._visible(rbac, user, tenant, PowerFeed, "powerfeed", feed_ids)

    @staticmethod
    def _visible(rbac, user, tenant, model, slug, ids) -> set:
        if not ids or tenant is None:
            return set()
        qs = model.objects.filter(tenant=tenant, pk__in=ids)
        return set(
            rbac.restrict_queryset(qs, user, tenant, slug, "view").values_list("pk", flat=True)
        )

    def allows(self, comp) -> bool:
        from .models import PowerFeed

        if isinstance(comp, PowerFeed):
            return comp.pk in self._feeds
        device_id = getattr(comp, "device_id", None)
        return device_id is not None and device_id in self._devices

    def far_end(self, term):
        """``far_end(term)``, or None when the caller may not see it."""
        comp = far_end_component(term)
        if comp is None or not self.allows(comp):
            return None
        return far_end(term)


# ── one interface, as the drawn faceplate reads it ──────────────────────────

_TYPE_LABELS: dict = {}


def _type_label(value: str) -> str:
    """The interface type's display name; a custom value reads as itself."""
    if not _TYPE_LABELS:
        from .models import Interface

        field = Interface._meta.get_field("type")
        _TYPE_LABELS.update({k: str(v) for k, v in field.flatchoices})
    return _TYPE_LABELS.get(value, value)


def interface_state(iface, peer=far_end) -> dict:
    """What the drawn faceplate (cages, photo markers, the port hover card)
    reads off one interface, with its cable reduced to state, id, label and
    type. Reads the prefetches of ``component_queryset("interfaces", …)``
    plus ``vlan__zone`` / ``lag``, the caller's visible IPs
    (``api.visible_ips.assigned_ips_prefetch``), ``tags`` and a
    ``tagged_vlan_n`` count."""
    from .visible_ips import VISIBLE_IPS

    term = next(iter(iface.terminations.all()), None)
    cable = term.cable if term is not None else None
    vlan = iface.vlan
    zone = vlan.zone if vlan is not None else None
    tagged = getattr(iface, "tagged_vlan_n", None)
    return {
        "id": str(iface.id),
        "name": iface.name,
        "label": iface.label or "",
        "type": iface.type or "",
        "type_display": _type_label(iface.type or ""),
        "speed": iface.speed or "",
        "enabled": iface.enabled,
        "mode": iface.mode or "",
        "mark_connected": iface.mark_connected,
        "cable_state": cable_state(iface, term),
        "cable_id": str(term.cable_id) if term is not None else None,
        "cable_label": (cable.label if cable is not None else "") or "",
        "cable_type": (cable.type if cable is not None else "") or "",
        "peer": peer(term),
        "hide_label": iface.hide_label,
        "label_color": iface.label_color or "",
        "vlan": {
            "id": str(vlan.id), "vlan_id": vlan.vlan_id, "name": vlan.name,
            "color": vlan.color,
            "zone": {
                "id": str(zone.id), "name": zone.name,
                "color": zone.color, "text_color": zone.text_color,
            } if zone is not None else None,
        } if vlan is not None else None,
        "tagged_vlan_count": tagged if tagged is not None else iface.tagged_vlans.count(),
        "lag": {"id": str(iface.lag_id), "name": iface.lag.name}
        if iface.lag_id is not None else None,
        "ip_addresses": [
            {"id": str(ip.id), "ip_address": ip.ip_address}
            for ip in getattr(iface, VISIBLE_IPS, ())
        ],
        "description": iface.description or "",
        "mac_address": iface.mac_address or "",
        "mtu": iface.mtu,
        "tags": [
            {"id": t.id, "name": t.name, "slug": t.slug, "color": t.color,
             "text_color": t.text_color}
            for t in iface.tags.all()
        ],
    }


# ── whose ports SNMP may have seen ──────────────────────────────────────────

def snmp_observed(devices, tenant) -> set:
    """The ids of ``devices`` whose ports SNMP may have observed - those the
    device SNMP view (``monitoring.vc_stack.stack_state``) can answer with
    interfaces: a device polled with interfaces, and any stack member, whose
    stack's poll may describe it. One query; a page asks for live port state
    only for these."""
    from monitoring.models import DeviceSnmp

    devices = list(devices)
    if not devices or tenant is None:
        return set()
    polled = set(
        DeviceSnmp.objects.filter(
            tenant=tenant, device_id__in=[d.id for d in devices], polled_at__isnull=False,
        )
        .exclude(interfaces=[])
        .values_list("device_id", flat=True)
    )
    return polled | {d.id for d in devices if d.virtual_chassis_id is not None}


# ── what else the drawn faceplate composes ──────────────────────────────────

# The kinds a saved faceplate layout can place besides interfaces, with the
# device relation and RBAC object type of each - the lists the device page
# loads with ``/api/console-ports/?device=`` and its siblings.
FACEPLATE_SLOT_KINDS = {
    "console-port": ("console_ports", "consoleport"),
    "console-server-port": ("console_server_ports", "consoleserverport"),
    "power-port": ("power_ports", "powerport"),
    "power-outlet": ("power_outlets", "poweroutlet"),
    "front-port": ("front_ports", "frontport"),
    "rear-port": ("rear_ports", "rearport"),
    "aux-port": ("aux_ports", "auxport"),
}


def faceplate_slot_kinds(doc) -> set[str]:
    """The non-interface kinds a faceplate document (a type's or a module
    type's ``faceplate``) places on either side."""
    kinds: set[str] = set()
    if not isinstance(doc, dict):
        return kinds
    for side in ("front", "rear"):
        groups = doc.get(side)
        for group in groups if isinstance(groups, list) else ():
            slots = group.get("slots") if isinstance(group, dict) else None
            for slot in slots if isinstance(slots, list) else ():
                if not isinstance(slot, dict) or slot.get("t") != "port":
                    continue
                kind = slot.get("kind") or "interface"
                if kind in FACEPLATE_SLOT_KINDS:
                    kinds.add(kind)
    return kinds


def module_interfaces(module) -> list:
    """The interfaces ``module`` contributes to its device, named as they
    land there - ``{module}`` → the bay's position, ``{position}`` → the
    device's stack position - with their type for cage sizing. Reads the
    module's device, bay, type and the type's interface templates."""
    from .models import render_component_name, render_module_name

    pos = module.device.vc_position
    bay_pos = module.module_bay.position
    return [
        {
            "name": render_component_name(render_module_name(t.name, bay_pos), pos),
            "type": t.type,
        }
        for t in module.module_type.interface_templates.all()
    ]


class FaceplateParts:
    """The installed modules and the placed components of ``devices``, as
    the drawn faceplate composes them, in a fixed number of queries.

    ``modules`` per device: what ``/api/modules/?device=`` gives the
    faceplate - ``id``, ``module_bay``, ``module_type_faceplate`` and
    ``module_interfaces`` - in bay order. ``components`` per device: by slot
    kind, ``{id, name, type}`` of every component of a kind the device's
    type (or one of its modules' types) places on its faceplate, and only
    those. Both are limited to what the caller may view, as those list
    endpoints are. Each device needs its ``device_type`` loaded.
    """

    def __init__(self, devices, user, tenant):
        from auth_api import rbac

        from .models import Device, Module
        from .natural import natural

        devices = list(devices)
        ids = [d.id for d in devices]
        self._modules: dict = defaultdict(list)
        self._components: dict = defaultdict(dict)
        loaded = list(rbac.restrict_queryset(
            Module.objects.filter(device_id__in=ids)
            .select_related("device", "module_bay", "module_type")
            .prefetch_related("module_type__interface_templates")
            .order_by(natural("module_bay__name")),
            user, tenant, "module", "view",
        )) if ids else []
        kinds_of: dict = defaultdict(set)
        for module in loaded:
            self._modules[module.device_id].append({
                "id": str(module.id),
                "module_bay": {
                    "id": str(module.module_bay_id),
                    "name": module.module_bay.name,
                    "position": module.module_bay.position,
                },
                "module_type_faceplate": module.module_type.faceplate,
                "module_interfaces": module_interfaces(module),
            })
            kinds_of[module.device_id] |= faceplate_slot_kinds(module.module_type.faceplate)
        needed: dict = defaultdict(list)
        for d in devices:
            kinds = kinds_of[d.id]
            if d.device_type is not None:
                kinds = kinds | faceplate_slot_kinds(d.device_type.faceplate)
            for kind in kinds:
                needed[kind].append(d.id)
        for kind in sorted(needed):
            relation, slug = FACEPLATE_SLOT_KINDS[kind]
            model = Device._meta.get_field(relation).related_model
            rows = rbac.restrict_queryset(
                model.objects.filter(device_id__in=needed[kind]),
                user, tenant, slug, "view",
            ).values("id", "name", "type", "device_id")
            for row in rows:
                self._components[row["device_id"]].setdefault(kind, []).append(
                    {"id": str(row["id"]), "name": row["name"], "type": row["type"] or ""}
                )

    def modules(self, device) -> list:
        return self._modules.get(device.id, [])

    def components(self, device) -> dict:
        return self._components.get(device.id, {})
