"""MAC tracking, read side (#284): uplinks, Location, and MAC → IP → name.

Nothing here writes. :mod:`monitoring.mac_tables` stores what each poll saw;
this module answers the questions people ask of it.

**Uplinks** (§4.1) are evaluated on read, from the per-port summary a poll
stored (``DeviceSnmp.mac_ports``), the interface's live Uplink setting and
the tenant's current settings - so a changed threshold applies without a
re-poll. A port is an uplink when its interface says *Always*, when its LLDP
neighbour is a switch (bridge or router capabilities without telephone, or a
device Danbyte polls with a MAC table), when it is a LAG aggregate or member,
or when it learns more distinct MACs than *Uplink above*. *Never* beats every
rule but *Always*; the reasons are kept either way.

**Location** (§6) is where a MAC really sits: of its present sightings on
devices the caller may view, the access (non-uplink) ones win; with none,
the uplink nearest to it (fewest MACs) - *behind uplink*. Among equals, a
sighting that started after another was last seen supersedes it (the MAC
moved), one more than a day older than the newest is stale, then the port
with the fewest MACs, then the device and port name. Recency only ever
removes evidence, it never ranks it, so two switches that both keep
reporting a MAC give the same answer on every poll instead of trading it.

**Enrichment** (§5.5) joins each MAC to its IPs - ARP on any polled device
(or only the tenant's ARP sources, when it names some), DHCP leases and
reservations, and IP addresses paired with it - and to a name. Every join is
tenant-filtered and cut to the caller's view scope for its own type.
"""
from __future__ import annotations

import ipaddress
from collections import defaultdict
from dataclasses import dataclass

from django.db.models import Exists, F, OuterRef, Q

from api.natural import natural_key
from auth_api import rbac

from .mac_tables import (
    STALE_AFTER,
    canon_mac,
    filter_hex,
    hexkey,
    is_stale,
    mac_settings,
)

# ─── scoping helpers ─────────────────────────────────────────────────────────


def restrict(qs, user, tenant, slug):
    """``qs`` cut to the rows ``user`` may view; ``user=None`` is the system
    (drift, a background job) and sees the tenant's rows."""
    if user is None:
        return qs
    return rbac.restrict_queryset(qs, user, tenant, slug, "view")


def viewable_ids(model, tenant_path, ids, user, tenant, slug) -> set:
    """The ids among ``ids`` of rows in ``tenant`` the caller may view."""
    ids = {i for i in ids if i}
    if not ids:
        return set()
    qs = model.objects.filter(pk__in=ids, **{tenant_path: tenant})
    return set(restrict(qs, user, tenant, slug).values_list("pk", flat=True))


def viewable_devices(tenant, user):
    """A subquery of the devices ``user`` may view, or ``None`` when that is
    every device in the tenant."""
    from api.models import Device

    if user is None or getattr(user, "is_superuser", False):
        return None
    return restrict(Device.objects.filter(tenant=tenant), user, tenant, "device").values("pk")


def arp_source_ids(tenant) -> list:
    from .models import MonitoringSettings

    return [
        i for i in MonitoringSettings.objects.filter(tenant=tenant).values_list(
            "arp_source_devices__id", flat=True
        ) if i
    ]


# ─── uplinks ─────────────────────────────────────────────────────────────────


@dataclass
class Uplink:
    is_uplink: bool
    mode: str  # auto | always | never
    reasons: list
    count: int

    def payload(self) -> dict:
        return {"is": self.is_uplink, "mode": self.mode, "reasons": self.reasons}


def _flags_qs(tenant):
    from api.models import Interface

    return Interface.objects.filter(device__tenant=tenant).annotate(
        _members=Exists(Interface.objects.filter(lag_id=OuterRef("pk")))
    )


