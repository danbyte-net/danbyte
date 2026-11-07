"""Proxmox SDN, read-only: zones and VNets into the inventory, and cables from
VNets.

A zone becomes a :class:`api.VirtualSwitch` of kind ``sdn-zone`` and each VNet
a :class:`integrations.VirtNetwork` under it, keyed by the VNet id (the same
key a NIC on that VNet used as a plain bridge, so an existing row is adopted).

Cables from VNets (opt-in on the source): a VNet with exactly two NICs on this
source's VMs becomes a cable between the interfaces of the devices those VMs
are (``VirtualMachine.represents_device``). A NIC maps to a device interface
by MAC, then by name. Nothing is ever changed on a cable that is already
there; a VNet that does not fit (one NIC, three NICs, a NIC with no device
interface, a port cabled elsewhere) is reported as a finding.

Danbyte only reads SDN. No call here writes to the hypervisor.
"""
from __future__ import annotations

import logging

from .virt_client import VirtAPIError, proxmox_get

logger = logging.getLogger("danbyte.virt_sync")

#: Shown when the token cannot read SDN. The pass carries on without it.
SDN_SKIPPED = (
    "SDN skipped: {error} The API token needs SDN.Audit on /sdn to read "
    "zones and VNets."
)


def _norm_mac(value) -> str:
    return "".join(c for c in str(value or "").lower() if c.isalnum())


def _rows(value) -> list:
    return [r for r in (value or []) if isinstance(r, dict)] if isinstance(value, list) else []


def fetch_sdn(source, get=proxmox_get) -> tuple[dict, dict, str]:
    """``(zones, vnets, warning)`` - zones keyed by id with their type, VNets
    keyed by id with zone, tag and alias. Any API failure (no SDN.Audit, a
    release without SDN) returns empty maps and the warning; it never raises."""
    try:
        zone_rows = _rows(get(source, "cluster/sdn/zones"))
        vnet_rows = _rows(get(source, "cluster/sdn/vnets"))
    except VirtAPIError as exc:
        return {}, {}, SDN_SKIPPED.format(error=str(exc).rstrip(".") + ".")
    zones = {}
    for z in zone_rows:
        zid = str(z.get("zone") or "").strip()
        if zid:
            zones[zid] = {"type": str(z.get("type") or "")}
    vnets = {}
    for v in vnet_rows:
        vid = str(v.get("vnet") or "").strip()
        if not vid:
            continue
        tag = v.get("tag")
        try:
            tag = int(tag) if tag not in (None, "") else None
        except (TypeError, ValueError):
            tag = None
        vnets[vid] = {
            "zone": str(v.get("zone") or "").strip(),
            "tag": tag,
            "alias": str(v.get("alias") or "").strip()[:255],
        }
    return zones, vnets, ""


