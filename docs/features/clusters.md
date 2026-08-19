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
| **Site** | Where the cluster itself lives. It is *not* inherited by its VMs — see below. |
| **Status** | From your status catalog. |
| **Description**, **tags** | Notes and labels. |

Its detail page lists the **virtual machines** on it (with a count on the tab),
plus Journal and History.

!!! note "Cluster site and VM site are independent"
    A cluster's site describes **the cluster**. A VM's site is its own field and
    is **not** derived from its cluster — a VM with no site set simply has no
    site, even when its cluster has one.

    That is deliberate: the compute often lives in one datacentre while the
    workloads belong to the branch or department they serve. Set a VM's site
    when you want it located; leave it blank when only the cluster's location
    matters.

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