class UplinkContext:
    """Everything the uplink rules read, loaded once per batch.

    :meth:`load` takes the polled devices and interfaces a batch touches and
    fetches only what is not loaded yet - one query each - so a table of 48
    ports costs what a table of 4 does."""

    def __init__(self, tenant, *, settings=None, ports=None):
        self.tenant = tenant
        self.settings = settings or mac_settings(tenant)
        self.ports: dict = dict(ports or {})
        self.flags: dict = {}
        self._loaded_ifaces: set = set()
        self._all_flags = False
        self._names: set | None = None

    def load(self, polled_ids=(), interface_ids=()) -> UplinkContext:
        from .models import DeviceSnmp

        missing = {i for i in polled_ids if i and i not in self.ports}
        if missing:
            for did, summary in DeviceSnmp.objects.filter(
                tenant=self.tenant, device_id__in=missing
            ).values_list("device_id", "mac_ports"):
                self.ports[did] = summary or {}
            for did in missing:
                self.ports.setdefault(did, {})
        if not self._all_flags:
            want = {i for i in interface_ids if i and i not in self._loaded_ifaces}
            if want:
                self._read_flags(_flags_qs(self.tenant).filter(pk__in=want))
                self._loaded_ifaces |= want
        return self

    def load_all_flags(self) -> UplinkContext:
        """Every interface in the tenant whose setting or LAG could change an
        answer - the rest are Automatic and in no bundle."""
        if not self._all_flags:
            self._read_flags(
                _flags_qs(self.tenant).filter(
                    Q(is_uplink=True) | Q(never_uplink=True) | Q(lag__isnull=False)
                    | Q(type="lag") | Q(_members=True)
                )
            )
            self._all_flags = True
        return self

    def _read_flags(self, qs) -> None:
        for pk, up, never, lag_id, typ, members in qs.values_list(
            "id", "is_uplink", "never_uplink", "lag_id", "type", "_members"
        ):
            lag = "aggregate" if (typ == "lag" or members) else ("member" if lag_id else None)
            self.flags[pk] = (bool(up), bool(never), lag)

    def _mac_table_names(self) -> set:
        """Names (and sysNames) of the devices Danbyte polls with a MAC
        table - including ones polled before 0.17 whose JSON table is all they
        have yet. Loaded on first need."""
        if self._names is None:
            from .models import DeviceSnmp

            names: set = set()
            for name, sys_name in DeviceSnmp.objects.filter(
                tenant=self.tenant, device__isnull=False
            ).filter(
                Q(fdb_polled_at__isnull=False) | (Q(fdb_meta={}) & ~Q(fdb=[]))
            ).values_list("device__name", "data__sys_name"):
                for n in (name, sys_name):
                    if isinstance(n, str) and n.strip():
                        names.add(n.strip().lower())
            self._names = names
        return self._names

    def classify(self, polled_id, port_key, interface_id=None) -> Uplink:
        entry = (self.ports.get(polled_id) or {}).get(port_key) or {}
        try:
            count = int(entry.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        up, never, iface_lag = self.flags.get(interface_id, (False, False, None))
        reasons: list[dict] = []
        if up:
            reasons.append({"code": "always", "text": "Set on the interface"})
        lldp = entry.get("lldp") if isinstance(entry.get("lldp"), dict) else None
        if lldp and self.settings["mac_uplink_lldp"]:
            name = str(lldp.get("name") or "")
            if lldp.get("switch") or (
                name and name.strip().lower() in self._mac_table_names()
            ):
                reasons.append({
                    "code": "lldp", "text": f"LLDP neighbour {name}", "neighbor": name,
                })
        lag = entry.get("lag") or iface_lag
        if lag:
            reasons.append({
                "code": "lag", "text": "Aggregate" if lag == "aggregate" else "LAG member",
                "lag": lag,
            })
        threshold = int(self.settings["mac_uplink_threshold"] or 0)
        if threshold and count > threshold:
            reasons.append({
                "code": "count", "text": f"{count} MACs, above {threshold}",
                "count": count, "threshold": threshold,
            })
        if up:
            return Uplink(True, "always", reasons, count)
        if never:
            return Uplink(False, "never", reasons, count)
        return Uplink(bool(reasons), "auto", reasons, count)


# ─── sightings and Location ─────────────────────────────────────────────────


@dataclass
class Seen:
    id: object
    mac: str
    polled_device_id: object
    device_id: object
    device_name: str
    site_id: object
    interface_id: object
    interface_name: str | None
    port_key: str
    port_name: str
    if_index: str
    vlan: int | None
    first_seen: object
    last_seen: object
    gone_at: object
    uplink: Uplink | None = None


SEEN_VALUES = (
    "id", "mac", "polled_device_id", "device_id", "device__name", "device__site_id",
    "interface_id", "interface__name", "port_key", "port_name", "if_index",
    "vlan_vid", "first_seen", "last_seen", "gone_at",
)


def seen_rows(qs) -> list[Seen]:
    return [Seen(*row) for row in qs.values_list(*SEEN_VALUES)]


@dataclass
class Location:
    mac: str
    kind: str  # access | behind_uplink
    at: Seen
    others: list


def _current(pool: list[Seen]) -> list[Seen]:
    """Drop history from a set of present sightings of one MAC: a sighting
    another one *started after it was last seen* is where the MAC used to be,
    and one more than a day older than the newest is a switch that stopped
    answering. Never empty: the latest-started and then the latest-seen
    sighting always survive."""
    if len(pool) < 2:
        return pool
    keep = [
        c for c in pool
        if not any(d is not c and d.first_seen > c.last_seen for d in pool)
    ]
    newest = max(c.last_seen for c in keep)
    return [c for c in keep if c.last_seen >= newest - STALE_AFTER]


def choose(cands: list[Seen]) -> Location | None:
    """The Location among one MAC's classified present sightings."""
    if not cands:
        return None
    access = [c for c in cands if not c.uplink.is_uplink]
    pool = _current(access or list(cands))
    pool = sorted(pool, key=lambda c: (
        c.uplink.count, natural_key(c.device_name),
        natural_key(c.port_name or c.port_key), str(c.id),
    ))
    at = pool[0]
    return Location(
        at.mac, "access" if access else "behind_uplink", at,
        [c for c in cands if c is not at],
    )


def present_candidates(tenant, qs, user) -> list[Seen]:
    """Present sightings from ``qs`` on devices the caller may view."""
    qs = qs.filter(tenant=tenant, gone_at__isnull=True)
    scope = viewable_devices(tenant, user)
    if scope is not None:
        qs = qs.filter(device_id__in=scope)
    return seen_rows(qs)


def locate_rows(tenant, rows: list[Seen], ctx: UplinkContext | None = None) -> dict:
    """``{mac: Location}`` for already-loaded candidate rows."""
    if not rows:
        return {}
    ctx = ctx or UplinkContext(tenant)
    ctx.load({r.polled_device_id for r in rows}, {r.interface_id for r in rows})
    by_mac: dict = defaultdict(list)
    for r in rows:
        r.uplink = ctx.classify(r.polled_device_id, r.port_key, r.interface_id)
        by_mac[r.mac].append(r)
    return {mac: choose(cands) for mac, cands in by_mac.items()}


def locate(tenant, macs, user=None, *, ctx: UplinkContext | None = None) -> dict:
    """``{mac: Location}`` for MACs in any notation (keys are canonical).
    MACs with no present sighting the caller may view are absent."""
    from .models import MacSighting

    keys = {canon_mac(m) for m in macs}
    keys.discard(None)
    if not keys:
        return {}
    rows = present_candidates(tenant, MacSighting.objects.filter(mac__in=keys), user)
    return locate_rows(tenant, rows, ctx)


def locate_for_device(
    tenant, polled_device_id, user=None, *, member_id=None,
    ctx: UplinkContext | None = None,
) -> dict:
    """Location of every MAC present on one polled device (one stack member's
    ports with ``member_id``) - a semi-join, so the query count does not grow
    with the port count."""
    from .models import MacSighting

    own = MacSighting.objects.filter(
        tenant=tenant, polled_device_id=polled_device_id, gone_at__isnull=True
    )
    if member_id is not None:
        own = own.filter(device_id=member_id)
    rows = present_candidates(
        tenant, MacSighting.objects.filter(mac__in=own.values("mac")), user
    )
    return locate_rows(tenant, rows, ctx)


def vlan_objects(tenant, user, pairs) -> dict:
    """``{(site_id, vid): {id, name, vid}}`` - the Danbyte VLAN each VID means
    at the device's site (``api.vlan_scope``), only when the caller may view
    it. Read-only: nothing is created."""
    from api.models import VLAN
    from api.vlan_scope import resolve_vids

    resolved = resolve_vids(tenant, pairs, exclude_group_prefix="virt-")
    ids = {v.pk for v in resolved.values() if v is not None}
    ok = viewable_ids(VLAN, "tenant", ids, user, tenant, "vlan")
    return {
        pair: {"id": str(v.pk), "name": v.name, "vid": v.vlan_id}
        for pair, v in resolved.items() if v is not None and v.pk in ok
    }


def _device_ref(seen: Seen) -> dict:
    return {"id": str(seen.device_id), "name": seen.device_name}


def _iface_ref(seen: Seen) -> dict | None:
    if not seen.interface_id:
        return None
    return {"id": str(seen.interface_id), "name": seen.interface_name}


def seen_payload(seen: Seen, now=None) -> dict:
    return {
        "device": _device_ref(seen),
        "interface": _iface_ref(seen),
        "port_name": seen.port_name,
        "vlan": seen.vlan,
        "first_seen": seen.first_seen,
        "last_seen": seen.last_seen,
        "present": seen.gone_at is None,
        "role": "uplink" if seen.uplink and seen.uplink.is_uplink else "access",
        "stale": seen.gone_at is None and is_stale(seen.last_seen, now),
    }


def location_payload(loc: Location, vlans: dict | None = None, now=None) -> dict:
    at = loc.at
    return {
        "kind": loc.kind,
        "device": _device_ref(at),
        "interface": _iface_ref(at),
        "port_name": at.port_name,
        "vlan": at.vlan,
        "vlan_object": (vlans or {}).get((at.site_id, at.vlan)),
        "since": at.first_seen,
        "last_seen": at.last_seen,
        "stale": is_stale(at.last_seen, now),
        "uplink": at.uplink.payload(),
        "others": [seen_payload(o, now) for o in loc.others],
    }


def location_ref(loc: Location) -> dict:
    """The compact form a table cell needs: where, and how."""
    return {
        "kind": loc.kind,
        "device": _device_ref(loc.at),
        "interface": _iface_ref(loc.at),
        "port_name": loc.at.port_name,
    }


# ─── MAC → IP → name ────────────────────────────────────────────────────────


def _dhcp_tenant_q(tenant):
    # Synced scopes ride their connection's tenant; local ones carry it.
    return Q(scope__connection__tenant=tenant) | Q(
        scope__connection__isnull=True, scope__tenant=tenant
    )


def _dns_tenant_q(tenant):
    return Q(zone__connection__tenant=tenant) | Q(
        zone__connection__isnull=True, zone__tenant=tenant
    )


def _ip(value) -> str | None:
    try:
        return str(ipaddress.ip_address(str(value or "").strip()))
    except ValueError:
        return None


#: Label priority among objects carrying a MAC: the NIC a Danbyte device
#: has, then a VM's, then a MAC object's description.
_KNOWN_RANK = {"interface": 0, "vminterface": 1, "macaddress": 2}


def enrich(tenant, macs, user=None) -> dict:
    """``{mac: {ips, names, name, name_source}}`` for a batch of MACs, in a
    constant number of queries (§5.5). Nothing is written.

    ``ips`` lists ``{ip, ip_id, last_seen, sources}`` - ARP first (newest
    first), then DHCP leases, reservations and IP addresses paired with the
    MAC. An IP read from a device's ARP table shows only when the caller may
    view that device or an IP address row with that address, and the device
    is named only when viewable. ``names`` is in label priority - a known
    object (an interface, VM interface or MAC object carrying the MAC), then
    reverse DNS / DNS records / DHCP - and ``name`` is the first."""
    from api.models import (
        Device,
        Interface,
        IPAddress,
        MACAddress,
        VirtualMachine,
        VMInterface,
    )
    from integrations.models import DhcpLease, DhcpReservation, DnsRecord
    from integrations.toggles import integration_enabled

    from .models import ArpSighting

    keys = sorted({canon_mac(m) for m in macs} - {None})
    if not keys:
        return {}
    by_hex = {hexkey(k): k for k in keys}
    hexes = list(by_hex)

    # Sources of IPs.
    arp_qs = ArpSighting.objects.filter(tenant=tenant, mac__in=keys, gone_at__isnull=True)
    sources = arp_source_ids(tenant)
    if sources:
        arp_qs = arp_qs.filter(device_id__in=sources)
    arp = list(arp_qs.order_by("-last_seen", "ip").values_list(
        "mac", "ip", "device_id", "vm_id", "device__name", "vm__name", "last_seen",
    ))
    dev_ok = viewable_ids(Device, "tenant", {a[2] for a in arp}, user, tenant, "device")
    vm_ok = viewable_ids(
        VirtualMachine, "tenant", {a[3] for a in arp}, user, tenant, "virtualmachine"
    )
    leases = []
    if integration_enabled(tenant, "dhcp"):
        leases = list(filter_hex(
            restrict(DhcpLease.objects.filter(_dhcp_tenant_q(tenant)), user, tenant,
                     "dhcplease"),
            "mac", hexes,
        ).order_by(F("last_seen_at").desc(nulls_last=True), "ip").values_list(
            "_mac_hex", "ip", "hostname", "last_seen_at"
        ))
    reservations = list(filter_hex(
        restrict(DhcpReservation.objects.filter(_dhcp_tenant_q(tenant)), user, tenant,
                 "dhcpreservation"),
        "mac", hexes,
    ).order_by("ip").values_list("_mac_hex", "ip", "name"))
    paired = list(filter_hex(
        restrict(IPAddress.objects.filter(tenant=tenant), user, tenant, "ipaddress"),
        "mac_address", hexes,
    ).order_by("ip_address").values_list("_mac_hex", "ip_address", "id"))

    # IP rows by address: whether an ARP-only address may show, and its
    # reverse-DNS name.
    all_ips = {_ip(a[1]) for a in arp} | {_ip(r[1]) for r in leases}
    all_ips |= {_ip(r[1]) for r in reservations} | {_ip(r[1]) for r in paired}
    all_ips.discard(None)
    ip_rows: dict = {}
    dns: dict = defaultdict(list)
    if all_ips:
        for addr, pk, dns_name in restrict(
            IPAddress.objects.filter(tenant=tenant, ip_address__in=all_ips),
            user, tenant, "ipaddress",
        ).order_by("ip_address", "id").values_list("ip_address", "id", "dns_name"):
            addr = _ip(addr)
            cur = ip_rows.get(addr)
            if cur is None or (not cur[1] and dns_name):
                ip_rows[addr] = (pk, dns_name or "")
        for addr, name in restrict(
            DnsRecord.objects.filter(
                _dns_tenant_q(tenant), record_type__in=("A", "AAAA", "PTR"),
                ip__in=all_ips,
            ),
            user, tenant, "dnsrecord",
        ).order_by("name").values_list("ip", "name"):
            name = (name or "").rstrip(".")
            if name and name not in dns[_ip(addr)]:
                dns[_ip(addr)].append(name)

    out: dict = {k: {"ips": {}, "names": []} for k in keys}

    def add_ip(mac, addr, source, seen=None):
        addr = _ip(addr)
        if addr is None or mac not in out:
            return
        entry = out[mac]["ips"].setdefault(
            addr, {"ip": addr, "ip_id": None, "last_seen": None, "sources": []}
        )
        entry["sources"].append(source)
        if seen is not None and (entry["last_seen"] is None or seen > entry["last_seen"]):
            entry["last_seen"] = seen

    for mac, addr, dev_id, vm_id, dev_name, vm_name, last_seen in arp:
        owner_ok = (dev_id in dev_ok) if dev_id else (vm_id in vm_ok)
        if not owner_ok and _ip(addr) not in ip_rows:
            continue
        source = {"kind": "arp", "last_seen": last_seen}
        if dev_id:
            source["device"] = {"id": str(dev_id), "name": dev_name} if owner_ok else None
        else:
            source["vm"] = {"id": str(vm_id), "name": vm_name} if owner_ok else None
        add_ip(mac, addr, source, last_seen)
    for hx, addr, hostname, last_seen in leases:
        add_ip(by_hex.get(hx), addr,
               {"kind": "dhcp_lease", "hostname": hostname, "last_seen": last_seen},
               last_seen)
    for hx, addr, name in reservations:
        add_ip(by_hex.get(hx), addr, {"kind": "dhcp_reservation", "name": name})
    for hx, addr, pk in paired:
        add_ip(by_hex.get(hx), addr, {"kind": "ipaddress", "id": str(pk)})

    # Known objects carrying the MAC.
    known: dict = defaultdict(list)
    for hx, dev_name, name in filter_hex(
        restrict(Interface.objects.filter(device__tenant=tenant), user, tenant, "interface"),
        "mac_address", hexes,
    ).values_list("_mac_hex", "device__name", "name"):
        known[by_hex.get(hx)].append((f"{dev_name} · {name}", "interface"))
    for hx, vm_name, name in filter_hex(
        restrict(VMInterface.objects.filter(vm__tenant=tenant), user, tenant, "vminterface"),
        "mac_address", hexes,
    ).values_list("_mac_hex", "vm__name", "name"):
        known[by_hex.get(hx)].append((f"{vm_name} · {name}", "vminterface"))
    for hx, descr, dev_name, if_name in filter_hex(
        restrict(MACAddress.objects.filter(tenant=tenant), user, tenant, "macaddress"),
        "mac_address", hexes,
    ).values_list(
        "_mac_hex", "description", "assigned_interface__device__name",
        "assigned_interface__name",
    ):
        label = (descr or "").strip() or (f"{dev_name} · {if_name}" if dev_name else "")
        if label:
            known[by_hex.get(hx)].append((label, "macaddress"))

    for mac, data in out.items():
        entries = list(data["ips"].values())
        for e in entries:
            row = ip_rows.get(e["ip"])
            e["ip_id"] = str(row[0]) if row else None
        names: list[dict] = []
        seen_names: set = set()

        def push(name, source, ip=None, _names=names, _seen=seen_names):
            name = (name or "").strip()
            if name and name.lower() not in _seen:
                _seen.add(name.lower())
                entry = {"name": name, "source": source}
                if ip:
                    entry["ip"] = ip
                _names.append(entry)

        for label, source in sorted(
            known.get(mac, ()), key=lambda x: (_KNOWN_RANK[x[1]], natural_key(x[0]))
        ):
            push(label, source)
        for e in entries:
            row = ip_rows.get(e["ip"])
            if row and row[1]:
                push(row[1].rstrip("."), "dns", e["ip"])
            for name in dns.get(e["ip"], ()):
                push(name, "dns_record", e["ip"])
        for e in entries:
            for s in e["sources"]:
                if s["kind"] == "dhcp_lease":
                    push(s.get("hostname"), "dhcp_lease", e["ip"])
                elif s["kind"] == "dhcp_reservation":
                    push(s.get("name"), "dhcp_reservation", e["ip"])
        data["ips"] = entries
        data["names"] = names
        data["name"] = names[0]["name"] if names else None
        data["name_source"] = names[0]["source"] if names else None
    return out
