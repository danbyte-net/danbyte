"""Zabbix as a discovery source (#162 phase 6).

A host Zabbix has and Danbyte has no device for becomes a proposal in the same
review queue as everything else, and applying it makes the device: name and
serial from the host, the address from its interface, the site from a host
group that names one, the model from the inventory. An existing Zabbix is a
way into Danbyte, not just something Danbyte writes into.

"No device for" is decided against **every** device of the tenant, not the
provisioning scope: a host that matches a device by address, serial or name is
that device, whether or not anyone asked Zabbix to watch it, and adopting it
would be a duplicate with a different name.

The placement chain, the defaults refresh and making the device are shared
with every external monitor (:mod:`monitoring.external.adoption`); this
module reads Zabbix hosts.
"""
from __future__ import annotations

import logging

from django.db import transaction
from django.utils import timezone

from monitoring.external import adoption as shared
from monitoring.external.adoption import applicable, device_index

from .models import ZabbixAdoptionRule, ZabbixChange, ZabbixHostLink

#: ``applicable`` and ``device_index`` are the shared ones, re-exported for
#: the callers that import them from here.
__all__ = ["applicable", "device_index", "refresh_pending_proposals"]

log = logging.getLogger("zabbix.adopt")

#: Zabbix interface types, in the order an adopted address is taken from them:
#: what SNMP polls is the management address; the agent's is the fallback.
_IFACE_PREFERENCE = ("2", "1", "3", "4")


def is_known(host, index) -> bool:
    """Whether some Danbyte device already is this host."""
    for iface in host.get("interfaces") or []:
        if (iface.get("ip") or "").strip() in index["addresses"]:
            return True
    serial = ((host.get("inventory") or {}).get("serialno_a") or "").strip().lower()
    if serial and serial in index["serials"]:
        return True
    for key in ("host", "name"):
        if (host.get(key) or "").strip().lower() in index["names"]:
            return True
    return False


def host_address(host) -> str:
    interfaces = host.get("interfaces") or []
    for kind in _IFACE_PREFERENCE:
        for iface in interfaces:
            if str(iface.get("type")) == kind and (iface.get("ip") or "").strip():
                return iface["ip"].strip()
    return ""


def rules_for(conn) -> list:
    """This connection's enabled adoption rules, in the order they are tried."""
    return list(
        ZabbixAdoptionRule.objects.filter(connection=conn, enabled=True)
        .select_related("site", "role", "device_type")
    )


def placement(host: dict, rules) -> dict:
    """What the first matching rule says about a host, or nothing.

    A rule matches the host's name, one of its groups, or one of its
    addresses. It sets only what it names, so a name rule that knows the site
    but not the type leaves the type to the inventory model and the defaults.
    """
    if not rules:
        return {}
    groups = [g.get("name", "") for g in host.get("hostgroups") or host.get("groups") or []]
    addresses = [(i.get("ip") or "").strip() for i in host.get("interfaces") or []]
    return shared.first_matching_rule(rules, {
        ZabbixAdoptionRule.SCOPE_NAME: [host.get("name") or "", host.get("host") or ""],
        ZabbixAdoptionRule.SCOPE_GROUP: groups,
        ZabbixAdoptionRule.SCOPE_IP: [a for a in addresses if a],
    })


