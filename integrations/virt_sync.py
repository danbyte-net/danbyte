"""Proxmox VE sync engine (read-only, virtualization track).

One pass per source:

1. ``/cluster/status`` — cluster name + nodes.
2. ``/cluster/resources?type=vm`` — every guest (QEMU + LXC) with specs and
   power state.
3. Per guest, its config (``/nodes/<n>/qemu|lxc/<vmid>/config``) for NICs,
   and — for running QEMU guests — the guest agent's
   ``network-get-interfaces`` for live IPs.

Mapping: cluster → :class:`api.Cluster` (a "Proxmox VE" ClusterType is
created on demand — required structural data, editable); guest →
:class:`api.VirtualMachine`; NICs → :class:`api.VMInterface`; agent IPs →
:class:`api.IPAddress` assigned to the interface (only when a containing
Prefix exists — sync never invents address space).

Adoption rules mirror the DHCP/DNS engines: rows the operator already has are
adopted and blank-filled, never overwritten; only VMs the sync created are
removed again when their guest disappears.
"""
from __future__ import annotations

import ipaddress
import logging
import re

from django.db import transaction
from django.utils import timezone

from .virt_client import VirtAPIError, proxmox_get

logger = logging.getLogger("danbyte.virt_sync")

_MAC_RE = re.compile(r"\b([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})\b")
_NET_KEY = re.compile(r"^net(\d+)$")


def _parse_net(value: str) -> dict:
    """Parse a Proxmox netX config value into {mac, name}.

    QEMU: ``virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=10``
    LXC:  ``name=eth0,bridge=vmbr0,hwaddr=AA:…,ip=dhcp``
    """
    out = {"mac": "", "name": ""}
    m = _MAC_RE.search(value or "")
    if m:
        out["mac"] = m.group(1).lower()
    for part in (value or "").split(","):
        k, _, v = part.partition("=")
        if k.strip() == "name":
            out["name"] = v.strip()
    return out


def sync_proxmox(source) -> dict:
    from .models import VirtGuest

    status = proxmox_get(source, "cluster/status") or []
    cluster_name = next(
        (s.get("name") for s in status if s.get("type") == "cluster"),
        source.name,
    )
    nodes = [s.get("name") for s in status if s.get("type") == "node"]
    resources = [
        r for r in (proxmox_get(source, "cluster/resources?type=vm") or [])
        if r.get("template") not in (1, True)  # VM templates aren't inventory
    ]

    now = timezone.now()
    counts = {"nodes": len(nodes), "vms": 0, "vms_created": 0,
              "interfaces": 0, "ips": 0}

    # Guest details come over the network — fetch before the DB transaction.
    details = {}
    for r in resources:
        vmid, node = r.get("vmid"), r.get("node")
        kind = "lxc" if r.get("type") == "lxc" else "qemu"
        try:
            cfg = proxmox_get(source, f"nodes/{node}/{kind}/{vmid}/config") or {}
        except VirtAPIError as exc:
            logger.warning("config fetch %s/%s failed: %s", node, vmid, exc)
            cfg = {}
        agent_ifaces = []
        if kind == "qemu" and r.get("status") == "running":
            try:
                agent = proxmox_get(
                    source, f"nodes/{node}/qemu/{vmid}/agent/network-get-interfaces"
                )
                agent_ifaces = (agent or {}).get("result", [])
            except VirtAPIError:
                pass  # agent not installed/running — IPs just stay unknown
        details[vmid] = (cfg, agent_ifaces)

    with transaction.atomic():
        cluster = _cluster_for(source, cluster_name)
        seen = set()
        for r in resources:
            vmid = r.get("vmid")
            if vmid is None:
                continue
            seen.add(vmid)
            counts["vms"] += 1
            kind = "lxc" if r.get("type") == "lxc" else "qemu"
            guest, _ = VirtGuest.objects.get_or_create(
                source=source, vmid=vmid, defaults={"kind": kind}
            )
            guest.kind = kind
            guest.node = r.get("node") or ""
            guest.power_state = r.get("status") or ""
            guest.last_seen_at = now
            created = _attach_vm(source, cluster, guest, r)
            if created:
                counts["vms_created"] += 1
            cfg, agent_ifaces = details.get(vmid, ({}, []))
            counts["interfaces"] += _sync_interfaces(guest, cfg)
            counts["ips"] += _sync_ips(source, guest, agent_ifaces)
            guest.save()

        # Guests gone from the hypervisor: drop the link; delete the VM only
        # if this sync created it (operator inventory is never sync-deleted).
        for gone in VirtGuest.objects.filter(source=source).exclude(vmid__in=seen):
            if gone.created_vm and gone.vm_id:
                gone.vm.delete()
            gone.delete()

    source.last_sync_at = now
    source.last_sync_status = "ok"
    source.last_sync_error = ""
    source.save(update_fields=["last_sync_at", "last_sync_status",
                               "last_sync_error"])
    logger.info("proxmox sync %s: %s", source.name, counts)
    return counts


def _cluster_for(source, name: str):
    from api.models import Cluster, ClusterType

    existing = Cluster.objects.filter(tenant=source.tenant, name=name).first()
    if existing:
        return existing
    ctype = ClusterType.objects.filter(
        tenant=source.tenant, name__iexact="Proxmox VE"
    ).first()
    if ctype is None:
        ctype = ClusterType.objects.create(
            tenant=source.tenant, name="Proxmox VE", slug="proxmox-ve"
        )
    return Cluster.objects.create(
        tenant=source.tenant, name=name, type=ctype,
        description=f"Synced from «{source.name}»",
    )


