---
icon: lucide/boxes
---

# Clusters, types & groups

A **cluster** is the compute that [virtual machines](virtual-machines.md) run
on - a vSphere cluster, a Proxmox cluster, or however you group your
hypervisors. It's also where a VM's location comes from, so it's usually the
only place you need to set a site.

## Clusters

| Field | What it's for |
| --- | --- |
| **Name** | The cluster's label. |
| **Type** | What kind of cluster it is (see below). |
| **Group** | Optional grouping across clusters. |
| **Site** | Where the cluster itself lives. Not inherited by its VMs unless you tick the option below. |
| **Give VMs on this cluster its site** | Opt-in: fills the cluster's site into VMs that have none. |
| **Status** | From your status catalog. |
| **Description**, **tags** | Notes and labels. |

Its detail page lists the **virtual machines** on it (with a count on the tab),
plus Journal and Change log.

### Site, and the VMs on it

A cluster's site describes **the cluster**. By default it is **not** inherited:
a VM's site is its own field, and a VM with none simply has none even when its
cluster has one.

That default is deliberate - the compute often lives in one datacentre while
the workloads belong to the branch or department they serve, and that is what
you want recorded.

Where the two really are the same place, tick **Give VMs on this cluster its
site**:

- Saving the cluster **backfills** VMs on it that have no site.
- New VMs added to it - by hand or by a [sync](external-sync.md) - get the site
  as they arrive.
- It is **blank-fill only**: a site you set on a VM is never overwritten, and
  clearing the cluster's site later never clears the VMs'.
- A site-scoped user can then see those VMs, so turn it on deliberately.

Either way, a site's own page has a **Virtual machines** tab, which answers both
questions separately: **Placed here** (VMs whose own site is this one) and
**Hosted by clusters here** (VMs running on a cluster at this site that carry no
site of their own).

## Cluster types

A **cluster type** records the platform: *VMware vCenter*, *Proxmox VE*,
*Hyper-V*, *KVM* - whatever you run. It's an ordinary catalog with a name, slug
and description, and it's yours to define: following the **zero pre-filled
data** rule, none ship with the product.

A [sync](external-sync.md) creates the one type it needs on demand (*Proxmox
VE* or *VMware vCenter*) so importing works on a fresh install, and reuses it
afterwards.

## Cluster groups

A **cluster group** organises clusters into a tree - by region, environment or
tenant of the platform, for example *Production*, *Lab*, *DR*. Like cluster
types it's a name, slug and description, and it never gates access; it's
navigation and reporting metadata only.

!!! warning "Delete order"
    A cluster type or group that's still referenced can't be deleted. Move the
    clusters off it first.

## See also

- [Virtual machines](virtual-machines.md) - what runs on a cluster.
- [Virtual switches & topology](virtual-switches.md) - a cluster's networking.
- [Sites](../dcim/index.md) - the physical location a cluster points at.
