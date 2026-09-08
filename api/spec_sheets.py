"""Spec sheets - a printable PDF datasheet for one device or VM (#150).

Rendered server-side with WeasyPrint like the label sheets, so the page box
and fonts are baked in and the file prints the same everywhere. The context
builders read the same relations the detail pages show; custom fields follow
their definitions' ``hidden`` flag, and the object itself is fetched through
the viewset, so RBAC and site scoping are the API's.
"""
from __future__ import annotations

import base64
import mimetypes
import re
from datetime import UTC, datetime

from django.contrib.contenttypes.models import ContentType
from django.template.loader import render_to_string

_MAX_IMAGE_BYTES = 8 * 1024 * 1024


def _natural(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name or "")]


def _data_uri(field) -> str | None:
    """An image field as a ``data:`` URI, so the PDF needs no media URL."""
    if not field:
        return None
    try:
        with field.open("rb") as fh:
            raw = fh.read(_MAX_IMAGE_BYTES + 1)
    except (OSError, ValueError):
        return None
    if len(raw) > _MAX_IMAGE_BYTES:
        return None
    mime = mimetypes.guess_type(field.name)[0] or "image/png"
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def _fmt_cf(value) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, dict):
        return str(value.get("name") or value.get("label") or value.get("id") or "")
    if isinstance(value, list):
        return ", ".join(_fmt_cf(v) for v in value if _fmt_cf(v))
    return str(value)


def custom_field_rows(obj, slug: str) -> list[tuple[str, str]]:
    """``(label, value)`` for every defined, non-hidden custom field that has a
    value on ``obj``, in the definition's weight order."""
    from customization.models import CustomField

    values = obj.custom_fields or {}
    rows = []
    defs = CustomField.objects.filter(
        tenant=obj.tenant, hidden=False, applies_to__contains=[slug]
    ).order_by("weight", "label")
    for d in defs:
        v = _fmt_cf(values.get(d.key))
        if v:
            rows.append((d.label, v))
    return rows


def _images_for(obj) -> list[dict]:
    from .models import ImageAttachment

    ct = ContentType.objects.get_for_model(type(obj))
    out = []
    for att in ImageAttachment.objects.filter(
        tenant=obj.tenant, content_type=ct, object_id=obj.id
    ).order_by("sort_order", "created_at"):
        src = _data_uri(att.image)
        if src:
            out.append({"src": src, "caption": att.name or ""})
    return out


def _peer_label(point) -> str:
    """``device:port`` at the far end of the cable on ``point``, or ``""``."""
    from .models import CableTermination

    term = point.terminations.select_related("cable").first()
    if term is None:
        return ""
    far = (
        CableTermination.objects.filter(cable=term.cable)
        .exclude(end=term.end)
        .first()
    )
    if far is None:
        return ""
    for field in CableTermination.POINT_FIELDS:
        target = getattr(far, field, None)
        if target is None:
            continue
        owner = getattr(target, "device", None) or getattr(target, "circuit", None)
        owner_name = getattr(owner, "name", None) or getattr(owner, "cid", None) or ""
        name = getattr(target, "name", None) or getattr(target, "term_side", None) or ""
        return f"{owner_name}:{name}" if owner_name else str(name)
    return ""


def _vendor_map(macs, tenant) -> dict:
    from .oui import hexkey, vendors_for

    got = vendors_for(macs, tenant)
    return {m: (got.get(hexkey(m)) or {}).get("name", "") for m in macs if m}


_PATHS = {"device": "/devices/", "vm": "/virtual-machines/", "vc": "/virtual-chassis/"}


def _meta(obj, request, kind: str) -> dict:
    from core.models import DeploymentSettings

    ds = DeploymentSettings.load()
    base = request.build_absolute_uri("/").rstrip("/") if request is not None else ""
    path = f"{_PATHS[kind]}{obj.id}"
    return {
        "deployment": ds.deployment_name or "Danbyte",
        "logo": _data_uri(ds.login_logo),
        "generated": datetime.now(UTC),
        "url": f"{base}{path}",
        "kind": kind,
    }


