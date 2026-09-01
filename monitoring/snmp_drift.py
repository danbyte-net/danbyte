"""Reconciliation: compare *observed* SNMP state to the device's *intended*
source-of-truth and surface the differences (drift), then apply an accepted
difference back to intent (#84, Phase 3).

Discovery never mutates the SoT on its own - ``compute_device_drift`` is
read-only; only an explicit ``apply_drift_action`` (an operator clicking
"Accept") writes a Device/Interface field. That's what keeps Danbyte the source
of truth while still letting reality flow in on demand.
"""
from __future__ import annotations

import re

import ipaddress as ipmod

from django.db import IntegrityError

from api.models import Interface, IPAddress, MACAddress, Prefix, VLAN
from api.speed import fmt_speed, speed_mbps
from api.vrf_placement import ANY_VRF, containing_prefix

from .models import DeviceSnmp, MonitoringSettings


def _real_ip(ip: str) -> bool:
    """Whether an observed IP is worth importing. Skips the addresses SNMP will
    inevitably report but that don't belong in IPAM - IPv4/IPv6 loopback
    (127.x, ::1), link-local (169.254.x, fe80::), unspecified (0.0.0.0, ::), and
    multicast. Uses the stdlib classifier so every special range is covered."""
    try:
        addr = ipmod.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_loopback
        or addr.is_link_local
        or addr.is_unspecified
        or addr.is_multicast
    )


def _suggested_prefix(ip: str) -> str:
    """A sensible prefix to create for an observed IP that has none - the host's
    natural /24 (v4) or /64 (v6) - so the UI can pre-fill "Add prefix"."""
    try:
        addr = ipmod.ip_address(ip)
    except ValueError:
        return ""
    plen = 24 if addr.version == 4 else 64
    return str(ipmod.ip_network(f"{ip}/{plen}", strict=False))


# Speed parsing/formatting is shared with the API (bundle capacity) - kept
# under the old names here so the call sites and tests read unchanged.
_fmt_speed = fmt_speed


#: A port learning more distinct MACs than this is treated as an uplink/trunk
#: and never gets switch-link suggestions (issue #22). An access port with an
#: IP phone, its PC, and a small hypervisor still fits under the limit.
UPLINK_MAC_LIMIT = 4


def _skip_not_present(tenant) -> bool:
    """Whether ports the agent reports as notPresent are ignored (#97).

    Stackable firmware pre-allocates ports for members that aren't installed
    and flags them notPresent. Importing those as ordinary enabled interfaces
    buries the real ports - so by default they're skipped on both drift and
    sync; a tenant that wants them can turn the setting on.

    A plain read, never ``for_tenant`` - that get-or-creates, which would
    make the FIRST drift call of a deployment cost writes the next one
    doesn't (the fleet endpoint's query-count guard catches exactly that).
    """
    from .models import MonitoringSettings

    opted_in = (
        MonitoringSettings.objects.filter(tenant=tenant)
        .values_list("snmp_import_not_present", flat=True)
        .first()
    )
    return not opted_in


def _snmp_policy(tenant) -> dict:
    """The tenant's SNMP source-of-truth policy flags, one plain read (no
    get-or-create - same rule as _skip_not_present)."""
    row = (
        MonitoringSettings.objects.filter(tenant=tenant)
        .values("snmp_update_only", "snmp_skip_unrouted_vlans",
                "snmp_mac_from_fdb")
        .first()
    )
    return row or {
        "snmp_update_only": False,
        "snmp_skip_unrouted_vlans": False,
        "snmp_mac_from_fdb": False,
    }


def _is_unrouted_vlan(o: dict) -> bool:
    """Cisco exposes every L2 VLAN as an ifTable pseudo-interface (ifType
    l2vlan / ifDescr "unrouted VLAN 401"). Those are VLANs, not ports. A
    routed SVI reports ifType l3vlan/propVirtual and is NOT matched here."""
    if str(o.get("type_name") or "") == "l2vlan":
        return True
    return str(o.get("descr") or "").lower().startswith("unrouted vlan")


def _fdb_single_macs(state) -> dict:
    """if_index → the ONE MAC learned on that port, from the FDB. Ports with
    several learners (trunks, uplinks) map to None so callers skip them."""
    seen: dict = {}
    for row in state.fdb or []:
        idx = str(row.get("if_index") or "")
        if not idx or not row.get("mac"):
            continue
        if idx in seen and seen[idx] != row["mac"]:
            seen[idx] = None
        else:
            seen.setdefault(idx, row["mac"])
    return seen


def _is_not_present(o: dict) -> bool:
    return str(o.get("oper_status") or "").lower() == "notpresent"


def _not_present_status(tenant):
    """The tenant's "Not present" interface status, or None if renamed away.

    Stamped on ports imported while the agent reports them notPresent (#105)
    so they read as absent hardware, not as ports someone switched off.
    """
    from api.models import Status

    return (
        Status.objects.filter(tenant=tenant, slug="not_present")
        .filter(available_to__contains=["interface"])
        .first()
    )


