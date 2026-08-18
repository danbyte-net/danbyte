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
from functools import partial

from django.db import transaction
from django.utils import timezone

from .virt_client import VirtAPIError, proxmox_get

logger = logging.getLogger("danbyte.virt_sync")

_MAC_RE = re.compile(r"\b([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})\b")
_NET_KEY = re.compile(r"^net(\d+)$")


def _parse_net(value: str) -> dict:
    """Parse a Proxmox netX config value into {mac, name, bridge, tag}.

    QEMU: ``virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=10``
    LXC:  ``name=eth0,bridge=vmbr0,hwaddr=AA:…,ip=dhcp``
    """
    out = {"mac": "", "name": "", "bridge": "", "tag": None}
    m = _MAC_RE.search(value or "")
    if m:
        out["mac"] = m.group(1).lower()
    for part in (value or "").split(","):
        k, _, v = part.partition("=")
        k, v = k.strip(), v.strip()
        if k == "name":
            out["name"] = v
        elif k == "bridge":
            out["bridge"] = v
        elif k == "tag" and v.isdigit():
            out["tag"] = int(v)
    return out


# Proxmox disk buses (skip cdrom/efidisk/tpmstate/cloudinit — not data disks).
_DISK_KEY = re.compile(r"^(scsi|virtio|sata|ide|nvme)(\d+)$")


def _disk_size_gb(value: str):
    """``…,size=32G`` / ``size=1024M`` / ``size=1T`` → whole GB (min 1)."""
    m = re.search(r"size=(\d+(?:\.\d+)?)([KMGT])", value or "")
    if not m:
        return None
    num = float(m.group(1))
    gb = num * {"K": 1 / 1024 / 1024, "M": 1 / 1024, "G": 1, "T": 1024}[m.group(2)]
    return int(gb) or (1 if gb > 0 else None)


def _sync_disks(guest, cfg: dict) -> int:
    """Proxmox VM config disks (scsiN/virtioN/…) → VirtualDisk rows.

    Sync-created rows track the hypervisor; adopted (operator) rows are only
    blank-filled. Only sync-created disks that vanish are pruned."""
    from api.models import VirtualDisk

    if guest.vm is None or not cfg:
        return 0
    seen, n = set(), 0
    for key, value in cfg.items():
        key = str(key)
        km = _DISK_KEY.match(key)
        if not km:
            continue
        val = str(value)
        head = val.split(",")[0]
        if "media=cdrom" in val or head in ("none", "") or head.endswith(".iso"):
            continue  # optical / empty bus, not a data disk
        storage = head.split(":")[0] if ":" in head else ""
        seen.add(key)
        n += 1
        _upsert_disk(guest.vm, key, name=key, size_gb=_disk_size_gb(val),
                     storage=storage, controller=km.group(1))
    VirtualDisk.objects.filter(
        vm=guest.vm, created_disk=True
    ).exclude(key__in=seen).delete()
    return n


def _upsert_disk(vm, key, *, name="", size_gb=None, storage="",
                 controller="", disk_format="") -> None:
    """Create or refresh one VirtualDisk. Sync-created rows track the
    hypervisor; adopted (operator) rows are only blank-filled."""
    from api.models import VirtualDisk

    controller = controller if controller in {
        "scsi", "virtio", "ide", "sata", "nvme"
    } else ""
    disk = VirtualDisk.objects.filter(vm=vm, key=key).first()
    if disk is None:
        VirtualDisk.objects.create(
            vm=vm, key=key, name=name or key, size_gb=size_gb, storage=storage,
            controller=controller, disk_format=disk_format, created_disk=True,
        )
        return
    changed = []
    for f, v in (("name", name), ("size_gb", size_gb), ("storage", storage),
                 ("controller", controller), ("disk_format", disk_format)):
        if v in (None, ""):
            continue
        if disk.created_disk or getattr(disk, f) in (None, ""):
            if getattr(disk, f) != v:
                setattr(disk, f, v)
                changed.append(f)
    if changed:
        disk.save(update_fields=changed)