class SdnState:
    """One pass's SDN view, with the rows it upserts cached per VNet."""

    def __init__(self, source, zones: dict, vnets: dict, now):
        self.source = source
        self.zones = zones
        self.vnets = vnets
        self.now = now
        self._networks: dict = {}

    def network(self, cluster, vnet_id: str):
        """The VirtNetwork for ``vnet_id`` under its zone's switch, created or
        refreshed once per pass."""
        if vnet_id in self._networks:
            return self._networks[vnet_id]
        from api.models import VirtualSwitch

        from .models import VirtNetwork

        info = self.vnets[vnet_id]
        zone = info["zone"] or "sdn"
        sw, made = VirtualSwitch.objects.get_or_create(
            tenant=self.source.tenant, cluster=cluster, name=zone,
            defaults={"kind": "sdn-zone", "created_switch": True},
        )
        if made:
            logger.info("created SDN zone %r on cluster %r", zone, cluster.name)
        elif sw.created_switch and sw.kind != "sdn-zone":
            sw.kind = "sdn-zone"
            sw.save(update_fields=["kind"])
        vn, made_net = VirtNetwork.objects.get_or_create(
            source=self.source, ext_key=vnet_id, defaults={"name": vnet_id},
        )
        if made_net:
            logger.info("created VNet %r in zone %r", vnet_id, zone)
        old_switch = vn.vswitch
        vn.sdn_zone = info["zone"][:8]
        vn.sdn_alias = info["alias"]
        vn.sdn_tag = info["tag"]
        vn.last_seen_at = self.now
        fields = ["sdn_zone", "sdn_alias", "sdn_tag", "last_seen_at"]
        # Move off the plain bridge switch the NIC pass made for it before
        # SDN was read - only a switch the sync made, never the operator's.
        if old_switch is None or (
            old_switch.id != sw.id and old_switch.created_switch
            and old_switch.kind != "sdn-zone"
        ):
            vn.vswitch = sw
            fields.append("vswitch")
        vn.save(update_fields=fields)
        if (
            old_switch is not None and old_switch.id != sw.id
            and old_switch.created_switch and old_switch.name == vnet_id
            and not old_switch.virt_networks.exists()
            and not old_switch.uplink_interfaces.exists()
            and old_switch.vrf_id is None
        ):
            logger.info("removed bridge switch %r now known as a VNet", vnet_id)
            old_switch.delete()
        self._networks[vnet_id] = vn
        return vn


def guest_nics(cfg: dict) -> list:
    """The NICs in a Proxmox guest config, as stored on ``VirtGuest.nics``."""
    from .virt_sync import _NET_KEY, _parse_net

    out = []
    for key, value in sorted((cfg or {}).items(), key=lambda kv: str(kv[0])):
        m = _NET_KEY.match(str(key))
        if not m:
            continue
        p = _parse_net(str(value))
        out.append({
            "key": str(key), "index": int(m.group(1)),
            "name": p["name"] or str(key), "mac": p["mac"],
            "bridge": p["bridge"], "tag": p["tag"],
        })
    out.sort(key=lambda n: n["index"])
    return out


def _iface_macs(iface) -> set:
    macs = {_norm_mac(iface.mac_address)} if iface.mac_address else set()
    macs |= {_norm_mac(m.mac_address) for m in iface.mac_addresses.all()}
    return macs - {""}


def device_interfaces(device) -> list:
    if device is None:
        return []
    return list(device.interfaces.prefetch_related("mac_addresses").all())


def interface_for_nic(ifaces: list, nic: dict):
    """The device interface a VM NIC is: same MAC, else same name."""
    mac = _norm_mac(nic.get("mac"))
    if mac:
        hits = [i for i in ifaces if mac in _iface_macs(i)]
        if len(hits) == 1:
            return hits[0]
    names = {str(nic.get("name") or "").lower(), str(nic.get("key") or "").lower()} - {""}
    hits = [i for i in ifaces if i.name.lower() in names]
    return hits[0] if len(hits) == 1 else None


def nic_for_interface(iface, nics: list, wanted: str = ""):
    """The VM NIC a device interface is: same MAC, else same name, else the
    one NIC already on ``wanted`` (a NIC that is right needs no mapping)."""
    macs = _iface_macs(iface)
    if macs:
        hits = [n for n in nics if _norm_mac(n.get("mac")) in macs]
        if len(hits) == 1:
            return hits[0]
    name = iface.name.lower()
    hits = [n for n in nics
            if name in (str(n.get("name") or "").lower(), str(n.get("key") or "").lower())]
    if len(hits) == 1:
        return hits[0]
    if wanted:
        hits = [n for n in nics if n.get("bridge") == wanted]
        if len(hits) == 1:
            return hits[0]
    return None


def _nic_label(guest, nic) -> str:
    return f"{guest.vm.name}/{nic.get('key')}"


