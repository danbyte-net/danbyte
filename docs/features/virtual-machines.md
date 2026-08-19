---
icon: lucide/server-cog
---

# Virtual machines

A **virtual machine** is a first-class object next to devices: it carries its
own interfaces, IP addresses, disks and services, so monitoring, IPAM, config
context and change history all work the same way they do for physical
hardware — a virtual router is checked and SNMP-polled exactly like a switch.

Every VM can be created by hand. If you run Proxmox VE or VMware vCenter, a
[sync](external-sync.md) can import them instead.

## Fields

| Field | Notes |
| --- | --- |
| **Name**, **status** | As for a device — the same status catalog. |
| **Power** | Read-only, from the hypervisor — see [Power state](#power-state). |
| **Role**, **platform** | Also the device catalogs, so one role can span physical and virtual. |
| **Cluster** | The [cluster](clusters.md) it runs on. |
| **Host device** | The physical host *inside* that cluster — see [Placement](#placement-site-and-host-device). |
| **Site** | Its own location, independent of the cluster's — see [Placement](#placement-site-and-host-device). |
| **vCPUs**, **Memory**, **Disk** | Resource sizing. Memory is entered in MB, disk in GB. |
| **Primary IP** | The address the VM is reached on; monitoring uses it. |
| **Description**, **tags**, **custom fields** | Free-form notes, labels and your own attributes. |

## The detail page

**Overview** carries the attribute cards, the disk list and a per-VM network
diagram. Then:

| Tab | What's on it |
| --- | --- |
| **Components** | The VM's interfaces (and their IPs), with a count on the tab. |
| **Services** | Services running on it, from your service templates. |
| **Monitoring** | Checks against its addresses, same engine as devices. |
| **SNMP** | Interface tables and polling, when the VM answers SNMP. |
| **Certificates** | TLS certificates seen on its endpoints. |
| **Config** | The rendered config context for this VM. |
| **Journal**, **History** | Notes you write, and the full change log. |

## Power state

For a VM a [sync](external-sync.md) tracks, Danbyte shows the hypervisor's
reported **power state** — *Powered on*, *Powered off* or *Suspended* — on the
VM's hero, in its Overview with the time the reading was taken, and as a
filterable **Power** column in VM tables.

It is deliberately separate from **Status**, and the distinction matters:

- **Status** is *yours*. It's the lifecycle — staged, active, decommissioning —
  and nothing overwrites it.
- **Power** is the *hypervisor's*. It changes whenever someone shuts a machine
  down.

A VM is routinely **Active and powered off** at the same time; collapsing the
two would make a nightly-shutdown dev box look decommissioned. A VM no sync
tracks shows no power state at all, rather than an unknown-looking dash.

## Placement: site and host device

Two different questions, two different fields:

- **Site** — *where in the world*. This is the VM's **own** field: a cluster in
  your datacentre can host VMs whose site is a branch office, which is usually
  what you want to record, so a cluster's site is not inherited by default. When
  the two really are the same place, tick **Give VMs on this cluster its site**
  on the [cluster](clusters.md#site-and-the-vms-on-it) and it is filled in for
  VMs that have none. Either way, a site's page lists the VMs placed there.
- **Host device** — *which physical machine*. Model the ESXi host or Proxmox
  node as a **Device**, then pick it as the VM's *Host device*. The device's
  own page lists the VMs it hosts.

!!! tip "Host devices link themselves during a sync"
    A sync sets *Host device* automatically whenever a Device exists whose
    **name matches** the host the hypervisor reports.

    You can create those hosts yourself, or tick **Create hosts as devices** on
    the [source](external-sync.md) and let the sync add each hypervisor node as
    a Device — name, cluster and status, with a *Hypervisor* role created on
    demand. It deliberately leaves **device type and site empty**: nothing the
    hypervisor reports says what they are, and those are yours to decide. A
    host you already model is matched case-insensitively and adopted, never
    duplicated or restyled.

## Interfaces and IP addresses

A **VM interface** mirrors a device interface: name, enabled flag, MAC address,
MTU, speed, and an 802.1Q **VLAN** with an access/trunk mode. Add them from the
VM's **Components** tab.

IP addresses attach to an interface exactly as on a device. From the VM's
**Components** tab:

- the **+** on an interface row opens the IP form with that VM and interface
  already filled in — use it to record a **new** address;
- **Assign IP** attaches an **existing** address to the VM instead.

You can also set it from the address itself: the IP form has **Virtual
machine** and **VM interface** pickers next to the device ones. Assigning to
the VM without naming an interface is allowed when you only care that the
address belongs to that VM.

The first private IPv4 becomes the VM's **primary IP** when it has none, and
that is what monitoring checks.

!!! note "A synced IP needs its prefix to exist first"
    When a hypervisor reports a guest address, Danbyte records it only if a
    **prefix containing it already exists** — the sync never invents address
    space, because nothing in the guest data says what the subnet is. Create
    the prefix, sync again, and the address attaches to its interface.

    Which VRF it looks in is the source's **Address VRF**, overridden per NIC by
    a VRF you set on the **VM interface** — sync reads that field and never
    writes it. See [where synced addresses
    land](external-sync.md#where-synced-addresses-land).

    The sync result says how many addresses it couldn't place, so a missing
    prefix shows up as *"2 addresses unplaced"* rather than as addresses that
    quietly never appear.

    Guest addresses also depend on the in-guest agent (**VMware Tools** or the
    **QEMU guest agent**) and only appear for running VMs.

## Disks

**Virtual disks** are listed on the VM's Overview: name, size, the storage pool
or datastore they live on, and their controller. They're descriptive — the VM's
own *Disk* figure is its own field, not a total of these. A sync imports them
when **Sync disks** is enabled on the source.

## What a sync owns, and what you own

For a VM that came from a hypervisor:

- **The hypervisor owns** its existence, its host, its power state, and — in
  *Automatic* mode — its specs (vCPU / RAM / disk).
- **You own** everything else: role, platform, **site**, tags, custom fields,
  description and the primary-IP choice. A sync never overwrites those, in any
  mode.

VMs, interfaces and IPs **you** created are linked and blank-filled, never
overwritten, and never deleted by a sync.

## See also

- [Clusters](clusters.md) — where VMs run.
- [Virtual switches & topology](virtual-switches.md) — how VMs reach the network.
- [Proxmox VE sync](virt-proxmox.md) · [VMware vCenter sync](virt-vcenter.md)
- [Devices](../dcim/devices.md) — the physical counterpart.