def _apply_notes(vm, notes) -> None:
    """Blank-fill the VM description from the hypervisor's notes — only when the
    operator hasn't written one (a sync-created VM's «Synced from …» placeholder
    counts as empty). Never overwrites a real description."""
    notes = (notes or "").strip()
    if not notes:
        return
    cur = (vm.description or "").strip()
    if cur and not cur.startswith("Synced from"):
        return
    if cur != notes:
        vm.description = notes
        vm.save(update_fields=["description"])


def _parse_tag_colors(tag_style) -> dict:
    """Parse Proxmox ``tag-style`` (cluster/options) into ``{name: "#rrggbb"}``.

    Format: ``color-map=<tag>:<RRGGBB>[:<text RRGGBB>];…,shape=…,…`` — only the
    explicit color-map is usable; without one Proxmox derives colors from a
    UI-side name hash, which isn't worth replicating.
    """
    out: dict = {}
    for part in str(tag_style or "").split(","):
        part = part.strip()
        if not part.startswith("color-map="):
            continue
        for entry in part[len("color-map="):].split(";"):
            bits = entry.split(":")
            if len(bits) >= 2 and bits[0] and re.fullmatch(r"[0-9a-fA-F]{6}", bits[1]):
                out[bits[0]] = f"#{bits[1].lower()}"
    return out


def _apply_tags(vm, names, colors: dict | None = None) -> None:
    """Additively attach hypervisor tags to the VM — get-or-create each Tag in
    the tenant, add the ones missing. Never removes operator-added tags. The
    hypervisor's tag color (Proxmox color-map) is blank-filled — set on create
    or on an uncoloured tag, never overwriting a color an operator picked."""
    from django.utils.text import slugify

    from core.models import Tag

    want = [n.strip() for n in names if n and n.strip()]
    if not want:
        return
    colors = colors or {}
    have = {t.name: t for t in vm.tags.all()}
    for name in want:
        color = colors.get(name, "")
        tag = have.get(name)
        if tag is None:
            tag, _ = Tag.objects.get_or_create(
                tenant=vm.tenant, slug=slugify(name)[:100] or name[:100],
                defaults={"name": name, "color": color},
            )
            vm.tags.add(tag)
        if color and not tag.color:
            tag.color = color
            tag.save(update_fields=["color"])


def _sync_meta_proxmox(guest, cfg, tag_colors: dict | None = None) -> None:
    """Proxmox VM tags (`tags: a;b`) → Tags (with color-map colors); Notes
    (`description`) → description."""
    if guest.vm is None or not cfg:
        return
    _apply_notes(guest.vm, cfg.get("description"))
    _apply_tags(
        guest.vm, re.split(r"[;,]", str(cfg.get("tags") or "")),
        colors=tag_colors,
    )


def _sync_meta_vcenter(guest, meta) -> None:
    """vCenter VM annotation (notes) → description. (vSphere tags live behind a
    separate tagging API — not synced here.)"""
    if guest.vm is None or not meta:
        return
    _apply_notes(guest.vm, meta.get("notes"))


def _network_group(source, cluster):
    """A dedicated VLANGroup for one source's synced VLANs — keeps their VIDs
    scoped so they never collide with operator-defined VLANs."""
    from api.models import VLANGroup

    grp, _ = VLANGroup.objects.get_or_create(
        tenant=source.tenant, slug=f"virt-{source.id.hex[:12]}",
        defaults={"name": f"{source.name} networks", "cluster": cluster},
    )
    return grp


