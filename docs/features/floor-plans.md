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

## Creating a plan

**Maps → Floor plans → Add** (or the **Floor plan** button on a Location
page). A plan belongs to a location, has a grid (default 24×16 cells, up to
512×512), and can carry an uploaded **background image** — a blueprint or
photo scaled under the grid with adjustable opacity.

## Floors

A location can hold **several plans — its floors**. Name them "Basement",
"Floor 1", "Floor 2"… and the plan header shows a **floor switcher** (the
same segmented tabs used everywhere) plus a **+** to add another floor to
the same location. Switching floors with unsaved edits asks first. For
click-through navigation *between* plans (e.g. a stairwell tile), link a
tile to another floor plan.

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