def _norm(value) -> str:
    return (value or "").strip().lower()


# Observed ifType name → the Danbyte interface type a discovered row is created
# with. Only the aggregate is mapped: it must be typed "lag" to take members.
_OBSERVED_TYPE = {"lag": "lag"}


def _lag_membership_items(device, observed: list[dict], int_by_name: dict) -> list[dict]:
    """Bundle membership drift: the aggregate each port reports itself under
    versus the `lag` it has in Danbyte. Compared by aggregate NAME - on a
    stack the aggregate lives on the master while the member port sits on
    another member device, so ids can't be compared. Rows without the
    ``lag_if_index`` key come from an agent that never looked and say
    nothing."""
    by_ifindex = {str(o.get("if_index") or ""): o for o in observed}
    items: list[dict] = []
    for o in observed:
        if "lag_if_index" not in o:
            continue
        existing = _match_observed(o, int_by_name)
        if existing is None or existing.snmp_ignore:
            continue
        agg_o = by_ifindex.get(str(o.get("lag_if_index") or "")) if o.get("lag_if_index") else None
        observed_name = str((agg_o or {}).get("name") or "")
        intended_name = existing.lag.name if existing.lag_id else ""
        if _norm(observed_name) == _norm(intended_name):
            continue
        if agg_o is not None and intended_name and _norm(agg_o.get("descr")) == _norm(intended_name):
            continue
        agg_iface = None
        if agg_o is not None:
            agg_iface = _match_observed(agg_o, int_by_name)
            if agg_iface is None and device.virtual_chassis_id:
                agg_iface = (
                    Interface.objects.filter(
                        device__virtual_chassis_id=device.virtual_chassis_id,
                        name__iexact=observed_name,
                    )
                    .exclude(device=device)
                    .first()
                )
        items.append({
            "kind": "lag_membership", "interface_id": str(existing.id),
            "name": existing.name,
            "intended": intended_name or "-", "observed": observed_name or "-",
            "lag_interface_id": str(agg_iface.id) if agg_iface else None,
        })
    return items


_speed_mbps = speed_mbps


def _part_drift(device, tenant, state) -> list[dict]:
    """Differences between observed hardware health and the parts' set statuses.

    Readings live on ``DeviceSnmp.sensors``, each carrying the status its value
    map resolved to. Compared against the part's own status, that yields either
    a status to review or a part Danbyte has never heard of.

    Covers the SNMP sensor path only for now. The Redfish collector still writes
    part statuses directly (``monitoring/redfish.py``) and so never appears here
    - the same treatment is owed to it.

    Deliberately mode-agnostic: an ``auto`` sensor has already written its
    reading into intent, so the two agree and it contributes nothing.
    """
    from api.models import InventoryItem

    readings = [r for r in (state.sensors or []) if r.get("status")]
    if not readings:
        return []

    parts = {
        _norm(p.name): p
        for p in InventoryItem.objects.filter(device=device).select_related("status")
    }
    out: list[dict] = []
    for r in readings:
        name = (r.get("name") or "").strip()
        if not name:
            continue
        part = parts.get(_norm(name))
        if part is None:
            out.append({
                "kind": "part_missing", "name": name,
                "part_kind": r.get("kind") or "other",
                "sensor": r.get("sensor") or "",
                "observed": r["status"], "raw": r.get("raw") or "",
            })
            continue
        intended = part.status.slug if part.status_id else ""
        if intended == r["status"]:
            continue
        out.append({
            "kind": "part_status", "part_id": str(part.id), "name": part.name,
            "sensor": r.get("sensor") or "",
            "intended": part.status.name if part.status_id else "-",
            "observed": r["status"], "raw": r.get("raw") or "",
        })
    return out


def _observed_ip_rows(tenant, observed) -> dict:
    """Existing IPAddress rows for every address this poll reported, by address."""
    addrs = {
        ip for o in observed for ip in (o.get("ip_addresses") or []) if _real_ip(ip)
    }
    if not addrs:
        return {}
    return {
        r.ip_address: r
        for r in IPAddress.objects.filter(tenant=tenant, ip_address__in=addrs)
    }


def _ip_attachable(ip_rows: dict, device, iface, ip: str) -> bool:
    """Is attaching ``ip`` to ``iface`` new, safe information?

    "Already on the device" is not the same as "already on the right port", and
    conflating them hid the common case: a server's OOB address is recorded on
    the device with no interface, so SNMP naming the port that bears it was
    discarded as redundant and the address never reached the port.
    """
    row = ip_rows.get(ip)
    if row is None:
        return True  # not recorded at all → offer to create it
    if row.assigned_interface_id == iface.id:
        return False  # already right
    if row.assigned_interface_id:
        return False  # on another port - a conflict to resolve, not to move
    # No port. Free, or already on THIS device: binding it to the port SNMP
    # names is a refinement, not a theft.
    return row.assigned_device_id in (None, device.id)