def _link_network(source, cluster, guest, iface_name, bridge, tag, name, now):
    """Shared: upsert VirtualSwitch(bridge) + VirtNetwork(→VLAN) and blank-fill
    the VM interface's VLAN. Returns 1 if a network row was touched."""
    from api.models import VLAN, VMInterface, VirtualSwitch
    from .models import VirtNetwork

    if not bridge:
        return 0
    c = cluster()
    vswitch, _ = VirtualSwitch.objects.get_or_create(
        tenant=source.tenant, cluster=c, name=bridge,
        defaults={"kind": "linux-bridge" if source.kind == "proxmox"
                  else "standard", "created_switch": True},
    )
    vlan = None
    if tag is not None:
        grp = _network_group(source, c)
        vlan, _ = VLAN.objects.get_or_create(
            tenant=source.tenant, group=grp, vlan_id=tag,
            defaults={"name": name or f"{bridge} VLAN {tag}"},
        )
    ext_key = f"{bridge}:{tag}" if tag is not None else bridge
    vn, _ = VirtNetwork.objects.get_or_create(
        source=source, ext_key=ext_key,
        defaults={"name": name or ext_key},
    )
    changed = ["last_seen_at"]
    vn.last_seen_at = now
    if vn.vswitch_id is None:
        vn.vswitch = vswitch
        changed.append("vswitch")
    if vn.vlan_id is None and vlan is not None:
        vn.vlan = vlan
        vn.created_vlan = True
        changed += ["vlan", "created_vlan"]
    vn.save(update_fields=changed)
    # Blank-fill the interface's access VLAN (never overwrite operator intent).
    if vlan is not None and iface_name:
        iface = VMInterface.objects.filter(vm=guest.vm, name=iface_name).first()
        if iface is not None and iface.vlan_id is None:
            iface.vlan = vlan
            if not iface.mode:
                iface.mode = "access"
            iface.save(update_fields=["vlan", "mode"])
    return 1


def _sync_networks_proxmox(source, cluster, guest, cfg, now) -> int:
    """Proxmox NIC bridges/tags → VirtualSwitch + VirtNetwork(→VLAN)."""
    if guest.vm is None or not cfg:
        return 0
    n = 0
    for key, value in cfg.items():
        if not _NET_KEY.match(str(key)):
            continue
        parsed = _parse_net(str(value))
        iface_name = parsed["name"] or str(key)
        n += _link_network(
            source, cluster, guest, iface_name,
            parsed["bridge"], parsed["tag"], "", now,
        )
    return n


def _sync_proxmox_uplinks(source, cluster_name, nodes) -> int:
    """Link each bridge's physical ports to the node Device's interfaces — the
    switch's uplinks (physical adapters). A bridge (vmbrN) exists on every node,
    so a cluster switch gets the union of all hosts' ports (multi-hypervisor).

    Additive only: never removes uplinks an operator set. Matches when the node
    is modelled as a Device and the port name is one of its Interfaces."""
    from api.models import Cluster, Device, Interface, VirtualSwitch

    cluster = Cluster.objects.filter(
        tenant=source.tenant, name=cluster_name
    ).first()
    if cluster is None:
        return 0
    added = 0
    for node in nodes:
        if not node:
            continue
        try:
            netcfg = proxmox_get(source, f"nodes/{node}/network") or []
        except VirtAPIError:
            continue
        dev = Device.objects.filter(tenant=source.tenant, name=node).first()
        if dev is None:
            continue
        for entry in netcfg:
            if entry.get("type") not in ("bridge", "OVSBridge"):
                continue
            bridge = entry.get("iface")
            ports = (
                entry.get("bridge_ports") or entry.get("ovs_ports") or ""
            ).split()
            if not bridge or not ports:
                continue
            sw = VirtualSwitch.objects.filter(
                tenant=source.tenant, cluster=cluster, name=bridge
            ).first()
            if sw is None:
                continue  # only link switches the VM-NIC pass created
            existing = set(sw.uplink_interfaces.values_list("id", flat=True))
            for port in ports:
                iface = Interface.objects.filter(device=dev, name=port).first()
                if iface and iface.id not in existing:
                    sw.uplink_interfaces.add(iface)
                    existing.add(iface.id)
                    added += 1
    return added


