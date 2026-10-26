---
icon: lucide/server-cog
---

# Virtual machines

A **virtual machine** is a first-class object next to devices: it carries its
own interfaces, IP addresses, disks and services, so monitoring, IPAM, config
context and change history all work the same way they do for physical
hardware - a virtual router is checked and SNMP-polled exactly like a switch.

Every VM can be created by hand. If you run Proxmox VE or VMware vCenter, a
[sync](external-sync.md) can import them instead.

## Fields

| Field | Notes |
| --- | --- |
| **Name**, **status** | As for a device - the same status catalog. |
| **Power** | Read-only, from the hypervisor - see [Power state](#power-state). |
| **Role**, **platform** | Also the device catalogs, so one role can span physical and virtual. |
| **Software version** | The version it runs, judged against the platform's [target version](lifecycle.md#software-target). Typed, or read from SNMP `sysDescr` - the Overview shows [where it came from](lifecycle.md#where-the-running-version-comes-from). |
| **Cluster** | The [cluster](clusters.md) it runs on. |
| **Group** | Its [VM group](vm-groups.md) - a vApp, resource pool, folder or one of your own - on the same cluster. Optional. |
| **Host device** | The physical host *inside* that cluster - see [Placement](#placement-site-and-host-device). |
| **Site** | Its own location, independent of the cluster's - see [Placement](#placement-site-and-host-device). |
| **vCPUs**, **Memory**, **Disk** | Resource sizing. Memory is entered in MB, disk in GB. |
| **Primary IP** | The address the VM is reached on; monitoring uses it. |
| **Description**, **tags**, **custom fields** | Free-form notes, labels and your own attributes. |
| **Application groups**, **Profiles** | The [application groups](applications.md#application-groups) and [device profiles](device-profiles.md#on-devices-and-vms) it gets, in order, written with the save. |
| **PRTG** | Only while [PRTG monitoring](prtg.md) is on: **Follow policies** (the default), **Monitor in PRTG** or **Exclude from PRTG** - see [Registering devices and VMs](prtg.md#registering-devices-and-vms). API field `prtg_sync` (`inherit`, `always`, `never`). |

## The detail page

The header carries the VM's status, its power state and, when anything
monitors it, the same monitoring pill as a device's header: the worst state
across its addresses' checks and PRTG. Hovering it shows each source's state
and counts.

**Overview** carries the same **monitoring card** as a device's: with
problems, full width on top with the worst three (each a link to the check or
the PRTG sensor's panel) and a bar per source (checks, PRTG); all clear, one
line beside the first card. **Notify me** watches the primary address - see
[The monitoring bar](monitoring.md#the-monitoring-bar).

**Overview** carries a **Sensors** card on top once a PRTG sensor or
channel is [pinned](prtg.md#pinned-sensors) to the VM (a pinned sensor as a
tile with its state, primary value and the hour's sparkline, a pinned channel
as a small reading tile; a tile opens the sensor's panel, unpinned on hover),
the attribute cards,
a **Software** card under
*Resources* (the first eight installs, each with its version and end-of-life
lifetime bar, then **View all N** to the Software tab), a **Profiles** card
(its [device profiles](device-profiles.md#on-devices-and-vms) with their
state, **Re-apply**, unassign and **Apply profile**), the disk list and the
VM's **Topology** card. Under the platform, **OS support** is its
[lifetime bar](lifecycle.md#the-lifetime-bar): the platform's effective dates,
entered or from its [end-of-life](end-of-life-data.md) cycle; VM tables offer
it as an optional **Next end of life** column (Columns menu,
`lifecycle_next` in the API), sorting by days left. The Topology
card draws the VM's networks as rails, the same drawing as the
[Virtual topology](virtual-switches.md#network-topology). With none mapped,
the card says *No virtual networks yet.* and what to do: run a sync, turn on
**Sync virtual switches & networks** on its source, or give one of its
interfaces a VLAN. Then:

| Tab | What's on it |
| --- | --- |
| **Components** | The VM's interfaces (and their IPs), with a count on the tab. |
| **Services** | Services running on it, from your service templates. |
| **Software** | Applications installed on it, each at a version, with a count on the tab (`install_count` in the API), and its [application groups](applications.md#application-groups). See [Applications & installed software](applications.md). |
| **Flows** | [Application flows](application-flows.md) with an end at one of its addresses, or at a prefix or range that holds one. |
| **Routing** | Static routes and BGP, OSPF, IS-IS and EIGRP instances on the VM - a virtual router's routing, the same as a device's. See [Routing on virtual machines](routing.md#routing-on-virtual-machines). |
| **Monitoring** | Checks against its primary address, same engine as devices (`?state=` filters them, as the monitoring bar does), and one **PRTG** row while PRTG is on, whose chevron opens [in PRTG, managed, registration and planned](prtg.md#planned-changes) with **Register in PRTG**. |
| **Sensors** | Only when [PRTG monitoring](prtg.md#sensors) is on and PRTG has a device for this VM, with the sensor count: the same status strip, sensor cards and sensor panel as a device's. |
| **SNMP** | Facts, the interface table, LLDP neighbours and the ARP table, when the VM answers SNMP. Each SNMP interface is read against the VM's own NICs by name; when the guest names a NIC differently from the hypervisor (`ether1` for `nic0`), set **SNMP name** on the interface and the row maps. |
| **Certificates** | TLS certificates seen on its endpoints. |
| **Config** | The rendered config context for this VM, and the [Oxidized backup](oxidized.md) of a virtual router when that is on. |
| **Journal**, **Change log** | Notes you write, and the automatic change record. |

## Power state

For a VM a [sync](external-sync.md) tracks, Danbyte shows the hypervisor's
reported **power state** - *Powered on*, *Powered off* or *Suspended* - on the
VM's hero, in its Overview with the time the reading was taken, and as a
filterable **Power** column in VM tables.

It is deliberately separate from **Status**, and the distinction matters:

- **Status** is *yours*. It's the lifecycle - staged, active, decommissioning -
  and nothing overwrites it.
- **Power** is the *hypervisor's*. It changes whenever someone shuts a machine
  down.

A VM is routinely **Active and powered off** at the same time; collapsing the
two would make a nightly-shutdown dev box look decommissioned. A VM no sync
tracks shows no power state at all, rather than an unknown-looking dash.

## Placement: site and host device

Two different questions, two different fields:

- **Site** - *where in the world*. This is the VM's **own** field: a cluster in
  your datacentre can host VMs whose site is a branch office, which is usually
  what you want to record, so a cluster's site is not inherited by default. When
  the two really are the same place, tick **Give VMs on this cluster its site**
  on the [cluster](clusters.md#site-and-the-vms-on-it) and it is filled in for
  VMs that have none. A synced VM can also get its site from
  [placement](external-sync.md#where-synced-hosts-and-vms-land), which reads
  the hypervisor's own datacenter/folder/cluster structure. Either way, a
  site's page lists the VMs placed there.
- **Host device** - *which physical machine*. Model the ESXi host or Proxmox
  node as a **Device**, then pick it as the VM's *Host device*. The device's
  own page lists the VMs it hosts.

!!! tip "Host devices link themselves during a sync"
    A sync sets *Host device* automatically whenever a Device exists whose
    **name matches** the host the hypervisor reports.

    You can create those hosts yourself, or tick **Create hosts as devices** on
    the [source](external-sync.md) and let the sync add each hypervisor node as
    a Device - name, cluster, status and, when
    [placement](external-sync.md#where-synced-hosts-and-vms-land) resolves one,
    a site. A *Hypervisor* role is created on demand. It still leaves **device
    type empty**: nothing the hypervisor reports says what the hardware is. A
    host you already model is matched case-insensitively and adopted, never
    duplicated or restyled.

## Interfaces and IP addresses

A **VM interface** mirrors a device interface: name, enabled flag, MAC address,
MTU, speed, and an 802.1Q **VLAN** with an access/trunk mode. Add them from the
VM's **Components** tab. A **Type** distinguishes what it is: a regular
**Virtual** NIC (the default), or a **Tunnel** (WireGuard, GRE, VXLAN, tun),
**Bridge**, or **Loopback** - tunnels and loopbacks carry no MAC or speed, so
the form drops those fields for them. Interfaces can also **nest**: pick a
**Parent interface** (same VM, loops refused) and `wg0` rides under `eth0` -
the table indents children beneath their parent.

IP addresses attach to an interface exactly as on a device. From the VM's
**Components** tab:

- the **+** on an interface row opens the IP form with that VM and interface
  already filled in - use it to record a **new** address;
- **Assign IP** attaches an **existing** address to the VM instead.

You can also set it from the address itself: the IP form has **Virtual
machine** and **VM interface** pickers next to the device ones. Assigning to
the VM without naming an interface is allowed when you only care that the
address belongs to that VM.

A VM interface's `ip_addresses` lists only the addresses the caller may view,
as on a device interface: IP view permission in the active tenant, with its
site scope and row constraints.

The first private IPv4 becomes the VM's **primary IP** when it has none, and
that is what monitoring checks. To choose a different one, tick **Make this
the VM's primary IP** on the address's own form, or set **Primary IP** on the
VM. Unticking the box clears it again.

!!! note "A synced IP needs its prefix to exist first"
    When a hypervisor reports a guest address, Danbyte records it only if a
    **prefix containing it already exists** - the sync never invents address
    space, because nothing in the guest data says what the subnet is. Create
    the prefix, sync again, and the address attaches to its interface.

    Which VRF it looks in is the source's **Address VRF**, overridden per NIC by
    a VRF you set on the **VM interface** - sync reads that field and never
    writes it. See [where synced addresses
    land](external-sync.md#where-synced-addresses-land).

    The sync result says how many addresses it couldn't place, so a missing
    prefix shows up as *"2 addresses unplaced"* rather than as addresses that
    quietly never appear.

    Guest addresses also depend on the in-guest agent (**VMware Tools** or the
    **QEMU guest agent**) and only appear for running VMs.

## Disks

**Virtual disks** are listed on the VM's Overview in a card like the
attribute cards: name, size, the storage pool or datastore they live on, and
their controller. They're descriptive - the VM's
own *Disk* figure is its own field, not a total of these. A sync imports them
when **Sync disks** is enabled on the source.

## What a sync owns, and what you own

For a VM that came from a hypervisor:

- **The hypervisor owns** its existence, its host, its power state, and - in
  *Automatic* mode - its specs (vCPU / RAM / disk).
- **You own** everything else: role, platform, **site**, tags, custom fields,
  description and the primary-IP choice. A sync never overwrites those, in any
  mode.

VMs, interfaces and IPs **you** created are linked and blank-filled, never
overwritten, and never deleted by a sync.

## See also

- [Clusters](clusters.md) - where VMs run.
- [Virtual switches & topology](virtual-switches.md) - how VMs reach the network.
- [Proxmox VE sync](virt-proxmox.md) · [VMware vCenter sync](virt-vcenter.md) ·
  [VMware Cloud Director sync](virt-vcloud.md)
- [Devices](../dcim/devices.md) - the physical counterpart.
