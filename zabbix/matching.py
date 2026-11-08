"""Which Zabbix host is this Danbyte device?

Four ways to answer, tried most-reliable first, and **stopping at the first
unambiguous hit**:

1. **A stored link.** Established once and kept, so a rename or a
   re-addressing on either side does not break the pairing.
2. **An interface address.** A Zabbix host answers on an address Danbyte has
   recorded for the device.
3. **The inventory serial.** Survives both a rename and a re-addressing, which
   is why it beats the name.
4. **The exact name.** Last, because names collide and get reused.

Where a level finds **two** candidates, the answer is **no match** - recorded
as needing a person. A wrong pairing means an operator reads one host's
problems believing they are reading another's, and nothing downstream would
ever flag it. A missing pairing is visible and fixable; a wrong one is neither.

The cascade itself is shared (:mod:`monitoring.external.matching`); this
module supplies Zabbix's levels and its host index.
"""
from __future__ import annotations

from monitoring.external.matching import Cascade, Level, Match

__all__ = ["CASCADE", "Match", "index_hosts", "match_device"]


def _device_addresses(device) -> set[str]:
    """Every address Danbyte knows for a device, mask stripped.

    The primary address plus anything on its interfaces: Zabbix commonly polls
    a management address that is not the one Danbyte calls primary.
    """
    out = set()
    if device.primary_ip_id and device.primary_ip:
        out.add(str(device.primary_ip.ip_address).split("/")[0])
    for ip in getattr(device, "_zbx_ips", ()) or ():
        out.add(str(ip).split("/")[0])
    return {a for a in out if a}


def index_hosts(hosts) -> dict:
    """Zabbix hosts indexed the three ways matching needs them.

    Built once per pass: matching a thousand devices must not be a thousand
    scans of the host list.
    """
    by_address: dict[str, list] = {}
    by_serial: dict[str, list] = {}
    by_name: dict[str, list] = {}
    for host in hosts:
        for iface in host.get("interfaces") or []:
            addr = (iface.get("ip") or "").strip()
            if addr:
                by_address.setdefault(addr, []).append(host)
        inventory = host.get("inventory") or {}
        serial = (inventory.get("serialno_a") or "").strip().lower()
        if serial:
            by_serial.setdefault(serial, []).append(host)
        for key in ("host", "name"):
            value = (host.get(key) or "").strip().lower()
            if value:
                by_name.setdefault(value, []).append(host)
    return {"address": by_address, "serial": by_serial, "name": by_name}


CASCADE = Cascade(
    levels=(
        Level("address", lambda device: sorted(_device_addresses(device))),
        Level("serial", lambda device: [(device.serial_number or "").strip().lower()]),
        Level("name", lambda device: [(device.name or "").strip().lower()]),
    ),
    id_key="hostid",
    label_key="name",
    plural="Zabbix hosts",
    singular="Zabbix host",
)


def match_device(device, index, link=None) -> Match:
    """Which Zabbix host this device is, and how we decided."""
    return CASCADE.match(device, index, link.hostid if link is not None else None)