def _intent_by_observed_name(intended) -> dict:
    """Map every name the agent may report → the interface it means.

    Ports match on their label, except that an explicit SNMP link REPLACES the
    label: the link is the operator saying "the agent calls this port eth0" -
    which also says the agent never reports the label, so keeping the label as
    a second key invented a phantom "not seen on device" row for the very port
    that was just linked.

    A link pointing at another port's own label can't be honoured: that port
    exists in its own right and would be evicted from the map, hiding a real
    duplicate. Such a link is ignored and both stay visible.

    Shared by drift compute AND sync - when sync had its own label-only map, a
    linked port's observed row didn't match it, so sync created a duplicate
    interface under the discovered name and hung the speed/VLAN/IPs there.
    """
    intended = list(intended)
    by_name = {_norm(i.name): i for i in intended}
    real_names = set(by_name)
    linked: dict = {}
    for i in intended:
        if not i.snmp_name:
            continue
        key = _norm(i.snmp_name)
        if key != _norm(i.name) and key in real_names:
            continue
        linked[key] = i
        by_name.pop(_norm(i.name), None)
    by_name.update(linked)
    return by_name


def _match_observed(o: dict, int_by_name: dict):
    """The intended interface an observed SNMP row refers to, or ``None``.

    Tries ifName (``Gi1/0/1``) first, then ifDescr (``GigabitEthernet1/0/1``).
    Cisco - and most vendors - report the SHORT form as ifName but the FULL form
    as ifDescr, and the full form is exactly what the device-type library stamps.
    Matching on name alone drifts every port of a library-built switch twice: a
    "new interface" for the short name and a "not seen on device" for the full
    one. Bridging through the device's OWN name↔descr pair beats a hard-coded
    abbreviation table (no Gi/Te/Fo/Twe/Tw vocabulary to maintain, no vendor
    guessing) and is safe: ifDescr only matches when it equals a real intended
    name, so a device that puts descriptive or duplicate text in ifDescr simply
    falls through to "new", exactly as before. An explicit snmp_name link still
    wins - it is already folded into ``int_by_name``.
    """
    for key in (_norm(o.get("name")), _norm(o.get("descr"))):
        if key and key in int_by_name:
            return int_by_name[key]
    return None


def _norm_mac(value) -> str:
    """Compare MACs by their hex digits only, so colon/dash/Cisco-dotted forms
    of the same address (``00:11:22:33:44:55`` vs ``0011.2233.4455``) don't read
    as drift - which would otherwise churn the SoT on every accept."""
    return re.sub(r"[^0-9a-f]", "", (value or "").lower())