def sync_proxmox(source) -> dict:
    # cluster/status needs Sys.Audit on / — a narrowly-scoped token may be
    # denied it while still seeing VMs. Fall back to /nodes + the source name.
    try:
        status = proxmox_get(source, "cluster/status") or []
    except VirtAPIError:
        status = []
    cluster_name = next(
        (s.get("name") for s in status if s.get("type") == "cluster"),
        source.name,
    )
    nodes = [s.get("name") for s in status if s.get("type") == "node"]
    if not nodes:
        nodes = [n.get("node") for n in (proxmox_get(source, "nodes") or [])]
    resources = [
        r for r in (proxmox_get(source, "cluster/resources?type=vm") or [])
        if r.get("template") not in (1, True)  # VM templates aren't inventory
    ]

    now = timezone.now()
    counts = {"nodes": len(nodes), "vms": 0, "vms_created": 0,
              "interfaces": 0, "ips": 0, "disks": 0, "networks": 0,
              "uplinks": 0, "pending": 0}

    # Guest details come over the network — fetch before the DB transaction.
    # The Proxmox config blob carries both NICs (netN) and disks (scsiN/…), so
    # one fetch feeds interfaces, disks and networks.
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
        details[vmid] = {"ifaces": cfg, "ips": agent_ifaces,
                         "disks": cfg, "nets": cfg, "meta": cfg}

    # Cluster tag colors (explicit color-map only) ride along into Tag rows.
    try:
        opts = proxmox_get(source, "cluster/options") or {}
    except VirtAPIError:
        opts = {}
    tag_colors = _parse_tag_colors(
        opts.get("tag-style") if isinstance(opts, dict) else ""
    )

    result = _run_pass(source, cluster_name, resources, details, now, counts,
                       _sync_interfaces, _sync_ips,
                       sync_disks_fn=_sync_disks,
                       sync_nets_fn=_sync_networks_proxmox,
                       sync_meta_fn=partial(_sync_meta_proxmox,
                                            tag_colors=tag_colors),
                       label="proxmox")
    # Switches exist now — link their bridge uplinks to the node's real NICs.
    if source.sync_networks:
        result["uplinks"] = _sync_proxmox_uplinks(source, cluster_name, nodes)
    return result


def _run_pass(source, cluster_name, resources, details, now, counts,
              sync_ifaces, sync_ips, *, sync_disks_fn=None,
              sync_nets_fn=None, sync_meta_fn=None, label) -> dict:
    """Reconcile one fetched inventory against Danbyte — hypervisor-agnostic.

    ``resources`` is a list of normalised guest dicts (``vmid``, ``name``,
    ``type``, ``node``, ``status`` + ``maxcpu``/``maxmem``/``maxdisk`` specs);
    ``details`` maps ``vmid → (iface_data, ip_data)`` fetched before the
    transaction. ``sync_ifaces``/``sync_ips`` are the hypervisor-specific
    callables that turn that detail into VMInterface/IPAddress rows. Everything
    else — adoption, spec diffing, the review queue, orphan pruning — is shared.
    """
    from .models import VirtChange, VirtGuest

    apply = source.sync_mode == "auto"
    with transaction.atomic():
        # The cluster is a container — only materialise it when a VM actually
        # lands (so a review-mode source with nothing accepted stays inert).
        cluster_box: list = []

        def cluster():
            if not cluster_box:
                cluster_box.append(_cluster_for(source, cluster_name))
            return cluster_box[0]

        seen = set()
        fresh_changes: set = set()  # (guest_id, kind) queued this pass
        for r in resources:
            vmid = r.get("vmid")
            if vmid is None:
                continue
            seen.add(vmid)
            counts["vms"] += 1
            kind = r.get("kind") or ("lxc" if r.get("type") == "lxc" else "qemu")
            guest, _ = VirtGuest.objects.get_or_create(
                source=source, vmid=vmid, defaults={"kind": kind}
            )
            guest.kind = kind
            guest.node = r.get("node") or ""
            guest.power_state = r.get("status") or ""
            guest.last_seen_at = now
            guest.save()
            _reconcile_guest(source, cluster, cluster_name, guest, r, apply,
                             now, counts, fresh_changes)
            if guest.vm_id:
                d = details.get(vmid) or {}
                counts["interfaces"] += sync_ifaces(guest, d.get("ifaces"))
                counts["ips"] += sync_ips(source, guest, d.get("ips"))
                if source.sync_disks and sync_disks_fn:
                    counts["disks"] += sync_disks_fn(guest, d.get("disks"))
                if source.sync_networks and sync_nets_fn:
                    counts["networks"] += sync_nets_fn(
                        source, cluster, guest, d.get("nets"), now
                    )
                if sync_meta_fn:
                    sync_meta_fn(guest, d.get("meta"))

        # Guests gone from the hypervisor.
        for gone in VirtGuest.objects.filter(source=source).exclude(vmid__in=seen):
            if gone.vm_id and gone.created_vm:
                if apply:
                    gone.vm.delete()
                    gone.delete()
                else:
                    _queue_change(gone, "removed_guest", {}, now, fresh_changes)
            else:
                # An adopted (operator-owned) VM or one never accepted: drop the
                # tracking row, never the VM.
                gone.delete()

        _prune_changes(source, fresh_changes)
        counts["pending"] = VirtChange.objects.filter(
            source=source, ignored=False
        ).count()

    source.last_sync_at = now
    source.last_sync_status = "ok"
    source.last_sync_error = ""
    source.save(update_fields=["last_sync_at", "last_sync_status",
                               "last_sync_error"])
    logger.info("%s sync %s (%s): %s", label, source.name, source.sync_mode, counts)
    return counts