def _status(obj) -> dict | None:
    s = getattr(obj, "status", None)
    return {"name": s.name, "color": s.color or "#e5e7eb"} if s else None


def _tags(obj) -> str:
    return ", ".join(t.name for t in obj.tags.all())


# ─── device ────────────────────────────────────────────────────────────────

def _fmt_speed(value) -> str:
    return str(value or "")


def interface_rows(device) -> tuple[list[dict], list]:
    """The interface table rows for ``device`` (natural order) and the
    interfaces themselves."""
    from .models import Interface

    ifaces = list(
        Interface.objects.filter(device=device)
        .select_related("vlan", "parent")
        .prefetch_related("tagged_vlans", "ip_addresses")
    )
    ifaces.sort(key=lambda i: _natural(i.name))
    vendors = _vendor_map({i.mac_address for i in ifaces if i.mac_address}, device.tenant)
    rows = []
    for i in ifaces:
        tagged = list(i.tagged_vlans.all())
        vlan = str(i.vlan.vlan_id) if i.vlan_id else ""
        if tagged:
            vlan = (vlan + " · " if vlan else "") + f"tagged {len(tagged)}"
        rows.append({
            "name": i.name,
            "depth": 1 if i.parent_id else 0,
            "type": i.get_type_display() if i.type else "",
            "enabled": i.enabled,
            "speed": _fmt_speed(i.speed),
            "mac": i.mac_address,
            "vendor": vendors.get(i.mac_address, ""),
            "vlan": vlan,
            "ips": [ip.ip_address for ip in i.ip_addresses.all()],
            "peer": _peer_label(i),
            "description": i.description,
        })

    return rows, ifaces


def device_context(device, request=None) -> dict:
    from .models import IPAddress

    dt = device.device_type
    rack = device.rack
    subtitle = [
        device.role.name if device.role_id else "",
        device.site.name if device.site_id else "",
        (
            f"{rack.name} · U{device.position}" if rack and device.position
            else rack.name if rack
            else device.location.name if device.location_id
            else ""
        ),
    ]
    rows, ifaces = interface_rows(device)

    power = list(device.power_ports.all())
    draw = sum((p.allocated_draw or p.maximum_draw or 0) for p in power)

    def _ip(rel):
        return rel.ip_address if rel else ""

    details = [
        ("Serial number", device.serial_number),
        ("Asset tag", device.asset_tag),
        ("Type", (
            f"{dt.manufacturer.name} {dt.model or dt.name}" if dt and dt.manufacturer_id
            else (dt.model or dt.name) if dt else ""
        )),
        ("Part number", dt.part_number if dt else ""),
        ("Height", f"{dt.u_height}U" if dt and dt.u_height else ""),
        ("Platform", device.platform.name if device.platform_id else ""),
        ("Primary IP", _ip(device.primary_ip)),
        ("OOB IP", _ip(device.oob_ip)),
        ("Tenant", device.tenant.name),
        ("Site", device.site.name if device.site_id else ""),
        ("Location", device.location.name if device.location_id else ""),
        ("Rack", " · ".join(
            x for x in (rack.name if rack else "",
                        f"U{device.position}" if rack and device.position else "",
                        device.face if rack and device.position else "")
            if x
        )),
        ("Cluster", device.cluster.name if device.cluster_id else ""),
        ("Virtual chassis", (
            f"{device.virtual_chassis.name} · member {device.vc_position}"
            if device.virtual_chassis_id else ""
        )),
        ("Description", device.description),
        ("Tags", _tags(device)),
    ]
    details = [(k, v) for k, v in details if v]
    details += custom_field_rows(device, "device")

    images = _images_for(device)
    elevation = []
    if dt:
        for label, field in (("Front", dt.front_image), ("Rear", dt.rear_image)):
            src = _data_uri(field)
            if src:
                elevation.append({"src": src, "caption": f"{label} · {dt.model or dt.name}"})

    return {
        "meta": _meta(device, request, "device"),
        "name": device.name,
        "subtitle": " · ".join(s for s in subtitle if s),
        "status": _status(device),
        "stats": [
            {"label": "Interfaces", "value": str(len(ifaces))},
            {"label": "Power draw", "value": f"{draw} W" if draw else "—",
             "hint": f"{len(power)} port{'s' if len(power) != 1 else ''}" if power else ""},
            {"label": "Rack position",
             "value": f"U{device.position}" if rack and device.position else "—",
             "hint": rack.name if rack else ""},
        ],
        "details": details,
        "modules": [
            {
                "bay": m.module_bay.name if m.module_bay_id else "",
                "type": m.module_type.name,
                "serial": m.serial_number,
            }
            for m in device.modules.select_related("module_bay", "module_type").all()
        ],
        "inventory": [
            {
                "name": it.name,
                "manufacturer": it.manufacturer.name if it.manufacturer_id else "",
                "part": it.part_id,
                "serial": it.serial_number,
            }
            for it in device.inventory_items.select_related("manufacturer").all()
        ],
        "interfaces": rows,
        "comments": device.comments or "",
        "images": images,
        "elevation": elevation,
        "ip_count": IPAddress.objects.filter(assigned_device=device).count(),
    }