def compute_device_drift(
    device, tenant, state=None, intended_interfaces=None, skip_absent=None
) -> list[dict]:
    """Read-only list of differences between observed SNMP state and intent.

    ``state`` (the device's ``DeviceSnmp`` row) and ``intended_interfaces`` (its
    ``Interface`` rows) may be passed pre-fetched - the fleet-wide drift list does
    this to avoid an N+1. Omit them on the per-device path and they're queried.
    """
    if state is None:
        state = DeviceSnmp.objects.filter(device=device, tenant=tenant).first()
    if state is None or not state.polled_at:
        return []

    items: list[dict] = []

    # 1. Device name vs sysName.
    sys_name = (state.data or {}).get("sys_name")
    if sys_name and _norm(sys_name) != _norm(device.name):
        items.append({
            "kind": "device_field", "field": "name", "label": "Device name",
            "intended": device.name, "observed": sys_name,
        })

    # 2. Interfaces, matched by name (case-insensitive).
    observed = [o for o in (state.interfaces or []) if o.get("name")]
    # Callers that loop devices resolve the policy once and pass it in.
    if skip_absent is None:
        skip_absent = _skip_not_present(tenant)
    if skip_absent:
        observed = [o for o in observed if not _is_not_present(o)]
    policy = _snmp_policy(tenant)
    if policy["snmp_skip_unrouted_vlans"]:
        observed = [o for o in observed if not _is_unrouted_vlan(o)]
    fdb_macs = _fdb_single_macs(state) if policy["snmp_mac_from_fdb"] else None
    obs_by_name = {_norm(o["name"]): o for o in observed}
    intended = (
        list(intended_interfaces) if intended_interfaces is not None
        else list(Interface.objects.filter(device=device).select_related("vlan"))
    )
    int_by_name = _intent_by_observed_name(intended)
    # Existing rows for the addresses SNMP just reported. Keyed by address so we
    # can tell "already on this port" from "on the device but on no port" - the
    # OOB address case, where the port SNMP names is new information - from
    # "belongs to someone else".
    ip_rows = _observed_ip_rows(tenant, observed)
    # The tenant's prefix networks (loaded once) so we can tell the UI whether a
    # discovered IP is acceptable yet, or needs a prefix created first.
    tenant_nets = []
    for cidr in Prefix.objects.filter(tenant=tenant).values_list("cidr", flat=True):
        try:
            tenant_nets.append(ipmod.ip_network(cidr, strict=False))
        except (ValueError, TypeError):
            continue

    def _has_prefix(ip: str) -> bool:
        try:
            addr = ipmod.ip_address(ip)
        except ValueError:
            return False
        return any(addr in n for n in tenant_nets)

    matched_ids: set = set()
    for name, o in obs_by_name.items():
        existing = _match_observed(o, int_by_name)
        if existing is None:
            # Update-only fleets: the operator is the source of truth for
            # WHICH ports exist - never propose adding one.
            if not policy["snmp_update_only"]:
                items.append({
                    "kind": "interface_missing",
                    "name": o["name"], "if_index": o.get("if_index", ""),
                    "observed": {
                        "mac": o.get("mac", ""),
                        "admin_status": o.get("admin_status", ""),
                        "type_name": o.get("type_name", ""),
                    },
                })
            continue
        # This intended port has been seen (by name or by descr), so it can't
        # also be reported stale below.
        matched_ids.add(existing.id)
        # Excluded from drift: the port still matches (so its observed row
        # doesn't drift as "new"), but produces no items in either direction.
        if existing.snmp_ignore:
            continue
        # MAC mismatch (separator-insensitive - see _norm_mac). With the
        # MAC-table policy the compared value is the port's single learned
        # MAC (the attached device); several learners → no proposal.
        if fdb_macs is None:
            obs_mac = o.get("mac")
        else:
            obs_mac = fdb_macs.get(str(o.get("if_index") or ""))
        if obs_mac and _norm_mac(obs_mac) != _norm_mac(existing.mac_address):
            items.append({
                "kind": "interface_mismatch", "interface_id": str(existing.id),
                "name": existing.name, "field": "mac_address",
                "intended": existing.mac_address, "observed": obs_mac,
            })
        # Admin enabled mismatch.
        if o.get("admin_status") in ("up", "down"):
            obs_enabled = o["admin_status"] == "up"
            if obs_enabled != existing.enabled:
                items.append({
                    "kind": "interface_mismatch", "interface_id": str(existing.id),
                    "name": existing.name, "field": "enabled",
                    "intended": existing.enabled, "observed": obs_enabled,
                })
        # Speed - compared numerically (see _speed_mbps): "1G", "1 Gbps" and
        # 1000 Mbps are the same value in three costumes. An intended speed
        # that doesn't parse is deliberate free text; leave it alone.
        obs_mbps = _speed_mbps(_fmt_speed(o.get("speed_mbps")))
        if obs_mbps is not None:
            int_mbps = _speed_mbps(existing.speed)
            if (int_mbps is None and not existing.speed) or (
                int_mbps is not None and int_mbps != obs_mbps
            ):
                items.append({
                    "kind": "interface_mismatch", "interface_id": str(existing.id),
                    "name": existing.name, "field": "speed",
                    "intended": existing.speed or "-",
                    "observed": _fmt_speed(o.get("speed_mbps")),
                })
        # Access-VLAN (PVID) mismatch - observed from Q-BRIDGE-MIB.
        if o.get("vlan"):
            intended_vid = str(existing.vlan.vlan_id) if existing.vlan_id else ""
            if str(o["vlan"]) != intended_vid:
                items.append({
                    "kind": "interface_mismatch", "interface_id": str(existing.id),
                    "name": existing.name, "field": "vlan",
                    "intended": intended_vid or "-", "observed": str(o["vlan"]),
                })
        # IPs observed on the interface that aren't recorded on it yet.
        for ip in o.get("ip_addresses", []):
            if not _real_ip(ip) or not _ip_attachable(ip_rows, device, existing, ip):
                continue
            # A prefix only has to exist when the address is new; binding a row
            # that already exists needs nothing.
            has_pfx = ip in ip_rows or _has_prefix(ip)
            items.append({
                "kind": "ip_missing", "interface_id": str(existing.id),
                "name": existing.name, "ip": ip, "observed": ip,
                # The UI offers "Add prefix" when there's nowhere to put it.
                "has_prefix": has_pfx,
                "suggested_prefix": "" if has_pfx else _suggested_prefix(ip),
            })

    # 2c. Bundle membership: which aggregate each port belongs to.
    items.extend(_lag_membership_items(device, observed, int_by_name))

    # 3. Stale: Danbyte has it, the device doesn't report it. Report only -
    #    discovery never deletes from the SoT.
    for name, i in int_by_name.items():
        if i.snmp_ignore:
            continue
        if i.id not in matched_ids:
            items.append({
                "kind": "interface_stale", "interface_id": str(i.id), "name": i.name,
            })

    # 3b. Hardware parts. Sensor and BMC readings are observed data like any
    #     other, so a health value that disagrees with the status a human set is
    #     a difference to review - not a write. (A sensor in `auto` mode has
    #     already written, so its intent matches and nothing appears here.)
    items.extend(_part_drift(device, tenant, state))

    # 4. Switch-link suggestions - join this device's ARP (IP↔MAC) with its FDB
    #    (MAC↔switch port) to propose which access port each already-known IP
    #    sits behind. Only fires on bridging devices (empty fdb → nothing) and
    #    only for IPs Danbyte already tracks (SoT: suggest, never invent).
    arp = state.arp or []
    fdb = state.fdb or []
    # ARP source mode (issues #22, #39): on pure-L2 networks a switch's own
    # ARP table only knows its management peers; the IP↔MAC truth lives on the
    # gateway - or on several, where more than one firewall routes. When the
    # tenant names source devices, their merged tables feed every switch's
    # suggestions instead. Merge order is device name, first answer per MAC
    # wins, so two gateways disagreeing about an address is deterministic.
    src_ids = list(
        MonitoringSettings.objects.filter(tenant=tenant)
        .values_list("arp_source_devices__id", flat=True)
    )
    src_ids = [i for i in src_ids if i]
    if src_ids:
        merged: list[dict] = []
        seen_macs: set[str] = set()
        for src_state in (
            DeviceSnmp.objects.filter(tenant=tenant, device_id__in=src_ids)
            .select_related("device")
            .order_by("device__name")
        ):
            for entry in src_state.arp or []:
                m = _norm_mac(entry.get("mac", ""))
                if m and m not in seen_macs:
                    seen_macs.add(m)
                    merged.append(entry)
        arp = merged
    if arp and fdb:
        mac_to_ip: dict[str, str] = {}
        for a in arp:
            m = _norm_mac(a.get("mac", ""))
            if m and a.get("ip"):
                mac_to_ip.setdefault(m, a["ip"])
        ifindex_to_name = {
            str(o.get("if_index")): o.get("name")
            for o in observed if o.get("if_index")
        }
        ip_to_ifindex: dict[str, str] = {}
        for f in fdb:
            m = _norm_mac(f.get("mac", ""))
            idx = str(f.get("if_index") or "")
            ip = mac_to_ip.get(m)
            if ip and idx:
                ip_to_ifindex.setdefault(ip, idx)
        if ip_to_ifindex:
            # Uplink guard (issue #22): trunk/aggregate ports learn every MAC
            # behind them, so suggesting attachment there claims hosts that
            # really hang off another switch - and each polled switch then
            # re-claims them, a tug of war. Skip ports that look like
            # infrastructure rather than host access:
            #   - the port learns more MACs than an access port plausibly
            #     carries (phone + PC + a hypervisor still fits the limit),
            #   - the port is a LAG aggregate or a LAG member,
            #   - LLDP shows another bridging device (a switch whose FDB we
            #     have) on the far end.
            macs_on_port: dict[str, set[str]] = {}
            for f in fdb:
                m = _norm_mac(f.get("mac", ""))
                fidx = str(f.get("if_index") or "")
                if m and fidx:
                    macs_on_port.setdefault(fidx, set()).add(m)
            lag_iface_ids: set = set()
            for member_id, lag_id in Interface.objects.filter(
                device=device, lag__isnull=False
            ).values_list("id", "lag_id"):
                lag_iface_ids.add(member_id)
                lag_iface_ids.add(lag_id)
            neighbor_names = {
                (n.get("remote_device") or "").strip()
                for n in (state.neighbors or [])
            }
            neighbor_names.discard("")
            bridging_neighbors = set(
                DeviceSnmp.objects.filter(
                    tenant=tenant, device__name__in=neighbor_names
                )
                .exclude(fdb=[])
                .values_list("device__name", flat=True)
            )
            switch_facing_ports = {
                _norm(n.get("local_port") or "")
                for n in (state.neighbors or [])
                if (n.get("remote_device") or "").strip() in bridging_neighbors
            }

            rows = {
                r.ip_address: r
                for r in IPAddress.objects.filter(
                    tenant=tenant, ip_address__in=list(ip_to_ifindex)
                ).select_related("switch", "switch_interface")
            }
            for ip, idx in ip_to_ifindex.items():
                row = rows.get(ip)
                if row is None:
                    continue
                iface = int_by_name.get(_norm(ifindex_to_name.get(idx) or ""))
                if iface is None:
                    continue
                if iface.is_uplink or iface.snmp_ignore:
                    continue  # operator said so - beats every heuristic
                if len(macs_on_port.get(idx, ())) > UPLINK_MAC_LIMIT:
                    continue
                if iface.id in lag_iface_ids:
                    continue
                if _norm(iface.name) in switch_facing_ports:
                    continue
                if row.switch_id == device.id and row.switch_interface_id == iface.id:
                    continue  # already linked to this exact port
                cur = (
                    f"{row.switch.name} · {row.switch_interface.name}"
                    if row.switch_id and row.switch_interface_id else "-"
                )
                items.append({
                    "kind": "switch_link_suggested",
                    "ip_id": str(row.id), "ip": ip,
                    "interface_id": str(iface.id), "name": iface.name,
                    "intended": cur,
                    "observed": f"{device.name} · {iface.name}",
                })

    return items


