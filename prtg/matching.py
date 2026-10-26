"""Which PRTG device is this Danbyte device?

Tried most reliable first, stopping at the first unambiguous hit:

1. **A stored link** - kept, so a rename or re-addressing on either side does
   not break the pairing.
2. **The tag** ``danbyte-<device uuid>`` on the PRTG device - written by
   Danbyte when it provisions, or by an operator who wants to pin a pairing.
3. **An address.** PRTG's ``host`` field equals one of the addresses assigned
   to the device in Danbyte.
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

__all__ = ["CASCADE", "Match", "annotate_devices", "index_devices", "match_device", "tag_for"]


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
    """Each device with ``_prtg_ips`` and ``_prtg_dns``: every address
    assigned to it in this tenant and their DNS names. One query for all."""
    from api.models import IPAddress

    devices = list(devices)
    by_id = {d.id: d for d in devices}
    for d in devices:
        d._prtg_ips, d._prtg_dns = set(), set()
    rows = IPAddress.objects.filter(
        tenant=tenant, assigned_device_id__in=list(by_id)
    ).values_list("assigned_device_id", "ip_address", "dns_name")
    for device_id, address, dns_name in rows:
        d = by_id[device_id]
        if _address(str(address)):
            d._prtg_ips.add(_address(str(address)))
        if dns_name:
            d._prtg_dns.add(_dns(dns_name))
    return devices


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