def _desired_specs(resource: dict) -> dict:
    maxmem = resource.get("maxmem") or 0
    maxdisk = resource.get("maxdisk") or 0
    return {
        "vcpus": int(resource.get("maxcpu") or 0) or None,
        "memory_mb": int(maxmem / 1024 / 1024) or None,
        "disk_gb": int(maxdisk / 1024 / 1024 / 1024) or None,
    }


def _reconcile_guest(source, cluster, cluster_name, guest, resource, apply, now,
                     counts, fresh_changes) -> None:
    """Bring one guest into line with the inventory — applying (auto) or
    queuing a change (review/manual)."""
    from api.models import VirtualMachine

    name = resource.get("name") or f"vm-{guest.vmid}"
    specs = _desired_specs(resource)

    if guest.vm_id is None:
        # Adopt an operator's existing VM of the same name — a non-destructive
        # link, so it happens in every mode.
        adopted = VirtualMachine.objects.filter(
            tenant=source.tenant, name=name
        ).first()
        if adopted is not None:
            guest.vm = adopted
            guest.created_vm = False
            guest.save(update_fields=["vm", "created_vm"])
            _blank_fill(adopted, specs, source, guest)
            _clear_change(guest, "new_guest")
            return
        if apply:
            vm = VirtualMachine.objects.create(
                tenant=source.tenant, name=name, cluster=cluster(),
                description=f"Synced from «{source.name}»", **_nonnull(specs),
            )
            guest.vm = vm
            guest.created_vm = True
            guest.save(update_fields=["vm", "created_vm"])
            _blank_fill(vm, {}, source, guest)  # node → device
            counts["vms_created"] += 1
        else:
            detail = {"name": name, "node": guest.node, "kind": guest.kind,
                      "cluster": cluster_name, **_nonnull(specs)}
            _queue_change(guest, "new_guest", detail, now, fresh_changes)
        return

    # Already linked. Sync-created rows track the hypervisor's specs; adopted
    # rows are operator-owned and only ever blank-filled.
    vm = guest.vm
    if guest.created_vm:
        diffs = {}
        for field, value in specs.items():
            if value is not None and getattr(vm, field) != value:
                diffs[field] = {"danbyte": getattr(vm, field), "hypervisor": value}
        if diffs:
            if apply:
                for field, pair in diffs.items():
                    setattr(vm, field, pair["hypervisor"])
                vm.save(update_fields=list(diffs))
                _clear_change(guest, "spec_change")
            else:
                _queue_change(guest, "spec_change", diffs, now, fresh_changes)
        else:
            _clear_change(guest, "spec_change")
    _blank_fill(vm, {} if guest.created_vm else specs, source, guest)


def _nonnull(specs: dict) -> dict:
    return {k: v for k, v in specs.items() if v is not None}


def _blank_fill(vm, specs, source, guest) -> None:
    """Fill only empty spec fields (adopted rows) and the host device link.
    Never overwrites operator data."""
    from api.models import Device

    changed = []
    for field, value in (specs or {}).items():
        if value is not None and getattr(vm, field) in (None, 0):
            setattr(vm, field, value)
            changed.append(field)
    if guest.node and vm.device_id is None:
        host = Device.objects.filter(
            tenant=source.tenant, name__iexact=guest.node
        ).first()
        if host is not None:
            vm.device = host
            changed.append("device")
    if changed:
        vm.save(update_fields=changed)


