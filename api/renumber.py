"""Renumber a prefix tree: move a prefix, everything under it and every
address-bearing reference into a new parent of the same size.

A delegated block (DHCPv6-PD, a provider's /29) changes and every child
prefix, address, range and the text references to them have to move by the
same offset. :func:`build_plan` works out what moves and what is left alone;
:func:`apply_plan` writes it in one transaction.

What moves (offset = new network - old network):

* the prefix and every prefix inside it, same tenant and VRF; its gateway;
* every address inside it in that VRF (mask length, assignment, role, DNS
  name and status stay); an address whose prefix is above the tree is
  re-homed onto the tree prefix that holds it;
* IP ranges inside it;
* local DHCP scopes on a tree prefix: scope id, pool, options holding an
  address, exclusions and reservations;
* local DNS A/AAAA records linked to a moved address;
* routing text: static route destinations and next hops, BGP neighbour
  addresses, EIGRP summaries (all matched on VRF), prefix-list lines that
  name a tree prefix; and, when the tree is in the global table, prefix-list
  lines by text, policy-rule selectors, route-map ``set ip next-hop``, the
  BGP VPN export next hop, the LDP transport address and RPKI cache
  addresses;
* monitoring text: deny subnets (by VRF), and in the global table SNMP
  binding targets, Redfish hosts and watched endpoints.

Foreign keys to a moved prefix or address (FHRP virtual IPs, NAT rules,
services, VTEPs, primary IPs …) need no write: they follow the row. Anything
that carries an address inside the tree and is not rewritten is listed as
left unchanged, with the reason - nothing is skipped silently.

The plan is collected per tenant; what the caller sees of it is not (#504).
:class:`Viewer` answers, per kind, the rule that kind's own API applies, and
:func:`describe` shows only those rows: the rest is one ``hidden_total``
count, never an address, label or id. A row the renumber would write that
the caller can't view refuses the whole renumber (:func:`blockers`), so
nothing hidden is rewritten on their behalf.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from typing import Any

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from django.db.models import BooleanField, Q
from django.db.models.expressions import RawSQL

from .models import IPAddress, IPRange, Prefix

#: Rows returned per list; totals are always exact.
PREVIEW_LIMIT = 2000


class RenumberError(Exception):
    """A refusal: ``status`` 400 (the request) or 403 (permissions)."""

    def __init__(self, message: str, status: int = 400, field_name: str = "new_prefix"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.field_name = field_name


@dataclass
class Change:
    kind: str
    obj: Any
    label: str
    #: attname -> new value
    values: dict = field(default_factory=dict)
    #: attname -> (old text, new text) for the preview
    shown: dict = field(default_factory=dict)


@dataclass
class Plan:
    prefix: Prefix
    old: Any
    new: Any
    changes: list = field(default_factory=list)
    unchanged: list = field(default_factory=list)
    linked: list = field(default_factory=list)


# kind -> (label, rbac slug, how to find the rows the grant is checked on)
KINDS: dict[str, tuple[str, str]] = {
    "prefix": ("Prefixes", "prefix"),
    "ipaddress": ("IP addresses", "ipaddress"),
    "iprange": ("IP ranges", "iprange"),
    "dhcpscope": ("DHCP scopes", "dhcpscope"),
    "dhcpexclusion": ("DHCP exclusions", "dhcpscope"),
    "dhcpreservation": ("DHCP reservations", "dhcpreservation"),
    "dhcplease": ("DHCP leases", "dhcplease"),
    "dnsrecord": ("DNS records", "dnsrecord"),
    "dnsdrift": ("DNS drift", "dnsdrift"),
    "staticroute": ("Static routes", "staticroute"),
    "policyrule": ("Policy rules", "policyrule"),
    "prefixlistrule": ("Prefix list rules", "prefixlistrule"),
    "routingpolicyrule": ("Routing policy rules", "routingpolicyrule"),
    "bgpsession": ("BGP sessions", "bgpsession"),
    "bgpinstance": ("BGP instances", "bgpinstance"),
    "ldpinstance": ("LDP instances", "ldpinstance"),
    "eigrpinterface": ("EIGRP interfaces", "eigrpinterface"),
    "rpkicache": ("RPKI caches", "rpkicache"),
    "roa": ("ROAs", "roa"),
    "aggregate": ("Aggregates", "aggregate"),
    "monitoringdenysubnet": ("Monitoring deny subnets", "monitoringdenysubnet"),
    "snmpprofilebinding": ("SNMP profile bindings", "snmpprofile"),
    "redfishendpoint": ("BMC (Redfish) endpoints", "redfishendpoint"),
    "watchedendpoint": ("Watched endpoints", "watchedendpoint"),
    "monitoringengine": ("Monitoring engines", "monitoringengine"),
    "arpsighting": ("ARP sightings", "arpsighting"),
    "oxidizednodelink": ("Oxidized node links", "oxidizednodelink"),
    "prtgdevicelink": ("PRTG device links", "prtgdevicelink"),
}


# ─── address arithmetic ─────────────────────────────────────────────────────


class _Shift:
    def __init__(self, old, new):
        self.old = old
        self.new = new
        self.offset = int(new.network_address) - int(old.network_address)

    def ip(self, value) -> str | None:
        """The moved address, or None when ``value`` is not an address inside
        the old prefix."""
        try:
            ip = ipaddress.ip_address(str(value).strip())
        except ValueError:
            return None
        if ip.version != self.old.version or ip not in self.old:
            return None
        return str(type(ip)(int(ip) + self.offset))

    def net(self, value) -> str | None:
        """The moved network, or None when ``value`` is not a network inside
        the old prefix (the prefix itself counts)."""
        try:
            n = ipaddress.ip_network(str(value).strip(), strict=False)
        except ValueError:
            return None
        if n.version != self.old.version or not n.subnet_of(self.old):
            return None
        return str(type(n)((int(n.network_address) + self.offset, n.prefixlen)))

    def touches(self, value) -> bool:
        """``value`` (an address or a network) overlaps the old prefix."""
        text = str(value or "").strip()
        if not text:
            return False
        try:
            n = ipaddress.ip_network(text, strict=False)
        except ValueError:
            return False
        return n.version == self.old.version and n.overlaps(self.old)

    def json(self, value):
        """``value`` with every string that is an address inside the old
        prefix moved. Returns ``(new value, changed)``."""
        if isinstance(value, str):
            moved = self.ip(value)
            return (moved, True) if moved is not None else (value, False)
        if isinstance(value, list):
            out, changed = [], False
            for v in value:
                nv, c = self.json(v)
                out.append(nv)
                changed = changed or c
            return out, changed
        if isinstance(value, dict):
            out, changed = {}, False
            for k, v in value.items():
                nv, c = self.json(v)
                out[k] = nv
                changed = changed or c
            return out, changed
        return value, False


def _inside(qs, column: str, net, cast: bool = False):
    """Rows whose ``column`` lies inside ``net`` - the containment test runs
    in PostgreSQL on the inet value."""
    col = f'"{qs.model._meta.db_table}"."{column}"' + ("::inet" if cast else "")
    alias = f"_rn_in_{column}"
    return qs.annotate(**{
        alias: RawSQL(f"{col} <<= %s::inet", (str(net),), output_field=BooleanField())
    }).filter(**{alias: True})


def _vrf_q(path: str, vrf_id) -> Q:
    return Q(**{f"{path}__isnull": True}) if vrf_id is None else Q(**{f"{path}_id": vrf_id})


# ─── visibility ─────────────────────────────────────────────────────────────


class Viewer:
    """Which plan rows ``user`` may view, each by the rule of that object's
    own API. ``user=None`` (an internal call) and superusers see everything.
    A kind with no rule here is hidden: fail closed."""

    def __init__(self, user, tenant):
        self.user = user
        self.tenant = tenant
        self.everything = user is None or bool(getattr(user, "is_superuser", False))

    def _view(self, qs, slug: str) -> set:
        from auth_api import rbac
        from auth_api.object_types import is_registered

        if not is_registered(slug):
            return set()
        return set(rbac.restrict_queryset(qs, self.user, self.tenant, slug, "view")
                   .values_list("pk", flat=True))

    def _ids(self, model, slug: str, ids) -> set:
        ids = {i for i in ids if i is not None}
        if not ids:
            return set()
        return self._view(model._default_manager.filter(pk__in=ids), slug)

    def visible(self, kind: str, objs) -> set:
        """The pks of ``objs`` (all of one ``kind``) the user may view."""
        objs = list(objs)
        if not objs:
            return set()
        if self.everything:
            return {o.pk for o in objs}
        rule = getattr(self, f"_rule_{kind}", None)
        if rule is not None:
            return rule(objs)
        model = type(objs[0])
        return self._ids(model, model._meta.model_name, {o.pk for o in objs})

    def sees(self, kind: str, obj) -> bool:
        return obj.pk in self.visible(kind, [obj])

    # A DHCP exclusion is part of its scope (the scope's API lists it).
    def _rule_dhcpexclusion(self, objs):
        from integrations.models import DhcpScope

        ok = self._ids(DhcpScope, "dhcpscope", {o.scope_id for o in objs})
        return {o.pk for o in objs if o.scope_id in ok}

    # The BMC endpoint is read through its device (/monitoring/devices/<id>/redfish/).
    def _rule_redfishendpoint(self, objs):
        from .models import Device

        ok = self._ids(Device, "device", {o.device_id for o in objs})
        return {o.pk for o in objs if o.device_id in ok}

    # An ARP entry is shown where the MAC lookup shows it (api/mac_views):
    # macaddress view, and only on devices and VMs the user may view.
    def _rule_arpsighting(self, objs):
        from auth_api import rbac

        from .models import Device, VirtualMachine

        if not rbac.has_action(self.user, self.tenant, "macaddress", "view"):
            return set()
        devs = self._ids(Device, "device", {o.device_id for o in objs})
        vms = self._ids(VirtualMachine, "virtualmachine", {o.vm_id for o in objs})
        return {o.pk for o in objs
                if (o.device_id and o.device_id in devs) or (o.vm_id and o.vm_id in vms)}

    # The engine list (with its SSH host and agent address) is readable by
    # every member of the tenant: the site forms need it (monitoring viewsets).
    def _rule_monitoringengine(self, objs):
        return {o.pk for o in objs}

    # An SNMP binding is read through its target (monitoring snmp_binding_view).
    def _rule_snmpprofilebinding(self, objs):
        from auth_api import rbac
        from monitoring.models import SnmpProfileBinding as B
        from monitoring.views import _binding_target, _can_access_binding_target

        out = set()
        for b in objs:
            slugs = {B.SCOPE_SITE: ("site", "device"),
                     B.SCOPE_LOCATION: ("location", "device")}.get(b.scope, ("device",))
            if not any(rbac.has_action(self.user, self.tenant, s, "view") for s in slugs):
                continue
            target = _binding_target(self.tenant, b.scope, b.object_id)
            if target is not None and _can_access_binding_target(
                    self.user, self.tenant, b.scope, target, "view"):
                out.add(b.pk)
        return out


# ─── labels ─────────────────────────────────────────────────────────────────


def _owner(obj) -> str:
    owner = getattr(obj, "owner_name", None)
    return owner if isinstance(owner, str) else ""


def _ip_label(ip) -> str:
    if ip.dns_name:
        return ip.dns_name
    if ip.assigned_interface_id and ip.assigned_interface is not None:
        dev = ip.assigned_interface.device
        return f"{dev.name if dev else '?'} · {ip.assigned_interface.name}"
    if ip.assigned_vm_id and ip.assigned_vm is not None:
        return ip.assigned_vm.name
    return (ip.description or "")[:80]


def _prefix_label(p) -> str:
    if p.vlan_id and p.vlan is not None:
        return f"VLAN {p.vlan.vid} {p.vlan.name}".strip()
    return (p.description or "")[:80]


# ─── the plan ───────────────────────────────────────────────────────────────


def parse_target(prefix: Prefix, raw) -> tuple[Any, Any]:
    """``(old network, new network)``, or a :class:`RenumberError`."""
    old = prefix.network
    if old is None:
        raise RenumberError("This prefix's CIDR is not valid.")
    text = str(raw or "").strip()
    if not text:
        raise RenumberError("Enter the new prefix.")
    if "/" not in text:
        raise RenumberError(f"Include the length, e.g. /{old.prefixlen}.")
    try:
        new = ipaddress.ip_network(text, strict=True)
    except ValueError as exc:
        raise RenumberError(f"Not a valid prefix: {exc}.") from None
    if new.version != old.version:
        raise RenumberError(f"Must be IPv{old.version}, like {old}.")
    if new.prefixlen != old.prefixlen:
        raise RenumberError(f"Must be a /{old.prefixlen}, the same size as {old}.")
    if new == old:
        raise RenumberError("That is the prefix's current network.")
    return old, new


def build_plan(prefix: Prefix, raw_new, *, lock: bool = False,
               viewer: Viewer | None = None) -> Plan:
    """Everything a renumber of ``prefix`` to ``raw_new`` writes, and every
    reference it leaves alone. Raises :class:`RenumberError` on a conflict;
    a conflicting row ``viewer`` may not view is not named.
    ``lock`` takes row locks on what it will write (inside a transaction)."""
    old, new = parse_target(prefix, raw_new)
    sh = _Shift(old, new)
    tenant_id, vrf_id = prefix.tenant_id, prefix.vrf_id
    global_table = vrf_id is None
    plan = Plan(prefix=prefix, old=old, new=new)
    viewer = viewer or Viewer(None, None)

    def locked(qs):
        return qs.select_for_update(of=("self",)) if lock else qs

    # ── conflicts in the new space ─────────────────────────────────────
    in_vrf = Q(tenant_id=tenant_id) & _vrf_q("vrf", vrf_id)
    first = _inside(Prefix.objects.filter(in_vrf), "cidr", new, cast=True).first()
    if first:
        if viewer.sees("prefix", first):
            raise RenumberError(f"{first.cidr} already exists inside {new}.")
        raise RenumberError(f"A prefix you can't view already exists inside {new}.")
    first = _inside(IPAddress.objects.filter(in_vrf), "ip_address", new).first()
    if first:
        if viewer.sees("ipaddress", first):
            raise RenumberError(f"The address {first.ip_address} already exists inside {new}.")
        raise RenumberError(f"An address you can't view already exists inside {new}.")
    for net, what in ((new, "overlaps {net}"), (old, "crosses the edge of {net}")):
        ranges = IPRange.objects.filter(in_vrf).annotate(_rn_ov=RawSQL(
            '"api_iprange"."start_address" <= %s::inet AND '
            '"api_iprange"."end_address" >= %s::inet AND '
            'family("api_iprange"."start_address") = %s',
            (str(net.broadcast_address), str(net.network_address), net.version),
            output_field=BooleanField(),
        )).filter(_rn_ov=True)
        for r in ranges:
            s, e = r._start_ip, r._end_ip
            if net is old and s is not None and e is not None and s in old and e in old:
                continue
            name = (f"The IP range {r.start_address}–{r.end_address}"
                    if viewer.sees("iprange", r) else "An IP range you can't view")
            raise RenumberError(f"{name} " + what.format(net=net) + ".")

    # ── prefixes ───────────────────────────────────────────────────────
    tree = list(locked(_inside(
        Prefix.objects.filter(in_vrf).select_related("vlan"), "cidr", old, cast=True,
    )))
    tree_ids = {p.pk for p in tree}
    if prefix.pk not in tree_ids:  # defensive: the root is always inside itself
        raise RenumberError("This prefix's CIDR is not valid.")
    tree_nets = sorted(
        ((p.network, p) for p in tree if p.network is not None),
        key=lambda t: t[0].prefixlen, reverse=True,
    )

    def deepest(addr: str):
        a = ipaddress.ip_address(addr)
        for n, p in tree_nets:
            if a in n:
                return p
        return prefix

    for p in sorted(tree, key=lambda x: (x.network.prefixlen, int(x.network.network_address))):
        ch = Change("prefix", p, _prefix_label(p))
        ch.values["cidr"] = sh.net(p.cidr)
        ch.shown["cidr"] = (p.cidr, ch.values["cidr"])
        if p.gateway:
            moved = sh.ip(p.gateway)
            if moved:
                ch.values["gateway"] = moved
                ch.shown["gateway"] = (p.gateway, moved)
            else:
                _keep(plan, "prefix", p, p.cidr, f"gateway {p.gateway}",
                      "Gateway is outside the prefix.")
        plan.changes.append(ch)

    # ── addresses ──────────────────────────────────────────────────────
    ips = list(locked(_inside(
        IPAddress.objects.filter(in_vrf).select_related(
            "assigned_interface__device", "assigned_vm"),
        "ip_address", old,
    )))
    moved_ip_ids = {ip.pk for ip in ips}
    for ip in sorted(ips, key=lambda x: int(ipaddress.ip_address(x.ip_address))):
        new_addr = sh.ip(ip.ip_address)
        ch = Change("ipaddress", ip, _ip_label(ip))
        ch.values["ip_address"] = new_addr
        ch.shown["ip_address"] = (ip.ip_address, new_addr)
        if ip.prefix_id not in tree_ids:
            home = deepest(ip.ip_address)
            ch.values["prefix_id"] = home.pk
            ch.shown["prefix"] = ("", sh.net(home.cidr))
        plan.changes.append(ch)
    for ip in IPAddress.objects.filter(prefix_id__in=tree_ids).exclude(pk__in=moved_ip_ids):
        _keep(plan, "ipaddress", ip, ip.ip_address, "", "Outside the prefix.")

    # ── ranges ─────────────────────────────────────────────────────────
    ranges = list(locked(_inside(_inside(
        IPRange.objects.filter(in_vrf), "start_address", old), "end_address", old)))
    moved_range_ids = {r.pk for r in ranges}
    for r in sorted(ranges, key=lambda x: int(x._start_ip)):
        ch = Change("iprange", r, (r.description or "")[:80])
        ch.values["start_address"] = sh.ip(r.start_address)
        ch.values["end_address"] = sh.ip(r.end_address)
        ch.shown["range"] = (
            f"{r.start_address}–{r.end_address}",
            f"{ch.values['start_address']}–{ch.values['end_address']}",
        )
        if r.prefix_id and r.prefix_id not in tree_ids:
            home = deepest(r.start_address)
            ch.values["prefix_id"] = home.pk
            ch.shown["prefix"] = ("", sh.net(home.cidr))
        plan.changes.append(ch)
    for r in IPRange.objects.filter(prefix_id__in=tree_ids).exclude(pk__in=moved_range_ids):
        _keep(plan, "iprange", r, f"{r.start_address}–{r.end_address}", "",
              "Outside the prefix.")

    _dhcp(plan, sh, tree_ids, moved_ip_ids, locked)
    _dns(plan, sh, tenant_id, moved_ip_ids, locked, global_table)
    _routing(plan, sh, tenant_id, vrf_id, tree_ids, locked)
    _monitoring(plan, sh, tenant_id, vrf_id, locked)
    _observed(plan, sh, tenant_id, global_table)
    plan.linked = _linked(plan, tree_ids, moved_ip_ids, moved_range_ids)
    return plan


def _keep(plan: Plan, kind: str, obj, value: str, detail: str, reason: str) -> None:
    plan.unchanged.append({
        "_obj": obj,  # for the visibility check; describe() drops it
        "kind": kind,
        "id": str(obj.pk),
        "label": str(obj)[:120],
        "value": f"{value} ({detail})" if detail else value,
        "reason": reason,
    })


def _text_changes(plan, sh, kind, rows, fields, label=str, *, mode="ip", match=None,
                  reason=None):
    """Rewrite the address/network text ``fields`` of ``rows``. ``match`` is
    a per-row predicate saying whether the row is in the tree's table; a row
    that touches the tree but fails it is listed with ``reason``."""
    shift = sh.ip if mode == "ip" else sh.net
    for obj in rows:
        values, shown = {}, {}
        touched = []
        for f in fields:
            cur = getattr(obj, f) or ""
            if not cur:
                continue
            moved = shift(cur)
            if moved is None:
                continue
            touched.append((f, cur))
            values[f], shown[f] = moved, (cur, moved)
        if not values:
            continue
        if match is not None and not match(obj):
            for f, cur in touched:
                _keep(plan, kind, obj, cur, f, reason)
            continue
        plan.changes.append(Change(kind, obj, label(obj), values, shown))


def _dhcp(plan, sh, tree_ids, moved_ip_ids, locked):
    from integrations.models import DhcpExclusion, DhcpReservation, DhcpScope

    scopes = list(locked(DhcpScope.objects.filter(prefix_id__in=tree_ids)))
    local = [s for s in scopes if s.connection_id is None]
    for s in scopes:
        if s.connection_id is not None:
            _keep(plan, "dhcpscope", s, f"{s.start_range}–{s.end_range}", "",
                  "On a DHCP server: change it there, the next sync follows.")
    for s in local:
        values, shown = {}, {}
        for f in ("scope_id", "start_range", "end_range"):
            cur = getattr(s, f)
            moved = sh.ip(cur) if cur else None
            if moved:
                values[f], shown[f] = moved, (cur, moved)
        opts, changed = sh.json(s.options or [])
        if changed:
            values["options"] = opts
            shown["options"] = (_opt_text(s.options), _opt_text(opts))
        if values:
            plan.changes.append(Change("dhcpscope", s, s.name or s.scope_id, values, shown))
    local_ids = [s.pk for s in local]
    for ex in locked(DhcpExclusion.objects.filter(scope_id__in=local_ids)):
        a, b = sh.ip(ex.start_address), sh.ip(ex.end_address)
        if a and b:
            plan.changes.append(Change(
                "dhcpexclusion", ex, str(ex.scope_id),
                {"start_address": a, "end_address": b},
                {"range": (f"{ex.start_address}–{ex.end_address}", f"{a}–{b}")},
            ))
    for res in locked(DhcpReservation.objects.filter(scope_id__in=local_ids)):
        moved = sh.ip(res.ip)
        if moved:
            plan.changes.append(Change(
                "dhcpreservation", res, res.name or res.mac,
                {"ip": moved}, {"ip": (res.ip, moved)},
            ))


def _opt_text(options) -> str:
    out = []
    for o in options or []:
        if isinstance(o, dict):
            v = o.get("value")
            v = ", ".join(map(str, v)) if isinstance(v, list) else str(v)
            out.append(f"{o.get('option_id', '?')}={v}")
    return "; ".join(out)[:255]


def _dns(plan, sh, tenant_id, moved_ip_ids, locked, global_table):
    from integrations.models import DnsDrift, DnsRecord

    records = locked(DnsRecord.objects.filter(ip_address_id__in=moved_ip_ids)
                     .select_related("zone"))
    for rec in records:
        moved = sh.ip(rec.ip) if rec.ip else None
        if moved is None:
            continue
        local = rec.zone.connection_id is None
        if local and rec.managed and rec.record_type in ("A", "AAAA"):
            values = {"ip": moved}
            shown = {"ip": (rec.ip, moved)}
            if (rec.data or "").strip() == rec.ip:
                values["data"] = moved
            plan.changes.append(Change("dnsrecord", rec, rec.name, values, shown))
        elif not local:
            _keep(plan, "dnsrecord", rec, rec.ip, rec.record_type,
                  "On a DNS server: change it there, the next sync follows.")
        else:
            _keep(plan, "dnsrecord", rec, rec.ip, rec.record_type,
                  "Reverse record: its name is the old address.")
    if global_table:
        zones = Q(zone__tenant_id=tenant_id) | Q(zone__connection__tenant_id=tenant_id)
        unlinked = _inside(
            DnsRecord.objects.filter(zones, ip_address__isnull=True, ip__isnull=False),
            "ip", sh.old,
        )
        for rec in unlinked:
            _keep(plan, "dnsrecord", rec, rec.ip, rec.record_type,
                  "Not linked to an address.")
    for d in DnsDrift.objects.filter(ip_address_id__in=moved_ip_ids):
        _keep(plan, "dnsdrift", d, d.ip, "", "Recomputed on the next DNS sync.")


def _routing(plan, sh, tenant_id, vrf_id, tree_ids, locked):
    from routing.models import (
        ROA,
        BGPInstance,
        BGPSession,
        EIGRPInterface,
        LDPInstance,
        PolicyRule,
        PrefixListRule,
        RoutingPolicyRule,
        RPKICache,
        StaticRoute,
    )

    global_table = vrf_id is None
    no_vrf = "Not tied to a VRF and the prefix is not in the global table."

    # Static routes: the destination is in the route's table, the next hop in
    # the next-hop VRF when one is set.
    for r in locked(StaticRoute.objects.filter(tenant_id=tenant_id)
                    .select_related("device", "virtual_machine")):
        values, shown = {}, {}
        moved = sh.net(r.prefix)
        if moved and r.vrf_id == vrf_id:
            values["prefix"], shown["prefix"] = moved, (r.prefix, moved)
        moved_nh = sh.ip(r.next_hop) if r.next_hop else None
        nh_vrf = r.next_hop_vrf_id or r.vrf_id
        if moved_nh and nh_vrf == vrf_id:
            values["next_hop"], shown["next_hop"] = moved_nh, (r.next_hop, moved_nh)
        if values:
            plan.changes.append(Change("staticroute", r, _owner(r), values, shown))

    # BGP neighbours: the instance's table.
    _text_changes(
        plan, sh, "bgpsession",
        locked(BGPSession.objects.filter(tenant_id=tenant_id).select_related(
            "instance__device", "instance__virtual_machine")),
        ["remote_address"], label=lambda s: s.name or _owner(s.instance),
        match=lambda s: s.instance.vrf_id == vrf_id,
    )

    # EIGRP summaries: the instance's table.
    for itf in locked(EIGRPInterface.objects.filter(instance__tenant_id=tenant_id)
                      .select_related("instance")):
        if itf.instance.vrf_id != vrf_id:
            continue
        cur = list(itf.summary_addresses or [])
        out = [sh.net(v) or v if isinstance(v, str) else v for v in cur]
        if out != cur:
            plan.changes.append(Change(
                "eigrpinterface", itf, str(itf), {"summary_addresses": out},
                {"summary_addresses": (", ".join(map(str, cur)), ", ".join(map(str, out)))},
            ))

    # Prefix-list lines: the IPAM link says which tree line it is; a text-only
    # line has no VRF and follows only in the global table.
    for rule in locked(PrefixListRule.objects.filter(prefix_list__tenant_id=tenant_id)
                       .select_related("prefix_list")):
        moved = sh.net(rule.prefix)
        if not moved:
            continue
        if rule.prefix_obj_id in tree_ids or (rule.prefix_obj_id is None and global_table):
            plan.changes.append(Change(
                "prefixlistrule", rule, f"{rule.prefix_list.name} seq {rule.sequence}",
                {"prefix": moved}, {"prefix": (rule.prefix, moved)},
            ))
        else:
            _keep(plan, "prefixlistrule", rule, rule.prefix, "prefix",
                  no_vrf if rule.prefix_obj_id is None else "Names a prefix in another VRF.")

    # Global-table only: these have no VRF of their own, or live in the
    # global table by definition (LDP, the VPN export next hop).
    vrfless = [
        (PolicyRule.objects.filter(tenant_id=tenant_id).select_related(
            "device", "virtual_machine"),
         "policyrule", ["from_prefix", "to_prefix"], "net", _owner),
        (RoutingPolicyRule.objects.filter(policy__tenant_id=tenant_id).select_related(
            "policy"),
         "routingpolicyrule", ["set_next_hop"], "ip",
         lambda r: f"{r.policy.name} seq {r.sequence}"),
        (RPKICache.objects.filter(tenant_id=tenant_id), "rpkicache", ["address"], "ip",
         lambda c: c.name),
    ]
    for qs, kind, fields, mode, label in vrfless:
        _text_changes(plan, sh, kind, locked(qs), fields, label=label, mode=mode,
                      match=lambda _o: global_table, reason=no_vrf)
    if global_table:
        _text_changes(
            plan, sh, "bgpinstance",
            locked(BGPInstance.objects.filter(tenant_id=tenant_id, vrf__isnull=True)
                   .select_related("device", "virtual_machine", "asn")),
            ["vpn_nexthop_export"], label=str,
        )
        _text_changes(
            plan, sh, "ldpinstance",
            locked(LDPInstance.objects.filter(tenant_id=tenant_id).select_related("device")),
            ["transport_address"], label=str,
        )

    # ROAs are authorisations: a new prefix needs a new ROA, not an edit.
    for roa in ROA.objects.filter(tenant_id=tenant_id):
        if sh.touches(roa.prefix):
            _keep(plan, "roa", roa, roa.prefix, "",
                  "An authorisation for the old prefix: issue one for the new.")


def _monitoring(plan, sh, tenant_id, vrf_id, locked):
    from monitoring.models import (
        MonitoringDenySubnet,
        RedfishEndpoint,
        SnmpProfileBinding,
        WatchedEndpoint,
    )

    global_table = vrf_id is None
    no_vrf = "Not tied to a VRF and the prefix is not in the global table."
    _text_changes(
        plan, sh, "monitoringdenysubnet",
        locked(MonitoringDenySubnet.objects.filter(tenant_id=tenant_id, **(
            {"vrf__isnull": True} if vrf_id is None else {"vrf_id": vrf_id}))),
        ["cidr"], mode="net", label=lambda d: d.description[:80] or "",
    )
    for qs, kind, fields, label in (
        (SnmpProfileBinding.objects.filter(tenant_id=tenant_id).select_related("profile"),
         "snmpprofilebinding", ["target"], lambda b: b.profile.name),
        (RedfishEndpoint.objects.filter(tenant_id=tenant_id).select_related("device"),
         "redfishendpoint", ["host"], lambda e: e.device.name),
        (WatchedEndpoint.objects.filter(tenant_id=tenant_id), "watchedendpoint",
         ["host"], lambda e: str(e)),
    ):
        _text_changes(plan, sh, kind, locked(qs), fields, label=label,
                      match=lambda _o: global_table, reason=no_vrf)


def _observed(plan, sh, tenant_id, global_table):
    """Rows another system writes: listed, never edited."""
    from integrations.models import DhcpLease
    from monitoring.models import ArpSighting, MonitoringEngine
    from oxidized.models import OxidizedNodeLink
    from prtg.models import PrtgDeviceLink

    from .models import Aggregate

    moved_ips = [c.obj.pk for c in plan.changes if c.kind == "ipaddress"]
    for lease in DhcpLease.objects.filter(ip_address_id__in=moved_ips):
        _keep(plan, "dhcplease", lease, lease.ip, "", "Observed lease.")
    for agg in Aggregate.objects.filter(tenant_id=tenant_id):
        if sh.touches(agg.prefix):
            _keep(plan, "aggregate", agg, agg.prefix, "", "A registry allocation.")
    if not global_table:
        return
    for row in _inside(ArpSighting.objects.filter(tenant_id=tenant_id, gone_at__isnull=True),
                       "ip", sh.old):
        _keep(plan, "arpsighting", row, row.ip, row.mac, "Observed ARP entry.")
    for link in OxidizedNodeLink.objects.filter(tenant_id=tenant_id).exclude(node_ip=""):
        if sh.ip(link.node_ip):
            _keep(plan, "oxidizednodelink", link, link.node_ip, "",
                  "Synced from Oxidized: change the node there.")
    for link in PrtgDeviceLink.objects.filter(tenant_id=tenant_id).exclude(host=""):
        if sh.ip(link.host):
            _keep(plan, "prtgdevicelink", link, link.host, "",
                  "PRTG's host field: change it in PRTG.")
    for eng in MonitoringEngine.objects.filter(tenant_id=tenant_id):
        for f in ("ssh_host", "agent_ip"):
            v = getattr(eng, f) or ""
            if v and sh.ip(v):
                _keep(plan, "monitoringengine", eng, v, f,
                      "The Outpost's own connection: change it on the engine.")


def _linked(plan, tree_ids, moved_ip_ids, moved_range_ids) -> list[dict]:
    """Rows that point at a moved prefix, address or range by foreign key:
    they follow without a write. Counted per kind for the preview; each
    entry keeps its querysets (``_qs``) so describe() counts what the caller
    may view."""
    from integrations.models import (
        DhcpLease,
        DhcpReservation,
        DhcpScope,
        DnsDrift,
        DnsRecord,
    )

    handled = {type(c.obj) for c in plan.changes}
    handled |= {IPAddress, IPRange, Prefix, DhcpLease, DnsDrift, DnsRecord,
                DhcpScope, DhcpReservation}
    counts: dict[str, dict] = {}
    for model, ids in ((Prefix, tree_ids), (IPAddress, moved_ip_ids),
                       (IPRange, moved_range_ids)):
        if not ids:
            continue
        # Hidden reverse relations (``related_name="+"``) count too.
        rels = [f for f in model._meta.get_fields(include_hidden=True)
                if f.auto_created and not f.concrete and f.is_relation]
        for rel in rels:
            rm = rel.related_model
            if rm in handled or getattr(rel, "field", None) is None or rm._meta.auto_created:
                continue
            try:
                qs = rm._base_manager.filter(
                    **{f"{rel.field.name}__in": list(ids)}).distinct()
                n = qs.count()
            except Exception:  # noqa: BLE001 - a relation we can't filter on
                continue
            if not n:
                continue
            key = rm._meta.label_lower
            row = counts.setdefault(key, {
                "kind": rm._meta.model_name,
                "label": str(rm._meta.verbose_name_plural).capitalize(),
                "count": 0,
                "_qs": [],
            })
            row["count"] += n
            row["_qs"].append((qs, n))
    return sorted(counts.values(), key=lambda r: r["label"])


# ─── permissions ────────────────────────────────────────────────────────────


def blockers(plan: Plan, user, tenant) -> list[str]:
    """What the user may not change, as ``"3 IP addresses"`` phrases. Only
    kinds the user may view are named; a row to write they can't view is a
    blocker too, counted in one ``"N objects you can't view"`` phrase."""
    from auth_api import rbac
    from auth_api.object_types import is_registered

    if user is None or getattr(user, "is_superuser", False):
        return []
    viewer = Viewer(user, tenant)
    by_kind: dict[str, list] = {}
    for c in plan.changes:
        by_kind.setdefault(c.kind, []).append(c.obj)
    out = []
    hidden = 0
    for kind, all_objs in by_kind.items():
        label, slug = KINDS[kind]
        seen = viewer.visible(kind, all_objs)
        objs = [o for o in all_objs if o.pk in seen]
        hidden += len(all_objs) - len(objs)
        if not objs:
            continue
        if kind == "dhcpexclusion":
            from integrations.models import DhcpScope

            model, ids = DhcpScope, {o.scope_id for o in objs}
        elif kind == "snmpprofilebinding":
            from monitoring.models import SnmpProfile

            model, ids = SnmpProfile, {o.profile_id for o in objs}
        else:
            model, ids = type(objs[0]), {o.pk for o in objs}
        if not is_registered(slug):
            out.append(label)
            continue
        allowed = rbac.restrict_queryset(
            model._default_manager.filter(pk__in=ids), user, tenant, slug, "change"
        ).count()
        if allowed < len(ids):
            n = len(ids) - allowed
            out.append(f"{n} of {len(ids)} {label.lower()}")
    if hidden:
        out.append(f"{hidden} object{'' if hidden == 1 else 's'} you can't view")
    # A site-scoped prefix editor may not move the tree into another site's
    # or the shared space - the same rule a new prefix follows.
    sites = rbac.site_scope(user, tenant, "prefix", "change")
    if sites is not None:
        tree = {c.obj.pk for c in plan.changes if c.kind == "prefix"}
        overlapping = list(Prefix.objects.filter(
            Q(tenant_id=plan.prefix.tenant_id) & _vrf_q("vrf", plan.prefix.vrf_id)
        ).exclude(pk__in=tree).annotate(_rn_ov=RawSQL(
            '"api_prefix"."cidr"::inet && %s::inet', (str(plan.new),),
            output_field=BooleanField(),
        )).filter(_rn_ov=True).only("pk", "cidr", "site_id"))
        seen = viewer.visible("prefix", overlapping)
        unseen = 0
        for p in overlapping:
            if p.site_id in sites:
                continue
            if p.pk not in seen:
                unseen += 1
                continue
            where = "another site" if p.site_id else "the shared space"
            out.append(f"{plan.new} sits in {p.cidr}, which belongs to {where}")
        if unseen:
            out.append(f"{plan.new} overlaps {unseen} prefix"
                       f"{'' if unseen == 1 else 'es'} you can't view")
    return out


# ─── output ─────────────────────────────────────────────────────────────────


def _seen_by_kind(viewer: Viewer, items, kind_of, obj_of) -> set:
    by_kind: dict[str, list] = {}
    for it in items:
        by_kind.setdefault(kind_of(it), []).append(obj_of(it))
    out = set()
    for kind, objs in by_kind.items():
        out |= {(kind, pk) for pk in viewer.visible(kind, objs)}
    return out


def _linked_visible(viewer: Viewer, linked: list[dict]) -> tuple[list[dict], int]:
    """The linked counts narrowed to rows the caller may view, and how many
    were left out. A type outside RBAC is not narrowed (as its own API, see
    auth_api.drf.restrict_for_view): these rows hang off the tree's own rows,
    which the caller may view or the renumber is refused."""
    from auth_api import rbac
    from auth_api.object_types import is_registered

    out, hidden = [], 0
    for row in linked:
        n = 0
        for qs, total in row.get("_qs", []):
            slug = qs.model._meta.model_name
            if viewer.everything or not is_registered(slug):
                n += total
            else:
                n += rbac.restrict_queryset(qs, viewer.user, viewer.tenant, slug,
                                            "view").count()
        hidden += row["count"] - n
        if n:
            out.append({"kind": row["kind"], "label": row["label"], "count": n})
    return out, hidden


def describe(plan: Plan, *, dry_run: bool, applied: bool = False,
             user=None, tenant=None) -> dict:
    """The preview (or the applied result) as ``user`` may see it: rows of
    kinds and objects they can't view are left out and counted together in
    ``hidden_total``, with nothing else about them."""
    viewer = Viewer(user, tenant)
    seen_changes = _seen_by_kind(viewer, plan.changes, lambda c: c.kind, lambda c: c.obj)
    seen_kept = _seen_by_kind(viewer, plan.unchanged, lambda u: u["kind"],
                              lambda u: u["_obj"])
    hidden = 0
    rows = []
    counts: dict[str, int] = {}
    for c in plan.changes:
        if (c.kind, c.obj.pk) not in seen_changes:
            hidden += 1
            continue
        counts[c.kind] = counts.get(c.kind, 0) + 1
        for f, (old, new) in c.shown.items():
            rows.append({
                "kind": c.kind, "id": str(c.obj.pk), "label": c.label or "",
                "field": f, "old": old, "new": new,
            })
    unchanged = []
    unchanged_counts: dict[str, int] = {}
    for u in plan.unchanged:
        if (u["kind"], u["_obj"].pk) not in seen_kept:
            hidden += 1
            continue
        unchanged.append({k: v for k, v in u.items() if k != "_obj"})
        unchanged_counts[u["kind"]] = unchanged_counts.get(u["kind"], 0) + 1
    linked, hidden_linked = _linked_visible(viewer, plan.linked)
    hidden += hidden_linked
    return {
        "prefix": {"id": str(plan.prefix.pk), "cidr": str(plan.old)},
        "new_prefix": str(plan.new),
        "dry_run": dry_run,
        "applied": applied,
        "counts": [
            {"kind": k, "label": KINDS[k][0], "count": n} for k, n in counts.items()
        ],
        "total": len(rows),
        "truncated": len(rows) > PREVIEW_LIMIT,
        "changes": rows[:PREVIEW_LIMIT],
        "unchanged_counts": [
            {"kind": k, "label": KINDS[k][0], "count": n}
            for k, n in unchanged_counts.items()
        ],
        "unchanged_total": len(unchanged),
        "unchanged": unchanged[:PREVIEW_LIMIT],
        "linked": linked,
        # Rows of the tree's references the caller may not view: left as
        # they are (a row the renumber writes is never hidden - see
        # blockers), and never described beyond this count.
        "hidden_total": hidden,
    }


# ─── apply ──────────────────────────────────────────────────────────────────


def _audited_labels() -> set[str]:
    from audit.apps import AUDITED_MODELS
    from audit.registry import _DYNAMIC_AUDITED

    return {label.lower() for label in AUDITED_MODELS + list(_DYNAMIC_AUDITED)}


def apply_plan(prefix: Prefix, raw_new, user, tenant) -> Plan:
    """Renumber in one transaction: lock, re-plan, check, write, journal.
    Raises :class:`RenumberError` and rolls everything back on any refusal."""
    from audit import context as audit_context
    from audit.bulk import log_bulk_update
    from audit.models import JournalEntry, JournalKind
    from audit.site_capture import entry_site_id

    with transaction.atomic():
        root = Prefix.objects.select_for_update().get(pk=prefix.pk)
        plan = build_plan(root, raw_new, lock=True, viewer=Viewer(user, tenant))
        blocked = blockers(plan, user, tenant)
        if blocked:
            raise RenumberError("You can't change " + "; ".join(blocked) + ".", status=403)
        cause = f"Renumbered {plan.old} to {plan.new}"
        audited = _audited_labels()
        order = list(KINDS)
        with audit_context.cause(cause):
            for c in sorted(plan.changes, key=lambda c: order.index(c.kind)):
                obj = c.obj
                if obj._meta.label_lower not in audited:
                    log_bulk_update([obj], {}, per_row={obj.pk: dict(c.values)})
                for attname, value in c.values.items():
                    setattr(obj, attname, value)
                names = {f.attname: f.name for f in obj._meta.concrete_fields}
                changed = {names.get(a, a) for a in c.values}
                exclude = [f.name for f in obj._meta.fields if f.name not in changed]
                try:
                    obj.full_clean(exclude=exclude)
                    obj.save()
                except DjangoValidationError as exc:
                    msgs = "; ".join(
                        f"{k}: {' '.join(map(str, v))}"
                        for k, v in getattr(exc, "message_dict", {"": exc.messages}).items()
                    )
                    raise RenumberError(
                        f"{KINDS[c.kind][0]} {c.label or obj.pk}: {msgs}"
                    ) from None
                except IntegrityError as exc:
                    raise RenumberError(
                        f"{KINDS[c.kind][0]} {c.label or obj.pk}: {exc}"
                    ) from None
            JournalEntry.objects.create(
                tenant_id=root.tenant_id,
                created_by=user if getattr(user, "pk", None) else None,
                author_name=getattr(user, "username", "") or "",
                object_type="api.prefix",
                object_id=str(root.pk),
                object_site_id=entry_site_id(root),
                kind=JournalKind.INFO,
                comments=f"Renumbered from {plan.old} to {plan.new}.",
            )
    return plan
