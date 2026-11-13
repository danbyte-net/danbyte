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

The preview shows only what you may view, each row by the rule of its own
page: an ARP entry or BMC address of a device at another site is not listed.
Those rows are counted together under **Not shown**, with nothing else about
them; they stay as they are. When something the renumber would have to
rewrite is one you can't view, it is refused and says how many such objects
there are, so another site's records are never changed on your behalf.

Every changed object gets a change-log entry with the cause *Renumbered X to
Y*, and the prefix's journal records *Renumbered from X to Y.* The API is
`POST /api/prefixes/<id>/renumber/` - see
[REST API](../reference/api.md#renumbering-a-prefix).

## Browse by tree

The left rail of the prefix list shows either **Filters** (the facets) or a
**Tree** - switch at the top of the rail. The choice is remembered per user
for this list and kept in the URL (`?rail=tree`), so a link opens the same
rail. On a narrow window the rail opens from the **Filters** / **Tree**
button in the header.

The tree shows one VRF at a time: pick **Global** or a VRF at the top. Below
it, the VRF's top-level prefixes; a chevron opens a prefix to its direct
children, and the number beside a prefix is how many direct children it has.
Each level loads when you open it, 200 prefixes at a time - a `/16` with
2,000 `/29`s shows the first 200 and **Show 200 more**.

Type in **Filter prefixes** to search the VRF on the server: the start of a
CIDR (`10.1` finds `10.1.0.0/16`, `10.10.0.0/16`, …) or a whole address or
network (`10.1.0.0/16`, `10.1.2.7`), which finds what is inside it, or else
the smallest prefix holding it. The tree then shows only the matches and the
prefixes above them; open a match to see its children.

Click a prefix (or press ++enter++) to select it. The table then lists that
prefix and everything inside it, in its VRF; with nothing selected and the
tree open, the table lists the whole VRF. The selection is `?within=<id>`
and works with the other filters. Switch back to **Filters** and it stays,
as a **Within 10.1.0.0/16** chip over the table; its ✕ (or **clear** in the
tree) goes back to the whole list.

The tree is a keyboard tree: ++arrow-up++ / ++arrow-down++ move, ++home++ /
++end++ jump, ++arrow-right++ opens a prefix or steps into it,
++arrow-left++ closes it or steps out to its parent, ++enter++ or ++space++
selects.

### On a prefix's page

A prefix's **IPs** and **Child prefixes** tabs have the same **Filters** /
**Tree** switch. There the tree starts at the prefix itself: its direct
children on top, each opening as above (a prefix with none shows **No child
prefixes.**). It has no VRF picker (the prefix's own VRF applies), and
**Filter prefixes** searches only inside the prefix.

Click a prefix in the tree to scope the tab to it:

- **IPs** lists the addresses inside the picked prefix - on it or on any
  prefix below it. **Show available** and **Show DHCP pool** stay under the
  switch in Tree mode and count against the picked prefix: its free hosts
  (when it holds no prefixes of its own and is small enough to list) and its
  own DHCP pool. **+ Add** on a free row opens the IP form in the picked
  prefix.
- **Child prefixes** lists the picked prefix and everything inside it.

The pick is `?within=<id>` and the mode `?rail=tree`, beside the tab's
`?tab=`, so a link opens the same view. Both tabs share them: a prefix
picked on **IPs** still scopes **Child prefixes**. The **Within …** chip
beside the row count, or **clear** in the tree, goes back to the whole
prefix. Tree or Filters is remembered per user for prefix pages, apart from
the two lists - a tree you browse the lists by doesn't change how a prefix
page opens. On a narrow window the rail opens from the **Filters** /
**Tree** button beside the row count.

### On a VRF's page

A VRF's **Prefixes** and **IPs** tabs have the same switch. **Filters**
shows the list pages' facets for the VRF's rows (the prefix list's, less
VRF, and the IP list's). **Tree** is the VRF's own tree: its top-level
prefixes on top, opening and paging as above, with no VRF picker, and
**Filter prefixes** searches the VRF.

Click a prefix to scope the tab to it, on the server: **Prefixes** lists it
and everything inside it, **IPs** the addresses on it or on any prefix
below it. A pick from another VRF scopes nothing (the chip reads **unknown
prefix**). The pick (`?within=`) and the mode (`?rail=tree`) sit beside
`?tab=` and are shared by both tabs, with the **Within …** chip and
**clear** as above. Tree or Filters is remembered per user for VRF pages,
apart from the lists and prefix pages. On a narrow window the rail opens
from the button beside the row count.

### Hidden prefixes

The tree holds only prefixes you may view. A prefix whose parent you can't
view hangs from the nearest prefix above it that you can - or sits at the
top of the VRF - so a hidden prefix is never named, shown or counted. A
selection naming a prefix you can't view lists nothing.

## Free space in the list

Tick **Show free space** at the top of the prefix list's filter sidebar. Each
container, and each prefix that holds child prefixes, then gets free rows
between its children: the gaps, as the largest aligned blocks. A `/16`
holding `10.20.0.0/24`, `10.20.1.0/24` and `10.20.4.0/22` shows
`10.20.2.0/23`, `10.20.8.0/21`, `10.20.16.0/20` and so on.

A free row shows its block, a dashed **Free** badge and its size
(`512 addresses`; IPv6 counts `/64`s). **Create** opens the prefix form with
the block, the parent's VRF and the parent's site filled in; the form's
**Size** picker carves a smaller block at the same start, so a `/23` gap can
become a `/24`, `/25` and so on. A parent with more than 8 free blocks shows
the first 8 and **+ N more free**, which loads the rest (up to 256; past
that it opens the prefix, whose [Space map](space-map.md) shows them all).

Free rows are never selected, exported or counted: the row count, the VRF
group counts, Download and the bulk bar see only real prefixes. The switch
lives in the URL (`?free=1`), so a link or a saved view keeps it, along
with the size, Next available and scope below.

IPv6 free space is offered in whole `/64`s under a `/64` or shorter: a `/64`
holding a `/127` link is not free, and blocks start on `/64` boundaries.
Under a longer parent (a `/120`), any size is shown.

Only prefixes count as used. Stray addresses and IP ranges don't take space
here, as on the Space map: a new prefix over them adopts them.

### Find a size

With free space on, type a length into **Free size** (`/29`, or pick one of
the sizes that fit). The list then shows only the parents that have a free
block of that size, each followed by its first 16, lowest address first,
and **+ N more free** for the rest.

Tick **Next available** to see just one: the lowest free block of that size
among the listed parents (the first VRF in the list that has one),
highlighted, with **Create**. The sidebar's other filters (VRF, site, tags,
status, search) narrow which parents are looked in.

### Scope

**Scope** limits every search to a block inside the parent: type any CIDR
(`10.20.0.0/19` out of a `/15`) or pick one of the listed parents. Free
rows, Free size, Next available and the planner then offer only space inside
it.

### Who sees what

Free space is worked out on the server against every prefix in the VRF,
including ones you may not view, so a free row is always really free. Space
a prefix you can't see takes is simply not offered - it is never named and
never counted in the totals. Free rows appear only under prefixes you can
view. Create, allocate and the planner check again on the server: they need
add on prefixes, and with site-limited access the new prefix must sit in
your own site's space, as for any new prefix.

## Plan subnets

**Plan subnets…** on a container or parent prefix (and in the list toolbar
when free space is on and one parent is in scope) places a set of subnets at
once. Each row is a count and a size - `2 × /24`, `5 × /29` - with an
optional description pattern (`servers-{n}` numbers them), status, VLAN and
site (the parent's site by default). **Keep together** places a row's
subnets side by side in one block.

The planner places the largest first, each aligned to its size, inside the
parent or the **Scope**:

- **Lowest address first** fills from the bottom of the free space;
- **Best fit** uses the smallest free block that holds each subnet, which
  keeps big blocks whole;
- **Leave room to grow** keeps the next block of the same size free after
  each one (not created, just left alone).

**Preview** shows the proposed prefixes in a table and on a strip of the
parent in the Space map's colours, with the proposed blocks outlined. A row
that doesn't fit says why: *No free /24 left in 10.0.0.0/22; largest free
block is /25.* **Create all** is offered only when everything fits, asks
once more, and creates the lot in one change - all or nothing. If the free
space changed since the preview, it refuses and asks for a new preview.
Every new prefix gets a change-log entry with the cause *Planned in
&lt;parent&gt;*.

Moving existing prefixes to make room is not part of planning; use
[Renumber](#renumbering-a-prefix) for that.

The API: `GET /api/prefixes/?free=1`, `GET /api/prefixes/available/`,
`POST /api/prefixes/<id>/allocate/` and `POST /api/prefixes/<id>/plan/` -
see [REST API](../reference/api.md#free-space-in-prefixes).

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
