---
icon: lucide/boxes
---

# Proxmox VE sync

Danbyte imports a Proxmox® Virtual Environment cluster's inventory into the
existing cluster/VM model - agentless, over the Proxmox VE REST API. Enable
the **Proxmox VE sync** toggle under **Settings → Integrations** and add a
source under **Integrations → Virtualization sources**; see
[External sync](external-sync.md) for the shared ground rules.

## The connection

- **Host** - any cluster node's address works: the API answers cluster-wide.
  Default API port `8006`.
- **Auth** - an **API token** (Datacenter → Permissions → API Tokens);
  the `PVEAuditor` role is enough for read sync. Reading SDN also needs
  `SDN.Audit` on `/sdn` (`PVEAuditor` on `/` includes it). The secret is
  encrypted at rest and write-only.
- **Address VRF** - the routing context guest addresses land in; see [where
  synced addresses land](external-sync.md#where-synced-addresses-land).
- **Test connection** reports the reachable node count and API version.

## What syncs in

| Proxmox object | Danbyte object |
| --- | --- |
| Cluster | **Cluster** (a *Proxmox VE* cluster type is created on demand) |
| QEMU / LXC guest | **Virtual machine** (vCPUs, memory, disk, description) |
| Resource pool | **[VM group](vm-groups.md)** on the cluster, kind *Resource pool* - on by default |
| Guest tags (`prod;web`) | **Tags** (added, never removed; colors from the cluster's tag color-map, blank-fill only) |
| Notes | **Description** (blank-filled, never overwrites yours) |
| Guest NIC (`netX`) | **VM interface** with its MAC |
| Disk (`scsiN`/`virtioN`/…) | **Virtual disk** (name, size, storage, controller) - *opt-in* |
| Bridge + VLAN tag (`vmbr0,tag=42`) | **VLAN** (in the source's VLAN group) + the interface's access VLAN - *opt-in* |
| Bridge / OVS switch | **Virtual switch** - *opt-in* |
| SDN zone · VNet | **Virtual switch** of kind *SDN zone* · **network** under it - *opt-in*, with networks |
| Guest-agent IP | **IP address** assigned to the interface |
| `ostype` | **Platform** - *opt-in* (*Set platform from the guest OS*). QEMU's enum maps to readable names (`l26` → *Linux 6.x/2.6 Kernel*, `win11` → *Windows 11/2022/2025*); LXC distro identifiers are title-cased (`debian` → *Debian*). Matches an existing platform before minting one, and `other` sets nothing. |
| Node | linked to the **Device** of the same name |

Guest identity uses the Proxmox integer **VMID** as the stable id.

### Matching NICs to VM interfaces

A guest NIC is matched to an existing VM interface by **MAC** first (case and
separator ignored, so `AA:BB:…` and `aa-bb-…` are one address), then by the
hypervisor's name (`net0`, or the LXC NIC name), and only then created. An
interface you named after the device port (`gi1`) with the NIC's MAC is
therefore the same interface as `net0`: it keeps your name and is blank-filled
and diffed as usual. A NIC the sync created on a VM it owns follows a rename
on the hypervisor; an intended VM's and your own interface names are never
changed.

When two interfaces of one VM already share a NIC's MAC, the sync does not
guess: it matches by name and the pass warns, naming the interfaces and
which of them the sync added. The sync never deletes them - remove the
duplicate (usually the `netN` one) yourself. Duplicates left by an earlier
release, where a port-named interface was given a second `netN` twin, show
up this way.


### Allowed networks - keeping container noise out

A guest running containers (Docker, Podman) reports every bridge and overlay
address it owns - easily 50-100 per host - and each one either lands in IPAM
or raises an unmatched-prefix warning. Two guards:

- **Allowed networks** on the source: a CIDR list (one per line). When set,
  guest-reported IPs are only recorded when they fall inside one of the
  networks; everything else is dropped **silently** - no warnings, no sync
  errors. Empty = record everything a prefix matches, as before.
- **Ignore IPs from sync** on a VM interface: the per-NIC hammer for when the
  noisy addresses share a subnet with real ones - sync records nothing from
  that NIC, whatever the allow-list says.

## Disks, switches, networks and hosts (opt-in)

Per-source switches widen what a source imports:

- **Sync disks** (on by default) - each VM's virtual disks become **Virtual
  disk** rows (shown on the VM's Overview): name, size, storage pool, and
  controller. Optical drives are skipped.
- **Sync virtual switches & networks** (off by default) - bridges / OVS
  switches become **Virtual switch** rows, and each VLAN-tagged network
  becomes a **VLAN** in a VLAN group named after the source. A VM interface's
  access VLAN is **blank-filled** from the bridge tag (never overwriting a
  VLAN you set).
- **Create hosts as devices** (off by default) - each hypervisor node becomes
  a **Device**: name, cluster and status, with a *Hypervisor* role created on
  demand. Device type and site are left empty - nothing on the wire says what
  they are. A host you already model is matched **case-insensitively** and
  adopted, never duplicated. This is what lets VMs link to their host, and
  what gives bridge uplinks a Device to hang NICs off.
- **Sync pools as VM groups** (on by default) - each guest's **resource
  pool** becomes a [VM group](vm-groups.md) of kind *Resource pool* on the
  cluster. Membership is read from the `pool` field `cluster/resources`
  already returns, so it costs no extra request. A guest in no pool has no
  group.

### SDN zones and VNets

With **Sync virtual switches & networks** on, the sync also reads
`cluster/sdn/zones` and `cluster/sdn/vnets`:

- each **zone** becomes a virtual switch of kind **SDN zone** on the cluster;
- each **VNet** becomes a network under its zone, keeping its tag (a VLAN id
  in a vlan zone, a VNI in a vxlan or evpn zone), alias and zone. No VLAN is
  created for the tag. A VNet with no NIC on it still gets its network;
- a VM NIC whose bridge is a VNet links to that network, the same as a NIC on
  a bridge. A VNet seen earlier as a plain bridge moves under its zone, and the
  bridge switch the sync made for it is removed when nothing else uses it.

If the token cannot read SDN (no `SDN.Audit`, or a release without SDN), the
pass skips SDN and says so on the **Skipped** tab; everything else syncs as
usual. A pass reports `sdn_zones` and `sdn_vnets` in its counts. Proxmox
lists only the zones and VNets the token may see, so a token scoped to some
zones reads only those.

### Cables from VNets

**Cables from VNets** (off by default, shown with networks sync) turns a VNet
into a cable. A VNet with exactly two NICs on this source's VMs becomes a
cable between the interfaces of the devices those VMs are (**Is router** on
the VM). A NIC is matched to a device interface by MAC (the interface's own
MAC or its MAC addresses), then by name (`net1`, or the LXC NIC name). The new
cable has the VNet as its [Proxmox VNet](../dcim/cabling.md#proxmox-vnet) and
the description *Synced from «source» (VNet …)*. It is made in every sync
mode: turning the setting on is the consent.

A cable that is already there is never changed or deleted. When it joins the
same two ports and has no VNet, the VNet is filled in; anything else is
reported on the **Skipped** tab and left alone:

- a VNet with one NIC, or more than two;
- a VM with no device, or a NIC with no matching interface;
- a port already cabled to something else, or a cable naming another VNet;
- a cable made from a VNet that no longer joins its two ports.

A pass reports `vnet_cables_created`, `vnet_cables_matched` and
`vnet_findings` in its counts.

Once networks are synced, each **virtual switch** page has a **Networks** tab
and **Maps → Virtual topology** draws the whole picture - switches,
their networks (VLANs) as bars, and the VMs on each.

### Uplinks - filled automatically

A switch's **Uplinks · physical adapters** link the switch to the real host
NICs. For Proxmox these are filled **automatically**: each bridge's
`bridge_ports` are matched to the node Device's interfaces - a cluster-wide
bridge collects the ports from every host (the multi-hypervisor case). The
node must be modelled as a Device carrying those interfaces - tick **Create
hosts as devices** and the sync does the Device half for you, leaving only the
interfaces. Matching is additive and never removes an uplink you set.

## Sync mode - who is the source of truth

- **Automatic (mirror)** - the sync applies everything on a schedule: new VMs
  created, specs updated, vanished guests removed. **Proxmox is the source of
  truth.**
- **Review** (default) - polls on a schedule but only **detects**; changes
  land in a review inbox and apply on **Accept**. **Danbyte stays the source
  of truth.**
- **Manual** - like Review, but detection runs only when you press **Sync**.

A new source defaults to **Review**, so a fresh connection never reshapes
your inventory before you've seen what it would do.

## What each side owns

- **Proxmox owns** a VM's existence, its node, power state, and - in
  Automatic mode - its specs (vCPU/RAM/disk).
- **You own** everything else: role, platform, tags, custom fields,
  description, site, and the primary-IP choice. The sync never overwrites
  those in any mode.
- On an [intended VM](#intended-vms) you own its specs, NICs, disks and
  existence too.

Rules:

- VMs, interfaces and IPs you already have are linked and blank-filled, never
  overwritten - and never deleted by sync. Only sync-created objects are
  removed (Automatic) or offered as removals (Review/Manual) when their guest
  disappears.
- Guest IPs come from the **QEMU guest agent**, so they only appear for
  running VMs with the agent installed. An IP is only created when a
  **containing prefix** already exists - sync never invents address space.
  Which VRF's prefixes count is the source's **Address VRF**; addresses it
  can't place are reported as *unplaced* and listed on the Last sync badge. See
  [where synced addresses land](external-sync.md#where-synced-addresses-land).
  The first private IPv4 becomes the VM's primary IP (if it had none).
- VM templates are skipped; the sync is read-only - Danbyte never changes the
  hypervisor.

## Network plan

A Proxmox source's **Network plan** tab works out what SDN should look like
from the cables between its VMs, and compares it with what the last sync saw.
It is read-only: Danbyte lists the plan and something else - a runner, a
script, a person - applies it.

A cable is in the plan when each end is one interface on a device that a VM
of this source is (**Is router**). It wants the VNet in its [Proxmox
VNet](../dcim/cabling.md#proxmox-vnet) field. A cable with none gets a name
from the source's **VNet name pattern** when one is set - `c{n:04}` gives
`c0042` for cable #42 - marked *Suggested*; the cable is not changed. Each end
is matched to a VM NIC by MAC, then by name, then to the one NIC of the VM
already on the wanted VNet.

| Section | What it lists |
| --- | --- |
| **VNets to create** | Wanted VNets the last sync did not see: name, zone (the source's **VNet zone**), tag and the cables that want it. The tag is the lowest free one in the source's **VNet tag range** (`1000-1999`) among the zone's VNets; blank range, no tag. |
| **Wrong VNet** | NICs on another VNet or bridge than their cable wants: VM, NIC (`net1`), interface, current, wanted, MAC and cable. |
| **No VNet** | NICs whose cable names no VNet and gets none from the pattern. |
| **Unused VNets** | VNets in the source's zone (or any zone, when none is set) that no cable wants and no NIC sits on. Report only. |
| **Issues** | VNets named by more than one cable, interfaces with no matching NIC, a pattern that gives an invalid id, an exhausted tag range, and cables left out (an end that is not a VM of this source, or several ports on one end). |

Pick a device to see only its VM and the VMs it is cabled to; **JSON**
downloads the plan (or that slice). The same plan is
`GET /api/virtualization-sources/<id>/network-plan/`, with `?device=<id>` to
scope it and `?format=json` for a download. It needs `view` on the source and
lists only the VMs, devices and cables the reader may view, so a site-scoped
user sees the plan of their own sites. The plan reads what the last sync
recorded; it makes no call to Proxmox.

Response keys: `vnets_to_create`, `nics_wrong_vnet`, `nics_without_vnet`,
`unused_vnets`, `duplicates`, `conflicts`, `cables_skipped`, `counts`,
`notes`, plus `source`, `device`, `zone` and `generated_at`.

## Intended VMs

An [intended VM](virtual-machines.md#intended-vms) is one Danbyte holds the
intent for. Every rule here applies only with **Intended** ticked; any other
VM syncs exactly as above.

| Rule | What the sync does |
| --- | --- |
| **Adopt** | A new guest links to the intended VM whose **VMID** is its own (one per cluster; a cluster of the same name breaks a tie), then to a VM of the same name. A VM without the flag is never matched by VMID. |
| **Re-link on rebuild** | When the guest an intended VM was linked to has gone - absent from this pass, or flagged missing on another source - and a new guest matches it by VMID or name, the stale tracking row is dropped and the new guest linked. The VM itself is untouched. While the old guest is still reported, the new one is skipped with a warning, as for any duplicate name. Rebuilt with the same VMID, the link simply carries on. |
| **Diff, never apply** | vCPU, memory, disk, name and VMID differences are raised as **Specs changed** for review - in Automatic mode too, and even for a VM the sync created. NIC **MAC**, **MTU**, **VLAN**, **model**, **bridge** and **index** differences are raised as **Interface fields differ**. Accepting one takes the hypervisor's value. |
| **Blank-fill** | Empty fields are still filled: specs, host, VMID, and each NIC's model, bridge and index (from `netN`). Filling a blank is not a disagreement. A NIC is found by MAC first, so an interface named after the device port (`gi1`) is filled, not duplicated - see [Matching NICs](#matching-nics-to-vm-interfaces). |
| **Never delete** | The VM is never deleted or offered for removal, whatever the mode, **Prune** setting or delay. Its tracking row stays with the time it went missing, and the VM page says **Not on any hypervisor**. A removal queued before the VM was ticked keeps the VM when accepted. |
| **Never prune** | No NIC or disk of an intended VM is pruned, even one the sync created; a NIC the hypervisor no longer has is raised as **Interface not on hypervisor**. |

Ticking **Intended** on a VM the sync created sets nothing else: it keeps
its history, and the flag wins in every rule above.

A sync pass reports `vms_missing_intended` and `vms_relinked` in its counts.

### The rebuild flow

1. Mark the router's VM **Intended**, set **Is router**, the VMID, image,
   CPU type and storage, and each NIC's index, model and bridge.
2. Your runner - a script, AWX or a webhook consumer - reads the VM from
   `GET /api/virtual-machines/<id>/` (or a render of it), or receives it
   through [Provision](iac-runner.md#provisioning-an-intended-vm), and
   builds it on Proxmox with its own credentials.
3. The next sync adopts the new guest by VMID or name and re-links it; any
   difference between what was built and the intent shows as drift.

!!! tip "Virtual routers become monitorable"
    Once a virtual router's IP is synced, the monitoring engine can check and
    SNMP-poll it like any other address - no special handling needed.

## See also

- [VMware vCenter sync](virt-vcenter.md) ·
  [VMware Cloud Director sync](virt-vcloud.md) - the sibling connectors.
- [External sync](external-sync.md) - toggles, allowlist, where things live.
- [Virtual machines](virtual-machines.md) · [Clusters](clusters.md) · [Virtual switches](virtual-switches.md) - the objects a sync fills in.

---

Proxmox® is a registered trademark of Proxmox Server Solutions GmbH. Danbyte
is not affiliated with or endorsed by them.
