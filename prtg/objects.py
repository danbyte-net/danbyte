"""What each PRTG sensor watches: an address, an interface, a service.

Resolved after every read that writes a link's sensors, so the IP address,
interface and service pages can show the sensors that are about them. Only
the linked device's or VM's own objects are candidates, in the connection's
tenant; a sensor that could mean two of them means none.

* **Address** - every sensor of a PRTG device probes that device's host, so
  the link's ``host`` is matched to one of the device's (or VM's) assigned
  addresses: by address when it is one, otherwise by the address's DNS name.
* **Interface** - SNMP traffic sensors only. PRTG names them
  ``(001) GigabitEthernet0/1 Traffic``: the index in brackets is the ifIndex,
  looked up in the device's last SNMP poll; without an index, or when the
  poll does not know it, the rest of the name is matched to an interface's
  name, label or SNMP name, or to a polled ifName, ifDescr or ifAlias.
* **Service** - HTTP and SSL sensors only. The port comes from the sensor's
  name (``(Port 8443)``, ``:8443``), else 443 for SSL and for a name that says
  HTTPS, else 80. A service on that TCP port of the device or VM is the one;
  two of them are decided by the address the service answers on, or not at
  all.
"""
from __future__ import annotations

import ipaddress
import re

from .sensor_kinds import BY_VALUE

_TRAFFIC = BY_VALUE["snmp_traffic"]
_HTTP = BY_VALUE["http"]
_SSL = (BY_VALUE["ssl_certificate"], BY_VALUE["ssl_security"])

#: ``(001) GigabitEthernet0/1 Traffic`` -> index 1, name GigabitEthernet0/1.
_TRAFFIC_NAME = re.compile(
    r"^\s*(?:\((?P<index>\d+)\)\s*)?(?:traffic\s+)?(?P<name>.*?)(?:\s+traffic)?\s*$",
    re.I,
)
_PORT_IN_NAME = (
    re.compile(r"\bport\s*(\d{1,5})\b", re.I),
    re.compile(r":(\d{1,5})\b"),
)


def _norm(value) -> str:
    return (value or "").strip().lower()


def parse_traffic_name(name: str) -> tuple[str, str]:
    """``(ifIndex, interface name)`` from a traffic sensor's name; either may
    be blank."""
    m = _TRAFFIC_NAME.match(name or "")
    if not m:
        return "", ""
    index = str(int(m.group("index"))) if m.group("index") else ""
    return index, (m.group("name") or "").strip()


def service_port(kind: str, name: str) -> int | None:
    """The TCP port an HTTP or SSL sensor checks, or ``None`` for any other
    sensor."""
    is_ssl = any(k.matches_type(kind) for k in _SSL)
    if not (is_ssl or _HTTP.matches_type(kind)):
        return None
    for pattern in _PORT_IN_NAME:
        m = pattern.search(name or "")
        if m and 0 < int(m.group(1)) < 65536:
            return int(m.group(1))
    if is_ssl or "https" in _norm(name):
        return 443
    return 80


def is_traffic(kind: str) -> bool:
    return _TRAFFIC.matches_type(kind)


def _one(items):
    """The single distinct item, or ``None`` when there are none or several."""
    distinct = {getattr(i, "id", i): i for i in items if i is not None}
    return next(iter(distinct.values())) if len(distinct) == 1 else None


