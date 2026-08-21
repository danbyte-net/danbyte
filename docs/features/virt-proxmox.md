---
icon: lucide/boxes
---

# Proxmox VE sync

Danbyte imports a Proxmox cluster's inventory into the existing cluster/VM
model - agentless, over the Proxmox REST API. Enable the **Virtualization
sync** toggle and add a source under **Integrations → Virtualization
sources**; see [External sync](external-sync.md) for the shared ground rules.

## The connection

- **Host** - any cluster node's address works: the API answers cluster-wide.
  Default API port `8006`.
- **Auth** - an **API token** (Datacenter → Permissions → API Tokens);
  the `PVEAuditor` role is enough for read sync. The secret is encrypted at
  rest and write-only.
- **Address VRF** - the routing context guest addresses land in; see [where
  synced addresses land](external-sync.md#where-synced-addresses-land).
- **Test connection** reports the reachable node count and API version.

## What syncs in

| Proxmox object | Danbyte object |
| --- | --- |
| Cluster | **Cluster** (a *Proxmox VE* cluster type is created on demand) |
| QEMU / LXC guest | **Virtual machine** (vCPUs, memory, disk, description) |
| Guest tags (`prod;web`) | **Tags** (added, never removed; colors from the cluster's tag color-map, blank-fill only) |
| Notes | **Description** (blank-filled, never overwrites yours) |
| Guest NIC (`netX`) | **VM interface** with its MAC |
| Disk (`scsiN`/`virtioN`/…) | **Virtual disk** (name, size, storage, controller) - *opt-in* |
| Bridge + VLAN tag (`vmbr0,tag=42`) | **VLAN** (in the source's VLAN group) + the interface's access VLAN - *opt-in* |
| Bridge / OVS switch | **Virtual switch** - *opt-in* |
| Guest-agent IP | **IP address** assigned to the interface |
| `ostype` | **Platform** - *opt-in* (*Set platform from the guest OS*). QEMU's enum maps to readable names (`l26` → *Linux 6.x/2.6 Kernel*, `win11` → *Windows 11/2022/2025*); LXC distro identifiers are title-cased (`debian` → *Debian*). Matches an existing platform before minting one, and `other` sets nothing. |
| Node | linked to the **Device** of the same name |

Guest identity uses the Proxmox integer **VMID** as the stable id.


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

Once networks are synced, each **virtual switch** page has a **Networks** tab
and **Virtualization → Network topology** draws the whole picture - switches,
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

!!! tip "Virtual routers become monitorable"
    Once a virtual router's IP is synced, the monitoring engine can check and
    SNMP-poll it like any other address - no special handling needed.

## See also

- [VMware vCenter sync](virt-vcenter.md) - the sibling connector.
- [External sync](external-sync.md) - toggles, allowlist, where things live.
- [Virtual machines](virtual-machines.md) · [Clusters](clusters.md) · [Virtual switches](virtual-switches.md) - the objects a sync fills in.
