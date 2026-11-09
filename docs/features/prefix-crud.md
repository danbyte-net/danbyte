---
icon: lucide/network
---

# Prefixes

A **prefix** is a block of address space written in CIDR form - for example
`10.0.10.0/24`. This page covers creating, editing, and deleting prefixes, and
the time-saving inheritance that fills in context for you.

## Add a prefix

There are three ways into the prefix form, and each carries different context
with it:

| You start from… | The new prefix inherits… |
|---|---|
| The **Add prefix** button on the prefix list | Nothing - it starts as a top-level block. |
| The **Add child prefix** button on a prefix's detail page | The **site**, **VLAN**, and **VRF** of the parent prefix. |
| A free slot in the **Children** tab, or a free chip in the [Space map](space-map.md) | The **site**, **VLAN**, and **VRF** of the smallest existing prefix that contains the new block. |

When inheritance applies, the form shows a small green chip confirming what's
being carried over, so you can see at a glance where the values came from:

> ✓ Inheriting **site + VLAN** from parent `10.0.10.0/24`

Fill in the remaining fields - status, role, description, gateway, tags - and
save.

!!! tip "Let the children inherit"
    Building out a network under a parent? Use **Add child prefix** instead of
    the global **Add prefix** button. You'll skip re-picking the site, VLAN, and
    VRF every time, and you won't accidentally split a block across the wrong
    VRF.

## A site's address scope