class _Owner:
    """The linked device's or VM's addresses, interfaces, services and last
    SNMP poll, loaded once per link."""

    def __init__(self, link, tenant):
        from api.models import Interface, IPAddress, Service, VMInterface

        self.vm = bool(link.virtual_machine_id)
        if self.vm:
            owner = {"assigned_vm_id": link.virtual_machine_id}
            svc = {"virtual_machine_id": link.virtual_machine_id}
            snmp = {"vm_id": link.virtual_machine_id}
            self.interfaces = list(VMInterface.objects.filter(
                vm_id=link.virtual_machine_id, vm__tenant=tenant,
            ).only("id", "name", "snmp_name"))
        else:
            owner = {"assigned_device_id": link.device_id}
            svc = {"device_id": link.device_id}
            snmp = {"device_id": link.device_id}
            self.interfaces = list(Interface.objects.filter(
                device_id=link.device_id, device__tenant=tenant,
            ).only("id", "name", "label", "snmp_name"))
        self.addresses = list(
            IPAddress.objects.filter(tenant=tenant, **owner).only("id", "ip_address", "dns_name")
        )
        self.services = list(Service.objects.filter(tenant=tenant, **svc).only(
            "id", "protocol", "ports", "protocol_ports", "ip_address_id",
        ))
        self._snmp_filter = {"tenant": tenant, **snmp}
        self._observed = None

    @property
    def observed(self) -> list[dict]:
        if self._observed is None:
            from monitoring.models import DeviceSnmp

            rows = (
                DeviceSnmp.objects.filter(**self._snmp_filter)
                .values_list("interfaces", flat=True).first()
            )
            self._observed = [r for r in rows or [] if isinstance(r, dict)]
        return self._observed

    # ── address ──────────────────────────────────────────────────────

    def address(self, host: str):
        host = (host or "").strip().rstrip(".")
        if not host:
            return None
        try:
            wanted = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            return _one(a for a in self.addresses
                        if _norm(a.dns_name).rstrip(".") == host.lower())
        out = []
        for a in self.addresses:
            try:
                if ipaddress.ip_address(str(a.ip_address).split("/")[0]) == wanted:
                    out.append(a)
            except ValueError:
                continue
        return _one(out)

    # ── interface ────────────────────────────────────────────────────

    def _by_names(self, *keys):
        keys = {_norm(k) for k in keys if _norm(k)}
        return [
            i for i in self.interfaces
            if keys & {_norm(i.name), _norm(getattr(i, "label", "")), _norm(i.snmp_name)}
        ]

    def interface(self, sensor_name: str):
        index, name = parse_traffic_name(sensor_name)
        if index:
            rows = [o for o in self.observed if str(o.get("if_index") or "").strip() == index]
            if len(rows) == 1:
                o = rows[0]
                found = _one(self._by_names(o.get("name")) or self._by_names(o.get("descr")))
                if found is not None:
                    return found
        if not name:
            return None
        direct = self._by_names(name)
        if direct:
            return _one(direct)
        polled = [
            o for o in self.observed
            if _norm(name) in {_norm(o.get("name")), _norm(o.get("descr")), _norm(o.get("alias"))}
        ]
        return _one(
            _one(self._by_names(o.get("name")) or self._by_names(o.get("descr")))
            for o in polled
        ) if polled else None

    # ── service ──────────────────────────────────────────────────────

    def service(self, port: int, address):
        on_port = [s for s in self.services if port in (s.port_map().get("tcp") or [])]
        if len(on_port) <= 1:
            return _one(on_port)
        if address is None:
            return None
        return _one(s for s in on_port if s.ip_address_id == address.id)


def resolve(link, tenant) -> int:
    """Set ``ip_address``, ``interface``/``vm_interface`` and ``service`` on
    every sensor of ``link``. Returns how many rows changed."""
    from .models import PrtgSensor

    sensors = list(PrtgSensor.objects.filter(link=link))
    if not sensors:
        return 0
    owner = _Owner(link, tenant)
    address = owner.address(link.host)
    changed = []
    for s in sensors:
        iface = owner.interface(s.name) if is_traffic(s.kind) else None
        port = service_port(s.kind, s.name)
        want = {
            "ip_address_id": address.id if address else None,
            "interface_id": iface.id if iface is not None and not owner.vm else None,
            "vm_interface_id": iface.id if iface is not None and owner.vm else None,
            "service_id": (svc.id if (svc := owner.service(port, address)) else None)
            if port else None,
        }
        if any(getattr(s, k) != v for k, v in want.items()):
            for k, v in want.items():
                setattr(s, k, v)
            changed.append(s)
    if changed:
        PrtgSensor.objects.bulk_update(
            changed, ["ip_address", "interface", "vm_interface", "service"], batch_size=500,
        )
    return len(changed)
