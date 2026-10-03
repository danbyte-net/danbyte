---
icon: lucide/rows-4
---

# Cabinets

A **cabinet** is an enclosure whose gear sits on DIN rails rather than in rack
units: a control cabinet with PLCs and I/O, a distribution board, a small
industrial switch box on a factory wall. Positions in a cabinet are measured
in millimetres, so it is a model of its own next to [racks](racks.md), not a
rack of a different height.

## Add a cabinet

1. Open **DCIM → Cabinets** and click **Add cabinet**.
2. Name it and pick its **site**. Names are unique per site, like rack names.
3. Optionally pick a [**cabinet type**](#cabinet-types), a
   [**role**](#cabinet-roles), a **location** within the site, a **status**,
   tags and a **facility ID** (the label on the door, e.g. `=UH1+K1`).
4. Give the **mounting plate** size - the plate the rails are fixed to - and,
   if you know it, the **outer** width, height and depth of the box.

All sizes are whole millimetres. The plate has to fit in the box: an outer
width or height smaller than the plate is refused. A cabinet created with a
type takes the type's sizes; a size you enter, or clear, wins. Changing the
type of an existing cabinet leaves its sizes as they are.

A cabinet page has the usual tabs - Overview, Documents, Journal and Change
log - and cabinets list on their site's and location's pages. Cabinets carry
custom fields, tags, contacts, images and statuses like racks do; the status
catalog offers *Active*, *Planned*, *Reserved*, *Available* and *Deprecated*
for them, *Active* first.

### Cabinet types

A **cabinet type** is an enclosure *model* - "Rittal AE 1060.500" - with the
plate and box sizes every cabinet of that model has. Define them on **DCIM →
Cabinet types**. Picking a type on the cabinet form fills the sizes; each
stays editable, so the cabinet remains the source of truth. A type in use by
a cabinet cannot be deleted.

### Cabinet roles

A **cabinet role** says what a cabinet is for (*distribution*, *control*,
*metering*, …) with a colour, so cabinets group visually in lists and
pickers. Define them on the **Cabinet roles** page; none ship by default. A
role in use cannot be deleted.

## Rails

The mounting plate carries **DIN rails**. Each rail has a **label**, unique in
its cabinet, and a **profile** - *TS 35*, *TS 15* or *G 32* - which sets the
height of the band it takes on the plate (35, 15 or 32 mm). It is placed by
its **left end** and its **centreline**, measured from the plate's top-left
corner, and has a **length**, all in tenths of a millimetre.

A rail has to lie on the plate, and two rails may not overlap where they run
side by side. Rails that only touch are fine, so rails can sit end to end on
one line or band against band. A plate cannot shrink past its rails; move
them in the same save.

On a cabinet's Overview, **Plate** draws the mounting plate to scale with its
rails, inside the box when its outer size is known; hover a rail for its
numbers. **Edit rails** lists one row per rail - label, profile, left end,
centreline, length - beside the drawing, where a rail can also be dragged in
whole millimetres or nudged with the arrow keys (Shift for 10 mm). **Add rail**
puts a new rail across the plate 125 mm below the lowest one (75 mm from the
top for the first), or in the first free spot from the top when that runs off
the plate. The rules above are checked as you type; **Save changes** writes
the whole set. The cabinet list has a **Rails** column.

A cabinet type carries **rail templates** of the same shape, edited the same
way on its page. A new cabinet of the type starts with its rails, unless rails
are given with it. A change to a cabinet's rails, or to a type's templates, is
one entry on its change log, listing the rails before and after.

### Sync from type

**Sync from type**, in a cabinet's header, compares it with its type: the
sizes that differ, the template rails it lacks (*add*), rails with a
template's label that sit elsewhere or have another profile (*update*), and
its own rails no template names (*extra*). Applying copies the sizes and adds
or moves rails; it never removes one. When both sizes and rails differ, either
can be left out. A sync whose result would not fit the plate is refused as a
whole.

## Mounting devices

A device goes in a cabinet when its type mounts on DIN rails: the
[device type](device-catalog.md#device-types) lists the rail profiles it fits
and its body size. The device sits on one of the cabinet's rails at an
**offset** - from the rail's left end to the device's left edge, in tenths of
a millimetre - and takes its type's width from there. Devices on one rail may
touch but not overlap, and stay on the rail. With no offset, a device takes
the first gap from the left that it fits in.

On the cabinet's Overview the plate draws each device on its rail at its
type's size - its front photo, else a box in its role's colour - and its name.
A [calibrated](device-catalog.md#photo-ports) photo is drawn at its true size,
its left guide on the device's left edge and its rail line on the rail; an
uncalibrated one is stretched to the device's size. Hover a device for its
type and offset; click to open it.

The toolbar over the plate works like a rack's elevation. **Images** (the
default) is the look above; **Names** draws each device as a box in its role's
colour with its name; **Render** lays each device's live faceplate on it - its
ports coloured by cable, speed and SNMP state, with the device page's hover
card - at true size when the photo is calibrated. **Images** marks the ports
on a photo the same way, where the device type has
[photo ports](device-catalog.md#photo-ports), as a rack's elevation does; a
device without keeps its plain photo. In both, a click on a cabled port opens
the trace of its run in a dialog, a free port opens its own page, and the key
to the colours sits under the plate. Images reads every device's markers in
one request; the interfaces they stand for load per device, as Render loads
them, and the live SNMP state only for a photo that marks interfaces. Disk
bays and other hardware markers only show their part in Images - edit parts
from the device.
**Labels** hides the device names (and, in Names, the rail labels); **−** and
**+** zoom, starting fitted to the column (Render starts larger) and
scrolling when the plate grows wider; **Export** saves the plate as a file
or prints it (see [Export](#export)). The mode, zoom and labels are
remembered in your browser. **Add device** in the Plate heading opens a
new device on the rail you pick, which takes the first free gap; **Assign**
puts an existing device of the site on a rail, offering only devices whose
type fits the rail's profile. Each rail in those menus shows its widest free
stretch. The **Devices** tab lists the cabinet's devices with their rail and
offset.

### Export

**Export**, at the end of the plate's toolbar, saves the plate as a file (on
a narrow screen the button is its icon). The file is drawn from the
cabinet's data, not captured from the screen, and is light-themed whatever
theme the app is in: the plate true to its millimetres inside its box, the
rails with their labels, and each device on its rail at its offset in the
mode on screen - Names, or Images with each calibrated photo at its true
size and the rest stretched over their devices - its name where the page
writes it, with **Labels** on.

| Format | What you get |
|---|---|
| **PNG** | The drawing at twice screen resolution |
| **SVG** | The same drawing as vectors, one pixel to the millimetre, with its font and every photo inside the file |
| **PDF…** | The drawing on one sheet of A4, A3, Letter or Tabloid, portrait or landscape - A4 landscape until you choose - fitted, under a title block |
| **Print** | The same PDF on the paper last chosen, in a new tab to print |

The PNG and SVG carry the cabinet's name over the drawing, with its site,
location, plate size and the time. On a PDF the title block is written by
the server from the cabinet: its name; its site, location, type and plate
size; the date, the Danbyte version and the page. Print it at **Actual
size**; if the browser blocks the new tab, the PDF is downloaded instead.
The paper is remembered in your browser, and Print shows which it will use.

Every file is named after the cabinet and the day:
`k1-plate-2026-10-02.svg`. A photo that will not load is drawn as its
device's Names box, and the menu says how many. **Render** has no vector
drawing yet: in Render the PNG is a picture of the screen, and the SVG and
PDF draw the Images look - the menu and the PDF dialog say so. There is no
Export while you arrange the plate.

### The plate in 3D

**2D | 3D**, first on the plate's toolbar, swaps the drawing for the cabinet
in 3D (`?viz=3d` keeps it in the URL): the enclosure at its outer size with
its door standing open, the galvanised mounting plate inside, each rail as a
bar of its profile, and each device on its rail as a box of its type's
width, height and depth, its front photo on its face - at true size where
the photo is [calibrated](device-catalog.md#photo-ports), stretched over the
face where it is not, the role's colour where there is none. A type with no
depth recorded is drawn 90 mm deep.

The ports marked on a device's photo are drawn on it, at their markers, as
the 3D room draws a racked device's: cabled ports in their speed tier, free
ones faint in their type's, disabled grey, a port held for a cable amber,
live SNMP state where the device is polled, a part's status on a hardware
marker and an amber outline where SNMP disagrees with the record. Where a
calibrated photo is clipped to its device, so are its ports. They resolve
in one request when the view opens - the room's own, so the drift outline
costs a check per device - and the key to their colours sits under the view.

Drag to turn it and scroll to zoom. **Close door** and **Open door** swing
the door on its left-hand hinge (it snaps when the system asks for reduced
motion); **Front** and **Rear** look straight at either side, as a
double-click on the cabinet does; **PNG** downloads `<cabinet>-3d.png`.
Hover a device for its card - type, role, rail and offset, size - and click
it to keep the card with **Open device**; hover a port for its card - state,
speed, the cable and its far end - and click it to keep that one. The view
draws at the quality picked in a floor plan's 3D View menu on this device. The same cabinet,
door and all, opens in a floor plan's
[3D room](../features/floor-plans.md#the-3d-room-view).

### Placing a device

In the device form, **Mounting** switches between **Rack** and **Cabinet**.
On **Cabinet**, pick the cabinet and a rail: the offset starts at the first
free spot the device fits, and the plate is drawn under the fields with the
device's outline there. Click a free spot on a rail to put it there,
double-click a gap to centre it in the gap, drag the outline along or across
rails, or nudge it with the arrow keys (Shift for 10 mm). It snaps flush to a
neighbour or the rail's end, and turns red where it would overlap or run off
the rail; rails of a profile the device does not fit are dimmed.

The slider under the plate moves the device along its rail; its track shows
what is taken. Beside it, buttons jump to the previous or next gap the device
fits in, or set it flush left or right in its gap; on the slider, Page Up and
Page Down jump between gaps and Home and End go to the first and last spot.
The line under the plate reads the device's edges (*120–180 mm*), or *No gap
fits*. A blank offset still takes the first gap.

### Arranging a cabinet

**Arrange** in the Plate heading turns the plate into the same placer for
every device in it: click a device to pick it, then drag it, nudge it or use
the slider. Move as many as you like - moved devices show where they will go,
red where they would clash - and **Save** applies them in one go, so devices
can swap places. With nothing picked, click a free spot on a rail for **Add
device here** or **Assign here**. Escape drops the pick; leaving with unsaved
moves asks first. Arrange is offered to users who may change devices. While
arranging, a plate in Render shows Images until you save or cancel.

### Where a device may sit

A device in a cabinet is at the cabinet's site: one without a site takes it,
and the cabinet's location when it has none; one at another site is refused.
A device sits in a rack or a cabinet, never both. Taking a device out of its
cabinet takes it off its rail; a device can also be in a cabinet off any rail.

Rails, cabinets and types keep their devices:

- a rail that carries devices cannot be removed, shortened past them, or given
  a profile they do not mount on - moving a rail moves its devices with it;
- a cabinet with devices on its rails cannot be deleted, nor move to another
  site while devices are in it;
- a type's width or profiles cannot change in a way devices of it on rails
  would not survive.

Sync from type skips a rail update that its devices would not survive and
lists it as *blocked*, with the reason. Search shows where a device sits -
*K1 · R2 @ 120 mm* - and finds it by its cabinet's name.

## Floor plans

A [floor plan](../features/floor-plans.md) tile can link to a cabinet:
in the plan editor's inspector, **Linked object → Cabinet** lists the
cabinets of the plan's site, and **Fit to cabinet** sizes the tile to the
cabinet's outer width × depth. Clicking the tile opens a panel with the
plate drawn and its devices rail by rail; the cabinet page's **Show on floor
plan** opens the plan on its tile. Its
live state (`GET /api/floor-plans/{id}/state/`) carries the cabinet's
`device_count`, `rail_count` and the worst monitoring `check` of its devices;
cable runs to its devices end on its tile; the 3D scene lists it as a box of
its outer size - the plate plus 50 mm, 200 mm deep, where the outer size is
not recorded - whose card opens its door onto the plate and its devices.
`/api/floor-plan-tiles/?cabinet={id}` finds the tiles that link to it.

## Permissions

Cabinets, cabinet types and cabinet roles are object types of their own in
permissions (`cabinet`, `cabinettype`, `cabinetrole`). A permission limited to
sites limits cabinets by their site, as it does racks. Types and roles are
shared by the whole tenant.

## API

| Endpoint | What |
|---|---|
| `/api/cabinets/` | Cabinets. Filters: `site`, `location`, `role`, `status`, `cabinet_type`, `search` (name, facility ID, description, custom fields). |
| `/api/cabinet-types/` | Cabinet types. Filters: `manufacturer`, `search`. |
| `/api/cabinet-roles/` | Cabinet roles. Filter: `search`. |

Sizes are `inner_width_mm` and `inner_height_mm` (the plate, required unless
the type gives them) and `outer_width_mm`, `outer_height_mm` and
`outer_depth_mm`. References are written as `site_id`, `location_id`,
`role_id`, `cabinet_type_id` and `status_id`, and read back as small objects.
`?picker=1` returns a short form of each list for pickers. Deleting a type or
role that cabinets use answers `409` with how many use it.

A cabinet's `rails`, and a type's `rail_templates`, are read and written with
it as a list of `{id, label, profile, x_mm, y_mm, length_mm}`. A write
replaces the whole set: an item with the `id` of one of its rails updates
that rail, an item without one is a new rail, and rails left out are
removed. Errors come back per rail, in the order sent.

`POST /api/cabinets/{id}/sync-from-type/` answers the difference
(`{"applied": false, "diff": …}`, its `rails` split into `add`, `update`,
`blocked` and `extra`); with `{"apply": true}` it applies it, and `sizes` and
`rails` (both true by default) narrow what applies.

A device reads `cabinet`, `din_rail` and `din_offset_mm`, and writes
`cabinet_id`, `din_rail_id` and `din_offset_mm`; `/api/devices/?cabinet=` and
`?din_rail=` filter by them, and `?din_profile=ts35` keeps devices whose type
mounts on that profile. A device type has `width_mm`, `height_mm`,
`depth_mm`, `din_profiles` (a list of `ts35`, `ts15`, `g32`) and
`din_rail_mm`. A cabinet counts its devices in `device_count`.

`POST /api/cabinets/{id}/arrange/` moves devices already in the cabinet in one
save: `{"placements": [{"device_id", "din_rail_id", "din_offset_mm"}]}`, a
null rail taking a device off its rail. The arrangement is checked as a whole
- every rail's devices fit and none overlap, moved or not - so devices can
swap places; errors come back per placement, in order, and nothing changes
unless all of it fits. It needs change on every device it moves.

`POST /api/cabinets/{id}/export/pdf/` lays the plate out on one sheet of
paper and returns the PDF as a download: `svg` is the drawing, as the Export
menu's SVG draws it (required); `paper` is `{size: a4|a3|letter|tabloid,
orientation: portrait|landscape}`, A4 landscape when absent, either key alone
keeping the other's default; `title_block: false` leaves the title block
off. The server writes the title block from the cabinet - its name; its
site, location, type and plate size; the date, the Danbyte version and
`Page 1 / 1` - and nothing in the request changes it. It needs view on
cabinets (a 403 without), and another tenant's cabinet, or one outside the
sites you are limited to, is a 404. The SVG is checked and limited as the
[topology's PDF](../features/topology.md#pdf-export-api) is, and the same
one PDF at a time per user and two across the server count every drawing's
PDFs together. `?print=1` answers `{"url":
"/api/cabinets/{id}/export/pdf/<token>/"}` instead: the PDF for five
minutes, to you alone in the same tenant while you can view the cabinet,
`?download=1` to save it; a newer one replaces it.
