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
from .templates import (
    IFACE_SNMP,
    groups_for,
    profile_for,
    rules_for,
    snmp_interface,
    snmp_macros,
    templates_for,
)

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


def device_address(device) -> str:
    if device.primary_ip_id and device.primary_ip:
        return str(device.primary_ip.ip_address).split("/")[0]
    return ""


def host_payload(device, group_ids, *, template_ids=(), profile=None,
                 macros=()) -> dict:
    """What Danbyte would write for this device.

    Still deliberately small: Danbyte states the facts it owns - name, address,
    group, serial - and says nothing about items or triggers, which are
    Zabbix's. Templates are the one place the line moved, and on purpose: a
    host with no template monitors nothing, and which template a device wants
    is a question about what the device *is*, which is the one Danbyte exists
    to answer.
    """
    address = device_address(device)
    interfaces = [{
        "type": IFACE_AGENT,
        "main": 1,
        "useip": 1 if address else 0,
        "ip": address,
        "dns": "" if address else device.name,
        "port": DEFAULT_AGENT_PORT,
    }]
    snmp = snmp_interface(device, profile, address)
    if snmp is not None:
        interfaces.append(snmp)
    payload = {
        "host": device.name,
        "groups": [{"groupid": g} for g in group_ids],
        "interfaces": interfaces,
    }
    if template_ids:
        payload["templates"] = [{"templateid": t} for t in template_ids]
    if macros:
        payload["macros"] = list(macros)
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
    address = device_address(device)
    if address:
        interfaces = host.get("interfaces") or []
        addresses = {(i.get("ip") or "") for i in interfaces}
        if address not in addresses:
            out["_address"] = address
            # An address lives on an interface, and `host.update` cannot touch
            # one - without the id, applying this said "Updated" and changed
            # nothing. The agent interface is the one Danbyte wrote.
            agent = next(
                (i for i in interfaces if str(i.get("type")) == str(IFACE_AGENT)),
                None,
            ) or (interfaces[0] if interfaces else None)
            if agent and agent.get("interfaceid"):
                out["_interfaceid"] = agent["interfaceid"]
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
              "template": 0, "ambiguous": 0, "prune": 0}
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
    # One read for the whole pass: a rule set is small and every device is
    # matched against all of it.
    rules = rules_for(conn)
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
                missing = _missing_templates(device, match.host, rules)
                groups = _missing_groups(device, match.host, rules)
                if missing or groups:
                    counts["template"] += 1
                    _propose(conn, device, ZabbixChange.TEMPLATE,
                             {"hostid": link.hostid, "add": missing,
                              "add_groups": groups,
                              "add_snmp_interface": _needs_snmp_interface(
                                  device, match.host, conn)}, fresh)
                continue
            counts["create"] += 1
            _propose(conn, device, ZabbixChange.CREATE,
                     {"name": device.name,
                      "site": device.site.name if device.site_id else None,
                      "groups": group_names(device, rules),
                      "templates": templates_for(device, rules)},
                     fresh)

        counts["prune"] = _plan_prune(conn, {d.id for d in devices}, now, fresh)
        # A proposal nobody has looked at, for something that is no longer
        # true, is worse than no proposal.
        ZabbixChange.objects.filter(connection=conn, ignored=False).exclude(
            id__in=fresh
        ).delete()
    return counts


def group_names(device, rules) -> list[str]:
    """The host groups this device belongs in.

    A rule's groups if any rule has an opinion; otherwise the device's site,
    which is what every host got before rules existed. Zabbix will not accept a
    host with no group at all, so there is always a last resort.
    """
    named = groups_for(device, rules)
    if named:
        return named
    if device is not None and device.site_id:
        return [device.site.name]
    return [FALLBACK_GROUP]


def _missing_groups(device, host, rules) -> list[str]:
    """Groups the rules ask for that this host is not already in.

    Only ever added. A group somebody put a host in is theirs, and Danbyte
    never proposes the site fallback for an existing host - that default is for
    hosts it is creating, not an opinion to impose later.
    """
    wanted = groups_for(device, rules)
    if not wanted:
        return []
    rows = host.get("hostgroups") or host.get("groups") or []
    have = {g.get("name") for g in rows}
    return [name for name in wanted if name not in have]


def _missing_templates(device, host, rules) -> list[str]:
    """Templates the rules ask for that this host does not already carry.

    Danbyte only ever adds. A template somebody linked by hand is theirs, and
    a rule that stops matching is not a reason to strip a host of monitoring.
    """
    wanted = templates_for(device, rules)
    if not wanted:
        return []
    have = {t.get("host") for t in host.get("parentTemplates") or []}
    return [name for name in wanted if name not in have]


