---
icon: lucide/git-branch
---

# Virtual & aggregate interfaces

Not every interface is a physical port. Danbyte lets you model **logical**
interfaces and the three ways real and logical ports relate to each other —
**sub-interfaces**, **link aggregation (LAG)**, and **bridges**.

## Virtual interfaces

Tick **Virtual** on the interface form to mark a port as logical — it has no
physical connector. Use this for loopbacks, tunnels, VLAN interfaces, and the
aggregate interfaces below. Virtual interfaces are tagged with a small
*virtual* badge in the list.

## Sub-interfaces (nesting)

A **sub-interface** sits underneath a parent interface — think `ae1.100` under
`ae1`, or `Gi0/1.10` under `Gi0/1`.

To create one, set the **Parent interface** field on the child. In the device's
**Interfaces** tab, children are **indented under their parent** so the hierarchy
is obvious at a glance.

Rules:

- The parent must be **on the same device**.
- An interface can't be its own parent, and you can't create loops.

## Link aggregation (LAG)

A **LAG** (also called a port-channel, bundle, or aggregate — e.g. `ae1`, `Po1`,
`bond0`) groups several physical ports into one logical link.

To model it:

1. Create the aggregate interface (e.g. `ae1`) and tick **Virtual**.
2. On each physical member port, set its **LAG / aggregate** field to `ae1`.

In the interface list, members show `· LAG ae1` next to their name, and the
aggregate's detail page shows how many members it has.

## Bridges

A **bridge** groups interfaces into a single layer-2 domain. Set the **Bridge**
field on each member to point at the bridge interface. Like LAG and parent, the
bridge must be on the same device.

## Quick reference

| Field on the form | Use it for | Points at |
|---|---|---|
| **Virtual** (checkbox) | loopbacks, tunnels, aggregates, VLAN interfaces | — |
| **Parent interface** | sub-interfaces (`ae1.100` → `ae1`) | the parent port |
| **LAG / aggregate** | bundle membership (a port → its aggregate) | the aggregate |
| **Bridge** | layer-2 bridge membership | the bridge interface |

All three relationships are limited to interfaces **on the same device**, and
none can point an interface at itself.