# ─── virtual machine ───────────────────────────────────────────────────────

def _memory(mb) -> str:
    if not mb:
        return "—"
    return f"{mb / 1024:g} GB" if mb % 1024 == 0 else f"{mb} MB"


def vm_context(vm, request=None) -> dict:
    from .models import IPAddress

    disks = list(vm.disks.all())
    disk_total = vm.disk_gb or sum((d.size_gb or 0) for d in disks)
    ifaces = list(vm.interfaces.select_related("parent").all())
    ifaces.sort(key=lambda i: _natural(i.name))
    ips_by_iface: dict = {}
    for ip in IPAddress.objects.filter(assigned_vm_interface__in=ifaces):
        ips_by_iface.setdefault(ip.assigned_vm_interface_id, []).append(ip.ip_address)
    vendors = _vendor_map({i.mac_address for i in ifaces if i.mac_address}, vm.tenant)

    subtitle = [
        vm.role.name if vm.role_id else "",
        vm.site.name if vm.site_id else "",
        vm.cluster.name if vm.cluster_id else "",
    ]
    details = [
        ("Cluster", vm.cluster.name if vm.cluster_id else ""),
        ("Host", vm.device.name if vm.device_id else ""),
        ("Platform", vm.platform.name if vm.platform_id else ""),
        ("Primary IP", vm.primary_ip.ip_address if vm.primary_ip_id else ""),
        ("Tenant", vm.tenant.name),
        ("Site", vm.site.name if vm.site_id else ""),
        ("Power state", (getattr(vm, "power_state", "") or "").capitalize()),
        ("Synced from", str(getattr(vm, "synced_from", "") or "")),
        ("Description", vm.description),
        ("Tags", _tags(vm)),
    ]
    details = [(k, v) for k, v in details if v]
    details += custom_field_rows(vm, "virtualmachine")

    return {
        "meta": _meta(vm, request, "vm"),
        "name": vm.name,
        "subtitle": " · ".join(s for s in subtitle if s),
        "status": _status(vm),
        "stats": [
            {"label": "vCPU", "value": str(vm.vcpus) if vm.vcpus else "—"},
            {"label": "Memory", "value": _memory(vm.memory_mb)},
            {"label": "Disk", "value": f"{disk_total} GB" if disk_total else "—",
             "hint": f"{len(disks)} disk{'s' if len(disks) != 1 else ''}" if disks else ""},
        ],
        "details": details,
        "disks": [
            {
                "name": d.name or d.key,
                "size": f"{d.size_gb} GB" if d.size_gb else "",
                "storage": d.storage,
                "controller": d.controller,
            }
            for d in disks
        ],
        "interfaces": [
            {
                "name": i.name,
                "depth": 1 if i.parent_id else 0,
                "type": (i.kind or "").capitalize(),
                "enabled": i.enabled,
                "speed": i.speed,
                "mac": i.mac_address,
                "vendor": vendors.get(i.mac_address, ""),
                "mtu": i.mtu,
                "ips": ips_by_iface.get(i.id, []),
            }
            for i in ifaces
        ],
        "comments": getattr(vm, "comments", "") or "",
        "images": _images_for(vm),
        "elevation": [],
    }