def apply_drift_action(device, tenant, action: dict) -> bool:
    """Apply one accepted drift item to intent. Returns True on success."""
    kind = action.get("kind")

    if kind == "device_field" and action.get("field") == "name":
        observed = action.get("observed")
        if observed:
            device.name = observed
            device.save(update_fields=["name"])
            return True
        return False

    if kind == "interface_missing":
        observed = action.get("observed") or {}
        try:
            iface = Interface.objects.create(
                device=device,
                name=action.get("name", "")[:64],
                type=_OBSERVED_TYPE.get(str(observed.get("type_name") or ""), ""),
                mac_address=(observed.get("mac") or "")[:17],
                enabled=(
                    observed.get("admin_status") != "down"
                    and not _is_not_present(observed)
                ),
                status=(
                    _not_present_status(tenant)
                    if _is_not_present(observed)
                    else None
                ),
            )
        except IntegrityError:
            # Already created (double-accept) or collides with an existing
            # (device, name) row - nothing to apply, report a clean failure.
            return False
        if iface.mac_address:
            _ensure_mac_object(tenant, iface, iface.mac_address)
        return True

    if kind == "interface_mismatch":
        iface = Interface.objects.filter(
            pk=action.get("interface_id"), device=device
        ).first()
        if iface is None:
            return False
        field = action.get("field")
        if field == "mac_address":
            iface.mac_address = (action.get("observed") or "")[:17]
            iface.save(update_fields=["mac_address"])
            _ensure_mac_object(tenant, iface, iface.mac_address)
            return True
        if field == "enabled":
            iface.enabled = bool(action.get("observed"))
            iface.save(update_fields=["enabled"])
            return True
        if field == "speed":
            iface.speed = str(action.get("observed") or "")[:32]
            iface.save(update_fields=["speed"])
            return True
        if field == "vlan":
            vlan = _resolve_observed_vlan(tenant, {"vlan": action.get("observed")})
            if vlan is None:
                return False
            iface.vlan = vlan
            iface.save(update_fields=["vlan"])
            return True

    if kind == "ip_missing":
        iface = Interface.objects.filter(
            pk=action.get("interface_id"), device=device
        ).first()
        ip = action.get("ip") or action.get("observed")
        if iface is None or not ip:
            return False
        # "skipped" → already assigned elsewhere, or no containing prefix exists
        # (add the prefix first). assigned/created both succeed.
        return _attach_observed_ip(tenant, iface, ip) != "skipped"

    if kind in ("part_status", "part_missing"):
        from api.models import InventoryItem
        from api.status_registry import resolve_status

        status = resolve_status(tenant, action.get("observed") or "", "inventoryitem")
        if status is None:
            return False
        if kind == "part_status":
            part = InventoryItem.objects.filter(
                pk=action.get("part_id"), device=device
            ).first()
            if part is None:
                return False
            part.status = status
            part.save(update_fields=["status", "updated_at"])
            return True
        name = (action.get("name") or "").strip()[:128]
        if not name:
            return False
        try:
            InventoryItem.objects.create(
                device=device, name=name,
                kind=action.get("part_kind") or "other", status=status,
            )
        except IntegrityError:
            return False  # double-accept, or the name is taken
        return True

    if kind == "switch_link_suggested":
        row = IPAddress.objects.filter(tenant=tenant, pk=action.get("ip_id")).first()
        iface = Interface.objects.filter(
            pk=action.get("interface_id"), device=device
        ).first()
        if row is None or iface is None:
            return False
        row.switch = device
        row.switch_interface = iface
        row.save(update_fields=["switch", "switch_interface", "updated_at"])
        return True

    if kind == "lag_membership":
        iface = Interface.objects.filter(
            pk=action.get("interface_id"), device=device
        ).first()
        if iface is None:
            return False
        if (action.get("observed") or "-") == "-":
            iface.lag = None
            iface.save(update_fields=["lag"])
            return True
        agg = (
            Interface.objects.filter(
                pk=action.get("lag_interface_id"), device__tenant=tenant
            )
            .select_related("device")
            .first()
        )
        if agg is None or agg.pk == iface.pk:
            return False
        same_stack = agg.device_id == device.id or (
            device.virtual_chassis_id is not None
            and agg.device.virtual_chassis_id == device.virtual_chassis_id
        )
        if not same_stack:
            return False
        # An aggregate created before types were enforced is promoted; one the
        # operator typed as physical media is theirs to fix.
        if agg.type in ("", "virtual"):
            agg.type = "lag"
            agg.save(update_fields=["type", "virtual"])
        elif agg.type != "lag":
            return False
        iface.lag = agg
        iface.save(update_fields=["lag"])
        return True

    return False


