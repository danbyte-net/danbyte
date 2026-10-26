"""PRTG as a way into Danbyte: adopting the devices it knows and Danbyte does
not.

A PRTG device that no Danbyte device or VM answers to - by address, serial
or name, across the whole tenant - becomes an ``adopt`` proposal in the
review queue, keyed by its PRTG object id. Applying it makes the device and
links it (``matched_by="adopted"``, ``created_here=False``).

Placement is the shared chain (:mod:`monitoring.external.adoption`): an
adoption rule over the PRTG device's name, group, probe or address first,
then a PRTG group named like one of the tenant's sites, then the
connection's defaults. An address is recorded only when the PRTG host is an
IP inside an existing prefix; a device PRTG knows by a DNS name is adopted
with its name and no address - Danbyte never resolves a name to invent one.
"""
from __future__ import annotations

import ipaddress
import logging

from django.db import transaction
from django.utils import timezone

from monitoring.external import adoption as shared

from .models import PrtgAdoptionRule, PrtgChange, PrtgDeviceLink

log = logging.getLogger("prtg.adopt")

#: What a proposal with a gap says beyond "set the defaults".
_HINT = "place it with an adoption rule"


def _ip(host: str) -> str:
    try:
        return str(ipaddress.ip_address((host or "").strip()))
    except ValueError:
        return ""


def _skip(row) -> bool:
    """PRTG's own objects: the core server (no host) and the probe device
    (a loopback address) describe PRTG, not the estate."""
    host = (row.get("host") or "").strip()
    if not host:
        return True
    ip = _ip(host)
    return bool(ip) and ipaddress.ip_address(ip).is_loopback


def known_index(tenant) -> dict:
    """:func:`~monitoring.external.adoption.device_index`, plus the
    tenant's virtual machines - PRTG watches VMs too, and a PRTG device that
    is a VM must not come back as a second, physical device."""
    from api.models import IPAddress, VirtualMachine

    index = shared.device_index(tenant)
    index["addresses"] |= {
        str(ip).split("/")[0]
        for ip in IPAddress.objects.filter(
            tenant=tenant, assigned_vm__isnull=False
        ).values_list("ip_address", flat=True)
    }
    index["names"] |= {
        n.strip().lower()
        for n in VirtualMachine.objects.filter(tenant=tenant).values_list("name", flat=True)
        if n
    }
    return index


def is_known(row, index) -> bool:
    host = (row.get("host") or "").strip().lower()
    if host and (host in index["addresses"] or host in index["names"]):
        return True
    if host and host.split(".")[0] in index["names"]:
        return True
    return (row.get("name") or "").strip().lower() in index["names"]


def rules_for(conn) -> list:
    """This connection's enabled rules, in the order they are tried."""
    return list(
        PrtgAdoptionRule.objects.filter(connection=conn, enabled=True)
        .select_related("site", "role", "device_type")
        .order_by("weight", "pattern")
    )


def proposal(conn, row, *, sites, rules=()) -> dict:
    """What applying would make for one PRTG device row, and what is still
    missing to make it. ``sites`` maps a lower-cased site name to its id."""
    host = (row.get("host") or "").strip()
    address = _ip(host)
    group = (row.get("group") or "").strip()
    probe = (row.get("probe") or "").strip()
    name = (row.get("name") or host).strip()
    placed = shared.first_matching_rule(rules, {
        PrtgAdoptionRule.SCOPE_NAME: [name],
        PrtgAdoptionRule.SCOPE_GROUP: [group] if group else [],
        PrtgAdoptionRule.SCOPE_PROBE: [probe] if probe else [],
        PrtgAdoptionRule.SCOPE_IP: [address] if address else [],
    })
    # A PRTG group named like a site - the reverse of a site-per-group
    # layout, so an estate grouped that way reads the same in both.
    site = (sites[group.lower()], group) if group.lower() in sites else None
    chosen, defaulted = shared.place(conn, placed, site=site)
    detail = {
        "objid": str(row["objid"]),
        "name": name,
        "host": host,
        "address": address,
        "group": group,
        "probe": probe,
        **shared.placement_detail(chosen),
        "rule": placed.get("rule"),
        "defaulted": defaulted,
    }
    if host and not address:
        detail["note"] = "PRTG knows it by a DNS name, so no address is recorded."
    shared.set_reason(detail, _HINT)
    return detail


def plan_adoption(conn, devices, fresh: set) -> int:
    """Propose a device for each PRTG device nothing in Danbyte answers to.
    ``devices`` are the normalised rows of the status read."""
    from api.models import Site

    index = known_index(conn.tenant)
    linked = set(PrtgDeviceLink.objects.filter(connection=conn).values_list("objid", flat=True))
    sites = {
        n.lower(): i for i, n in Site.objects.filter(tenant=conn.tenant).values_list("id", "name")
    }
    rules = rules_for(conn)
    n = 0
    for row in devices:
        if str(row["objid"]) in linked or _skip(row) or is_known(row, index):
            continue
        PrtgChange.propose(
            conn, fresh, proposal(conn, row, sites=sites, rules=rules),
            device=None, virtual_machine=None, kind=PrtgChange.ADOPT, key=str(row["objid"]),
        )
        n += 1
    return n


def drop_stale(conn, fresh: set) -> int:
    """Adoption proposals this pass did not make again - the device went, or
    something now answers to it, or adoption was switched off."""
    deleted, _ = (
        PrtgChange.pending(conn).filter(kind=PrtgChange.ADOPT).exclude(id__in=fresh).delete()
    )
    return deleted


def refresh_pending_proposals(conn) -> int:
    """Re-apply the connection's defaults to the adoptions still waiting."""
    return shared.refresh_pending_proposals(
        conn,
        PrtgChange.objects.filter(connection=conn, kind=PrtgChange.ADOPT, ignored=False),
        hint=_HINT,
    )


def apply_adoption(change) -> str:
    """Make the device the proposal describes and link it to the PRTG
    device. Every id in the detail is re-read inside the tenant."""
    conn = change.connection
    detail = change.detail or {}
    objid = str(detail.get("objid") or change.key or "")
    if not objid:
        raise ValueError("This proposal names no PRTG device.")
    if PrtgDeviceLink.objects.filter(connection=conn, objid=objid).exists():
        raise ValueError("That PRTG device is already linked.")
    name = detail.get("name") or detail.get("host") or f"prtg-{objid}"
    with transaction.atomic():
        device, note = shared.make_device(
            conn, detail, name=name, origin=f"PRTG «{conn.name}»"
        )
        PrtgDeviceLink.objects.create(
            tenant=conn.tenant, connection=conn, device=device, objid=objid,
            name=(detail.get("name") or "")[:255], host=(detail.get("host") or "")[:255],
            probe_name=(detail.get("probe") or "")[:255],
            group_path=(detail.get("group") or "")[:255],
            matched_by="adopted", created_here=False, last_seen_at=timezone.now(),
        )
        change.delete()
    log.info("prtg %s: adopted %s as a device", conn.name, name)
    return f"Adopted {name} as a device.{note}"
