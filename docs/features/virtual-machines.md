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
| **Software version** | The version it runs, judged against the platform's [target version](lifecycle.md#software-target). Typed, or read from SNMP `sysDescr` or an Oxidized config - the Overview shows [where it came from](lifecycle.md#where-the-running-version-comes-from). |
| **Cluster** | The [cluster](clusters.md) it runs on. |
| **Group** | Its [VM group](vm-groups.md) - a vApp, resource pool, folder or one of your own - on the same cluster. Optional. |
| **Host device** | The physical host *inside* that cluster - see [Placement](#placement-site-and-host-device). |
| **Site** | Its own location, independent of the cluster's - see [Placement](#placement-site-and-host-device). |
| **vCPUs**, **Memory**, **Disk** | Resource sizing. Memory is entered in MB, disk in GB. |
| **Primary IP** | The address the VM is reached on; monitoring uses it. |
| **Description**, **tags**, **custom fields** | Free-form notes, labels and your own attributes. Custom fields are checked on save as on devices: a required one must have a value, a choice must be one of its choices, and an object field must point at an object of this tenant. |
| **Application groups**, **Profiles** | The [application groups](applications.md#application-groups) and [device profiles](device-profiles.md#on-devices-and-vms) it gets, in order, written with the save. |
| **PRTG** | Only while [PRTG monitoring](prtg.md) is on: **Follow policies** (the default), **Monitor in PRTG** or **Exclude from PRTG** - see [Registering devices and VMs](prtg.md#registering-devices-and-vms). API field `prtg_sync` (`inherit`, `always`, `never`). |
| **Intended**, **Is router**, build fields | Danbyte holds this VM's intent, and the device it *is*. See [Intended VMs](#intended-vms). |

## The detail page

Opened from the VM list, the page draws at once from the list's row, and the
VM's own read (`GET /api/virtual-machines/<id>/`) fills in the tab counts
when it lands - the counts come from the one query that reads the VM.

The header carries the VM's status, its power state and, when anything
monitors it, the same monitoring pill as a device's header: the worst state
across its addresses' checks and PRTG. Hovering it shows each source's state
and counts.

The header's **Connect** menu is the device one: the enabled [connect
protocols](device-access.md#connect-protocols) filled from the VM (`{host}`
is its primary IP, `{username}` one of its credentials' usernames) and, when
the [in-browser SSH terminal](device-access.md#the-in-browser-ssh-terminal)
is on, **Open web terminal**. It shows to holders of the **connect**
permission on *Virtual machines*; the device verb does not reach VMs. The
terminal authenticates with an SSH credential from the **Credentials** card
on the Monitoring tab and verifies the VM's SSH host keys (Certificates tab).

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
| **IPs** | Every address the VM uses: assigned to it, to one of its interfaces, or set as its primary address while assigned elsewhere, with **Assign IP** and **+ Add IP**. **Designation** marks the primary; **Assigned to** shows *This VM*, the interface (a link to Components) or the other object. The tab count and the Overview's **IP addresses** count the same set (`ip_count`, `?virtual_machine=` on [the IP list](../models/ip-address.md#addresses-a-device-or-vm-uses)). |
| **Components** | The VM's interfaces (and their IPs), with a count on the tab. |
| **Services** | Services running on it, from your service templates. |
| **Software** | Applications installed on it, each at a version, with a count on the tab (`install_count` in the API), and its [application groups](applications.md#application-groups). See [Applications & installed software](applications.md). |
| **Flows** | [Application flows](application-flows.md) with an end at one of its addresses, or at a prefix or range that holds one. |
| **Routing** | Static routes and BGP, OSPF, IS-IS and EIGRP instances on the VM - a virtual router's routing, the same as a device's. See [Routing on virtual machines](routing.md#routing-on-virtual-machines). |
| **Monitoring** | Checks against its primary address, same engine as devices (`?state=` filters them, as the monitoring bar does), and one **PRTG** row while PRTG is on, whose chevron opens [in PRTG, managed, registration and planned](prtg.md#planned-changes) with **Register in PRTG** and **Add to PRTG now**. |
| **Sensors** | Only when [PRTG monitoring](prtg.md#sensors) is on, with the sensor count: the same status strip, sensor cards and sensor panel as a device's, and before PRTG has sensors for the VM the same state cards (excluded, not in PRTG, planned with **Add to PRTG now**, needs attention, being added, no sensors yet). |
| **SNMP** | Facts, the interface table, LLDP neighbours and the ARP table, when the VM answers SNMP. Each SNMP interface is read against the VM's own NICs by name; when the guest names a NIC differently from the hypervisor (`ether1` for `nic0`), set **SNMP name** on the interface and the row maps. |
| **Certificates** | TLS certificates seen on its endpoints, and its [SSH host keys](../monitoring/ssh-host-keys.md#virtual-machines-and-discovery). |
| **Config** | The rendered config context for this VM, with its sources in merge order, and the [Oxidized backup](oxidized.md) of a virtual router when that is on. The VM form's **Config context → Local context data** (`local_context_data` in the API) is merged last, over every matching context - see [Local context data](config-contexts.md#local-context-data). |
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
their controller. The VM's own *Disk* figure is its own field, not a total
of these. A sync imports them when **Sync disks** is enabled on the source.

Disks are editable: add, edit and delete them on the Overview, or through
`/api/virtual-disks/` (`vm_id`, `key` such as `scsi0`, `name`, `size_gb`,
`storage`, `controller`, `disk_format`, `description`; `?vm=<id>` lists one
VM's). The key is unique per VM. Tenant and site come through the VM, and
the permissions are the **Virtual disks** object type's. A sync prunes only
the disks it created itself, and never an [intended](#intended-vms) VM's.

## Intended VMs

Tick **Intended** on a VM when Danbyte holds its intent - a virtual router
you rebuild from Danbyte alone. A [sync](external-sync.md) then compares the
hypervisor against it, but never rewrites it:

- it is adopted by its **VMID** (Proxmox), then by name;
- spec, VMID and NIC differences are always raised as drift for review, in
  *Automatic* mode too, and even when the sync created the VM;
- blank fields are still filled in, as on any adopted VM;
- it is never deleted or proposed for removal, and its NICs and disks are
  never pruned. When its guest is gone the page says **Not on any
  hypervisor** (`missing_since` in the API);
- rebuilt with a new VMID, the new guest is linked to it once the old one
  has gone.

The rules in full are in [Proxmox VE sync](virt-proxmox.md#intended-vms).

| Field | API | Notes |
| --- | --- | --- |
| **Intended** | `intended` | Off by default. Ticking it on a synced VM changes nothing else. |
| **Is router** | `represents_device` (read), `represents_device_id` (write) | The [device](../dcim/devices.md) this VM *is*, as opposed to **Host device**, the host it runs on. Same tenant, never its own host, one VM per device. A site-scoped user can only pick a device of their own sites. The device's page links back to it as **Backing VM** (`backing_vm` on the device's own read). |
| **VMID** | `vmid` | The hypervisor id to build it with. Unique per cluster. |
| **CPU type**, **Sockets** | `cpu_type`, `sockets` | `host`, `x86-64-v2-AES`, … *vCPUs* stays the total. |
| **Image** | `image` | A template VMID or name, or a cloud image (`local:import/debian-13.qcow2`). Free text: the runner reads it. |
| **Storage** | `storage` | The default for disks that name none. |
| Hypervisor options | `hypervisor_options` | API only: an object of the long tail (`machine`, `bios`, `agent`, `onboot`), passed through and never compared. |

Each interface also carries its **Index** (`index`, Proxmox `netN`, unique
per VM), **Model** (`model`: `virtio`, `e1000`, `e1000e`, `vmxnet3`,
`rtl8139`), **Bridge** (`bridge`, the Linux bridge or SDN VNet, free text)
and `firewall`. The Components tab shows them as columns.

The VM list filters on `?intended=true|false`, `?represents_device=<id>`
and `?vmid=<n>`.

On an intended VM's page the Overview has a **Build** card with these
fields, and a **Drift** card with what the hypervisor reports where it
differs from the intent.

Any VM with open drift - intended or synced - shows the **Drift** card on
its Overview and at the top of its Components tab: one row per field, with
what Danbyte holds and what the hypervisor reports. The **N drift** badge
in the header names the fields on hover and opens the Components tab.
With change rights on virtualization changes, each item has **Use
hypervisor's** (write the hypervisor's values into Danbyte; for an interface
the hypervisor no longer reports, **Delete interface**) and **Keep
Danbyte's** (dismiss the item until the hypervisor's value changes again).
Overwriting an intended VM or deleting an interface asks first. Neither
writes to the hypervisor.

### Building it: render and provision

A rebuild script reads everything from the API: the VM with its
`interfaces` and `disks`, or a [render](export-templates.md#rendering-one-vm)
of it. A device render also carries `backing_vm`, the build of the VM the
device runs as.

**Provision** on an intended VM's header sends it to an
[automation target](iac-runner.md#provisioning-an-intended-vm) that takes
virtual machines: the runner builds it on the hypervisor. Danbyte never
calls a hypervisor's write API. It needs the **provision** permission on
virtual machines, and each request is written to the change log.

## What a sync owns, and what you own

For a VM that came from a hypervisor:

- **The hypervisor owns** its existence, its host, its power state, and - in
  *Automatic* mode - its specs (vCPU / RAM / disk).
- **You own** everything else: role, platform, **site**, tags, custom fields,
  description and the primary-IP choice. A sync never overwrites those, in any
  mode.
- On an [intended](#intended-vms) VM you also own its specs, NICs and disks,
  and its existence.

VMs, interfaces and IPs **you** created are linked and blank-filled, never
overwritten, and never deleted by a sync.

## Editing several at once

Tick VMs on the list, or **Select all**, and use **Edit** on the selection
bar. It sets the same value on every ticked VM: **status**, **role**,
**platform**, **cluster**, **group**, **host device**, **site**,
**description** and **PRTG**, plus **add tags**, **remove tags** and the
tenant's VM [custom fields](tags-and-custom-fields.md). A field left on
**Keep current** is not touched and **Clear** empties it. A custom field
you leave unticked keeps each VM's own value, as do the custom fields the
dialog does not show. Name, primary IP and sizing stay per VM. More than
1000 VMs go 1000 at a time (see
[Large selections](table-preferences.md#large-selections)).

Each value is checked as an edit of that VM checks it: a status VMs do not
offer, an object from another tenant or outside your sites, a group on
another cluster, a value a custom field does not take, or clearing a
required custom field. One bad value refuses the whole edit and nothing is
written. The edit only touches the VMs you may change; any others in the
selection are left out. A site-scoped user cannot move a VM to a site
outside their own.

The edit does what saving each VM would do: moving VMs to another cluster
drops a group that belongs to the old one, a VM left without a site takes
its cluster's when the cluster
[gives VMs its site](clusters.md#site-and-the-vms-on-it), and changing
**PRTG** plans the change for PRTG straight away. Each changed VM gets its
own [change log](change-log.md) entry.

The edit is `POST /api/virtual-machines/bulk-update/`, and
`GET /api/virtual-machines/bulk-edit-fields/` lists its fields - see
[API: Bulk calls](../reference/api.md#bulk-calls). It needs the **change**
permission on virtual machines.

## Deleting virtual machines

**Delete** in the VM's header, or tick VMs on the list and use **Delete**
on the selection bar (`POST /api/virtual-machines/bulk-delete/`), which
first shows what would go. When a VM is linked to a PRTG device, both offer
**Also remove from PRTG** - see
[PRTG: Deleting and retiring](prtg.md#deleting-and-retiring).

## See also

- [Clusters](clusters.md) - where VMs run.
- [Virtual switches & topology](virtual-switches.md) - how VMs reach the network.
- [Proxmox VE sync](virt-proxmox.md) · [VMware vCenter sync](virt-vcenter.md) ·
  [VMware Cloud Director sync](virt-vcloud.md)
- [Devices](../dcim/devices.md) - the physical counterpart.
