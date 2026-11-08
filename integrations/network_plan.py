"""The network plan of a Proxmox source: what SDN should look like, worked out
from the cables between this source's VMs.

Read-only. It compares the VNet each cable names (``Cable.pve_vnet``, or a
name from the source's pattern when the cable has none) with what the last
sync saw on the VMs' NICs (``VirtGuest.nics``) and the VNets it read
(``VirtNetwork`` rows with an SDN zone). Something else applies it; Danbyte
never writes to the hypervisor.

A cable counts when both ends are single interfaces on devices that VMs of
this source are (``VirtualMachine.represents_device``). A device interface
maps to a VM NIC by MAC, then by name, then - when one NIC of the VM already
sits on the wanted VNet - to that NIC.

Every reader-facing row is filtered by the reader's own view rights: VMs,
devices and cables they cannot see are left out, so a site-scoped user sees
the plan of their own sites.
"""
from __future__ import annotations

import re

from django.utils import timezone

from api.pve_vnet import is_pve_vnet

from .virt_sdn import nic_for_interface

_RANGE = re.compile(r"^\s*(\d+)\s*-\s*(\d+)\s*$")


def parse_tag_range(text: str):
    """``"1000-1999"`` → ``(1000, 1999)``; blank or malformed → ``None``."""
    m = _RANGE.match(text or "")
    if not m:
        return None
    lo, hi = int(m.group(1)), int(m.group(2))
    return (lo, hi) if 1 <= lo <= hi else None


def render_name(pattern: str, cable) -> str:
    """The pattern's name for ``cable`` (``n`` is its number), or ``""``."""
    if not pattern or cable.numid is None:
        return ""
    try:
        return pattern.format(n=cable.numid)
    except (KeyError, IndexError, ValueError):
        return ""


def _cable_ref(cable) -> dict:
    return {"id": str(cable.id), "numid": cable.numid, "label": cable.label}


