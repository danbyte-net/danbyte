---
icon: lucide/network
---

# Virtual switches & topology

A **virtual switch** is the hypervisor switch a VM's traffic passes through on
its way to the physical network. Danbyte models it on the cluster, records the
networks it carries, and connects it to the **real host NICs** — so a trace can
run from a VM all the way to a cabled port.

## Virtual switches

| Field | What it's for |
| --- | --- |
| **Name** | As the hypervisor knows it (`vSwitch0`, `vmbr0`, …). |
| **Cluster** | The [cluster](clusters.md) it belongs to. |
| **Kind** | Standard switch · Distributed switch · Linux bridge · Open vSwitch · Bond. |
| **Uplinks** | The physical port names the hypervisor reports. |

Its detail page has a **Networks** tab — the port groups / bridges on the
switch, the VLAN each maps to, and the VMs attached to them.

## Uplinks · physical adapters

A switch's uplinks are what tie virtual networking to the physical plant: the
host is a **Device**, and you assign that device's **physical interfaces** as
the switch's uplinks (host device → interface) from the switch's Overview.

This is the vSphere "Physical Adapters" layer. Once set, the uplink traces
straight through to its cabled port, and the topology view shows the adapters
feeding each switch — including the multi-host case, where several hypervisors
contribute ports to one cluster-wide switch.

- **Proxmox** fills these in **automatically**: each bridge's ports are matched
  to the node Device's interfaces. The node must be modelled as a Device with
  those interfaces; matching is additive and never removes an uplink you set.
- **vCenter** doesn't expose standard-switch pNICs cleanly through its REST
  API, so assign those uplinks by hand on the switch page.

## Networks

A **network** is a port group (vCenter) or a tagged bridge (Proxmox), mapped to
a **VLAN** in Danbyte. When a source imports networks, each VLAN-tagged network
becomes a VLAN in a VLAN group named after the source, and a VM interface's
access VLAN is **blank-filled** from it — never overwriting a VLAN you set
yourself.

## Network topology

**Virtualization → Network topology** draws the whole picture in one diagram:

    external network → physical adapters (host NICs) → switches
        → networks (VLANs, as coloured rails) → the VMs on each

Each VM is drawn **once**, with one connector per network it attaches to, so a
multi-homed firewall reads as a single box with several cables rather than
appearing on every rail. Rail colour follows the [VLAN's own
colour](ipam-objects.md#vlans), falling back to its zone's colour and then to a
palette shade. Every node clicks through to its object, and a VM's own page
shows the same diagram scoped to that VM.

Switches, networks and the topology are populated when **Sync virtual switches
& networks** is enabled on a source; you can also create switches by hand.

## See also

- [Virtual machines](virtual-machines.md) · [Clusters](clusters.md)
- [Proxmox VE sync](virt-proxmox.md) · [VMware vCenter sync](virt-vcenter.md)
- [VLANs](ipam-objects.md#vlans) — what the networks map onto.
