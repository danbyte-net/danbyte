"""The floor plan's detail panels: one read per click.

``cable_panel`` is what the cable panel shows of a cable and both its ends -
each end's device (role, status, where it stands) and port (type, speed,
enabled, description, untagged VLAN, the addresses on it and, when SNMP has
polled the device, the port's live state). ``tile_panel`` is what a device or
rack tile's panel shows: the object's facts, its monitoring, a device's port
summary and preview (photo or 3D model) and a rack's devices.

Both answer only what the reader may view: the cable is one ``/api/cables/``
lists them, an end on a device they may not view reads ``{"hidden": true}``
and nothing more (#453), interfaces and addresses follow their own view
scope, and a tile whose object they may not view reads only Hidden.
"""
from __future__ import annotations

from auth_api import rbac
from core.tags import tags_of

from .port_state import interface_state, termination_component

#: Termination kinds a panel names, by the termination's field.
_PORT_KIND = {
    "interface": "interface",
    "front_port": "front-port",
    "rear_port": "rear-port",
    "console_port": "console-port",
    "console_server_port": "console-server-port",
    "power_port": "power-port",
    "power_outlet": "power-outlet",
    "aux_port": "aux-port",
    "power_feed": "power-feed",
    "circuit_termination": "circuit-termination",
}

#: How many checks a device's panel lists, worst first.
CHECK_ROWS = 6


def _ref(obj, **extra):
    if obj is None:
        return None
    return {"id": str(obj.id), "name": getattr(obj, "name", "") or str(obj), **extra}


def _status(st):
    if st is None:
        return None
    return {"id": str(st.id), "name": st.name, "slug": st.slug,
            "color": st.color, "text_color": st.text_color}


def _role(role):
    if role is None:
        return None
    return {"id": str(role.id), "name": role.name, "color": role.color or ""}


def _tags(obj):
    return [{"id": t.id, "name": t.name, "color": t.color or ""} for t in tags_of(obj)]


def _type_label(model, field, value):
    if not value:
        return ""
    return str(dict(model._meta.get_field(field).flatchoices).get(value, value))


class _Viewable:
    """``may_view(slug, pk)`` for one reader; a superuser sees everything."""

    def __init__(self, user, tenant):
        self.rows = None if user.is_superuser else rbac.ViewableRows(user, tenant)

    def prime(self, slug, pks):
        if self.rows is not None:
            self.rows.prime(slug, pks)

    def may_view(self, slug, pk):
        return pk is not None and (self.rows is None or self.rows.may_view(slug, pk))


def _observed_ports(devices, tenant) -> dict:
    """``{device id: {interface id: {oper_status, admin_status, speed_mbps}}}``
    from each device's last SNMP poll, matched as drift matches them."""
    from monitoring.models import DeviceSnmp
    from monitoring.snmp_drift import _intent_by_observed_name, _match_observed

    out: dict = {}
    snaps = {
        s.device_id: s
        for s in DeviceSnmp.objects.filter(
            tenant=tenant, device_id__in=[d.id for d in devices]
        ).only("device_id", "interfaces")
    }
    for d in devices:
        snap = snaps.get(d.id)
        if snap is None or not snap.interfaces:
            continue
        by_name = _intent_by_observed_name(d.interfaces.all())
        seen = {}
        for o in snap.interfaces:
            iface = _match_observed(o, by_name)
            if iface is not None and iface.id not in seen:
                seen[iface.id] = {
                    "oper_status": str(o.get("oper_status") or ""),
                    "admin_status": str(o.get("admin_status") or ""),
                    "speed_mbps": str(o.get("speed_mbps") or ""),
                }
        out[d.id] = seen
    return out


def _device_where(d):
    return {
        "id": str(d.id),
        "name": d.name,
        "role": _role(d.role),
        "status": _status(d.status),
        "site": _ref(d.site),
        "location": _ref(d.location),
        "rack": _ref(d.rack),
        "cabinet": _ref(d.cabinet),
        "position": d.position,
        "face": d.face or "",
        "u_height": d.device_type.u_height if d.device_type_id else None,
    }


