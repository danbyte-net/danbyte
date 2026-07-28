---
icon: lucide/layout-grid
---

# Floor plans

**Maps → Floor plans** lays out a [location](regions-locations.md) — a room, a
hall, a floor — as a grid of tiles: racks, aisles, walls, cooling units,
cameras, doors… Each tile can **link to a real object** (a rack, a device, a
power panel or feed, or another floor plan), so the drawing stays a live view
of your DCIM data rather than a static diagram.

Everything is self-contained: an SVG canvas, uploaded background images served
from your own deployment, no external tile servers — floor plans work fully
air-gapped.

## The palette is yours (zero pre-filled data)

There are **no built-in tile kinds**. Before placing tiles, define your
palette under **Customize → Floor tiles**: each tile type has a name, a color,
an optional **icon** (searchable Lucide picker — type "cam" and pick a camera),
and a default size in cells (a rack is 1×1, an aisle might be 1×4).

Two sources feed the palette automatically:

- **Floor tile types** — the kinds you create.
- **Device roles** — every role doubles as a tile type, reusing its color, so
  a shop that already defined "Firewall / Access / Server" roles gets matching
  tiles for free.

Two ticks on a tile type change how its tiles behave:

- **Background zone** — the tile paints the grid background instead of
  occupying it: red for a hot aisle, blue for cold, an amber security zone…
  Zones render *under* normal tiles, and normal tiles may sit on top of them
  (they're the one exception to the no-stacking rule). Their name labels
  (*Cold aisle*, *Hot aisle*…) can be hidden with the **Zone labels** toggle
  under **View** when they clutter a busy plan.
- **Camera field of view** — tiles of this type get a **FOV cone**
  (direction / angle / reach in cells) drawn on the canvas. The same tick
  exists on **device roles** (e.g. a CCTV role), so camera devices get cones
  whichever way you type the tile. Toggle all cones under **View**.
  Per tile: a dice-style **anchor picker** sets where the cone emits from
  (center or any corner), and a **PTZ** toggle swaps the cone for a full
  **360° coverage ring** (radius = reach) for pan-tilt-zoom cameras.

A tile's *behaviour* never depends on what its type is called — it comes from
what the tile **links to**. A tile linked to a rack acts like a rack tile
whether you named its type "Rack", "Cabinet", or "Skab".

### Open a tile type

Clicking a name under **Customize → Floor tiles** opens that type's detail page
— the answer to "what breaks if I change this?" before you recolour, rename, or
delete a palette entry.

- **Overview** — its colour, icon, slug and default size; the three rendering
  ticks (**Background zone**, **Camera field of view**, **Perforated**); and a
  short **Site markers** list, because a type is also the vocabulary for free
  markers on the geographic [site map](site-map.md). Markers are a handful at
  most, so they sit here rather than in a tab of their own.
- **Placed** — every tile of this type on any floor plan, with the plan, the
  grid cell, the size, and what the tile is linked to. Both placed tiles and
  site markers block a delete, and both are listed here.
- **Journal** — your notes on this tile type.
- **History** — the change log for the type itself.

## Creating a plan

**Maps → Floor plans → Add** (or the **Floor plan** button on a Location
page). A plan belongs to a location, has a grid (default 24×16 cells, up to
512×512), and can carry an uploaded **background image** — a blueprint or
photo scaled under the grid with adjustable opacity.

The grid also carries a **real-world scale**: a **cell size** in millimetres
(default 600 — one standard raised-floor tile) and a **ceiling height**
(default 3000). Existing plans keep working untouched; the scale powers the
3D view, route-length estimation, and the scale bar on printed drawings.

## The 3D room view

The **2D / 3D** toggle in the plan header (or `?viz=3d` in the URL) turns the
plan into a navigable room: rack tiles become cabinets at their grid
positions — sized from the rack's rail width, outer dimensions and U height —
with their racked devices drawn at true U positions when you move close.
Trays render at their recorded level/elevation (overhead runs hang below the
ceiling, underfloor runs sit beneath the slab), zones tint the floor, and the
uploaded blueprint textures it.

- **Navigate**: drag to orbit, scroll to zoom, right-drag to pan.
  **Keyboard**: the arrow keys or WASD glide the camera level with the floor
  in the direction it faces — the way to walk the aisles — while **Space**
  rises, **C** descends (PageUp/PageDown work too) and holding **Shift**
  sprints at 4× speed. Speed tracks how far you are zoomed out, so close-up
  moves are fine-grained and hall-scale hops are quick. The first key press
  also pulls the orbit pivot to a few metres ahead of the camera, so
  dragging looks around first-person-style while you walk; **double-click a
  rack** to re-anchor the pivot on it and orbit for inspection, flying the
  camera to its front.
- **Zoom has no wall**: the wheel zooms right down to a few centimetres from
  a faceplate, and scrolling past that point *walks the camera forward* —
  through the rack front and out into the aisle behind it — so orbit turns
  into fly exactly when orbiting stops being useful. Zoom-out reaches far
  enough to frame a campus-sized plan, and wheel speed scales with room
  size, so a closet and a 400-rack hall take about the same number of ticks
  end to end.
- **Cabinet shell** (View menu, 3D): a three-position mode, not a checkbox.
  **Solid** closes every cabinet — side panels plus smoked-glass doors
  front and rear, so the gear reads as silhouettes — the room as a visitor
  sees it. **Cutaway** (the default) strips doors and side panels down to
  the corner-post frame so whole rows read through. **X-ray** keeps the
  open frame up close and draws distant cabinets as bare outlines, ghosts
  the walls and floor, and lifts every raised floor — the tin goes, the
  equipment stays: faceplate photos and ports render (and click) exactly
  as in the other modes.
  The shell mode is independent of draw distance: how much detail a far
  cabinet gets is still the renderer's business.
- **Focus** (++f++, or the button on a selected rack/device card): the
  selection stays lit and everything else drops to a faint ghost. Click
  another cabinet to move the spotlight; ++esc++ (or clicking empty floor)
  lifts it.
- **Isolate**: on a selected rack's card, **Isolate row** keeps just that
  row (the row axis is detected from how the hall actually lines up) and
  **Isolate zone** — offered when the rack stands in a zone — keeps
  everything inside that zone. A pill at the bottom shows what's isolated;
  ++esc++ or **Show all** restores the room. Isolation hides tiles
  outright — ghosts are for focus, absence is for isolation.
- **View rear** on a rack's card flips the camera to the cabinet's other
  face — the same framing as a double-click fly-to, mirrored through the
  rack — and flips back with **View front**.
- **Light that grounds the room**: one shadow-casting key light plus a
  procedural studio environment (no downloaded assets — it works
  airgapped), so cabinets stand *on* the floor instead of floating in
  front of it, and painted steel and galvanised tray read as material
  rather than flat grey. On High quality, screen-space ambient occlusion
  adds the interior depth that makes an open cabinet look hollow.
- **Quality** (View menu, 3D): Auto / Low / Medium / High — how much the
  effects may cost. Low drops shadows and caps resolution (software
  rendering survives), Medium adds shadows, High adds ambient occlusion.
  Saved **per device** in the browser, not on the plan: your workstation's
  High never follows the plan onto a weak laptop. Auto probes the GPU once
  and picks a tier.
- **Click a rack** for a summary card (space used, monitoring rollup) and a
  jump to the rack page; **click a device** inside an open cabinet for its
  own card (U position, size, face) and a jump to the device page. Up close,
  devices wear their device-type **front/rear images**. Monitoring state
  lights a beacon on top of each cabinet — the same worst-status rollup the
  2D overlays use.
- **Side-mounted 0U strips** (vertical PDUs with a
  [rail mount](../dcim/racks.md#zero-u-side-mounting-vertical-pdus)) hang on
  their cabinet's flank as slim vertical strips in both detail tiers —
  click one for its device card. Up close, the strip's end face carries one
  small quad per **outlet** (spread down the strip at a real C13 pitch, by
  the trailing number in the outlet's name) plus its inlet at the foot.
  Each quad is clickable like a photo port — card, connect flow — and power
  cords land exactly on them.
- **Build in advance**: a typed tile needs no linked object — paint the
  future rack row now (bulk *Set type* makes this one sweep) and link real
  racks as they land. In 3D, unlinked non-zone tiles render as translucent
  ghost boxes with their type name, so the planned room reads as a room
  rather than empty floor. Scroll-zoom dollies **toward the pointer**, so
  getting close to a far corner of a big hall is one scroll, not a slow
  W-key flight.
- **Airflow** (View menu, 3D): draws each device's cooling direction as
  small cones — blue where air is drawn in, red where it is exhausted —
  from the device's effective airflow (its own setting, else its type's).
  Front-to-rear gear shows intake cones on the face and exhaust cones on
  the rear, side-breathing gear shows them on its flanks, `mixed` shows one
  of each on the exposed face, and `passive` draws nothing. The legend
  gains an Airflow row only while cones are on screen.

- Up close, a device whose type has **photo-anchored ports** wears its port
  markers on the image, coloured exactly as on the device page — speed tier
  for cabled ports, the part's status for hardware bays. Click one for a card
  with its cable, far end and, when SNMP disagrees with the record, the
  **difference** (see [drift in the room](#drift-in-the-room)). Marker names
  match their components case-insensitively, so a photo marked `Psu 1` still
  resolves a port named `PSU 1`.
- **Power ports the photo doesn't mark still exist**: any power port or
  outlet without a photo marker gets a small synthetic quad along the bottom
  edge of the device's rear panel, ordered by name. It clicks, cards and
  cables exactly like a photo port, and power cords anchor on it instead of
  the middle of the face.
- Arriving with a **cable trace** (`?trace=<cable>` — e.g. "Show on floor
  plan" from a cable) draws the run as an animated line riding its assigned
  trays and dropping into both end racks.
- **Cables are real geometry**: each run renders as a lit tube whose jacket
  thickness follows its kind (power fatter than copper, copper fatter than
  fibre), leaves its port with a rounded bend into the cabinet's front-corner
  channel — never straight down across the faceplates — and rides its trays
  in a **lane of its own**, so ten runs in one duct read as ten parallel
  runs. Hover glows; click opens the cable card. Past a couple hundred runs
  the layer falls back to simple lines for performance.
- **Trays are open baskets** — two side rails and a floor of rungs — and
  runs ride *inside* them, resting on the rungs. **Click a tray to open it**:
  the near rail drops away, the basket tints, and a card lists every cable
  routed through it (click one to select that run). Click it again, or
  **Close tray**, to shut it. Where runs corner, tee or cross, the rails stop
  short and a **junction plate** bridges the joint, so a crossing reads as
  fabricated tray instead of two baskets shot through each other.
- A run with **no tray** flies over the cabinets rather than through them —
  it clears the tallest rack in the room and stays under the ceiling.
- The cable card names what the run **follows** — the trays in order, or
  *point-to-point* when it follows none. A cable that ignores an obvious duct
  is almost always set to point-to-point; change it on the cable's own page
  (see [routing a cable](#routing-a-cable)).
- **Double-click** a cabinet to fly to its face; double-click a **device** to
  fly to *that* device, framed for its height, from whichever aisle its face
  is on.
- The **key** in the top-right corner appears only once something photo-anchored
  is in view, and lists the hardware statuses actually on screen. The speed ramp
  itself is always the full FE→400G+ scale, so it reads the same here as under a
  2D panel — see [The panel's key](../dcim/devices.md#the-panels-key).
- The view is **read-only** in v1 — layout editing stays in 2D.
- Everything is drawn from the same millimetre constants as the 2D elevation
  and faceplates, so proportions match reality (EIA-310 rack opening, 44.45 mm
  U pitch). Browsers without WebGL fall back to a notice; 2D is unaffected.

Face images and text labels are filtered at the GPU's best anisotropy and the
canvas renders at the display's pixel ratio, so a cabinet read at an angle
stays sharp. What that can't fix is a low-resolution source photo — a 600 px
device image stretched across a 19″ face is soft at close range in any view.
Upload the largest faceplate photo you have.

### Drift in the room

A port or hardware bay whose observed SNMP state disagrees with the record
wears an **amber outline** — the 3D reading of the same ring the 2D faceplate
uses. The marker keeps showing your **source of truth**; the outline is a
separate signal saying "look here". Click it and the card names the difference
("SNMP says failed", "speed: SNMP says 1 Gbps"). Nothing changes until you
accept it on the device's Monitoring tab — see
[SNMP discovery](snmp-discovery.md#drift-and-reconciliation).

Drift rides along in the same per-device request the port markers already use,
so a rack of cabinets costs no extra round trips.

## Floors

A location can hold **several plans — its floors**. Name them "Basement",
"Floor 1", "Floor 2"… and the plan header shows a **floor switcher** (the
same segmented tabs used everywhere) plus a **+** to add another floor to
the same location. Switching floors with unsaved edits asks first — the same
guard that covers every other way out of the editor, described under
[the editor](#the-editor). For click-through navigation *between* plans (e.g. a
stairwell tile), link a tile to another floor plan.

## The editor

Anyone with `floorplan · change` gets the edit tools; everyone else sees the
read-only viewer.

| Action | How |
|---|---|
| Place a tile | Click a palette entry to arm it, then click a cell (default size) or drag a rectangle (walls, aisles) |
| Move | Drag a tile — snaps to cells |
| Resize | Drag the corner handle of the selected tile |
| Rotate | The rotate button — swaps width/height in 90° steps and turns the icon; grid occupancy stays honest |
| Label / color / status | The inspector panel (label overrides the linked object's name; status renders planned/reserved dashed, decommissioning faded) |
| Link to an object | Inspector → Link: rack and device use the advanced pickers, power panel/feed and nested plans a searchable dropdown |
| Delete | Select + `Delete`, or the inspector button |
| Nudge | Arrow keys move the selected tile one cell |
| Pan / zoom | Drag empty grid / mouse wheel |

**Tiles never stack.** Placing, dragging, resizing, or rotating a tile onto
occupied cells is blocked — the tile stays where it was. Background **zones**
are the exception: they may cover anything, and anything may sit on them.

Edits are local until you press **Save** — one transactional bulk call writes
all creates, moves, and deletes together, and the change log records each
tile individually.

While there are unsaved edits an **unsaved** badge sits in the header, and
leaving the plan asks first — **Discard unsaved changes?**, with *Keep editing*
or *Discard and leave*. One guard covers every in-app exit: a sidebar link, a
breadcrumb, browser back/forward, a tile that links out to a rack or another
floor, and the floor switcher. Closing the tab or reloading raises the
browser's own leave-site prompt instead, since that never reaches the app.

Switching the same plan between 2D and 3D, or clearing a cable trace, is a view
change rather than an exit, so neither is guarded.

Under **View**: **Fit labels to tiles** auto-sizes each tile's text to its
footprint (so single-cell tiles keep readable names) — the preference is
saved on the plan; and **Camera FOV cones** shows/hides the camera wedges.

## Live state on tiles

The canvas refreshes `GET /api/floor-plans/<id>/state/` every 30 seconds:

- **Rack tiles** carry a space-utilization bar (green ≤80% · amber 80–95% ·
  red >95%) and a percentage.
- **Monitoring rollup** — a rack tile's border turns red the moment any
  device inside it goes down (worst status across the rack's devices' IPs);
  device tiles do the same for their own IPs.

## Rack & device deep view

Click a rack tile (or its **Contents & trace** button) to open a side panel
with the rack's capacity, its **real elevation** (front/rear, role-colored),
and the device list — each device has an **End-to-end** button that shows its
cable paths through patch panels to the far end, the same trace view as the
device page. Device tiles open the end-to-end view directly.

## Viewer

Click a tile to see what it is and jump to the linked object ("Open rack R01").
Rack and device tiles open the deep view; a tile linked to **another floor
plan** navigates into it on click — use this to nest a cage or suite plan
inside a hall plan.

### Working many tiles at once

**Ctrl/⌘-click** tiles to build a selection, or **Shift-drag** on empty grid
to sweep one (plain drag still pans). A bulk bar appears with the count,
**Facing** buttons that set the orientation of every selected tile in one
click — placing a hundred racks no longer means a hundred rotate clicks —
and **Delete**. The changes join the normal draft: nothing persists until
**Save**, and Esc or a plain click clears the selection.

## Raised floors (Structure mode)

The **Structure** tab models the room itself. Draw **raised-floor areas** —
rectangles of tiles standing on pedestals with a cable plenum underneath —
and give each one its **plenum depth** (default 300 mm). Rooms are rarely
uniformly raised, so the raised floor is per-area: the DC pad is, the
corridor isn't, and an L-shaped pad is simply two abutting rectangles
(areas may share edges but never overlap, so the depth under any point is
unambiguous).

In 3D the finished floor draws its **600 mm tile grid** (the grid every
operator actually addresses), and each area can be **lifted on its own**:
click an area's edge skirt and its floor fades out over a beat so the
plenum contents read; click again to close it. The global **Lift raised
floor** toggle (View menu) still lifts everything at once. Zone tile types
marked **Perforated floor (3D)** (Customize → Floor tiles) render their
zones as grate/supply tiles instead of a flat tint — the cold-aisle read,
one repeat per 600 mm tile. An optional **Ceiling** (View menu, 3D,
default off) closes the room from the inside without ever blocking the
bird's-eye view.

The plenum is data, not decoration:

- **Underfloor trays** with no explicit elevation dive to the plenum of the
  area beneath them (still 300 mm outside any area, as before).
- **Route-length estimates** use the same depth for their vertical-drop
  term, so a 600 mm plenum genuinely lengthens the cables that dive into it.
- The **3D room** draws the finished floor and the void below; the **Lift
  raised floor** toggle (View menu, 3D) turns the floor translucent so the
  underfloor runs read through it.

Areas are drawn with the same drag-a-rectangle gesture as tiles; select one
in the left rail to edit its label, plenum depth and color, or delete it.

## Walls & doors (Structure mode)

The Structure tab also draws the **room shell**: walls as polylines on the
same half-cell lattice trays snap to, so a wall can run along tile
boundaries or straight down a tile's centerline. Click **Draw wall**, click
corners (drawing magnetically snaps to existing walls, so rooms chain
cleanly), and double-click or press ++enter++ to finish — the wall is saved
immediately and its inspector opens.

A selected wall edits like the rest of the structure kit:

- **Label, color** — cosmetic; the default wall follows the theme.
- **Height (mm)** — blank means full height, i.e. the plan's ceiling.
  A half wall is just a wall with a height.
- **Doors** — arm **Add door**, then click the wall where the opening goes.
  Each door is a 900 mm gap by default (2100 mm tall); width and height are
  editable per door in the inspector, and a blank door height renders the
  standard 2100 mm. Doors live *on* the wall (spans of a segment), so a
  wall and its openings always move — and save — together.
- **Move** — drag a wall to translate the whole run (0.5-cell snap);
  delete and redraw to reshape it.

The 2D canvas draws walls in **every mode** — solid spans with a dashed
threshold and jamb ticks across each door gap — because the shell is
context whether you're placing tiles or pulling cable. The 3D room raises
the same geometry: solid runs, true door gaps, and a lintel over each
opening (none when a door reaches the wall top). The **Walls** toggle
(View menu, 3D) hides the shell when it blocks the view — it defaults on.

Walls are documentation geometry in this release: **walls do not affect
routing in v1**. A cable's route and length ignore them, exactly as they
did before walls existed.

## Cable trays (Cables mode)

The **Cables** tab (top-right toggle, next to Layout) turns the plan into a
**buildable wiring drawing**. Draw **trays** — cable/conduit runs — as
polylines a contractor can follow, and assign the real DCIM cables that run
through each one. Hand the PNG to whoever's pulling cable.

- **Draw a tray**: Cables mode → **Draw** in the left rail → click grid
  points to route the run → double-click (or Enter) to finish, then name it.
  Esc cancels. Trays snap to a **half-cell lattice** (twice as fine as the
  tile grid), so you can lay two runs a half-cell apart and they read as
  distinct parallel trays.
- **Trays may overlap and cross** — unlike tiles, there's no no-stacking
  rule; one run can pass over another (route them on the fine lattice to
  keep both visible).
- **Assign cables**: select a tray → its inspector lists the cables in it,
  with **Add cable** (searches all cables) and a × to remove. The tray shows
  its cable count on the canvas and in the rail.
- **Auto-route**: on a cable's page, the **Auto-route** button computes the
  best path through this plan's tray network (Dijkstra over segments,
  junctions and crossings), assigns those trays to the cable, and estimates
  its physical length — horizontal run × cell size, plus the vertical drops
  between each end rack and its tray, plus 10 % slack. A recorded length is
  never overwritten (the API accepts `overwrite: true`). Ends farther than
  ~6 cells from any tray come back *unreachable* rather than pretending a
  20 m unsupported hop is a route. `POST /api/floor-plans/{id}/route/`
  previews the same computation without saving.

#### Routing a cable

Auto-route picks a path for you. The **Routing** card on a cable's own page is
the manual twin — and the answer to "what is this run actually set to
follow?", which nothing used to show:

- **Point-to-point** — the cable follows no tray and draws as a direct A↔B
  run. This is the default, and the usual reason a cable in the 3D room
  ignores a tray it visibly passes.
- **Through trays** — pick the ducts yourself, **as many as the run needs**,
  and order them with the arrows so the path reads the way the cable
  travels. Removing every tray puts it back to point-to-point.

Changes take effect immediately in the 2D canvas and the 3D room. Routing is
recorded **per floor plan**, so a cable that crosses plans keeps each plan's
assignment separately. `GET`/`PUT /api/cables/{id}/routing/?floor_plan=<id>`
is the same operation over the API; editing requires **change** on the cable.
- **Level & elevation**: each tray records where it physically lives —
  **Overhead** (the default), **Underfloor**, or **Floor level** — plus an
  optional exact **elevation in mm**. Leave elevation blank and it derives
  from the level (overhead → ceiling − 300, underfloor → −300, floor → 0).
  This drives the tray's height in the 3D view and the vertical-drop term in
  route-length estimation.
- Trays render **above tiles** so the run is legible on the print, and they
  export with the PNG.
- Cables mode is edit-gated; viewers still see the trays.

### Connecting trays (junctions, T-splits, crossings)

Trays form a **network** — a cable assigned to several connected trays routes
through their junctions. There are three ways trays connect, and while drawing
the cursor **magnetically snaps** to nearby trays so the joins land exactly:

1. **End on another tray.** While drawing, move near an existing tray — the
   next point snaps onto its line or a vertex (within half a cell). Click
   there (or double-click to finish there) and the two trays share that point,
   so they're joined. This is the usual "branch off the main run" move.
2. **T-split.** Draw a branch that starts (or ends) on the middle of another
   tray — it snaps to that tray's line, creating a T-junction the cable can
   turn through.
3. **Crossing.** Two trays that simply cross each other are joined at the
   crossing automatically — no click needed.

**Editing a tray.** Select a tray (Cables mode) and drag its **body** to move
the run or a **vertex dot** to reshape — both snap to the grid and
magnetically to other trays (drag a vertex onto another tray to connect them).

For heavier reshaping — e.g. rerouting runs around something added in a
remodel — flip on **Edit trays** (the toggle at the top of the Cables rail).
It **hides all cables** so nothing blocks the trays, and every tray becomes
reshapeable. Click a tray to select it, then:

- **Drag any point** to move it.
- **Click a ＋** on a segment to **add a bend**, then drag it into place.
- **Right-click a point → Remove bend** to delete it.
- **Drag the body** to shift the whole run.

**Done editing trays** (or **Esc**) turns cables back on. Name / kind /
colour / cables and delete stay in the inspector.

Tips:

- If a join doesn't take, zoom in and re-draw (or drag a vertex) *onto* the
  other tray until it snaps (the point sits exactly on the line).
- Draw parallel runs a **half-cell** apart so they stay visually distinct.
- Assign a cable to **every tray it passes through** (main run + each branch);
  the trace stitches them at the junctions and takes the branch toward the
  destination. If there's no tray between two points, the trace draws a
  straight line for that stretch.

*Assignment is manual for now — a cable belongs to the trays you put it in.
Auto-picking a cable's trays from its endpoints is the next phase.*

### Seeing cables A↔B (routed through the trays)

Turn on **View → Cable links (A↔B)** and every cable routed through a tray
draws its **physical run** — not a straight line, but the actual path
**through the trays it's assigned to**. Danbyte resolves each cable's
terminations to its devices, then to the tile holding that device (or the
device's rack tile), and routes A→B along the tray network: it enters at the
nearest tray point, follows the trays — **including T-junctions and across
several connected trays** — and only straight-lines the short hops from a
device to the tray. A cable with no trays just draws straight A→B. Click a
cable in a tray's inspector to **highlight** its run (animated).

**Assigning a cable to several trays** is how branching works: add the cable
to each tray it passes through (a main run plus a branch, say). The trace
stitches them at their junctions — including where two trays **cross
mid-run** — and takes the branch toward the destination.

**Tracing a single cable — no Cables mode needed.** With **View → Cable
links** on, just **click any cable line** (in Layout *or* Cables mode) to
trace it: the clicked run jumps to the **front**, brightens with a moving
dash, and every other cable **dims** so the route reads clearly even where
several share a tray. Click empty floor to clear.

**Trace on map from a cable** — the **cable detail page** has a *Trace on
map* button that jumps to the plan showing that cable, with its route already
highlighted and the view fitted to it. The **rack/device deep-view** (click a
rack or device tile) shows each device's end-to-end paths: a ⟿ next to the
origin traces the **whole run** (all its cables, through patch panels), and
the ⟿ on a single cable segment traces just that cable. Both close the panel,
highlight on the plan, and fit the view.

**Right-click** anywhere on the plan for a quick menu — *Trace cables here*
(highlight every run touching a tile), *Open*, *Fit to view*, *Clear trace*.

**What shows a route:** any cable that's either routed through a tray, or has
both ends placed on the plan (a device tile, or the device's rack tile).
Untrayed cables between two placed devices draw as a straight A↔B line;
trayed ones follow the trays.

**Where things live:** patch panels are rack-mounted, so they stay *inside
their rack* (their runs trace from the rack tile) — only floor-level things
like **drops (wall plates)** and the equipment they serve (a printer, an AP)
are placed as their own tiles.

Trays render as a **subtle gray channel** (recolor per tray) with no solid
centerline, so a highlighted cable reads as running *inside* the tray.

**View → Cable trays** hides/shows the tray layer itself — look at just the
cable runs, just the trays, or both.

## Finding things

- **Search** (Layout mode, header): type a tile's label, linked object, or
  type name and jump straight to it — the canvas pans and zooms to the hit.
- **Fit** (the ⤢ button) recentres the whole plan after you've zoomed around.
- **Hover** any tile for a popover: name, type, status, a link straight to the
  linked object, and (racks) utilization / power / weight / device count / live
  monitoring state. **Click to pin** it — a pinned popover stays put so you can
  read it, follow its link, or hit *Contents & trace*; **Esc** or a click
  outside dismisses it. Which rows appear is configurable — see
  [Popover fields](#popover-fields).
- **Objects** (header toggle) opens a side list of everything placed on the
  plan, in foldable groups by **device role** and by **tile type**, each with a
  count and a live health dot. Search it, or click a row to select and zoom to
  that tile. Editors' toggle state is saved with the plan.
- **Show on floor plan** — the Rack and Device detail pages carry a button
  that jumps to where they're placed (a device falls back to *its rack's*
  plan, marked "via rack").

## Export

**PNG** exports the current view, theme-aware, at 2× resolution — same as the
topology map and rack elevation exports. Trays and their labels are included,
so the export doubles as the builder's pull sheet.

## Tenancy, permissions, audit

Plans, tiles, and tile types are tenant-scoped like everything else; links are
validated against the active tenant. RBAC object types: **Floor plans**
(`floorplan`, the plan and its tiles) and **Floor tile types**
(`floortiletype`, the palette). All three models are audited — every tile
create/move/delete lands in the [change log](change-log.md).

## Popover fields

**Settings → Deployment → Floor plans** picks which rows the tile popover shows,
and in what order. A field with nothing to say for a given tile is skipped
automatically — no rack utilization on a wall tile — so turning one on is safe
everywhere.

The list is the **deployment default**. A tenant that overrides its UI policy
(**Settings → This tenant → General**) carries its own list, resolved the same
way as the optional device fields. Per-tile-type lists are supported too: a tile
type **without** its own list inherits the global one, so the two can't drift
apart as you change the default.

## Roadmap

Planned next: multi-select and undo/redo, cable traces drawn **on** the plan
with "show on map", wall-plate ("drop") tiles with port assignments, in-plan
search, and PDF export.
