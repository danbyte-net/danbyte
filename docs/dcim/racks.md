---
icon: lucide/columns-3
---

# Racks

A **rack** gives your devices a physical home and draws an **elevation** - the
familiar front/rear diagram showing what's mounted in each rack unit.

## Add a rack

1. Open **DCIM → Racks** and click **Add rack**.
2. Name it and set its **height** in rack units (e.g. 42U) and **starting unit**
   (usually 1).
3. Optionally assign a **site**, a **rack role**, and tags.
4. Optionally record the cabinet's **outer width / depth (mm)** - the physical
   footprint including the frame. These drive the 3D room view and scaled
   drawings; left blank, plausible defaults are used (depth 1000 mm, width
   derived from the rail width plus a 150 mm frame).

Picking a [**rack type**](#rack-types) fills the height, width, outer
dimensions and weight budget from the cabinet model in one go.

A rack's units can't shrink or shift out from under its devices: lowering
the **height** or raising the **starting unit** below a mounted device is
refused, naming the devices in the way (`Devices are installed outside
U1–U10 (hi at U40). Move or remove them first.`). Side-mounted strips have no
U position and never block. A rack with devices in it can't move to another
site either - move them out first, as with a [cabinet](cabinets.md).

### Rack roles

A **rack role** classifies a rack's purpose (e.g. *network*, *compute*,
*storage*) with a color, so racks group visually. Define them on the **Rack
roles** page - like everything else, none ship by default.

### Rack types

A **rack type** is a cabinet *model* - "APC NetShelter SX 42U 600mm" - with
the dimensions a cabinet of that model always has: rail width, height in U,
starting unit and numbering direction, outer width/depth (mm), and the load
rating. Define them on **DCIM → Rack types**; picking one on the rack form
**pre-fills all of those fields** (each stays editable - the rack remains the
source of truth, so a one-off odd cabinet just overrides a value).

**Import from library** on the Rack types page reads the NetBox
devicetype-library's `rack-types/` folder - single files, pasted YAML, uploads,
or a `/tree/` link to a manufacturer - through the same import the device types
use. The model, width, height, starting unit, top-down numbering, outer width
and depth (converted from inches when the file uses them) and load budget come
across; the form factor, outer height, the rack's own weight and mounting depth
aren't held on a rack type, and the import report lists them as skipped. A
model that already exists is left alone.

A rack type can also carry **accessories**: the factory-fitted 0U gear the
model ships with - typically a pair of vertical PDU strips. Each accessory
names a **0U device type**, a **label** (`PDU-A`), a **rail** (left/right),
a **channel** (front/rear), and the optional offset/span of a
[side mount](#zero-u-side-mounting-vertical-pdus).
When you create a rack with a type picked, tick **Create accessories** and
Danbyte stamps one side-mounted device per accessory, named
`{rack}-{label}` (deduped `-2`, `-3`… if taken), with the device type's
component templates materialised - so a stamped PDU arrives with its real
outlets, ready for power cabling.

Stamping writes devices, so the checkbox requires permission to **add
devices at the rack's site** - without it the rack is refused wholly (no
half-created rack). The stamp is create-only: re-saving a rack never
duplicates its strips. Deleting a rack type never touches racks or devices
(and is refused with a conflict while racks still use it).

#### Syncing a rack with its type

A model changes after its racks are built - the cabinet gains a second PDU,
or its recorded depth was wrong. **Sync type** on a rack's page (the rack
twin of a device's *Sync from type*) compares the two and shows a preview
before touching anything:

- **Dimensions to copy** - every dimension that drifted from the model, old
  value and new. Drift is legitimate (you can edit a rack's dims after
  picking a type), so this reports rather than nags.
- **Accessories to add** - strips the type defines that this rack hasn't
  got, stamped exactly as they would be at creation.