def cable_panel(request, tenant, cable):
    """The cable panel's payload for ``cable``, which the reader may view."""
    from .models import CableTermination, Device, Interface
    from .visible_ips import assigned_ips_prefetch

    user = request.user
    view = _Viewable(user, tenant)
    terms = list(
        CableTermination.objects.filter(cable=cable)
        .select_related(*CableTermination.POINT_FIELDS)
        .order_by("end", "pk")
    )
    comps = [(t, termination_component(t)) for t in terms]
    dev_ids = {getattr(c, "device_id", None) for _t, c in comps} - {None}
    view.prime("device", dev_ids)
    devices = {
        d.id: d
        for d in Device.objects.filter(tenant=tenant, id__in=dev_ids).select_related(
            "role", "status", "site", "location", "rack", "cabinet", "device_type"
        )
    }
    iface_ids = {c.pk for t, c in comps if t.interface_id is not None}
    ifaces = {
        i.id: i
        for i in rbac.restrict_queryset(
            Interface.objects.filter(pk__in=iface_ids, device__tenant=tenant)
            .select_related("vlan__zone", "lag")
            .prefetch_related(
                assigned_ips_prefetch(request, tenant), "tagged_vlans",
                "terminations__cable", "reservations",
            ),
            user, tenant, "interface", "view",
        )
    } if iface_ids else {}
    shown = [d for i, d in devices.items() if view.may_view("device", i)]
    observed = _observed_ports(shown, tenant) if shown else {}

    ends: dict = {"A": [], "B": []}
    for term, comp in comps:
        field = next(
            (f for f in CableTermination.POINT_FIELDS if getattr(term, f"{f}_id", None)),
            None,
        )
        dev_id = getattr(comp, "device_id", None)
        if dev_id is not None and not view.may_view("device", dev_id):
            ends[term.end].append({"hidden": True})
            continue
        dev = devices.get(dev_id) if dev_id is not None else None
        port = None
        if field == "interface":
            iface = ifaces.get(comp.pk)
            if iface is not None:
                state = interface_state(iface, peer=lambda _t: None)
                port = {
                    "kind": "interface",
                    **{k: state[k] for k in (
                        "id", "name", "label", "type", "type_display", "speed",
                        "enabled", "mode", "description", "mac_address", "vlan",
                        "ip_addresses", "tagged_vlan_count", "lag",
                    )},
                    "observed": observed.get(dev_id, {}).get(iface.id),
                }
        elif comp is not None:
            ptype = getattr(comp, "type", "") or ""
            port = {
                "kind": _PORT_KIND.get(field, field or ""),
                "id": str(comp.pk),
                "name": getattr(comp, "name", "") or str(comp),
                "label": getattr(comp, "label", "") or "",
                "type": ptype,
                "type_display": _type_label(type(comp), "type", ptype)
                if ptype and any(f.name == "type" for f in type(comp)._meta.fields) else "",
                "description": getattr(comp, "description", "") or "",
            }
        ends[term.end].append({
            "device": _device_where(dev) if dev is not None else None,
            "port": port,
        })
    st = cable.status
    return {
        "id": str(cable.id),
        "numid": getattr(cable, "numid", None),
        "label": cable.label or "",
        "name": str(cable),
        "type": cable.type or "",
        "type_display": cable.get_type_display() if cable.type else "",
        "color": cable.color or "",
        "status": _status(st),
        "length": float(cable.length) if cable.length is not None else None,
        "length_unit": cable.length_unit or "m",
        "length_source": cable.length_source,
        "description": getattr(cable, "description", "") or "",
        "ends": ends,
    }


# ── tiles ───────────────────────────────────────────────────────────────────