def _needs_snmp_interface(device, host, conn) -> bool:
    """Whether this host would have to grow an SNMP interface first.

    Zabbix refuses to link an SNMP template to a host that has nowhere to poll
    through - and a host Danbyte created before it knew how to write SNMP
    interfaces is exactly that. Reported at plan time so the operator agrees to
    the interface as well as the template, and fixed at apply time so they do
    not have to do it by hand.
    """
    if profile_for(device, conn.tenant) is None:
        return False
    return not any(
        str(i.get("type")) == str(IFACE_SNMP)
        for i in host.get("interfaces") or []
    )


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
        rules = rules_for(conn)
        groups = client.group_ids(group_names(device, rules))
        wanted = templates_for(device, rules)
        found = client.template_ids(wanted)
        missing = [n for n in wanted if n not in found]
        profile = profile_for(device, conn.tenant)
        macros = snmp_macros(profile) if conn.send_snmp_credentials else []
        hostid = client.create_host(host_payload(
            device, groups, template_ids=list(found.values()),
            profile=profile, macros=macros,
        ))
        ZabbixHostLink.objects.update_or_create(
            connection=conn, device=device,
            defaults={"tenant": conn.tenant, "hostid": hostid,
                      "host_name": device.name, "matched_by": "created",
                      "created_here": True, "last_seen_at": timezone.now(),
                      "unwanted_since": None},
        )
        result = f"Created {device.name} in Zabbix."
        if missing:
            # The host exists and is worth saying so; the templates Zabbix has
            # never heard of are worth saying too, in the same breath.
            result += f" Zabbix has no template named {', '.join(missing)}."
    elif change.kind == ZabbixChange.UPDATE:
        detail = change.detail or {}
        changes = detail.get("changes") or {}
        payload = {k: v for k, v in changes.items() if not k.startswith("_")}
        if payload:
            client.update_host(detail["hostid"], payload)
        address, interfaceid = changes.get("_address"), changes.get("_interfaceid")
        if address and interfaceid:
            client.update_interface(interfaceid, {"useip": 1, "ip": address})
        result = f"Updated {device.name if device else 'host'} in Zabbix."
    elif change.kind == ZabbixChange.TEMPLATE:
        detail = change.detail or {}
        # The interface first: an SNMP template will not link to a host with
        # nowhere to poll through, and doing it in two changes would leave the
        # order to chance.
        _ensure_snmp_ready(client, conn, device, detail["hostid"])
        # Re-read rather than trusting the plan: a template linked by hand
        # since, or one Zabbix does not have, both belong in the answer.
        already = client.host_templates(detail["hostid"])
        wanted = [n for n in (detail.get("add") or []) if n not in already]
        found = client.template_ids(wanted)
        client.link_templates(detail["hostid"], list(found.values()))
        missing = [n for n in wanted if n not in found]
        # Groups the same way: re-read, add only what is absent - and only
        # ask at all when a rule named some, which most changes do not.
        want_groups = list(detail.get("add_groups") or [])
        if want_groups:
            in_groups = client.host_groups(detail["hostid"])
            want_groups = [g for g in want_groups if g not in in_groups]
        if want_groups:
            client.add_groups(detail["hostid"], client.group_ids(want_groups))
        did = ", ".join([*found, *want_groups]) or "nothing new"
        result = f"Linked {did} to {device.name if device else 'host'}."
        if missing:
            result += f" Zabbix has no template named {', '.join(missing)}."
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


def _ensure_snmp_ready(client, conn, device, hostid) -> bool:
    """Give a host what its SNMP templates need, if it does not have it.

    Two things, both **only ever added**: the SNMP interface Zabbix insists on
    before it will link an SNMP template, and - when the connection's
    credential switch is on - the macros that interface refers to. An interface
    somebody configured is theirs, and a macro somebody set is theirs; a host
    that has neither cannot poll, which is the case worth closing.
    """
    if device is None:
        return False
    profile = profile_for(device, conn.tenant)
    if profile is None:
        return False
    acted = False
    existing = client.host_interfaces(hostid)
    if not any(str(i.get("type")) == str(IFACE_SNMP) for i in existing):
        payload = snmp_interface(device, profile, device_address(device))
        if payload is not None:
            client.create_interface(hostid, payload)
            acted = True
    if conn.send_snmp_credentials:
        # A secret macro's value never comes back, so presence is the only
        # honest question - and the only one worth asking, because a value
        # somebody changed is theirs.
        have = client.host_macro_names(hostid)
        missing = [m for m in snmp_macros(profile) if m["macro"] not in have]
        if missing:
            client.add_macros(hostid, missing)
            acted = True
    return acted


def apply_pending(conn: ZabbixConnection) -> dict:
    """Apply every proposal - what ``auto`` mode does after planning.

    One failure never stops the rest: a single host Zabbix refuses should not
    hold up forty it would have accepted.
    """
    done = {"applied": 0, "failed": 0, "errors": []}
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
            # What Zabbix said, not just that something failed. Its refusals
            # are usually the operator's answer - "these two templates both
            # define icmpping" is a rule to fix, and a bare count is not.
            if len(done["errors"]) < 10:
                done["errors"].append({
                    "device": change.device.name if change.device_id else "",
                    "kind": change.kind,
                    "detail": str(exc)[:300],
                })
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
