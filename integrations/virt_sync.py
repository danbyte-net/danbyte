"""Proxmox VE sync engine (read-only, virtualization track).

One pass per source:

1. ``/cluster/status`` - cluster name + nodes.
2. ``/cluster/resources?type=vm`` - every guest (QEMU + LXC) with specs and
   power state.
3. Per guest, its config (``/nodes/<n>/qemu|lxc/<vmid>/config``) for NICs,
   and - for running QEMU guests - the guest agent's
   ``network-get-interfaces`` for live IPs.

Mapping: cluster → :class:`api.Cluster` (a "Proxmox VE" ClusterType is
created on demand - required structural data, editable); guest →
:class:`api.VirtualMachine`; NICs → :class:`api.VMInterface`; agent IPs →
:class:`api.IPAddress` assigned to the interface (only when a containing
Prefix exists - sync never invents address space).

Adoption rules mirror the DHCP/DNS engines: rows the operator already has are
adopted and blank-filled, never overwritten; only VMs the sync created are
removed again when their guest disappears.
"""
from __future__ import annotations

import ipaddress
import logging
import re
from functools import partial

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.text import slugify

from api import vrf_placement

from . import placement
from .virt_client import VirtAPIError, proxmox_get

logger = logging.getLogger("danbyte.virt_sync")

_MAC_RE = re.compile(r"\b([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5})\b")
_NET_KEY = re.compile(r"^net(\d+)$")


def _parse_net(value: str) -> dict:
    """Parse a Proxmox netX config value into {mac, name, bridge, tag, mtu}.

    QEMU: ``virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=10``
    LXC:  ``name=eth0,bridge=vmbr0,hwaddr=AA:…,ip=dhcp``
    """
    out = {"mac": "", "name": "", "bridge": "", "tag": None, "mtu": None}
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
        elif k == "mtu" and v.isdigit():
            out["mtu"] = int(v)
    return out