def _device_checks(device_ids, tenant):
    """``{device id: [check rows]}`` for the devices' addresses' checks."""
    from monitoring.models import CheckState

    from .models import IPAddress

    ip_dev = dict(
        IPAddress.objects.filter(tenant=tenant, assigned_device_id__in=device_ids)
        .values_list("id", "assigned_device_id")
    )
    out: dict = {}
    for s in (
        CheckState.objects.filter(tenant=tenant, target_ip_id__in=ip_dev)
        .select_related("template", "target_ip")
    ):
        out.setdefault(ip_dev[s.target_ip_id], []).append(s)
    return out


def _monitoring(states):
    from monitoring.rollup import status_rank, worst_status

    rows = sorted(states, key=lambda s: (-status_rank(s.status), s.template.name))
    counts: dict = {}
    for s in states:
        counts[s.status] = counts.get(s.status, 0) + 1
    return {
        "status": worst_status(s.status for s in states),
        "counts": counts,
        "checks": [
            {
                "id": str(s.id),
                "name": s.template.name,
                "kind": s.kind,
                "status": s.status,
                "ip": s.target_ip.ip_address,
                "last_checked": s.last_checked.isoformat() if s.last_checked else None,
                "since": s.since.isoformat() if s.since else None,
                "latency_ms": s.last_latency_ms,
            }
            for s in rows[:CHECK_ROWS]
        ],
    }


def _ports_summary(device, user, tenant):
    """Counted over the device's physical interfaces the reader may view."""
    from .models import Interface

    ifaces = list(
        rbac.restrict_queryset(
            Interface.objects.filter(device=device, virtual=False),
            user, tenant, "interface", "view",
        ).prefetch_related("terminations")
    )
    observed = _observed_ports([device], tenant).get(device.id)
    connected = sum(
        1 for i in ifaces if i.mark_connected or any(True for _ in i.terminations.all())
    )
    out = {
        "total": len(ifaces),
        "connected": connected,
        "free": len(ifaces) - connected,
        "disabled": sum(1 for i in ifaces if not i.enabled),
        "observed": observed is not None,
        "up": None,
        "down": None,
    }
    if observed is not None:
        mine = {i.id for i in ifaces}
        states = [o for iid, o in observed.items() if iid in mine]
        out["up"] = sum(1 for o in states if o["oper_status"] == "up")
        out["down"] = sum(
            1 for o in states
            if o["oper_status"] != "up" and o["admin_status"] != "down"
        )
    return out


def _ip(ip, view):
    if ip is None or not view.may_view("ipaddress", ip.pk):
        return None
    return {"id": str(ip.id), "ip_address": ip.ip_address, "dns_name": ip.dns_name or ""}


def _device_facts(d, view):
    """Every built-in attribute a device panel may show, by key."""
    profiles = []
    if view.rows is None or rbac.has_action(
        view.rows.user, view.rows.tenant, "deviceprofileassignment", "view"
    ):
        profiles = [
            {"id": str(a.profile_id), "name": a.profile.name, "color": a.profile.color}
            for a in d.device_profile_assignments.all()
        ]
    dt = d.device_type
    return {
        **_device_where(d),
        "numid": getattr(d, "numid", None),
        "device_type": {
            "id": str(dt.id),
            "model": dt.model or str(dt),
            "manufacturer": dt.manufacturer.name if dt.manufacturer_id else "",
        } if dt is not None else None,
        "platform": _ref(d.platform),
        "serial_number": d.serial_number or "",
        "asset_tag": d.asset_tag or "",
        "primary_ip": _ip(d.primary_ip, view),
        "secondary_ip": _ip(d.secondary_ip, view),
        "oob_ip": _ip(d.oob_ip, view),
        "tenant": _ref(d.tenant),
        "description": d.description or "",
        "software_version": getattr(d, "software_version", "") or "",
        "tags": _tags(d),
        "profiles": profiles,
    }


