---
icon: lucide/layers-3
---

# VMware vCenter sync

Danbyte imports a vCenter's inventory into the existing cluster/VM model —
agentless, over the vSphere Automation REST API (`/api/`), one login session
per sync pass. Enable the **Virtualization sync** toggle and add a source
under **Integrations → Virtualization sources**; see
[External sync](external-sync.md) for the shared ground rules.

## The connection

- **Host** — the vCenter Server FQDN or IP. Default API port `443`.
- **Auth** — an **SSO username and password** (a read-only role is enough for
  inventory sync). Credentials are encrypted at rest and write-only.
- **Address VRF** — the routing context guest addresses land in; see [where
  synced addresses land](external-sync.md#where-synced-addresses-land).
- **Test connection** reports the reachable host and VM counts. vSphere's REST
  list endpoints carry no version string, so no version is shown.

## What syncs in

| vCenter object | Danbyte object |
| --- | --- |
| Cluster (single-cluster vCenters; else the source name) | **Cluster** (a *VMware vCenter* cluster type is created on demand) |
| Virtual machine | **Virtual machine** (vCPUs, memory, disk, description) |
| VM annotation | **Description** (blank-filled, never overwrites yours) |
| Ethernet adapter | **VM interface** with its MAC |
| Virtual disk device | **Virtual disk** (name, size, datastore, controller) — *opt-in* |
| Port-group VLAN | **VLAN** (in the source's VLAN group) + the interface's access VLAN — *opt-in* |
| Standard / distributed switch | **Virtual switch** — *opt-in* |
| VMware Tools reported IP | **IP address** assigned to the interface |
| ESXi host | linked to the **Device** of the same name |

Guest identity uses the VM **MoRef**, whose numeric part is the stable id.

## Disks, switches, networks and hosts (opt-in)

Per-source switches widen what a source imports:

- **Sync disks** (on by default) — each VM's virtual disks become **Virtual
  disk** rows (shown on the VM's Overview): name, size, datastore, and
  controller. Optical drives are skipped.
- **Sync virtual switches & networks** (off by default) — standard and
  distributed switches become **Virtual switch** rows, and each VLAN-tagged
  port-group becomes a **VLAN** in a VLAN group named after the source. A VM
  interface's access VLAN is **blank-filled** from the port-group tag (never
  overwriting a VLAN you set).
- **Create hosts as devices** (off by default) — each ESXi host becomes
  a **Device**: name, cluster and status, with a *Hypervisor* role created on
  demand. Device type and site are left empty — nothing on the wire says what
  they are. A host you already model is matched **case-insensitively** and
  adopted, never duplicated. This is what lets VMs link to their host, and
  what gives bridge uplinks a Device to hang NICs off.

Once networks are synced, each **virtual switch** page has a **Networks** tab
and **Virtualization → Network topology** draws the whole picture — switches,
their networks (VLANs) as bars, and the VMs on each.

### Uplinks — assigned by hand (for now)

A switch's **Uplinks · physical adapters** link the switch to the real host
NICs — the ESXi host is a Device, and you assign its physical interfaces as
the switch's uplinks. This is the vCenter "Physical Adapters" layer: the
uplink traces straight through to its cabled port, and the topology shows the
adapters feeding each switch. The vSphere REST API doesn't expose
standard-switch pNICs cleanly, so assign uplinks **inline on the switch
page** for now.

## Sync mode — who is the source of truth

- **Automatic (mirror)** — the sync applies everything on a schedule: new VMs
  created, specs updated, vanished guests removed. **vCenter is the source of
  truth.**
- **Review** (default) — polls on a schedule but only **detects**; changes
  land in a review inbox and apply on **Accept**. **Danbyte stays the source
  of truth.**
- **Manual** — like Review, but detection runs only when you press **Sync**.

A new source defaults to **Review**, so a fresh connection never reshapes
your inventory before you've seen what it would do.

## What each side owns

- **vCenter owns** a VM's existence, its host, power state, and — in
  Automatic mode — its specs (vCPU/RAM/disk).
- **You own** everything else: role, platform, tags, custom fields,
  description, site, and the primary-IP choice. The sync never overwrites
  those in any mode.

Rules:

- VMs, interfaces and IPs you already have are linked and blank-filled, never
  overwritten — and never deleted by sync. Only sync-created objects are
  removed (Automatic) or offered as removals (Review/Manual) when their guest
  disappears.
- Guest IPs come from **VMware Tools**, so they only appear for running VMs
  with Tools present. An IP is only created when a **containing prefix**
  already exists — sync never invents address space. Which VRF's prefixes count
  is the source's **Address VRF**; addresses it can't place are reported as
  *unplaced* and listed on the Last sync badge. See [where synced addresses
  land](external-sync.md#where-synced-addresses-land). The first private IPv4
  becomes the VM's primary IP (if it had none).
- VM templates are skipped; the sync is read-only — Danbyte never changes the
  hypervisor.

## See also

- [Proxmox VE sync](virt-proxmox.md) — the sibling connector.
- [External sync](external-sync.md) — toggles, allowlist, where things live.
- [Virtual machines](virtual-machines.md) · [Clusters](clusters.md) · [Virtual switches](virtual-switches.md) — the objects a sync fills in.
