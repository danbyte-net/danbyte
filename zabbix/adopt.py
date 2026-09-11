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

from .models import ZabbixChange, ZabbixHostLink

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


def proposal(conn, host, *, sites, types) -> dict:
    """What applying would make, and what is still missing to make it.

    ``sites`` maps a lower-cased site name to its id; ``types`` a lower-cased
    device-type model to its id. Both are read once per pass.
    """
    inventory = host.get("inventory") or {}
    groups = [g.get("name", "") for g in host.get("hostgroups") or host.get("groups") or []]
    # The site is the first host group that names one of this tenant's sites -
    # the reverse of what provisioning writes, so an estate Danbyte provisioned
    # and one somebody built by hand read the same way.
    site = next(
        ((sites[g.lower()], g) for g in groups if g.lower() in sites),
        None,
    )
    if site is None and conn.adopt_site_id:
        site = (conn.adopt_site_id, conn.adopt_site.name)
    model = (inventory.get("model") or "").strip()
    device_type = None
    if model and model.lower() in types:
        device_type = (types[model.lower()], model)
    elif conn.adopt_device_type_id:
        device_type = (conn.adopt_device_type_id, conn.adopt_device_type.model)
    role = (conn.adopt_role_id, conn.adopt_role.name) if conn.adopt_role_id else None

    missing = [
        label for label, value in (("site", site), ("role", role), ("device type", device_type))
        if value is None
    ]
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
    }
    if missing:
        detail["reason"] = (
            "No " + ", ".join(missing) + " to adopt into - set the defaults on "
            "the connection, or name the site in a host group."
        )
    return detail


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
    n = 0
    for host in hosts:
        if host["hostid"] in linked or is_known(host, index):
            continue
        detail = proposal(conn, host, sites=sites, types=types)
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