A site can *own* one or more prefix ranges - together they're the site's
**address scope**. Site-scoped editors (see
[Permissions → Site roles](permissions.md#site-roles-local-it-in-one-click)) can
only carve child prefixes inside those ranges, so the scope doubles as a guardrail.

Open a site and use its **Prefixes** tab (the address scope is also summarised on
the site's **Edit** form). Two ways to populate it:

- **Add prefix range** - create a brand-new prefix already assigned to this site.
- **Assign prefix** - pull an *existing* prefix into the site. Search, pick one,
  and it's moved into the site's scope. You can assign several in a row.

To remove a range from a site, edit that prefix and clear its **site**.

## Edit a prefix

Open the prefix and click **Edit**. The form opens populated with the prefix's
current values, including its tags. Change what you need and save.

## Delete a prefix

Open the prefix and click **Delete**. You'll be asked to confirm.

The addresses recorded inside it are handed to the prefix that still
contains them - the next one up, longest match - and keep their assignments;
the confirmation says how many move and where. Only addresses no other prefix
covers are removed with it, and the confirmation counts those too.

To delete several, tick them in the **Prefixes** list and press **Delete** in
the bar. Their addresses move the same way, onto prefixes that stay. More than
1000 go 1000 at a time (see
[Large selections](table-preferences.md#large-selections)); an address on a
prefix a later batch deletes moves on again, so it ends up where one call
would have put it.

## Renumbering a prefix

When a block you don't control changes - a provider's DHCPv6-PD `/60`, a
re-issued `/29` - everything under it has to move by the same offset. Open the
prefix and click **Renumber…**, type the new network, and press **Preview**.
The new prefix must be the same family and length, written as a network
address; the dialog says so as you type. Renumbering stays in the prefix's VRF.

The preview lists every change, grouped by kind, as old → new; badges count
each kind, and the **linked** badges count records that point at a moved
prefix or address and follow it without an edit. **Left unchanged** lists
everything that carries an address inside the prefix but is not rewritten,
with the reason. **Renumber** asks once more, then writes it all in one
change: if any part is refused, nothing moves.

What moves, by the difference between the new and old network:

| Kind | What changes |
|---|---|
| Prefixes | The prefix and every prefix inside it in the same VRF; a prefix's gateway. |
| IP addresses | Every address inside it in the VRF. Mask length, interface or VM assignment, role (gateway, anycast, VIP), status and DNS name stay. An address recorded on a prefix above the tree moves onto the tree prefix that holds it. |
| IP ranges | Start and end. |
| DHCP | Local scopes on a moved prefix: scope id, pool, options that hold an address, exclusions and reservations. |
| DNS | A/AAAA records in local zones, linked to a moved address. |
| Routing | Static route destinations and next hops, BGP neighbour addresses and EIGRP summary addresses in the prefix's VRF; prefix-list lines that name a moved prefix. |
| Global table only | Prefix-list lines by text, policy-rule selectors, route-map next hops, the BGP VPN export next hop, the LDP transport address, RPKI cache addresses, SNMP binding targets, BMC (Redfish) hosts and watched endpoints - they have no VRF to match on. |
| Monitoring | Deny subnets in the prefix's VRF. |

FHRP virtual IPs, NAT rules, services, VTEP addresses, BGP local addresses,
device primary IPs and anything else holding a moved address or prefix by
reference follow it: they are counted as linked, not rewritten.

Left unchanged, and listed: scopes, records and reservations on a Windows DHCP
or DNS server (change them there; the next sync follows), reverse (PTR)
records, observed leases, ARP sightings and DNS drift, Oxidized and PRTG
addresses, an Outpost's own connection address, ROAs (issue one for the new
prefix), aggregates, a gateway outside its prefix, and an address or range on
a moved prefix that lies outside it. With the prefix in a VRF, the
global-table-only references above are listed instead of rewritten.

It is refused when a prefix, address or range already sits in the new
network in that VRF, or an IP range crosses the edge of the old one. A prefix
that contains the new network - a covering `/48` - is fine; site-scoped
editors may not move into another site's or the shared space. You need
change on every kind the preview lists, within your sites; the refusal names
what is missing.

Every changed object gets a change-log entry with the cause *Renumbered X to
Y*, and the prefix's journal records *Renumbered from X to Y.* The API is
`POST /api/prefixes/<id>/renumber/` - see
[REST API](../reference/api.md#renumbering-a-prefix).

## What gets validated

Danbyte checks a few things when you save, so your data stays clean:

| Rule | What it means |
|---|---|
| **Valid CIDR** | The block must be a real network (for example `10.0.0.0/24`). It's stored in its canonical form. |
| **Valid gateway** | If you set a gateway, it must be a valid IP address. |
| **No duplicates in a VRF** | The same block can't exist twice in the same VRF. The same block *can* exist in two different VRFs - that's expected and supported. |

## Carving a subnet re-homes its IPs

Each IP belongs to exactly one prefix. When you create a **child prefix** (from
the detail page's *Add child prefix*, the [space map](space-map.md), or the API),
Danbyte automatically **moves the IP addresses it now most-specifically
contains** onto the new prefix - pulling them down from the broader parent so
they aren't stranded. It never steals IPs that belong to an existing
more-specific child, and only affects the same tenant + VRF.

## Add a pool of addresses

Rather than adding hosts one at a time, the **Add pool** button on a prefix's
**IPs** tab bulk-creates every address across a range in one step. It appears on
enumerable leaf prefixes (not containers or prefixes with child prefixes).

The dialog takes a **start** and **end** address, an optional **status**,
**role**, and **description** applied to every address, and a **Populate from**
shortcut that fills the range from:

- a **DHCP scope pool** on the prefix (see [Windows DHCP & DNS sync](windows-sync.md)), or
- the **whole prefix** (its usable host range) - or, on a prefix that
  [allocates only from its ranges](ipam-objects.md#ip-ranges), each **range**
  instead; a pool straddling a range edge is cut to the range.

Addresses that already exist are skipped, and the prefix's network and broadcast
addresses are never created. A single pool is capped at 1024 addresses - add a
wider span in smaller ranges. Each address is created individually, so it lands
in the change log and history like any other IP.

## Edit or delete many addresses

The **IP addresses** list (and a prefix's **IPs** tab) has a checkbox per row
and a select-all in the header. Once something is ticked a bar appears with the
count and the actions that take a selection: **Edit** opens the bulk editor for
the chosen addresses (status, role, VRF, tags, description and the rest, one
field at a time), **Delete** asks once, naming how many rows go, **Export** writes
just those rows, and **Check now** re-runs their monitoring checks. Select-all
covers the rows on the page in front of you, after the filters you have set.

## Gateway autospawn

If you leave the **gateway** field blank and the prefix's site has a gateway
policy set, Danbyte creates the gateway address for you automatically when you
save. See [Gateway autospawn](gateway-autospawn.md) for how to set that up.

## See also

- [The prefix tree](tree-and-sections.md) - how the list groups and indents prefixes.
- [Space map](space-map.md) - visualise free and used space inside a prefix.
- [VLANs, VRFs & route targets](ipam-objects.md) - the objects a prefix references.
