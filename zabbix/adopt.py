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
"""
from __future__ import annotations

import logging

from django.db import transaction
from django.utils import timezone

from .models import ZabbixAdoptionRule, ZabbixChange, ZabbixHostLink

log = logging.getLogger("zabbix.adopt")

#: Zabbix interface types, in the order an adopted address is taken from them:
#: what SNMP polls is the management address; the agent's is the fallback.
_IFACE_PREFERENCE = ("2", "1", "3", "4")


def device_index(tenant) -> dict:
    """Every address, serial and name the tenant's devices answer to."""
    from api.models import Device, IPAddress

    addresses = {
        str(ip).split("/")[0]
        for ip in IPAddress.objects.filter(
            tenant=tenant, assigned_device__isnull=False
        ).values_list("ip_address", flat=True)
    }
    serials, names = set(), set()
    for name, serial in Device.objects.filter(tenant=tenant).values_list(
        "name", "serial_number"
    ):
        if name:
            names.add(name.strip().lower())
        if serial:
            serials.add(serial.strip().lower())
    return {"addresses": addresses, "serials": serials, "names": names}


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
    from integrations.placement import pattern_matches

    if not rules:
        return {}
    groups = [g.get("name", "") for g in host.get("hostgroups") or host.get("groups") or []]
    addresses = [(i.get("ip") or "").strip() for i in host.get("interfaces") or []]
    candidates = {
        ZabbixAdoptionRule.SCOPE_NAME: [host.get("name") or "", host.get("host") or ""],
        ZabbixAdoptionRule.SCOPE_GROUP: groups,
        ZabbixAdoptionRule.SCOPE_IP: [a for a in addresses if a],
    }
    for rule in rules:
        values = candidates.get(rule.scope) or []
        if any(pattern_matches(rule.pattern, v, scope=rule.scope) for v in values):
            out = {"rule": rule.pattern, "site": (rule.site_id, rule.site.name)}
            if rule.role_id:
                out["role"] = (rule.role_id, rule.role.name)
            if rule.device_type_id:
                out["device_type"] = (rule.device_type_id, rule.device_type.model)
            return out
    return {}


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

    # Which fields came from the connection's defaults, so a later change
    # to the defaults can be re-applied to a pending proposal without
    # disturbing what a rule or the host itself decided.
    defaulted: list[str] = []

    site = placed.get("site")
    if site is None:
        # The first host group that names one of this tenant's sites - the
        # reverse of what provisioning writes, so an estate Danbyte provisioned
        # and one somebody built by hand read the same way.
        site = next(
            ((sites[g.lower()], g) for g in groups if g.lower() in sites),
            None,
        )
    if site is None:
        defaulted.append("site")
        if conn.adopt_site_id:
            site = (conn.adopt_site_id, conn.adopt_site.name)

    model = (inventory.get("model") or "").strip()
    device_type = placed.get("device_type")
    if device_type is None and model and model.lower() in types:
        device_type = (types[model.lower()], model)
    if device_type is None:
        defaulted.append("device_type")
        if conn.adopt_device_type_id:
            device_type = (conn.adopt_device_type_id, conn.adopt_device_type.model)

    role = placed.get("role")
    if role is None:
        defaulted.append("role")
        if conn.adopt_role_id:
            role = (conn.adopt_role_id, conn.adopt_role.name)

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
        "site_id": str(site[0]) if site else None,
        "site": site[1] if site else None,
        "role_id": str(role[0]) if role else None,
        "role": role[1] if role else None,
        "device_type_id": str(device_type[0]) if device_type else None,
        "device_type": device_type[1] if device_type else None,
        # Which rule placed it, so the queue can say why this site and not
        # the default.
        "rule": placed.get("rule"),
        "defaulted": defaulted,
    }
    _reason(detail)
    return detail


_MISSING_LABEL = {"site": "site", "role": "role", "device_type": "device type"}


def _reason(detail: dict) -> None:
    missing = [
        _MISSING_LABEL[f] for f in ("site", "role", "device_type") if not detail.get(f"{f}_id")
    ]
    if missing:
        detail["reason"] = (
            "No " + ", ".join(missing) + " to adopt into - set the defaults on "
            "the connection, or name the site in a host group."
        )
    else:
        detail.pop("reason", None)


