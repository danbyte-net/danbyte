---
icon: lucide/boxes
---

# Clusters, types & groups

A **cluster** is the compute that [virtual machines](virtual-machines.md) run
on — a vSphere cluster, a Proxmox cluster, or however you group your
hypervisors. It's also where a VM's location comes from, so it's usually the
only place you need to set a site.

## Clusters

| Field | What it's for |
| --- | --- |
| **Name** | The cluster's label. |
| **Type** | What kind of cluster it is (see below). |
| **Group** | Optional grouping across clusters. |
| **Site** | Where the cluster physically lives — the VMs on it are located here. |
| **Status** | From your status catalog. |
| **Description**, **tags** | Notes and labels. |

Its detail page lists the **virtual machines** on it (with a count on the tab),
plus Journal and History.

!!! tip "Set the site once, on the cluster"
    A VM has its own site field, but you rarely need it: give the cluster a
    site and everything on it is located there. Use the per-VM field only for
    the exception — a VM that sits somewhere other than its cluster.

## Cluster types

A **cluster type** records the platform: *VMware vCenter*, *Proxmox VE*,
*Hyper-V*, *KVM* — whatever you run. It's an ordinary catalog with a name, slug
and description, and it's yours to define: following the **zero pre-filled
data** rule, none ship with the product.

A [sync](external-sync.md) creates the one type it needs on demand (*Proxmox
VE* or *VMware vCenter*) so importing works on a fresh install, and reuses it
afterwards.

## Cluster groups

A **cluster group** organises clusters into a tree — by region, environment or
tenant of the platform, for example *Production*, *Lab*, *DR*. Like cluster
types it's a name, slug and description, and it never gates access; it's
navigation and reporting metadata only.

!!! warning "Delete order"
    A cluster type or group that's still referenced can't be deleted. Move the
    clusters off it first.

## See also

- [Virtual machines](virtual-machines.md) — what runs on a cluster.
- [Virtual switches & topology](virtual-switches.md) — a cluster's networking.
- [Sites](../dcim/index.md) — the physical location a cluster points at.