def sync_device_from_snmp(device, tenant) -> dict:
    """One-shot "Sync from SNMP": create any observed interfaces Danbyte lacks,
    fix MAC/admin-status drift on the ones it has, and assign observed IPs (when
    a containing prefix exists). Leaves the device name alone. Returns a summary.
    """
    summary = {"interfaces_created": 0, "interfaces_updated": 0, "lag_memberships": 0,
               "ips_assigned": 0, "ips_skipped": 0, "vlans_assigned": 0,
               "switch_links": 0}
    state = DeviceSnmp.objects.filter(device=device, tenant=tenant).first()
    if state is None or not state.polled_at:
        return summary

    # The same observed-name map drift uses, so SNMP links hold here too -
    # with a label-only map, a linked port's observed row didn't match and
    # sync created a duplicate interface under the discovered name, hanging
    # the speed/VLAN/IPs on the duplicate instead of the port it means.
    existing = _intent_by_observed_name(Interface.objects.filter(device=device))
    ip_rows = _observed_ip_rows(tenant, state.interfaces or [])
    skip_absent = _skip_not_present(tenant)
    policy = _snmp_policy(tenant)
    fdb_macs = _fdb_single_macs(state) if policy["snmp_mac_from_fdb"] else None
    for o in (state.interfaces or []):
        name = o.get("name")
        # Pre-allocated stack ports: not real hardware, not intent.
        if skip_absent and _is_not_present(o):
            summary["interfaces_skipped_not_present"] = (
                summary.get("interfaces_skipped_not_present", 0) + 1
            )
            continue
        if not name:
            continue
        # L2 VLAN pseudo-interfaces: VLANs, not ports (policy, see drift).
        if policy["snmp_skip_unrouted_vlans"] and _is_unrouted_vlan(o):
            continue
        speed = _fmt_speed(o.get("speed_mbps"))
        vlan = _resolve_observed_vlan(tenant, o)
        # Match on ifName then ifDescr (see _match_observed): a library-built
        # switch stores the FULL name (GigabitEthernet1/0/1) that SNMP reports
        # as ifDescr, so name-only matching would create a duplicate short-named
        # port instead of updating the real one.
        iface = _match_observed(o, existing)
        # Excluded from drift ⇒ excluded from sync: sync is "accept all
        # drift", and an ignored port produces none.
        if iface is not None and iface.snmp_ignore:
            continue
        if iface is None:
            # Update-only fleets never create ports from SNMP.
            if policy["snmp_update_only"]:
                continue
            try:
                created_mac = (
                    fdb_macs.get(str(o.get("if_index") or ""))
                    if fdb_macs is not None
                    else o.get("mac")
                )
                iface = Interface.objects.create(
                    device=device, name=name[:64],
                    mac_address=(created_mac or "")[:17],
                    # A notPresent port only reaches here when the
                    # tenant opted in. It's a slot with no hardware: it lands
                    # disabled AND carries the Not present status (#97, #105).
                    enabled=(
                        o.get("admin_status") != "down"
                        and not _is_not_present(o)
                    ),
                    status=(
                        _not_present_status(tenant)
                        if _is_not_present(o)
                        else None
                    ),
                    speed=speed, vlan=vlan,
                    type=_OBSERVED_TYPE.get(str(o.get("type_name") or ""), ""),
                )
            except IntegrityError:
                iface = Interface.objects.filter(device=device, name=name[:64]).first()
                if iface is None:
                    continue
            else:
                summary["interfaces_created"] += 1
                if vlan is not None:
                    summary["vlans_assigned"] += 1
                existing[_norm(name)] = iface
        else:
            changed = []
            if fdb_macs is None:
                obs_mac = o.get("mac")
            else:
                obs_mac = fdb_macs.get(str(o.get("if_index") or ""))
            if obs_mac and _norm_mac(obs_mac) != _norm_mac(iface.mac_address):
                iface.mac_address = obs_mac[:17]
                changed.append("mac_address")
            if o.get("admin_status") in ("up", "down"):
                en = o["admin_status"] == "up"
                if en != iface.enabled:
                    iface.enabled = en
                    changed.append("enabled")
            if speed and speed != iface.speed:
                iface.speed = speed
                changed.append("speed")
            if vlan is not None and iface.vlan_id != vlan.id:
                iface.vlan = vlan
                changed.append("vlan")
                summary["vlans_assigned"] += 1
            if changed:
                iface.save(update_fields=changed)
                summary["interfaces_updated"] += 1

        # A MAC we recorded → a first-class MACAddress object.
        if iface.mac_address:
            _ensure_mac_object(tenant, iface, iface.mac_address)

        for ip in o.get("ip_addresses", []):
            if not _real_ip(ip) or not _ip_attachable(ip_rows, device, iface, ip):
                continue
            result = _attach_observed_ip(tenant, iface, ip)
            if result == "skipped":
                summary["ips_skipped"] += 1
            else:
                summary["ips_assigned"] += 1
                # Re-read so a second observed row for the same address sees it
                # as settled rather than attaching it twice.
                ip_rows[ip] = IPAddress.objects.get(tenant=tenant, ip_address=ip)

    # Relationship-shaped drift, applied after the interface pass so a just-
    # created aggregate is there to join: switch links (IP ↔ this switch's
    # port) and bundle membership.
    for item in compute_device_drift(device, tenant, state=state):
        kind = item.get("kind")
        if kind == "switch_link_suggested" and apply_drift_action(device, tenant, item):
            summary["switch_links"] += 1
        elif kind == "lag_membership" and apply_drift_action(device, tenant, item):
            summary["lag_memberships"] += 1
    return summary