def proposal(conn, host, *, sites, types, rules=()) -> dict:
    """What applying would make, and what is still missing to make it.

    ``sites`` maps a lower-cased site name to its id; ``types`` a lower-cased
    device-type model to its id; ``rules`` are the connection's adoption
    rules. All read once per pass.

    Each field is decided most-specific first: an adoption rule, then what the
    host itself says (a group naming a site, the inventory model naming a
    type), then the connection's defaults.
    """
    inventory = host.get("inventory") or {}
    groups = [g.get("name", "") for g in host.get("hostgroups") or host.get("groups") or []]
    placed = placement(host, rules)

    # The first host group that names one of this tenant's sites - the
    # reverse of what provisioning writes, so an estate Danbyte provisioned
    # and one somebody built by hand read the same way.
    site = next(
        ((sites[g.lower()], g) for g in groups if g.lower() in sites),
        None,
    )
    model = (inventory.get("model") or "").strip()
    device_type = (types[model.lower()], model) if model and model.lower() in types else None
    # Which fields came from the connection's defaults is recorded, so a later
    # change to the defaults can be re-applied to a pending proposal without
    # disturbing what a rule or the host itself decided.
    chosen, defaulted = shared.place(conn, placed, site=site, device_type=device_type)

    detail = {
        "hostid": host["hostid"],
        "host": host.get("host", ""),
        "name": (host.get("name") or host.get("host") or "").strip(),
        "address": host_address(host),
        "groups": groups,
        "serial": (inventory.get("serialno_a") or "").strip(),
        "model": model,
        "vendor": (inventory.get("vendor") or "").strip(),
        "os": (inventory.get("os") or "").strip(),
        **shared.placement_detail(chosen),
        # Which rule placed it, so the queue can say why this site and not
        # the default.
        "rule": placed.get("rule"),
        "defaulted": defaulted,
    }
    _reason(detail)
    return detail


#: What a proposal with a gap says beyond "set the defaults".
_HINT = "name the site in a host group"


def _reason(detail: dict) -> None:
    shared.set_reason(detail, _HINT)


def refresh_pending_proposals(conn) -> int:
    """Re-apply the connection's defaults to the adoptions still waiting.

    Fields a rule or the host decided are left alone. Returns how many
    proposals changed.
    """
    return shared.refresh_pending_proposals(
        conn,
        ZabbixChange.objects.filter(
            connection=conn, kind=ZabbixChange.ADOPT, ignored=False, device__isnull=True
        ),
        hint=_HINT,
    )


def plan_adoption(conn, hosts, fresh) -> int:
    """Propose a device for each host nothing in Danbyte answers to."""
    from api.models import DeviceType, Site

    index = device_index(conn.tenant)
    linked = set(
        ZabbixHostLink.objects.filter(connection=conn).values_list("hostid", flat=True)
    )
    sites = {
        n.lower(): i
        for i, n in Site.objects.filter(tenant=conn.tenant).values_list("id", "name")
    }
    types = {
        m.lower(): i
        for i, m in DeviceType.objects.filter(tenant=conn.tenant)
        .exclude(model="").values_list("id", "model")
    }
    rules = rules_for(conn)
    n = 0
    for host in hosts:
        if host["hostid"] in linked or is_known(host, index):
            continue
        detail = proposal(conn, host, sites=sites, types=types, rules=rules)
        change = ZabbixChange.objects.filter(
            connection=conn, kind=ZabbixChange.ADOPT, detail__hostid=host["hostid"]
        ).first()
        if change is None:
            change = ZabbixChange(
                tenant=conn.tenant, connection=conn, kind=ZabbixChange.ADOPT
            )
        change.detail = detail
        change.save()
        fresh.add(change.id)
        n += 1
    return n


def apply_adoption(change) -> str:
    """Make the device the proposal describes, and link it to the host.

    The link is ``created_here=False``: Danbyte did not make the Zabbix host,
    so pruning may never touch it. The address is recorded only when a prefix
    of the tenant's contains it - an address with nowhere to live is left to
    the operator rather than invented a prefix for.
    """
    conn = change.connection
    detail = change.detail or {}
    name = detail.get("name") or detail.get("host") or f"zabbix-{detail.get('hostid')}"
    with transaction.atomic():
        device, note = shared.make_device(
            conn, detail, name=name, origin=f"Zabbix «{conn.name}»"
        )
        ZabbixHostLink.objects.update_or_create(
            connection=conn, hostid=detail["hostid"],
            defaults={
                "tenant": conn.tenant, "device": device,
                "host_name": (detail.get("name") or "")[:255],
                "matched_by": "adopted", "created_here": False,
                "last_seen_at": timezone.now(), "unwanted_since": None,
            },
        )
    log.info("zabbix %s: adopted %s as a device", conn.name, name)
    return f"Adopted {name} as a device.{note}"
