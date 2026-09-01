---
icon: lucide/git-branch
---

# Virtual & aggregate interfaces

Not every interface is a physical port. Danbyte lets you model **logical**
interfaces and the three ways real and logical ports relate to each other -
**sub-interfaces**, **link aggregation (LAG)**, and **bridges**.

## Virtual interfaces

Tick **Virtual** on the interface form to mark a port as logical - it has no
physical connector. Use this for loopbacks, tunnels, VLAN interfaces, and the
aggregate interfaces below. Virtual interfaces are tagged with a small
*virtual* badge in the list.

## Sub-interfaces (nesting)

A **sub-interface** sits underneath a parent interface - think `ae1.100` under
`ae1`, or `Gi0/1.10` under `Gi0/1`.

To create one, set the **Parent interface** field on the child. In the device's
**Interfaces** tab, children are **indented under their parent** so the hierarchy
is obvious at a glance.

Rules:

- The parent must be **on the same device**, or on another member of the
  same **virtual chassis**.
- An interface can't be its own parent, and you can't create loops.

## Link aggregation (LAG)

A **LAG** (also called a port-channel, bundle, or aggregate - e.g. `ae1`, `Po1`,
`bond0`) groups several physical ports into one logical link.

The aggregate (port-channel, `ae1`, `bond0`) is the *logical link*; **LACP**
is the protocol that negotiates it - or nothing, for a static "on" bundle, or
PAgP on older Cisco gear. Danbyte keeps both on the aggregate interface.

To model it:

1. Create the aggregate interface (e.g. `ae1`) with **Type = LAG** (Link
   Aggregation Group). It is virtual automatically. The **Bundle** section
   takes the protocol (static / LACP / PAgP), LACP mode and rate, and the
   minimum number of links.
2. On each physical member port, set its **LAG / aggregate** field to `ae1`.
   The picker offers only aggregates (type LAG) on the device or its stack;
   **+** beside it creates a new aggregate in place.

The aggregate's page shows a **Bundle** card - protocol, min links (flagged
when the bundle has fewer members), member count, capacity (the members'
speeds added up), and the **peer aggregate** its members' cables land on
(`core1: Po10 · 2 links`). Two peers means an MLAG / vPC pair and reads as
information, not a fault; members without a peer aggregate are listed. The
**Members** tab is the interface table filtered to the bundle. A member's own
page carries a `Member of Po1 · LACP active` chip that opens the aggregate.

The interface table has a **LAG** column: a member shows its aggregate as a
chip that opens it, and the aggregate row shows `2 links` - so the bundle reads
in both directions. On the device overview, the cabled runs of a bundle's
members are grouped under the aggregate (`ae1 · 2 links`) instead of listing
as unrelated cables.

**Stacks.** Create the aggregate once, on the virtual chassis master, and pick
it from any member's ports - the LAG / aggregate picker offers every member's
interfaces, labelled `member: name` when they live on another member. Those
ports' LAG chip adds `on <master>`, and the overview grouping does the same.
There is no need to mirror the aggregate onto each member.

## Bridges

A **bridge** groups interfaces into a single layer-2 domain. Set the **Bridge**
field on each member to point at the bridge interface. Like LAG and parent, the
bridge must be on the same device or virtual chassis.

## Quick reference

| Field on the form | Use it for | Points at |
|---|---|---|
| **Virtual** (checkbox) | loopbacks, tunnels, VLAN interfaces (aggregates are virtual by type) | - |
| **Type = LAG** + **Bundle** | the aggregate itself: protocol, LACP mode / rate, min links | - |
| **Parent interface** | sub-interfaces (`ae1.100` → `ae1`) | the parent port |
| **LAG / aggregate** | bundle membership (a port → its aggregate) | the aggregate |
| **Bridge** | layer-2 bridge membership | the bridge interface |

All three relationships are limited to interfaces **on the same device or the
same virtual chassis**, and none can point an interface at itself.