def cables_from_vnets(source, vnets: dict, now, warnings: list, counts: dict) -> None:
    """Make a cable for each VNet with exactly two NICs; report the rest.

    Never changes or deletes a cable it did not make, and never changes one it
    did: a blank VNet on a cable that already joins the two ports is filled,
    and that is all."""
    from api.models import Cable, CableTermination, retire_port_placeholders

    from .models import VirtCableLink, VirtGuest

    guests = list(
        VirtGuest.objects.filter(source=source, vm__isnull=False)
        .select_related("vm", "vm__represents_device")
    )
    on_vnet: dict = {}
    for g in guests:
        for nic in g.nics or []:
            if nic.get("bridge") in vnets:
                on_vnet.setdefault(nic["bridge"], []).append((g, nic))
    made = matched = findings = 0

    def finding(text):
        nonlocal findings
        findings += 1
        warnings.append(text)

    for vnet in sorted(on_vnet):
        ends = on_vnet[vnet]
        if len(ends) != 2:
            finding(
                f"VNet {vnet} has {len(ends)} NIC{'' if len(ends) == 1 else 's'} "
                f"({', '.join(_nic_label(g, n) for g, n in ends)}) - a cable needs "
                f"exactly two; none made."
            )
            continue
        ports = []
        for g, nic in ends:
            dev = g.vm.represents_device
            if dev is None or dev.tenant_id != source.tenant_id:
                finding(f"VNet {vnet}: {g.vm.name} is not set as a device "
                        f"(Is router) - no cable made.")
                break
            iface = interface_for_nic(device_interfaces(dev), nic)
            if iface is None:
                finding(f"VNet {vnet}: no interface on {dev.name} matches "
                        f"{_nic_label(g, nic)} by MAC or name - no cable made.")
                break
            ports.append(iface)
        if len(ports) != 2:
            continue
        a, b = ports
        if a.id == b.id:
            finding(f"VNet {vnet}: both NICs map to {a.device.name} {a.name} - "
                    f"no cable made.")
            continue
        ta = CableTermination.objects.filter(interface=a).select_related("cable").first()
        tb = CableTermination.objects.filter(interface=b).select_related("cable").first()
        if ta and tb and ta.cable_id == tb.cable_id:
            cable = ta.cable
            if cable.terminations.count() != 2:
                finding(f"VNet {vnet}: {cable} joins more than these two ports - "
                        f"left as is.")
                continue
            if cable.pve_vnet and cable.pve_vnet != vnet:
                finding(f"VNet {vnet}: {cable} between {a.device.name} {a.name} "
                        f"and {b.device.name} {b.name} says VNet "
                        f"{cable.pve_vnet} - left as is.")
                continue
            if not cable.pve_vnet:
                cable.pve_vnet = vnet
                cable.save(update_fields=["pve_vnet", "updated_at"])
            VirtCableLink.objects.update_or_create(
                source=source, cable=cable,
                defaults={"vnet": vnet, "last_seen_at": now},
            )
            matched += 1
            continue
        if ta or tb:
            busy, term = (a, ta) if ta else (b, tb)
            finding(f"VNet {vnet}: {busy.device.name} {busy.name} is already on "
                    f"{term.cable} - left as is.")
            continue
        cable = Cable.objects.create(
            tenant=source.tenant, pve_vnet=vnet,
            description=f"Synced from «{source.name}» (VNet {vnet})",
        )
        rows = [
            CableTermination.objects.create(cable=cable, end="A", interface=a),
            CableTermination.objects.create(cable=cable, end="B", interface=b),
        ]
        retire_port_placeholders(rows)
        VirtCableLink.objects.create(
            source=source, cable=cable, vnet=vnet, created_cable=True,
            last_seen_at=now,
        )
        logger.info("created cable %s from VNet %s (%s %s - %s %s)", cable.numid,
                    vnet, a.device.name, a.name, b.device.name, b.name)
        made += 1

    for link in (
        VirtCableLink.objects.filter(source=source)
        .exclude(last_seen_at=now).select_related("cable")
    ):
        finding(f"{link.cable} came from VNet {link.vnet}, which no longer joins "
                f"its two ports - left as is.")
    counts["vnet_cables_created"] = made
    counts["vnet_cables_matched"] = matched
    counts["vnet_findings"] = findings
