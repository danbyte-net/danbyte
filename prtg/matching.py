"""Which PRTG device is this Danbyte device?

Tried most reliable first, stopping at the first unambiguous hit:

1. **A stored link** - kept, so a rename or re-addressing on either side does
   not break the pairing.
2. **The tag** ``danbyte-<device uuid>`` on the PRTG device - written by
   Danbyte when it provisions, or by an operator who wants to pin a pairing.
3. **An address.** PRTG's ``host`` field equals one of the addresses the
   device uses in Danbyte: assigned to it or to one of its interfaces, or in
   its primary, OOB or secondary slot.
4. **A DNS name.** ``host`` equals the DNS name of one of those addresses.
5. **The exact name.** Last, because names collide and get reused.

Two candidates at one level are no match, and a row in the review queue: a
wrong pairing shows one device's sensors as another's, and nothing downstream
would flag it. The cascade is the shared one
(:mod:`monitoring.external.matching`); this module supplies PRTG's levels and
its device index.
"""
from __future__ import annotations

import ipaddress

from monitoring.external.matching import Cascade, Level, Match

__all__ = [
    "CASCADE", "VM_CASCADE", "Match", "annotate_devices", "annotate_vms", "index_devices",
    "match_device", "match_vm", "tag_for",
]


def tag_for(device) -> str:
    """The PRTG tag that names a Danbyte device."""
    return f"danbyte-{device.id}"


def _address(value: str) -> str:
    """An IP literal, normalised, or "" for anything else."""
    value = (value or "").strip().split("/")[0].strip("[]")
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        return ""


def _dns(value: str) -> str:
    return (value or "").strip().rstrip(".").lower()


def annotate_devices(tenant, devices) -> list:
    """Each device with ``_prtg_ips`` and ``_prtg_dns``: every address it
    uses in this tenant - assigned to it or to one of its interfaces, or in
    its primary, OOB or secondary slot - and their DNS names. The same
    candidates the host PRTG polls is chosen from
    (:func:`prtg.provision.host_choice`). Two queries for all."""
    from django.db.models import Q

    from api.models import IPAddress

    devices = list(devices)
    by_id = {d.id: d for d in devices}
    for d in devices:
        d._prtg_ips, d._prtg_dns = set(), set()

    def add(d, address, dns_name):
        if _address(str(address)):
            d._prtg_ips.add(_address(str(address)))
        if dns_name:
            d._prtg_dns.add(_dns(dns_name))

    if by_id:
        ids = list(by_id)
        rows = IPAddress.objects.filter(tenant=tenant).filter(
            Q(assigned_device_id__in=ids) | Q(assigned_interface__device_id__in=ids)
        ).values_list("assigned_device_id", "assigned_interface__device_id",
                      "ip_address", "dns_name")
        for direct, via_iface, address, dns_name in rows:
            for device_id in {direct, via_iface} - {None}:
                if device_id in by_id:
                    add(by_id[device_id], address, dns_name)
        slots: dict = {}
        for d in devices:
            for attr in ("primary_ip_id", "oob_ip_id", "secondary_ip_id"):
                if getattr(d, attr, None):
                    slots.setdefault(getattr(d, attr), []).append(d)
        if slots:
            for pk, address, dns_name in IPAddress.objects.filter(
                tenant=tenant, pk__in=list(slots)
            ).values_list("pk", "ip_address", "dns_name"):
                for d in slots[pk]:
                    add(d, address, dns_name)
    for d in devices:
        _override(d)
    return devices


def _override(obj) -> None:
    """An object with a PRTG host override is matched by that host alone:
    it is what PRTG polls."""
    host = (getattr(obj, "prtg_host", "") or "").strip()
    if not host:
        return
    if _address(host):
        obj._prtg_ips, obj._prtg_dns = {_address(host)}, set()
    else:
        obj._prtg_ips, obj._prtg_dns = set(), {_dns(host)}