# ─── virtual chassis ───────────────────────────────────────────────────────

def vc_context(vc, request=None) -> dict:
    from .port_utilization import utilization_payload

    members = list(
        vc.members.select_related("device_type__manufacturer", "status", "site", "primary_ip", "oob_ip")
        .order_by("vc_position", "name")
    )
    master = vc.master if vc.master_id else (members[0] if members else None)
    elevation = []
    member_rows = []
    member_ifaces = []
    total_ifaces = 0
    for m in members:
        dt = m.device_type
        label = f"{m.vc_position if m.vc_position is not None else '-'} · {m.name}"
        if master and m.id == master.id:
            label += " · master"
        if dt:
            src = _data_uri(dt.front_image)
            if src:
                elevation.append({"src": src, "caption": f"{label} · {dt.model or dt.name}"})
        rows, ifaces = interface_rows(m)
        total_ifaces += len(ifaces)
        member_ifaces.append({"label": label, "rows": rows})
        member_rows.append({
            "position": m.vc_position if m.vc_position is not None else "-",
            "name": m.name,
            "role": "Master" if master and m.id == master.id else "Member",
            "priority": m.vc_priority if m.vc_priority is not None else "",
            "type": (dt.model or dt.name) if dt else "",
            "serial": m.serial_number,
            "status": m.status.name if m.status_id else "",
        })
    util = (utilization_payload(vc.members.all()) if members else {}).get("combined") or {}
    used = (util.get("connected") or 0) + (util.get("reserved") or 0)
    total = util.get("total") or 0
    details = [
        ("Domain", vc.domain),
        ("Master", master.name if master else ""),
        ("Members", str(len(members))),
        ("Primary IP", master.primary_ip.ip_address if master and master.primary_ip_id else ""),
        ("OOB IP", master.oob_ip.ip_address if master and master.oob_ip_id else ""),
        ("Tenant", vc.tenant.name),
        ("Site", master.site.name if master and master.site_id else ""),
        ("Description", vc.description),
        ("Tags", _tags(vc)),
    ]
    details = [(k, v) for k, v in details if v]
    details += custom_field_rows(vc, "virtualchassis")
    return {
        "meta": _meta(vc, request, "vc"),
        "name": vc.name,
        "subtitle": " · ".join(
            x for x in ("Virtual chassis", master.site.name if master and master.site_id else "")
            if x
        ),
        "status": _status(master) if master else None,
        "stats": [
            {"label": "Members", "value": str(len(members))},
            {"label": "Interfaces", "value": str(total_ifaces)},
            {"label": "Ports used",
             "value": f"{used} / {total}" if total else "—",
             "hint": f"{round(100 * used / total)} %" if total else ""},
        ],
        "details": details,
        "members": member_rows,
        "member_ifaces": member_ifaces,
        "comments": vc.comments or "",
        "images": _images_for(vc),
        "elevation": elevation,
    }


# ─── rendering ─────────────────────────────────────────────────────────────

_CONTEXTS = {"device": device_context, "vm": vm_context, "vc": vc_context}


def render_spec_html(kind: str, obj, request=None) -> str:
    return render_to_string(f"spec/{kind}.html", _CONTEXTS[kind](obj, request))


def render_spec_pdf(kind: str, obj, request=None) -> bytes:
    import weasyprint

    return weasyprint.HTML(string=render_spec_html(kind, obj, request)).write_pdf()


def spec_filename(obj) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", obj.name or "object").strip("-") or "object"
    return f"{stem}-spec-{datetime.now(UTC):%Y-%m-%d}.pdf"