def _queue_change(guest, kind, detail, now, fresh_changes) -> None:
    """Record (or refresh) a pending change without disturbing an ignore."""
    from .models import VirtChange

    row, created = VirtChange.objects.get_or_create(
        guest=guest, kind=kind,
        defaults={"source": guest.source, "vm": guest.vm, "detail": detail,
                  "last_seen_at": now},
    )
    if not created:
        row.detail = detail
        row.vm = guest.vm
        row.last_seen_at = now
        row.save(update_fields=["detail", "vm", "last_seen_at"])
    fresh_changes.add((guest.id, kind))


def _clear_change(guest, kind) -> None:
    from .models import VirtChange

    VirtChange.objects.filter(guest=guest, kind=kind).delete()


def _prune_changes(source, fresh_changes) -> None:
    """Drop change rows that no longer reproduce (resolved on the hypervisor)."""
    from .models import VirtChange

    for row in VirtChange.objects.filter(source=source).select_related("guest"):
        if (row.guest_id, row.kind) not in fresh_changes:
            row.delete()


_CLUSTER_TYPE = {
    "proxmox": ("Proxmox VE", "proxmox-ve"),
    "vcenter": ("VMware vCenter", "vmware-vcenter"),
}


def _cluster_for(source, name: str):
    from api.models import Cluster, ClusterType

    existing = Cluster.objects.filter(tenant=source.tenant, name=name).first()
    if existing:
        return existing
    type_name, type_slug = _CLUSTER_TYPE.get(source.kind, _CLUSTER_TYPE["proxmox"])
    ctype = ClusterType.objects.filter(
        tenant=source.tenant, name__iexact=type_name
    ).first()
    if ctype is None:
        ctype = ClusterType.objects.create(
            tenant=source.tenant, name=type_name, slug=type_slug
        )
    return Cluster.objects.create(
        tenant=source.tenant, name=name, type=ctype,
        description=f"Synced from «{source.name}»",
    )


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


def _sync_ips(source, guest, agent_ifaces) -> int:
    """Proxmox guest-agent IPs → the shared attach path (matched by MAC)."""
    entries = [
        {
            "mac": entry.get("hardware-address") or "",
            "ips": [i.get("ip-address") or ""
                    for i in (entry.get("ip-addresses") or [])],
        }
        for entry in (agent_ifaces or [])
    ]
    return _attach_ips(source, guest, entries)


def _attach_ips(source, guest, entries) -> int:
    """Attach discovered IPs to a VM's interfaces (matched by MAC).

    ``entries`` is a hypervisor-agnostic ``[{"mac": .., "ips": [str, ..]}]``.
    An IP is only recorded when a containing Prefix already exists — sync never
    invents address space — and only ever adopts an unassigned IPAM row.
    """
    from api.models import IPAddress, Prefix, VMInterface

    if guest.vm is None or not entries:
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
    for entry in entries:
        mac = (entry.get("mac") or "").lower()
        iface = by_mac.get(mac)
        for raw in entry.get("ips") or []:
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


# ─── VMware vCenter (vSphere Automation REST) ────────────────────────────────

_MOREF_RE = re.compile(r"(\d+)")

_VC_POWER = {"POWERED_ON": "running", "POWERED_OFF": "stopped",
             "SUSPENDED": "suspended"}


def _moref_id(moref: str):
    """``vm-1023`` → ``1023``. vCenter MoRefs are stable per VM lifetime, so the
    integer is a safe key for VirtGuest.vmid (a PositiveIntegerField)."""
    m = _MOREF_RE.search(moref or "")
    return int(m.group(1)) if m else None


