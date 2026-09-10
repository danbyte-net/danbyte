"""Danbyte's inventory, written into Zabbix (#162 phase 2).

Danbyte already knows every device's name, address, site and serial, and
somebody has usually typed all four into Zabbix by hand. This closes that.

Three rules, all of them the same rule in different clothes - **Danbyte does
not act on a guess, and does not act at all unless asked**:

* ``provision_mode`` is **off** by default. Reading somebody's monitoring is
  one decision; writing to it is another, and the second is never implied.
* ``review`` proposes and stops. Every write shows up as a change an operator
  reads first, and applying one is their act.
* Pruning is a third switch, also off, with a grace period - and only ever
  touches a host **Danbyte created itself**.

**What is in scope** is the elegant part: the devices Danbyte already asks
Zabbix about. A ``zabbix``-kind check bound to this connection's engine is
exactly the statement "I want Zabbix watching this", so it drives provisioning
too. One scope definition, not two that can disagree.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

from integrations.toggles import integration_enabled

from .checker import KIND
from .client import ZabbixClient, ZabbixError
from .matching import index_hosts, match_device
from .models import ZabbixChange, ZabbixConnection, ZabbixHostLink

log = logging.getLogger("zabbix.provision")

#: Zabbix interface type 1 is "agent". Danbyte does not yet know which of a
#: device's addresses is the agent's, so it states the one it is sure of and
#: leaves the rest to Zabbix's own templates.
IFACE_AGENT = 1
DEFAULT_AGENT_PORT = "10050"
#: Where a device has no site to name a group after.
FALLBACK_GROUP = "Danbyte"


def _client(conn: ZabbixConnection) -> ZabbixClient:
    return ZabbixClient(
        conn.api_url, (conn.credentials or {}).get("token", ""),
        verify_tls=conn.verify_tls,
    )


def devices_in_scope(conn: ZabbixConnection):
    """The devices this connection should be keeping hosts for.

    Derived from the checks, not from a second filter: a device with a
    ``zabbix`` check on one of this connection's engines is one an operator
    has already said they want Zabbix watching.
    """
    from api.models import Device
    from monitoring.models import CheckState

    engine_ids = list(
        conn.tenant.monitoring_engines.filter(kind="zabbix").values_list(
            "id", flat=True
        )
    )
    if not engine_ids:
        return Device.objects.none()
    device_ids = (
        CheckState.objects.filter(kind=KIND, engine_id__in=engine_ids)
        .exclude(target_ip__assigned_device__isnull=True)
        .values_list("target_ip__assigned_device_id", flat=True)
        .distinct()
    )
    return (
        Device.objects.filter(tenant=conn.tenant, id__in=list(device_ids))
        .select_related("primary_ip", "site", "role")
    )


def host_payload(device, group_id) -> dict:
    """What Danbyte would write for this device.

    Deliberately small. Danbyte states the facts it owns - name, address,
    group, serial - and says nothing about items, triggers or templates, which
    are Zabbix's to own. Two systems editing one field is how both stop being
    trusted.
    """
    address = ""
    if device.primary_ip_id and device.primary_ip:
        address = str(device.primary_ip.ip_address).split("/")[0]
    payload = {
        "host": device.name,
        "groups": [{"groupid": group_id}],
        "interfaces": [{
            "type": IFACE_AGENT,
            "main": 1,
            "useip": 1 if address else 0,
            "ip": address,
            "dns": "" if address else device.name,
            "port": DEFAULT_AGENT_PORT,
        }],
    }
    if device.serial_number:
        # inventory_mode 0 = manual: Danbyte is stating the serial, not asking
        # Zabbix to discover it.
        payload["inventory_mode"] = 0
        payload["inventory"] = {"serialno_a": device.serial_number}
    return payload


def _differences(device, host) -> dict:
    """What Danbyte would change on an existing host, and nothing more.

    Only fields Danbyte is the source of truth for, and only where Zabbix's
    value is actually different - an update that rewrites a field to itself is
    noise in somebody's audit log.
    """
    out = {}
    if device.name and host.get("host") != device.name:
        out["host"] = device.name
    address = ""
    if device.primary_ip_id and device.primary_ip:
        address = str(device.primary_ip.ip_address).split("/")[0]
    if address:
        addresses = {
            (i.get("ip") or "") for i in host.get("interfaces") or []
        }
        if address not in addresses:
            out["_address"] = address
    return out


def plan(conn: ZabbixConnection, now=None) -> dict:
    """Work out what Danbyte would do, and record it.

    Returns counts. Nothing is written to Zabbix here - in ``auto`` mode
    :func:`apply_pending` runs straight afterwards, but the planning pass is
    the same either way, so what an operator approves is exactly what an
    automatic run would have done.
    """
    now = now or timezone.now()
    counts = {"scoped": 0, "linked": 0, "create": 0, "update": 0,
              "ambiguous": 0, "prune": 0}
    if conn.provision_mode == ZabbixConnection.OFF:
        return counts
    if not integration_enabled(conn.tenant, "zabbix"):
        return counts

    devices = list(devices_in_scope(conn))
    counts["scoped"] = len(devices)

    hosts = []
    if devices:
        try:
            hosts = _client(conn).all_hosts()
        except ZabbixError as exc:
            # Without the host list every device looks unmatched, and proposing
            # to create the whole estate would be catastrophic. Nothing is also
            # the right answer for pruning: Danbyte cannot say a host is
            # unwanted when it could not read what is there.
            log.warning("zabbix %s: could not read hosts: %s", conn.name, exc)
            return counts

    index = index_hosts(hosts)
    index["by_id"] = {h["hostid"]: h for h in hosts}
    links = {
        link.device_id: link
        for link in ZabbixHostLink.objects.filter(connection=conn)
    }
    fresh: set = set()

    with transaction.atomic():
        # An empty scope still reaches the prune pass below - that is precisely
        # the case pruning exists for, and returning early here meant a host
        # Danbyte created and then abandoned was never even marked.
        for device in devices:
            match = match_device(device, index, links.get(device.id))
            if match.how == "ambiguous":
                counts["ambiguous"] += 1
                _propose(conn, device, ZabbixChange.AMBIGUOUS,
                         {"reason": match.reason}, fresh)
                continue
            if match.matched:
                link = _remember(conn, device, match, now)
                counts["linked"] += 1
                changed = _differences(device, match.host)
                if changed:
                    counts["update"] += 1
                    _propose(conn, device, ZabbixChange.UPDATE,
                             {"hostid": link.hostid, "changes": changed}, fresh)
                continue
            counts["create"] += 1
            _propose(conn, device, ZabbixChange.CREATE,
                     {"name": device.name,
                      "site": device.site.name if device.site_id else None},
                     fresh)

        counts["prune"] = _plan_prune(conn, {d.id for d in devices}, now, fresh)
        # A proposal nobody has looked at, for something that is no longer
        # true, is worse than no proposal.
        ZabbixChange.objects.filter(connection=conn, ignored=False).exclude(
            id__in=fresh
        ).delete()
    return counts


def _propose(conn, device, kind, detail, fresh):
    change, _ = ZabbixChange.objects.update_or_create(
        connection=conn, device=device, kind=kind,
        defaults={"tenant": conn.tenant, "detail": detail},
    )
    fresh.add(change.id)
    return change


def _remember(conn, device, match, now) -> ZabbixHostLink:
    link, _ = ZabbixHostLink.objects.update_or_create(
        connection=conn, device=device,
        defaults={
            "tenant": conn.tenant,
            "hostid": match.host["hostid"],
            "host_name": match.host.get("name", "")[:255],
            "matched_by": match.how,
            "last_seen_at": now,
            "unwanted_since": None,
        },
    )
    return link


def _plan_prune(conn, wanted_ids, now, fresh) -> int:
    """Hosts Danbyte made and no longer has a reason for.

    Only ever ``created_here`` hosts: a host somebody else made is theirs, and
    Danbyte losing interest in it is not a reason to delete it.
    """
    stale = ZabbixHostLink.objects.filter(
        connection=conn, created_here=True
    ).exclude(device_id__in=wanted_ids).select_related("device")
    grace = timedelta(days=conn.prune_after_days)
    n = 0
    for link in stale:
        if link.unwanted_since is None:
            link.unwanted_since = now
            link.save(update_fields=["unwanted_since"])
        if not conn.prune_hosts or now - link.unwanted_since < grace:
            continue
        n += 1
        _propose(conn, link.device, ZabbixChange.PRUNE,
                 {"hostid": link.hostid, "host_name": link.host_name,
                  "unwanted_since": link.unwanted_since.isoformat()}, fresh)
    return n


def apply_change(change: ZabbixChange) -> str:
    """Do one proposed write. Returns a sentence for the operator.

    Applying deletes the change: it was a proposal, and a proposal that has
    happened is not a record of anything.
    """
    conn = change.connection
    client = _client(conn)
    device = change.device

    if change.kind == ZabbixChange.CREATE:
        group = client.group_id(
            device.site.name if device and device.site_id else FALLBACK_GROUP
        )
        hostid = client.create_host(host_payload(device, group))
        ZabbixHostLink.objects.update_or_create(
            connection=conn, device=device,
            defaults={"tenant": conn.tenant, "hostid": hostid,
                      "host_name": device.name, "matched_by": "created",
                      "created_here": True, "last_seen_at": timezone.now(),
                      "unwanted_since": None},
        )
        result = f"Created {device.name} in Zabbix."
    elif change.kind == ZabbixChange.UPDATE:
        detail = change.detail or {}
        payload = {k: v for k, v in (detail.get("changes") or {}).items()
                   if not k.startswith("_")}
        if payload:
            client.update_host(detail["hostid"], payload)
        result = f"Updated {device.name if device else 'host'} in Zabbix."
    elif change.kind == ZabbixChange.PRUNE:
        hostid = (change.detail or {}).get("hostid")
        client.delete_hosts([hostid])
        ZabbixHostLink.objects.filter(connection=conn, hostid=hostid).delete()
        result = f"Removed {(change.detail or {}).get('host_name')} from Zabbix."
    else:
        # "Needs a decision" is not something Danbyte can apply - resolving it
        # means linking or renaming, which is the operator's to do.
        raise ValueError("This change has to be resolved by hand.")

    change.delete()
    return result


def apply_pending(conn: ZabbixConnection) -> dict:
    """Apply every proposal - what ``auto`` mode does after planning.

    One failure never stops the rest: a single host Zabbix refuses should not
    hold up forty it would have accepted.
    """
    done = {"applied": 0, "failed": 0}
    for change in list(
        ZabbixChange.objects.filter(connection=conn, ignored=False)
        .exclude(kind=ZabbixChange.AMBIGUOUS)
        .select_related("device", "connection")
    ):
        try:
            apply_change(change)
            done["applied"] += 1
        except (ZabbixError, ValueError) as exc:
            done["failed"] += 1
            log.warning("zabbix %s: %s failed: %s", conn.name, change.kind, exc)
    return done


def sync(conn: ZabbixConnection, now=None) -> dict:
    """Plan, and in ``auto`` mode apply. The one entry point.

    Used by the Sync button and by the beat, so a timer can never do something
    the button would not have done.
    """
    counts = plan(conn, now)
    if conn.provision_mode == ZabbixConnection.AUTO:
        counts.update(apply_pending(conn))
    conn.last_sync_at = timezone.now()
    conn.last_sync_summary = counts
    conn.save(update_fields=["last_sync_at", "last_sync_summary"])
    return counts
