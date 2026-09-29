---
icon: lucide/network
---

# Virtual switches & topology

A **virtual switch** is the hypervisor switch a VM's traffic passes through on
its way to the physical network. Danbyte models it on the cluster, records the
networks it carries, and connects it to the **real host NICs** - so a trace can
run from a VM all the way to a cabled port.

## Virtual switches

| Field | What it's for |
| --- | --- |
| **Name** | As the hypervisor knows it (`vSwitch0`, `vmbr0`, …). |
| **Cluster** | The [cluster](clusters.md) it belongs to. |
| **Kind** | Standard switch · Distributed switch · Linux bridge · Open vSwitch · Bond. Read from the hypervisor where it says (vCenter reports the port-group type), otherwise inferred from the connector. |
| **Uplinks** | The physical port names the hypervisor reports. |

Its detail page has a **Networks** tab - the port groups / bridges on the
switch, the VLAN each maps to, and the VMs attached to them.

## Uplinks · physical adapters

A switch's uplinks are what tie virtual networking to the physical plant: the
host is a **Device**, and you assign that device's **physical interfaces** as
the switch's uplinks (host device → interface) from the switch's Overview.

This is the vSphere "Physical Adapters" layer. Once set, the uplink traces
straight through to its cabled port, and the topology view shows the adapters
feeding each switch.

A switch that spans hosts legitimately carries several hosts' adapters: a
cluster-wide bridge collects the matching ports from **every** node, so one
switch can show `eno1` on `pve1` and `eno1` on `pve2` side by side. Each entry
names its host device, so it stays clear which port belongs where.

- **Proxmox** fills these in **automatically**, per bridge - not per host: it
  reads each bridge's own port list (`bridge_ports` / `ovs_ports`) and matches
  those names to interfaces on **that node's** Device. So `vmbr0` with
  `bridge_ports eno1 eno2` gets exactly those two; a NIC that belongs to no
  bridge is never linked. Nothing is guessed - the node must exist as a Device
  carrying interfaces with matching names, and ticking **Create hosts as
  devices** on the source creates the Device half for you. Matching is
  additive, so an uplink you set by hand is never removed.
- **vCenter** doesn't expose standard-switch pNICs cleanly through its REST
  API, so assign those uplinks by hand on the switch page.

## Routing context (VRF)

A switch's **Address VRF** says which VRF's prefixes a synced address on it may
land in. It exists at two levels because one vSwitch normally trunks many VLANs
and the routing domain follows the **segment**, not the switch:

| Where | Meaning |
| --- | --- |
| **Switch → Address VRF** | The default for every network on it. |
| **Networks tab → VRF** | An override for that port group / bridge. |

Empty means *no opinion* - not Global. A network with no VRF follows its
switch; a switch with none follows the [sync source](external-sync.md). So
`vmbr0` can default to *prod* while `vmbr0:30` overrides to *dmz*, and the
Networks tab shows which value is inherited.

Both are read **live** at sync time, so changing one takes effect on the next
pass with nothing to backfill - and neither is ever written by a sync. A VRF set
on a **VM interface** is more specific still and wins for that NIC. The full
order, and what happens when nothing matches, is in [where synced addresses
land](external-sync.md#where-synced-addresses-land).

## Networks

A **network** is a port group (vCenter) or a tagged bridge (Proxmox), mapped to
a **VLAN** in Danbyte. When a source imports networks, each VLAN-tagged network
becomes a VLAN in a VLAN group named after the source, and a VM interface's
access VLAN is **blank-filled** from it - never overwriting a VLAN you set
yourself.

Prefer your own VLANs instead: tick **Match existing VLANs by ID** on the
source and a tagged network first looks for a VLAN you already have with that
VLAN ID - ungrouped first, then by group name - and links to it, bringing the
prefixes on it along through the prefix's own VLAN field. Only when nothing
matches does the sync mint a VLAN in the source's group, and only those minted
rows are ever pruned. Toggling it on later migrates on the next sync: a network
still linked to its own minted VLAN is re-pointed at the matching real one
(the network keeps its hypervisor name; only the VLAN link moves), and NICs
the sync parked on the minted copy follow it. A VLAN you assigned to a network
by hand is never re-pointed. The now-unused minted VLAN stays in the source's
group for you to delete - the sync never removes a VLAN something might still
reference.

## Virtual topology {#network-topology}

**Maps → Virtual topology** (also the **Virtual topology** button on the
Virtual switches list) draws the whole picture in one diagram:

    external network → physical adapters (host NICs) → switches
        → networks (VLANs, as colored rails) → the VMs on each

Each VM is drawn **once**, with one connector per network it attaches to, so a
multi-homed firewall reads as a single card with several cables rather than
appearing on every rail. Rail color follows the [VLAN's own
color](ipam-objects.md#vlans), falling back to its zone's color and then to a
palette shade, and a rail wears its VLAN's status as a pill after its name.
Each switch heads its networks, with its host NICs at the right end. VMs are
the topology Diagram's cards, dashed: their role's color, the name bold, the
status pill in the top-left corner. Every switch, network, VM and host NIC
is a link to its page that you can reach with Tab, and a name cut short
shows whole on hover or focus. A **Legend** in the corner keys the roles,
the rails, VMs and host NICs. A VM's own page shows the same diagram scoped
to that VM, as its **Topology** card, with the switch at each rail's right
end. The ⓘ beside the title sums this up.

The second bar has **Copy link** and **Export** - PNG, SVG, PDF, Print and
draw.io, drawn the way the topology page's [Logical
export](topology.md#export) is.

Switches, networks and the topology are populated when **Sync virtual switches
& networks** is enabled on a source; you can also create switches by hand.
Until then the page says *No virtual networks yet.* and names that setting.

Pick a source in the header (**Any source** shows them all) to scope the
diagram to it. The choice is on the address (`?source=<id>`), so a single
cluster's picture is a link, and an export names it among its filters.

`GET /api/virt-networks/` feeds the diagram: each network's `vlan` carries
its `status`, and each of its `vms` its `status_mini` and `role`
(`{id, name, color}`) beside the status name and the `iface` that rides the
network.

The same rail diagram drives the [topology page's **Logical**
view](topology.md), which widens the picture to the whole L2 domain -
physical device interfaces and VM interfaces on shared VLAN rails.

## See also

- [Virtual machines](virtual-machines.md) · [Clusters](clusters.md)
- [Proxmox VE sync](virt-proxmox.md) · [VMware vCenter sync](virt-vcenter.md) ·
  [VMware Cloud Director sync](virt-vcloud.md)
- [VLANs](ipam-objects.md#vlans) - what the networks map onto.
