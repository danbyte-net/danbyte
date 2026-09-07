---
icon: lucide/network
---

# Topology map

**DCIM → Topology** draws your network four ways, switched by the
**Wiring / Hierarchy / Flat / Logical** tabs in the header:

- **Wiring** (default) - the port-accurate diagram described below: stencil
  cards with one row per cabled port, cables drawn port-to-port.
- **Hierarchy** - tall rounded cards with the identity on a header row and
  **port chips aligned to their peer's height**, so cables run
  near-straight left-to-right. The layout relaxes ports toward their far
  ends over the rank structure; drag a card and its chips ride along.
  Cables here are routed from the ports, not the cards: one bends only to
  cross a card standing in its way, and only where a clear vertical street
  exists - otherwise it stays straight at its own port level.
- **Flat** - the barebones view for big graphs: every device is a small
  fixed-size chip (role color, status dot, name), parallel cables between
  two devices merge into a single **×N** edge (click it to list and open
  the member cables; hover names them). A pair joined by one cable shows
  that cable - its label on the line, its own colour, its panel on click.
  The layout packs tight. Hundreds of devices stay
  readable; Levels, direction, color modes and saved views all still apply.
- **Logical** - the L2 picture: **VLANs as rails** (grouped by VLAN group,
  colored by the VLAN's own color or its zone's), with everything attached
  to them - physical devices via their interfaces' untagged/tagged VLANs
  **and virtual machines** via their VM interfaces, on one hybrid diagram.
  Devices draw solid, VMs dashed; a dashed leg is a tagged (trunk)
  attachment; leg labels are the interface names. Filter by site or VLAN
  group, or hide VMs. Click any rail or box to open it. (The same rail
  layout drives the [virtual network topology](virtual-switches.md).)

