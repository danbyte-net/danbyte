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
from fractions import Fraction

from django.contrib.contenttypes.models import ContentType
from django.template.loader import render_to_string

from core.tags import tags_of

from .din import mm
from .natural import natural, natural_key

_MAX_IMAGE_BYTES = 8 * 1024 * 1024


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
    return ", ".join(t.name for t in tags_of(obj))


def _ports_used(devices, tenant) -> dict | None:
    """The port-utilisation card's numbers for ``devices`` (a queryset):
    ``{used, total, pct, connected, reserved, free}`` or ``None`` when no
    port is counted - the same rule as the card, ``tenant``'s setting
    included."""
    from core.effective_settings import port_count_virtual

    from .port_utilization import utilization_payload

    payload = utilization_payload(devices, count_virtual=port_count_virtual(tenant))
    comb = payload.get("combined") or {}
    total = comb.get("total") or 0
    if not total:
        return None
    connected = comb.get("connected") or 0
    reserved = comb.get("reserved") or 0
    used = connected + reserved
    return {
        "used": used,
        "total": total,
        "pct": round(100 * used / total),
        "connected": connected,
        "reserved": reserved,
        "free": comb.get("free") or 0,
        "connected_pct": 100 * connected / total,
        "reserved_pct": 100 * reserved / total,
    }


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
    ifaces.sort(key=lambda i: natural_key(i.name))
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
        ("Size", (
            "×".join(f"{mm(v)}" for v in (dt.width_mm, dt.height_mm, dt.depth_mm) if v)
            + " mm" if dt and dt.width_mm and dt.height_mm else ""
        )),
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
        ("Cabinet", " · ".join(
            x for x in (device.cabinet.name if device.cabinet_id else "",
                        device.din_rail.label if device.din_rail_id else "",
                        f"{mm(device.din_offset_mm)} mm" if device.din_rail_id else "")
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
            for m in device.modules.select_related("module_bay", "module_type")
            .order_by(natural("module_bay__name"))
        ],
        "inventory": [
            {
                "name": it.name,
                "manufacturer": it.manufacturer.name if it.manufacturer_id else "",
                "part": it.part_id,
                "serial": it.serial_number,
            }
            for it in device.inventory_items.select_related("manufacturer")
            .order_by(natural("name"))
        ],
        "interfaces": rows,
        "comments": device.comments or "",
        "images": images,
        "elevation": elevation,
        "ip_count": IPAddress.objects.filter(assigned_device=device).count(),
        "ports": _ports_used(type(device).objects.filter(pk=device.pk), device.tenant),
    }


# ─── virtual machine ───────────────────────────────────────────────────────

def _memory(mb) -> str:
    """A VM's memory (MiB) in GB, like the hardware sheet's RAM."""
    return format_gb(Fraction(mb, 1024)) if mb and mb > 0 else "—"


def vm_context(vm, request=None) -> dict:
    from .models import IPAddress

    disks = list(vm.disks.order_by(natural("key")))
    disk_total = vm.disk_gb or sum((d.size_gb or 0) for d in disks)
    ifaces = list(vm.interfaces.select_related("parent").all())
    ifaces.sort(key=lambda i: natural_key(i.name))
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
    ports = _ports_used(vc.members.all(), vc.tenant) if members else None
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
             "value": f"{ports['used']} / {ports['total']}" if ports else "—",
             "hint": f"{ports['pct']} %" if ports else ""},
        ],
        "details": details,
        "ports": ports,
        "members": member_rows,
        "member_ifaces": member_ifaces,
        "comments": vc.comments or "",
        "images": _images_for(vc),
        "elevation": elevation,
    }


# ─── rendering ─────────────────────────────────────────────────────────────

# ─── hardware sheet ────────────────────────────────────────────────────────

_UNITS = [("PB", 1e15), ("TB", 1e12), ("GB", 1e9), ("MB", 1e6), ("KB", 1e3)]


def format_bytes(n) -> str:
    """Bytes → "1.92 TB" (decimal units, trailing zeros trimmed)."""
    if not n or n <= 0:
        return ""
    for unit, factor in _UNITS:
        if n >= factor:
            v = n / factor
            text = f"{v:.0f}" if v >= 100 else f"{v:.2f}".rstrip("0").rstrip(".")
            return f"{text} {unit}"
    return f"{n} B"


_MIB = 1 << 20


def memory_gb(n) -> Fraction:
    """A memory size in GB, exactly. The bytes come two ways: a BMC reports
    MiB, so 32 GiB is stored as 34 359 738 368; the form writes decimal GB,
    so 32 GB is 32 000 000 000. A whole number of MiB reads in GiB, anything
    else in decimal GB - both are 32 GB."""
    if not n or n <= 0:
        return Fraction(0)
    return Fraction(n, 1 << 30) if n % _MIB == 0 else Fraction(n, 10**9)