def _ensure_mac_object(tenant, iface, mac: str) -> None:
    """Make sure a first-class MACAddress object exists for a MAC we've recorded
    on an interface, so discovered MACs become real, clickable objects."""
    mac = (mac or "").strip().lower()
    if not mac:
        return
    MACAddress.objects.get_or_create(
        tenant=tenant, mac_address=mac, assigned_interface=iface
    )


def _resolve_observed_vlan(tenant, o: dict):
    """Find-or-create the access VLAN an observed interface reports (Q-BRIDGE
    PVID), or ``None`` when it reports no usable VLAN. Ungrouped, tenant-scoped -
    so a switch's VLANs become first-class Danbyte VLAN objects on sync."""
    try:
        vid = int(o.get("vlan"))
    except (ValueError, TypeError):
        return None
    if not (1 <= vid <= 4094):
        return None
    vlan = VLAN.objects.filter(tenant=tenant, vlan_id=vid, group__isnull=True).first()
    if vlan is None:
        # Grouped VLANs count too (site-scoped groups are the norm on larger
        # estates) - same resolution order as virt sync's match_existing_vlans:
        # ungrouped first, then by group name, virt-sync groups excluded.
        vlan = (
            VLAN.objects.filter(tenant=tenant, vlan_id=vid)
            .exclude(group__slug__startswith="virt-")
            .order_by("group__name")
            .first()
        )
    if vlan is None:
        vlan = VLAN.objects.create(
            tenant=tenant, vlan_id=vid,
            name=(o.get("vlan_name") or f"VLAN {vid}")[:255],
        )
    return vlan