def refresh_pending_proposals(conn) -> int:
    """Re-apply the connection's defaults to the adoptions still waiting.

    A proposal records what it decided at sync time; the defaults are its
    last resort, so when they change the proposals that leaned on them (or
    had nothing to lean on) must follow at once - an operator who has just
    pressed *Set defaults* is looking at the queue, not waiting for the next
    pass. Fields a rule or the host decided are left alone. Returns how
    many proposals changed.
    """
    defaults = {
        "site": (conn.adopt_site_id, conn.adopt_site.name) if conn.adopt_site_id else None,
        "role": (conn.adopt_role_id, conn.adopt_role.name) if conn.adopt_role_id else None,
        "device_type": (
            (conn.adopt_device_type_id, conn.adopt_device_type.model)
            if conn.adopt_device_type_id else None
        ),
    }
    changed = 0
    for change in ZabbixChange.objects.filter(
        connection=conn, kind=ZabbixChange.ADOPT, ignored=False, device__isnull=True
    ):
        detail = dict(change.detail or {})
        # Older proposals carry no marker: a field with no value is one the
        # defaults may fill, which is what the marker would have said.
        defaulted = set(detail.get("defaulted") or []) | {
            f for f in ("site", "role", "device_type") if not detail.get(f"{f}_id")
        }
        before = {k: detail.get(k) for k in ("site_id", "role_id", "device_type_id", "reason")}
        for field in defaulted:
            value = defaults[field]
            detail[f"{field}_id"] = str(value[0]) if value else None
            detail[field] = value[1] if value else None
        detail["defaulted"] = sorted(defaulted)
        _reason(detail)
        after = {k: detail.get(k) for k in ("site_id", "role_id", "device_type_id", "reason")}
        if after != before or "defaulted" not in (change.detail or {}):
            change.detail = detail
            change.save(update_fields=["detail"])
            changed += 1
    return changed


def applicable(detail: dict) -> bool:
    return bool(
        detail.get("site_id") and detail.get("role_id") and detail.get("device_type_id")
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
    from api.models import Device, DeviceRole, DeviceType, IPAddress, Site
    from api.status_registry import resolve_status
    from api.vrf_placement import containing_prefix

    conn = change.connection
    detail = change.detail or {}
    if not applicable(detail):
        raise ValueError(detail.get("reason") or "This proposal is missing a default.")
    tenant = conn.tenant
    site = Site.objects.filter(tenant=tenant, pk=detail["site_id"]).first()
    role = DeviceRole.objects.filter(tenant=tenant, pk=detail["role_id"]).first()
    dtype = DeviceType.objects.filter(tenant=tenant, pk=detail["device_type_id"]).first()
    if site is None or role is None or dtype is None:
        raise ValueError("A default named in this proposal no longer exists.")

    name = detail.get("name") or detail.get("host") or f"zabbix-{detail['hostid']}"
    with transaction.atomic():
        device = Device.objects.create(
            tenant=tenant, name=name[:255], device_type=dtype, role=role, site=site,
            serial_number=(detail.get("serial") or "")[:255],
            status=resolve_status(tenant, "active", "device"),
            description=f"Adopted from Zabbix «{conn.name}»",
        )
        note = ""
        address = (detail.get("address") or "").strip()
        if address:
            row = IPAddress.objects.filter(tenant=tenant, ip_address=address).first()
            if row is None:
                prefix = containing_prefix(tenant, address)
                if prefix is not None:
                    row = IPAddress.objects.create(
                        tenant=tenant, ip_address=address, prefix=prefix,
                        description=f"Adopted from Zabbix «{conn.name}»",
                    )
                else:
                    note = f" {address} is in no prefix of yours, so it was not recorded."
            if row is not None and row.assigned_device_id is None:
                row.assigned_device = device
                row.save(update_fields=["assigned_device"])
                device.primary_ip = row
                device.save(update_fields=["primary_ip"])
        ZabbixHostLink.objects.update_or_create(
            connection=conn, hostid=detail["hostid"],
            defaults={
                "tenant": tenant, "device": device,
                "host_name": (detail.get("name") or "")[:255],
                "matched_by": "adopted", "created_here": False,
                "last_seen_at": timezone.now(), "unwanted_since": None,
            },
        )
    log.info("zabbix %s: adopted %s as a device", conn.name, name)
    return f"Adopted {name} as a device.{note}"