The view choice is remembered per browser and saved with
[saved views](#saved-views).

In the Wiring view, devices render as **stencil cards** - role-colored
spine, status dot, type and primary IP, and one row per **cabled port** -
and every cable connects **port-to-port** on the cards, so you can follow
`asw1:Gi1/0/48 → core:Te1/1/1` visually instead of guessing which line is
which.

## Big graphs

Three mechanisms keep a large fabric legible:

- **Zoom declutter** - zoomed out, edge labels hide; further out, port text
  hides too, so the map reads as clean boxes and lines. Zoom in and the
  detail returns; **hovering any line always shows its full name** - cable,
  media, speed, and endpoints - at any zoom, in every view. On graphs over
  ~80 devices a dismissible hint offers the Flat view.
- **Per-cable lanes** - the gap between two tiers sizes itself to the number
  of cables crossing it, and each cable rides its own lane, ordered to
  minimize crossings - no more overlapping combs.
- **Leaf grids** - a switch with many single-cable neighbours (blades,
  servers, cameras) stacks them in a compact grid beside it instead of
  stringing them along one endless row; each cable drops down its column's
  street.
- **Cards slide off cable runs** - a card the layout happened to drop on
  another pair's straight cable nudges sideways just far enough to clear it,
  when a small move does clear it without overlapping anything. Matters most
  in the Flat view, whose point-to-point cables are never routed around
  cards; hand-placed (pinned) cards are never moved.
- **Dense cards** - past ~24 cabled ports the card's side columns render as
  a faceplate bar: one slim slot per cabled port with a truncated name, and
  a cabled-port count in the middle, so a 48-port stack stays a reasonable
  height. Top and bottom strips always keep full horizontal port names; the
  full name is also on the cable's hover label and its panel.
- **Group by site / location** (Display popover) - the graph aggregates to
  **one card per site** (or location): device count, role breakdown, and
  one edge per group pair labelled with its cable count (click it for the
  media types). **Double-click a group** (or its panel's *Open group*) to
  drill into that group's device view; the header chip pops back out.
  Levels and focus pause while grouped. Devices without a site collect
  under *Unassigned*.
- **The Flat view** - see above.

A cable's or interface's **Trace** tab shows the run two ways: the flat
end-to-end path strip on top, and a **trace map** below - the traced devices
as full stencil cards (Side-to-side or Tree) with the traced cable drawn as a
thick animated primary line. The interface **Overview** also carries the
end-to-end path on the right.

Port names in a path strip that resolve to a real interface are **clickable** (pointer cursor) - jump straight to the interface. The device card lists its first five runs with a **Show all** toggle.

**Viewing a patch panel** shows the *whole* run drawn **through** it - the panel
sits mid-path (highlighted as "you are here", with its front/rear ports) and the
real endpoints appear on either side - rather than a fragment that starts at the
panel. Each physical run appears once (the front- and rear-port views collapse
to a single strip).

Every **device page** carries the same language: its Topology card defaults
to **Paths** - one flat end-to-end strip per cabled port (linked chips,
panels crossed `front ⇄ rear`, segments in the cable's color) - with a
**Map** tab for the React Flow 1-hop neighbourhood and "Full map" jumping
here focused. That choice is on the address (`?sub=map`), so a link can open
the device straight on its map. The **cable page** hero draws its own run the
same way. Site and location pages have a **Topology** button that opens this
map scoped to them.

A collapsible **Legend** in the map's corner explains the line styles for
whichever view is active (the Logical view carries its own under the
diagram); its open/closed state is remembered per browser. In *By type*
color mode it swatches the media types actually on the map. Clicking a
cable draws it emphasized in the accent color while its panel is open.

## Reading the map

- **Cards** - the colored spine is the device's role color; the dot before
  the name is its status. Clicking a card **spotlights** it - everything not
  directly cabled to it fades until you click empty canvas.
  **Double-clicking** a card opens its device page. Flat chips carry a small
  `N×` cabled-port count; Hierarchy headers show the primary IP. Patch panels get a dashed border. Port cells show
  the full port name. A cabled front port and its strand's rear port render as **one continuous
  row** (`front1 ⇄ rear`) - the cable enters on the left and leaves on the
  right, the way the light actually travels through a fiber panel.
- **Edges** - solid lines are cables; a **long-dashed** line is a collapsed
  end-to-end run (labelled `via <panel>…`); a short-dashed *italic* line is an
  **LLDP ghost** - SNMP saw the adjacency but no cable exists (click it to
  materialise one). `×N` marks a breakout/trunk carrying N pairs.
- **Hover** an edge and it thickens while every other edge fades - the only
  way crossings stay readable in a dense mesh.
- **Click** a card or an edge for a detail panel - device summary with *Open
  device* / *Focus*, or the cable's type, length, status and every port pair
  with *Open cable*.

## Pass-through tracing

A cable **trace** (on a cable or interface page, and the device Paths strips)
walks *through* a device's internal pass-throughs to find the true far end:

- **Patch panels** - front ↔ rear strand (1:1 by position), both directions.
- **PDUs** - a **power outlet → its inlet** (the outlet names the one inlet
  that feeds it), so tracing a server's PSU cable continues upstream to the
  UPS through the PDU. The reverse (**inlet → outlets**) is *not* walked: one
  inlet feeds many outlets with no way to pick "the" one, so guessing a path
  would be worse than stopping. Console, console-server and aux ports are
  leaves - the trace ends there.

On the **map**, PDUs stay visible as their own nodes (they're only a partial
pass-through); only patch panels collapse away.

A trace map's axis is on the page's own address (`?dir=tb`), so a link opens
it read the way you left it. The same trace inside a dialog keeps its axis to
itself - a dialog doesn't rewrite the page behind it.

## Patch panels

Passive panels are hidden by default - their runs collapse so cables read
end-to-end. The **Show patch panels** toggle reveals them as nodes between the
cables. A device counts as a panel when its cabled ports are all patch-panel
front/rear ports **or** its device role is flagged **Patch-panel role** (on the
role's edit page) - so you can designate any role (e.g. a fibre-tray role) as
passive. Panel roles are also kept out of the **Levels** tiers, since a panel
isn't a device tier.

## Panels: collapsed or raw

**Collapse panels** (on by default) walks front→rear pass-throughs so a
server-to-switch run through two patch panels is **one edge**, annotated
`via panel-a, panel-b`. Untick it to see the raw physical hops with the
panels as nodes - the truth on the wall vs the truth in the racks.

## Custom maps - build exactly the diagram you want

Right-click is the builder. **Right-click a device** and pick *Start custom
map here* - the map reduces to just that device - then grow it: right-click →
**Add connected devices** pulls in a node's cabled neighbours, **Remove from
map** prunes, and the **Add device** button (also on right-clicking empty
canvas) inserts any device by name - including onto an empty map. A header
chip shows the set size and exits the builder. The hand-picked set saves
with a [saved view](#saved-views), so a curated diagram ("core row",
"customer X hand-off") is one select away. Right-click also offers *Open
device* and *Focus here* in any mode.

## Filters, focus, search

Filter by **site / role / status / tag** - the filter fields are searchable
comboboxes, so a long site list is a keystroke away. Click a device → **Focus** to
re-query just its neighbourhood, with a **1–4 hop** radius selector; the
focus chip in the header clears it. The **Find device** box dims everything
that doesn't match (name, IP, type) - press ++enter++ to zoom to the first
hit.

## Layout: side-to-side or tree

The **Side-to-side / Tree** toggle picks the layout axis:

- **Side-to-side** (default) - cards flow left→right, ports on the left and
  right edges.
- **Tree (top-down)** - cards flow top→bottom: a device's ports run across the
  **top** and **bottom** of the card with its identity in the middle, so a
  hierarchy (core at the top, access below, servers at the bottom) reads like
  a real network diagram.

Either way, a cable **auto-snaps** to whichever side (or top/bottom) of a card
faces its neighbour, so dragging a node never leaves an edge wrapped backwards
around it. Saved views remember the layout direction.

Two passes keep the wiring readable without manual cleanup:

- **Port order** - ports on a given side are ordered by where the cable's other
  end sits, so two cables leaving the same side don't cross each other (one
  going up, one going down, in the right order).
- **Routing around cards** - with **Display → Cables = Routed** (the default), a
  cable that would cross a card it isn't connected to **bends around** it
  instead. The route is computed from the cards' actual positions, so it works
  the same in the auto layout, the tiered (Levels) layout, **and a saved view**
  - not just the fresh auto layout. Switch to **Straight** for plain orthogonal
  lines, or **Curved** for the Flat view's floating point-to-point curves on
  the full wiring cards. Dragging a card drops *that card's* cables back to
  straight; the rest keep their routing.

The toolbar groups its controls to stay uncluttered: a **Filters** popover
(site / role / status / tag, with a badge counting active filters) and a
**Display** popover (layout axis, cables routed/straight, colour-by, and *Show
patch panels*). **Search** and **Levels** stay on the bar.

## Link aggregation bundles

Member cables of one bundle - both ends in an aggregate, the same pair of
aggregates - draw as **one thicker edge** labelled `Po1 ⇄ Po10 ×2`, the
logical link rather than its physical legs. A port-channel that fans out to a
vPC / MLAG pair is two bundles, one per far-end aggregate. Hover names the
aggregates, the member cables and the speed; click opens the same bundle panel
as a flat-view `×N` edge, titled by the aggregates. **Display → Bundle
aggregates** turns the fold off (`?lag=off` in the URL) to see every cable;
the flat view already bundles every parallel cable and simply names the
aggregates when all of them share one.

## Edge coloring

The **color mode** select paints edges by:

| Mode | Meaning |
|---|---|
| **Cable color** | the literal color recorded on each cable (default) |
| **By type** | a stable hue per media type (cat6, OM4, DAC…) |
| **By status** | green = active/connected, amber = planned, red = failed |
| **By speed** | link speed from the endpoint interface's **speed** field - green 1G, blue 10G, violet 25G, amber 40G, red 100G+ - with the speed as the edge label |
| **No color** | monochrome |

## Levels (role tiers)

The panel-lane and distance behaviour below is part of **Levels**, so it needs
the tier order set (at least one role dragged into the list). A saved view
restores the arrangement it was saved with, tiers or not; the tier order still
places anything you never dragged, and changing a tier order, bond or distance
re-runs the layout. **Re-layout** regenerates the view you're on from its tiers
whenever you want it back. With **Show patch panels**
on and tiers active, each panel gets its
**own lane between the two device tiers it joins** - so panels never land on a
device row and the fabric spaces out by a layer. Each tier's **distance dot**
controls the gap directly **above** its own row, so dragging a role's dot moves
that row up or down.

The **Levels** button opens a list of the device roles on the map - drag them
into the tier order you want (top of the list = first level). Nodes then stack
strictly by role: firewalls, then distribution, then access, then servers, so
the map reads as a hierarchy instead of following raw cable structure. Roles
left off, and devices with no role, fall to the last tier. **Clear** returns to
the structural layout. Each tier (except the first) has a **distance** control - five dots adding
room above it. The gap's **minimum is computed, not chosen**: every cable
crossing a gap gets its own 14px lane, so a tier fed by eighty cables opens
up automatically and the dots only ever add space on top - a distance
setting can no longer be "too small" for the cabling. Tiers are centred on a common axis, so
levels even out from the middle into a symmetric tree. The tier order and
distances are saved with the view.

Ports **auto-snap**: each cabled port renders once, on whichever side of its
card faces its neighbour - so an HA link between two side-by-side firewalls
connects on their touching edges, uplinks sit on top and downlinks on the
bottom, and cables never wrap around a card. Port strips size to their own
counts.

## Saved views

Drag cards where you want them, then **Save as…** - a saved view stores the
**filter set, color mode and every node position** per tenant. Load it from
the views select; **Save** updates it in place after you rearrange;
**Re-layout** discards hand positions and re-runs the automatic
left-to-right layout. Views are plain API objects
(`/api/topology-views/`), change-logged like everything else.

Arrangements are kept **per view** - Wiring, Hierarchy and Flat each remember
their own. The cards are different sizes in each, so one shared set of
coordinates would hand Hierarchy the spacing you tuned for Flat. Arrange a view,
switch away, come back: it's as you left it.

**Save** stores the arrangements you actually made - a view you dragged is
pinned exactly, a view you left (or returned, with **Re-layout**) to the
automatic layout stays automatic, so it keeps laying itself out as the map's
devices change. **Re-layout** only re-runs the view you're looking at. The
saved arrangements come back however the view is opened - picked from the
select, or as a `?view=` link in a fresh tab. Views saved before the per-view
split keep their arrangement under the style they were saved in; if one opens
scrambled, **Re-layout** and **Save** once.

A view is addressable: `?view=<id>` opens it. Change anything afterwards and
the toolbar says **edited** - what you're looking at is no longer what the
view describes. **Save** writes it back and the address collapses to the plain
`?view=<id>` again.

## Linking and sharing

The map is its address. Every control writes to the URL, so **Link** in the
toolbar copies exactly what you're looking at - and a browser bookmark, the
back button and a reload all keep it.

| Parameter | Values |
|---|---|
| `tab` | `wiring` (default), `hierarchy`, `flat`, `logical` |
| `view` | a saved view's id |
| `site` `location` `role` `status` | an id, or `all` |
| `tag` | a tag slug, or `all` |
| `panels` | `1` shows patch panels |
| `group` | `site`, `location`, `none` |
| `dir` | `lr` (default), `tb` |
| `color` | `cable` (default), `type`, `status`, `speed`, `none` |
| `cables` | `routed` (default), `straight` |
| `levels` | the tier order - see below |
| `device` `depth` | focus on one device, 1-6 hops |
| `devices` | a comma-separated device set (the custom map) |
| `q` | the search box |
| `vlangroup` `vms` | Logical view: VLAN group, `vms=0` hides VMs |

A setting on its default is left out, so a plain map stays `/topology`. A value
the page doesn't recognise reads as that default rather than breaking the page.
Grouping by site while scoped to one site *is* that site's device view, so
`?group=site&site=<id>` is the drill-in - the same link the breadcrumb gives
you.

**Levels** ride in one parameter: the roles in tier order, `+` for a role
bonded to the level above it and `:n` for extra distance, e.g.
`levels=Firewall|Core%20switch+|Distribution:2|Access`. `levels=none` turns a
saved view's tiers off.

Node positions are **not** in the URL - a hand-dragged arrangement lives in the
saved view (or your browser). A link reproduces the map's settings and lets the
layout run.

## Export

**PNG** renders the entire graph (not just the visible viewport) to an image
sized to the diagram - ready for a wiki page or a change ticket.
**Alt-click** exports just the visible area instead, for pasting one detail
rather than the whole estate.

## API

`GET /api/topology/` - parameters: `site`, `location`, `role`, `status`,
`tag`, `collapse_panels=0|1`, `device=<id>&depth=1..6` for a focused
neighbourhood, `devices=<id,id,…>` for the induced subgraph on an explicit
device set (the custom-map builder), and `group_by=site|location` for the
aggregated group graph
(one node per group with device count + role breakdown, cable-count edges).
Nodes carry the cabled ports + role/IP used by the stencil; edges carry the
cable id/type/label/length, every port pair, and the `via` panel list when
collapsed.

In the **Logical** view, a leg's interface name clicks through to that
interface's page (device interfaces; VM interfaces have no page). Cable
detail pages have a **Topology** button opening a custom map of the cable's
whole end-to-end run - every device it passes through, with patch panels
shown when the run threads one.

`GET /api/topology/logical/` - the Logical view's payload: `rails` (VLANs -
id, `vlan_id`, name, effective color, group) and `nodes` (devices and VMs
with `attachments: [{rail, iface, tagged, iface_id}]`). Parameters: `site`, `role`,
`vlan_group`, `include_vms=0`.

`GET /api/topology/summary/` - the topology as **plain facts** sized for an
LLM context or scripted analysis: `device_count`, `cable_count`, per-site
device rollups, `inter_site_links` (cable counts between sites), and
`adjacency` - one row per device with its role, site, and neighbors
(`{device, cables, types, via_panels}`), no port-level noise. Same filters
and `collapse_panels` semantics as the graph endpoint. This is the endpoint
to point an AI assistant at when it needs to answer "what connects to
what" questions.

All three are RBAC-scoped to the caller's `device.view` grant.