def _attach_observed_ip(tenant, iface, ip: str) -> str:
    """Record an SNMP-observed interface IP in Danbyte → ``"assigned"`` (an
    existing unassigned IP bound to this interface), ``"created"`` (a new IP), or
    ``"skipped"`` (already assigned elsewhere, or no containing prefix exists)."""
    existing = IPAddress.objects.filter(tenant=tenant, ip_address=ip).first()
    if existing is not None:
        if existing.assigned_interface_id or (
            existing.assigned_device_id
            and existing.assigned_device_id != iface.device_id
        ):
            # Another port's, or another device's - don't steal it. An address
            # already on THIS device with no port falls through: that's the OOB
            # address, and the port SNMP names for it is the missing half.
            return "skipped"
        existing.assigned_interface = iface
        # save() mirrors assigned_device from the interface; include it so the
        # scoped write actually persists the device link too.
        existing.save(update_fields=["assigned_interface", "assigned_device"])
        return "assigned"
    # Scope the prefix search to the interface's VRF when it has one, so the IP
    # lands in the right routing context. Without one, the tenant's default
    # SNMP VRF policy (device → role → type → site → tenant) narrows the
    # search; no policy keeps the any-VRF tie-break.
    if iface.vrf_id:
        vrf = iface.vrf
    else:
        from .snmp_resolve import resolve_snmp_vrf

        vrf = resolve_snmp_vrf(iface.device, tenant) or _ANY_VRF
    prefix = _containing_prefix(tenant, ip, vrf)
    if prefix is None:
        return "skipped"
    try:
        IPAddress.objects.create(
            tenant=tenant, prefix=prefix, ip_address=ip,
            assigned_interface=iface, description="Discovered via SNMP.",
        )
    except IntegrityError:
        return "skipped"
    return "created"


# Prefix placement is shared with the sync engines - see api.vrf_placement.
# These aliases keep this module's call sites reading the same as before.
_ANY_VRF = ANY_VRF
_containing_prefix = containing_prefix