def format_gb(gb: Fraction) -> str:
    """GB with no unit switch - "1024 GB", not "1.1 TB" - whole when exact,
    else to one decimal."""
    if gb <= 0:
        return ""
    text = str(gb.numerator) if gb.denominator == 1 else f"{float(gb):.1f}"
    return f"{text} GB"


def format_memory(n) -> str:
    """Memory bytes → "32 GB" (see ``memory_gb``)."""
    return format_gb(memory_gb(n))


def _most_common(values) -> str:
    vals = [v for v in values if v]
    if not vals:
        return ""
    return max(set(vals), key=vals.count)


def size_mix(items, fmt, media_labels=None) -> str:
    """"2 × 2 TB · 8 × 10 TB": one count per distinct size, smallest first.

    A multiplier over the most common size would read "10 × 2 TB" for two
    2 TB and eight 10 TB disks. With ``media_labels`` and more than one medium
    among the parts, each group names its medium ("2 × 2 TB SSD"). Parts with
    no size are counted at the end ("2 more")."""
    sized = [i for i in items if i.capacity_bytes]
    if not sized:
        return ""
    mixed = media_labels is not None and len({i.media for i in sized}) > 1
    # Grouped by the size as printed, so two "960 GB" disks a few bytes
    # apart count together; ordered by the smallest part in each group.
    groups: dict[tuple, list] = {}
    for i in sized:
        key = (fmt(i.capacity_bytes), i.media if mixed else "")
        g = groups.setdefault(key, [0, i.capacity_bytes])
        g[0] += 1
        g[1] = min(g[1], i.capacity_bytes)
    bits = []
    for (size, medium), (n, _) in sorted(groups.items(), key=lambda kv: (kv[1][1], kv[0][1])):
        label = f"{n} × {size}"
        if mixed and media_labels.get(medium):
            label += f" {media_labels[medium]}"
        bits.append(label)
    unsized = len(items) - len(sized)
    if unsized:
        bits.append(f"{unsized} more")
    return " · ".join(bits)


_CORES_IN_TEXT = re.compile(r"^\s*(\d+)\s*[x×]\s")


def cores_of(item) -> int:
    """The part's core count: the recorded figure, else the "36 x Xeon…"
    prefix a BMC or hypervisor writes into the description."""
    if item.cores:
        return item.cores
    m = _CORES_IN_TEXT.match(item.description or "")
    return int(m.group(1)) if m else 0


def model_of(item) -> str:
    """The part's model text without the "36 x " count prefix - the count is
    shown as cores, so it must not read twice."""
    return _CORES_IN_TEXT.sub("", item.description or "", count=1).strip() or item.part_id


def hardware_totals(items) -> dict:
    """What the box adds up to - one entry per kind that carries a total:
    CPUs (sockets, cores, the clock and model most of them share), RAM (total
    size, sticks, grade) and disks (total capacity, count, media)."""
    cpus = [i for i in items if i.kind == "cpu"]
    rams = [i for i in items if i.kind == "ram"]
    disks = [i for i in items if i.kind == "disk"]
    cores = sum(cores_of(i) for i in cpus)
    ram_bytes = sum(i.capacity_bytes or 0 for i in rams)
    ram_gb = sum((memory_gb(i.capacity_bytes) for i in rams), Fraction(0))
    disk_bytes = sum(i.capacity_bytes or 0 for i in disks)
    from .models import INVENTORY_MEDIA_TYPES

    media_labels = dict(INVENTORY_MEDIA_TYPES)
    return {
        "cpu": {
            "sockets": len(cpus),
            "cores": cores,
            "clock": _most_common(i.speed for i in cpus),
            "model": _most_common(model_of(i) for i in cpus),
        },
        "ram": {
            "bytes": ram_bytes,
            "total": format_gb(ram_gb),
            "sticks": len(rams),
            "stick": _most_common(format_memory(i.capacity_bytes) for i in rams),
            "mix": size_mix(rams, format_memory),
            "speed": _most_common(i.speed for i in rams),
        },
        "disk": {
            "bytes": disk_bytes,
            "total": format_bytes(disk_bytes),
            "count": len(disks),
            "each": _most_common(format_bytes(i.capacity_bytes) for i in disks),
            "mix": size_mix(disks, format_bytes, media_labels),
            # One medium for all: said once after the sizes. Mixed media are
            # named per size in "mix" instead.
            "media": (
                media_labels.get(_most_common(i.media for i in disks), "")
                if len({i.media for i in disks if i.capacity_bytes}) <= 1 else ""
            ),
        },
    }


