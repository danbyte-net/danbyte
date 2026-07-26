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
4. Optionally record the cabinet's **outer width / depth (mm)** — the physical
   footprint including the frame. These drive the 3D room view and scaled
   drawings; left blank, plausible defaults are used (depth 1000 mm, width
   derived from the rail width plus a 150 mm frame).

Picking a [**rack type**](#rack-types) fills the height, width, outer
dimensions and weight budget from the cabinet model in one go.

### Rack roles

A **rack role** classifies a rack's purpose (e.g. *network*, *compute*,
*storage*) with a color, so racks group visually. Define them on the **Rack
roles** page — like everything else, none ship by default.

### Rack types

A **rack type** is a cabinet *model* — "APC NetShelter SX 42U 600mm" — with
the dimensions a cabinet of that model always has: rail width, height in U,
starting unit and numbering direction, outer width/depth (mm), and the load
rating. Define them on **DCIM → Rack types**; picking one on the rack form
**pre-fills all of those fields** (each stays editable — the rack remains the
source of truth, so a one-off odd cabinet just overrides a value).

A rack type can also carry **accessories**: the factory-fitted 0U gear the
model ships with — typically a pair of vertical PDU strips. Each accessory
names a **0U device type**, a **label** (`PDU-A`), a **rail** (left/right),
a **channel** (front/rear), and the optional offset/span of a
[side mount](#zero-u-side-mounting-vertical-pdus).
When you create a rack with a type picked, tick **Create accessories** and
Danbyte stamps one side-mounted device per accessory, named
`{rack}-{label}` (deduped `-2`, `-3`… if taken), with the device type's
component templates materialised — so a stamped PDU arrives with its real
outlets, ready for power cabling.

Stamping writes devices, so the checkbox requires permission to **add
devices at the rack's site** — without it the rack is refused wholly (no
half-created rack). The stamp is create-only: re-saving a rack never
duplicates its strips. Deleting a rack type never touches racks or devices
(and is refused with a conflict while racks still use it).

#### Syncing a rack with its type

A model changes after its racks are built — the cabinet gains a second PDU,
or its recorded depth was wrong. **Sync type** on a rack's page (the rack
twin of a device's *Sync from type*) compares the two and shows a preview
before touching anything:

- **Dimensions to copy** — every dimension that drifted from the model, old
  value and new. Drift is legitimate (you can edit a rack's dims after
  picking a type), so this reports rather than nags.
- **Accessories to add** — strips the type defines that this rack hasn't
  got, stamped exactly as they would be at creation.
- **Strips to bring in line** — a strip that *exists* but no longer agrees
  with its accessory: the model's device type was swapped, the rail moved,
  a channel was set. Applying re-points the existing device rather than
  creating a second one. A changed **device type** adds the new type's
  components and leaves the ones already there — pruning those is the
  *device's* own Sync from type, which is the only place that knows what
  the cabling depends on.
- **Not on the type** — stamped-looking strips the type no longer defines.
  These are listed and **left alone**: a strip in a live rack is real,
  probably cabled hardware, so syncing never deletes one.

Apply needs **change** on the rack, and the accessory half additionally
needs device-add at its site. Syncing twice does nothing the second time.
`POST /api/racks/{id}/sync-from-type/` is the same operation
(`apply`, plus `dims` / `accessories` to narrow it); without `apply` it is
a dry run that returns the diff.

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

### Zero-U space (room for PDUs and cabling)

The mounting rails are a fixed width (450 mm at 19″); anything you add to a
cabinet's **outer width** beyond that becomes the **zero-U space** — the
channel down each side of the rails where vertical PDUs and cable management
live. Widen a rack's **Outer width (mm)** past the rails and the form tells
you how much zero-U space that opens per side; the 3D room seats the vertical
strips in it. A cabinet with no extra width has no zero-U space, so a strip
sits hard against the rail.

### Zero-U side mounting (vertical PDUs)

A vertical PDU strip bolts to a rack **rail** instead of occupying units.
Give it a **0U device type**, then on the device pick **Side mount** — left
or right rail — plus an optional **offset from the base** (mm) and a
**span** in U (blank draws about three quarters of the rack). Side mounting
replaces U placement: no position and no half-width side.

A side-mounted strip also picks a **channel** — front or rear — which is
the face it's reachable from. The elevation then draws it on **that
elevation only**, and the 3D room seats it at that depth in the cabinet.
Leave the channel blank and the strip shows on **both** elevations, which
is what strips mounted before this field existed do: we genuinely don't
know which channel they're in, so neither view claims otherwise.

The elevation grows a slim **rail lane on each side** of the U grid listing
that rail's strips (click one to open it; **+** hangs a new one with the
rack and rail pre-picked), and the 3D room draws the strip on the cabinet's
flank. **0U gear never counts against used units** — including 0U types
parked at a U position, which previously (and wrongly) charged a full unit.

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

!!! note "Power numbers changed with the PDU fix"
    Devices that **have power outlets** (PDUs — distributors) no longer
    contribute their inlet draw to the rack's demand: a PDU's inlet
    restates its children's draws, so counting both **double-counted**
    every rack that recorded its PDU. If a rack's demand dropped after
    upgrading, this fix is why — the new number is the honest one.

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
