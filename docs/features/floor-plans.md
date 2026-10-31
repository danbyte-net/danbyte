---
icon: lucide/layout-grid
---

# Floor plans

**Maps → Floor plans** lays out a [location](regions-locations.md) - a room, a
hall, a floor - or a whole site, as a grid of tiles: racks, aisles, walls, cooling units,
cameras, doors… Each tile can **link to a real object** (a rack, a DIN-rail
[cabinet](../dcim/cabinets.md), a device, a power panel or feed, a
[cooling source](cooling.md#on-the-floor-plan), or another floor plan), so
the drawing stays a live view of your DCIM data rather than a static
diagram.

Everything is self-contained: an SVG canvas, uploaded background images served
from your own deployment, no external tile servers - floor plans work fully
air-gapped.

## The palette is yours (zero pre-filled data)

There are **no built-in tile kinds**. Before placing tiles, define your
palette under **Customize → Floor tiles**: each tile type has a name, a color,
an optional **icon** (searchable Lucide picker - type "cam" and pick a camera),
and a default size in cells (a rack is 1×1, an aisle might be 1×4).

Two sources feed the palette automatically:

- **Floor tile types** - the kinds you create.
- **Device roles** - every role doubles as a tile type, reusing its color, so
  a shop that already defined "Firewall / Access / Server" roles gets matching
  tiles for free. The palette lists a role as its colored role badge, a tile
  type as its tile.

Two ticks on a tile type change how its tiles behave:

- **Background zone** - the tile paints the grid background instead of
  occupying it: red for a hot aisle, blue for cold, an amber security zone…
  Zones render *under* normal tiles, and normal tiles may sit on top of them
  (they're the one exception to the no-stacking rule). Their name labels
  (*Cold aisle*, *Hot aisle*…) can be hidden with the **Zone labels** toggle
  under **Display** when they clutter a busy plan.
- **Camera field of view** - tiles of this type get a **FOV cone**
  (direction / angle / reach in cells) drawn on the canvas. The same tick
  exists on **device roles** (e.g. a CCTV role), so camera devices get cones
  whichever way you type the tile. Toggle all cones under **Display**.
  Per tile: a dice-style **anchor picker** sets where the cone emits from
  (center or any corner), and a **PTZ** toggle swaps the cone for a full
  **360° coverage ring** (radius = reach) for pan-tilt-zoom cameras.

Plain areas drawn on a plan - parking, fences, roads - have a catalog of
their own, **Organization → Area types**: see [Area types](#area-types).

A tile's *behaviour* never depends on what its type is called - it comes from
what the tile **links to**. A tile linked to a rack acts like a rack tile
whether you named its type "Rack", "Cabinet", or "Skab".

### Open a tile type

Clicking a name under **Customize → Floor tiles** opens that type's detail page
- the answer to "what breaks if I change this?" before you recolor, rename, or
delete a palette entry.

- **Overview** - its color, icon, slug and default size; the three rendering
  ticks (**Background zone**, **Camera field of view**, **Perforated**); and a
  short **Site markers** list, because a type is also the vocabulary for free
  markers on the geographic [site map](site-map.md). Markers are a handful at
  most, so they sit here rather than in a tab of their own.
- **Placed** - every tile of this type on any floor plan, with the plan, the
  grid cell, the size, and what the tile is linked to. Both placed tiles and
  site markers block a delete, and both are listed here.
- **Journal** - your notes on this tile type.
- **Change log** - the automatic record of changes to the type itself.

## Creating a plan

**Maps → Floor plans → Add** (or the **Floor plan** button on a Location
page, or **Add floor plan** on a site's **Floor plans** tab). Pick the
**Site**, then a **Location** of it or leave it at **Whole site** (see
[Site-wide floor plans](#site-wide-floor-plans)). A new floor plan starts
with one floor, both named as you named it; add more floors from the editor
(see [Floors](#floors)). Each floor has a grid (default 24×16 cells, up to
512×512), and can carry an uploaded **background image** - a blueprint or
photo scaled under the grid with adjustable opacity.

### Site-wide floor plans

A floor plan names a **site** and, optionally, a **location** of it. A
floor plan with no location is **site-wide**: a campus or yard map with
many buildings on it. **Maps → Floor plans** reads **Whole site** in its
Location column, the editor's subtitle names only the site, and the site's
page lists it on its **Floor plans** tab with the floor plans of the site's
locations.

What a floor spans follows from that:

- **Areas** may stand for any room or location of the site, not only those
  under one location; the Room and Location pickers list the whole site.
  **New room** is offered only on a floor with a location (a room needs
  one).
- **The Place picker** offers the site's devices, racks and cabinets, as on
  any floor, ranked by the area under the pointer: its room (or location)
  first, then the location of that room and the locations inside it, then
  the rest of the site. **Not placed** lists the site's objects on no plan.
- **Assign rooms from areas**, cables, trays and
  [snapshots](#snapshots) work as on any floor; a snapshot or clone of a
  site-wide plan is site-wide too.

A floor of a site-wide floor plan may name any location of the site, or
none. A floor plan's site is fixed once it exists; its location may change
(the floor plan's name menu → **Edit…**) as long as every floor's location
stays that location or one inside it, and going to **Whole site** is always
allowed. Deleting a location deletes the floor plans at it; deleting a site
deletes all of its floor plans, site-wide ones included.

The grid also carries a **real-world scale**: a **cell size** in millimetres
(default 600 - one standard raised-floor tile) and a **ceiling height**
(default 3000). Existing plans keep working untouched; the scale powers the
3D view, route-length estimation, and the scale bar on printed drawings.

### Plans made from the Site map

**New floor plan** on the [Site map](site-map.md#new-floor-plan-from-this-view)
makes a site-wide floor plan from an area of the map:

- **Scale** - the plan spans the framed area at true scale. The map is Web
  Mercator, so the area is measured in metres at its middle latitude (a
  degree of longitude is shorter the further from the equator); across a
  campus the difference from one edge to the other is negligible. The grid
  is that many cells of the chosen cell size, the area grown east and south
  to whole cells. A grid has at most 512 cells a side, so a larger area
  gets a larger cell; an area over 2.56 km across is refused - zoom in.
- **Background** - the area as the map showed it (street map or satellite),
  stretched exactly over the grid, so a 40 m building is 40 cells of 1 m.
  The tile attribution is drawn in the image's bottom-right corner and
  written in the plan's description, as the tiles' licences require.
  Without readable tiles the plan has no background.
- **Outlines as areas** - each [building outline](site-map.md#building-outlines)
  of the plan's site inside the area becomes a polygon area linked to the
  outline's location, in the outline's colour (its own, else its location
  type's, else its location's), labelled with the outline's label or the
  location's code. An outline crossing the edge is cut at it; one with more
  than 200 points is simplified. Outlines of other sites, and those linked to
  a location you may not view, are left out.

The plan is an ordinary floor plan from then on: draw on it, add floors,
replace the background. Its `state.from_map` keeps the box, the tile zoom,
the basemap and the attribution it was made from.

`POST /api/floor-plans/from-map/` (multipart, or JSON without an image)
takes `name`, `site_id`, `bbox` (`[south, west, north, east]` in degrees,
as JSON text in a form), `cell_mm` (50-5000, default 1000, raised to fit),
`zoom` and `basemap` (`map` or `sat`, for the attribution), and an optional
`background_image`: a PNG, JPEG or WebP of the box, at most 20 MB, 8,192
pixels a side and 40 megapixels, stretched over the grid. It answers the
new floor (201) with `areas_created` and `outlines_skipped` (the labels of
outlines that did not make a valid area). Needs `floorplan · add` at the
site; outlines are copied only with `sitemapoutline · view`. The server
never fetches tiles: the image comes from the browser.

## CAD drawings

A plan can carry a **CAD drawing** as its background instead of an image: a
**DXF** file, or a **DWG** when the server has a converter. The drawing is
shown at **true scale**: its units and the grid's cell size line up, so a
600 mm floor tile in the drawing is one 600 mm cell.

### In the editor

- **Upload**: **Background → Drawing → Upload drawing…** in the plan header
  (**More → Background…** on a narrow screen). The file picker takes `.dxf`,
  and `.dwg` only when the server has a converter; without one the popover
  says so. A plan has one background: a drawing replaces the image, and an
  image replaces the drawing, each after a confirm.
- **Status**: while the worker has the file, the popover shows the loading
  state; a failed drawing shows why, with **Reprocess**. **Remove** deletes
  the drawing and its files.
- **Drawing** in the toolbar opens the drawing's panel over the plan:
  - **Layers**: tick a layer to show it; each shows its colour and shape
    count, and **Off** or **Frozen** when the file had it so. **All** shows
    every layer; **Architecture only** hides the layers that hold only
    hatches, dimensions or text. **Hide text** hides every text.
  - **Placement**: opacity, rotation (0°, 90°, 180°, 270°) and the offset in
    mm, with arrows that move it one cell.
  - **Scale**: the file's units, **Drawn in** (**From file**, mm, cm, m, in,
    ft), where the scale comes from (**From file**, **Set by hand**,
    **Calibrated** or **Assumed mm**), one unit in mm and the drawing's size.
    When that size is no plausible floor plan, a warning says so and offers
    the unit that fixes it - see [Units and calibration](#units-and-calibration).
    **Reset calibration** goes back to the units.
  - **Fit grid to drawing**; when the drawing needs more than 512 cells a
    side, it offers the cell size that fits.
  - **Calibrate**: click two points on the drawing, type the distance between
    them in mm, **Save**. A drag still pans while you pick.
- Changes save as you make them, like the background image's opacity; the
  plan's **Save** is for tiles. Without change permission on the plan you see
  the drawing and can show or hide layers and text for yourself; that is not
  saved.
- **Large drawings**: past 60,000 shapes the plan shows the drawing as one
  picture, with a **Layers flattened** chip. Hiding layers or text then asks
  the server for a render without them (the chip reads **Rendering…** until
  it lands). That render keeps the whole drawing's frame, so it sits exactly
  where the full drawing does even when the hidden layers held its edges.
- **Colours and the theme**: the drawing's default colour - ACI 7 (white on a
  CAD screen, black on paper) and near-black or near-white lines and text -
  is drawn in the app's text colour, so it reads in the light and the dark
  theme alike. Every other colour is the drawing's own, unless it is too
  faint on the floor (yellow on the light theme, dark blue on the dark one):
  then only its lightness moves until it reads, keeping its hue. The PDF
  prints the light theme's colours.
- The drawing is in the plan's **PNG** and **PDF** exports (see
  [Export](#export)), and in the [3D room](#the-3d-room-view) as the floor,
  with the same layers hidden.

### Formats and limits

- **DXF** (ASCII or binary, any version ezdxf reads) is read natively.
- **DWG** goes through a converter on the worker host - see
  [`DANBYTE_CAD_CONVERTER`](../reference/settings.md#cad-drawings-danbyte_cad_converter).
  The release bundle and the
  [Docker image](../getting-started/docker.md#dwg-drawings) both ship
  LibreDWG's `dwg2dxf`, so DWG works out of the box wherever bubblewrap
  can run it in a sandbox (see [Processing](#processing)); a
  source checkout builds it with `make cad-tools`
  ([Installation](../getting-started/installation.md#dwg-converter)).
  LibreDWG is GPLv3 and runs as a separate program, never linked; its
  licence and source come with it.
  Without a converter, a DWG upload is refused with the way round it: save the drawing
  as DXF in the CAD program (AutoCAD and BricsCAD: **Save As → DXF**;
  LibreCAD: **File → Save As → Drawing Exchange**) and upload that.
- Uploads are capped at **50 MB**. The file's name and its first bytes must
  agree (a `.dxf` that is really a DWG is refused).
- Only **model space** is drawn; paper-space layouts are ignored.
- Never drawn: raster `IMAGE`s, PDF/DWF/DGN underlays, OLE objects, wipeouts
  and external references (xrefs) - anything that points at another file.
  Infinite construction lines (`XLINE`, `RAY`) are skipped too. The drawing
  record counts what was left out.
- The rendered drawing is capped at **20 MB** and **250,000 elements**. Over
  that, it is simplified step by step - hatches go first, then dimensions,
  then text, then the shortest lines - and the drawing record lists the steps
  taken. If even that is over, processing fails and says so.

### Processing

An upload is stored and queued; a background job (the RQ workers) converts a
DWG, reads the DXF, renders it and stores the result. The drawing's status
goes **queued → ready**, or **failed** with the reason (not a readable DXF, no
converter or no sandbox for it, too large, took too long). **Reprocess** runs it again, for
example after a converter is installed. Uploading a new file replaces the old
one and its files; the position, rotation and opacity stay, the calibration,
picked units and layer choices go with the old file.

Reading happens only in the worker, in separate processes with memory, CPU
time and output-size limits. The DWG converter is a C parser, so it also runs
in a bubblewrap sandbox: no network, no Danbyte directory, `.env` or media,
and nothing writable but its own output directory. A converter bug a hostile
file exploits is contained there; see
[`DANBYTE_CAD_SANDBOX`](../reference/settings.md#converter-sandbox-danbyte_cad_sandbox).
A host where the sandbox cannot run refuses DWG and says why, unless the
operator turns the sandbox off. The DXF reader (ezdxf) is pure Python and
is not sandboxed: a bad file makes it fail, not run code. The rendered SVG
passes the server's SVG sanitiser before it is stored; it holds paths,
groups and text only - no scripts, images, links or fonts.

### Units and calibration

The drawing's units come from the file (`$INSUNITS`: millimetres, inches,
metres…). A **unitless** file is drawn as if in millimetres until it is
calibrated: pick two points on the drawing and type the real distance between
them, like the [cabinet photo calibration](../dcim/device-catalog.md#photo-ports).
The points must stand at least 1% of the drawing apart.

Files often carry the wrong units: an architect's plan drawn in metres but
saved with a millimetre header lands as a speck in the plan's corner. **Drawn
in** says what the drawing is really in - mm, cm, m, in or ft - without
picking points; **From file** trusts the file again.

The scale in effect is, first to last: a calibration, the units picked under
**Drawn in**, the file's units, millimetres. Picking units drops any
calibration, since the newer choice wins; a calibration made afterwards wins
over the picked units, and resetting it falls back to them. A new file drops
both; a [clone](#cloning-a-plan) keeps both.

When the scale comes from the file, or is assumed, and the drawing's longest
side comes out under 2 m or over 5 km, the Scale panel warns - **Drawn 15 cm
across**, with what the file says - and offers one click to the metric unit
that would make it 2 m to 5 km across, the one nearest a 50 m building when
several would. The bounds span a single room to a large campus; the usual
mistake, mm against m, is a factor of 1000 and lands far outside them. Once
the units are picked or the drawing is calibrated, the warning stays away.

### Layers

Every layer with something on it is listed with its colour, whether the file
had it **on** or **frozen**, and how many shapes it holds. All layers are
rendered; the ones the file had off or frozen start hidden. Which layers are
hidden, and whether text is hidden, is saved with the plan.

### Placement

Offset (in mm from the plan's top-left corner), rotation (0, 90, 180, 270)
and opacity, as for a background image. **Fit grid to drawing** moves the
drawing to the plan's corner and sets the grid to the cells that cover it,
optionally at a new cell size; when that would take more than 512 cells a side
it says which cell size would fit.

### API

All under the plan, with the plan's permissions: reading needs **view** on the
floor plan, changing needs **change**.

| Call | What it does |
|---|---|
| `GET /api/floor-plans/drawing-support/` | `{dxf, dwg, converter, message, max_upload_bytes}` - whether DWG is taken and, if not, why. |
| `GET /api/floor-plans/{id}/drawing/` | The drawing; 404 when the plan has none. The plan itself carries a `drawing` summary (`id`, `status`, `source_kind`, `source_name`, `rendered_url`, `updated_at`) or `null`. |
| `POST /api/floor-plans/{id}/drawing/` | Multipart `file`. Replaces any drawing; 202 with `status: "queued"`. 400 with a `file` error for a missing, oversized or unrecognised file; a DWG without a converter adds `code: "converter_missing"`. |
| `PATCH /api/floor-plans/{id}/drawing/` | Placement: any of `x_mm`, `y_mm` (±10,000,000), `rotation` (0/90/180/270), `opacity` (0-100), `hidden_layers` (names of this drawing's layers), `hide_text`. |
| `DELETE /api/floor-plans/{id}/drawing/` | Removes the drawing and its files. 204. |
| `POST /api/floor-plans/{id}/drawing/reprocess/` | Queues processing again. 202; 200 with the drawing unchanged while a run is already queued. |
| `POST /api/floor-plans/{id}/drawing/calibrate/` | `{"a": [x, y], "b": [x, y], "distance_mm": n}`, points in the SVG's viewBox units, distance 1-1,000,000 mm. 409 until the drawing is ready. `DELETE` clears it. |
| `POST /api/floor-plans/{id}/drawing/units/` | `{"units": "m"}` (`mm`, `cm`, `m`, `in`, `ft`): the units the drawing is really in, over the file's; drops any calibration. `{"units": null}` or `DELETE` trusts the file again. Returns the drawing. |
| `POST /api/floor-plans/{id}/drawing/fit-grid/` | Optional `cell_mm` (50-5000). Returns `{floor_plan, drawing}`; 400 with `min_cell_mm` when the drawing needs more than 512 cells. |
| `POST /api/floor-plans/{id}/drawing/render/` | `{"hidden_layers": [...], "hide_text": bool}`: a server render with those layers left out, for drawings too large to toggle in the browser. Needs only **view**. 200 with the cached render, or 202 when queued; `GET …/render/?key=` reports on it (`status`, `url`, `error`). The same request while one is queued returns that one. At most 3 renders of a drawing queue at once; past that, 429 until one finishes. The last 12 are kept. |

The drawing record:

- `status` (`queued`, `ready`, `failed`) and `error`.
- `source_kind`, `source_name`, `source_bytes`, `source_url` (the uploaded file).
- `rendered_url`, `rendered_bytes`, `rendered_elements`, `simplified` (the
  steps taken to fit the caps), `skipped` (`external`, `infinite` counts).
- `units`, `units_mm_per_unit` (from the file, `null` when unitless),
  `units_override` (the picked units, `null` when none), `calibration`,
  `mm_per_unit` (the scale in effect) and `scale_source` (`calibration`,
  `override`, `units` or `assumed`).
- `extents` (`min_x`, `min_y`, `max_x`, `max_y`) and `size` (`width`,
  `height`) in drawing units, `size_mm`.
- `layers`: `name`, `color`, `on`, `frozen`, `entity_count`, `kinds` (counts
  of `geometry`, `hatch`, `dimension`, `text`).
- `placement`: `x_mm`, `y_mm`, `rotation`, `opacity`, `hidden_layers`,
  `hide_text`.
- `bounds_mm` (the placed, rotated box on the plan), `transform_mm` and `fit`
  (`grid_width`, `grid_height`, `fits`, `min_cell_mm` at the plan's cell size).

The rendered SVG (fetch it from `rendered_url`; it is served as a download, so
use it inline, not as a link):

- `viewBox="0 0 W H"` in **drawing units**, y pointing down: a drawing point
  `(x, y)` is at `(x - min_x, max_y - y)`.
- One `<g data-layer="NAME">` per layer, in the file's layer order. Inside it,
  the layer's lines and curves, then `<g data-kind="hatch">`,
  `<g data-kind="dimension">` and `<g data-kind="text">` as present. Hiding a
  layer or all text is `display: none` on those groups.
- Strokes carry the CAD colour and line weight in drawing units; hatches are
  filled paths (pattern hatches as a 25% tint). Text is `<text>` with a
  `matrix()` transform and `font-size`, and no font: it takes the page's.
- `transform_mm` places it on the plan in millimetres: the rotated box's
  top-left at (`x_mm`, `y_mm`), rotated about its centre. For grid cells,
  put `scale(1 / cell_mm)` in front.

## The 3D room view

The **2D / 3D** toggle in the plan header (or `?viz=3d` in the URL) turns the
plan into a navigable room: rack tiles become cabinets at their grid
positions - sized from the rack's rail width, outer dimensions and U height -
with their racked devices drawn at true U positions when you move close.
A site-sized plan keeps its floor layers (slab, map background, area tints)
apart at any distance, and its grid draws every n-th line - about 120 a side
- so it reads as a grid rather than a hatch.
Trays render at their recorded level/elevation (overhead runs hang below the
ceiling, underfloor runs sit beneath the slab), zones tint the floor, and the
uploaded blueprint or CAD drawing textures it.

- **Navigate**: drag to orbit, scroll to zoom, right-drag to pan.
  **Keyboard**: the arrow keys or WASD glide the camera level with the floor
  in the direction it faces - the way to walk the aisles - while **Space**
  rises, **C** descends (PageUp/PageDown work too) and holding **Shift**
  sprints at 4× speed. Speed tracks how far you are zoomed out, so close-up
  moves are fine-grained and hall-scale hops are quick. The first key press
  also pulls the orbit pivot to a few metres ahead of the camera, so
  dragging looks around first-person-style while you walk; **double-click a
  rack** to re-anchor the pivot on it and orbit for inspection, flying the
  camera to its front.
- **Zoom has no wall**: the wheel zooms right down to a few centimetres from
  a faceplate, and scrolling past that point *walks the camera forward* -
  through the rack front and out into the aisle behind it - so orbit turns
  into fly exactly when orbiting stops being useful. Zoom-out reaches far
  enough to frame a campus-sized plan, and wheel speed scales with room
  size, so a closet and a 400-rack hall take about the same number of ticks
  end to end.
- **Cabinet shell** (View menu, 3D): a three-position mode, not a checkbox.
  **Solid** closes every cabinet - side panels plus smoked-glass doors
  front and rear, so the gear reads as silhouettes - the room as a visitor
  sees it. **Cutaway** (the default) strips doors and side panels down to
  the corner-post frame so whole rows read through. **X-ray** keeps the
  open frame up close and draws distant cabinets as bare outlines, ghosts
  the walls and floor, and lifts every raised floor - the tin goes, the
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
  **Isolate zone** - offered when the rack stands in a zone - keeps
  everything inside that zone. A pill at the bottom shows what's isolated;
  ++esc++ or **Show all** restores the room. Isolation hides tiles
  outright - ghosts are for focus, absence is for isolation.
- **View rear** on a rack's card flips the camera to the cabinet's other
  face - the same framing as a double-click fly-to, mirrored through the
  rack - and flips back with **View front**.
- **A rack's card** gives its devices, **Space**, **Power**, **Cooling**,
  **Ports** and **Panel ports** as bars on the racks' scale, and its role and
  status as their pills.
- **Color by** (Display) colours the room's racks as it colours their 2D
  tiles: a cabinet takes its tile's fill - the whole frame from afar, the
  posts, caps and side panels up close - with the same legend in the corner,
  and a row of the [rack table](#the-rack-table) lights its cabinet up.
- **Light that grounds the room**: one shadow-casting key light plus a
  procedural studio environment (no downloaded assets - it works
  airgapped), so cabinets stand *on* the floor instead of floating in
  front of it, and painted steel and galvanised tray read as material
  rather than flat grey. On High quality, screen-space ambient occlusion
  adds the interior depth that makes an open cabinet look hollow.
- **Port labels** (View menu, 3D, shown when the deployment prints them):
  turns the labels on the port quads off for this browser only - the same
  switch as the device page's Panel header.
- **Device names** (View menu, 3D): name plates per device. Underneath,
  **All racks / Highlighted rack** limits them to the rack you have selected
  or are focused on, and **Names off the gear** starts each plate at the
  rail edge so it runs over the frame and past the cabinet instead of
  covering the faceplate.
- **Cable thickness** (View menu, 3D): a slider from a quarter to double
  life size. Real jacket diameters are right up close and vanish across a
  hall; pick what reads at the distance you work at. Under it, **Auto /
  Tubes / Lines** picks the renderer: real tubes shaded like the rest of the
  room, or flat lines of constant on-screen width in the cable's solid
  color. Auto draws tubes up to two hundred cables and lines past that.
  Both saved per device in the browser, like Quality.
- **Quality** (View menu, 3D): Auto / Low / Medium / High - how much the
  effects may cost. Low drops shadows and caps resolution (software
  rendering survives), Medium adds shadows, High adds ambient occlusion.
  Saved **per device** in the browser, not on the plan: your workstation's
  High never follows the plan onto a weak laptop. Auto probes the GPU once
  and picks a tier.
- **Click a rack** for a summary card (space used, monitoring rollup) and a
  jump to the rack page; **click a device** inside an open cabinet for its
  own card (U position, size, face) and a jump to the device page. Up close,
  devices wear their device-type **front/rear images**. Monitoring state
  lights a beacon on top of each cabinet - the same worst-status rollup the
  2D overlays use.
- **DIN-rail cabinets** (a tile linked to a [cabinet](../dcim/cabinets.md))
  stand on the floor as closed light-grey boxes of the cabinet's outer size,
  with a door handle and the name over the front - nothing is recorded about
  how high one hangs. The outline carries the
  monitoring rollup in the beacon colours; focus, isolation, the hide eyes
  and X-ray (outline only, still clickable) apply as to racks. Hover for the
  device and rail counts, click for **Focus**, **Open door**, **Isolate
  row/zone** and **Open cabinet**, double-click to fly to the front.
  **Open door** swings the door out on its left-hand hinge (it snaps open
  when the system asks for reduced motion) and shows the inside as the
  cabinet page's [3D view](../dcim/cabinets.md#the-plate-in-3d) does: the
  mounting plate, its rails, and each device on its rail at its type's true
  size, wearing its front photo with the ports marked on it, coloured as a
  racked device's (a port held for a cable amber) and in the room's key.
  Hover a device or a port for its card; click a device for the card with
  **Open device**, a port for the same card a racked port gets - its cable
  and far end, **Connect cable**, **Trace run**. **Close door** on the
  cabinet's card shuts it again. A cabinet's contents are fetched the first
  time its door opens, never for a shut one, and its ports in one request. Cable runs end on the box's lid, each in its own
  lane; a cable between two devices in one cabinet stays inside it and is
  not drawn.
- **Side-mounted 0U strips** (vertical PDUs with a
  [rail mount](../dcim/racks.md#zero-u-side-mounting-vertical-pdus)) hang on
  their cabinet's flank as slim vertical strips in both detail tiers -
  click one for its device card. Up close, the strip's end face carries one
  small quad per **outlet** (spread down the strip at a real C13 pitch, by
  the trailing number in the outlet's name) plus its inlet at the foot.
  Each quad is clickable like a photo port - card, connect flow - and power
  cords land exactly on them.
- **Build in advance**: a typed tile needs no linked object - paint the
  future rack row now (bulk *Set type* makes this one sweep) and link real
  racks as they land. In 3D, non-rack tiles render as translucent ghost
  boxes so the planned room reads as a room rather than empty floor. Each
  carries a camera-facing name tag - the tile's label, else its linked
  device's name, else the type name. Scroll-zoom dollies **toward the pointer**, so
  getting close to a far corner of a big hall is one scroll, not a slow
  W-key flight.
- **Airflow** (View menu, 3D): draws each device's cooling direction as
  small cones - blue where air is drawn in, red where it is exhausted -
  from the device's effective airflow (its own setting, else its type's).
  Front-to-rear gear shows intake cones on the face and exhaust cones on
  the rear, side-breathing gear shows them on its flanks, `mixed` shows one
  of each on the exposed face, and `passive` draws nothing. The legend
  gains an Airflow row only while cones are on screen.

- Up close, a device whose type has **photo-anchored ports** wears its port
  markers on the image, colored exactly as on the device page - speed tier
  for cabled ports, the part's status for hardware bays. Click one for a card
  with its cable, far end and, when SNMP disagrees with the record, the
  **difference** (see [drift in the room](#drift-in-the-room)). A hardware
  bay's card carries the part's **status** as pills to pick from, and a
  right-click on the bay - pressed and let go without dragging, since a
  right-drag pans - opens the same choices at the pointer (see
  [part status](../dcim/devices.md#part-status)). The same goes for a rack's
  3D view and a cabinet's. Marker names
  match their components case-insensitively, so a photo marked `Psu 1` still
  resolves a port named `PSU 1`.
- **Power ports the photo doesn't mark still exist**: any power port or
  outlet without a photo marker gets a small synthetic quad along the bottom
  edge of the device's rear panel, ordered by name. It clicks, cards and
  cables exactly like a photo port, and power cords anchor on it instead of
  the middle of the face.
- Arriving with a **cable trace** (`?trace=<cable>` - e.g. "Show on floor
  plan" from a cable) draws the run as an animated line riding its assigned
  trays and dropping into both end racks.
- **Cables are real geometry**: each run renders as a lit tube whose jacket
  thickness follows its kind (power fatter than copper, copper fatter than
  fibre), leaves its port with a rounded bend into a corner channel just
  outside the rail - never straight down across the faceplates - and rides its trays
  in a **lane of its own**, so ten runs in one duct read as ten parallel
  runs. Hover glows; click opens the cable card. Past a couple hundred runs
  the layer falls back to simple lines for performance.
- **Same-rack runs dress at the rail.** A lead between two devices in one
  cabinet takes the corner channel nearest the two ports (2 cm outside the
  rail opening, 3 cm in front of the face) and gets a small lane of its own,
  so ten patch leads down one rail read as ten. Two ports a U apart on the
  same face still patch directly. An end whose device type has no marker for
  that port is drawn at the panel's centre, and the cable card says so.
- **Trays are open baskets** - two side rails and a floor of rungs - and
  runs ride *inside* them, resting on the rungs. **Click a tray to open it**:
  the near rail drops away, the basket tints, and a card lists every cable
  routed through it (click one to select that run). Click it again, or
  **Close tray**, to shut it. Where runs corner, tee or cross, the rails stop
  short and a **junction plate** bridges the joint, so a crossing reads as
  fabricated tray instead of two baskets shot through each other.
- A run with **no tray** flies over the cabinets rather than through them -
  it clears the tallest rack in the room and stays under the ceiling.
- The cable card names what the run **follows** - the trays in order, or
  *point-to-point* when it follows none. A cable that ignores an obvious duct
  is almost always set to point-to-point; change it on the cable's own page
  (see [routing a cable](#routing-a-cable)).
- **Double-click** a cabinet to fly to its face; double-click a **device** to
  fly to *that* device, framed for its height, from whichever aisle its face
  is on.
- The **key** in the top-right corner appears only once something photo-anchored
  is in view, and lists the hardware statuses actually on screen, as their
  pills. The speed ramp itself is always the full <100M→400G+ scale, so it
  reads the same here as under a 2D panel - see
  [The panel's key](../dcim/devices.md#the-panels-key). It is the maps' legend
  box: **Hide legend** folds it to a **Legend** chip, and the room remembers
  that per browser.
- The view is **read-only** in v1 - layout editing stays in 2D.
- Everything is drawn from the same millimetre constants as the 2D elevation
  and faceplates, so proportions match reality (EIA-310 rack opening, 44.45 mm
  U pitch). Browsers without WebGL fall back to a notice; 2D is unaffected.

Face images and text labels are filtered at the GPU's best anisotropy and the
canvas renders at the display's pixel ratio, so a cabinet read at an angle
stays sharp. What that can't fix is a low-resolution source photo - a 600 px
device image stretched across a 19″ face is soft at close range in any view.
Upload the largest faceplate photo you have.

### Drift in the room

A port or hardware bay whose observed SNMP state disagrees with the record
wears an **amber outline** - the 3D reading of the same ring the 2D faceplate
uses. The marker keeps showing your **source of truth**; the outline is a
separate signal saying "look here". Click it and the card names the difference
("SNMP says failed", "speed: SNMP says 1 Gbps"). Nothing changes until you
accept it on the device's Monitoring tab - see
[SNMP discovery](snmp-discovery.md#drift-and-reconciliation).

Drift rides along in the same batched request the port markers already use
(`GET /api/devices/face-ports/?ids=…&drift=1`), so a rack of cabinets costs no
extra round trips. Resolving the markers costs that request the same number of
queries for two devices or two hundred; drift is the part that grows with the
devices, so the request asks for it by name, and without `drift=1` every
marker's `drift` is null. A single rack's
[port state](../dcim/racks.md#api-port-state-and-3d-geometry) leaves drift out.

## Floors

A **floor plan** is a building or a hall, and holds one or more **floors**
in order, lowest first: "B1", "Ground", "1", "2", "Roof"… Each floor is its
own canvas, with its own grid, scale, background, CAD drawing, tiles, walls,
trays and 3D room; the floor plan only groups and orders them. **Maps →
Floor plans** lists floor plans with their floor count, and opening one
opens the floor you last viewed in it in this browser, or its lowest floor.
A floor plan with one floor looks the same as a single plan.

The editor header names the floor plan and shows the **floor switcher**:
the floors as segmented tabs in order, or a compact **Floor: 2** dropdown
past six floors. The address is the floor's own (`/floorplans/<floor id>`),
so a link, a bookmark or a reload lands on the same floor; switching floors
keeps the 2D or 3D view. Switching with unsaved edits asks first - the same
guard that covers every other way out of the editor, described under
[the editor](#the-editor). For click-through navigation *between* floors
(e.g. a stairwell tile), link a tile to another floor.

With the floor-plan add permission, **+** beside the switcher adds a floor:
a name, its position (on top, or below a chosen floor), and **Same grid and
scale as** the floor on screen. Nothing else is asked; the floor's settings
are the usual plan settings once it exists.

The floor plan's name is a menu (floor-plan change permission):

- **Manage floors…** - drag floors into order, rename them in place, and
  per floor **Move to floor plan…** (another floor plan at the same site),
  **Make its own floor plan**, or **Delete…**. Deleting a floor removes
  everything drawn on it; deleting the last floor removes the floor plan.
- **Merge floor plans…** - pick other floor plans at the same site; their
  floors move into this one, after its own, and the emptied floor plans go.
  Two floors with the same name are refused, listed, until one is renamed.
- **Edit…** - the floor plan's name, location (one of its site's, or
  **Whole site**) and description.
- **Clone this floor** - see [Cloning a plan](#cloning-a-plan).

Nothing groups, merges or renames floors on its own; each of these is an
explicit action. A floor name is unique inside its floor plan, so two
buildings under one location can each have a "1"; a floor plan's name is
unique at its location, or among its site's site-wide floor plans. A floor's
site is its floor plan's. Its location is its floor plan's location or a
location nested under it, so floors modelled as locations (Building A →
Level 2) work: a floor may point at Level 2 while its floor plan sits at
Building A. In a site-wide floor plan a floor may point at any location of
the site, or none. Moving or merging a floor into a floor plan at another
location of the site gives it that floor plan's location when its own lies
outside it. Moving a floor changes
only which floor plan it is in, its order and that location; its tiles,
drawing and links stay as they are.

!!! note "Upgrading to 0.19"
    Before 0.19 the floors of a building were the plans that shared a
    location. The upgrade makes one floor plan per location holding that
    location's plans as its floors, in the order the switcher showed them
    (by name), so the switcher shows the same floors as before. A location
    with one plan gets a floor plan named after that plan; one with several
    gets one named after the location. Nothing is merged across locations,
    renamed or deleted. Split, move or merge floors afterwards to match your
    buildings.

### Floors API

Floor plans are `/api/floor-plan-stacks/`; their floors stay
`/api/floor-plans/`, with every endpoint, payload and filter they had.

| Call | Purpose |
|---|---|
| `GET /api/floor-plan-stacks/` | Floor plans; `?location=`, `?site=` (its site-wide floor plans and those of its locations), `?site_wide=1`, `?tag=<slug>`, `?search=` (also matches floor names). Each row has `site`, `location` (null when site-wide), `floors` (id, name, `floor_order`, location id or null; the floors you may view, in order), `floor_count` and `last_edited`. |
| `POST/PATCH/DELETE /api/floor-plan-stacks/<id>/` | `name`, `description`, `site_id`, `location_id` (null: the whole site), `tag_ids`. `site_id` is required on create unless `location_id` gives it, and a location must be at that site; the site cannot change afterwards. A delete takes every floor with it and needs delete on each. |
| `POST /api/floor-plan-stacks/<id>/floors/` | Add a floor: `{"name", "position"?, "copy_from"?}`. `position` is its place in the order (0 = lowest; default on top); `copy_from`, a floor of this floor plan, lends its grid size, scale and layout (grid or free) - not what is drawn on it. Answers the new floor (201). |
| `POST /api/floor-plan-stacks/<id>/reorder/` | `{"order": [every floor id, lowest first]}`. |
| `POST /api/floor-plan-stacks/<id>/merge/` | `{"stacks": [ids]}` - floor plans at the same site. A name clash is a 400 with the clashes listed under `clashes`. |
| `GET /api/floor-plans/?stack=<id>` | One floor plan's floors, in order. |
| `GET /api/floor-plans/?source=<id>` | The snapshots (copies and live views) taken of one plan. |
| `POST /api/floor-plans/<id>/move/` | `{"stack_id"}` - to another floor plan at the same site, on top of its floors. |
| `POST /api/floor-plans/<id>/split/` | `{"name"?}` - make the floor a floor plan of its own (default: the floor's name). Answers the new floor plan (201). |

A floor (`/api/floor-plans/`) gains `stack` (`{id, name}`), `stack_id`
(write), `floor_order` (lowest first; negative is fine) and `elevation_mm`
(optional, reserved for a stacked 3D building). A `POST` without
`stack_id` creates a floor plan of its own named after the plan, as the
**Add** form does, and needs no other change from a script written before
0.19; with `stack_id`, `location_id` may be left out (the floor plan's
location) and the new floor goes on top. A floor reads `site` and
`location` (null on a site-wide floor) and writes `site_id` and
`location_id` (null: the whole site): `site_id` is needed on create only
when neither `stack_id` nor `location_id` gives it - a client that sends
only `location_id` gets that location's site - and the site cannot change
afterwards. `GET /api/floor-plans/?site=<id>` lists the site's floors,
site-wide or not. Deleting a floor plan's last floor
deletes the floor plan.

## The editor

Every plan opens in **View**: a clean canvas to look at, click, search and
export. Anyone with `floorplan · change` also gets **View | Edit** in the
header - press ++e++ to switch, ++esc++ (with nothing selected or half
drawn) to go back. The choice is remembered in this browser. Without the
permission the plan is View only, whatever the browser remembers, and the
server refuses every write anyway. Leaving Edit with unsaved edits asks
first; **Discard** drops them.

The page has two bars, split the way the [topology map](topology.md)'s are.
The header names the plan, with the floor switcher, the **Edited** badge,
**View | Edit** and **2D / 3D**. The bar under it has *Find on plan…*,
**Fit to view** and **Grid** on the left, and **Racks** (while the plan is
[coloured by its racks](#color-by)), **Objects**, **Display**, **Export**
and, in Edit, **Background**, plan settings, **Undo**, **Redo** and **Save**
on the right. When that bar is too narrow for all of them (a small window),
Grid, Background and plan settings move into **More** and Export shrinks to
its icon, so nothing is ever cut off.

In Edit a **tool rail** runs down the left of the canvas. It replaced the
Layout / Structure / Cables tabs of 0.18:

| Tool | Key | What it does |
|---|---|---|
| Select | ++v++ | Select, move, resize and turn what is on the plan |
| Room or area | ++r++ | Drag a rectangle: a [room, location or plain area](#rooms-areas-and-labels) |
| Polygon area | ++shift+r++ | Click its corners; ++enter++, a double-click or a click on the first point closes it |
| Label | ++t++ | Click to place a [label](#labels) |
| Tiles | ++g++ | The tile palette (Tiles / Background tabs) |
| Walls and raised floors | ++w++ | What the Structure tab did: [raised floors](#raised-floors-structure-mode) and [walls](#walls-doors-structure-mode) |
| Door | ++d++ | Drag along a wall: a [door](#doors) of that width |
| Cable trays | ++c++ | What the Cables tab did: [trays](#cable-trays-cables-mode) |
| Snapshot | ++s++ | Drag a rectangle: a [snapshot](#snapshots) of that part of the floor |

At its foot, **Free placement** switches the plan between the grid and
[free placement](#free-placement).

| Action | How |
|---|---|
| Place a device, rack or cabinet | **Place…** (++p++) - [pick or drag it](#placing-devices-racks-and-cabinets); no tile type needed |
| Place a tile | Click a palette entry to arm it, then click a cell (default size) or drag a rectangle (walls, aisles) |
| Move | Drag a tile - snaps to cells |
| Resize | Drag the corner handle of the selected tile |
| Rotate | The rotate button - swaps width/height in 90° steps and turns the icon; grid occupancy stays honest. A thin bar just inside the tile marks the edge its front faces |
| Label / color / status | The inspector panel (label overrides the linked object's name; status renders planned/reserved dashed, decommissioning faded) |
| Link to an object | Inspector → Link: rack, cabinet and device use the advanced pickers (cabinets of the plan's site only), power panel/feed, cooling source and nested plans a searchable dropdown. When a cabinet's outer width × depth does not match the tile, **Fit to cabinet** resizes the tile to it, turned with the tile's facing |
| Delete | Select + `Delete`, or the inspector button |
| Nudge | Arrow keys move the selected tile one cell (on a [free plan](#free-placement), ++alt++ + arrow moves a tenth of a cell) |
| Undo / redo | ++ctrl+z++ / ++ctrl+shift+z++ (or ++ctrl+y++), or the bar's buttons - ++cmd++ on a Mac |
| Save | **Save**, or ++ctrl+s++ |
| Pan / zoom | Drag empty grid / mouse wheel. On a touch screen, drag with one finger and pinch with two. A plan zooms out to half of what fits it on screen, so a large site plan can be seen whole |

**Pinch zoom.** On a tablet or a touch screen, two fingers zoom the 2D plan
about the point between them and pan it as they move, within the same zoom
limits as the wheel. This works for viewers as well as editors, and on the
dashboard's floor-plan widget. A second finger landing stops what the first
one started: a tile drag ends where the tile is, and a half-drawn paint or
selection sweep is dropped.

**Tiles never stack.** Placing, dragging, resizing, or rotating a tile onto
occupied cells is blocked - the tile stays where it was. Background **zones**
are the exception: they may cover anything, and anything may sit on them.

Edits are local until you press **Save** - one transactional bulk call writes
all creates, moves, and deletes of tiles, areas and labels together, and the
change log records each row individually. If someone else changed or deleted
one of those rows since you opened the plan, nothing is written and the
editor [asks whose version stays](#when-someone-else-saved-first).

**Undo** steps back through the edits since the plan was opened or last
saved - placing, moving, resizing, turning, retyping, relabelling and
deleting tiles, and drawing, moving, resizing, turning, linking and deleting
rooms, areas and labels, and drawing, moving, reshaping, splitting, joining
and deleting walls, doors, trays and raised floors, up to 100 steps - and
**Redo** steps forward again. A whole drag is one step, and so is a bulk
action on a selection or **Add walls around this**. Routes applied from
[Update N routes?](#re-routing-after-a-move) join the move they follow, so
one undo takes back both. Undoing every step
leaves nothing to save. Saving starts a fresh history. Walls, doors, trays
and raised floors save with the rest of the plan; a tray's cables and the
drawing save as you change them and are not part of it.

While there are unsaved edits an **Edited** badge sits in the header, and
leaving the plan asks first - **Discard unsaved changes?**, with *Keep editing*
or *Discard and leave*. One guard covers every in-app exit: a sidebar link, a
breadcrumb, browser back/forward, a tile that links out to a rack or another
floor, and the floor switcher. Closing the tab or reloading raises the
browser's own leave-site prompt instead, since that never reaches the app.

Switching the same plan between 2D and 3D, or clearing a cable trace, is a view
change rather than an exit, so neither is guarded.

Under **Display**: **Color by** heads the menu - see [below](#color-by);
**Fit labels to tiles** auto-sizes each tile's text to its footprint (so
single-cell tiles keep readable names) - the preference is saved on the plan;
**Camera FOV cones** shows/hides the camera wedges; **Photos** draws
every device and rack tile that has a photo as its photo, and **Photo
outlines** gives photo tiles their coloured outline (see [Photos](#photos)).

**Changing a tile's type.** Select a placed tile and pick another **Type**
in the inspector - any tile type, or a device role standing in as one. The
tile keeps its position, size, label, color and object link; only the look
(and the popover rows configured for that type) follow the new type. Zones
stay zones.

## Rooms, areas and labels

A floor is more than its racks: draw the **rooms** on it, mark areas that are
not rooms (a cage, a loading dock, a staging corner) and write **labels**
where a reader needs them ("North side", "A-feed side").

### Rooms and areas

In Edit, the **Room or area** tool (++r++) draws a rectangle - drag it out,
or click for a 3 × 3 cell one - and **Polygon area** (++shift+r++) draws any
outline: click its corners, then ++enter++, a double-click or a click on the
first point closes it (++backspace++ takes back the last point, ++esc++ drops
the drawing). An outline that crosses itself is not closed. After drawing, the tool goes back
to **Select** and the inspector shows the new area:

- **Stands for** - a **Room** of this floor's location (or of a location
  inside it), a **Location** (this floor's or one inside it), or **Just an
  area**. Rooms and locations are offered as their colour badges; **+**
  next to the Room picker makes a new room in this floor's location and
  links the area to it (needs permission to add rooms). On a
  [site-wide floor](#site-wide-floor-plans) - one made from the Site map -
  the dialog also asks which **Location** the room is in, starting from the
  location of an area drawn around the new one. **+** next to the Location
  picker makes a location at the floor's site - its **Parent** (this floor's
  location by default) and **Location type** optional - and links the area
  to it (needs permission to add locations). A linked
  area wears the room's or location's colour - from its data, never from
  its name - and shows its name; a plain area takes a colour of its own,
  or its [area type's](#area-types).
- **Type** (Just an area only) - what the area is: *Parking*, *Fence*,
  *Road*… from your [area types](#area-types), offered as their colour
  badges, with **+** to make one there and then (needs permission to add
  area types). Linking the area to a room or a location drops its type.
  Linking never changes anything about the room or the devices standing in
  it: a device's room is set on the device.
- **Room colour** (or **Location colour**) is the linked room's or
  location's own colour, not the area's. With permission to change the room
  (or location) you can change it here: it is written to the room itself -
  checked and logged like an edit on the room's page - and every area of
  that room, on every floor, and its badge everywhere take the new colour.
  Without that permission the colour shows read-only.
- **Name** overrides the linked name on the plan.
- **Fill** (opacity), **Border** (solid, dashed or none), **Show the name**,
  and the **Rotation** of a rectangle in degrees. The name is drawn in the
  area's colour over a light fill, and in black or white - whichever reads -
  from 50 % fill up, so it never disappears into the fill.

Areas draw over the background, the drawing and the zone tiles, and under
every other tile. They may overlap - a cage inside a hall is real. Each has a
stacking order: **Bring forward** / **Send back** in the inspector or the
right-click menu, ++ctrl+bracketright++ / ++ctrl+bracketleft++. **Lock**
keeps an area from moving.

**Selecting and moving.** Click an area to select it, then drag to move it -
an area must be selected before it moves, so a big room under the pointer
never catches an attempt to pan. A selected rectangle shows eight resize
handles and a turn handle above its top edge; a selected polygon shows its
corners, each a handle to drag. Double-click a polygon's edge to add a
corner there; right-click a corner and **Remove point** to drop one (a
polygon keeps at least three). ++shift++ while resizing keeps the
proportions; ++shift++ while turning turns in 15° steps, and without it the
turn settles on a quarter turn within 4°.

**Snapping.** On a grid plan, rooms, areas and labels settle on **half
cells**; on a [free plan](#free-placement) they are pulled onto the cell
lines when near one. On both, an edge or middle near another area's, label's
or tile's edge or middle is pulled onto it, and a dashed guide shows the line
it took. Hold ++alt++ to place freely.

**Viewing.** In View, click an area linked to a room and the map panel opens
the room: its code, status, location and how many devices, racks and cabinets
stand in it, with **Open room**. An area linked to a location offers **Open
location**. The room's (or location's) page shows its part of the floor on a
[**Floor plan** tab](../dcim/rooms.md#floor-plan); its **Open in floor plan**
opens the floor at `/floorplans/<id>?area=<area id>`, with the area open
and in view.

**Snapshot.** **Snapshot this room…** on an area's right-click menu or its
floating toolbar takes a [snapshot](#of-a-room-location-or-area) of it.

### Opens links

An area or a label can **open** another floor plan: a click on it in View
goes there, as a click on a [floor-plan tile](#open-a-tile-type) does. Use
it for "Go to B1" on a site plan, a building that opens its ground floor, or
a room that opens its snapshot.

- **Setting it.** **Opens…** on the floating toolbar, or the **Opens** row in
  the inspector, picks the target from three groups: **Floors of this
  plan**, **Snapshots of this plan** (its copies and live views) and **Other
  floor plans** (searchable). **Make a snapshot of this…** makes a live view
  of the area (a label: of the area it stands in) and links to it in one
  step; it needs a saved area and permission to add floor plans. The arrow
  next to the picker opens the target. Any floor of any floor plan,
  snapshots and live views included, may be a target - never the plan the
  shape is on.
- **On the plan.** A linked area or label carries a small link mark; in
  View, hovering it names the target ("Opens Campus · B1").
- **Back button.** With a target set, the **Back button** switch puts a
  label on the target that opens this plan back - "Back to Site" unless you
  write your own text below the switch. Each side's text is its own:
  renaming one never renames the other. The label lands in the target's
  top left - on a live view, on the view's source in the view's top left
  (just inside the room's outline when the view follows a room, so the
  dimming never covers it), shown only in that view (never on the source or its other views) - and
  is an ordinary label there, to move and restyle. It starts looking like
  the button that leads there - a label's size, weight, colours and plate;
  for an area, a size that reads on the target when it is fitted. A live view also hides
  the shapes of its source that open the view itself, so "Go to B1" shows
  on the main plan and "Go back" in the B1 view. Picking another target offers to move the back label with it;
  clearing the target, turning the switch off or deleting the shape offers
  to delete it. The switch needs the shape saved and permission to change
  the target (a live view's source too); without it, it is disabled and
  says why.
- **Who sees what.** The target must be a plan of the tenant you may view.
  A reader who may not view it sees no name: the shape keeps its mark,
  opens nothing and reads "Opens a hidden plan", and saving the plan keeps
  the link.
- **Copies.** A clone and a snapshot copy keep where each shape opens; a
  copied back label becomes a plain label. On paper the link is a note
  under the shape ("→ Campus · B1").

### Area types

An **area type** says what a plain area is - *Parking*, *Fence*, *Road*,
*Gate*, *Lawn*, whatever a site plan holds besides rooms. Types are your own
catalog under **Organization → Area types**: each has a name, a **colour**,
a **fill pattern** (*Solid*, *Hatched*, *Cross-hatched* or *Dotted*), a
**Lucide icon** and a description, and a name is unique in the tenant.
Danbyte ships none - make the ones you use. On screen a pattern's lines, and
an area's border, keep their spacing and width at any zoom, so a hatch stays
readable zoomed out.

- **Plain areas only.** A type is for an area that stands for neither a room
  nor a location ("Just an area"). A linked area keeps one meaning - the
  room's or location's - and its colour; it never carries a type, and the
  API refuses one on it.
- **How a typed area is drawn.** Its colour is its own when you set one,
  else its type's. The fill pattern runs over the area's fill in the same
  colour, clipped to its outline, in both themes; the type's icon sits
  before the name, and an unnamed area is called by its type. Over a
  pattern the name has a halo of the background so it reads; from 50 %
  fill up it turns black or white as on any area.
- **Legend.** The plan's legend, in its corner and inside the export area,
  gains an **Areas** section: each type a shown area wears, as a swatch of
  its colour and pattern, its icon and its name.
- **Paper and 3D.** The PDF draws the patterns as lines clipped to each area
  and prints the Areas legend in its footer; the PNG is the screen. The 3D
  room tints the floor under a typed area in its colour, without the
  pattern.
- **The catalog.** The list has a pattern column and filter, and how many
  areas use each type. Select several types to edit their colour, pattern,
  icon and description at once, or to delete them. **Deleting a type**
  leaves its areas in place, without a type. A type's page shows its look,
  its Journal and its Change log. Import and export work like any other list.
- **Permissions** - `areatype`, a tenant-wide catalog like location types.
  [Site roles](permissions.md#site-roles-local-it-in-one-click) read the
  types; only a tenant-wide grant changes them.

API: `/api/area-types/` (`?picker=1` for the short form, `?search=`) with
`name`, `slug`, `color`, `pattern`, `icon`, `description` and the read-only
`area_count` (the areas you may view); an area carries `area_type` and
`area_type_id`.

### Labels

The **Label** tool (++t++) places a label where you click, its text selected
in the inspector so you can type straight away; the text may run to several
lines. A label's size is the **height of its text on the
floor, in millimetres**, so it scales with the plan, the PDF and its scale
bar like the drawing does. **S**, **M**, **L** and **XL** are a quarter, a
half, three quarters and one and a quarter of the plan's cell (150, 300, 450
and 750 mm on a 600 mm grid); the millimetre field takes any height from 20
to 5,000. Dragging a label's corner handle scales its text. A label also has
**Bold**, alignment, a **colour** from a short palette (ink, muted, red,
amber, green, blue, violet - the same on screen in either theme and on
paper), an optional **plate** behind the text so it reads over lines, and a
rotation. The plate has a **Plate colour** of its own from the same palette
(**Default** is the theme's background); over a coloured plate the text
turns black or white, whichever reads, unless the label has a colour of its
own. The PDF draws the same. Labels draw over the tiles. A label can
[open another plan](#opens-links).

### Right-click on the plan

In Edit, a right-click on empty plan space offers **Place device here…**
(the [Place picker](#the-place-picker); what you pick lands at the point,
on the grid on a grid plan), **Draw room/area here** (what a click with the
Room tool draws: a 3 × 3 area at the point, selected to resize and link),
**Add label here** (a label at the
point, its text ready to type) and **Fit to view**. In View, those who may
edit get **Edit here**, which switches to Edit.

The menu offers what fits what is under the pointer: a placed device, rack
or cabinet adds **Connect to…** (in Edit, for those who may add cables); an
area adds **Add walls around this**; a wall offers **Add door here**, **Add bend here**,
**Split here**, **Join walls** and **Delete wall**, a door **Flip swing** and
**Delete door**; with the walls tool a raised floor offers **Delete raised
floor**, and with the trays tool a tray the same as a wall, less the door.

### Keyboard

| Key | In Edit |
|---|---|
| ++e++ | View / Edit |
| ++p++ | Place… - in View too, for those who may edit: it switches to Edit and opens the picker |
| ++v++ ++r++ ++shift+r++ ++t++ ++g++ ++w++ ++c++ ++s++ | The tools |
| Arrows | Move the selected area or label half a cell (a cell on a free plan, a tenth with ++alt++) |
| ++delete++ | Delete the selected area or label - or wall, door, tray or raised floor |
| ++d++ | The Door tool |
| ++f++ | Flip the selected door's swing |
| ++j++ | Join the two walls (or trays) picked with Shift or Ctrl/⌘ |
| Arrows (structure) | Move the selected wall or tray half a cell, a raised floor a cell; slide a selected door 100 mm |
| ++ctrl+bracketleft++ / ++ctrl+bracketright++ | Send back / bring forward |
| ++h++ / ++shift+h++ | Hide the selection / show everything |
| ++enter++ / ++backspace++ | Close the polygon / take back its last point |
| ++esc++ | Drop the drawing, put the tool down, clear the selection, then leave Edit |

**Objects** lists the plan's areas under **Rooms and areas** (as their colour
badges) and its labels under **Labels**, each with an eye; a hidden one is
left off the plan, the 3D room and the exports, and counts in the hidden
chip like a hidden tile.

### On paper and in 3D

The PNG and PDF exports draw rooms, areas and labels as the plan shows them
(labels at their real size, in their paper ink; an area type's pattern and
icon included). The 3D room tints the floor under each room or area in its
colour; labels are 2D only.

### API

| Call | |
|---|---|
| `GET/POST/PATCH/DELETE /api/floor-plan-areas/` | `?floor_plan=<id>`. Write `floor_plan_id`, `shape` (`rect` or `polygon`), `x`, `y`, `width`, `height`, `rotation` (a rectangle: its upright box in cells, inside the grid, turned about its centre), `points` (a polygon: 3-200 `[x, y]` pairs inside the grid that do not cross; its box is worked out), `room_id` or `location_id` (at most one), `area_type_id` (a plain area only; linking a room or location drops it), `label`, `color`, `fill_opacity` (0-100), `border` (`solid`, `dashed`, `none`), `show_name`, `z`, `locked`. Reads `room` (`id`, `name`, `code`, `color`), `location` (`id`, `name`, `color`) and `area_type` (`id`, `name`, `color`, `pattern`, `icon`). |
| `GET/POST/PATCH/DELETE /api/floor-plan-labels/` | `?floor_plan=<id>`. `text` (1-500 characters), `x`, `y` (inside the grid), `width`, `height` (`null`: sized to the text), `rotation`, `font_mm` (20-5000, default 300), `weight` (`normal`, `bold`), `align` (`left`, `center`, `right`), `color` (`""`, `muted`, `red`, `amber`, `green`, `blue`, `violet`), `plate`, `plate_color` (the same tokens, `""` the background), `z`, `locked`. Reads `pair_id`: on a back label, the area or label whose Back button made it. A back label made for a live view is shown only in that view's `contents/`. |
| Opens (areas and labels) | Write `opens_id` (a floor plan of the tenant you may view, not the shape's own; `null` clears it; left out, it is kept). Reads `opens` (`id`, `name`, `stack_name`, `kind`, `can_change`) - `null` with `opens_hidden: true` when you may not view the target - and `back_label` (`id`, `floor_plan_id`, `floor_plan_name`, `text`) or `null`. |
| `POST /api/floor-plans/<id>/back-link/` | A shape's Back button: `{"kind": "area" \| "label", "id", "on": true, "target_id", "text"}` makes the back label on `target_id` (or moves it there, or renames it); `"on": false` deletes it. Needs `floorplan · change` on this plan and on the target (a live view's source too). Answers `{"back_label"}`. |
| `POST /api/floor-plans/<id>/bulk/` | What the editor's **Save** sends: `{"tiles": {...}, "areas": {...}, "labels": {...}, "walls": {...}, "raised_floors": {...}, "trays": {...}}`, each `{"create": [...], "update": [{"id", ...}], "delete": [ids]}`, every key optional, in one transaction (deletes first), at most 5,000 operations. A new tray in `trays.create` carries a `key` (the draft's id for it) and may carry `cable_ids`; a tray update writes its cables only when it carries `cable_ids`. An id that is not this plan's is a 400 and nothing is written. Answers `{"tiles", "areas", "labels", "walls", "raised_floors", "tray_rows"}` - the plan's rows afterwards (`trays` lists the new trays' keys and ids). Needs `floorplan · change`, and for walls, raised floors and trays the add, change or delete permission their own endpoints ask for. `tiles/bulk/` stays for tiles alone. |
| Walls | `/api/floor-plan-walls/` writes `points`, `label`, `color`, `height_mm`, `thickness_mm` (20-2000, `null` the standard 100 mm) and `openings`: `[{"seg", "from", "to", "height_mm", "hinge"?, "side"?}]` - spans along segment `seg` in cells, inside it and not overlapping; `hinge` is `start` or `end` and `side` `left` or `right` (both left out: a plain opening). |

A room must be one of the plan's location's rooms, or of a location nested
under it; a location must be the plan's or nested under it (on a site-wide
floor: any room or location of the site); both must be in
the active tenant and ones you may view - anything else is refused on the
`room_id` or `location_id` field, on create, update and bulk alike.

## Free placement

A plan is laid out on its **grid** - tiles on whole cells, turned in quarter
turns, never on each other - or in **free placement**. **Free placement** at
the foot of the tool rail switches the plan to free at once. On a free plan:

- a tile moves smoothly with the pointer (snapping onto cell lines and other
  tiles', areas' and labels' edges when near them; ++alt++ for none) and
  stops wherever you let go - positions and sizes are kept to a thousandth of
  a cell;
- a selected tile shows the same eight resize handles and turn handle as an
  area, and turns to any whole degree;
- tiles may overlap;
- arrows nudge a cell, ++alt++ + arrow a tenth of one.

The way back is **Back to the grid…** (the same button): **Snap all to the
grid?** shows how many tiles move - each to the nearest whole cells and the
nearest quarter turn - and lists any that would then stand on another tile.
Nothing moves until you confirm; tiles that end up on each other stay so
until you move them. Save your edits first - the snap works on the saved
plan. A plan cannot be switched back to the grid any other way while a tile
is off it.

A tile linked to an object does not need a tile type or role: a linked
tile may have neither and draws from its object - see
[Placing devices, racks and cabinets](#placing-devices-racks-and-cabinets).

| Call | |
|---|---|
| `PATCH /api/floor-plans/<id>/` | `layout_mode`: `grid` or `free`. To `grid` only when every tile is on whole cells and a quarter turn, else a 400 on `layout_mode`. |
| `POST /api/floor-plans/<id>/snap-all/` | `{"dry_run": true}` answers `{"layout_mode", "moved", "collisions": [{"id", "name"}]}` and changes nothing; without it the tiles are snapped (each one in the change log), the plan is set to `grid` and the answer adds `tiles`. Needs `floorplan · change`. |
| Tiles | `x`, `y`, `width`, `height` are numbers of cells; a grid plan takes whole ones only, and `orientation` 0, 90, 180 or 270; a free plan any `orientation` 0-359. A tile needs a `tile_type_id` or a `role_type_id`, or a link. |

## Placing devices, racks and cabinets

Placing an existing device, rack or cabinet takes one step: pick it, and it
is on the plan. No tile type or role is chosen first.

### The Place picker

In Edit, **Place…** sits first on the bar; ++p++ opens it, and in View
switches to Edit first when you may edit the plan (its tooltip shows the
key). It lists the
devices, racks and cabinets of the plan's site that you may view, searchable
by name, in three groups:

1. **In** the room near the pointer - the room (or location) of the area
   under the pointer when the picker opened, else of the area in the middle
   of the view. **Near** shows that room; × clears it.
2. **In** the floor's location, or a location inside it. A site-wide floor
   has none: this group is the location of the room near the pointer, and
   reads **Nearby**.
3. **Elsewhere** at the site.

Each row shows the object's room as its colour badge, and where it is
already placed: **On this floor**, or the name of the other floor. **On this
floor** follows the plan as it is in the editor, unsaved edits included: an
object placed a moment ago is on this floor at once, and one whose tile was
deleted is not. A device mounted in a rack or a cabinet is placed with it
and is not listed.

What already stands on this floor is not suggested: it leaves the **In**
groups and waits, folded, in **On this floor** at the foot of the list, with
its count. A search by name finds it in its group, marked **On this floor**.
Objects placed on another floor stay listed, with that floor's name.

An object stands once on a floor:

- **Click** a row: the object is placed in the middle of the view. A row
  already on this floor is selected and shown instead.
- **Drag** a row onto the plan: it is placed where you drop it - on a grid
  plan on the cell under the pointer (or the next free cell to its right,
  as tiles never stack), on a free plan exactly there. Dragging an object
  already on this floor moves its tile there instead (on a grid, when the
  cell is free) and selects it.
- **Tick** several rows and drag one of them, or press **Place N**: they are
  placed side by side in a row from that point. Those already on this floor
  are skipped, and a note says how many.

The save refuses a second tile linked to the same device, rack or cabinet on
one floor, whichever way it is sent. Duplicates saved before this rule stay
as they are and can still be edited.

A placement is an ordinary edit: part of undo and of the next **Save**.

### How a placed object looks

A placed tile has no type of its own: it draws from its object, as it is
now. A device wears its **device role's** colour and icon, a rack or a
cabinet its role's colour; a new role colour shows on the plan, the 3D room
and the exports without touching the tile. An object without a role is
grey. The tile's own colour, and a type picked later in the inspector, still
win.

The older way stays: arm a tile type in the **Tiles** palette, place the
tile, then **Link** it to an object in the inspector. Such a tile keeps its
type's look.

### Not placed

In Edit, **Objects** opens with **Not placed** on top: the devices, racks
and cabinets of the floor's location (or a location inside it, or one of
their rooms; on a site-wide floor, of the whole site) that stand on no floor
plan yet, with their count - this floor counted as the editor holds it, so a
placed object leaves the list at once and one whose tile you deleted comes
back before you save. Drag one onto the plan, or click it to place it in the
middle of the view.

### Rooms are never set by placing

Where a tile stands does not change the object's room. When you drop an
object into a room's area and the object names another room (or none), the
**After placing** card over the plan offers **Set room** to that area's room
(the card also offers to route the object's cables:
[After placing](#after-placing-route-the-cables)) - one click,
written as an edit of the object (it needs `change` on it and lands in its
change log), or dismissed with ×. Setting a room also sets the object's
location to the room's, as any room edit does ([Rooms](../dcim/rooms.md)).

The same offer sits in the floating toolbar of a selected tile standing in
another room's area. **Place… → Set rooms from areas…** (its (i) says
what it does) lists every
placed object of the floor whose tile centre lies in a room's area while the
object names another room - the topmost room area when they overlap -, with
its room and the area's room. Tick the ones to change and **Set**; an
object you may not change is listed but cannot be ticked. Areas linked to a
location, and plain areas, are not used.

### Photos

A device or rack can show as its **photo** instead of its coloured box: the
first image attached to the object, else - a device - its device type's
front image. Select the tile and press **Show as photo** in the floating
toolbar (**Show as tile** goes back); a tile just placed from the picker
offers it at once, before the save. Without a photo the button is greyed
out, and its tooltip says where one comes from: an image on the device (or
rack), or a front image on its device type. The photo keeps its proportions
inside the tile, with the name under it. Selected, it is outlined; the
coloured outline that carries monitoring and planned status shows on the
other photo tiles only with **Display → Photo outlines** (off by default).
On a grid plan the photo fits the tile's cells; the tile keeps its size. On a free plan, placing an object
that has a photo places it as its photo at the device type's real width (one
cell when the type has none); the corner handles resize it with its
proportions kept (++shift++ frees them), the turn handle turns it, and
**Bring forward** / **Send back** stack overlapping tiles. Without a photo
the tile draws as its box, whatever it is set to. The PDF export draws a
photo tile as its box.

To see the whole floor as photos, turn on **Display → Photos**: every tile
that has a photo draws as it, in View and in Edit, while each tile's own
**Show as photo** / **Show as tile** setting stays as saved. Like the other
display choices it is saved on the plan for those who may edit it.

### The floating toolbar

A selected tile, area or label in Edit carries a small toolbar just above
it, next to the inspector: **Set room** (see above), **Show as photo** or
**Show as tile**, **Bring forward** and **Send back** (a free plan's tiles;
areas and labels), **Lock** (areas and labels), **Link room** (areas),
**Opens…** (areas and labels, see [Opens links](#opens-links)),
**Add walls around this** (areas; **Add walls around these** with several
picked), **Connect to…** (a device, rack or cabinet, for those who may add
cables; see [Connect to…](#connect-to-plan-new-cables)) and **Delete**. A selected wall carries **Add door** and **Delete**, a
door **Flip swing** and **Delete**, a tray or raised floor **Delete**, and two
walls or trays picked that touch **Join**.

### An empty floor

A floor with nothing on it opens in Edit with two buttons: **Draw a room**
(the Room tool) and **Place devices** (the picker).

### When someone else saved first

Every row the editor saves carries the `updated_at` it was based on. If
someone else changed or deleted one of those rows since the plan was
opened, nothing is written and **Changed elsewhere** lists them - who
changed each one, from the change log, and whether it was changed or
deleted. Per row, **Keep mine** saves your version over theirs (a row they
deleted is made again) and **Take theirs** drops your edit of it and shows
the row as it is now; **Save** then saves again. A whole row wins or loses:
fields are never merged, since a position from one edit and a turn from
another would give a place nobody chose.

### API

| Call | |
|---|---|
| `GET /api/floor-plans/<id>/placeable/` | The picker's rows: `?q=` (name), `?kind=device,rack,cabinet`, `?near_room=<id>` or `?near_location=<id>` (rank 0), `?unplaced=1` (the floor's objects on no plan; with `&include_here=1` on no other plan, those on this one last), `?limit=` (50, at most 200). Each row: `kind`, `id`, `name`, `rank` (0 near, 1 the floor's location, 2 the rest of the site), `room`, `location`, `status`, `role`, `photo`, `placed_count`, `placed_on` (`floor_plan`, `tile_id`, `this_floor` - floor plans you may view). Each kind by its own view grant and site scope. On a site-wide floor rank 1 is the near room's location and `?unplaced=1` covers the whole site. |
| `POST /api/floor-plans/<id>/assign-rooms/` | `{"dry_run": true}` answers `{"objects": [{kind, id, name, tile_id, room, area_room, can_change}]}`; `{"apply": [{"kind", "id"}]}` sets the room of the listed ones you may change (each validated and audited like a `PATCH` of the object) and answers `{applied, skipped, objects}`. |
| Tiles | `display`: `icon` (default) or `photo`; `z`: stacking order. Read-only `photo` (`url`, `aspect` - height over width -, `source`: `device`, `rack` or `type`, `width_mm`), null without one or without view on the object; `linked` adds the object's `room` and `role` (`id`, `name`, `color`, `icon`) for a device, rack or cabinet. |
| `POST /api/floor-plans/<id>/bulk/` | A create (or a relink) of a tile linked to a device, rack or cabinet that already has a tile on this plan is refused with a `link_id` field error (400), as on `/api/floor-plan-tiles/`. An update may carry `version` (the row's `updated_at`), and a delete may be `{"id", "version"}`. A row changed since answers **409** `{"detail", "conflicts": [{kind, id, current, changed_by}]}` (`current` null when it was deleted) and nothing is written. Without a version the last save wins, as before. |
| `PATCH` / `DELETE` on `/api/floor-plan-tiles/`, `-areas/`, `-labels/` | The same check: `version` in the body, or `?version=` on a delete. |

## Opening a plan

The editor reads everything drawn on a plan in one request,
`GET /api/floor-plans/<id>/contents/`: every tile, tray, wall, raised-floor
area, room or area and label, with no page limit, so a plan of several thousand tiles opens whole.
Before 0.19 the editor read one page of each kind - at most 1,000 tiles and
500 trays, walls or raised floors - and left the rest off the plan without a
word. The dashboard's floor-plan widget reads the same request.

```json
{
  "version": "2026-10-30T09:14:02.511Z",
  "tiles": [ … ],
  "trays": [ … ],
  "walls": [ … ],
  "raised_floors": [ … ],
  "areas": [ … ],
  "labels": [ … ]
}
```

Each list holds rows in the shape its own endpoint returns
(`/api/floor-plan-tiles/`, `/api/floor-plan-trays/`, `/api/floor-plan-walls/`,
`/api/floor-plan-raised-floors/`, `/api/floor-plan-areas/`,
`/api/floor-plan-labels/`), narrowed the same way: to the active tenant,
and to the rows the reader may view under each type's own permission and site
scope. Someone who may view the plan but not its trays gets an empty `trays`.
`version` is the newest `updated_at` across the rows, `null` for an empty plan.
The request costs the same number of database queries however large the plan
is.

Those per-kind endpoints stay, with `?floor_plan=<id>`, for scripts and
integrations. They page like every list, so read every page or use
`contents/`.

## Live state on tiles

The canvas refreshes `GET /api/floor-plans/<id>/state/` every 30 seconds - a
poll that costs the same number of queries however many devices the plan
holds. A rack tile's figures are the rack page's, its `power` and `cooling`
included (see
[Racks](../dcim/racks.md#api-a-floor-plans-racks-and-their-ports)); a
plan's racks with their port figures are
`GET /api/racks/?floor_plan=<id>&include=ports`, asked for once rather than
on every poll.

- **Rack tiles** carry a space-utilization bar (green, amber and red at the
  tenant's capacity levels, 80 % and 95 % unless changed - see
  [Racks](../dcim/racks.md)) and a percentage. The racks list's **Used** and **Power** bars
  and the tile popover's bar use the same scale. Coloured by a rack measure
  ([Color by](#color-by)), the bar and the figure show that measure instead.
- **Monitoring rollup** - a rack tile's border turns red the moment any
  device inside it goes down (worst status across the rack's devices' IPs);
  device tiles do the same for their own IPs.
- **Cabinet tiles** report the cabinet's device and rail counts - the
  device count sits in the tile's corner - and roll up its devices'
  monitoring the same way. A cable to a device in a placed
  cabinet ends on the cabinet's tile, as one to a racked device ends on its
  rack's, and in the 3D room the cabinet stands as a closed box of its outer
  size.

## Color by

**Display → Color by** colours the plan's racks by how full they are, or by
what they are - in 2D and in the 3D room alike:

| Choice | A rack's tile shows |
|---|---|
| **Type** (the default) | The plan as it always looked: every tile in its type's colour. |
| **Space** | Units in use over its height. |
| **Power** | Demand over supply, as the [rack page](../dcim/racks.md) reads it. |
| **Cooling** | Heat over its cooling capacity, as the rack page reads it - see [Cooling](cooling.md). |
| **Ports** | Ports in use - cabled or reserved - over its devices' counted interfaces, patch panels aside. |
| **Panel ports** | The same for its front ports and patch-panel devices. |
| **Rack role** | Its role's colour. |
| **Status** | Its status's colour. |

- The five measures fill a rack's tile with its level on the racks' one
  scale - green up to the tenant's warning level, amber above it, red above
  its critical level (80 % and 95 % unless changed) - and grey where
  there is nothing to measure: no supply, no cooling capacity, no ports
  counted. The figure is
  always written on the tile, `86%` or *No data*, on a one-cell rack too, so
  the reading never rests on colour alone; the bar along the tile's foot
  shows the same measure.
- **Rack role** and **Status** take the role's or the status's own colour,
  grey for a rack without one, and keep the space bar.
- **Monitoring keeps the outline** in every mode: a rack with a device down
  is outlined red whatever its fill says.
- Tiles that are not racks - walls, aisles, a rack tile with no rack linked
  yet - turn neutral and faint while the racks are coloured; zones keep their
  tint.
- A **legend** in the plan's corner keys the colours: the levels with how
  many racks sit in each, or the roles and statuses as their pills, and what
  the outline means while a rack is alarming. It is part of the picture,
  with no Hide button, so the [PNG](#export) carries it.
- The choice is saved with the plan, like its other view settings: an
  editor's choice is the plan's, a viewer's lasts the visit.
- Units, power and cooling refresh with the 30-second [live state](#live-state-on-tiles);
  ports, roles and statuses come from the plan's racks, asked for once when a
  rack choice is picked (`GET /api/racks/?floor_plan=<id>&include=ports`),
  never on the poll.

### The rack table

While the plan is coloured by its racks, a table of them opens under it,
the width of the page: the racks list's own columns - **Name**, **Role**,
**Status**, **Devices**, **Used**, **Power**, **Cooling**, **Ports**,
**Panel ports** and **Tags** - sortable, with the rest and the custom fields
in **Columns**.
*Find rack…* matches a name or facility ID; the rail filters by role, status
and tag, and its advanced filter reaches custom fields.

- Pointing at a row rings its rack on the plan; a click on the row - not on
  its links - selects the rack and zooms to it, and in the 3D room flies to
  its front.
- While anything is filtered, the racks the table leaves out fade on the 2D
  plan.
- The Ports figures open **Port utilization** on the rack.
- Drag the table's top edge to resize it (remembered per browser). **Racks**
  on the bar, or the table's ×, closes it, and the plan fits itself to the
  room it gets back.
- The table lists the racks the [Objects](#finding-things) sidebar otherwise
  would: while it is open, the sidebar keeps the plan's other tiles.

## Rack & device deep view

A click on a rack or device tile pins its popover; its **Contents & trace**
(a device: **Trace**) button, a double-click or right-click → Open opens a
side panel with the rack's capacity, its **real elevation** (front/rear, role-colored),
and the device list - each device has an **End-to-end** button that shows its
cable paths through patch panels to the far end, the same trace view as the
device page. Device tiles open the end-to-end view directly.

A cabinet tile opens the same panel for the cabinet: its status, monitoring,
devices, rails and size, the plate drawn with its devices' photos, and the
devices rail by rail, each with a link and a trace. Editors open it with a
double-click, viewers with a click, and either from *Contents & trace* or
right-click → Open.

## Viewer

Click a tile to see what it is and jump to the linked object (**Open rack**,
**Open device**…, the same link every map panel uses).
A click on a rack or device tile pins its popover, where **Contents & trace**
(**Trace** for a device) opens the deep view, as a double-click does; on a
touch screen, with no hover to pin, a tap opens it straight away. A cabinet
tile opens its panel on a click; a tile linked to **another floor
plan** navigates into it on click - use this to nest a cage or suite plan
inside a hall plan.

### Working many tiles at once

**Shift-click** or **Ctrl/⌘-click** tiles to build a selection (a tile
already selected joins it), or **Shift-drag** on empty grid to sweep one
(plain drag still pans). Then:

- **Drag** any selected tile to move the whole selection, cell by cell. It
  stops where it would leave the grid or land on a tile outside the
  selection, and catches up when the pointer is somewhere it fits.
- **Arrow keys** move the selection one cell; ++delete++ removes it.
- A bulk bar shows the count, **Facing** buttons that set the orientation of
  every selected tile in one click - placing a hundred racks no longer means
  a hundred rotate clicks - **Turn the selection** (a quarter turn
  clockwise as one piece, about its middle, each tile's facing turning with
  it; refused when the turned piece would not fit), **Set type…** and
  **Delete**.

The changes join the normal draft: nothing persists until **Save**, each
action is one [undo](#the-editor) step, and Esc or a plain click clears the
selection.

## Raised floors (Structure mode)

The **Walls and raised floors** tool (++w++, the Structure tab before 0.19)
models the room itself. Draw **raised-floor areas** -
rectangles of tiles standing on pedestals with a cable plenum underneath -
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
zones as grate/supply tiles instead of a flat tint - the cold-aisle read,
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

Areas are drawn with the same drag-a-rectangle gesture as tiles. A selected
one drags to move and has a handle on each corner and side to resize it, in
whole cells; its edges pull onto the other raised floors' edges, with a
guide line (++alt++ turns the pull off). A drop onto another raised floor
is refused - they may share edges, never overlap. The arrows move it a
cell, ++delete++ removes it, and its label, plenum depth and colour are in
the inspector. Raised floors save with the plan's **Save** and undo like
everything else.

## Walls & doors (Structure mode)

The same tool also draws the **room shell**: walls as polylines on the
same half-cell lattice trays snap to, so a wall can run along tile
boundaries or straight down a tile's centerline. Click **Draw wall**, click
corners (drawing magnetically snaps to existing walls, so rooms chain
cleanly), and double-click or press ++enter++ to finish - the wall joins
the plan's draft and its inspector opens. Or let a room draw its own:
[walls from a room's outline](#walls-from-a-rooms-outline).

A selected wall's inspector holds its numbers:

- **Label, color** - cosmetic; the default wall follows the theme.
- **Height (mm)** - blank means full height, i.e. the plan's ceiling.
  A half wall is just a wall with a height.
- **Thickness (mm)** - blank is the standard 100 mm. It draws true to
  scale on the plan, the PDF and in 3D. A new wall takes the thickness you
  last gave a wall in this browser.
- **Doors** - each door's width, height (blank is the standard 2100 mm)
  and **Swing**. Doors live *on* the wall (spans of a segment), so a wall
  and its doors always move - and save - together.

Walls are part of the plan's draft: every change below is an undo step and
goes with **Save**, in the same transaction as the tiles, with the same
[check for edits made elsewhere](#when-someone-else-saved-first).

### Walls from a room's outline

**Add walls around this** - on an area's floating toolbar and its
right-click menu - draws walls along the outline of a rectangle (turned or
not) or a polygon: one wall per unbroken stretch, joined at the corners, so
a free-standing room gets one closed wall. Ctrl/⌘-click more areas to pick
them together; the toolbar and the menu then offer **Add walls around these**,
and an edge two rooms share is walled once. A stretch of outline a wall
already runs along (in line with it, within a quarter of a cell) is left
out, so running it twice adds nothing. The corners land on the half-cell
lattice walls use. All of it is one undo step.

### Doors

With the **Door** tool (++d++), or **Add door** on a selected wall, drag
along a wall: the door snaps to it and its width shows beside the pointer in
centimetres or metres, from the plan's scale. A click without a drag makes a
standard 900 mm door there. A door stays inside its wall and clear of the
others. **Add door here** on a wall's right-click menu does the same at the
point.

Click a door to select it. Its handles:

| Handle | Does |
|---|---|
| The square at each end | Drag to resize it along the wall |
| The round one in the middle | Drag to slide it along the wall |
| The filled circle at the leaf | Click to flip the swing - hinge at the start or the end, opening to either side - as ++f++ does |

The plan draws a door's leaf and its swing arc; a door with **Swing** set to
*Opening* is a plain gap. Arrows slide a selected door 100 mm, ++delete++
removes it, and **Flip swing** and **Delete door** are on its toolbar and its
right-click menu. A wall made shorter keeps its doors inside it.

### Editing walls by mouse

A selected wall shows a round handle on each point and a square one in the
middle of each segment:

- **Drag the wall** to move the whole run.
- **Drag a point** to move it. Drop an end on another wall's end and the two
  become one wall.
- **Drag a segment's handle** to move that segment; the segments either side
  follow.
- **Double-click a segment** to split the wall there into two walls. A split
  never cuts a door.
- **Join** - Shift- or Ctrl/⌘-click two walls whose ends touch, then **Join
  walls** on the toolbar or the menu, or ++j++.
- Right-click a wall for **Add door here**, **Add bend here**, **Split here**,
  **Join walls** and **Delete wall**; right-click a point for **Remove point**.

Dragged points snap to the half-cell lattice and to other walls' points and
edges, and line up with their points along a dashed guide; ++alt++ keeps
them on the lattice alone. The arrows move a selected wall half a cell and
++delete++ removes it. Hovering a handle names what it does.

The 2D canvas draws walls in **every mode** - solid spans with a dashed
threshold and jamb ticks across each door gap - because the shell is
context whether you're placing tiles or pulling cable. The 3D room raises
the same geometry: solid runs, true door gaps, and a lintel over each
opening (none when a door reaches the wall top). The **Walls** toggle
(View menu, 3D) hides the shell when it blocks the view - it defaults on.

Walls are documentation geometry in this release: **walls do not affect
routing in v1**. A cable's route and length ignore them, exactly as they
did before walls existed.

## Cable trays (Cables mode)

The **Cable trays** tool (++c++, the Cables tab before 0.19) turns the plan into a
**buildable wiring drawing**. Draw **trays** - cable/conduit runs - as
polylines a contractor can follow, and assign the real DCIM cables that run
through each one. Hand the PNG to whoever's pulling cable.

- **Draw a tray**: Cables mode → **Draw** in the left rail → click grid
  points to route the run → double-click (or Enter) to finish, then name it.
  Esc cancels. Trays snap to a **half-cell lattice** (twice as fine as the
  tile grid), so you can lay two runs a half-cell apart and they read as
  distinct parallel trays.
- **Trays may overlap and cross** - unlike tiles, there's no no-stacking
  rule; one run can pass over another (route them on the fine lattice to
  keep both visible).
- **Assign cables**: select a tray → its inspector lists the cables in it,
  with **Add cable** (searches all cables) and a × to remove. The tray shows
  its cable count on the canvas and in the rail. It lists only the cables you
  may view; adding or removing one needs **change** on that cable, and the
  cables you cannot see stay in the tray when you save
  ([permissions](#tenancy-permissions-audit)).
- **Auto-route**: on a cable's page, the **Auto-route** button computes the
  best path through this plan's tray network (Dijkstra over segments,
  junctions and same-level crossings), stores it as the cable's
  [route on the plan](#stored-routes-and-lengths), assigns those trays to
  the cable, and works out its length by the tenant's
  [length rules](#lengths). A length a person entered is never overwritten
  (the API accepts `overwrite: true`); a blank or computed one is filled.
  Ends farther than ~6 cells from any tray come back *unreachable* rather
  than pretending a 20 m unsupported hop is a route.
  `POST /api/floor-plans/{id}/route/` previews a route between two objects
  without saving.
- **Capacity**: a tray may record how many cables it holds (`capacity`,
  blank when no limit is known).
- **Editing by mouse**: a selected tray takes the same handles as a
  [wall](#editing-walls-by-mouse) - drag it, a point or a segment; drop an
  end on another tray's end to join them (the joined tray keeps both trays'
  cables); double-click to split it (the new half carries the same cables);
  right-click for **Add bend here**, **Split here**, **Join trays** and
  **Delete tray**. Snapping, guides, ++alt++, the arrows and ++delete++ work
  as on walls. **Edit shape** still hides the cables and adds a ＋ on each
  segment for a bend.
- **Saving**: a tray's shape, name, kind, level, elevation and capacity go
  with the plan's **Save** and its undo; its **cables** are written as you
  add or remove them. A new tray takes cables once the plan is saved.

#### Routing a cable

Auto-route picks a path for you. The **Routing** card on a cable's own page is
the manual twin - and the answer to "what is this run actually set to
follow?", which nothing used to show:

- **Point-to-point** - the cable follows no tray and draws as a direct A↔B
  run. This is the default, and the usual reason a cable in the 3D room
  ignores a tray it visibly passes.
- **Through trays** - pick the ducts yourself, **as many as the run needs**,
  and order them with the arrows so the path reads the way the cable
  travels. Removing every tray puts it back to point-to-point.

Changes take effect immediately in the 2D canvas and the 3D room. Routing is
recorded **per floor plan**, so a cable that crosses plans keeps each plan's
assignment separately. `GET`/`PUT /api/cables/{id}/routing/?floor_plan=<id>`
is the same operation over the API; editing requires **change** on the cable.
When both ends are placed on the plan, a `PUT` also stores the route through
the trays named - in that order - or the direct run for an empty list, as
the cable's [stored route](#stored-routes-and-lengths); `GET` lists the
trays in the stored order, and both answer the stored `path` (null when
there is none). A length is never written by the routing card.
- **Level & elevation**: each tray records where it physically lives -
  **Overhead** (the default), **Underfloor**, or **Floor level** - plus an
  optional exact **elevation in mm**. Leave elevation blank and it derives
  from the level (overhead → ceiling − 300, underfloor → −300, floor → 0).
  This drives the tray's height in the 3D view and the vertical-drop term in
  route-length estimation.
- Trays render **above tiles** so the run is legible on the print, and they
  export with the PNG.
- Cables mode is edit-gated; viewers still see the trays.

### Connecting trays (junctions, T-splits, crossings)

Trays form a **network** - a cable assigned to several connected trays routes
through their junctions. There are three ways trays connect, and while drawing
the cursor **magnetically snaps** to nearby trays so the joins land exactly:

1. **End on another tray.** While drawing, move near an existing tray - the
   next point snaps onto its line or a vertex (within half a cell). Click
   there (or double-click to finish there) and the two trays share that point,
   so they're joined. This is the usual "branch off the main run" move.
2. **T-split.** Draw a branch that starts (or ends) on the middle of another
   tray - it snaps to that tray's line, creating a T-junction the cable can
   turn through.
3. **Crossing.** Two trays at the same level that simply cross each other
   are joined at the crossing automatically - no click needed. "The same
   level" means their elevations (set, or derived from the level) are within
   300 mm. An overhead ladder passing over an underfloor tray is **not** a
   junction: a cable cannot turn from one onto the other there, and a route
   that needs that turn comes back unreachable. To take a cable from one
   level to the other, end one tray on the other (1 or 2) - a snapped vertex
   is a drop and always joins.

**Editing a tray.** Select a tray (Cables mode) and drag its **body** to move
the run or a **vertex dot** to reshape - both snap to the grid and
magnetically to other trays (drag a vertex onto another tray to connect them).

For heavier reshaping - e.g. rerouting runs around something added in a
remodel - flip on **Edit trays** (the toggle at the top of the Cables rail).
It **hides all cables** so nothing blocks the trays, and every tray becomes
reshapeable. Click a tray to select it, then:

- **Drag any point** to move it.
- **Click a ＋** on a segment to **add a bend**, then drag it into place.
- **Right-click a point → Remove bend** to delete it.
- **Drag the body** to shift the whole run.

**Done editing trays** (or **Esc**) turns cables back on. Name / kind /
color / cables and delete stay in the inspector.

Tips:

- If a join doesn't take, zoom in and re-draw (or drag a vertex) *onto* the
  other tray until it snaps (the point sits exactly on the line).
- Draw parallel runs a **half-cell** apart so they stay visually distinct.
- Assign a cable to **every tray it passes through** (main run + each branch);
  the trace stitches them at the junctions and takes the branch toward the
  destination. If there's no tray between two points, the trace draws a
  straight line for that stretch.

*Assignment is manual for now - a cable belongs to the trays you put it in.
Auto-picking a cable's trays from its endpoints is the next phase.*

### Seeing cables A↔B (routed through the trays)

Turn on **Display → Cable links (A↔B)** and every cable on the plan draws
its **physical run**. Danbyte resolves each cable's terminations to its
devices, then to the tile holding that device (or the device's rack or
cabinet tile), and routes A→B along **the trays the cable is assigned to**:
it enters at the nearest tray point, follows the trays - **including
T-junctions and across several connected trays** - and squares off the
short hops between a tile and its tray. A cable with no trays (or whose
trays do not connect its ends) draws as an **orthogonal elbow** between its
two tiles, never a diagonal through other tiles.

**What shows a route:** any cable that's either routed through a tray here,
or has both ends placed on the plan (a device tile, or the device's rack or
cabinet tile). Only the cables you may view are drawn; a tray's label counts
the ones in it you may not (`T-03 · 12 · 2 hidden`).

**Assigning a cable to several trays** is how branching works: add the cable
to each tray it passes through (a main run plus a branch, say). The trace
stitches them at their junctions - including where two trays at the same
level **cross mid-run** - and takes the branch toward the destination.

#### Lanes and bundles

Cables that share a tray no longer draw on top of each other:

- **Lanes.** Each stretch of tray the runs share is split into parallel
  lanes inside the tray's width. The lanes are in one order everywhere
  (by cable label), so two cables keep their sides along the whole run
  instead of braiding. Cables between the same two tiles share one elbow,
  in lanes the same way.
- **Bundles.** Where the lanes would sit closer than a few pixels on
  screen, the stretch draws as **one thicker stroke with a count** (the
  squarish badge). Hover it to list its cables; **click it to fan them
  out** into lanes. **Display → Bundle parallel runs** (on by default)
  turns bundling off.

#### Colour, styles and the legend

**Display → Color cables by** colours every run from its data:

| Choice | A run's colour |
|---|---|
| **Status** (the default) | Its status's colour. |
| **Cable color** | The physical jacket colour recorded on the cable. |
| **Type** | A colour per cable type on this plan, handed out in legend order - the most common type first. Types have no catalog colour, so the legend says which is which. |

A cable with nothing to colour it by (no status, no jacket colour, no type)
draws in the muted foreground. A bundle takes its cables' colour when they
share one, else the muted foreground.

The line style says how the route is known:

| Style | Meaning |
|---|---|
| **Documented** - solid | A route stored for the cable on this plan. |
| **Planned** - long dash | The cable's status is marked **Planned** (Statuses → *Planned*). |
| **Inferred** - thin, lighter | Worked out from the cable's trays, or straight between its tiles; nothing stored. |
| **Preview** - dotted | A route being proposed, not saved. |
| **Out of date** - with a warning mark | A stored route whose end tile has since moved, whose device now stands elsewhere, or whose tray changed. |

A cable with a [stored route](#stored-routes-and-lengths) draws that route,
documented; a cable without one keeps drawing **inferred**. An out-of-date
route draws where it was stored, with an amber mark at each end whose tile
moved and a dashed line to where the tile is now; it reads out of date even
in a planned status. Previews draw only while
[Document routes](#document-routes) is open, over the plan's own runs.

The cables' **legend** sits in the plan's corner, under the
[Color by](#color-by) legend and inside the export area: the colours in use
(statuses as their pills, types and jacket colours as short lines), the
line styles in use, and the bundle.

#### Level of detail

Strokes keep **the same width on screen at every zoom**; what is drawn
follows how large a cell is on screen:

- **Far** (zoomed out): the trays with their cable counts only - plus a
  traced run.
- **Mid**: shared stretches as bundles with counts, single runs as lines,
  no labels.
- **Near** (zoomed in): every lane that fits apart, bundles only where the
  lanes still would not read, and - with **Display → Cable labels** on (the
  default) - each cable's label along its run where it does not collide
  with another. A hovered or traced run shows its route length and, up
  close, its device and port at each end.

The routes are worked out once per change of the plan's contents - a tile
moved, a tray reshaped, a tray's level changed - and then only for the
cables that change touches. Panning and zooming route nothing.

#### Hover, trace and the popover

**Hover a run** (or reach it with **Tab**) to raise it and open its
**popover**: the cable's label, status, type, both ends as `device · port`
(an end on a device you may not view reads **Hidden**), the cable's
**length** (marked *computed* when a route wrote it) and the **route
length** with the difference, and the trays it rides. For a stored route the
route length is the stored one, by the tenant's [length rules](#lengths),
marked *documented* or *out of date*; for an inferred run the plan works it
out (run × cell size, plus the drops between each end's rack top and its
tray, plus 10 % slack). Hover a bundle to list the cables in it.

**Click a run** (or **Enter**) to trace it and pin its popover, with
**Open cable**: the run is drawn heavier with a halo, and every other cable
**dims** so the route reads where several share a tray. Click it again,
click empty floor, or press **Esc** to clear. No Cables mode is needed - it
works in any mode while the links are on.

**Trace on map from a cable** - the **cable detail page** has a *Trace on
map* button that jumps to the plan showing that cable, with its route already
highlighted and the view fitted to it. The **rack/device deep-view** (click a
rack or device tile) shows each device's end-to-end paths: a ⟿ next to the
origin traces the **whole run** (all its cables, through patch panels), and
the ⟿ on a single cable segment traces just that cable. Both close the panel,
highlight on the plan, and fit the view.

**Right-click** anywhere on the plan for a quick menu - *Trace cables here*
(highlight every run touching a tile), *Open*, *Fit to view*, *Clear trace*.

**Where things live:** patch panels are rack-mounted, so they stay *inside
their rack* (their runs trace from the rack tile) - only floor-level things
like **drops (wall plates)** and the equipment they serve (a printer, an AP)
are placed as their own tiles.

Trays render as a **subtle gray channel** (recolor per tray) with no solid
centerline, so the lanes read as running *inside* the tray.

**Display → Cable trays** hides/shows the tray layer itself - look at just the
cable runs, just the trays, or both.

### Stored routes and lengths

A cable's **route** on a plan can be stored: where it runs, the trays it
rides in the order it travels them, and how long it is. A stored route is
the documentation - it draws **documented** and its length is the one the
popover shows - while a cable without one keeps drawing inferred from its
trays. One route per cable per plan; a cable that crosses plans has one on
each.

A route is worked out on the server (`api/cable_routing.py`), the same way
for Auto-route, the Routing card, Document routes and the API:

- **Ends.** Each end resolves to a tile on the plan - the device's own tile,
  else its rack's or cabinet's - and a **port height**: a racked device at
  the middle of its rack units (plinth + U position × 44.45 mm), a rack's
  device with no position at the rack's top, and a device on its own tile or
  in a cabinet at the tenant's **standalone port height**.
- **Path.** Through the plan's trays (junctions, T-splits and same-level
  crossings, as [above](#connecting-trays-junctions-t-splits-crossings)),
  else a **direct** orthogonal run between the two tiles. A breakout cable
  has one leg per far tile; its length is its longest leg's.
- **What is stored.** Per leg: the tile at each end and its centre then, the
  centreline, each tray with the point the run enters and leaves it by and
  its elevation, and the free points of a hand-drawn run. With it: the trays
  in travel order, the length breakdown (run, the drop at each end, level
  changes and service loops, slack, total) and when it was worked out. The
  cable's trays on the plan are kept in step with the trays the route rides.

#### Lengths

```
length = run along the path (cells × cell size)
       + drop A + drop B      (port height ↔ first and last tray)
       + level changes        (between trays at different heights)
       + service loop × 2
       then + slack %, rounded up to the step
```

The rules are this tenant's, under **Settings → Floor plans → Cable
lengths**:

| Setting | Default | |
|---|---|---|
| **Slack** | 10 % | Added for dressing and termination. |
| **Service loop** | 0 mm | Left coiled at each end. |
| **Round up to** | 500 mm | Lengths round up to a multiple of this; 0 rounds to the millimetre. |
| **Standalone port height** | 0 mm | Ports of a device on its own tile or in a cabinet. |

A run with no tray stays at the ports' height and climbs only between them.
Lengths are as right as the plan's scale: with a CAD drawing whose scale
was never set (`scale_source` *assumed*), Document routes warns
*Drawing not calibrated - lengths may be wrong*.

**Where a length came from.** A cable's `length_source` is `""` for a length
a person entered (or imported) and `computed` for one a route wrote. A
computed length is written only where the length is blank or was computed
before; replacing a length a person entered takes an explicit tick
(**Replace measured length**) or `replace_length` / `overwrite` in the API.
Editing a cable's length on its page or through `/api/cables/` makes it
entered again. The value is written in the cable's own unit.

#### Out-of-date routes

A stored route goes **out of date** when:

- a tile it ends on is moved, resized or removed (in the editor, through the
  API, anywhere);
- a tray it rides is reshaped, raised or lowered, or deleted, or the cable is
  taken out of it;
- a device it ends on now stands in another rack or cabinet, or on another
  tile.

It keeps drawing where it was, marked out of date, until it is routed again
(Document routes ticks it by default). Moving a tile never rewrites a route
on its own. In the editor a route reads out of date as soon as the draft
moves its tile or reshapes, re-levels or deletes a tray it rides - before
Save.

#### Re-routing after a move

When a finished edit moves a tile that stored routes end on - a drag (once
the pointer lifts), an arrow-key nudge, an align, a room moved with its
tiles - or reshapes, re-levels or deletes a tray they ride, the editor asks
**Update N routes?** over the plan, in the After placing card's place. It
asks only when that edit put a stored route out of date; a tile with no
stored routes asks nothing. Nothing changes until you choose:

- **Review** opens the **Update routes** panel - the
  [Route cables](#after-placing-route-the-cables) panel for those cables,
  worked out against the draft as it stands (the moved tiles, the trays as
  edited). Each row shows the new route and its length against the cable's
  stored length, or, without one, against the old route (`was 8.5 m
  (+2.4 m)`). Routes are ticked by default; a length is set where it is
  blank or computed, while a length a person entered needs its own
  **Replace measured length** tick. Pick trays, Suggest a run and Direct
  work as there.
- **Apply N routes** puts the ticked routes (and lengths) in the draft as
  part of the move: one **Undo** takes back the move and its new routes
  together, and **Redo** brings both back. Save writes them with the move.
- **×** declines: the routes stay as they were, drawn out of date, and can
  be routed later.

Undoing the move closes the prompt. A second move before answering adds its
routes to the same prompt.

The same panel opens from:

- an out-of-date route's popover - pin it (click) and press **Re-route**;
- **More → Update out-of-date routes…**, listing every route on the plan
  that is out of date - moved here, in DCIM, or by someone else - with the
  same preview and ticks. It is there only while a route is out of date,
  and works on the unsaved draft. Applying from either is an undo step of
  its own;
- **Back to the grid…** (Snap all to the grid), which moves tiles on the
  server: once the plan reloads, the prompt offers the routes it left out
  of date.

#### Document routes

**More → Document routes…** (editors; save the plan first) routes every
cable with both ends on this plan and lists them: the cable, the trays it
would ride (or *Direct*), the computed length and the stored one with the
difference. Every ticked route is drawn on the plan as a **preview**. Ticked
by default: routes that are new, out of date or different from the stored
one, and their length when it is blank or computed. A length a person
entered shows **Replace measured length**, unticked. **Save N routes**
stores the ticked ones in one save. A cable you may not change cannot be
ticked; cables you may not view are not listed.

#### After placing: route the cables

Placing a device, rack or cabinet (a drag, a click from the picker,
**Place N** or **Not placed**) shows the **After placing** card over the
plan: **Set room** when the object stands in another room's area, and
**Route N cables** when it has cables you may change whose far end stands on
this floor - a device's own tile, or the rack or cabinet holding it. A rack
or cabinet counts the cables of the devices in it; a cable between two of
them on one tile is left out. **Connect to…** plans new cables from what
was placed ([below](#connect-to-plan-new-cables)). Nothing changes until a
button is pressed; × dismisses the card.

**Route N cables** opens the **Route cables** panel. The routes are worked
out against the draft as it stands - unsaved tiles, moves, removals and
trays included - and every ticked one is drawn on the plan as a
**preview**. Per cable:

- the far end (device · port, or **Hidden** for a device you may not
  view), how it runs - the trays in order (`T-03 → T-07`), **Suggested
  run**, or **Direct** - and the computed length;
- the stored length with the difference, when it has one;
- a tick for the route, ticked by default, and one for the length:
  **Set length** (ticked) where it is blank or was computed, **Replace
  measured length** (unticked) where a person entered it.

The header shows the scale (`1 cell = 600 mm`) and, with a CAD drawing
whose scale was never set, *Drawing not calibrated - lengths may be wrong*;
lengths follow [the rules above](#lengths).

**No tray path.** A cable no tray connects gets a choice under its row:

- **Pick trays** - click trays on the plan in the order the cable travels
  them (a second click takes one away), **Done** to finish. Trays that do
  not join up show **Trays do not connect**, and the cable runs direct.
- **Suggest a run** - a run worked out on the half-cell lattice. The other
  tiles are in the way, and walls are too except at their doors. It follows
  existing trays where it can (a step along one costs less, so a run
  extends the network rather than running beside it), and turns cost extra,
  so runs come out straight. It runs underfloor when both ends stand on a
  raised floor and a run fits inside it, else overhead. Cables between the
  same two tiles share one run, and a later run follows an earlier one. A
  plan too big to search, or ends nothing gets through to, falls back to
  direct. **Suggest runs** above the list does this for every such cable.
- **Direct** (the default) - an orthogonal run between the two tiles,
  marked as estimated.

With a suggested run, **Keep as a tray** (on by default) adds it to the
draft as a new tray named `Run N`, the next free number, and routes the
cables through it - the next drop reuses it, and it is what gets built.
Untick it to keep the run as each cable's own path (**Suggested path**,
`manual`) with no tray.

**Leaves this floor** lists the cables whose far end is not on this floor;
they are not routed (risers between floors come later).

**Apply N routes** puts the ticked routes, their lengths and the kept runs
into the draft as one undo step; they draw on the plan until **Save** writes
them with the rest of the plan, and **Discard** drops them. A cable you may
not change cannot be ticked; cables you may not view are not listed.

#### Connect to…: plan new cables

**Connect to…** plans new cables from a placed device, rack or cabinet to
others on this floor. It is on the tile's [floating
toolbar](#the-floating-toolbar), its right-click menu and the **After
placing** card, for editors who may add cables.

- **Targets.** Click tiles on the plan (**Pick on plan** is on when the
  panel opens; a second click takes one back), or tick them in the list
  below, searchable, with the objects in the same room area first and then
  the nearest. A rack or cabinet stands for the devices in it. Objects you
  may not view, and devices that are not placed on this plan, are never
  offered.
- **What to connect.** **Network** (interfaces and patch-panel ports),
  **Console** or **Power**; **Cables each** (1-8) to every target device;
  **Management ports** to offer management-only interfaces too.
- **The proposal.** Danbyte pairs free ports only - no cable on them, not
  marked connected, not reserved, an interface enabled and physical - and
  only ports a direct cable may join: kinds a cable may join at all (as on
  the cable form), the same media (copper with copper, fibre with fibre or
  an empty transceiver cage, DAC with DAC or a cage, a cage with a cage of
  the same family - SFP or QSFP; a type that says nothing matches
  anything) and the same speed when both are known (from the interface
  type, else its speed).
- **Which ports first.** Between two switch-sized devices (8 or more
  physical interfaces) - an uplink - ports marked **Uplink** come first,
  then the faster ones, then the last ports by number. Otherwise the
  smaller device gives its fastest port and the switch its lowest free one,
  its uplinks last. The same choice gives the same pairs every time; a port
  is used once. Device pairs that got fewer cables than asked are listed
  with the reason (*No free ports*, *No compatible free ports*).
- **Review.** Each pair shows `device · port → device · port`, how it runs
  and its length. The pencil changes either port, from a list of that
  device's free ports that fit the other end; × drops the pair. The cables
  draw on the plan as **previews**, routed like existing cables - through
  the trays, or **Suggest runs** (kept as a tray by default) where no tray
  path serves. Patch-panel paths are not followed: these are direct cables.
- **The cables.** **Status** lists only statuses marked *Planned* that
  apply to cables, the first by default. With none, the panel says so and
  links to **Add one** - nothing is seeded. **Type** is *Suggested* by
  default (Cat6 for copper, a passive DAC for DAC and cages, Power for
  power; fibre is left to you), **Color** is the jacket colour. Cables
  have no label scheme to follow, so new ones are left unlabelled.

**Add N cables** puts the cables and their routes into the draft as one
undo step: they draw on the plan as planned runs (long dash) until **Save**
makes them, together with the rest of the plan, and **Discard** drops
them. Save makes every cable through the same checks as
[creating several cables](../dcim/cabling.md#many-at-once) - all or
nothing: a port cabled by someone else since, or a status that no longer
means planned, writes nothing and names the cable. Each route's length is
written to its cable as computed.

#### API

| Endpoint | |
|---|---|
| `GET /api/floor-plans/{id}/cable-paths/` | Each cable also carries `length_source` and `path`: its stored route (`id`, `kind` `trays`/`manual`/`direct`, `legs`, `tray_order`, `run_mm`, `drop_a_mm`, `drop_b_mm`, `extra_mm`, `slack_mm`, `length_mm`, `computed_at`, `stale`, `version`) or null. `stale` is true when the stored flag is set or an end's tile or device has moved since. A cable with a stored route here is listed even when nothing else would list it. |
| `GET /api/floor-plans/{id}/contents/` | Also lists `cable_paths`: the stored routes you may view, of cables you may view, each with its `cable` (on a view, those ending on a tile it shows, in its cells). Here `stale` is the stored flag only; their `updated_at` counts toward `version`. |
| `POST /api/floor-plans/{id}/cable-plan/` | A preview; nothing is stored. Body (each key optional): `cable_ids` (at most 256); else `objects` (`[{"kind": "device"\|"rack"\|"cabinet", "id"}]`, at most 64: what was just placed - every cable of their devices you may view, including those leaving the floor); else every cable you may view with both ends on the plan (`truncated` when there were more). The unsaved draft: `positions` (`{tile_id: {x, y, width?, height?}}`), `new_tiles` (`[{id, x, y, width, height, link_kind, link_id}]`, at most 256, linked to a device, rack or cabinet of the tenant), `removed_tiles` (ids), `draft_trays` (`[{id, points, level, elevation_mm?}]`, at most 64; one with a saved tray's id is that tray as the draft reshaped it) and `removed_trays` (ids of saved trays the draft deletes). A stored `path` riding a tray the draft changed reads `stale`. Routing: `tray_ids` (route through only those), `choices` (`{cable_id: {"via": "auto"\|"trays"\|"suggest"\|"direct", "tray_ids"?}}`), `suggest_runs` (suggest a run for every cable no tray path serves), `keep_runs` (default true: a run is a new tray; false: the cable's own path) and `run_level` (`overhead` or `underfloor`). Per cable: `route` (the computed route in the stored shape, or null with `reason`), `reachable`, `via` (`trays`, `suggest`, `direct`), `suggestions` (the run keys it uses), `path` (the stored one), `length`, `length_unit`, `length_source`, `cable_version`, `delta_mm`, `write_length` (whether a save would fill the length without replacing one a person entered) and `can_change`; with `objects` also `far` (the other end's `device_name` and `port`, or `hidden`) and `off_floor`. Plus `suggestions` (`[{key, level, elevation_mm, points, run, cable_ids}]`; `run` is the new tray's points, null when nothing new is needed), `cell_mm`, `scale_source` and `hidden_count`. Needs view on the plan. |
| `POST /api/floor-plans/{id}/cable-plan/` with `mode: "new"` | Connect to…: a preview of new cables; nothing is stored. Body: `source` and `targets` (`[{"kind": "device"\|"rack"\|"cabinet", "id"}]`, each at most 64; devices you may view and that are placed on this plan), `family` (`data`, `console`, `power`; default `data`), `per_target` (1-8, default 1), `include_mgmt`, `exclude_ports` (`[{kind, id}]` the draft's new cables take), the unsaved draft as above, and `choices` (by pair key), `suggest_runs`, `keep_runs`, `run_level`. Without `pairs` the server proposes; with `pairs` (`[{"key", "a": {kind, id}, "b": {kind, id}}]`, at most 256) it checks and routes those, each pair failing a check carrying `error`. Answers `pairs` (`[{key, a, b, type, route, via, suggestions, reason, error}]`, each port `{kind, id, name, device, device_name, type, media, connector, speed_mbps, uplink, mgmt_only, poe_mode}`), `short` (`[{a_device, b_device, made, reason}]`), `statuses` (the tenant's planned cable statuses), `can_add` (cable · add), `suggestions`, `cell_mm` and `scale_source`. Needs view on the plan. |
| `GET /api/floor-plans/{id}/cable-plan/ports/` | Connect to…'s port picker: `?device=<id>&family=&for=<kind>:<id>&include_mgmt=1&exclude=<kind>:<id>,...` - the device's free ports in the family, only those a direct cable may join to the `for` port when given. The device (and the `for` port's) must be the tenant's and one you may view. Answers `{"ports": [...]}`. |
| `POST /api/floor-plans/{id}/bulk/` | Also takes `cable_paths`: `{"upsert": [...], "delete": [cable ids or {"cable", "version"}]}`, in the same transaction, written after the tiles (so a route sees the tiles as saved), at most 256 upserts. An upsert is `{"cable", "legs"?, "kind"?, "tray_order"?, "version"?, "write_length"?, "replace_length"?, "cable_version"?}`: without `legs` the route is worked out on the server; with them (`[{"points": [[x, y], ...]}]`, one per far tile, each from its A tile's centre to its far tile's) they are checked against the plan and measured on the server - lengths, ends and tray spans are never taken from the payload, and every tray named must be this plan's. `version` is the stored route's, `cable_version` the cable's `updated_at` when a length is written: a change since answers **409** with `kind` `cable_path` or `cable`, and nothing is written. A save that carried `cable_paths` also answers `cable_paths`, the routes written. It also takes `trays`: `{"create": [{"key", "points", "level"?, "elevation_mm"?, "name"?, "kind"?, "color"?, "capacity"?}]}` (at most 64) - new trays, created before the routes, each needing tray `add`; a tray without a name is `Run N`. An upsert's `tray_order` may name a new tray by its `key`, and the answer carries `trays` (`[{key, id}]`). It also takes `cables`: `{"create": [{"key", "a", "b", "status_id", "type"?, "color"?, ...}]}` (at most 256) - new cables (Connect to…), each validated as `POST /api/cables/bulk-create/` validates it, in a status marked planned, made after the trays and before the routes, all or nothing (400 with `cables`, one error object per cable in order). It needs cable · add, and each cable's ends inside your cable grant's sites. An upsert's `cable` may name a new cable by its `key`; the answer carries `cables` (`[{key, id}]`). |
| `POST /api/cables/{id}/auto-route/` | Stores the route and answers its `path`. |
| `GET`/`PUT /api/cables/{id}/routing/` | Stores the route through the trays named; answers `path`. |

## Finding things

- **Find on plan…** (Layout mode, the bar under the header): type a tile's
  label, the rack, device, cabinet or panel it links, or its type or role,
  and pick a hit - the canvas pans and zooms to it. Every word must match, in
  any order (`r12 core`), and hits by name come before hits by type; ++enter++
  jumps to the first. Hidden tiles are not offered.
- **Fit to view** (the ⤢ button) recentres the whole plan after you've zoomed around.
- **Hover** any tile for a popover: name, type, status, a link straight to the
  linked object, and (racks) utilization / power / weight / device count / live
  monitoring state - for a cabinet, its devices and rails. **Click to pin** it - a pinned popover stays put so you can
  read it, follow its link, or hit *Contents & trace*; **Esc** or a click
  outside dismisses it. Which rows appear is configurable - see
  [Popover fields](#popover-fields). **Power** reads as the rack page reads
  it: demand over supply (`1.2 kW / 3.6 kW`), marked *nameplate* when no draw
  is recorded and *No feed* when no feed is. **Cooling** reads the same way:
  heat over cooling capacity, *No capacity* without one.
- **Objects** (header toggle) opens a side list of everything placed on the
  plan - the same Objects sidebar the [site map](site-map.md) and the
  [topology map](topology.md) open. Tiles fold into groups by **device role**
  and by **tile type** - a tile placed straight from its object under
  **Placed objects**, by the object's role - each headed by the role's or
  type's color badge with a
  count, and the down/degraded counts on the header even while it is folded.
  A tile with live monitoring carries its status pill. The *Search…* box
  covers each tile's label, linked object and type (Enter jumps to the first
  hit), the **All · Down · Degraded · Up** tabs narrow the list to one
  monitoring state, and a labelled tile shows its linked object's real name as
  a muted second line. Click a row to select and zoom to that tile. Editors'
  toggle state is saved with the plan. While the plan is
  [coloured by its racks](#color-by), the rack table under it lists the racks
  and the sidebar keeps the rest.
- **Hiding things** - the same eyes the [site map](site-map.md) and the
  [topology map](topology.md) have. Every group header in
  the Objects list (a device role, a tile type) and every tile row carries an
  eye: click it and that role, that type or that one tile leaves the plan -
  the 2D canvas, the 3D room and a cable whose end it was all follow, and the
  PNG export draws the plan as you see it. Hidden rows stay in the list,
  dimmed, so they can be brought back; a count and **Show all** sit at the top
  of the list, and a chip in the canvas corner says how many are hidden while
  the list is closed. A hidden tile cannot be selected, nudged or deleted
  until it is shown again. What is hidden is part of the plan (saved with its
  other view settings by anyone who can edit it), because "the plan without
  the old rack row" is part of how a plan is shaped for its readers; hiding
  never changes the plan's contents. Keyboard: ++h++ hides the selected
  tile(s); ++shift+h++ shows all.
- **Show on floor plan** - the Rack, Cabinet and Device detail pages carry a button
  that opens the plan zoomed onto the tile; placed on several plans (its own
  tile and its rack's, or a cloned what-if plan), the button becomes a menu
  listing them. The Rack and Device detail pages carry a button
  that jumps to where they're placed (a device falls back to *its rack's* or
  *its cabinet's* plan, marked "via rack" or "via cabinet").

!!! note "Changed in 0.17"
    The tile popover's **Power** row showed the allocated draw over the
    nameplate maximum (`1200/2000 W`). It now shows demand over the rack's
    supply, the figure the rack page shows, so the two agree, and the rack
    panel's heading (*Contents & trace*) reads the same figure. Large figures
    read in kW.

## Snapshots

A snapshot is a rectangle of a floor as a plan of its own: one room of a
hall, one cage, the corner a contractor needs. In Edit, the **Snapshot** tool
(++s++) drags the rectangle on whole cells; on release a dialog asks for:

- **Name**.
- **Goes to**: a **new floor plan** at the floor's location (site-wide
  when the floor is), or a **new floor** of this floor plan (on top of its
  floors).
- **Kind**: an **Independent copy**, or **Keep in sync (live view)**.

The snapshot opens. Its header carries a chip - **Copy of HQ · Floor 2 ·
30 Oct 2026** or **View of HQ · Floor 2** - linking back to the plan it was
taken of. On the floor-plan list a floor plan whose floors are all live
views reads **View of** its source next to its name.

### Of a room, location or area

A snapshot can also be taken of a **room, location or area** drawn on the
floor instead of a dragged rectangle:

- In Edit, right-click an area - or use its floating toolbar - and choose
  **Snapshot this room…** (**…location…**, **…area…**).
- After dragging a rectangle, the dialog's **Of** switches between **The
  drawn rectangle** and **A room, location or area**, picked from the floor's
  areas (shown as their colour badges).
- A room's or location's page: **Make snapshot…** on its
  [Floor plan tab](../dcim/rooms.md#floor-plan).

The crop is the area's bounding box in whole cells - a turned rectangle's or
a polygon's box - plus a **Margin** of whole cells on every side (0-50,
default 0), inside the floor. The name starts as the area's. Only saved areas
are offered; save the plan first after drawing one.

Both kinds work. A **copy** is made of that rectangle as any copy is. A **live
view** remembers the area and **follows it**: move, resize or turn the room
and the view's rectangle moves with it - its grid grows or shrinks to the
area's new box. The rectangle is worked out from the area each time the view
is read, not stored and kept up to date, so it follows a change made
anywhere - the editor, the areas API, a view, an import - and can never fall
behind. Through the view itself the area, like any row, stays inside the
view's rectangle - to grow it past the margin, change it on the source.
Deleting the area leaves the view showing the rectangle the area last gave
it. **Unlink** forgets the area.

In a view that follows an area, everything outside the area's outline is
**dimmed**: a turned or polygon room reads as the room inside its box. The
canvas draws the dimming (so its PNG carries it); the PDF export draws the
whole rectangle.

### Independent copy

A plan of its own with the same cell size, ceiling, layout (grid or free)
and display settings, its grid the size of the rectangle. Everything inside
the rectangle is copied and moved so the rectangle's corner is the new
plan's origin: tiles (with their rack, device, cabinet or other links),
rooms, areas, labels, walls (with their doors), cable trays (geometry only,
as a [clone](#cloning-a-plan) copies them) and raised floors.

What crosses the rectangle's edge is cut where its shape allows it:

| Crossing the edge | Copied |
|---|---|
| Unlinked tile at a quarter turn, raised floor, upright room or area | Cut to the rectangle |
| Polygon area | Cut to the rectangle |
| Wall, cable tray | Cut where it crosses; a part that leaves and comes back becomes two runs (a tray's second run is named `<name> (2)`). A door is kept when it lies wholly inside |
| Linked tile, tile at any other angle, turned area, label | Copied whole, past the edge, and listed after the copy is made |

A linked tile keeps its link, so the rack or device then stands on two
plans: the Place picker and **Not placed** show both (**On this floor +1**).

The background image is cut to the rectangle's share of the image. A CAD
drawing is copied with its file (as Clone does) and rendered again for the
rectangle's part only - shapes that miss it are left out, shapes on its edge
are clipped where they are drawn - by the same background job, sandbox,
limits and caps as an upload. Its placement, units, calibration, layers and
**Reprocess** work as for any drawing.

### Live view

A live view stores no objects of its own: it shows the plan it was taken of
inside the rectangle, as it is now. Change a rack there and the view shows
it; change it in the view and it changes there. There is one copy of every
object, so nothing has to be kept in sync and the two can never disagree.

- **Editing through a view** edits the source's objects: the same Save, the
  same [conflict check](#when-someone-else-saved-first) and the same change
  log, each entry noting **Through the view &lt;name&gt;**. It needs
  `floorplan · change` on the source as well as on the view, and reading a
  view needs view on both.
- An object crossing the view's edge is drawn cut at the edge, faded, and
  **locked** in the view: move or change it on the source. Nothing drawn or
  moved in the view may cross its edge.
- The view takes its cell size, ceiling, layout and background from the
  source: no background upload, grid size, cell size or free-placement
  switch of its own. Its name, floor, location and display settings are its
  own. A source that shrinks past the rectangle shows the part still inside
  it.
- Background: the source's image, cut to the rectangle as it is drawn. A
  CAD drawing is rendered on the server for the rectangle's part and kept;
  a new file, or reprocessing it, on the source renders it again.
- A snapshot of a live view is taken of its source.
- **Unlink…**, in the menu on the floor plan's name, turns a view into an
  independent copy of what it shows at that moment - the same plan, address
  and floor. It cannot be undone; the change log records it.
- Deleting a view leaves its source alone. **Deleting a plan that live views
  still show is refused**, naming the views: unlink or delete them first.
  The same holds for deleting the floor plan the source is a floor of.

### Snapshots API

| Call | |
|---|---|
| `POST /api/floor-plans/<id>/snapshot/` | `{"name", "crop": {"x", "y", "w", "h"}, "mode": "copy" \| "view", "target": "plan" \| "floor"}`. The crop is whole cells inside the plan. Answers the new plan (201) with `crossing` - the copied objects that crossed the edge, `{"kind", "id", "name"}`. Needs view on the plan and `floorplan · add`; `floor` needs add on its floor plan too. On a view, the crop is in the view's cells. In place of `crop`: `"area_id"` (a room, location or area on the plan you may view) and `"margin"` (whole cells, 0-50, default 0) - the crop is the area's bounding box in whole cells plus the margin, inside the plan (on a view: inside the view's rectangle, 400 when the area misses it). A `view` taken so follows the area. |
| `POST /api/floor-plans/<id>/unlink/` | A live view becomes an independent copy. Answers the plan with `crossing`. Needs change on the view and view on its source. |
| `DELETE /api/floor-plans/<id>/` | 409 while live views show the plan: `{"detail", "views": [{"id", "name"}]}`. `DELETE /api/floor-plan-stacks/<id>/` the same. |

A plan reads `kind` (`plan` or `view`) and `snapshot` - `null`, or `{"kind":
"copy" | "view", "source": {"id", "name", "stack"} | null, "crop", "at"}`,
and on a view `source_grid` (the source's grid, which its background image
spans). `source` is null when the source is gone or the reader may not view
it. A view's `crop` is the one it shows now; a view taken of an area also
reads `area` (`{"id", "name"}`, null once the area is gone), `margin` and
`mask` (the area's outline in the view's cells, null for other views). A view's `grid_width`, `grid_height`, `cell_mm`, `ceiling_mm`,
`layout_mode`, `background_image` and `background_opacity` are its source's,
at the rectangle's size; `PATCH` refuses changing them. A floor in a floor
plan's `floors` reads `kind` and `view_of` (`{"id", "name"}`).

On a view, everything that reads a plan's contents reads the source's rows
inside the rectangle in the view's cells - `contents/`, `state/`, `scene/`
(the 3D room, without the background image), `cable-paths/` (stored routes
translated to the view), `cable-plan/`, `route/`,
`placeable/` (**On this floor** is inside the rectangle) and `assign-rooms/`.
In `contents/` each row of a view carries `crosses_edge`. Writes:

- `bulk/` on a view takes rows in the view's cells and writes the source's;
  updates and deletes take only rows wholly inside the view (400 otherwise),
  every row written must stay inside it, and a 409's `current` rows are in
  the view's cells. Cable routes in `cable_paths` are in the view's cells
  too, stored on the source. `tiles/bulk/`, `snap-all/`, `background/` and the
  drawing's writes are refused on a view.
- The rows' own endpoints (`/api/floor-plan-tiles/`, `-areas/`, `-labels/`,
  `-walls/`, `-trays/`, `-raised-floors/`) take `?via=<view id>`, or a create
  whose `floor_plan_id` is the view: the body is in the view's cells, the
  row written is the source's, under the same rules, and the answer is in
  the view's cells. No row is ever stored on a view.
- `GET …/drawing/` on a view answers the source's drawing with the view's
  render: `clip` (its part, in drawing units), `rendered_url` once rendered
  (`status` `queued` until then), and its own `size`, `placement` and
  `transform_mm`. `…/drawing/render/` on a view renders that part with
  layers left out.

A drawing record reads `clip`: the part of the file it renders, or `null`.

## Cloning a plan

**Clone this floor**, in the menu on the floor plan's name, copies the floor
on screen with everything drawn on it - tiles (with their rack / device /
panel links), cable trays (geometry only; the cables routed through the
originals stay where they are), raised-floor areas, walls, rooms, areas
and labels, its layout (grid or free), and its
[CAD drawing](#cad-drawings) with its placement, units and calibration - into
the same location (or, for a site-wide plan, site-wide at the same site) as
`<name> copy`, a floor plan of its own, and opens it.
Handy for a what-if layout you can throw away; **Move to floor plan…** makes
it a floor of another floor plan. `POST /api/floor-plans/<id>/clone/` does
the same. Needs the floor-plan add permission.

## Export

**Export** in the bar under the header has **PNG**, **PDF…** and **Print**.

**PNG** exports the current view, theme-aware, at 2× resolution - same as the
topology map and rack elevation exports. Trays and their labels are included,
so the export doubles as the builder's pull sheet. The [Color by](#color-by)
legend and the cables' legend are part of the picture too, so a coloured plan
explains itself on paper. The cables come out as the screen draws them at
that zoom - lanes, bundles, colours and styles.

**PDF…** asks for the paper - **A4**, **A3**, **Letter** or **Tabloid**,
portrait or landscape (A3 landscape until you choose) - and makes one sheet
on the server:

- the whole plan **fitted to the page** - tiles, zones, raised floors, walls,
  trays, rooms, areas and labels as the plan shows them, unsaved edits and hidden tiles included
  as on screen, in the light theme;
- the **cables**, when the links are on: the same lanes, bundles, colours
  and line styles as the screen, at the paper's scale. The level of detail
  comes from the paper - under 10 mm a cell (a 1:200 A3, say) shared
  stretches print as bundles with counts; above it every lane that is
  0.6 mm apart prints, with labels. A traced run prints as a static heavier
  stroke; preview and out-of-date marks are left out;
- the [CAD drawing](#cad-drawings) under it **in vector**, at its placement
  and opacity, with the layers and text the plan hides left out. A drawing
  over 60,000 shapes on paper is refused - hide some of its layers first. If
  its text is too long to typeset, the text is left out and the sheet says
  so;
- a footer with a **scale bar** worked out from the plan's cell size (with
  the ratio, `1:200`), the **Color by legend**, the **cables' legend**
  (their colours, then the line styles), the **Areas** legend (the
  [area types](#area-types) in use, with their patterns), the drawing's
  source file,
  and a **title block**: the plan, its location, site and tenant, the date,
  the Danbyte version and the page.

**Print** makes the same PDF on the paper last chosen (the menu shows it) and
opens it in the browser's viewer to print. The PDF obeys the same limits as
the [topology PDF](topology.md): one at a time per user, a few at a time on
the server, and 30 seconds of rendering. Anyone who can view the plan can
export it: `POST /api/floor-plans/{id}/export/pdf/` with the plan's SVG, the
paper, the legend, `cable_legend` and `area_legend` (rows of `label` and
`color`, a line row adding `line`: `solid`, `dashed`, `thin` or `bundle`, an
area row `pattern`: `solid`, `hatched`, `crosshatched` or `dotted`;
`?print=1` for a five-minute print link).

## Tenancy, permissions, audit

Plans, tiles, and tile types are tenant-scoped like everything else; links are
validated against the active tenant. RBAC object types: **Floor plans**
(`floorplan`, the plan and its tiles) and **Floor tile types**
(`floortiletype`, the palette). All three models are audited - every tile
create/move/delete lands in the [change log](change-log.md). A floor plan's
floors (the stack, **Floor plan stacks** in the change log and the search)
are audited too, but follow the `floorplan` permission and its site scope:
viewing, adding floors, ordering, moving, merging and deleting each need the
matching `floorplan` action, on the floor plans and floors involved. Every
floor in a move or merge stays at the same site and tenant; a site-limited
editor works only on the floor plans at their sites. Site scope keys on
the floor plan's own **site**, so a site-limited user sees and edits the
site-wide floor plans of their sites, and everything drawn on them, and
none of another site's. A plan's CAD
drawing is audited too (**Floor-plan drawings**), but its endpoints and files
follow the plan's own permission; its files are served only to someone who
may view the plan, in its tenant, are deleted with it, and are part of a
media backup.

Rooms, areas and labels drawn on a plan are their own types, **Floor-plan
areas** (`floorplanarea`) and **Floor-plan labels** (`floorplanlabel`):
scoped through their plan's tenant and its site, audited one row
at a time, and in a site role's types like the plan's walls. Reading them in
`contents/` follows their own view grant; the editor's **Save** (`bulk/`)
needs `floorplan · change`. [Area types](#area-types) (`areatype`) are a
tenant-wide catalog like location types: site roles read them, only a
tenant-wide grant adds, changes or deletes them, and an area names one only
of its own tenant.

A [snapshot](#snapshots) follows the floor plan's rules: making one needs
view on the plan and `floorplan · add`, and it stays at the plan's site and
tenant. A live view is read and written with the grants of both the view
and the plan it shows, and every edit through it is audited on the source's
objects; making and unlinking one are in the change log.

Placing reads and writes the objects themselves under their own grants:
the Place picker (`placeable/`) needs view on the plan and lists each kind -
devices, racks, cabinets - by that kind's view grant and site scope; a
tile's photo shows only to someone who may view its device or rack; and a
room set from the prompt or **Set rooms from areas** needs `change` on
each object and is audited on it.

A tile can link another site's device, rack, cabinet, power panel, power
feed, cooling source or floor plan. To someone who may view the tile but
not that object, the tile keeps its place and size and names nothing of
the object:

- Its `linked` reads `{"kind": "device", "id": null, "name": "Hidden",
  "hidden": true}`, with no route, room, role or photo. This applies in
  `contents/`, the tile list and detail, a save's answer (`bulk/`,
  `tiles/bulk/`, `snap-all/`) and so the PNG and PDF exports.
- The editor draws it as a plain tile named **Hidden**. It can be moved,
  relabelled, relinked or unlinked, but not opened, traced or placed by.
- `scene/` (the 3D room) gives it `hidden: true`, `device_name` *Hidden*,
  no rack or cabinet and no role colour, and draws a rack's devices only
  when you may view them.
- `state/` (the live overlay) leaves it out, and a `snap-all/` collision
  calls it *Hidden*.

Linking writes the same rule: `link_id` must be an object you may view, or
it is refused as unknown. A save that sends a tile's own `link_kind` with no
`link_id` keeps its link, which is how the editor saves a Hidden tile.

Cables on a plan follow the cable grant, as `/api/cables/` does: the tenant,
the grant's constraints and its sites (a site-limited cable grant covers a
cable only when every end is at its sites). A site viewer role holds no cable
grant, so it sees the trays but no cables. Where a plan names cables:

- `GET /api/floor-plans/{id}/cable-paths/` (the A↔B runs, the trace, the 3D
  room and what the PNG and PDF draw) lists only the cables you may view, and
  `hidden_count` counts the others. Each run carries its `status` (`id`,
  `name`, `color`, `text_color`, `is_planned`), `type` and `type_display`,
  `length` and `length_unit`, its end tiles, `a_top_mm` / `b_top_mm` (an end
  rack's top above the floor, else 0) and its trays. An end names its
  `device`, `device_name` and `port`; an end on a device you may not view
  keeps its tile but reads `{"device": null, "port": null, "hidden": true}`;
  ends on tiles you may not view are left out.
- A tray's `cables`, in its own API and in `contents/`, lists only the cables
  you may view; `hidden_cable_count` counts the others. In `scene/`, a tray's
  `cable_count` counts the cables you may view and `hidden_cable_count` the
  others.
- Writing a tray's `cable_ids` sets the cables you can see: the ones you
  cannot see stay in the tray. A cable you may not view answers as unknown,
  and each cable added or removed needs **change** on that cable, else the
  save is refused with a `cable_ids` error naming it. Superusers set the
  whole list.

A cable's [stored route](#stored-routes-and-lengths) on a plan is its own
type, **Floor-plan cable paths** (`floorplancablepath`): scoped through its
plan's tenant and site, in a site role's types like the plan's trays, and
audited one row at a time (a path's going out of date is not an edit and is
not logged). Reading one needs view on it and on its cable - a cable you may
not view shows no route and is counted hidden. Saving one through `bulk/`
needs `floorplan · change`, **change** on the cable (else 403, nothing
written), and add, change or delete on the path; a cable you may not view
answers as unknown. A length a route writes is audited as an edit of the
cable. `auto-route/` and `routing/` store routes as edits of the cable, on a
plan you may view. A live view reads and writes the source's routes in the
view's cells; a copy snapshot or a clone copies no routes.

## Popover fields

**Settings → Floor plans → Tile popover** picks which rows the tile popover
shows, and in what order. A field with nothing to say for a given tile is skipped
automatically - no rack utilization on a wall tile - so turning one on is safe
everywhere. A cabinet has no units to fill, so on its tile **Utilization**
reads as its devices and rails; **Rails** shows the rail count on its own, and
the cabinet's custom fields can be picked like a rack's.

**Cooling** (off by default) gives a rack tile's heat over its cooling
capacity, from the 30-second poll like **Power** - see
[Cooling](cooling.md).

A tile linked to a cooling source shows the source itself - its type,
status, rated capacity and the heat of the racks it feeds against that
rating - whatever fields are picked.

**Ports** (off by default) gives a rack tile's ports in use over its counted
ports, and its **panel ports** under them when it has any - the split the
racks list and the rack page show - each opening **Port utilization** on the
rack. It reads the plan's racks, asked for once for the whole plan while the
field is on (or the plan is [coloured by its racks](#color-by)), never per
tile and never on the 30-second poll.

### Showing the device's panel {#faceplate-field}

Tick **Faceplate** (on by default) to draw a device-linked tile's front panel
in its popover - what the box actually looks like, without opening its page. It
uses the type's photo with its mapped ports when there are any, the plain
uploaded photo when the type has a picture but no ports mapped on that side,
and the drawn panel otherwise, and offers a **rear** toggle when the type has a rear
image.

It applies to tiles linked to a **device**; a rack tile has an elevation rather
than a faceplate, so the row is skipped there. Unlike the other rows, this one
fetches the device's ports when the popover opens - which is why it is **off by
default**: the standard popover answers entirely from data the plan has already
loaded.

The card is scoped. **Deployment default** is the list every tenant starts
from; **This tenant** carries its own once you switch the card off inheriting,
seeded from what it was inheriting so you edit the current look rather than a
blank slate. Per-tile-type lists are supported too - pick a tile type or device
role on the left and **Override**; a type **without** its own list inherits the
global one, so the two can't drift apart as you change the default.

## Roadmap

Planned next: cable traces drawn **on** the plan with "show on map", and
wall-plate ("drop") tiles with port assignments.

!!! note "New in 0.18"
    PDF export with the CAD drawing in vector, undo and redo in the editor,
    moving and turning a multi-selection, and Shift-click to select.

!!! note "New in 0.19"
    View and Edit, the tool rail, rooms, areas and labels drawn on a floor,
    free placement, the Place picker with rooms near the pointer, devices in
    their role's look or as their photo, a save that asks before it
    overwrites someone else's change, and snapshots: a rectangle of a floor
    as an independent copy or a live view.