def _attach_vm(source, cluster, guest, resource) -> bool:
    """Link (or create) the VirtualMachine for a guest. Returns created."""
    from api.models import Device, VirtualMachine

    name = resource.get("name") or f"vm-{guest.vmid}"
    vm = guest.vm
    created = False
    if vm is None:
        vm = VirtualMachine.objects.filter(
            tenant=source.tenant, name=name
        ).first()
        if vm is None:
            vm = VirtualMachine.objects.create(
                tenant=source.tenant, name=name, cluster=cluster,
                description=f"Synced from «{source.name}»",
            )
            created = True
            guest.created_vm = True
        guest.vm = vm

    # Specs: sync-created rows track the hypervisor; adopted rows blank-fill.
    own = guest.created_vm
    maxmem = resource.get("maxmem") or 0
    maxdisk = resource.get("maxdisk") or 0
    updates = {
        "vcpus": int(resource.get("maxcpu") or 0) or None,
        "memory_mb": int(maxmem / 1024 / 1024) or None,
        "disk_gb": int(maxdisk / 1024 / 1024 / 1024) or None,
    }
    changed = []
    for field, value in updates.items():
        if value is None:
            continue
        if own or getattr(vm, field) in (None, 0):
            if getattr(vm, field) != value:
                setattr(vm, field, value)
                changed.append(field)
    if vm.cluster_id != cluster.id and own:
        vm.cluster = cluster
        changed.append("cluster")
    # The node it runs on, when a Device of that name exists (blank-fill).
    if guest.node and vm.device_id is None:
        host = Device.objects.filter(
            tenant=source.tenant, name__iexact=guest.node
        ).first()
        if host is not None:
            vm.device = host
            changed.append("device")
    if changed:
        vm.save(update_fields=changed)
    return created


def _sync_interfaces(guest, cfg: dict) -> int:
    from api.models import VMInterface

    if guest.vm is None:
        return 0
    n = 0
    for key, value in (cfg or {}).items():
        if not _NET_KEY.match(str(key)):
            continue
        parsed = _parse_net(str(value))
        name = parsed["name"] or key  # LXC names its NIC; QEMU keeps netX
        iface = VMInterface.objects.filter(vm=guest.vm, name=name).first()
        if iface is None:
            iface = VMInterface.objects.create(
                vm=guest.vm, name=name, mac_address=parsed["mac"]
            )
        elif parsed["mac"] and not iface.mac_address:
            iface.mac_address = parsed["mac"]
            iface.save(update_fields=["mac_address"])
        n += 1
    return n


def _sync_ips(source, guest, agent_ifaces: list) -> int:
    """Attach guest-agent IPs to the VM's interfaces (matched by MAC)."""
    from api.models import IPAddress, Prefix, VMInterface

    if guest.vm is None or not agent_ifaces:
        return 0
    prefixes = []
    for p in Prefix.objects.filter(tenant=source.tenant, vrf__isnull=True):
        try:
            prefixes.append((ipaddress.ip_network(p.cidr, strict=False), p))
        except ValueError:
            continue

    def containing_prefix(addr):
        best = None
        for net, p in prefixes:
            if addr in net and (best is None or net.prefixlen > best[0].prefixlen):
                best = (net, p)
        return best[1] if best else None

    by_mac = {
        (i.mac_address or "").lower(): i
        for i in VMInterface.objects.filter(vm=guest.vm)
        if i.mac_address
    }
    n = 0
    first_v4 = None
    for entry in agent_ifaces:
        mac = (entry.get("hardware-address") or "").lower()
        iface = by_mac.get(mac)
        for ipinfo in entry.get("ip-addresses") or []:
            raw = ipinfo.get("ip-address") or ""
            try:
                addr = ipaddress.ip_address(raw)
            except ValueError:
                continue
            if addr.is_loopback or addr.is_link_local:
                continue
            row = IPAddress.objects.filter(
                tenant=source.tenant, vrf__isnull=True, ip_address=str(addr)
            ).first()
            if row is None:
                prefix = containing_prefix(addr)
                if prefix is None:
                    continue  # no containing prefix — never invent address space
                row = IPAddress.objects.create(
                    tenant=source.tenant, ip_address=str(addr), prefix=prefix,
                    description=f"Synced from «{source.name}»",
                )
            changed = []
            if row.assigned_vm_id is None and row.assigned_interface_id is None:
                row.assigned_vm = guest.vm
                changed.append("assigned_vm")
                if iface is not None and row.assigned_vm_interface_id is None:
                    row.assigned_vm_interface = iface
                    changed.append("assigned_vm_interface")
            if mac and not row.mac_address:
                row.mac_address = mac
                changed.append("mac_address")
            if changed:
                row.save(update_fields=changed)
            n += 1
            if first_v4 is None and addr.version == 4 and addr.is_private:
                first_v4 = row
    if first_v4 is not None and guest.vm.primary_ip_id is None:
        guest.vm.primary_ip = first_v4
        guest.vm.save(update_fields=["primary_ip"])
    return n


def record_virt_failure(source, exc: Exception) -> None:
    source.last_sync_at = timezone.now()
    source.last_sync_status = "failed"
    source.last_sync_error = str(exc)[:2000]
    source.save(update_fields=["last_sync_at", "last_sync_status",
                               "last_sync_error"])
