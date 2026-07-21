"""Reconciliation: compare *observed* SNMP state to the device's *intended*
source-of-truth and surface the differences (drift), then apply an accepted
difference back to intent (#84, Phase 3).

Discovery never mutates the SoT on its own — ``compute_device_drift`` is
read-only; only an explicit ``apply_drift_action`` (an operator clicking
"Accept") writes a Device/Interface field. That's what keeps Danbyte the source
of truth while still letting reality flow in on demand.
"""
from __future__ import annotations

import re

import ipaddress as ipmod

from django.db import IntegrityError

from api.models import Interface, IPAddress, MACAddress, Prefix, VLAN

from .models import DeviceSnmp


def _real_ip(ip: str) -> bool:
    """Whether an observed IP is worth importing. Skips the addresses SNMP will
    inevitably report but that don't belong in IPAM — IPv4/IPv6 loopback
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
    """A sensible prefix to create for an observed IP that has none — the host's
    natural /24 (v4) or /64 (v6) — so the UI can pre-fill "Add prefix"."""
    try:
        addr = ipmod.ip_address(ip)
    except ValueError:
        return ""
    plen = 24 if addr.version == 4 else 64
    return str(ipmod.ip_network(f"{ip}/{plen}", strict=False))


def _fmt_speed(mbps) -> str:
    """SNMP ifHighSpeed (Mbps) → a human string for Interface.speed, matching the
    observed card ("10 Gbps" / "100 Mbps"). Blank when unknown."""
    try:
        n = int(mbps)
    except (ValueError, TypeError):
        return ""
    if n <= 0:
        return ""
    if n >= 1000 and n % 1000 == 0:
        return f"{n // 1000} Gbps"
    return f"{n} Mbps"


def _norm(value) -> str:
    return (value or "").strip().lower()


def _norm_mac(value) -> str:
    """Compare MACs by their hex digits only, so colon/dash/Cisco-dotted forms
    of the same address (``00:11:22:33:44:55`` vs ``0011.2233.4455``) don't read
    as drift — which would otherwise churn the SoT on every accept."""
    return re.sub(r"[^0-9a-f]", "", (value or "").lower())


def compute_device_drift(device, tenant, state=None, intended_interfaces=None) -> list[dict]:
    """Read-only list of differences between observed SNMP state and intent.

    ``state`` (the device's ``DeviceSnmp`` row) and ``intended_interfaces`` (its
    ``Interface`` rows) may be passed pre-fetched — the fleet-wide drift list does
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
    obs_by_name = {_norm(o["name"]): o for o in observed}
    intended = (
        list(intended_interfaces) if intended_interfaces is not None
        else list(Interface.objects.filter(device=device).select_related("vlan"))
    )
    int_by_name = {_norm(i.name): i for i in intended}
    # IPs Danbyte already records on this device, to spot ones SNMP sees but we
    # don't have yet (the "accept discovered IP" loop).
    device_ips = set(
        IPAddress.objects.filter(tenant=tenant, assigned_device=device)
        .values_list("ip_address", flat=True)
    )
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

    for name, o in obs_by_name.items():
        existing = int_by_name.get(name)
        if existing is None:
            items.append({
                "kind": "interface_missing",
                "name": o["name"], "if_index": o.get("if_index", ""),
                "observed": {
                    "mac": o.get("mac", ""),
                    "admin_status": o.get("admin_status", ""),
                },
            })
            continue
        # MAC mismatch (separator-insensitive — see _norm_mac).
        if o.get("mac") and _norm_mac(o["mac"]) != _norm_mac(existing.mac_address):
            items.append({
                "kind": "interface_mismatch", "interface_id": str(existing.id),
                "name": existing.name, "field": "mac_address",
                "intended": existing.mac_address, "observed": o["mac"],
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
        # Access-VLAN (PVID) mismatch — observed from Q-BRIDGE-MIB.
        if o.get("vlan"):
            intended_vid = str(existing.vlan.vlan_id) if existing.vlan_id else ""
            if str(o["vlan"]) != intended_vid:
                items.append({
                    "kind": "interface_mismatch", "interface_id": str(existing.id),
                    "name": existing.name, "field": "vlan",
                    "intended": intended_vid or "—", "observed": str(o["vlan"]),
                })
        # IPs observed on the interface that Danbyte doesn't record yet.
        for ip in o.get("ip_addresses", []):
            if _real_ip(ip) and ip not in device_ips:
                has_pfx = _has_prefix(ip)
                items.append({
                    "kind": "ip_missing", "interface_id": str(existing.id),
                    "name": existing.name, "ip": ip, "observed": ip,
                    # The UI offers "Add prefix" when there's nowhere to put it.
                    "has_prefix": has_pfx,
                    "suggested_prefix": "" if has_pfx else _suggested_prefix(ip),
                })

    # 3. Stale: Danbyte has it, the device doesn't report it. Report only —
    #    discovery never deletes from the SoT.
    for name, i in int_by_name.items():
        if name not in obs_by_name:
            items.append({
                "kind": "interface_stale", "interface_id": str(i.id), "name": i.name,
            })

    # 4. Switch-link suggestions — join this device's ARP (IP↔MAC) with its FDB
    #    (MAC↔switch port) to propose which access port each already-known IP
    #    sits behind. Only fires on bridging devices (empty fdb → nothing) and
    #    only for IPs Danbyte already tracks (SoT: suggest, never invent).
    arp = state.arp or []
    fdb = state.fdb or []
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
                if row.switch_id == device.id and row.switch_interface_id == iface.id:
                    continue  # already linked to this exact port
                cur = (
                    f"{row.switch.name} · {row.switch_interface.name}"
                    if row.switch_id and row.switch_interface_id else "—"
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
                mac_address=(observed.get("mac") or "")[:17],
                enabled=observed.get("admin_status") != "down",
            )
        except IntegrityError:
            # Already created (double-accept) or collides with an existing
            # (device, name) row — nothing to apply, report a clean failure.
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

    return False


def sync_device_from_snmp(device, tenant) -> dict:
    """One-shot "Sync from SNMP": create any observed interfaces Danbyte lacks,
    fix MAC/admin-status drift on the ones it has, and assign observed IPs (when
    a containing prefix exists). Leaves the device name alone. Returns a summary.
    """
    summary = {"interfaces_created": 0, "interfaces_updated": 0,
               "ips_assigned": 0, "ips_skipped": 0, "vlans_assigned": 0,
               "switch_links": 0}
    state = DeviceSnmp.objects.filter(device=device, tenant=tenant).first()
    if state is None or not state.polled_at:
        return summary

    existing = {_norm(i.name): i for i in Interface.objects.filter(device=device)}
    device_ips = set(
        IPAddress.objects.filter(tenant=tenant, assigned_device=device)
        .values_list("ip_address", flat=True)
    )
    for o in (state.interfaces or []):
        name = o.get("name")
        if not name:
            continue
        speed = _fmt_speed(o.get("speed_mbps"))
        vlan = _resolve_observed_vlan(tenant, o)
        iface = existing.get(_norm(name))
        if iface is None:
            try:
                iface = Interface.objects.create(
                    device=device, name=name[:64],
                    mac_address=(o.get("mac") or "")[:17],
                    enabled=o.get("admin_status") != "down",
                    speed=speed, vlan=vlan,
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
            if o.get("mac") and _norm_mac(o["mac"]) != _norm_mac(iface.mac_address):
                iface.mac_address = o["mac"][:17]
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
            if not _real_ip(ip) or ip in device_ips:
                continue
            result = _attach_observed_ip(tenant, iface, ip)
            if result == "skipped":
                summary["ips_skipped"] += 1
            else:
                summary["ips_assigned"] += 1
                device_ips.add(ip)

    # Accept all switch-link suggestions (IP ↔ this switch's port).
    for item in compute_device_drift(device, tenant, state=state):
        if item.get("kind") == "switch_link_suggested" and apply_drift_action(
            device, tenant, item
        ):
            summary["switch_links"] += 1
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
    PVID), or ``None`` when it reports no usable VLAN. Ungrouped, tenant-scoped —
    so a switch's VLANs become first-class Danbyte VLAN objects on sync."""
    try:
        vid = int(o.get("vlan"))
    except (ValueError, TypeError):
        return None
    if not (1 <= vid <= 4094):
        return None
    vlan = VLAN.objects.filter(tenant=tenant, vlan_id=vid, group__isnull=True).first()
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
        if existing.assigned_interface_id or existing.assigned_device_id:
            return "skipped"  # already belongs to a device — don't steal it
        existing.assigned_interface = iface
        # save() mirrors assigned_device from the interface; include it so the
        # scoped write actually persists the device link too.
        existing.save(update_fields=["assigned_interface", "assigned_device"])
        return "assigned"
    # Scope the prefix search to the interface's VRF when it has one, so the IP
    # lands in the right routing context.
    vrf = iface.vrf if iface.vrf_id else _ANY_VRF
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


_ANY_VRF = object()


def _containing_prefix(tenant, ip: str, vrf=_ANY_VRF):
    """Smallest tenant prefix that contains ``ip`` (or ``None``). When ``vrf`` is
    given (an interface's VRF, possibly None = Global), the search is scoped to
    that VRF — so an IP lands in the prefix of the right routing context and
    overlapping IPs across VRFs don't collide."""
    import ipaddress as ipmod

    try:
        addr = ipmod.ip_address(ip)
    except ValueError:
        return None
    qs = Prefix.objects.filter(tenant=tenant)
    if vrf is not _ANY_VRF:
        qs = qs.filter(vrf=vrf)
    best = None
    best_len = -1
    for p in qs:
        try:
            net = ipmod.ip_network(p.cidr, strict=False)
        except ValueError:
            continue
        if addr in net and net.prefixlen > best_len:
            best, best_len = p, net.prefixlen
    return best