def build_plan(source, *, user, tenant, device=None) -> dict:
    from api.cable_scope import restrict_cables
    from api.models import Cable, CableTermination, Device, VirtualMachine
    from auth_api import rbac

    from .models import VirtGuest, VirtNetwork

    vms = rbac.restrict_queryset(
        VirtualMachine.objects.filter(tenant=tenant, represents_device__isnull=False),
        user, tenant, "virtualmachine", "view",
    )
    devices = rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant), user, tenant, "device", "view",
    )
    guests = (
        VirtGuest.objects.filter(source=source, vm__in=vms,
                                 vm__represents_device__in=devices)
        .select_related("vm", "vm__represents_device")
    )
    by_device = {g.vm.represents_device_id: g for g in guests}

    notes = []
    if not source.sync_networks:
        notes.append("Networks sync is off on this source, so no VNets are "
                     "known: every wanted VNet is listed as one to create.")

    cable_ids = (
        CableTermination.objects
        .filter(interface__device_id__in=list(by_device))
        .values_list("cable_id", flat=True)
    )
    cables = list(
        restrict_cables(
            Cable.objects.filter(tenant=tenant, id__in=cable_ids), user, tenant, "view"
        )
        .prefetch_related("terminations__interface__device",
                          "terminations__interface__mac_addresses")
        .distinct().order_by("numid")
    )

    scoped = []      # (cable, [(guest, iface)] A then B)
    skipped = []
    for cable in cables:
        terms = list(cable.terminations.all())
        a = [t for t in terms if t.end == "A"]
        b = [t for t in terms if t.end == "B"]
        ends = []
        reason = ""
        if len(a) != 1 or len(b) != 1:
            reason = "has more than one port on an end"
        for t in a[:1] + b[:1]:
            if reason:
                break
            if t.interface_id is None:
                reason = "does not end on an interface"
                break
            g = by_device.get(t.interface.device_id)
            if g is None:
                reason = f"{t.interface.device.name} is not a VM of this source"
                break
            ends.append((g, t.interface))
        if device is not None and not any(
            t.interface_id and t.interface.device_id == device.id for t in terms
        ):
            continue
        if reason:
            skipped.append({"cable": _cable_ref(cable), "reason": reason})
            continue
        scoped.append((cable, ends))

    existing = {
        vn.ext_key: vn for vn in VirtNetwork.objects.filter(source=source).exclude(sdn_zone="")
    }

    to_create: dict = {}
    wrong = []
    without = []
    conflicts = []
    wanted_by: dict = {}
    for cable, ends in scoped:
        wanted = cable.pve_vnet
        suggested = False
        if not wanted and source.vnet_name_pattern:
            wanted = render_name(source.vnet_name_pattern, cable)
            suggested = True
            if wanted and not is_pve_vnet(wanted):
                conflicts.append({
                    "kind": "bad_name", "cable": _cable_ref(cable),
                    "detail": f"The name pattern gives {wanted!r}, which is not a "
                              "VNet id (1-8 characters, a lowercase letter, then "
                              "lowercase letters or digits).",
                })
                wanted = ""
        for g, iface in ends:
            nic = nic_for_interface(iface, g.nics or [], wanted)
            row = {
                "vm": {"id": str(g.vm.id), "name": g.vm.name},
                "device": {"id": str(iface.device.id), "name": iface.device.name},
                "interface": {"id": str(iface.id), "name": iface.name},
                "cable": _cable_ref(cable),
                "nic": nic["key"] if nic else None,
                "mac": nic["mac"] if nic else (iface.mac_address or ""),
                "current": nic["bridge"] if nic else None,
                "wanted": wanted,
            }
            if nic is None:
                conflicts.append({
                    "kind": "no_nic", "cable": _cable_ref(cable),
                    "vm": row["vm"], "interface": row["interface"],
                    "detail": f"No NIC of {g.vm.name} matches {iface.device.name} "
                              f"{iface.name} by MAC or name.",
                })
                continue
            if not wanted:
                without.append(row)
            elif nic["bridge"] != wanted:
                wrong.append(row)
        if not wanted:
            continue
        wanted_by.setdefault(wanted, []).append((cable, suggested))
        if wanted not in existing:
            entry = to_create.setdefault(wanted, {
                "name": wanted, "zone": source.vnet_zone, "tag": None,
                "suggested": suggested, "cables": [],
            })
            entry["cables"].append(_cable_ref(cable))

    # Tags for the new VNets: the lowest free one in the range, per zone.
    rng = parse_tag_range(source.vnet_tag_range)
    if rng and to_create:
        used = {vn.sdn_tag for vn in existing.values()
                if vn.sdn_tag is not None and vn.sdn_zone == source.vnet_zone}
        nxt = rng[0]
        for name in sorted(to_create):
            while nxt in used and nxt <= rng[1]:
                nxt += 1
            if nxt > rng[1]:
                conflicts.append({
                    "kind": "tags_exhausted", "detail":
                    f"The tag range {source.vnet_tag_range} has no free tag for "
                    f"VNet {name}.",
                })
                break
            to_create[name]["tag"] = nxt
            used.add(nxt)

    # The same VNet named by more than one cable, inside the plan or by any
    # cable of the tenant the reader can see.
    duplicates = []
    names = set(wanted_by)
    if names:
        others = (
            restrict_cables(Cable.objects.filter(tenant=tenant, pve_vnet__in=names),
                            user, tenant, "view")
            .order_by("numid")
        )
        seen_by: dict = {}
        for c in others:
            seen_by.setdefault(c.pve_vnet, {})[c.id] = c
        for name in sorted(names):
            group = dict(seen_by.get(name, {}))
            for c, _ in wanted_by[name]:
                group[c.id] = c
            if len(group) > 1:
                duplicates.append({
                    "vnet": name,
                    "cables": [_cable_ref(c) for c in
                               sorted(group.values(), key=lambda c: c.numid or 0)],
                })

    # VNets nothing uses any more: no cable wants them and no NIC is on them.
    # Report only, and only for the whole plan - a device's slice cannot tell.
    unused = []
    if device is None:
        on_nic = {
            n.get("bridge") for g in VirtGuest.objects.filter(source=source)
            for n in (g.nics or [])
        }
        for name, vn in sorted(existing.items()):
            if source.vnet_zone and vn.sdn_zone != source.vnet_zone:
                continue
            if name in names or name in on_nic:
                continue
            unused.append({"name": name, "zone": vn.sdn_zone, "tag": vn.sdn_tag,
                           "alias": vn.sdn_alias})

    vnets_to_create = [to_create[k] for k in sorted(to_create)]
    return {
        "source": {"id": str(source.id), "name": source.name},
        "device": ({"id": str(device.id), "name": device.name}
                   if device is not None else None),
        "zone": source.vnet_zone,
        "generated_at": timezone.now().isoformat(),
        "counts": {
            "cables": len(scoped),
            "vnets_to_create": len(vnets_to_create),
            "nics_wrong_vnet": len(wrong),
            "nics_without_vnet": len(without),
            "unused_vnets": len(unused),
            "duplicates": len(duplicates),
            "conflicts": len(conflicts),
        },
        "vnets_to_create": vnets_to_create,
        "nics_wrong_vnet": wrong,
        "nics_without_vnet": without,
        "unused_vnets": unused,
        "duplicates": duplicates,
        "conflicts": conflicts,
        "cables_skipped": skipped,
        "notes": notes,
    }