def _layout_for(tenant, kind, obj, items):
    """The resolved layout, or ``items`` as sent (the settings preview)."""
    from . import panel_layouts

    if items is not None:
        return {"id": None, "scope": "preview", "scope_id": None, "scope_name": "",
                "items": items}
    return panel_layouts.resolve(tenant, kind, obj)


def _device_ips(d, request, tenant):
    """The device's addresses the reader may view, by interface."""
    from .visible_ips import visible_ips

    rows = (
        visible_ips(request, tenant)
        .filter(assigned_device=d)
        .select_related("assigned_interface")
        .order_by("assigned_interface__name", "ip_address")[:20]
    )
    return [
        {
            "id": str(ip.id),
            "ip_address": ip.ip_address,
            "dns_name": ip.dns_name or "",
            "interface": ip.assigned_interface.name if ip.assigned_interface_id else "",
        }
        for ip in rows
    ]


def device_panel(request, tenant, device, items=None):
    """A device's panel, as its resolved layout (or ``items``) asks."""
    from core.tags import TAGS

    from . import panel_layouts
    from .models import Device

    user = request.user
    view = _Viewable(user, tenant)
    d = (
        Device.objects.filter(pk=device.pk)
        .select_related(
            "role", "status", "site", "location", "rack", "cabinet", "platform",
            "device_type__manufacturer", "primary_ip", "secondary_ip", "oob_ip", "tenant",
        )
        .prefetch_related(TAGS, "device_profile_assignments__profile")
        .get()
    )
    view.prime("ipaddress", {d.primary_ip_id, d.secondary_ip_id, d.oob_ip_id})
    layout = _layout_for(tenant, "device", d, items)
    want = layout["items"]
    out = {
        "kind": "device",
        "layout": layout,
        "device": _device_facts(d, view),
        "custom_fields": panel_layouts.custom_field_values(
            request, tenant, "device", d, want
        ),
    }
    if panel_layouts.wants(want, "monitoring"):
        out["monitoring"] = _monitoring(_device_checks([d.id], tenant).get(d.id, []))
    if panel_layouts.wants(want, "ports"):
        out["ports"] = _ports_summary(d, user, tenant)
    if panel_layouts.wants(want, "ips"):
        out["ips"] = _device_ips(d, request, tenant)
    if panel_layouts.wants(want, "preview"):
        out["preview"] = _device_preview(d, user, tenant)
    return out


def _image(f):
    if not f:
        return None
    try:
        return f.url
    except ValueError:
        return None


def _device_preview(d, user, tenant) -> dict:
    """What the panel's preview block draws: the type's rack-face photos,
    else the 3D model the room draws for the device (``api.model_3d.
    effective``) with its mapped ports. An inherited model points at the
    type's URL only when the reader may view the type, else at the device's
    own download, which serves the same file."""
    from .model_3d import effective
    from .model_ports import effective_model_ports
    from .models import DeviceType

    dt = d.device_type
    type_viewable = dt is not None and rbac.restrict_queryset(
        DeviceType.objects.filter(pk=dt.pk), user, tenant, "devicetype", "view"
    ).exists()
    model = effective(d, type_viewable=type_viewable)

    def mm(v):
        return float(v) if v is not None else None

    return {
        "front_image": _image(dt.front_image) if dt else None,
        "rear_image": _image(dt.rear_image) if dt else None,
        "model": model,
        "model_ports": effective_model_ports(d) if model else None,
        "width_mm": mm(dt.width_mm) if dt else None,
        "height_mm": mm(dt.height_mm) if dt else None,
        "depth_mm": mm(dt.depth_mm) if dt else None,
    }


