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
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Match:
    """The outcome of matching one device."""

    device: object
    host: dict | None = None
    #: link | address | serial | name | none | ambiguous
    how: str = "none"
    #: Human sentence for the "needs a decision" queue.
    reason: str = ""

    @property
    def matched(self) -> bool:
        return self.host is not None


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


def _only(candidates):
    """One host, or nothing. Deduplicated by hostid first, because a host with
    two interfaces on the same address is one host, not an ambiguity."""
    if not candidates:
        return None, 0
    unique = {h["hostid"]: h for h in candidates}
    if len(unique) == 1:
        return next(iter(unique.values())), 1
    return None, len(unique)


def match_device(device, index, link=None) -> Match:
    """Which Zabbix host this device is, and how we decided."""
    if link is not None:
        host = index.get("by_id", {}).get(link.hostid)
        if host is not None:
            return Match(device, host, "link")
        # The link points at a host that is gone. Fall through and try to
        # find it again rather than reporting the device unmatched - a host
        # deleted and recreated in Zabbix is still the same box.

    for how, keys in (
        ("address", sorted(_device_addresses(device))),
        ("serial", [(device.serial_number or "").strip().lower()]),
        ("name", [(device.name or "").strip().lower()]),
    ):
        found = None
        for key in keys:
            if not key:
                continue
            hit, n = _only(index[how].get(key) or [])
            if n > 1:
                names = ", ".join(
                    sorted(h["name"] for h in index[how][key])[:4]
                )
                return Match(
                    device, None, "ambiguous",
                    f"{n} Zabbix hosts share this device's {how} "
                    f"'{key}' ({names}).",
                )
            if hit is not None:
                if found is not None and found["hostid"] != hit["hostid"]:
                    return Match(
                        device, None, "ambiguous",
                        f"This device's addresses point at different Zabbix "
                        f"hosts ({found['name']}, {hit['name']}).",
                    )
                found = hit
        if found is not None:
            return Match(device, found, how)

    return Match(device, None, "none", "No Zabbix host matches this device.")