def shared_addresses(tenant, addresses) -> dict:
    """``{address: [owner names]}`` for the addresses that more than one
    device or virtual machine of the tenant holds.

    A PRTG ``host`` on such an address does not say which of them PRTG
    watches - a VM and the hypervisor device recorded on the same address
    is the usual case - so an address match on it is a question, not an
    answer."""
    from api.models import Device, IPAddress, VirtualMachine

    wanted = {a for a in addresses if a}
    if not wanted:
        return {}
    owners: dict[str, set] = {}

    def own(address, name):
        if name:
            owners.setdefault(_address(str(address)), set()).add(name)

    rows = IPAddress.objects.filter(tenant=tenant, ip_address__in=sorted(wanted))
    for address, device_name, vm_name in rows.values_list(
        "ip_address", "assigned_device__name", "assigned_vm__name"
    ):
        own(address, device_name)
        own(address, vm_name and f"VM {vm_name}")
    # An address is also a device's or a VM's when it is their primary
    # address without being assigned to them - a VM recorded with the
    # hypervisor's address as its primary is exactly the case to catch.
    for address, name in Device.objects.filter(
        tenant=tenant, primary_ip__in=rows
    ).values_list("primary_ip__ip_address", "name"):
        own(address, name)
    for address, name in VirtualMachine.objects.filter(
        tenant=tenant, primary_ip__in=rows
    ).values_list("primary_ip__ip_address", "name"):
        own(address, name and f"VM {name}")
    return {a: sorted(n) for a, n in owners.items() if len(n) > 1}


def index_devices(rows) -> dict:
    """PRTG devices (normalised ``table.json`` rows) indexed for every level,
    plus ``by_id`` for the stored link. Built once per pass."""
    index: dict = {"by_id": {}, "tag": {}, "address": {}, "dns": {}, "name": {}}
    for row in rows:
        row = {**row, "objid": str(row["objid"])}
        index["by_id"][row["objid"]] = row
        for tag in row.get("tags") or ():
            if tag.lower().startswith("danbyte-"):
                index["tag"].setdefault(tag.lower(), []).append(row)
        host = row.get("host") or ""
        if _address(host):
            index["address"].setdefault(_address(host), []).append(row)
        elif _dns(host):
            index["dns"].setdefault(_dns(host), []).append(row)
        name = (row.get("name") or "").strip().lower()
        if name:
            index["name"].setdefault(name, []).append(row)
    return index


CASCADE = Cascade(
    levels=(
        Level("tag", lambda d: [tag_for(d).lower()]),
        Level("address", lambda d: sorted(getattr(d, "_prtg_ips", ()))),
        Level("dns", lambda d: sorted(getattr(d, "_prtg_dns", ()))),
        Level("name", lambda d: [(d.name or "").strip().lower()]),
    ),
    id_key="objid",
    label_key="name",
    plural="PRTG devices",
    singular="PRTG device",
)


def match_device(device, index, link=None) -> Match:
    """Which PRTG device this device is, and how that was decided."""
    return CASCADE.match(device, index, str(link.objid) if link is not None else None)


# ── virtual machines ────────────────────────────────────────────────────────


def annotate_vms(tenant, vms) -> list:
    """Each VM with ``_prtg_ips`` and ``_prtg_dns``: its primary address and
    every address assigned to it (directly or through a VM interface) in
    this tenant, with their DNS names. Each VM is marked ``_prtg_vm`` so the
    passes know which kind of parent a match is for."""
    from django.db.models import Q

    from api.models import IPAddress

    vms = list(vms)
    by_id = {v.id: v for v in vms}
    for v in vms:
        v._prtg_ips, v._prtg_dns, v._prtg_vm = set(), set(), True
    if not by_id:
        return vms
    ids = list(by_id)
    rows = IPAddress.objects.filter(tenant=tenant).filter(
        Q(assigned_vm_id__in=ids) | Q(assigned_vm_interface__vm_id__in=ids)
        | Q(primary_ip_for_vms__id__in=ids)
    ).values_list(
        "assigned_vm_id", "assigned_vm_interface__vm_id", "primary_ip_for_vms__id",
        "ip_address", "dns_name",
    )
    for direct, via_iface, primary, address, dns_name in rows:
        for vm_id in {direct, via_iface, primary} - {None}:
            v = by_id.get(vm_id)
            if v is None:
                continue
            if _address(str(address)):
                v._prtg_ips.add(_address(str(address)))
            if dns_name:
                v._prtg_dns.add(_dns(dns_name))
    for v in vms:
        _override(v)
    return vms


#: A VM is recognised by its tag, an address or a DNS name - not by name
#: alone: VM names repeat the names of the hosts and services around them,
#: and a name match would make a device's established pairing ambiguous.
VM_CASCADE = Cascade(
    levels=CASCADE.levels[:3],
    id_key="objid",
    label_key="name",
    plural="PRTG devices",
    singular="PRTG device",
)


def match_vm(vm, index, link=None) -> Match:
    """Which PRTG device this VM is, and how that was decided."""
    return VM_CASCADE.match(vm, index, str(link.objid) if link is not None else None)