# Proxmox disk buses (skip cdrom/efidisk/tpmstate/cloudinit - not data disks).
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
    """Blank-fill the VM description from the hypervisor's notes - only when the
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

    Format: ``color-map=<tag>:<RRGGBB>[:<text RRGGBB>];…,shape=…,…`` - only the
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
    """Additively attach hypervisor tags to the VM - get-or-create each Tag in
    the tenant, add the ones missing. Never removes operator-added tags. The
    hypervisor's tag color (Proxmox color-map) is blank-filled - set on create
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
    separate tagging API - not synced here.)"""
    if guest.vm is None or not meta:
        return
    _apply_notes(guest.vm, meta.get("notes"))


def _network_group(source, cluster):
    """A dedicated VLANGroup for one source's synced VLANs - keeps their VIDs
    scoped so they never collide with operator-defined VLANs."""
    from api.models import VLANGroup

    grp, _ = VLANGroup.objects.get_or_create(
        tenant=source.tenant, slug=f"virt-{source.id.hex[:12]}",
        defaults={"name": f"{source.name} networks", "cluster": cluster},
    )
    return grp


def _link_network(source, cluster, guest, iface_name, bridge, tag, name, now,
                  kind=None):
    """Shared: upsert VirtualSwitch(bridge) + VirtNetwork(→VLAN) and blank-fill
    the VM interface's VLAN. Returns 1 if a network row was touched."""
    from api.models import VLAN, VMInterface, VirtualSwitch
    from .models import VirtNetwork

    if not bridge:
        return 0
    c = cluster()
    # `kind` is what the hypervisor actually says, when it says anything.
    # Falling back to the connector guesses, which labelled every vCenter
    # switch "standard" even when it was distributed.
    vswitch, made_switch = VirtualSwitch.objects.get_or_create(
        tenant=source.tenant, cluster=c, name=bridge,
        defaults={
            "kind": kind or (
                "linux-bridge" if source.kind == "proxmox" else "standard"
            ),
            "created_switch": True,
        },
    )
    if made_switch:
        logger.info("created virtual switch %r (kind=%s) on cluster %r",
                    bridge, vswitch.kind, c.name)
    # A switch created before the type was known gets corrected once, but an
    # operator's own choice is left alone.
    if kind and vswitch.created_switch and vswitch.kind != kind:
        vswitch.kind = kind
        vswitch.save(update_fields=["kind"])
    vlan = None
    if tag is not None:
        grp = _network_group(source, c)
        vlan, made_vlan = VLAN.objects.get_or_create(
            tenant=source.tenant, group=grp, vlan_id=tag,
            defaults={"name": name or f"{bridge} VLAN {tag}"},
        )
        if made_vlan:
            logger.info("created VLAN %s (%s) in group %r",
                        tag, vlan.name, grp.name)
    ext_key = f"{bridge}:{tag}" if tag is not None else bridge
    vn, made_net = VirtNetwork.objects.get_or_create(
        source=source, ext_key=ext_key,
        defaults={"name": name or ext_key},
    )
    if made_net:
        logger.info("created network %r on switch %r", vn.name or ext_key,
                    bridge)
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
    # The direct NIC-to-network statement. The VM page renders from this, not
    # from a shared VLAN - vCenter never supplies a VLAN on the NIC, so the
    # VLAN inference left every vCenter VM looking unmapped (#46).
    if iface_name:
        iface = VMInterface.objects.filter(vm=guest.vm, name=iface_name).first()
        if iface is not None:
            from .models import VirtNetworkLink

            _, made_link = VirtNetworkLink.objects.update_or_create(
                network=vn, vm_interface=iface,
                defaults={"last_seen_at": now},
            )
            if made_link:
                logger.info("linked %s/%s to network %r",
                            guest.vm.name, iface.name, vn.name or ext_key)
            # Blank-fill the access VLAN (never overwrite operator intent).
            if vlan is not None and iface.vlan_id is None:
                iface.vlan = vlan
                if not iface.mode:
                    iface.mode = "access"
                iface.save(update_fields=["vlan", "mode"])
                logger.info("blank-filled %s/%s access VLAN to %s",
                            guest.vm.name, iface.name, vlan.vlan_id)
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
    """Link each bridge's physical ports to the node Device's interfaces - the
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
    # cluster/status needs Sys.Audit on / - a narrowly-scoped token may be
    # denied it while still seeing VMs. Fall back to /nodes + the source name.
    try:
        status = proxmox_get(source, "cluster/status") or []
    except VirtAPIError:
        status = []
    cluster_name = next(
        (s.get("name") for s in status if s.get("type") == "cluster"),
        source.name,
    )
    node_rows = [
        {"name": s.get("name"), "online": bool(s.get("online"))}
        for s in status if s.get("type") == "node"
    ]
    if not node_rows:
        node_rows = [
            {"name": n.get("node"), "online": n.get("status") == "online"}
            for n in (proxmox_get(source, "nodes") or [])
        ]
    nodes = [n["name"] for n in node_rows]
    resources = [
        r for r in (proxmox_get(source, "cluster/resources?type=vm") or [])
        if r.get("template") not in (1, True)  # VM templates aren't inventory
    ]

    now = timezone.now()
    counts = {"nodes": len(nodes), "vms": 0, "vms_created": 0, "hosts": 0,
              "interfaces": 0, "ips": 0, "ips_skipped": 0, "disks": 0,
              "networks": 0, "uplinks": 0, "pending": 0}

    # Guest details come over the network - fetch before the DB transaction.
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
                pass  # agent not installed/running - IPs just stay unknown
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

    # Hosts first: the VM pass links each guest to the Device of the same name,
    # and the uplink pass needs those Devices to hang bridge ports off.
    if source.sync_hosts:
        counts["hosts"] = _sync_hosts(source, cluster_name, node_rows)
    result = _run_pass(source, cluster_name, resources, details, now, counts,
                       _sync_interfaces, _sync_ips,
                       sync_disks_fn=_sync_disks,
                       sync_nets_fn=_sync_networks_proxmox,
                       sync_meta_fn=partial(_sync_meta_proxmox,
                                            tag_colors=tag_colors),
                       label="proxmox")
    # Switches exist now - link their bridge uplinks to the node's real NICs.
    if source.sync_networks:
        result["uplinks"] = _sync_proxmox_uplinks(source, cluster_name, nodes)
    return result


def _run_pass(source, cluster_name, resources, details, now, counts,
              sync_ifaces, sync_ips, *, sync_disks_fn=None,
              sync_nets_fn=None, sync_meta_fn=None, extra_warnings=None,
              label) -> dict:
    """Reconcile one fetched inventory against Danbyte - hypervisor-agnostic.

    ``resources`` is a list of normalised guest dicts (``vmid``, ``name``,
    ``type``, ``node``, ``status`` + ``maxcpu``/``maxmem``/``maxdisk`` specs);
    ``details`` maps ``vmid → (iface_data, ip_data)`` fetched before the
    transaction. ``sync_ifaces``/``sync_ips`` are the hypervisor-specific
    callables that turn that detail into VMInterface/IPAddress rows. Everything
    else - adoption, spec diffing, the review queue, orphan pruning - is shared.
    """
    from api.models import Site

    from .models import VirtChange, VirtGuest, VirtNetworkLink

    apply = source.sync_mode == "auto"
    # Load the tenant's prefixes once for the whole pass - this used to be a
    # full Prefix scan per guest - and collect the run's placement warnings so
    # a scheduled sync can report them without a toast to show.
    prefixes = vrf_placement.load_prefixes(source.tenant)
    # Which networks/switches state a routing context, read once per pass. A
    # network can only be configured after it has been discovered, so on the
    # pass that first creates one this is simply empty - no reordering needed.
    net_vrfs = _network_vrf_map(source)
    # Placement inputs, read once: the operator's rules and the tenant's sites
    # by name (the hierarchy fallback). Both are small.
    rules = list(
        source.placement_rules.select_related("site", "location").all()
    )
    site_by_name = {
        s.name.lower(): s
        for s in Site.objects.filter(tenant=source.tenant).only("id", "name")
    }
    warnings: list[str] = list(extra_warnings or [])
    with transaction.atomic():
        # Clusters are containers - only materialise one when a guest actually
        # lands on it (so a review-mode source with nothing accepted stays
        # inert), and materialise them **per name**. This used to be a single
        # cluster shared by the whole pass, which collapsed every guest in a
        # multi-cluster vCenter into one cluster named after the source.
        cluster_cache: dict = {}

        def cluster_for(name: str):
            key = name or cluster_name
            if key not in cluster_cache:
                cluster_cache[key] = _cluster_for(source, key)
            return cluster_cache[key]

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
            # Each guest carries the cluster it actually runs on; Proxmox
            # reports one for the whole source, so its behaviour is unchanged.
            guest_cluster_name = r.get("cluster") or cluster_name
            guest_cluster = partial(cluster_for, guest_cluster_name)
            guest_path = placement.PlacementPath(
                datacenter=r.get("datacenter") or "",
                cluster=guest_cluster_name,
                host=r.get("node") or "",
                folders=list(r.get("folders") or []),
                # The guest's own addresses, as the hypervisor reports them -
                # this is what an "10.0.9.* is RS" rule matches on. Read here
                # rather than from IPAM because placement runs before the
                # addresses are attached, and must not depend on that having
                # worked.
                ips=_reported_ips((details.get(vmid) or {}).get("ips")),
            )
            place = placement.resolve(
                guest_path, rules, site_by_name=site_by_name
            )
            # Only worth saying when placement could plausibly have worked -
            # a deployment with no sites and no rules isn't using this, and
            # nagging it every pass would be noise. Duplicates collapse in
            # record_skipped, so this is one line per distinct location.
            if not place.ok and (rules or site_by_name):
                warnings.append(placement.unplaced_warning(guest_path))
            _reconcile_guest(source, guest_cluster, guest_cluster_name, guest, r,
                             apply, now, counts, fresh_changes, place, warnings)
            if guest.vm_id:
                d = details.get(vmid) or {}
                made, seen_ifaces = sync_ifaces(guest, d.get("ifaces"))
                counts["interfaces"] += made
                # An interface Danbyte has but the hypervisor doesn't is either
                # stale bookkeeping or the operator's - see _reconcile_interfaces.
                if seen_ifaces:
                    _reconcile_interfaces(
                        guest, seen_ifaces, now, fresh_changes, apply
                    )
                attached, unplaced = sync_ips(
                    source, guest, d.get("ips"), nets=d.get("nets"),
                    prefixes=prefixes, warnings=warnings, net_vrfs=net_vrfs,
                )
                counts["ips"] += attached
                counts["ips_skipped"] += unplaced
                if source.sync_disks and sync_disks_fn:
                    counts["disks"] += sync_disks_fn(guest, d.get("disks"))
                if source.sync_networks and sync_nets_fn:
                    counts["networks"] += sync_nets_fn(
                        source, guest_cluster, guest, d.get("nets"), now
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

        if source.sync_networks:
            # Links the hypervisor stopped stating this pass are gone. Guarded
            # on the toggle: with networks sync off nothing is refreshed, and
            # pruning then would silently disconnect every VM.
            gone, _ = VirtNetworkLink.objects.filter(
                network__source=source
            ).exclude(last_seen_at=now).delete()
            if gone:
                logger.info("pruned %d stale network link(s)", gone)
        _prune_changes(source, fresh_changes)
        counts["pending"] = VirtChange.objects.filter(
            source=source, ignored=False
        ).count()

    source.last_sync_at = now
    source.last_sync_status = "ok"
    source.last_sync_error = ""
    unplaced = counts.get("ips_skipped") or 0
    summary = ""
    if unplaced:
        where = vrf_placement.vrf_label(source.vrf)
        summary = (
            f"{unplaced} address{'' if unplaced == 1 else 'es'} could not be "
            f"placed. Create a prefix that contains them in {where}, or change "
            f"this source's Address VRF."
        )
    source.record_skipped(warnings, summary=summary)
    source.save(update_fields=["last_sync_at", "last_sync_status",
                               "last_sync_error", "last_sync_skipped"])
    for line in warnings:
        logger.warning("%s", line)
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


#: Interface fields the sync can compare, and how to read each side. Only
#: fields a hypervisor genuinely reports belong here: one that is never stated
#: would read as "Danbyte disagrees with nothing" on every single interface.
_IFACE_FIELDS = ("mac_address", "mtu", "vlan_vid")


def _iface_value(iface, field):
    """The Danbyte side of a comparable field."""
    if field == "vlan_vid":
        # iface.vlan_id is the FK column; the 802.1Q tag is VLAN.vlan_id.
        return iface.vlan.vlan_id if iface.vlan_id else None
    return getattr(iface, field, None)


def _iface_drift(iface, reported: dict) -> dict:
    """``{field: {danbyte, hypervisor}}`` for genuine disagreements only.

    Three things are deliberately *not* drift:

    * a field the hypervisor didn't report (key absent, or ``None``) - silence
      is not a claim;
    * a field empty on the Danbyte side - blank-fill handles that, and calling
      it drift would ask the operator to approve filling in a blank;
    * a MAC that differs only in case or separator style.
    """
    out = {}
    for field in _IFACE_FIELDS:
        theirs = reported.get(field)
        if theirs in (None, ""):
            continue
        ours = _iface_value(iface, field)
        if ours in (None, ""):
            continue  # blank-fill territory, not disagreement
        if field == "mac_address":
            if _norm_mac(ours) == _norm_mac(theirs):
                continue
        elif ours == theirs:
            continue
        out[field] = {"danbyte": ours, "hypervisor": theirs}
    return out


def _norm_mac(value) -> str:
    """Compare MACs by their digits - ``AA:BB`` and ``aa-bb`` are one address."""
    return "".join(c for c in str(value or "").lower() if c.isalnum())


def _reconcile_interfaces(guest, seen, now, fresh_changes, apply=False) -> None:
    """Deal with VM interfaces the hypervisor no longer reports, and with those
    whose fields disagree.

    Two different situations for a missing NIC, and conflating them would lose
    operator data:

    * a NIC **the sync created** that has vanished is stale bookkeeping - prune
      it, exactly as ``_sync_disks`` prunes its own disks;
    * a NIC **the operator created** is theirs. It may be a typo, or it may be
      a NIC they are about to add on the hypervisor. Either way, deleting it is
      not the sync's call - it is raised as drift for a human to resolve.

    For a NIC that exists on both sides, a differing MAC, MTU or VLAN is raised
    as ``iface_change``. Mirror mode applies it directly for sync-created rows,
    matching how ``spec_change`` treats a sync-created VM.
    """
    from api.models import VMInterface

    if guest.vm is None:
        return
    seen_names = [r["name"] for r in seen]
    _diff_interfaces(guest, seen, now, fresh_changes, apply)
    extra = list(
        VMInterface.objects.filter(vm=guest.vm).exclude(name__in=seen_names)
    )
    if not extra:
        _clear_change(guest, "iface_extra")
        return
    stale = [i for i in extra if i.created_interface]
    theirs = [i for i in extra if not i.created_interface]
    if stale:
        VMInterface.objects.filter(pk__in=[i.pk for i in stale]).delete()
    if theirs:
        _queue_change(
            guest, "iface_extra",
            {"names": sorted(i.name for i in theirs)}, now, fresh_changes,
        )
    else:
        _clear_change(guest, "iface_extra")


def _diff_interfaces(guest, seen, now, fresh_changes, apply) -> None:
    """Raise (or apply) per-interface field drift."""
    from api.models import VMInterface

    by_name = {
        i.name: i for i in VMInterface.objects.filter(vm=guest.vm).select_related("vlan")
    }
    drifted, applied = {}, []
    for reported in seen:
        iface = by_name.get(reported.get("name"))
        if iface is None:
            continue
        diff = _iface_drift(iface, reported)
        if not diff:
            continue
        # Mirror mode owns the rows it created; an adopted interface is the
        # operator's and is always raised rather than silently rewritten.
        if apply and iface.created_interface:
            fields = []
            for field, pair in diff.items():
                if field == "vlan_vid":
                    continue  # a VLAN row is resolved by _link_network, not here
                setattr(iface, field, pair["hypervisor"])
                fields.append(field)
            if fields:
                iface.save(update_fields=fields)
                applied.append(iface.name)
                continue
        drifted[iface.name] = diff
    if drifted:
        _queue_change(guest, "iface_change", {"interfaces": drifted}, now,
                      fresh_changes)
    else:
        _clear_change(guest, "iface_change")


def _owned_by_another_source(vm, source) -> bool:
    """Is this VM already tracked by a *different* virtualization source?"""
    from .models import VirtGuest

    return (
        VirtGuest.objects.filter(vm=vm)
        .exclude(source=source)
        .exists()
    )


def _reconcile_guest(source, cluster, cluster_name, guest, resource, apply, now,
                     counts, fresh_changes, place=None, warnings=None) -> None:
    """Bring one guest into line with the inventory - applying (auto) or
    queuing a change (review/manual)."""
    from api.models import VirtualMachine

    name = resource.get("name") or f"vm-{guest.vmid}"
    specs = _desired_specs(resource)
    # (enum, human label) as the hypervisor reports them; Proxmox sends neither.
    os_info = (resource.get("os_kind") or "", resource.get("os_name") or "")

    if guest.vm_id is None:
        # Adopt an operator's existing VM of the same name - a non-destructive
        # link, so it happens in every mode.
        adopted = VirtualMachine.objects.filter(
            tenant=source.tenant, name=name
        ).first()
        if adopted is not None and _owned_by_another_source(adopted, source):
            # Two hypervisors, two different machines, one name. VM names are
            # unique per tenant, so adopting would merge them into a single row
            # that both syncs then write to - wrong specs, wrong cluster, wrong
            # host, and no sign anything happened. Leave both alone and say so.
            if warnings is not None:
                warnings.append(
                    f'"{name}" already belongs to another virtualization '
                    f"source, so it was skipped - rename one of them, since a "
                    f"VM name has to be unique"
                )
            return
        if adopted is not None:
            guest.vm = adopted
            guest.created_vm = False
            guest.save(update_fields=["vm", "created_vm"])
            logger.info("adopted existing VM %r for guest %s",
                        adopted.name, guest.vmid)
            _blank_fill(adopted, specs, source, guest, place, os_info)
            _clear_change(guest, "new_guest")
            return
        if apply:
            # No «Synced from …» description: a VM reports its source as a
            # real field, and this one belongs to the operator.
            vm = VirtualMachine.objects.create(
                tenant=source.tenant, name=name, cluster=cluster(),
                **_nonnull(specs),
            )
            guest.vm = vm
            guest.created_vm = True
            guest.save(update_fields=["vm", "created_vm"])
            logger.info("created VM %r (%s vCPU, %s MB)", name,
                        specs.get("vcpus"), specs.get("memory_mb"))
            _blank_fill(vm, {}, source, guest, place, os_info)  # node → device
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
    _blank_fill(vm, {} if guest.created_vm else specs, source, guest, place,
                os_info)


def _reported_ips(entries) -> list:
    """Flatten the hypervisor's per-interface address lists into addresses.

    ``entries`` is the same ``[{"mac": .., "ips": [str, ..]}]`` shape both
    connectors already produce for ``sync_ips``; an ip-scope placement rule
    matches against these strings.
    """
    out = []
    for entry in entries or []:
        for addr in entry.get("ips") or []:
            addr = (addr or "").strip()
            if addr and addr not in out:
                out.append(addr)
    return out


def _nonnull(specs: dict) -> dict:
    return {k: v for k, v in specs.items() if v is not None}


def _blank_fill(vm, specs, source, guest, place=None, os_info=None) -> None:
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
    # Site stays the operator's, but is blank-filled from two sources: a
    # placement rule (or a site named after the datacenter/cluster), and then
    # the cluster's own site when it opts in. Placement is the more specific
    # statement, so it goes first.
    # Platform is opt-in: it mints rows in a catalog the operator curates, and
    # a large estate would produce a lot of them on the first pass.
    if source.sync_platforms and vm.platform_id is None:
        name = _platform_name(*(os_info or ("", "")))
        plat = _platform_for(source.tenant, name) if name else None
        if plat is not None:
            vm.platform = plat
            changed.append("platform")
    _apply_placement(vm, place, changed)
    if vm.site_id is None and vm.cluster_id is not None:
        cl = vm.cluster
        if cl.apply_site_to_vms and cl.site_id is not None:
            vm.site_id = cl.site_id
            changed.append("site")
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
    else:
        logger.info("queued %s change for review: %s",
                    kind, guest.vm.name if guest.vm_id else guest.vmid)
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


_HYPERVISOR_ROLE = ("Hypervisor", "hypervisor")


def _vcenter_folder_paths(client, want: bool) -> dict:
    """``{folder_moref: ["Test site", "Linux"]}`` for every VM/host folder.

    The REST payload carries no parent, so the tree is walked **downward** with
    ``?parent_folders=``. That is one call per folder, which is why it is
    skipped entirely unless the source actually has folder rules. Identity is
    the MoRef, never the name - vCenter happily hosts several folders called
    ``vm``.
    """
    if not want:
        return {}
    try:
        folders = client.get("vcenter/folder") or []
    except VirtAPIError:
        return {}
    parent_of: dict = {}
    for f in folders:
        fid = f.get("folder")
        if not fid:
            continue
        try:
            for kid in client.get(f"vcenter/folder?parent_folders={fid}") or []:
                if kid.get("folder"):
                    parent_of[kid["folder"]] = fid
        except VirtAPIError:
            continue
    name_of = {f.get("folder"): f.get("name") or "" for f in folders}

    paths: dict = {}
    for fid in name_of:
        chain, seen, cur = [], set(), fid
        while cur and cur not in seen:
            seen.add(cur)  # a cycle can't happen, but don't hang if it does
            chain.append(name_of.get(cur, ""))
            cur = parent_of.get(cur)
        paths[fid] = placement.strip_builtin_folders(reversed(chain))
    return paths


def _vcenter_placement_maps(client, source, datacenters, hosts) -> dict:
    """Everything the placement evaluator needs, fetched once per pass.

    Returns ``{"dc_of_vm", "dc_of_host", "folders_of_vm"}``. Each lookup is
    skipped when no rule needs it, so a source with no placement rules pays
    nothing beyond the datacenter list it already has.
    """
    scopes = set(source.placement_rules.values_list("scope", flat=True))
    # The datacenter is also the hierarchy fallback, so it is always useful.
    dc_of_vm: dict = {}
    dc_of_host: dict = {}
    for dc in datacenters:
        dm, dn = dc.get("datacenter"), dc.get("name") or ""
        if not dm:
            continue
        try:
            for v in client.get(f"vcenter/vm?datacenters={dm}") or []:
                dc_of_vm[v.get("vm")] = dn
        except VirtAPIError:
            pass
        try:
            for h in client.get(f"vcenter/host?datacenters={dm}") or []:
                dc_of_host[h.get("host")] = dn
        except VirtAPIError:
            pass

    folders_of_vm: dict = {}
    paths = _vcenter_folder_paths(client, "folder" in scopes)
    for fid, path in paths.items():
        if not path:
            continue  # a built-in folder, or the root
        try:
            for v in client.get(f"vcenter/vm?folders={fid}") or []:
                # Direct membership only - the ancestor chain is the path.
                folders_of_vm[v.get("vm")] = path
        except VirtAPIError:
            continue
    return {"dc_of_vm": dc_of_vm, "dc_of_host": dc_of_host,
            "folders_of_vm": folders_of_vm}


def _apply_placement(obj, place, changed: list) -> None:
    """Blank-fill a resolved site/location onto a Device, Cluster or VM."""
    if place is None or not place.ok:
        return
    if getattr(obj, "site_id", None) is None:
        obj.site = place.site
        changed.append("site")
        logger.info("placed %s %r into site %r (%s)",
                    type(obj).__name__.lower(), str(obj), place.site.name,
                    place.reason)
    if (
        place.location is not None
        and hasattr(obj, "location_id")
        and obj.location_id is None
        # Only inside the site the object actually ended up in.
        and getattr(obj, "site_id", None) == place.site.id
    ):
        obj.location = place.location
        changed.append("location")


# vCenter reports the guest OS as an enum (RHEL_8_64, OTHER_3X_LINUX_64). Short
# all-caps words are acronyms and stay as they are; the rest title-case. Four
# characters is the cut-off that keeps RHEL and SLES while letting OTHER and
# LINUX read normally.
_OS_TRAILING_BITS = {"64": "(64-bit)", "32": "(32-bit)"}


def _platform_name(guest_os: str, full_name: str = "") -> str:
    """A human name for a guest OS.

    vCenter's own label is used when VMware Tools reports one, since it is
    better than anything derived. Otherwise the enum is unpacked mechanically -
    deliberately no 200-row lookup table, because the operator can rename the
    Platform afterwards and the slug keeps it matched.
    """
    full_name = (full_name or "").strip()
    if full_name:
        return full_name[:128]
    parts = [p for p in (guest_os or "").split("_") if p]
    if not parts:
        return ""
    suffix = _OS_TRAILING_BITS.get(parts[-1], "")
    if suffix:
        parts = parts[:-1]
    words = [w if (w.isupper() and len(w) <= 4) else w.title() for w in parts]
    return " ".join([*words, suffix]).strip()[:128]


def _platform_key(name: str) -> str:
    """A loose key for comparing platform names.

    Lowercased, punctuation dropped, and the bit-width suffix removed, so
    "RHEL 8 (64-bit)" and an operator's existing "RHEL 8" are recognised as the
    same platform. Deliberately mild: it will not fold "Windows Server 2019"
    into "Windows Server 2022", because a wrong match is worse than a new row.
    """
    text = re.sub(r"\(?\b(32|64)[- ]?bit\)?", " ", (name or "").lower())
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(text.split())


def _platform_for(tenant, name: str):
    """The Platform row for ``name`` - an existing one wherever possible.

    Order matters. An exact name or slug hit comes first, then a loose match
    against the platforms the tenant already curates, and only then a new row.
    That way a sync joins the operator's catalog instead of growing a parallel
    one beside it, and renaming a platform keeps it matched.
    """
    from api.models import Platform

    slug = slugify(name)[:128]
    if not slug:
        return None
    plat = Platform.objects.filter(
        Q(name__iexact=name) | Q(slug=slug), tenant=tenant
    ).first()
    if plat is not None:
        return plat

    key = _platform_key(name)
    if key:
        for existing in Platform.objects.filter(tenant=tenant).only(
            "id", "name", "slug"
        ):
            if _platform_key(existing.name) == key or (
                _platform_key(existing.slug) == key
            ):
                return existing
    return Platform.objects.create(tenant=tenant, name=name, slug=slug)


def _apply_host_hardware(dev, hw, source) -> list:
    """Blank-fill a host Device from what vim25 reports. Never overwrites.

    Model and vendor become a DeviceType under a Manufacturer, because that is
    how Danbyte models hardware - the alternative would be free text on the
    Device that nothing else can use. The catalog rows are created on demand,
    the same way the sync already creates a ClusterType and a DeviceRole.
    """
    from api.devicetype_import import _get_or_create_manufacturer
    from api.models import DeviceType, Platform

    changed = []
    serial = (hw.get("serial") or "").strip()
    if serial and not dev.serial_number:
        dev.serial_number = serial[:255]
        changed.append("serial_number")

    model = (hw.get("model") or "").strip()
    if model and dev.device_type_id is None:
        # DeviceType has no slug and its unique key is case-sensitive, so match
        # case-insensitively first or a second sync mints a near-duplicate.
        dt = DeviceType.objects.filter(
            tenant=source.tenant, name__iexact=model
        ).first()
        if dt is None:
            vendor = (hw.get("vendor") or "").strip()
            dt = DeviceType.objects.create(
                tenant=source.tenant, name=model, model=model,
                manufacturer=(
                    _get_or_create_manufacturer(source.tenant, vendor)
                    if vendor else None
                ),
            )
        dev.device_type = dt
        changed.append("device_type")

    platform = (hw.get("platform") or "").strip()
    if platform and dev.platform_id is None:
        slug = slugify(platform)[:128] or "esxi"
        plat = Platform.objects.filter(
            Q(name__iexact=platform) | Q(slug=slug), tenant=source.tenant
        ).first()
        if plat is None:
            plat = Platform.objects.create(
                tenant=source.tenant, name=platform, slug=slug
            )
        dev.platform = plat
        changed.append("platform")
    return changed


def _sync_hosts(source, cluster_name: str, hosts, *, placements=None,
                warnings=None) -> int:
    """Create the hypervisor's own nodes/hosts as Devices - opt-in (#34).

    ``hosts`` is ``[{"name": .., "online": bool}]``, normalised by the caller.

    A Device needs only a tenant and a name, so this fills what the hypervisor
    actually reports: name, cluster, status - plus a **site**, when placement
    resolves one from the operator's rules or from a site named after the
    datacenter. It still leaves **device type empty**: nothing on the wire says
    what the hardware is, and guessing would put fiction in the physical
    inventory. Enrich that by hand, or later from Redfish/SNMP.

    Matching is ``name__iexact`` because that is how ``_blank_fill`` already
    finds a host; the uniqueness constraint is case-sensitive, so matching any
    other way would mint a near-duplicate of a host the operator already has.
    Existing Devices are adopted and blank-filled, never overwritten.
    """
    from api.models import Device
    from api.status_registry import resolve_status

    hosts = [h for h in hosts if (h.get("name") or "").strip()]
    if not hosts:
        return 0
    # Materialise the cluster here rather than waiting for a VM to land: when
    # an operator has asked for host Devices, the nodes *are* the cluster, and
    # a host with no cluster on the first pass would be needlessly incomplete.
    cluster = _cluster_for(source, cluster_name)
    made = 0
    role = None
    for h in hosts:
        name = (h.get("name") or "").strip()
        if not name:
            continue
        dev = Device.objects.filter(
            tenant=source.tenant, name__iexact=name
        ).first()
        place = (placements or {}).get(name)
        if dev is None:
            if role is None:
                role = _hypervisor_role(source)
            dev = Device.objects.create(
                tenant=source.tenant, name=name, role=role, cluster=cluster,
                status=resolve_status(
                    source.tenant, "active" if h.get("online") else "offline",
                    "device",
                ),
                description=f"Synced from «{source.name}»",
            )
            made += 1
            logger.info("created host device %r", h.get("name"))
        # Adopted or fresh: blank-fill the cluster link and the resolved site.
        # A Device the operator already models is theirs - nothing is restyled.
        changed = []
        if dev.cluster_id is None:
            dev.cluster = cluster
            changed.append("cluster")
        _apply_placement(dev, place, changed)
        if h.get("hardware"):
            changed += _apply_host_hardware(dev, h["hardware"], source)
        if changed:
            dev.save(update_fields=changed)
        if place is not None and not place.ok and warnings is not None:
            warnings.append(place.reason)
    return made


def _hypervisor_role(source):
    """The *Hypervisor* device role, created on demand.

    Same shape as ``_cluster_for``'s cluster-type handling - a catalog row the
    product needs to function, not illustrative inventory - but without its
    habit of silently defaulting an unrecognised source kind.
    """
    from api.models import DeviceRole

    name, slug = _HYPERVISOR_ROLE
    # Match on either half of the identity: the slug is unique per tenant, so a
    # role already holding it under a different name would collide on create.
    role = DeviceRole.objects.filter(
        Q(name__iexact=name) | Q(slug=slug), tenant=source.tenant
    ).first()
    if role is not None:
        return role
    return DeviceRole.objects.create(
        tenant=source.tenant, name=name, slug=slug,
        description="Hypervisor hosts imported by a virtualization sync.",
    )


def _sync_interfaces(guest, cfg: dict) -> tuple[int, list]:
    """Proxmox NICs → VMInterface. Returns (count, names the hypervisor has)."""
    from api.models import VMInterface

    if guest.vm is None:
        return 0, []
    n = 0
    seen: list = []
    for key, value in (cfg or {}).items():
        if not _NET_KEY.match(str(key)):
            continue
        parsed = _parse_net(str(value))
        name = parsed["name"] or key  # LXC names its NIC; QEMU keeps netX
        # Report what the hypervisor actually said, so _reconcile_interfaces can
        # diff it. Absent keys mean "not reported" and are never treated as
        # disagreement - see _iface_drift.
        seen.append({"name": name, "mac_address": parsed["mac"],
                     "mtu": parsed["mtu"], "vlan_vid": parsed["tag"]})
        iface = VMInterface.objects.filter(vm=guest.vm, name=name).first()
        if iface is None:
            iface = VMInterface.objects.create(
                vm=guest.vm, name=name, mac_address=parsed["mac"],
                mtu=parsed["mtu"], created_interface=True,
            )
            logger.info("created interface %s/%s (%s)", guest.vm.name, name,
                        parsed["mac"] or "no mac")
        else:
            fill = []
            if parsed["mac"] and not iface.mac_address:
                iface.mac_address = parsed["mac"]
                fill.append("mac_address")
            if parsed["mtu"] and iface.mtu is None:
                iface.mtu = parsed["mtu"]
                fill.append("mtu")
            if fill:
                iface.save(update_fields=fill)
        n += 1
    return n, seen


def _sync_ips(source, guest, agent_ifaces, *, nets=None, prefixes=None,
              warnings=None, net_vrfs=None) -> tuple[int, int]:
    """Proxmox guest-agent IPs → the shared attach path (matched by MAC).

    ``nets`` is the same VM config blob the interface/network passes already
    read, so tagging each NIC with the bridge it sits on costs no extra API
    call - ``_parse_net`` hands back mac, bridge and tag in one go.
    """
    net_key_by_mac = {}
    for key, value in (nets or {}).items():
        if not _NET_KEY.match(str(key)):
            continue
        parsed = _parse_net(str(value))
        if not parsed["mac"] or not parsed["bridge"]:
            continue
        tag = parsed["tag"]
        net_key_by_mac[parsed["mac"]] = (
            f"{parsed['bridge']}:{tag}" if tag is not None else parsed["bridge"]
        )
    entries = [
        {
            "mac": entry.get("hardware-address") or "",
            "ips": [i.get("ip-address") or ""
                    for i in (entry.get("ip-addresses") or [])],
            "net_key": net_key_by_mac.get(
                (entry.get("hardware-address") or "").lower()
            ),
        }
        for entry in (agent_ifaces or [])
    ]
    return _attach_ips(source, guest, entries, prefixes=prefixes,
                       warnings=warnings, net_vrfs=net_vrfs)


def _network_vrf_map(source) -> dict:
    """``{ext_key: VRF}`` for the source's networks that state a routing context.

    A network's own VRF wins; otherwise its switch's, which is the switch-wide
    default. A key is **absent** when neither states one - that means "no
    opinion, fall through to the source", which is not the same as Global.
    """
    from .models import VirtNetwork

    out = {}
    rows = VirtNetwork.objects.filter(source=source).select_related(
        "vrf", "vswitch", "vswitch__vrf"
    )
    for n in rows:
        vrf = n.vrf if n.vrf_id else (
            n.vswitch.vrf if n.vswitch_id and n.vswitch.vrf_id else None
        )
        if vrf is not None:
            out[n.ext_key] = vrf
    return out


def _attach_ips(source, guest, entries, *, prefixes=None, warnings=None,
                net_vrfs=None) -> tuple[int, int]:
    """Attach discovered IPs to a VM's interfaces (matched by MAC).

    ``entries`` is a hypervisor-agnostic ``[{"mac": .., "ips": [str, ..]}]``.
    An IP is only recorded when a containing Prefix already exists - sync never
    invents address space - and only ever adopts an unassigned IPAM row.

    Which VRF's prefixes count is decided most-specific-first: the NIC's own
    ``VMInterface.vrf``, then the network/switch it attaches to (``net_vrfs``),
    then the source's policy. Every one of those is operator-set - sync only
    ever *reads* them.

    ``prefixes`` is the tenant's prefix list, hoisted by the caller so it isn't
    rebuilt per guest. Returns ``(attached, skipped)``; unplaceable addresses
    are counted and explained in ``warnings`` rather than silently dropped.
    """
    from api.models import IPAddress, VMInterface

    if guest.vm is None or not entries:
        return 0, 0
    if prefixes is None:
        prefixes = vrf_placement.load_prefixes(source.tenant)
    if warnings is None:
        warnings = []
    source_placement = vrf_placement.Placement.from_policy(source)

    by_mac = {
        (i.mac_address or "").lower(): i
        for i in VMInterface.objects.filter(vm=guest.vm)
        if i.mac_address
    }
    n = 0
    skipped = 0
    first_v4 = None
    for entry in entries:
        mac = (entry.get("mac") or "").lower()
        iface = by_mac.get(mac)
        # Most specific statement wins. Each layer is a hard scope: naming a
        # VRF that turns out to hold nothing skips the address rather than
        # quietly filing it in Global.
        placement = source_placement
        net_vrf = (net_vrfs or {}).get(entry.get("net_key"))
        if net_vrf is not None:
            placement = vrf_placement.Placement(preferred=net_vrf)
        if iface is not None and iface.vrf_id:
            placement = vrf_placement.Placement(preferred=iface.vrf)
        for raw in entry.get("ips") or []:
            try:
                addr = ipaddress.ip_address(raw)
            except ValueError:
                continue
            if addr.is_loopback or addr.is_link_local:
                continue
            row, note = vrf_placement.existing_row(
                source.tenant, str(addr), placement
            )
            if note:
                warnings.append(f"{guest.vm.name}: {note}")
            if row is None:
                placed = vrf_placement.place(
                    source.tenant, str(addr), placement, prefixes=prefixes
                )
                if not placed.ok:
                    # Never invent address space - but say so, rather than
                    # letting the address disappear without a trace.
                    skipped += 1
                    label = f"{guest.vm.name}/{iface.name}" if iface else guest.vm.name
                    warnings.append(f"{label}: {placed.detail}")
                    continue
                try:
                    row = IPAddress.objects.create(
                        tenant=source.tenant, ip_address=str(addr),
                        prefix=placed.prefix,
                        description=f"Synced from «{source.name}»",
                    )
                except IntegrityError:
                    # Same address already recorded in this VRF by a concurrent
                    # pass - nothing to do, and nothing worth failing over.
                    skipped += 1
                    continue
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
    return n, skipped


# ─── VMware vCenter (vSphere Automation REST) ────────────────────────────────

_MOREF_RE = re.compile(r"(\d+)")

def _vc_full_name(info: dict) -> str:
    """VMware Tools' own OS label, when it reports one.

    The field is sometimes a plain string and sometimes a localisable message
    object, so both shapes are handled rather than assuming one.
    """
    fn = ((info or {}).get("identity") or {}).get("full_name")
    if isinstance(fn, dict):
        return (fn.get("default_message") or "").strip()
    return (fn or "").strip()


_VC_POWER = {"POWERED_ON": "running", "POWERED_OFF": "stopped",
             "SUSPENDED": "suspended"}


def _moref_id(moref: str):
    """``vm-1023`` → ``1023``. vCenter MoRefs are stable per VM lifetime, so the
    integer is a safe key for VirtGuest.vmid (a PositiveIntegerField)."""
    m = _MOREF_RE.search(moref or "")
    return int(m.group(1)) if m else None


def _vcenter_resource(summary: dict, info: dict, vmid: int, node: str,
                      cluster: str = "", datacenter: str = "",
                      folders=None) -> dict:
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
        # "" when the guest is on a standalone host - _run_pass falls back to
        # the pass-level cluster name.
        "cluster": cluster,
        # Guest OS, for the optional Platform mapping.
        "os_kind": info.get("guest_OS") or "",
        "os_name": _vc_full_name(info),
        # Placement inputs; empty for Proxmox, which has neither concept.
        "datacenter": datacenter,
        "folders": list(folders or []),
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
        try:
            datacenters = client.get("vcenter/datacenter") or []
        except VirtAPIError:
            datacenters = []
        # Where everything sits, for placement. Folder walking is skipped
        # unless the source actually has folder rules.
        maps = _vcenter_placement_maps(client, source, datacenters, hosts)
        # Port-group type tells a distributed switch from a standard one.
        net_kinds: dict = {}
        net_names: dict = {}
        if source.sync_networks:
            try:
                for net in client.get("vcenter/network") or []:
                    kind = _VC_PORTGROUP_KIND.get(net.get("type") or "")
                    if kind and net.get("name"):
                        net_kinds[net["name"]] = kind
                    # A distributed port group's NIC backing omits the name
                    # and carries only this MoRef - without the map, switch
                    # rows end up called "dvportgroup-1010" (#46).
                    if net.get("network") and net.get("name"):
                        net_names[net["network"]] = net["name"]
            except VirtAPIError:
                pass  # fall back to the connector default

        # Port-group VLANs exist only in the SOAP API - REST states them
        # nowhere, which is why vCenter VMs never got VLAN links (#46). Best
        # effort: without pyvmomi (or with SOAP unreachable) the mapping still
        # works through the direct links, just without VLANs.
        net_vlans: dict = {}
        host_warnings: list[str] = []
        if source.sync_networks:
            from .vsphere_soap import VSphereSoap

            soap_nets = VSphereSoap(source)
            try:
                soap_nets.connect()
                net_vlans = soap_nets.portgroup_vlans()
            except VirtAPIError as exc:
                host_warnings.append(f"Port-group VLANs unavailable: {exc}")
            finally:
                soap_nets.close()

        # Fallback name for guests that belong to no cluster (standalone hosts).
        cluster_name = clusters[0]["name"] if len(clusters) == 1 else source.name

        # Map each VM to the cluster it runs on. The VM summary doesn't carry
        # it, but `?clusters=` filters by it - the same trick the host mapping
        # below already uses. Without this every guest on a multi-cluster
        # vCenter landed in one cluster named after the source.
        cluster_of: dict = {}
        host_cluster: dict = {}
        for cl in clusters:
            cm, cn = cl.get("cluster"), cl.get("name") or ""
            if not cm:
                continue
            try:
                for v in client.get(f"vcenter/vm?clusters={cm}") or []:
                    cluster_of[v.get("vm")] = cn
            except VirtAPIError:
                pass
            try:
                for h in client.get(f"vcenter/host?clusters={cm}") or []:
                    host_cluster[h.get("host")] = cn
            except VirtAPIError:
                pass

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
        counts = {"nodes": len(hosts), "vms": 0, "vms_created": 0, "hosts": 0,
                  "interfaces": 0, "ips": 0, "ips_skipped": 0, "disks": 0,
                  "networks": 0, "pending": 0}

        # Hosts first, so the VM pass can link each guest to its ESXi Device.
        if source.sync_hosts:
            from api.models import Site

            rules = list(
                source.placement_rules.select_related("site", "location").all()
            )
            by_name = {
                st.name.lower(): st
                for st in Site.objects.filter(tenant=source.tenant).only(
                    "id", "name"
                )
            }
            # SOAP first, because it is the only source of a host's management
            # address and an ip-scope rule needs that before placement runs.
            # Still one call: the addresses ride along with the hardware
            # retrieval. Skipped entirely when neither feature is asked for.
            wants_ips = any(r.scope == "ip" for r in rules)
            hw_by_name: dict = {}
            if source.sync_host_hardware or wants_ips:
                from .vsphere_soap import VSphereSoap

                soap = VSphereSoap(source)
                try:
                    soap.connect()
                    hw_by_name = {h["name"]: h for h in soap.hosts()}
                except VirtAPIError as exc:
                    # An ip rule that cannot see addresses would silently place
                    # nothing, so say which capability was lost.
                    host_warnings.append(
                        f"Host hardware unavailable: {exc}" if source.sync_host_hardware
                        else f"Host addresses unavailable, so ip rules cannot match: {exc}"
                    )
                finally:
                    soap.close()

            places = {}
            for h in hosts:
                hn = h.get("name") or ""
                places[hn] = placement.resolve(
                    placement.PlacementPath(
                        datacenter=maps["dc_of_host"].get(h.get("host"), ""),
                        cluster=host_cluster.get(h.get("host")) or "",
                        host=hn,
                        ips=list((hw_by_name.get(hn) or {}).get("ips") or []),
                    ),
                    rules, site_by_name=by_name,
                )

            counts["hosts"] = _sync_hosts(
                source, cluster_name,
                [{"name": h.get("name") or "",
                  "online": h.get("connection_state") == "CONNECTED",
                  "cluster": host_cluster.get(h.get("host")) or "",
                  "hardware": hw_by_name.get(h.get("name") or "")
                  if source.sync_host_hardware else None}
                 for h in hosts],
                placements=places, warnings=host_warnings,
            )

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
                _vcenter_resource(
                    v, info, vmid, host_of.get(moref, ""),
                    cluster_of.get(moref, ""),
                    maps["dc_of_vm"].get(moref, ""),
                    maps["folders_of_vm"].get(moref) or [],
                )
            )
            nics = info.get("nics") or {}
            guest_nets = []
            if v.get("power_state") == "POWERED_ON":
                try:
                    guest_nets = client.get(
                        f"vcenter/vm/{moref}/guest/networking/interfaces"
                    ) or []
                except VirtAPIError:
                    pass  # VMware Tools absent/starting - IPs stay unknown
            details[vmid] = {"ifaces": nics, "ips": guest_nets,
                             "disks": info.get("disks"), "nets": nics,
                             "meta": {"notes": info.get("notes")}}

        return _run_pass(source, cluster_name, resources, details, now, counts,
                         _sync_vcenter_interfaces,
                         partial(_sync_vcenter_ips, net_names=net_names),
                         extra_warnings=host_warnings,
                         sync_disks_fn=_sync_vcenter_disks,
                         sync_nets_fn=partial(_sync_networks_vcenter,
                                              net_kinds=net_kinds,
                                              net_names=net_names,
                                              net_vlans=net_vlans),
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


# vCenter reports what a port-group is attached to, so the switch kind is a
# fact rather than a guess. Anything else (opaque/NSX backings) stays unset.
_VC_PORTGROUP_KIND = {
    "STANDARD_PORTGROUP": "standard",
    "DISTRIBUTED_PORTGROUP": "distributed",
}


def _sync_networks_vcenter(source, cluster, guest, nics, now,
                           net_kinds=None, net_names=None,
                           net_vlans=None) -> int:
    """vCenter NIC backings → VirtualSwitch + VirtNetwork. VLAN tags live on the
    port-group (not the VM NIC), so a VLAN is only linked when the backing
    exposes one; otherwise the network is recorded without a VLAN."""
    if guest.vm is None or not nics:
        return 0
    n = 0
    for key, nic in nics.items():
        nic = nic or {}
        backing = nic.get("backing") or {}
        # Distributed port groups state only the MoRef here; resolve it to the
        # port group's real name so the switch isn't called "dvportgroup-NNN".
        network = (
            backing.get("network_name")
            or (net_names or {}).get(backing.get("network"))
            or backing.get("network")
            or ""
        )
        if not network:
            continue
        # The backing never actually carries vlan_id (kept as a first look for
        # forward compatibility); the real source is the SOAP port-group read.
        tag = backing.get("vlan_id")
        if tag is None:
            tag = (net_vlans or {}).get(network)
        iface_name = nic.get("label") or f"nic-{key}"
        n += _link_network(
            source, cluster, guest, iface_name, network,
            int(tag) if isinstance(tag, int) else None, network, now,
            kind=(net_kinds or {}).get(network),
        )
    return n


def _sync_vcenter_interfaces(guest, nics) -> tuple[int, list]:
    """vCenter NICs → VMInterface. Returns (count, names the hypervisor has)."""
    from api.models import VMInterface

    if guest.vm is None or not nics:
        return 0, []
    n = 0
    seen: list = []
    for key, nic in (nics or {}).items():
        nic = nic or {}
        name = nic.get("label") or f"nic-{key}"
        mac = (nic.get("mac_address") or "").lower()
        # vCenter's VM NIC payload carries no MTU and no speed, so those keys
        # stay absent rather than being reported as empty - a field the
        # hypervisor never states must never read as disagreement. The VLAN
        # arrives separately, through the port group in _link_network.
        seen.append({"name": name, "mac_address": mac})
        iface = VMInterface.objects.filter(vm=guest.vm, name=name).first()
        if iface is None:
            VMInterface.objects.create(
                vm=guest.vm, name=name, mac_address=mac, created_interface=True
            )
            logger.info("created interface %s/%s (%s)", guest.vm.name, name,
                        mac or "no mac")
        elif mac and not iface.mac_address:
            iface.mac_address = mac
            iface.save(update_fields=["mac_address"])
        n += 1
    return n, seen


def _sync_vcenter_ips(source, guest, guest_nets, *, nets=None, prefixes=None,
                      warnings=None, net_vrfs=None,
                      net_names=None) -> tuple[int, int]:
    """vCenter guest-tools IPs → the shared attach path (matched by MAC).

    ``nets`` is the NIC map the interface/network passes already fetched, so
    the port-group each NIC sits on comes free - matching the ``ext_key``
    ``_link_network`` builds.
    """
    net_key_by_mac = {}
    for nic in (nets or {}).values():
        nic = nic or {}
        mac = (nic.get("mac_address") or "").lower()
        backing = nic.get("backing") or {}
        network = (
            backing.get("network_name")
            or (net_names or {}).get(backing.get("network"))
            or backing.get("network")
            or ""
        )
        if not mac or not network:
            continue
        tag = backing.get("vlan_id")
        net_key_by_mac[mac] = (
            f"{network}:{tag}" if isinstance(tag, int) else network
        )
    entries = [
        {
            "mac": gn.get("mac_address") or "",
            "ips": [a.get("ip_address") or ""
                    for a in ((gn.get("ip") or {}).get("ip_addresses") or [])],
            "net_key": net_key_by_mac.get(
                (gn.get("mac_address") or "").lower()
            ),
        }
        for gn in (guest_nets or [])
    ]
    return _attach_ips(source, guest, entries, prefixes=prefixes,
                       warnings=warnings, net_vrfs=net_vrfs)


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
    the VM shell and links it - the specs and NICs fill in on the next detect.
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
    elif change.kind == "iface_change":
        _accept_iface_change(guest, change.detail or {})
    change.delete()


def _accept_iface_change(guest, detail: dict) -> None:
    """Take the hypervisor's values for the interfaces in this change.

    VLAN is reported as a plain tag number, and turning one into a VLAN row is
    ``_link_network``'s job (it owns the site/group scoping and the
    created_vlan bookkeeping). Accepting here re-points the interface at a VLAN
    the tenant already has with that vid, and leaves it alone otherwise rather
    than minting a half-specified one.
    """
    from api.models import VLAN, VMInterface

    if guest.vm is None:
        return
    by_name = {i.name: i for i in VMInterface.objects.filter(vm=guest.vm)}
    for name, diff in (detail.get("interfaces") or {}).items():
        iface = by_name.get(name)
        if iface is None:
            continue
        fields = []
        for field, pair in (diff or {}).items():
            value = pair.get("hypervisor")
            if field == "vlan_vid":
                vlan = VLAN.objects.filter(
                    tenant=guest.source.tenant, vlan_id=value
                ).first()
                if vlan is None:
                    continue
                iface.vlan = vlan
                fields.append("vlan")
            else:
                setattr(iface, field, value)
                fields.append(field)
        if fields:
            iface.save(update_fields=fields)


def ignore_change(change) -> None:
    """Dismiss a change: kept so detection won't re-raise it, hidden from the
    default inbox until it's accepted or the guest disappears."""
    change.ignored = True
    change.save(update_fields=["ignored"])