def _hardware_stats(totals: dict) -> list[dict]:
    cpu, ram, disk = totals["cpu"], totals["ram"], totals["disk"]
    if cpu["cores"]:
        cpu_value = f"{cpu['cores']} cores"
        cpu_hint = " · ".join(x for x in (
            f"{cpu['sockets']} socket{'s' if cpu['sockets'] != 1 else ''}",
            cpu["clock"], cpu["model"]) if x)
    else:
        cpu_value = f"{cpu['sockets']} CPU{'s' if cpu['sockets'] != 1 else ''}" if cpu["sockets"] else "—"
        cpu_hint = " · ".join(x for x in (cpu["clock"], cpu["model"]) if x)
    ram_hint = " · ".join(x for x in (
        ram["mix"] if ram["mix"] else
        f"{ram['sticks']} module{'s' if ram['sticks'] != 1 else ''}" if ram["sticks"] else "",
        ram["speed"]) if x)
    disk_hint = " · ".join(x for x in (
        disk["mix"] if disk["mix"] else
        f"{disk['count']} disk{'s' if disk['count'] != 1 else ''}" if disk["count"] else "",
        disk["media"]) if x)
    return [
        {"label": "CPU", "value": cpu_value, "hint": cpu_hint},
        {"label": "Memory", "value": ram["total"] or "—", "hint": ram_hint},
        {"label": "Storage", "value": disk["total"] or "—", "hint": disk_hint},
    ]


def _hardware_parts(device) -> dict:
    """The parts grouped per kind, plus their totals - shared by the hardware
    sheet and the all-in-one sheet."""
    from .models import INVENTORY_ITEM_KINDS, INVENTORY_MEDIA_TYPES

    # Slot then name, in natural order: "DIMM 2" before "DIMM 10". A part a
    # BMC synced has no slot, so its name orders it.
    items = list(
        device.inventory_items.select_related("manufacturer", "status")
        .order_by("kind", natural("slot"), natural("name"))
    )
    totals = hardware_totals(items)
    media = dict(INVENTORY_MEDIA_TYPES)
    kinds = dict(INVENTORY_ITEM_KINDS)

    def _row(it):
        size = (format_memory if it.kind == "ram" else format_bytes)(it.capacity_bytes)
        return {
            "slot": it.slot,
            "name": it.name,
            "model": model_of(it),
            "manufacturer": it.manufacturer.name if it.manufacturer_id else "",
            "part": it.part_id,
            "serial": it.serial_number,
            "speed": it.speed,
            "cores": cores_of(it) or "",
            "capacity": size,
            "media": media.get(it.media, ""),
            "status": it.status.name if it.status_id else "",
            "kind": kinds.get(it.kind, it.kind),
            "details": " · ".join(x for x in (
                model_of(it), it.speed, size
            ) if x),
        }

    return {
        "totals": totals,
        "hardware_stats": _hardware_stats(totals),
        "cpus": [_row(i) for i in items if i.kind == "cpu"],
        "rams": [_row(i) for i in items if i.kind == "ram"],
        "disks": [_row(i) for i in items if i.kind == "disk"],
        "others": [_row(i) for i in items if i.kind not in ("cpu", "ram", "disk")],
    }


def device_full_context(device, request=None) -> dict:
    """Everything on one sheet: the datasheet as it is, with the hardware
    totals and the parts per kind between the details and the interfaces."""
    base = device_context(device, request)
    return {**base, **_hardware_parts(device)}


def device_hardware_context(device, request=None) -> dict:
    """The hardware-first sheet: the same header, the parts' totals as the
    stat boxes, then one table per kind with the slot each part sits in. No
    rack figures, no interfaces - what a server's inventory sheet is for."""
    base = device_context(device, request)
    parts = _hardware_parts(device)
    keep = {"Serial number", "Asset tag", "Type", "Part number", "Platform",
            "Primary IP", "OOB IP", "Site", "Rack", "Description"}
    dt = device.device_type if device.device_type_id else None
    return {
        **{k: v for k, v in base.items() if k not in ("ports", "images", "interfaces")},
        "subtitle": " · ".join(x for x in (
            f"{dt.manufacturer.name} {dt.model or dt.name}" if dt and dt.manufacturer_id
            else (dt.model or dt.name) if dt else "",
            device.site.name if device.site_id else "",
        ) if x),
        "details": [(k, v) for k, v in base["details"] if k in keep],
        **parts,
        "stats": parts["hardware_stats"],
    }


_CONTEXTS = {
    "device": device_context,
    "device_hardware": device_hardware_context,
    "device_full": device_full_context,
    "vm": vm_context,
    "vc": vc_context,
}


def render_spec_html(kind: str, obj, request=None) -> str:
    return render_to_string(f"spec/{kind}.html", _CONTEXTS[kind](obj, request))


def render_spec_pdf(kind: str, obj, request=None) -> bytes:
    import weasyprint

    return weasyprint.HTML(string=render_spec_html(kind, obj, request)).write_pdf()


def spec_filename(obj, suffix: str = "") -> str:
    """``<name>-spec[-variant]-<serial>.pdf`` when the object has a serial
    number - the file then names the box wherever it lands - else the date."""
    clean = lambda v: re.sub(r"[^A-Za-z0-9._-]+", "-", v).strip("-")  # noqa: E731
    stem = clean(obj.name or "object") or "object"
    tail = clean(getattr(obj, "serial_number", "") or "") or f"{datetime.now(UTC):%Y-%m-%d}"
    return f"{stem}-spec{suffix}-{tail}.pdf"