def _vcenter_resource(summary: dict, info: dict, vmid: int, node: str) -> dict:
    """Normalise a vCenter VM into the shared resource shape ``_run_pass`` wants."""
    mem_mib = (info.get("memory") or {}).get("size_MiB") \
        or summary.get("memory_size_MiB") or 0
    cpu = (info.get("cpu") or {}).get("count") or summary.get("cpu_count") or 0
    disk_bytes = sum(
        int((d or {}).get("capacity") or 0)
        for d in (info.get("disks") or {}).values()
    )
    power = summary.get("power_state") or info.get("power_state") or ""
    return {
        "vmid": vmid,
        "kind": "vmware",
        "type": "vmware",
        "name": summary.get("name") or info.get("name") or f"vm-{vmid}",
        "node": node,
        "status": _VC_POWER.get(power, power.lower()),
        "maxcpu": cpu,
        "maxmem": int(mem_mib) * 1024 * 1024,
        "maxdisk": disk_bytes,
    }


def sync_vcenter(source) -> dict:
    from .virt_client import VCenterClient

    client = VCenterClient(source).login()
    try:
        vms = client.get("vcenter/vm") or []
        clusters = client.get("vcenter/cluster") or []
        hosts = client.get("vcenter/host") or []

        # A single cluster names the api.Cluster; a multi-cluster vCenter falls
        # back to the source name (VM→cluster placement isn't in the VM summary).
        cluster_name = clusters[0]["name"] if len(clusters) == 1 else source.name

        # Map each VM to its ESXi host so blank-fill can link the host Device.
        host_of: dict = {}
        for h in hosts:
            hm, hn = h.get("host"), h.get("name") or ""
            if not hm:
                continue
            try:
                on_host = client.get(f"vcenter/vm?hosts={hm}") or []
            except VirtAPIError:
                on_host = []
            for v in on_host:
                host_of[v.get("vm")] = hn

        now = timezone.now()
        counts = {"nodes": len(hosts), "vms": 0, "vms_created": 0,
                  "interfaces": 0, "ips": 0, "disks": 0, "networks": 0,
                  "pending": 0}

        resources: list = []
        details: dict = {}
        for v in vms:
            moref = v.get("vm")
            vmid = _moref_id(moref)
            if vmid is None:
                continue
            try:
                info = client.get(f"vcenter/vm/{moref}") or {}
            except VirtAPIError as exc:
                logger.warning("vcenter vm %s fetch failed: %s", moref, exc)
                info = {}
            resources.append(
                _vcenter_resource(v, info, vmid, host_of.get(moref, ""))
            )
            nics = info.get("nics") or {}
            guest_nets = []
            if v.get("power_state") == "POWERED_ON":
                try:
                    guest_nets = client.get(
                        f"vcenter/vm/{moref}/guest/networking/interfaces"
                    ) or []
                except VirtAPIError:
                    pass  # VMware Tools absent/starting — IPs stay unknown
            details[vmid] = {"ifaces": nics, "ips": guest_nets,
                             "disks": info.get("disks"), "nets": nics,
                             "meta": {"notes": info.get("notes")}}

        return _run_pass(source, cluster_name, resources, details, now, counts,
                         _sync_vcenter_interfaces, _sync_vcenter_ips,
                         sync_disks_fn=_sync_vcenter_disks,
                         sync_nets_fn=_sync_networks_vcenter,
                         sync_meta_fn=_sync_meta_vcenter, label="vcenter")
    finally:
        client.close()


def _sync_vcenter_disks(guest, disks) -> int:
    """vCenter VM disk devices → VirtualDisk rows."""
    from api.models import VirtualDisk

    if guest.vm is None or not disks:
        return 0
    seen, n = set(), 0
    for key, d in disks.items():
        d = d or {}
        key = str(key)
        cap = int(d.get("capacity") or 0)
        size_gb = int(cap / 1024**3) or (1 if cap > 0 else None)
        backing = d.get("backing") or {}
        storage = ""
        m = re.match(r"\[([^\]]+)\]", backing.get("vmdk_file") or "")
        if m:
            storage = m.group(1)
        seen.add(key)
        n += 1
        _upsert_disk(guest.vm, key, name=d.get("label") or key, size_gb=size_gb,
                     storage=storage, controller=(d.get("type") or "").lower())
    VirtualDisk.objects.filter(
        vm=guest.vm, created_disk=True
    ).exclude(key__in=seen).delete()
    return n