- **Strips to bring in line** - a strip that *exists* but no longer agrees
  with its accessory: the model's device type was swapped, the rail moved,
  a channel was set. Applying re-points the existing device rather than
  creating a second one. A changed **device type** adds the new type's
  components and leaves the ones already there - pruning those is the
  *device's* own Sync from type, which is the only place that knows what
  the cabling depends on.
- **Not on the type** - stamped-looking strips the type no longer defines.
  These are listed and **left alone**: a strip in a live rack is real,
  probably cabled hardware, so syncing never deletes one.

Apply needs **change** on the rack, and the accessory half additionally
needs device-add at its site. A height or starting unit that would leave a
mounted device outside the rack is refused, as on the rack form, and nothing
is applied. Syncing twice does nothing the second time.
`POST /api/racks/{id}/sync-from-type/` is the same operation
(`apply`, plus `dims` / `accessories` to narrow it); without `apply` it is
a dry run that returns the diff.

## Mount a device in a rack

On a device (or in the rack), set:

- **Rack** - which rack it's in.
- **Position** - the lowest rack unit it occupies. The dropdown lists the
  rack's real units (top-down, matching the elevation); units that are already
  taken are greyed out and show the blocking device, so you can only pick a
  spot where the device actually fits.
- **Face** - front or rear. Leave it blank and the device takes both faces.
- **Side** - only for half-width device types: which half of the U (left/right).

The form draws the rack's front and rear beside these fields: click a free unit
to put the device there - that unit becomes its lowest - and its outline turns
red where it would collide. Typing a position or choosing a face moves the
outline.

The device's **height** comes from its [device type](device-catalog.md), so the
elevation knows how many units to fill. Danbyte checks the device actually fits -
it won't let you mount a 2U device where only 1U is free, or overlap two devices
on the same face.

**Full depth takes both faces.** A device whose type is *full depth* (the
default) fills its units front to back, so nothing mounts on the other face of
those units, and a full-depth device can't go behind anything either. Two
shallow devices - patch panels, half-depth switches - share a U front and rear.
A device with no type counts as full depth, as the elevation draws it.

**A racked device is at its rack's site.** A rack from another site is refused
(`Pick a rack in the device's site.`), and so is moving a racked device to
another site without taking it out of the rack. A device with no site takes
its rack's. Its **location**, when set, is in its site too.

These rules hold on every write: the form, the API, the elevation's drag, and
the [spreadsheet import](../features/import-export.md). A placement
and a change to the rack's units or site queue on the rack, so two at once
can't both pass. Rows stored before a rule existed keep reading and editing;
the rule applies when the placement, site or location itself changes.
`manage.py check_dcim_integrity` lists them - devices over each other,
outside their rack's units, or at a different site than their rack - and
changes nothing.

### Half-width devices

Some gear is half a 19″ rack wide - e.g. a Mellanox SN2010 ToR switch - so two
mount side-by-side in a single U. Mark the **device type** as *Half width*
(next to its U height), and each device of that type then picks a **Side**
(left or right) when racked. Two half-width devices may share a U as long as
they're on opposite sides; a full-width device still claims the whole U. The
elevation draws the halves side by side, and a shared U counts once in the
rack's used-units figure.

### Zero-U space (room for PDUs and cabling)

The mounting rails are a fixed width (450 mm at 19″); anything you add to a
cabinet's **outer width** beyond that becomes the **zero-U space** - the
channel down each side of the rails where vertical PDUs and cable management
live. Widen a rack's **Outer width (mm)** past the rails and the form tells
you how much zero-U space that opens per side; the 3D room seats the vertical
strips in it. A cabinet with no extra width has no zero-U space, so a strip
sits hard against the rail.

### Zero-U side mounting (vertical PDUs)

A vertical PDU strip bolts to a rack **rail** instead of occupying units.
Give it a **0U device type**, then on the device pick **Side mount** - left
or right rail - plus an optional **offset from the base** (mm) and a
**span** in U (blank draws about three quarters of the rack). Side mounting
replaces U placement: no position and no half-width side.

