---
icon: lucide/network
---

# Topology map

**DCIM → Topology** draws your cabling as a wiring diagram. Devices render as
**stencil cards** — role-colored spine, status dot, type and primary IP, and
one row per **cabled port** — and every cable connects **port-to-port** on the
cards, so you can follow `asw1:Gi1/0/48 → core:Te1/1/1` visually instead of
guessing which line is which.

A cable's or interface's **Trace** tab shows the run two ways: the flat
end-to-end path strip on top, and a **trace map** below — the traced devices
as full stencil cards (Side-to-side or Tree) with the traced cable drawn as a
thick animated primary line. The interface **Overview** also carries the
end-to-end path on the right.

Port names in a path strip that resolve to a real interface are **clickable** (pointer cursor) — jump straight to the interface. The device card lists its first five runs with a **Show all** toggle.

Every **device page** carries the same language: its Topology card defaults
to **Paths** — one flat end-to-end strip per cabled port (linked chips,
panels crossed `front ⇄ rear`, segments in the cable's color) — with a
**Map** tab for the React Flow 1-hop neighbourhood and "Full map" jumping
here focused. The **cable page** hero draws its own run the same way.

## Reading the map

- **Cards** — the colored spine is the device's role color; the dot before
  the name is its status. Patch panels get a dashed border. Ports show a tiny
  kind dot: amber = console, red = power, violet = aux, zinc = data/panel.
  A cabled front port and its strand's rear port render as **one continuous
  row** (`front1 ⇄ rear`) — the cable enters on the left and leaves on the
  right, the way the light actually travels through a fiber panel.
- **Edges** — solid lines are cables; a **long-dashed** line is a collapsed
  end-to-end run (labelled `via <panel>…`); a short-dashed *italic* line is an
  **LLDP ghost** — SNMP saw the adjacency but no cable exists (click it to
  materialise one). `×N` marks a breakout/trunk carrying N pairs.
- **Hover** an edge and it thickens while every other edge fades — the only
  way crossings stay readable in a dense mesh.
- **Click** a card or an edge for a detail panel — device summary with *Open
  device* / *Focus*, or the cable's type, length, status and every port pair
  with *Open cable*.

## Pass-through tracing

A cable **trace** (on a cable or interface page, and the device Paths strips)
walks *through* a device's internal pass-throughs to find the true far end:

- **Patch panels** — front ↔ rear strand (1:1 by position), both directions.
- **PDUs** — a **power outlet → its inlet** (the outlet names the one inlet
  that feeds it), so tracing a server's PSU cable continues upstream to the
  UPS through the PDU. The reverse (**inlet → outlets**) is *not* walked: one
  inlet feeds many outlets with no way to pick "the" one, so guessing a path
  would be worse than stopping. Console, console-server and aux ports are
  leaves — the trace ends there.

On the **map**, PDUs stay visible as their own nodes (they're only a partial
pass-through); only patch panels collapse away.

## Patch panels

Passive panels are hidden by default — their runs collapse so cables read
end-to-end. The **Show patch panels** toggle reveals them as nodes between the
cables. A device counts as a panel when its cabled ports are all patch-panel
front/rear ports **or** its device role is flagged **Patch-panel role** (on the
role's edit page) — so you can designate any role (e.g. a fibre-tray role) as
passive. Panel roles are also kept out of the **Levels** tiers, since a panel
isn't a device tier.

## Panels: collapsed or raw

**Collapse panels** (on by default) walks front→rear pass-throughs so a
server-to-switch run through two patch panels is **one edge**, annotated
`via panel-a, panel-b`. Untick it to see the raw physical hops with the
panels as nodes — the truth on the wall vs the truth in the racks.

## Filters, focus, search

Filter by **site / role / status / tag**. Click a device → **Focus** to
re-query just its neighbourhood, with a **1–4 hop** radius selector; the
focus chip in the header clears it. The **Find device** box dims everything
that doesn't match (name, IP, type) — press ++enter++ to zoom to the first
hit.

## Layout: side-to-side or tree

The **Side-to-side / Tree** toggle picks the layout axis:

- **Side-to-side** (default) — cards flow left→right, ports on the left and
  right edges.
- **Tree (top-down)** — cards flow top→bottom: a device's ports run across the
  **top** and **bottom** of the card with its identity in the middle, so a
  hierarchy (core at the top, access below, servers at the bottom) reads like
  a real network diagram.

Either way, a cable **auto-snaps** to whichever side (or top/bottom) of a card
faces its neighbour, so dragging a node never leaves an edge wrapped backwards
around it. Saved views remember the layout direction.

Two passes keep the wiring readable without manual cleanup:

- **Port order** — ports on a given side are ordered by where the cable's other
  end sits, so two cables leaving the same side don't cross each other (one
  going up, one going down, in the right order).
- **Routing around cards** — with **Display → Cables = Routed** (the default), a
  cable that would cross a card it isn't connected to **bends around** it
  instead. The route is computed from the cards' actual positions, so it works
  the same in the auto layout, the tiered (Levels) layout, **and a saved view**
  — not just the fresh auto layout. Switch to **Straight** for plain orthogonal
  lines. Dragging a card drops *that card's* cables back to straight; the rest
  keep their routing.

The toolbar groups its controls to stay uncluttered: a **Filters** popover
(site / role / status / tag, with a badge counting active filters) and a
**Display** popover (layout axis, cables routed/straight, colour-by, and *Show
patch panels*). **Search** and **Levels** stay on the bar.

## Edge coloring

The **color mode** select paints edges by:

| Mode | Meaning |
|---|---|
| **Cable color** | the literal color recorded on each cable (default) |
| **By type** | a stable hue per media type (cat6, OM4, DAC…) |
| **By status** | green = active/connected, amber = planned, red = failed |
| **No color** | monochrome |

## Levels (role tiers)

The panel-lane and distance behaviour below is part of **Levels**, so it needs
the tier order set (at least one role dragged into the list). A **saved view
that has a Level order regenerates from its tiers** when reopened (so its
distance dots and panel lanes apply straight away); a saved view *without*
tiers restores its exact pinned arrangement instead. With **Show patch panels**
on and tiers active, each panel gets its
**own lane between the two device tiers it joins** — so panels never land on a
device row and the fabric spaces out by a layer. Each tier's **distance dot**
controls the gap directly **above** its own row, so dragging a role's dot moves
that row up or down.

The **Levels** button opens a list of the device roles on the map — drag them
into the tier order you want (top of the list = first level). Nodes then stack
strictly by role: firewalls, then distribution, then access, then servers, so
the map reads as a hierarchy instead of following raw cable structure. Roles
left off, and devices with no role, fall to the last tier. **Clear** returns to
the structural layout. Each tier (except the first) has a **distance** control — five dots setting the
gap above it — so busy tiers with lots of cables get more room and the cable
labels between levels stay readable. Tiers are centred on a common axis, so
levels even out from the middle into a symmetric tree. The tier order and
distances are saved with the view.

Ports **auto-snap**: each cabled port renders once, on whichever side of its
card faces its neighbour — so an HA link between two side-by-side firewalls
connects on their touching edges, uplinks sit on top and downlinks on the
bottom, and cables never wrap around a card. Port strips size to their own
counts.

## Saved views

Drag cards where you want them, then **Save as…** — a saved view stores the
**filter set, color mode and every node position** per tenant. Load it from
the views select; **Save** updates it in place after you rearrange;
**Re-layout** discards hand positions and re-runs the automatic
left-to-right layout. Views are plain API objects
(`/api/topology-views/`), change-logged like everything else.

## Export

**PNG** renders the entire graph (not just the visible viewport) to an image
sized to the diagram — ready for a wiki page or a change ticket.

## API

`GET /api/topology/` — parameters: `site`, `location`, `role`, `status`,
`tag`, `collapse_panels=0|1`, and `device=<id>&depth=1..6` for a focused
neighbourhood. Nodes carry the cabled ports + role/IP used by the stencil;
edges carry the cable id/type/label/length, every port pair, and the `via`
panel list when collapsed.