def _sync_networks_vcenter(source, cluster, guest, nics, now) -> int:
    """vCenter NIC backings → VirtualSwitch + VirtNetwork. VLAN tags live on the
    port-group (not the VM NIC), so a VLAN is only linked when the backing
    exposes one; otherwise the network is recorded without a VLAN."""
    if guest.vm is None or not nics:
        return 0
    n = 0
    for key, nic in nics.items():
        nic = nic or {}
        backing = nic.get("backing") or {}
        network = backing.get("network_name") or backing.get("network") or ""
        if not network:
            continue
        tag = backing.get("vlan_id")
        iface_name = nic.get("label") or f"nic-{key}"
        n += _link_network(
            source, cluster, guest, iface_name, network,
            int(tag) if isinstance(tag, int) else None, network, now,
        )
    return n


def _sync_vcenter_interfaces(guest, nics) -> int:
    from api.models import VMInterface

    if guest.vm is None or not nics:
        return 0
    n = 0
    for key, nic in (nics or {}).items():
        nic = nic or {}
        name = nic.get("label") or f"nic-{key}"
        mac = (nic.get("mac_address") or "").lower()
        iface = VMInterface.objects.filter(vm=guest.vm, name=name).first()
        if iface is None:
            VMInterface.objects.create(vm=guest.vm, name=name, mac_address=mac)
        elif mac and not iface.mac_address:
            iface.mac_address = mac
            iface.save(update_fields=["mac_address"])
        n += 1
    return n


def _sync_vcenter_ips(source, guest, guest_nets) -> int:
    """vCenter guest-tools IPs → the shared attach path (matched by MAC)."""
    entries = [
        {
            "mac": gn.get("mac_address") or "",
            "ips": [a.get("ip_address") or ""
                    for a in ((gn.get("ip") or {}).get("ip_addresses") or [])],
        }
        for gn in (guest_nets or [])
    ]
    return _attach_ips(source, guest, entries)


def record_virt_failure(source, exc: Exception) -> None:
    source.last_sync_at = timezone.now()
    source.last_sync_status = "failed"
    source.last_sync_error = str(exc)[:2000]
    source.save(update_fields=["last_sync_at", "last_sync_status",
                               "last_sync_error"])


# ─── Review inbox: accept / ignore a pending change ───────────────────────────


def apply_change(change) -> None:
    """Apply one pending :class:`VirtChange` to the inventory, then clear it.

    Interface/IP enrichment for a newly-created VM lands on the next sync pass
    (it needs the guest's live config), so accepting a ``new_guest`` creates
    the VM shell and links it — the specs and NICs fill in on the next detect.
    """
    from api.models import VirtualMachine

    guest = change.guest
    if change.kind == "removed_guest":
        if guest.vm_id and guest.created_vm:
            guest.vm.delete()
        guest.delete()  # cascades the change row
        return

    if change.kind == "new_guest":
        detail = change.detail or {}
        cluster = _cluster_for(guest.source, detail.get("cluster") or guest.source.name)
        specs = {k: detail.get(k) for k in ("vcpus", "memory_mb", "disk_gb")}
        vm = VirtualMachine.objects.create(
            tenant=guest.source.tenant,
            name=detail.get("name") or f"vm-{guest.vmid}",
            cluster=cluster,
            description=f"Synced from «{guest.source.name}»",
            **{k: v for k, v in specs.items() if v is not None},
        )
        guest.vm = vm
        guest.created_vm = True
        guest.save(update_fields=["vm", "created_vm"])
        _blank_fill(vm, {}, guest.source, guest)  # node → device
    elif change.kind == "spec_change":
        vm = guest.vm
        if vm is not None:
            fields = []
            for field, pair in (change.detail or {}).items():
                setattr(vm, field, pair.get("hypervisor"))
                fields.append(field)
            if fields:
                vm.save(update_fields=fields)
    change.delete()


def ignore_change(change) -> None:
    """Dismiss a change: kept so detection won't re-raise it, hidden from the
    default inbox until it's accepted or the guest disappears."""
    change.ignored = True
    change.save(update_fields=["ignored"])
