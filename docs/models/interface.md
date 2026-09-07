---
icon: lucide/workflow
---

# Interface

A network port on a [device](site.md) - physical (a switch port, a NIC) or
virtual (a sub-interface, LAG, loopback). Interfaces terminate
[cables](../dcim/cabling.md), carry [IP addresses](ip-address.md) and
[VLANs](vlan.md), and are what monitoring, discovery, and the topology views
reason about.

## Fields

### Device

The device this interface belongs to. An interface's name must be unique on
its device.

### Name

The port's name (`GigabitEthernet0/1`, `eth0`). On create, a `[a-b]` range in
the name fans out into one interface per number.

### Type

The media type (`1000base-t`, `10gbase-x-sfpp`, …) from the standard
taxonomy. Drives the faceplate rendering and the speed-capability colouring.

### Enabled

Administratively up. Disabled interfaces render dashed on faceplates.

### Description

Free-text note shown on rows and the detail page.

### Tags

Tenant-scoped [tags](tag.md).

## Switching & routing

### 802.1Q mode

How the port handles VLAN tagging: **Access** (one untagged VLAN),
**Tagged** (a native VLAN plus tagged VLANs), or **Tagged (all)** (carries
every VLAN). Blank for routed ports.

### Untagged VLAN

The access / native [VLAN](vlan.md).

### Tagged VLANs

The VLANs carried tagged on a trunk. Only valid in *Tagged* mode.

### VRF

The [VRF](vrf.md) this interface routes in. Empty = the Global table.

## State

### Status

Lifecycle status from the tenant's [status catalog](../features/catalogs-and-settings.md),
distinct from **Enabled** (the admin flag the device reports). Seeded values:
Active, Disabled, Planned, Not present, Decommissioning. Empty reads as
Active. **Not present** marks hardware the agent reports as absent - a
pre-allocated stack port or an empty slot; SNMP sync sets it automatically
when the *Import pre-allocated ports* setting is on. Not present and
Decommissioning ports are excluded from port-utilization capacity entirely.

### Management only

Out-of-band management port; excluded from data-plane views.

### Mark connected

A cable is physically in the port but not documented yet. Counts as
connected in [port utilization](../dcim/devices.md#the-device-page) and
clears itself when a real cable is attached.

### Reservation

A [port reservation](port-reservation.md) holding this (uncabled) port -
who claimed it, the note, and since when. Read-only here; managed through
the reserve actions or `/api/port-reservations/`.

### Uplink

Faces other network gear: discovery never suggests hosts on this port, and
topology treats it as an infrastructure link.

## Hardware

### Speed

Free-text speed label (`10G`); the type's capability is used when unset. A
bare integer is taken as **kbps** and normalised on save (`1000000` → `1G`).

### MTU

Maximum transmissible unit.

### MAC address

The primary MAC. Additional MACs live as first-class MAC address objects
linked to the interface.

### Duplex

Half / full / auto.

### PoE mode / PoE type

Whether the port supplies or draws power, and the PoE standard.

### WWN

Fibre Channel World Wide Name.

### Combo group

Combo / shared port: alternate connectors of one logical port (an RJ45 and
its SFP twin) share a group name; enabling one disables the others on the
device.

## Nesting

### Virtual interface

Marks a sub-interface, LAG, or loopback - no physical attributes, cannot be
cabled.

### Parent interface

The interface a sub-interface nests under.

### LAG / aggregate

The aggregate interface this port is a member of. The target must be an
interface of **type LAG** on the same device or virtual chassis; an aggregate
can't itself be a member. Changing an aggregate's type away from LAG is
refused while it has members.

## Bundle

Set on the aggregate (type LAG) only - "Only an interface of type LAG has
bundle settings." Picking type LAG marks the interface virtual.

### Protocol

`lag_protocol`: blank = static aggregate (no negotiation), `lacp` (802.3ad),
`pagp`. The port-channel / ae / bond is the logical link; this is the protocol
negotiating it.

### LACP mode / LACP rate

`lacp_mode` (`active` / `passive`) and `lacp_rate` (`slow` 30 s / `fast` 1 s).
Only kept under LACP - any other protocol clears them on save.

### Min links

`lag_min_links`: members that must be up for the bundle to count as up
(at least 1). The detail page flags the bundle when it has fewer members.

### Bridge

The bridge interface this one belongs to.

## Discovery

### SNMP name

What the polled agent calls this port; links the row to
[SNMP discovery](../features/snmp-discovery.md). Clearing it unlinks.

### Exclude from SNMP drift

The agent can never report this port - it is skipped by drift comparison.

## Read-only

`cable` (the terminating cable and its status), `ip_addresses`,
`tunnel_terminations` (VPN ends on this port), `child_count`,
`lag_member_count`, `lag_protocol_display`. A member's `lag` relation carries
the aggregate's `lag_protocol` and `lacp_mode`.

`GET /api/interfaces/<id>/lag/` returns an aggregate's members as full rows
plus `capacity` (sum of parseable member speeds), `unparsed_speeds`,
`min_links` / `degraded`, `peers` (the far-end aggregates its members' direct
cables land on, with a member count each), `unpaired` (members whose far end
is uncabled, on a panel, or in no bundle) and `mixed_peers` (more than one
peer - an MLAG / vPC pair). The list accepts `?type=lag` and `?lag=<id>`.
