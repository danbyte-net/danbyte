---
icon: lucide/group
---

# VM groups

A **VM group** is a named set of [virtual machines](virtual-machines.md)
below one [cluster](clusters.md): a Cloud Director **vApp**, a Proxmox
**resource pool**, a vCenter **folder**, or a group you make yourself. It
carries a name, a kind, a description, tags and custom fields. It never gates
access.

It exists because some platforms have no flat VM list at all. In Cloud
Director every machine lives in a vApp, so without groups the structure an
operator reads their own console by would be lost on import.

## Where to find them

- **Virtualization → VM groups** - every group, with filters for kind,
  cluster and site. A group has no site of its own; it shows its cluster's.
- A group's page - **Overview** (kind, cluster, site, VM count, custom
  fields), **Virtual machines**, **Journal** and **Change log**.
- A cluster's **VM groups** tab - that cluster's groups, with **Add VM
  group** pre-set to the cluster.
- The **Group** column on the VM list, filterable like any other, and the
  **Group** field on a VM's form and Overview.
- Global search finds groups by name; `cluster:` narrows by cluster.

## Kinds

| Kind | Comes from |
| --- | --- |
| *vApp* | [Cloud Director sync](virt-vcloud.md#vapps-and-vm-groups) |
| *Resource pool* | [Proxmox VE sync](virt-proxmox.md) |
| *Folder* | [vCenter sync](virt-vcenter.md) |
| *Group* | made by hand |

The kind is a label, so the word on screen matches the console you compare
against. You can set it on a group you make yourself.

## Rules

- **A VM joins only a group on its own cluster.** The VM form offers the
  selected cluster's groups. Moving a VM to another cluster drops its old
  group; a group cannot move to another cluster while it has VMs.
- **Names are unique per cluster.** The same name on two clusters is two
  groups - a vCenter folder that spans clusters becomes one group per cluster.
- **Deleting a group leaves its VMs alone.** They stay, without a group.

## Groups a sync writes

Synced groups follow the same rule as synced clusters: they are ordinary,
editable objects, and the sync finds them again **by cluster and name**.

- Description, tags and custom fields are yours to edit, and a sync never
  touches them.
- **Rename a synced group and the next pass makes a new one** with the
  hypervisor's name, because that name is the key. VMs the sync created move
  to it in Automatic mode; VMs you adopted keep the renamed group. Rename the
  pool, folder or vApp at the source instead.
- **Delete a synced group and the next pass recreates it** if the hypervisor
  still reports it.

Membership follows the hypervisor only for VMs the sync created, in
Automatic mode - into another group or out of one. Anything else is
blank-fill: a VM with no group gets the hypervisor's, and a VM you grouped by
hand keeps your grouping. A group of kind *Group* is never cleared by a sync.

Each source has a **Sync … as VM groups** switch (on by default). Turning it
off stops new groups and memberships; it removes nothing already written.

## See also

- [Clusters, types & groups](clusters.md) - the cluster a group sits on.
- [External sync](external-sync.md#vm-groups-pools-folders-and-vapps) - the
  per-source switch and what each connector maps.
- [Virtual machines](virtual-machines.md) - the members.
