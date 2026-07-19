---
icon: lucide/map
---

# Site map

**Organization → Site map** shows your estate on a real world map — the
geographic analog of a [floor plan](floor-plans.md). Every site with
coordinates gets a labelled marker (with its device count); devices that carry
their own GPS coordinates appear as small dots colored by role. Click a marker
for a popup with counts and a jump-off to the site or device page.

## What's on the map

- **Sites** — labelled markers with a device count **and a health ring**: the
  worst monitoring status across the site's device IPs (green/amber/red), so
  the map doubles as a NOC view.
- **Devices** — any device with GPS coordinates, role-colored, with the same
  health ring. Camera-ish devices (roles with *has FOV*) render a
  **field-of-view cone** — direction, angle, and reach in meters, or a full
  PTZ coverage ring — edited with live preview from the sidebar inspector.
- **Free markers** — anything else worth pinning (generators, gates, masts):
  markers typed by your own **floor tile types and device roles** (zero
  pre-filled vocabulary), placed by arming a type in the edit sidebar and
  clicking the map (it stays armed for stamping several). Camera-ish types
  get cones too.
- **Connections** — site-to-site links drawn as arcs, **derived from what you
  already model**, never a separate schema:
    - *circuits* whose A and Z terminations land on two placed sites
      (colored by circuit type, then status);
    - *tunnels*, resolved termination → interface → device → site — two
      sites make an edge, a hub termination makes a star to its spokes;
    - *cross-site cables* (dark fiber), aggregated per site pair — a bundle
      is one arc with a count.
  Hover thickens an arc; click opens its popover (provider, rates,
  encapsulation, member cables) with jump-offs to both sites and the object.
  Each kind respects its own view permission.

## The layout — the floor planner, on a map

The page is a clone of the floor-plan editor's shell:

- **Header** — View / Edit tabs, a *Find on map…* search (sites, devices,
  markers — jump + select), **Fit to view**, the **Satellite** toggle, the
  **Objects** sidebar toggle, and a **View** menu (Sites / Devices / Links
  layers + camera FOV cones).
- **Left palette rail** (Edit mode) — tabbed **Sites / Markers**, exactly
  like the plan's palette: click to arm, then click the map. Marker types
  stay armed so you can stamp several; Esc disarms. Stamping a marker opens
  a small dialog asking for a name and an optional **device link** — role
  markers open the picker pre-filtered to that role. Both are skippable; an
  unnamed marker displays its linked device's name, then its type name.
- **Right inspector** — opens when something is selected. Sites show health,
  counts, and floor-plan jump-offs; devices show badges, the front image,
  and the FOV sliders; markers are edited here (label, description, linked
  device, FOV, delete); links show their endpoints and metadata.
- **"On this map"** (Objects) — the far-right objects sidebar: one search
  box over foldable groups — sites, devices by role, markers, and links
  grouped by kind. Click a row to fly to it.

Placed markers are fully editable from the inspector: rename, describe,
link/unlink a device, tune FOV, or delete (or press Delete in Edit mode).

## The map elsewhere — the Map widget

The same live OSM map (real tiles, your sites/devices, cables, and connection
arcs) is reused as a compact **MiniMap** wherever a map helps:

- an opt-in **Map** dashboard widget (Add widget → *Map*) with an "Open map →"
  corner link;
- a collapsible strip above the **Circuits** table;
- an **"On the map"** locator on each site's overview (that site highlighted,
  only its connections drawn);
- a **Location** card on each placed device's page — the device centered, with
  **Site map** and **Floor plan** jump-off buttons.

Markers are clickable everywhere (site → site page, device → device page).

Devices and free markers render as the floor-planner's **badge squares**
(the role/type colour, icon or centred dot) rather than plain pins; the
**selected** one gets a primary-coloured ring so it's obvious what you
clicked.

## Deferred (documented, not forgotten)

Multipoint L2VPN / peer-mesh tunnels as mesh overlays, a wireless
point-to-point link model, configurable popover fields (the floorplan's
registry), and antimeridian-aware arcs.

## What used to be here

- **Sites** — labelled markers with a device count. Click one for a popover
  with its counts, direct links into its **floor plans** (the map → floor
  plan drill-down), and a jump to the site page.
- **Devices** — any device with GPS coordinates: outdoor APs, cameras,
  gateways, roadside cabinets. Dots are colored by the device's role, with a
  popover showing status, role, hardware type, its site, and (in edit mode)
  a *Remove from map* action. Toggle the **Sites** / **Devices** layers in
  the toolbar.

## Placing things

Sites get coordinates two ways:

- **On the map** — switch the header tabs to **Edit**. The palette rail
  lists sites not yet placed: pick one, click its spot, done. Already-placed
  pins become draggable. Every change saves immediately (and lands in the
  change log — you need `site.change` for what you move).
- **In the form** — Site and Device forms both accept decimal-degree
  *Latitude* / *Longitude*, for pasting coordinates from elsewhere.

Devices appear on the map through their coordinates (set them on the device
form, or stamp a role marker and link the device from the placement dialog);
dragging a placed device or removing it from the map needs `device.change`.

Danbyte never geocodes addresses — there's no lookup of your street addresses
against an external service. You place things yourself.