def _contents(request, tenant, every, order):
    """The devices of ``every`` the reader may view, their worst checks, and
    how many they may not."""
    from monitoring.rollup import worst_status

    devices = list(
        rbac.restrict_queryset(every, request.user, tenant, "device", "view")
        .select_related("role", "status", "device_type", "din_rail")
        .order_by(*order)
    )
    checks = _device_checks([d.id for d in devices], tenant)
    rows = [
        {
            **{k: v for k, v in _device_where(d).items()
               if k not in ("site", "location", "rack", "cabinet")},
            "device_type": str(d.device_type) if d.device_type_id else "",
            "rail": d.din_rail.label if d.din_rail_id else "",
            "rail_offset_mm": float(d.din_offset_mm) if d.din_offset_mm is not None else None,
            "check": worst_status(s.status for s in checks.get(d.id, [])),
        }
        for d in devices
    ]
    status = worst_status(s.status for states in checks.values() for s in states)
    return devices, rows, status, every.count() - len(devices)


def rack_panel(request, tenant, rack, items=None):
    from core.tags import TAGS

    from . import panel_layouts
    from .models import Device, Rack

    rack = (
        Rack.objects.select_related("role", "status", "site", "location", "rack_type", "tenant")
        .prefetch_related(TAGS)
        .get(pk=rack.pk)
    )
    layout = _layout_for(tenant, "rack", rack, items)
    devices, rows, status, hidden = _contents(
        request, tenant, Device.objects.filter(tenant=tenant, rack=rack),
        ("-position", "name"),
    )
    used = sum(
        (d.device_type.u_height or 0) for d in devices
        if d.position is not None and d.device_type_id
    )
    return {
        "kind": "rack",
        "layout": layout,
        "rack": {
            "id": str(rack.id),
            "numid": getattr(rack, "numid", None),
            "name": rack.name,
            "facility_id": rack.facility_id or "",
            "role": _role(rack.role),
            "status": _status(rack.status),
            "site": _ref(rack.site),
            "location": _ref(rack.location),
            "rack_type": _ref(rack.rack_type, name=str(rack.rack_type))
            if rack.rack_type_id else None,
            "u_height": rack.u_height,
            "tenant": _ref(rack.tenant),
            "description": getattr(rack, "description", "") or "",
            "tags": _tags(rack),
        },
        "custom_fields": panel_layouts.custom_field_values(
            request, tenant, "rack", rack, layout["items"]
        ),
        "monitoring": {"status": status},
        "devices": rows,
        "used_units": used,
        "hidden_count": hidden,
    }


def cabinet_panel(request, tenant, cabinet, items=None):
    from core.tags import TAGS

    from . import panel_layouts
    from .models import Cabinet, Device

    cab = (
        Cabinet.objects.select_related(
            "role", "status", "site", "location", "cabinet_type", "tenant"
        )
        .prefetch_related(TAGS)
        .get(pk=cabinet.pk)
    )
    layout = _layout_for(tenant, "cabinet", cab, items)
    _devices, rows, status, hidden = _contents(
        request, tenant, Device.objects.filter(tenant=tenant, cabinet=cab),
        ("din_rail__y_mm", "din_offset_mm", "name"),
    )
    size = [cab.outer_width_mm, cab.outer_height_mm, cab.outer_depth_mm]
    return {
        "kind": "cabinet",
        "layout": layout,
        "cabinet": {
            "id": str(cab.id),
            "numid": getattr(cab, "numid", None),
            "name": cab.name,
            "facility_id": cab.facility_id or "",
            "role": _role(cab.role),
            "status": _status(cab.status),
            "site": _ref(cab.site),
            "location": _ref(cab.location),
            "cabinet_type": _ref(cab.cabinet_type, name=str(cab.cabinet_type))
            if cab.cabinet_type_id else None,
            "size_mm": size if all(v for v in size) else None,
            "tenant": _ref(cab.tenant),
            "description": cab.description or "",
            "tags": _tags(cab),
        },
        "custom_fields": panel_layouts.custom_field_values(
            request, tenant, "cabinet", cab, layout["items"]
        ),
        "monitoring": {"status": status},
        "devices": rows,
        "hidden_count": hidden,
    }


