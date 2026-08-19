---
icon: lucide/server-cog
---

# Virtual machines & clusters

Danbyte models virtual infrastructure alongside the physical: a **cluster**
groups the compute, **virtual machines** run on it, and each VM carries its own
interfaces, IP addresses, disks and services — the same objects a physical
device has, so monitoring, IPAM, services and change history work the same way
for both.

Everything here can be created by hand. If you run Proxmox VE or VMware
vCenter, the [sync](external-sync.md) can import it instead — see
[Proxmox VE](virt-proxmox.md) and [VMware vCenter](virt-vcenter.md).

## Clusters

A **cluster** is where VMs live. It carries:

| Field | What it's for |
| --- | --- |
| **Name** | The cluster's label. |
| **Type** | *Proxmox VE*, *VMware vCenter*, or whatever you define — a catalog you own. |
| **Group** | Optional grouping across clusters (e.g. by region or purpose). |
| **Site** | Where the cluster physically is. |
| **Status, description, tags** | The usual classification. |

Its detail page lists the **virtual machines** on it, plus Journal and History.

**Cluster types** and **cluster groups** are ordinary catalogs — following the
[zero pre-filled data](../index.md) rule, none ship with the product. A sync
creates the type it needs (*Proxmox VE* / *VMware vCenter*) on demand.

## Virtual machines

A VM carries identity, placement, resources and its network:

| Field | Notes |
| --- | --- |
| **Name**, **status**, **role**, **platform** | As for a device — the same catalogs. |
| **Cluster** | The cluster it runs on. |
| **Host device** | The physical host *within* the cluster (see below). |
| **Site** | Where it is — see [Placement](#placement-site-and-host-device). |
| **vCPUs**, **memory**, **disk** | Resource sizing. |
| **Primary IP** | The address the VM is reached on; used by monitoring. |
| **Description, tags, custom fields** | Free-form and your own attributes. |

Its detail page has **Components** (interfaces and disks), **Services**,
**Monitoring**, **SNMP**, **Certificates**, **Config**, **Journal** and
**History** — the same shape as a device, so a virtual router is monitored and
SNMP-polled exactly like a physical one.

### Placement: site and host device

Two separate things decide "where is this VM":

- **Site** — set it on the **cluster** and everything in that cluster is
  located there, or set it **per VM** when one sits somewhere else.
- **Host device** — the physical machine inside the cluster (an ESXi host or a
  Proxmox node). Model that host as a **Device** in Danbyte, then pick it as
  the VM's *Host device*.

!!! tip "Host devices link themselves during a sync"
    A sync sets *Host device* automatically when a Device already exists whose
    **name matches** the ESXi host / Proxmox node reported by the hypervisor.
    It never creates the Device for you — physical inventory needs a device
    type, role and site, which are yours to decide. Create the hosts once with
    matching names and every VM lands on the right one from then on.

## Interfaces and IP addresses

A **VM interface** mirrors a device interface: name, enabled flag, MAC, MTU,
speed, and an 802.1Q **VLAN** (access or trunk). Add one from the VM's
**Components** tab.

IP addresses attach to an interface exactly as they do on a device — **Add IP**
or **Assign IP** from the VM, or from the address itself. The first private
IPv4 becomes the VM's **primary IP** if it has none, and that's what monitoring
checks and what the VM row shows.

!!! note "Synced IPs need a prefix first"
    When a hypervisor reports a guest address, Danbyte only records it if a
    **prefix containing it already exists** — the sync never invents address
    space. Create the prefix, re-sync, and the address attaches to its
    interface. See [Proxmox VE](virt-proxmox.md) / [vCenter](virt-vcenter.md)
    for the per-hypervisor detail.

## Disks

**Virtual disks** are listed on a VM's Overview: name, size, storage pool or
datastore, and controller. They're informational — the VM's own *disk* figure
is its own field, not a sum of these. A sync imports them when **Sync disks**
is on for the source.

## Virtual switches & networks

A **virtual switch** models a hypervisor switch (a vSphere standard or
distributed switch, a Proxmox bridge or OVS switch) on a cluster. Its page
shows the **networks** on it — the port groups / bridges, mapped to the VLANs
they carry — and its **uplinks**.

**Uplinks · physical adapters** connect the virtual switch to the real host
NICs: the host is a Device, and you assign its physical interfaces as the
switch's uplinks, so a trace runs from a VM all the way to a cabled port.

**Virtualization → Network topology** draws the whole picture: external network
→ physical adapters → switches → networks (VLANs) as coloured rails → the VMs
on each. A multi-homed VM appears once, with one connector per attachment. A
VM's own page shows the same view scoped to that VM.

Virtual switches and networks are imported when **Sync virtual switches &
networks** is on for a source; Proxmox uplinks are matched automatically from
each bridge's ports.

## What a sync owns, and what you own

If a VM came from a hypervisor:

- **The hypervisor owns** its existence, its host, power state, and — in
  *Automatic* mode — its specs (vCPU / RAM / disk).
- **You own** everything else: role, platform, **site**, tags, custom fields,
  description and the primary-IP choice. A sync never overwrites those, in any
  mode.

VMs, interfaces and IPs you created yourself are linked and blank-filled, never
overwritten, and never deleted by a sync.

## See also

- [External sync overview](external-sync.md) — toggles and shared rules.
- [Proxmox VE sync](virt-proxmox.md) · [VMware vCenter sync](virt-vcenter.md)
- [Devices](../dcim/devices.md) — the physical counterpart.
- [Monitoring](monitoring.md) — checks and SNMP work the same for VMs.