## Cabling on the map

Every cable whose two ends land on the map draws as a line — you don't need
to draw a route first. A cable follows its route's geometry if it has one,
otherwise it's a gentle dashed curve between the two devices (bundles fan out
so you can tell them apart).

Click a device to open its inspector:

- **Cabling** lists every end-to-end run through the device (panels and
  splitters crossed). The **⤳ trace** button on a run lights that whole path
  on the map and fits the view; clicking any cable line toggles its highlight.
- **Ports** lists the device's interfaces and front/rear ports, each showing
  a coloured dot when cabled or a **＋ Connect** when empty. Connect opens the
  cable form seeded with that port as the A-side — the fastest way to wire
  fibre straight from the map; the new cable appears the instant you save.

The device popover shows a cable count and a **Trace** shortcut.

## Cables mode — routes for the outside plant

The header's **Cables** tab (editors only) is the floor planner's tray editor,
geographic. **Draw** a route by clicking waypoints along the duct / aerial /
trench path (double-click or Enter to finish, Esc to cancel), name it, then
assign the physical cables right in the naming dialog (pick a cable and the
line you drew IS that cable's path — no duct required; the name and color
prefill from it) or later from the route inspector. Reshape
any time: drag a vertex, click a segment's **＋** to add a bend, right-click a
vertex to remove it.

Routes render in every mode as faint channels (toggle under **View → Cable
routes**); their assigned cables draw as thin colored lines *inside* the
channel, routed through the route graph between their endpoint sites. A cable
bundle whose members all follow real routes drops its abstract arc. Cable
detail pages gain **Show on site map** (`/site-map?trace=<cableId>`) once the
cable is routed. Routes are a registered RBAC type (`cableroute`) — users
without the grant see no plant geography.

For splice closures and PON splitters, see [fibre](../dcim/fiber.md).

## Satellite view

The header's **Satellite** button swaps the basemap to imagery —
**Esri World Imagery** by default (their attribution shown as required).
The choice is remembered per browser. A deployment can point the satellite
basemap elsewhere in **Settings → Deployment → Map tiles** (satellite URL +
attribution), same rules as the street tiles: https-only, `{z}`/`{x}`/`{y}`
placeholders, and the tile host must be allowed in the nginx CSP `img-src`
(the shipped config already allows `server.arcgisonline.com`).
If a basemap's tiles are CSP-blocked, the map shows a banner linking back to
this page instead of failing silently.

## Map tiles — read this before heavy use

The map background is raster tiles from a tile server. **By default that is
OpenStreetMap's standard tile service**, which is donated, donation-funded
infrastructure with a strict
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
Danbyte follows it:

- the required attribution (*© OpenStreetMap contributors*) is always shown
  on the map and is never hidden — leave it alone; it's a condition of use;
- a *Report a map issue* link is included, as the policy recommends;
- tiles are browser-cached per their HTTP headers, never bulk-downloaded;
- the browser sends a valid (origin-only) `Referer` with tile requests.

The default is fine for **light internal use** — a handful of operators
looking at a map. If your deployment is large, busy, or public-facing, the
policy expects you to use your own tile source: set **Settings → Deployment →
Map tiles** to any raster tile server (an `https://…/{z}/{x}/{y}.png`
template) — a commercial provider, or self-hosted tiles. Set the matching
attribution string; nearly every provider requires one.

!!! note "Content-Security-Policy"
    The bundled nginx config allows images from `tile.openstreetmap.org`
    (street map) **and** `server.arcgisonline.com` (the default satellite
    imagery). If you configure a different tile server for either basemap,
    add its origin to the `img-src` directive in
    `/etc/nginx/sites-available/danbyte.conf` (see the CSP line) and reload
    nginx — otherwise the browser blocks the tiles and the map shows a
    warning banner over a plain gray background.

    **Upgrading an existing install:** re-running the bundle's `install.sh`
    regenerates the nginx config with the current CSP automatically. The
    in-app updater can't edit nginx — after an in-app update, add whichever
    hosts are missing by hand (safe to re-run; it only adds what's absent):

    ```bash
    CONF=/etc/nginx/sites-available/danbyte.conf
    for host in https://tile.openstreetmap.org https://server.arcgisonline.com; do
      grep -q "$host" "$CONF" || \
        sudo sed -i "s|img-src 'self' data: blob:|img-src 'self' data: blob: $host|" "$CONF"
    done
    sudo nginx -t && sudo systemctl reload nginx
    ```

!!! note "Airgapped servers"
    Tiles are fetched by the **browser**, never by the Danbyte server — so an
    airgapped *server* is a non-issue: operators whose workstations have
    internet access see the full map. Only when the workstations themselves
    can't reach a tile server (a fully isolated network) does the map fall
    back to a plain background — markers, placement, and popups still work.
    For real tiles there, self-host a tile server on the isolated network and
    point the Map tiles setting at it.

## API

`GET /api/site-map/` returns the effective tile config plus the RBAC-scoped
sites (all of them — unplaced ones carry `null` coordinates so the edit panel
can offer them) and every device with coordinates. Site coordinates are plain
fields on the Site resource (`latitude` / `longitude`, decimal degrees), so
they're scriptable like everything else.
