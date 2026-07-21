---
icon: lucide/network
---

# Prefixes

A **prefix** is a block of address space written in CIDR form — for example
`10.0.10.0/24`. This page covers creating, editing, and deleting prefixes, and
the time-saving inheritance that fills in context for you.

## Add a prefix

There are three ways into the prefix form, and each carries different context
with it:

| You start from… | The new prefix inherits… |
|---|---|
| The **Add prefix** button on the prefix list | Nothing — it starts as a top-level block. |
| The **Add child prefix** button on a prefix's detail page | The **site**, **VLAN**, and **VRF** of the parent prefix. |
| A free slot in the **Children** tab, or a free chip in the [Space map](space-map.md) | The **site**, **VLAN**, and **VRF** of the smallest existing prefix that contains the new block. |

When inheritance applies, the form shows a small green chip confirming what's
being carried over, so you can see at a glance where the values came from:

> ✓ Inheriting **site + VLAN** from parent `10.0.10.0/24`

Fill in the remaining fields — status, role, description, gateway, tags — and
save.

!!! tip "Let the children inherit"
    Building out a network under a parent? Use **Add child prefix** instead of
    the global **Add prefix** button. You'll skip re-picking the site, VLAN, and
    VRF every time, and you won't accidentally split a block across the wrong
    VRF.

## A site's address scope

A site can *own* one or more prefix ranges — together they're the site's
**address scope**. Site-scoped editors (see
[Permissions → Site roles](permissions.md#site-roles-local-it-in-one-click)) can
only carve child prefixes inside those ranges, so the scope doubles as a guardrail.

Open a site and use its **Prefixes** tab (the address scope is also summarised on
the site's **Edit** form). Two ways to populate it:

- **Add prefix range** — create a brand-new prefix already assigned to this site.
- **Assign prefix** — pull an *existing* prefix into the site. Search, pick one,
  and it's moved into the site's scope. You can assign several in a row.

To remove a range from a site, edit that prefix and clear its **site**.

## Edit a prefix

Open the prefix and click **Edit**. The form opens populated with the prefix's
current values, including its tags. Change what you need and save.

## Delete a prefix

Open the prefix and click **Delete**. You'll be asked to confirm.

!!! warning "Deleting takes the IPs with it"
    Deleting a prefix also removes the IP addresses recorded inside it. Move or
    confirm you no longer need those addresses first.

## What gets validated

Danbyte checks a few things when you save, so your data stays clean:

| Rule | What it means |
|---|---|
| **Valid CIDR** | The block must be a real network (for example `10.0.0.0/24`). It's stored in its canonical form. |
| **Valid gateway** | If you set a gateway, it must be a valid IP address. |
| **No duplicates in a VRF** | The same block can't exist twice in the same VRF. The same block *can* exist in two different VRFs — that's expected and supported. |

## Carving a subnet re-homes its IPs

Each IP belongs to exactly one prefix. When you create a **child prefix** (from
the detail page's *Add child prefix*, the [space map](space-map.md), or the API),
Danbyte automatically **moves the IP addresses it now most-specifically
contains** onto the new prefix — pulling them down from the broader parent so
they aren't stranded. It never steals IPs that belong to an existing
more-specific child, and only affects the same tenant + VRF.

## Gateway autospawn

If you leave the **gateway** field blank and the prefix's site has a gateway
policy set, Danbyte creates the gateway address for you automatically when you
save. See [Gateway autospawn](gateway-autospawn.md) for how to set that up.

## See also

- [The prefix tree](tree-and-sections.md) — how the list groups and indents prefixes.
- [Space map](space-map.md) — visualise free and used space inside a prefix.
- [VLANs, VRFs & route targets](ipam-objects.md) — the objects a prefix references.