A side-mounted strip also picks a **channel** - front or rear - which is
the face it's reachable from. The elevation then draws it on **that
elevation only**, and the 3D room seats it at that depth in the cabinet.
Leave the channel blank and the strip shows on **both** elevations, which
is what strips mounted before this field existed do: we genuinely don't
know which channel they're in, so neither view claims otherwise.

The elevation grows a slim **rail lane on each side** of the U grid listing
that rail's strips (click one to open it; **+** hangs a new one with the
rack and rail pre-picked), and the 3D room draws the strip on the cabinet's
flank. **0U gear never counts against used units** - including 0U types
parked at a U position, which previously (and wrongly) charged a full unit.

## Rack elevations

The rack's **Overview** puts the rack's facts on the left - the **Rack** and
**Capacity** cards, with custom fields between them - and the rack itself on
the right, under **Elevation**: paired elevations, **front and rear side by
side**. Until you zoom by hand the zoom steps down until both faces fit the
column, so a whole rack reads without scrolling; **−** and **+** take over
from there. The Devices tab keeps a single toggleable elevation. Three
**display modes**:

| Mode | Shows |
|---|---|
| **Names** | Clean labeled blocks (position, name, height). |
| **Images** | The device type's [rack-face image](device-catalog.md#rack-face-images) stretched across the block, name overlaid. |
| **Render** | The type's **faceplate drawn as hardware** (the same mm-true port rendering as the device page), whole rack at true proportions. |

**Display ▾**, after the modes, holds the drawing's ticks: **Text** (Images
and Render) writes the names over the photos and drawings, so a photo-real
rack stays clean when you want it to; **Ports** draws each device's live
ports - see [below](#live-ports-on-the-elevation); and **Show** picks the
gear to show. On a narrow screen the button is its icon.

**Depth-aware faces:** a device mounts on one face, but if its device type is
**full depth** (the default) it fills the other face too, and shows its
**other side** there: in Names a block like its own; in Images its type's
rear photo; in Render its rear photo with the ports marked on it, or the
drawing of its rear. Where the type has no rear photo or drawing, the block
is **hatched** (diagonal stripes) with its name, so the face still shows
what's blocking the space - never an empty block. Mark shallow gear (patch
panels, half-depth switches) as *not* full depth on the device type and it
frees the other face.

**Show** keeps the gear mounted on one face - **Front-mounted** or
**Rear-mounted** - or **All**. The gear it leaves out stays in its units as
nameless hatched space, on both faces, so the used and free units still read
true; the 0U strips on the rails always show. The choice is in the URL
(`?show=rear`), like the 2D | 3D switch, so a link opens the same view.

Elevations follow the rack's **width** (10″ / 19″ / 21″ / 23″) - a 10″
lab rack draws narrower than a 23″ telco rack, and Images/Render modes use
true 1U proportions so photos aren't squashed. Occupied units fill
edge-to-edge and take the **device role's color** in Names mode.

