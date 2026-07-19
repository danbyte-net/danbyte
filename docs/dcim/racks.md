---
icon: lucide/columns-3
---

# Racks

A **rack** gives your devices a physical home and draws an **elevation** — the
familiar front/rear diagram showing what's mounted in each rack unit.

## Add a rack

1. Open **DCIM → Racks** and click **Add rack**.
2. Name it and set its **height** in rack units (e.g. 42U) and **starting unit**
   (usually 1).
3. Optionally assign a **site**, a **rack role**, and tags.

### Rack roles

A **rack role** classifies a rack's purpose (e.g. *network*, *compute*,
*storage*) with a color, so racks group visually. Define them on the **Rack
roles** page — like everything else, none ship by default.

## Mount a device in a rack

On a device (or in the rack), set:

- **Rack** — which rack it's in.
- **Position** — the lowest rack unit it occupies. The dropdown lists the
  rack's real units (top-down, matching the elevation); units that are already
  taken are greyed out and show the blocking device, so you can only pick a
  spot where the device actually fits.
- **Face** — front or rear (leave blank for full-depth gear that occupies both).
- **Side** — only for half-width device types: which half of the U (left/right).

The device's **height** comes from its [device type](device-catalog.md), so the
elevation knows how many units to fill. Danbyte checks the device actually fits —
it won't let you mount a 2U device where only 1U is free, or overlap two devices
on the same face.

### Half-width devices

Some gear is half a 19″ rack wide — e.g. a Mellanox SN2010 ToR switch — so two
mount side-by-side in a single U. Mark the **device type** as *Half width*
(next to its U height), and each device of that type then picks a **Side**
(left or right) when racked. Two half-width devices may share a U as long as
they're on opposite sides; a full-width device still claims the whole U. The
elevation draws the halves side by side, and a shared U counts once in the
rack's used-units figure.

## Rack elevations

The rack's **Overview** draws paired elevations — **front and
rear side by side** — and the Devices tab keeps a single toggleable one. Three
**display modes**:

| Mode | Shows |
|---|---|
| **Names** | Clean labeled blocks (position, name, height). |
| **Images** | The device type's [rack-face image](device-catalog.md#rack-face-images) stretched across the block, name overlaid. |
| **Render** | The type's **faceplate drawn as hardware** (the same mm-true port rendering as the device page), whole rack at true proportions. |

In Images and Render modes a **Text** tick toggles the name overlay, so a
photo-real rack stays clean when you want it to.

**Depth-aware faces:** a device mounts on one face, but if its device type is
**full depth** (the default) it occupies the other face too — the opposite
view draws it **hatched** (diagonal stripes), so the rear elevation shows
exactly what's blocking the space. Mark shallow gear (patch
panels, half-depth switches) as *not* full depth on the device type and it
frees the other face.

Elevations follow the rack's **width** (10″ / 19″ / 21″ / 23″) — a 10″
lab rack draws narrower than a 23″ telco rack, and Images/Render modes use
true 1U proportions so photos aren't squashed. Occupied units fill
edge-to-edge and take the **device role's color** in Names mode.

On a rack's own page you can **drag device blocks between units** — drop a
block on an empty band and the device re-mounts with that band as its top U
(occupied space, rack edges and half-width columns are respected; a plain
click still opens the device). The **PNG** button snapshots the front + rear
pair for a change ticket or wiki page.

Racks roll up **power**: supply is every *primary* power
feed delivered to the rack (volts × amps × max-utilisation%,
three-phase × √3), demand is the racked devices' power-port draws —
allocated where you've recorded it, otherwise the nameplate sum (labelled as
such). The rack page shows **demand / supply W** and turns red when over.

Racks can carry a **weight budget** (max weight + unit on the rack form —
the floor or rack load rating). Every racked device's *type* weight sums
against it, normalised to kg; the rack page shows **used / budget** and turns
red when over. Types without a weight contribute nothing, so the number is a
floor, not a guarantee.

Racks can carry a **location** (building / floor / room within their
site) — the Locations page's **Rack elevations** button then shows exactly
the racks in that room, and `/api/racks/?location=` filters likewise. A
location can also be drawn as a [floor plan](../features/floor-plans.md),
with tiles linked back to its racks.

Every device's own page shows its rack with the device **highlighted**.

## Images

The rack's Overview has an **Images** gallery — attach any number of captioned
photos (front/rear shots, cabling, labels). Uploading and removing require
**change** permission on racks; viewers see it read-only. It's the same shared
attachment system used on [devices](devices.md#images), sites, and locations.