On a rack's own page you can **drag device blocks between units** - drop a
block on an empty band and the device re-mounts with that band as its top U
(occupied space, rack edges and half-width columns are respected; a plain
click still opens the device). **Export** saves the front + rear pair for a
change ticket, a wiki page or the rack door (see [Export](#export)).

### Export

**Export**, at the end of the Elevation toolbar, saves the rack as a file
(on a narrow screen the button is its icon). The file is drawn from the
rack's data, not captured from the screen, and is light-themed whatever
theme the app is in: the front and rear side by side under their names,
the units numbered beside each frame in the rack's own numbering, every
device in its units in the mode on screen - Names, or Images with **Text**
on or off - half-width devices in their half, the 0U strips in their rail
lanes, and full-depth gear's other side on the face it isn't mounted on: a
block like its own in Names, its rear photo in Images, hatched with its name
where it has none. **Show** applies too: the gear it leaves out is drawn as
nameless hatched space.

| Format | What you get |
|---|---|
| **PNG** | The drawing at twice screen resolution |
| **SVG** | The same drawing as vectors, with its font and every photo inside the file, so it opens anywhere without Danbyte |
| **PDF…** | The drawing on one sheet of A4, A3, Letter or Tabloid, portrait or landscape - A4 portrait until you choose - fitted, under a title block |
| **Print** | The same PDF on the paper last chosen, in a new tab to print |

The PNG and SVG carry the rack's name over the drawing, with its site,
location, width, units used and the time. On a PDF the title block sits in
the sheet's bottom-right corner and is written by the server from the rack:
its name; its site, location, type and the units used and free; the date,
the Danbyte version and the page. Print it at **Actual size**; if the
browser blocks the new tab, the PDF is downloaded instead. The paper is
remembered in your browser, and Print shows which it will use.

Every file is named after the rack and the day:
`r12-elevation-2026-10-02.pdf`. A photo that will not load is drawn as its
device's Names block - on a device's other side, hatched - and the menu says
how many. **Render** has no vector
drawing yet: in Render the PNG is a picture of the screen, and the SVG and
PDF draw the Images look - the menu and the PDF dialog say so. The 3D view
keeps its own **PNG**.

### Live ports on the elevation

On the rack's own page, with **Ports** ticked in Display ▾ (the default),
the elevation carries every device's port state, read for the whole rack in
one request while the Overview is open (the
[port state](#api-port-state-and-3d-geometry) below):

- **Render** draws each device as its device page's Panel does. A type with
  [photo ports](device-catalog.md#photo-ports) shows its photo with the
  ports marked on it; any other draws its faceplate as hardware - its type's
  saved layout with the installed modules composed in, or the automatic one.
  **Images** marks the ports on the photo the same way; a type without photo
  ports keeps its plain photo. On the face a full-depth device isn't mounted
  on, its rear plate is live the same way: a server's NICs and power inlets
  on its rear photo.
- Ports wear the device page's colours: cabled ports in their speed tier,
  free ones outlined, reserved amber, disabled dashed, trunks notched; a
  hardware marker wears its part's status and a module bay its occupancy.
  Where the device is polled over SNMP, a port also wears its **live dot**.
- **Hover** a port for the device page's hover card - the fields set under
  **Settings → Component details**, including **Far end**: the device and
  port its cable reaches, named only when you can view that device.
- **Click** a cabled port to open the trace of its run in a dialog; a free
  port opens its own page, and a click between ports opens the device, as
  before. A disk bay or another hardware marker shows its part, and its
  card - or a right-click on it - sets the part's
  [status](devices.md#part-status); the rest of the part is edited on the
  device.
- Every block shows its **ports in use** over its counted ports - `38 / 48`,
  in all three modes, on the face the device is mounted on only - by the
  [port counting rule](devices.md#what-counts-as-a-port): ports cabled or
  reserved, out of its physical interfaces and front ports, plus its virtual
  interfaces where **Count virtual interfaces** is on. Hover the count for
  that in words. A device with no counted ports shows none. In Images and
  Render the count goes with the name, so **Text** off clears both.

**Ports** off draws the elevation as it was before: the bare photos in
Images, each type's plain drawing in Render, and no counts. The tick is kept
in your browser, and it is the same one as on a
[cabinet's plate](cabinets.md).

The elevation asks nothing per device for its ports: each device type loads
once, and the live SNMP state once per device that draws interface ports in
Images or Render and that SNMP may have seen - polled with interfaces, or a
stack member. It is shared with the device page and the 3D room, and fresh
for a minute. Names mode asks for no SNMP state at all.

The **Capacity** card gives the rack's **Free** units (those no device
occupies) and its ports in use over counted ports, in two rows: **Ports**,
the counted interfaces of its devices that are not patch panels, and
**Panel ports**, its front ports and every port of a patch-panel device -
the split the racks list, the floor plan and the site's
[Capacity](../models/site.md#the-capacity-tab) tab show, so a rack reads the
same everywhere. Each links to **DCIM → Connections → Port utilization**
filtered to this rack (`/port-utilization?rack=<id>`), for the per-device
breakdown. Like the rack's used units and power, the rack's port figures
count every device in it, while the blocks and the breakdown list the
devices you can view.

!!! note "Changed in 0.17"
    The Capacity card's **Ports** row counted a rack's patch-panel ports
    together with its devices' interfaces. They are now two rows, **Ports**
    and **Panel ports**, which add up to the old figure.

### The rack in 3D

**2D | 3D**, first on the Elevation toolbar, swaps the drawing for the rack in
3D (`?viz=3d` keeps it in the URL) - the same cabinet, devices and photo
faceplates as the floor plan's [3D room](../features/floor-plans.md#the-3d-room-view),
this rack alone. Drag to turn it and scroll to zoom; **Front** and **Rear**
look straight at either face, and a double-click on a device frames it.
Ports on the photos are coloured as the room colours them - cabled by
speed, free faint, disabled grey, live SNMP where it is polled - and a port
held for a cable shows amber. Click a device or a port for its card;
**PNG** saves the view. The view draws at the quality picked in a floor
plan's 3D View menu on this device. Cables are not drawn in this view yet.

Racks roll up **power**: supply is every *primary* power
feed delivered to the rack (volts × amps × max-utilisation%,
three-phase × √3) - or, where no primary feed with a voltage and amperage
reaches the rack, the rated (maximum) draw of the rack's PDUs, marked as a
**PDU rating**. A PDU's inlets are redundant feeds of the same outlets, so a
PDU counts its smallest rated inlet - unless its outlets name different
inlets, when each inlet feeds its own bank and they add up. Two or more PDUs
are taken as A and B sides, split as evenly as their ratings allow, and the
supply is the smaller side, since either
side must carry the rack alone: an unequal pair of 3.7 kW and 7.4 kW is
3.7 kW, four equal PDUs two of them. A **Power budget (W)** on the rack
form (`max_power_w`) overrides both: what the rack may draw - a cooling or
contract limit - whatever its feeds could deliver. With a budget set, demand
is measured against it and the figure is marked *budget*; the API keeps what
the feeds or PDUs would give as `supplied_w`. Demand is the racked devices' power-port draws -
allocated where you've recorded it, otherwise the nameplate sum (labelled
*nameplate*). The rack page shows **demand / supply** (`1.2 kW / 3.6 kW`,
in W below 1 kW) and turns red when over; a rack drawing power with neither
a feed nor a PDU rating says *No feed*. The floor plan's tile popover and
rack panel read the same figure, and so does the racks list's **Power**
column, with a bar in front: it is offered in the list's **Columns** menu,
hidden until you tick it, and sorts by how much of the supply the demand
takes.

The rack's **Power feeds** tab lists the feeds delivered to it, the same rows
as the feeds list; tick them to edit or delete several at once (see
[Power](../features/power.md#editing-and-deleting-several-at-once)).

The racks list offers **Ports** and **Panel ports** the same way - hidden
until ticked, each a bar and *in use / counted* (`46 / 48`), sorting by the
share in use and opening the Port utilization page on the rack. Counting
ports costs the list a few queries, so it asks for them
(`?include=ports`) only while one of the two is shown.

A rack's space, power and ports share one scale wherever they are drawn as a
bar or a colour: green up to the warning level, amber above it, red above the
critical level. The levels are 80 % and 95 % until a tenant admin changes them
under **Settings → Tenant policy → Rack capacity** (`capacity_warn_pct`,
`capacity_critical_pct`; the warning level must sit below the critical one).
The racks list's **Used**, **Power** and **Ports** bars, the floor plan's
tiles and its [Color by](../features/floor-plans.md#color-by) legend, the
tile popover, the 3D room and the site's Capacity tab all use them. A page
already open picks up changed levels on its next load.

!!! note "Changed in 0.18"
    The 80 / 95 % levels are a tenant setting, and a rack can carry a power
    budget that capacity measures against instead of its feeds.

!!! note "Changed in 0.17"
    Power figures of 1 kW and up read in kW (`3.6 kW` where the page showed
    `3600 W`). A rack with no primary feed had no supply figure at all; it now
    falls back to its PDUs' inlet ratings, taken as A and B sides - model
    the feeds (a primary and a redundant one) for the exact figure. The
    racks list's **Used** bar measures the exact share: a 42U rack with 40U
    used (95.2 %) is red there now, as it already was on the floor plan.

!!! note "Changed in 0.17.2"
    The PDU rating no longer adds up a PDU's inlets or averages a pair: a
    PDU with two 3680 W inlets rates 3680 W (it read 7360 W), and a 3680 W
    and a 7360 W PDU rate 3680 W (it read 5520 W).

!!! note "Power numbers changed with the PDU fix"
    Devices that **have power outlets** (PDUs - distributors) no longer
    contribute their inlet draw to the rack's demand: a PDU's inlet
    restates its children's draws, so counting both **double-counted**
    every rack that recorded its PDU. If a rack's demand dropped after
    upgrading, this fix is why - the new number is the honest one.

Racks can carry a **weight budget** (max weight + unit on the rack form -
the floor or rack load rating). Every racked device's *type* weight sums
against it, normalised to kg; the rack page shows **used / budget** and turns
red when over. Types without a weight contribute nothing, so the number is a
floor, not a guarantee.

Racks can carry a **location** (building / floor / room within their
site) - the Locations page's **Rack elevations** button then shows exactly
the racks in that room, and `/api/racks/?location=` filters likewise. A
location can also be drawn as a [floor plan](../features/floor-plans.md),
with tiles linked back to its racks.

Every device's own page shows its rack with the device **highlighted**.

## Images

The rack's Overview has an **Images** gallery - attach any number of captioned
photos (front/rear shots, cabling, labels). Uploading and removing require
**change** permission on racks; viewers see it read-only. It's the same shared
attachment system used on [devices](devices.md#images), sites, and locations -
including the grid/list toggle and the file details the list shows.

## API: a floor plan's racks and their ports

`GET /api/racks/?floor_plan=<id>` lists the racks the tiles of one
[floor plan](../features/floor-plans.md) stand for, each once - none unless you
can view that plan. Add `include=ports`, on the list or on one rack's
`GET /api/racks/{id}/`, and each rack also carries its port figures, split in
two:

- `ports`: the counted interfaces - physical, plus virtual ones where
  **Count virtual interfaces** is on - of its devices that are not patch
  panels;
- `panel_ports`: its front ports, and every counted port of a device whose
  role is a patch-panel role.

Each holds `total`, `connected`, `reserved`, `free` and `marked` under the
[port counting rule](devices.md#what-counts-as-a-port); added together they
are the rack's `ports` in the [port state](#api-port-state-and-3d-geometry)
below. Without `include=ports` both are null. Like the rack's units and
power, they count every device in the rack. A page of racks costs the same
number of queries whatever stands in them, ports or not.

A rack's `power` holds `available_w`, `allocated_w`, `maximum_w` and
`supply`: `feed` when the supply is its primary feeds, `pdu_rating` when it is
its PDUs' inlet ratings (the smaller of two sides), null when there is
neither. A site adds its racks up
floor plan by floor plan on its [Capacity](../models/site.md#capacity) API.

## API: port state and 3D geometry

Two read-only endpoints serve a single rack's views. Both need **view** on
racks, and each costs the same number of queries whatever the rack holds.

`GET /api/racks/{id}/port-state/` returns every port in the rack:

- `rack`: `u_height`, `u_used` and `u_free` (the units its devices occupy,
  as the Overview's *Used* counts them), `power` (the same roll-up as the
  rack page), `ports` and `count_virtual`. `ports` holds `total`,
  `connected`, `reserved`, `free` and `marked`, counted by the
  [port counting rule](devices.md#what-counts-as-a-port); `count_virtual`
  says whether virtual interfaces were counted.
- `devices`, keyed by device id, each with:
    - `ports`: the device's counts, the same numbers as its Port utilization
      card. A device with no counted ports reads zero.
    - `face`: its photo-port markers resolved to its real components, as
      `GET /api/devices/face-ports/?ids=` returns them, with `drift` always
      null.
    - `interfaces`: its physical interfaces, with what the drawn faceplate
      colours and hovers them by: name, label, type, speed, enabled, VLAN
      mode, VLAN and tagged count, LAG, IPs, MAC, MTU, description and tags.
      The cable comes as its state (`free`, `connected`, `reserved` or
      `marked`) with its id, label and type, and `peer` names the far end.
    - `modules`: its installed modules as the drawn faceplate composes them -
      `id`, `module_bay`, `module_type_faceplate` and `module_interfaces`,
      as `GET /api/modules/?device=` gives them.
    - `components`: by kind (`console-port`, `power-port`, `front-port`…),
      the `id`, `name` and `type` of each component of a kind its type's
      saved faceplate layout (or a module type's) places - only those kinds.
    - `observed`: whether SNMP may have seen its ports - it was polled with
      interfaces, or it is a stack member, whose stack's poll may describe
      it. The page asks for live port state only for these.

The rack's figures count every device in the rack, as its used units and
power do. The `devices` entries list only the devices you can view, and in
them only the interfaces, IP addresses, modules and components you can view.
A photo marker for a port you can't view - a front port, a power port - stays
unresolved, without its id, cable or far end; `GET /api/devices/face-ports/`
follows the same rule. A far end is named only when its device (or, for a
PDU inlet, its power feed) is one you can view.

`GET /api/racks/{id}/scene/` returns the rack alone for a 3D view. It is the
same object a [floor plan's](../features/floor-plans.md#the-3d-room-view) 3D
scene carries for a rack tile: size, numbering and outer dimensions, plus the
positioned and side-mounted devices with their photos, port markers, power
component names and the feed type of each PDU. The devices are limited to the
ones you can view.

## API: the elevation as a PDF

`POST /api/racks/{id}/export/pdf/` lays the elevation out on one sheet of
paper and returns the PDF as a download. The body:

| Field | Shape |
|---|---|
| `svg` | the drawing, as the Export menu's SVG draws it (required) |
| `paper` | `{size: a4\|a3\|letter\|tabloid, orientation: portrait\|landscape}`; A4 portrait when absent, and either key alone keeps the other's default |
| `title_block` | `false` leaves the title block off; `true` by default |

The title block is written by the server from the rack - its name; its
site, location, type and the units used and free, counted as the rack's
*Used* figure counts them; the date, the Danbyte version and `Page 1 / 1` -
and nothing in the request changes it. The drawing is the one your browser
made from the devices you can view.

It needs **view** on racks (a 403 without), and the rack must be one you can
see: another tenant's, or one outside the sites you are limited to, is a
404. The SVG is checked and limited exactly as the topology's is - the same
sanitizer and size, text and render limits (see
[PDF export API](../features/topology.md#pdf-export-api)) - and the same
one PDF at a time per user and two at a time across the server count every
drawing's PDFs together.

`?print=1` answers `{"url": "/api/racks/{id}/export/pdf/<token>/"}` instead
of the file: the PDF for five minutes, to you alone and in the same tenant,
while you can still view the rack. `GET` it to open the PDF in the browser,
or add `?download=1` to save it. You keep one such rack PDF per tenant: a
newer one replaces it, and the older link is a 404. Without a cache to keep
it the answer is a 503.
