---
icon: lucide/network
---

# Topology map

**DCIM → Topology** draws your network five ways, switched by the
**Diagram / Wiring / Hierarchy / Flat / Logical** tabs in the header:

- **Diagram** - a clean, printable network diagram: one solid card per
  device in its role's colour, with **Simple** and **Detailed** modes and a
  choice of line. See [Diagram view](#diagram-view).
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
  fixed-size chip (role color, name, status pill), parallel cables between
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
spine, status pill, type and primary IP, and one row per **cabled port** -
and every cable connects **port-to-port** on the cards, so you can follow
`asw1:Gi1/0/48 → core:Te1/1/1` visually instead of guessing which line is
which.

## Diagram view

The **Diagram** tab draws the map the way you would sketch it for a wiki
page or a change ticket: plain cards and lines, colour only where it means
something.

- **Cards** - each device is a solid rounded card filled with its **role's
  colour**, the name bold and centred at the top and a few quieter lines
  under it (by default its IP, loopback and serial - see
  [Card lines](#card-lines)). The text is black or white, whichever reads on
  that colour. A device whose role has no colour gets a plain grey card.
  Patch panels keep a dashed edge.
- **The pill** - at most one, inside the card's top-left corner: the
  monitoring pill (your tenant's name for *down* or *degraded*) while the
  device is down or degraded, else the lifecycle status pill when the card
  lists it. A card keeps room for its pill, so a device going down never
  resizes it or moves its lines.
- **Simple | Detailed** (beside the tabs):
    - **Simple** - compact cards. Every line leaving one side of a card
      starts at that side's midpoint, and the lines part right after it:
      each elbow turns off at its own depth, a lane apart. All the cables
      between two devices draw as one line with a count chip (`2x`, or the
      aggregates' names when they are one bundle). A line that is one
      cable carries its port names (see [Link labels](#link-labels)), on
      its own run once it has parted from the side's other lines.
    - **Detailed** - each cabled interface gets a small grey **nub** on the
      edge facing its far end, and each cable leaves its own nub - a LAG's
      members too, with the bundle's chip on the lines between. The
      interface name sits **on its own cable**, just past the nub (see
      [Link labels](#link-labels)), so names side by side can never be
      read as the neighbour's. Cards grow to fit their nubs; past 48 on
      one side they continue round the corner. The nubs on a side are
      ordered by where their cables turn, so the cables leaving one side
      nest instead of crossing on their way out.
- **Devices** (Display popover) - **Card** or **Photo**: each device drawn
  as its card, or as its type's front photo with every cable on the port it
  is plugged into; one device at a time from its right-click menu. See
  [Photo nodes](#photo-nodes).
- **Lines** (Display popover) - **Straight**, **Elbow**, **Bendy** or
  **Cyclical**, for the whole view or one link at a time; see
  [Line types](#line-types).
- **Breakout cables** - one cable whose one end is a single port and whose
  other end lands on several (a fan-out, as the cable's own page draws it)
  is drawn as **one cable**: a single nub for the shared port, one trunk out
  of it to a small dot where the cable splits, then one leg to each far
  port - its own nub and port name on the far card, legs to one card in
  lanes side by side. The trunk carries the cable's label and type
  (`TEST · cat5e`; on a trunk too short for it, the longest leg carries
  it). Hovering or clicking any part lights up and opens the whole cable.
  With Bendy lines, legs converging on one card end in a straight run long
  enough for their port names, one name to each gap between them; a leg
  bends nearer its split point or its port to keep clear of the cards it
  passes, and one no curve gets clear of goes round them as an elbow.
  In Simple the legs to one card fold into one, named by its first port in
  natural order and a count of the rest (`Ethernet1/3 +2`); hovering it
  lists them all, and the cable's panel has every pair. A `2x` count only
  ever counts separate cables between two devices (and a LAG's members) -
  never the legs of one cable. A cable with several ports at **both** ends
  (an MPO trunk broken out at each end) is drawn the same way from both:
  each end's ports meet at a split point of their own, a third of the way
  across the gap from its cards (the layout leaves the room), and one
  trunk joins the two - its ends are told apart by the cable end (A/B) each
  port is on.
  From a server that does not send the ends it stays one line per port
  pair.
- **Middle chips** (a bundle's count, a trunk's name) sit at the middle of
  their line, or the nearest spot along it (or just beside it) clear of the
  cards, the port names and the other lines; a chip with no free spot
  shows while its line is hovered.
- **Link labels** - the subnet on the middle chip, and each end's port name
  and address on the cable itself; see [Link labels](#link-labels).

Simple and Detailed share one arrangement: a card is placed by its centre,
so it stays put when Detailed grows it. The automatic layout follows the
cables only - BGP sessions never move a card - and two devices of one role
that share a neighbour (a leaf pair on the same spines, an HA pair) sit on
one tier with their peer link between them. It leaves the tiers far enough
apart for the labels at both ends of a cable - a port name, then its
address - and a few lanes between; a map with no labels to show keeps
Simple's compact spacing. For clean role rows, set the [Levels](#levels-role-tiers). Drag a
card and its lines follow it straight away; when you drop it they are
routed, laned and labelled again (a breakout's split point moves with its
trunk). Zoomed out, the port names and addresses go first (the lines close
up behind them), then the chips and the card lines; hovering a line still
names it at any zoom.

The cards fetch their lines with the map (`include=card`), and the
monitoring states load whenever a card lists the monitoring pill - not only
with the sidebar open. The legend lists the roles on the map in their card
colours, and the monitoring pill when a card can show it.

### Card lines

What a card says under the device name is a short list of **card lines**,
top to bottom - by default the monitoring pill, **IP**, **Loopback** and
**Serial**. Admins choose them under **Settings → Topology → Card lines**:

- **All devices** - the list every device starts from.
- **A device role** - pick the role on the left (each is drawn as its
  colour badge) and **Override** to give it lines of its own; the role is
  then marked **Custom**. **Inherit** drops its list again.
- **This tenant / Deployment default** - a tenant uses the deployment's
  lines, shown read-only, until its switch is on; turning it on starts
  from the deployment's lists. The deployment tier needs a deployment
  admin.

The most specific list wins, and it replaces the ones below it rather
than adding to them:

1. the device's own list;
2. the saved view's list;
3. the device role's list;
4. All devices - the tenant's, or the deployment's while the tenant
   inherits;
5. the built-in default.

**Name only** is a real choice at every level, not "inherit": switch it on
and the card shows just the name, whatever the levels below say. Turning
it off puts back the list you had.

A list holds up to 8 entries. **Monitoring** and **Status** are the card's
pill rather than lines (at most one shows, monitoring first), so a card has
at most six lines, and a line with no value for a device is skipped. Device
custom fields can be lines too; hidden ones are not offered. **Restore
defaults** puts All devices back on the built-in list, which then follows
future releases. What each line prints is under
[Card lines API](#card-lines-api).

The page opens on one role with `?role=<slug>`, and on the deployment tier
with `?scope=deployment`.

**For one saved view** - the Diagram's **Display** popover has a **Card
lines** section, open to anyone who can see the map:

- **Inherit** previews the All devices list (and says how many roles have
  their own); each device still gets its role's lines.
- **Custom** gives the view one list for every card on it, over the role
  and All devices lists. **Add line** opens the picker; **Name only** works
  as above.

It is part of the map's document: every change is one undo step
(++ctrl+z++ / ++cmd+z++), marks the view **edited**, redraws the cards at
once, and is kept by **Save** like the rest of the view. On the default map
it stays in this browser.

**For one device** - its own list wins over everything else, on every map:

- On the Diagram, right-click a card for **Card lines…** (shown when you
  can change devices). **Inherit** shows what the device gets without a
  list of its own - this view's lines, else its role's, else All devices -
  and where they come from; **Custom** and **Name only** set its own.
  **Save** stores it on the device.
- The device's edit form has the same control under **Topology card**.
  There the preview shows the role's or All devices lines, since a saved
  view is not known on the form.

Admins also get **Role card lines** in the card's menu, which opens
**Settings → Topology** on that device's role.

### Line types

**Lines** in the Display popover sets the view's line, as icon tabs (hover
one for its name). LLDP ghosts stay straight and dashed; BGP sessions stay
the faint dotted overlay from card centre to card centre.

- **Straight** - the direct line; a card's side is still chosen so the line
  does not leave it straight into a neighbour.
- **Elbow** - right angles with rounded corners. Each cable runs straight
  out of its port far enough for its end labels before its first bend, and
  keeps clear of the cards it does not connect: a corridor with a card in
  it moves to the middle of the clear gap, and when no corridor between two
  cards is clear the cable steps round through a clear street. Cables
  sharing a corridor each get a **lane** of their own, 12 px apart, in the
  order that keeps them from crossing. In a tight gap the labels give way
  first (a cable keeps its lane and loses the name), and only then do the
  lanes close up.
- **Bendy** - a smooth curve that leaves each card square to its edge,
  reined in where it would sweep through a card and never overshooting the
  middle of the gap between two facing cards. Where a nub has labels the
  curve runs straight out of it far enough for them.
- **Cyclical** - an arc that loops round the cards between its two ends
  instead of crossing them, both ends leaving through the side it bulges to
  (the top of a row, say). In Detailed each end first runs straight out of
  its nub, square to the card, far enough for its labels, and then turns
  into the arc. It rises until it keeps 16 px clear of every card within its
  span; a longer arc goes round a shorter one it holds, at least 12 px
  outside it, and the arcs leaving one side of a card leave in that nesting
  order. As the view's line it arcs the links whose straight line would
  cross a card - cards of one row with others between, or a link that skips
  over a card on its way, even between cards that are not quite level - and
  draws the rest Bendy, as it does a link no arc gets clear for. It goes
  above (or left of) the cards unless the other side gives the lower arc.
  The arc is a draw.io curve, so every export draws the same one.

**One link's own line** - click a cable (or a bundle) and its panel has a
**Line** row: **Default** follows the view, the four line types pin this
link's own. A link's own Cyclical always arcs; between cards on no one row
or column it goes round whichever way - over their tops or past their sides
- is clear of the cards between. On a link drawn as an arc, **Flip the arc**
turns it over to the other side of the cards. The choice covers every cable
between the two devices, in Simple and Detailed alike, and is part of the
view like its arrangement: each change is one undo step, marks the view
**edited**, and is kept by **Save** (on the default map, in this browser).

### Link labels

**Labels** in the Display popover picks what the links carry - **Subnet**,
**IPs** and **Ports**, all on by default. The choice is part of the view,
and of the link (`labels=`).

- **Ports** - each cable's port name sits **on the cable**, which breaks for
  it: out of the nub the line runs a few pixels, stops for a small gap, the
  name, a gap, and runs on. So when many ports sit side by side, each name
  is plainly on its own cable. It reads along the line, turned to stay
  upright (a line within 10° of vertical reads bottom to top). In Detailed
  the name sits on the straight run out of its nub, and the planner makes
  that run long enough for it before the cable bends; in Simple a line that
  is one cable carries its names on its own run, once it has parted from
  the other lines leaving that side.
- **IPs** - each end's full address in the subnet the two ends share, the
  same way on the same cable, after its port name (a dual-stack end shows
  both, one after the other).
- **Subnet** - the shared subnet as the chip on the middle of the line
  (both, stacked, on a dual-stack link; under a bundle's count).

The gaps are the canvas's own colour, in the light and the dark theme, and
the page's white in every export. The gap is cut to the text's exact width,
so it stays even on both sides at every zoom; on a faded line (while another
is hovered) only the text fades, and the break stays. A hovered or selected
link's chip sits over its raised line. Which labels exist:

- Only a subnet both ends of a cable sit in counts, and only a link-sized
  one: /24 or smaller for IPv4, /64 or smaller for IPv6. A larger shared
  subnet is a LAN and gets no labels.
- A LAG's address, on the aggregate, is shown once. A breakout gets a
  subnet per leg (one that every leg shares goes on its trunk, once) and the
  shared port's addresses on its trunk.
- The addresses load with the map only while Subnet or IPs is on
  (`include=link_ips`), and only the ones you may see: without permission to
  view IP addresses - or with none recorded - there are no subnet or address
  labels, and no error. The cable's panel lists every address of each end,
  and the subnets they share.
- Labels are best effort: one with no free stretch of its line, clear of the
  cards, the other labels and the other lines, is left off (the nub's
  tooltip and the panel still name the port). With Ports off the cables
  carry no names.

### Photo nodes

**Devices ▸ Photo** in the Display popover draws each device as its device
type's **front photo**, with every cable landing on the port it is plugged
into - the picture you would take of the rack, wired up. **Card** is the
default. Right-click a device for **Show photo** or **Show card** to draw
just that one the other way; the choice is kept with the view (one undo
step, marks the view edited) and the view's own choice is in the link
(`face=photo`).

- **What it needs:** a front photo on the device type, with its
  [photo ports](../dcim/device-catalog.md#photo-ports) marked. Markers
  match the device's ports the way its faceplate matches them - the stack
  member number, a renamed port's marker key, then its name - and a
  device's own marker layout wins over its type's.
- **To scale:** every photo is drawn at one scale, a 19-inch device 480 px
  wide (a half-width type half that), at the photo's own proportions. The
  device's name is a caption under it, the status pill after it, with no
  card fill.
- **Cables on their ports:** a cable starts at its port's marker, runs
  straight up or down to the nearer edge of the photo (its lead, drawn over
  the photo), and from there is routed like any other line - elbows round
  the photos, the photo it leaves included, in their own lanes. The port a
  line lands on has a thin outline; the port name sits on the cable just
  past the photo's edge. This holds in **Simple** too: the photo is the
  detail, so each cable to a photo keeps its own port rather than meeting
  at the side's midpoint. Straight and Bendy lines keep their shape, so one
  can cross a photo where its port faces away from the far end - Elbow
  goes round.
- **The caption** sits at the left under the photo, or steps right to the
  first gap between the leads running down through it.
- **What stands in** (never artwork made up for the map):
    1. the photo with its port markers;
    2. the photo without a marker for a port - that cable lands on a short
       grey tab on the photo's top or bottom edge, facing its far end;
    3. no photo, but a schematic faceplate for the type - drawn on screen,
       its ports as those tabs (its drawing has no port positions to land
       on); a file draws it as the device's card;
    4. neither - the normal card.
- **Layout:** photos are wide and their cables leave up and down, so
  side-by-side photos keep room above and below them for the cables and
  their port names. **Tree** layout (Display ▸ Layout) often suits a
  photo map best. When devices change between card and photo, a map laid
  out automatically is laid out again; a saved arrangement keeps each
  device's centre, and whatever a photo now covers moves out of its way.
- **Performance:** photos load with the map only while some device shows
  one (`include=photo`). Far out - below 35% zoom on a map with 24 photos
  or more, 12% on a smaller one - each photo is drawn as a plain box.

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
- **The Diagram is built in the background** - its layout and line
  planning run in a web worker, so a big site never freezes the page: the
  map shows a muted *Loading...* while the first build runs, and keeps the
  last layout on screen (with *Loading...* at the top) while a new one is
  built after a change of mode, line or labels, or re-routed after a drag.
  Search dimming and the focused card are applied on the page and need no
  rebuild. The worker loads the app's own Inter font and measures text on
  an offscreen canvas, so its cards and labels are sized exactly as the
  page would size them; it waits for the font before the first layout, so
  a map opens as a *Re-layout* would draw it once fonts are loaded. A
  browser without workers (or one that fails to start it) builds on the
  page as before.
- **Diagram work is reused** - the Diagram ranks a map's devices once:
  switching Simple / Detailed, the line type or the labels lays the same
  cards out again without ranking them anew. A drag re-routes only the
  elbow lines whose way the moved card was, or now is, in, and a port name
  crowded off the start of a straight line jumps past whatever surely
  blocks it instead of trying every step. The picture is the same as a
  full re-plan; it just arrives sooner.
- **Layouts rank fast** - every view sorts its cards into ranks with the
  layout library's own network-simplex method, run on flat arrays: it makes
  the same choices, so every card lands exactly where it did, but a
  2,400-device site ranks in a fraction of a second instead of seconds.
- **A big minimap is one picture** - above 500 cards the minimap paints its
  cards on a single canvas instead of drawing each one as a shape; it
  looks, pans and zooms the same.
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

- **Cards** - the colored spine is the device's role color; the pill after
  the name is its lifecycle status, in that status's own color (the same pill
  as the device list). A long status name widens the card rather than
  squeezing the name. Clicking a card **spotlights** it - everything not
  directly cabled to it fades until you click empty canvas.
  **Double-clicking** a card opens its device page. Flat chips carry a small
  `N×` cabled-port count; Hierarchy headers show the primary IP. Patch panels get a dashed border. Port cells show
  the full port name. A cabled front port and its strand's rear port render as **one continuous
  row** (`front1 ⇄ rear`) - the cable enters on the left and leaves on the
  right, the way the light actually travels through a fiber panel.
- **Edges** - solid lines are cables; a **long-dashed** line is a collapsed
  end-to-end run (labelled `via <panel>…`); a short-dashed *italic* line is an
  **LLDP ghost** - SNMP saw the adjacency but no cable exists (click it to
  materialise one). On these tabs `×N` marks a breakout/trunk carrying N
  pairs; the Diagram tab draws a breakout as one trunk splitting into legs
  (see [Diagram view](#diagram-view)).
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

## Building a diagram

A map normally shows whatever its filters match. A diagram built by hand
shows exactly the devices you put on it, where you put them - "core row",
"customer X hand-off" - and keeps them there as the network grows around it.

**Start from a blank view.** The **New view** button (the page icon beside
the saved-views select) asks for a name and where to start:

- **Blank** - a view with no devices at all.
- **This map** - the devices the map shows now become the view's fixed set,
  arranged as they stand on the Diagram. Not offered for a map grouped by
  site or location, nor for more than 10,000 devices.

The new view opens on the Diagram tab with the device list open. It needs the
add permission on topology views.

**The device list.** **Devices** at the left of the second bar opens it: every
device you may see, grouped by role under the role's own badge (fold a group
by its header). Type to search names, models, sites and racks; the filter
button narrows by site, role, type, status, tag and rack. **All** and **Not
placed** switch between every device and the ones not on the map yet. A
device already on the map is dimmed and ticked - click it to find its card.

**Placing devices.** Drag a device from the list onto the canvas and its card
lands where you let go. To place several, click one, ++ctrl++-click
(++cmd++-click on a Mac) more or ++shift++-click a range, then drag any of
them: they land in a small grid from that point, clear of the cards already
there. Double-click a device, press ++enter++ on it, or use **Add** at the
bottom of the list to place the selection in the middle of the screen (after
right-clicking the canvas → *Add device…*, where you clicked). Cables between
the devices on the map draw themselves - there is nothing to connect. A card
shows muted until the map has fetched it; the camera stays where it is.

Patch panels cannot be placed while **Show patch panels** is off: their
cables are walked through, so the panel would never appear.

**Add connected devices.** Right-click a card → *Add connected devices*, or
select it and use **Add ▸ Connected devices**, to bring in everything cabled
to it. Each newcomer is placed under the cards it is cabled to.

**Removing devices.** Right-click a card → *Remove from diagram*, or select
cards and press ++delete++ (or ++backspace++). That takes the device out of
the view's set, with its position and overrides; ++ctrl+z++ puts it back.
*Remove from view* is different - it hides a card and keeps it in the set
(see [Hiding things](#hiding-things-the-eyes)).

**Arranging.** Drag cards where you want them. **Arrange ▸ Re-layout** lays
the diagram out automatically again. Devices added to a diagram that was laid
out automatically pin the cards already there, so nothing moves under you.

**Saving.** Adding, placing and removing devices are edits to the view: undo
steps like any other, and **Save** (++ctrl+s++) writes them - see
[Saved views](#saved-views). On the Diagram tab **Add** and **Arrange** menus
stand in for the Add device, Zone and Re-layout buttons of the other tabs.

**A map that follows its filters** takes no drops: the device list says so and
offers **New view**. Right-click a device → *Start custom map here* still
turns any map into an unsaved one of just that device, grown with *Add
connected devices* (and, on the other tabs, the **Add device** button). An
unsaved map keeps its devices in its address (`devices=`), which holds up to
200 of them; past that, save it as a view to keep adding. A header chip
shows the set's size and leaves it. Right-click also offers *Open device* and
*Focus here* in any mode.

### Hiding things - the eyes

The map has the same eyes as the [site map](site-map.md) and the
[floor plans](floor-plans.md). In the **Objects** sidebar, every group
header has one - a **role**, a **site** or a **location** (whichever the
Devices list is grouped by), a **link family** (a cable media type, or the
LLDP-discovered links) - and so does every device row. Right-click a card →
**Remove from view** is the same thing for one card, from the canvas.

Hiding is not a filter: a filter says what kind of thing belongs on the map,
this says "not that one" - the last mile of a diagram you are shaping for
someone else to read. What is hidden is kept by *group*, so a role hidden
today hides the switch that gets that role tomorrow. A hidden card takes its
cables with it (a cable to a card that is not drawn has nowhere to land); a
hidden link family goes without touching the cards. Positions are kept -
hiding never re-runs the layout, and re-layout ignores hidden cards so they
do not hold empty space. Hidden objects stay in the sidebar, dimmed, with the
eye lit, so "where did my core switch go" answers itself; **Show all** at the
top of the sidebar - or the **"n hidden · Show all"** chip in the corner when
the sidebar is closed - puts everything back.

The hidden set saves with the view, and the default map remembers it per
browser. Views saved before the eyes existed hold their removed cards under
the same model.

Keyboard: ++h++ hides the selected card (or, on a grouped map, the selected
site or location); ++shift+h++ shows everything again. The same two keys
work on the site map and the floor plans.

(On a map built by hand, *Remove from diagram* - *Remove from map* on the
other tabs - is the different thing next to *Remove from view*: it takes the
device out of the hand-picked set the map is built from.)

### Zones - boxes to group things by eye

The **Zone** button (**Add ▸ Zone** on the Diagram tab, or right-click empty
canvas → *Add zone*) drops a labelled box behind the map. Use them to say what a cluster of cards *is*:
"WAN circuits", "comms closet rack", "customer side".

- **Move** it by its label bar - the bar is the grip, so a click anywhere
  else inside the box still reaches the canvas and the cards under it.
- **Rename** it by double-clicking the label.
- **Resize** it by selecting it and dragging a corner.
- **Recolour or delete** it from the small toolbar above a selected zone, or
  by right-clicking it. The Delete and Backspace keys never remove a zone -
  that always takes one of these explicit actions - and remove cards only
  from a [diagram built by hand](#building-a-diagram); ++ctrl+z++ puts
  either back.

A zone is an **annotation, not a container** - it owns nothing inside it, so
dragging one moves the box and leaves every card exactly where it was. That
is what makes it safe to draw one across a map somebody else arranged.
Zones sit behind the cables as well as the cards, so a cable crossing a zone
still reads as a cable.

Like the arrangement, zones are kept **per view style**: a box that frames
four Flat chips would frame half a card in Wiring.

The arrangement, zones and hidden objects belong to the map you made them
on. A saved view carries its own, the default map keeps its own in this
browser, and a **custom map is a scratch map** - what you arrange and draw
there stays there until you save it as a view, and exiting the custom map
neither carries it back to the default map nor disturbs the default map's
own arrangement.

## Filters, focus, search

Filter by **site / role / status / tag** - the filter fields are searchable
comboboxes, so a long site list is a keystroke away. Click a device → **Focus** to
re-query just its neighbourhood, with a **1–4 hop** radius selector; the
focus chip in the header clears it. The **Find device** box dims everything
that doesn't match (name, IP, type) - press ++enter++ to zoom to the first
hit.

### On this map - the objects sidebar

**Objects** in the toolbar opens the same sidebar the site map and the floor
plans have: one search box, status chips, and every object on the map in
foldable groups. It is the answer to "where is that switch" on a 70-card
map.

- **Problems** first: every card whose monitoring roll-up is down or
  degraded, worst first. The **down / degraded / up** chips narrow the whole
  list to one state.
- **Devices** grouped by **role**, **site** or **location** - the switch at
  the group header, remembered per browser - with the monitoring chip on
  each row. When the map is grouped by site or location, the groups are
  listed instead; double-click one to open it.
- **Links** by media type, with LLDP-discovered links and **BGP sessions**
  (a dotted line per peering device pair and table, labelled with the two
  AS numbers, iBGP or eBGP and the VRF; click it to open the session) as
  their own families;
  each row names its two ends and the cable label.
- **Zones** on this view style: click to fit the box, double-click to
  rename.

On a big map the long lists draw only the rows near where you have
scrolled, so a 2,400-device sidebar stays light. The browser's find-in-page
sees only those rows; the sidebar's own search sees them all.

A click on any row flies to the object and selects it, so its inspector
opens as if you had clicked the card. The eyes on the headers and rows are
[hiding](#hiding-things-the-eyes). The sidebar is a per-browser preference,
like the site map's.

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
aggregates** turns the fold off (`?lag=off` in the URL; a saved view keeps
the setting) to see every cable; the flat view already bundles every
parallel cable and simply names the aggregates when all of them share one.

## Edge coloring

The **color mode** select paints edges by:

| Mode | Meaning |
|---|---|
| **Cable color** | the literal color recorded on each cable (default) |
| **By type** | a stable hue per media type (cat6, OM4, DAC…) |
| **By status** | each cable's status color from your [status catalog](catalogs-and-settings.md) |
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

Drag cards where you want them, then **Save as…** - a saved view stores,
per tenant, the **filter set** (or a custom map's device set), the **display
settings** (colour mode, layout direction, cables, Levels, grouping,
aggregate bundling, and the Diagram's Simple/Detailed mode, line type and
its own [card lines](#card-lines)),
**every node position** per view style, the **zones**
and the **hidden objects**. Load it from the views select; **Save** (or
++ctrl+s++, ++cmd+s++ on a Mac) updates it in place after you rearrange;
**Re-layout** discards hand positions and re-runs the automatic
left-to-right layout. **Save** needs the change permission on topology
views, **Save as…** the add permission (++ctrl+s++ on a map that is not a
saved view opens **Save as…**), and deleting a view the delete permission.
Views are plain API objects
(`/api/topology-views/`), change-logged like everything else - except that
the change log keeps a summary of a view's `state`, not the arrangement
itself: which top-level keys changed and the size before and after. In a
change-log entry, `changes.state` holds `changed_keys` plus `old` and `new`,
each `{"keys": [...], "bytes": n}` listing the changed keys that side holds.
The pre- and post-change snapshots carry `state` in the same form over all
its keys. `bytes` is measured the way the 8 MB cap is.

A view can hold up to 50,000 positioned or hidden cards per list and 8 MB in
all. A map that outgrows that is refused with its size; **Re-layout** a style
you do not use to drop its arrangement and save again. What a view's `state`
holds, and how a save from an outdated copy is refused, is in
[Saved views API](#saved-views-api).

Arrangements are kept **per view** - Diagram, Wiring, Hierarchy and Flat each
remember their own (the Diagram's one arrangement serves Simple and Detailed). The cards are different sizes in each, so one shared set of
coordinates would hand Hierarchy the spacing you tuned for Flat. Arrange a view,
switch away, come back: it's as you left it.

**Save** stores the arrangements you actually made - a view you dragged is
pinned exactly, a view you left (or returned, with **Re-layout**) to the
automatic layout stays automatic, so it keeps laying itself out as the map's
devices change. **Re-layout** only re-runs the view you're looking at. A
drag stores the whole arrangement of that view as it stands; the only
positions it keeps from before are those of cards your permissions do not
let you see, so saving a shared view never scrambles somebody else's. The
saved arrangements come back however the view is opened - picked from the
select, or as a `?view=` link in a fresh tab. Views saved before the per-view
split keep their arrangement under the style they were saved in; if one opens
scrambled, **Re-layout** and **Save** once.

A view is addressable: `?view=<id>` opens it. Change anything afterwards -
a setting, a drag, a zone, a hidden card - and the toolbar says **edited**:
what you're looking at is no longer what the view describes. **Save** writes
it back and the address collapses to the plain `?view=<id>` again.

Edits to a map are **undoable**: every drag, zone change, hide and
**Re-layout** is one step, up to 100 steps back, and a save can be undone
too. Settings that live in the URL (filters, tab, colour mode…) are not on
the undo list - the browser's Back button takes those back.

**Unsaved changes.** Leaving a saved view or a custom map with unsaved edits -
another view from the select, the default map, a sidebar link, the browser's
Back button, closing the tab - asks first: **Keep editing** or **Discard and
leave**. The default map never asks; it is kept in this browser as you go.

**Changed by someone else.** Save only writes over the version you opened. If
somebody saved the view in the meantime, Save is refused and offers **Save as
copy** (keep your version as a new view) or **Reload** (take theirs and drop
your changes); nothing is overwritten silently.

### Keyboard

| Keys | Action |
|---|---|
| ++ctrl+s++ / ++cmd+s++ | Save (Save as… on a map that is not a saved view) |
| ++ctrl+z++ / ++cmd+z++ | Undo the last edit to the map |
| ++ctrl+shift+z++ / ++cmd+shift+z++ (or ++ctrl+y++) | Redo |
| ++delete++ / ++backspace++ | Remove the selected cards from a diagram built by hand |
| ++enter++ (device list) | Place the selected devices in the middle of the screen |
| ++ctrl++ / ++cmd++ / ++shift++ + click (device list) | Select several devices to drag at once |

Undo and redo leave a text field's own undo alone while you type in it.
++h++ and ++shift+h++ hide and show cards - see
[Hiding things](#hiding-things-the-eyes).

## Linking and sharing

The map is its address. Every control writes to the URL, so **Link** in the
toolbar copies exactly what you're looking at - and a browser bookmark, the
back button and a reload all keep it.

| Parameter | Values |
|---|---|
| `tab` | `wiring` (default), `diagram`, `hierarchy`, `flat`, `logical` |
| `mode` | Diagram: `simple` (default), `detailed` |
| `face` | Diagram: devices as `card` (default) or `photo` - see [Photo nodes](#photo-nodes) |
| `line` | Diagram: `straight` (default), `elbow`, `bendy`, `cyclical` |
| `labels` | Diagram: the link labels, comma-separated `subnet`, `ip`, `port` (all by default); empty for none |
| `view` | a saved view's id |
| `site` `location` `role` `status` | an id, or `all` |
| `tag` | a tag slug, or `all` |
| `panels` | `1` shows patch panels |
| `group` | `site`, `location`, `none` |
| `dir` | `lr` (default), `tb` |
| `color` | `cable` (default), `type`, `status`, `speed`, `none` |
| `cables` | `routed` (default), `straight` |
| `lag` | `on` (default) bundles aggregate members, `off` |
| `levels` | the tier order - see below |
| `device` `depth` | focus on one device, 1-6 hops |
| `devices` | a comma-separated device set - an unsaved map built by hand, up to 200 |
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

**Export** in the second bar downloads the map as a file. It is drawn from
the map's data, not captured from the screen, so every card is in the file
however far off screen it sits.

| Format | What you get | Good for |
|---|---|---|
| **PNG** | An image at twice screen resolution | A wiki page, a change ticket, a chat message |
| **SVG** | A vector drawing: cards, lines and text, each card and cable a link back to Danbyte | Printing at any size, Inkscape or Illustrator, documentation |
| **draw.io** | An editable `.drawio` file (see [draw.io](#drawio) below) | A diagram you keep editing in draw.io |

The menu's choices are remembered per browser:

- **Area** - **Whole map**, or **Visible area**: only the cards on screen
  and the lines between them.
- **draw.io** (Diagram tab) - **Simple** (the default) or **Detailed**,
  whichever mode the map is in on screen, and **Photos**: off by default,
  so a photo is drawn as the device's card - the shape you edit in draw.io;
  on, it is the photo (see [draw.io](#drawio)).
- **Title and legend** - a strip under a PNG or SVG: the view name, the
  tenant, the filters, the date and a link back to this map, beside the
  legend (role colours, the monitoring pill, line styles).

A file is named after the saved view (else the site, else `topology`) and
the day: `arhus-dc-2026-09-26.drawio`.

**Wiring, Hierarchy and Flat** export their SVG and draw.io in the Diagram's
Simple look: a compact role-coloured card with the device's IP, centred
where its card sits on the tab, and one straight line per device pair with
a count chip (`2x`) when it stands for several cables. Their port rows and
routed cables are how those tabs draw rather than what the map says. Their
PNG is still a picture of the canvas as you see it, in the app's theme. The
Logical tab has no export.

### How Diagram exports are drawn

Every export is light-themed whatever theme the app is in: white paper,
zinc greys, and colour only where it means something - role fills, status
pills, cable colours.

- **SVG** is plain vector drawing: shapes, lines and text, no embedded HTML.
  It opens in a browser, Inkscape or Illustrator and stays editable. Text is
  set in Inter, falling back to the usual sans-serif fonts where Inter is not
  installed.
- **PNG** is that SVG rasterised (2x), with Inter embedded so names never
  reflow in another font. A very large map is scaled down to stay under
  about 16.7 million pixels - Safari draws nothing above that.
- **Photos** ([photo nodes](#photo-nodes)) are embedded in the SVG and the
  PNG, scaled down in your browser to twice the size they are drawn at, so
  the file stands alone. Each cable's lead is drawn over its photo into the
  port, and the ports it lands on are outlined. A photo that will not load
  is drawn as the device's card; a faceplate, which has no image, is too.

Both show what the canvas shows, from the same plan: role-coloured cards
with the name, card lines and pill; in Detailed, the interface nubs; the
port names and addresses on their cables where the map put them, each over
a white box that breaks the line (a label the map left off is left off);
every elbow in its lane; the same line types, Cyclical arcs and each link's
own line (curves follow draw.io's curved rule, so the draw.io file
matches); a breakout's split points; the subnet and count chips where the
map shows them (a chip the map only shows on hover is left out); zones. The monitoring pill is
the one on screen when the file is made. Selection, hover, search dimming
and hidden devices or link families never reach a file.

#### draw.io

**draw.io** (`.drawio`) is the same diagram as a file you keep editing, in
draw.io (diagrams.net) desktop, on the web or in the VS Code extension.

- **Cards** are rounded boxes in the role colour, with the name in bold and
  the card lines under it; the pill is a small box in the top-left corner.
  Each card links back: click it in draw.io to open the device in Danbyte,
  and its Danbyte id is under *Edit Data* (Ctrl+M). A name cut to fit its
  card keeps the full name as the hover text.
- **Simple is the default**: every line meets its card at the midpoint of
  that side, and a pair's cables are one line with a count - the shape a
  hand-drawn diagram has, even when the map is in Detailed. **Detailed**
  adds the interface nubs; each line leaves its own nub.
- **Labels:** the chip (subnet, count) is the line's own label. Each port
  name and address is a label cell on its line, turned along it, on a
  white background with a space either side, so the line breaks for it
  with a small gap round the text - move the line and they follow.
- **Lines keep their route.** Elbows go through draw.io's orthogonal router
  with each corner as a waypoint, so they stay square when you move a card.
  Bendy lines and Cyclical arcs are draw.io curves through the same points
  the map uses. A
  single cable links back to it in Danbyte. Lines are written before the
  cards, so they pass under a card as they do on the screen.
- **Breakouts:** the split point is a small ellipse (two, for a cable
  broken out at both ends); the trunk ends on it and each leg leaves from
  it, so dragging it in draw.io moves the split.
  The trunk, the legs and the ellipse carry the cable's id
  (`danbyte_cable`, under *Edit Data*) and link back to the cable.
- **Bands:** a row band becomes a swimlane that holds its cards (the ones
  whose centre is inside it) and carries them when you drag it. Zones hold
  their cards the same way. A side band is a shape behind the rows, as a
  card can sit in only one container.
- **Layers:** LLDP neighbours and BGP sessions are on their own layers,
  *Discovered (LLDP)* and *BGP sessions*, so you can hide them in one click
  (*View ▸ Layers*, Ctrl+Shift+L).
- Text is Helvetica, as few machines have Inter installed.
- **Photos:** by default a photo node is drawn as the device's card, at the
  photo's size, its cables meeting the card's edge where their ports are.
  With **Photos** ticked it is the photo itself, embedded (scaled down to
  600 px wide), with the name as its label underneath: each cable is
  attached at its port, each marked port is a connection point, and the
  photo sits behind the lines so their leads show over it.

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

`POST /api/topology/` takes the same query as a JSON body and returns the same
graph: `devices` (a list), `device`, `depth`, `site`, `location`, `role`,
`status`, `tag`, `collapse_panels` (a boolean), `group_by`, `include` (a list)
and `card_fields` (a list). The map posts whenever it has a device set - a few
hundred ids overflow the server's 8 KB request line - and scripts can keep
using GET. It is a read: the same `device.view` scope applies. A read-only API
token can't POST, so use GET with one. A body that isn't a JSON object is a
400; `"devices": null` means no device set.

Enrichment is opt-in with `include` (comma-separated on GET): `card`,
`link_ips` and `photo`, the data behind the Diagram tab's cards, link labels
and photo fronts. Unknown tokens are ignored, and `include` is ignored with
`group_by`. When anything is included the response gains a `meta` object;
without `include` the payload and its cost are unchanged. `card_fields`
passes a saved view's own card lines for `include=card` (keys as in
[Card lines API](#card-lines-api); an empty value means name only).

Always present, at no extra query cost:

| Where | Field | Shape |
|---|---|---|
| Node | `role` | `{id, name, slug, color, icon, is_patch_panel}`, or `null` |
| Node | `status_mini` | `{id, name, slug, color, text_color, is_default}`, or `null` |
| Node | `device_type_id` | id, or `null` |
| Cable edge | `status_mini` | as on a node, for the cable's status |
| Each pair | `a_id`, `a_kind`, `b_id`, `b_kind` | the component at each end |
| Each pair | `a_end`, `b_end` | `"A"` or `"B"`: the cable end each component sits on |

`is_default` is true when the status is the one new devices (on a node) or
new cables (on an edge) get by default - its `default_for` list.
`a_kind`/`b_kind` name the termination type: `interface`, `front_port`,
`rear_port`, `console_port`, `console_server_port`, `power_port`,
`power_outlet`, `aux_port` or `circuit_termination`. Pair ends follow the same
orientation as `a_port`/`b_port` (the edge's source, then its target); on a
collapsed edge they are the run's two real endpoints, not the panels between.
`a_end`/`b_end` say which end of the edge's cable each component is
terminated on, whatever the orientation - so the pairs of a breakout cable
with several ports at both ends split into its A side and its B side. A
collapsed run's far end, beyond the panels, sits on another cable: it takes
the end the run leaves the edge's cable by, the opposite of the near end.

`GET /api/monitoring/topology/ghosts/?device=<id>` - the device page's LLDP
mini-graph - returns its nodes in a reduced shape: name, site, `status` and
`status_mini`, with no role or ports. The device nodes of a trace
(`GET /api/interfaces/<id>/trace/`, `GET /api/cables/<id>/trace/`) carry
`status_mini` as well.

**`include=card`** adds `card` to every device node and `card` to `meta`:

```json
"card": {
  "fields": ["monitor", "primary_ip", "loopback", "serial"],
  "source": "default",
  "values": {
    "primary_ip": {"id": "…", "address": "10.0.0.1", "cidr": "10.0.0.1/24"},
    "loopback": [{"id": "…", "address": "10.255.0.1", "cidr": "10.255.0.1/32"}],
    "serial": "SN-1"
  }
}
```

- `fields` are the device's resolved [card lines](#card-lines-api) and `source`
  the level that chose them: `device`, `view` (the query's `card_fields`),
  `role`, `tenant`, `deployment` or `default`.
- `values` holds only that node's own keys. `status`, `monitor`,
  `device_type`, `role`, `site` and `location` have no value: the node
  already carries them, and the monitoring pill comes from
  `/api/monitoring/status/`.
- `primary_ip`, `secondary_ip` and `oob_ip` are `{id, address, cidr}` or
  `null`. They are device attributes, shown wherever the device is, as on the
  device API. `cidr` uses the address's own mask length, else its prefix's.
- `loopback` lists the addresses with the IP role `loopback` assigned to the
  device, limited to the caller's `ipaddress.view` scope.
- `serial` and `asset_tag` are strings; `platform` (the device's own, else
  its type's) and `manufacturer` are `{id, name}` or `null`; `rack` is
  `{id, name, position}` or `null`; `tags` is `[{name, slug, color}]`.
- `cf_<key>` is the custom field's raw value. A key for a hidden custom field,
  or one that isn't a device custom field, is dropped from `fields`.
- `meta.card` is `{fields, source, uses_monitor}`: the effective global list
  (before role, view and device lists) and whether any node shows the
  monitoring pill, which is when the page fetches check states.

The cost doesn't grow with the map: at most ten queries, each run only when
some card shows a line that needs it.

**`include=link_ips`** adds each cable pair's addresses and the subnets its
two ends share, and `subnets` to every cable edge:

```json
"pairs": [{
  "a_port": "eth0", "b_port": "eth1", "…": "…",
  "a_ips": ["10.1.0.0/31", "2001:db8:1::1/64"],
  "b_ips": ["10.1.0.1/31", "2001:db8:1::2/64"],
  "subnets": [
    {"cidr": "10.1.0.0/31", "family": 4, "a": "10.1.0.0", "b": "10.1.0.1",
     "a_via": null, "b_via": null},
    {"cidr": "2001:db8:1::/64", "family": 6, "a": "2001:db8:1::1",
     "b": "2001:db8:1::2", "a_via": null, "b_via": null}
  ],
  "subnets_truncated": false
}],
"subnets": ["10.1.0.0/31", "2001:db8:1::/64"]
```

- An end's addresses are those on its interface, then on the interface's
  LAG, then on its sub-interfaces, then on the LAG's sub-interfaces.
  `a_via`/`b_via` name the interface an address sits on when it isn't the
  cabled port (`ae1`, `Gi0/0.100`), so every member of a bundle reports the
  bundle's subnet.
- Two ends share a subnet when `address/length` gives the same network on
  both. The length is the address's own mask length, else its prefix's, so
  a /31 carved from an aggregate stays a /31. VRFs aren't compared: a cable
  joins its ends whatever their routing tables. The same address on both
  ends shares nothing.
- Host routes (/32, /128) and virtual addresses (an IP role marked virtual,
  such as an HSRP/VRRP VIP) are left out.
- `a_ips`/`b_ips` are `address/length` strings, at most 8 per end.
  `subnets` lists IPv4 first, then follows the A end's order, at most 8;
  `subnets_truncated` says there were more. The edge's `subnets` is the
  union of its pairs' subnets. Ends follow the pair's orientation, and a
  collapsed run's ends are the real ports beyond the panels. Only interface
  ends have addresses; other ends get empty lists.
- Addresses pass the caller's `ipaddress.view` scope, so an end whose
  address is hidden shares no subnet. Without `ipaddress.view` none of these
  fields are added.

It costs at most two queries (the sub-interfaces, then the addresses),
whatever the size of the map, and none without `ipaddress.view`.

**`include=photo`** adds `photo` to every device node:

```json
"photo": {
  "front": {
    "url": "/media/device-type-images/c9300-48p.png",
    "aspect": 0.0833,
    "scale": null,
    "markers": [
      {"port": "Gi2/0/1", "port_id": "…", "kind": "interface",
       "x": 0.12, "y": 0.4, "w": 0.02, "h": 0.2}
    ]
  },
  "type_faceplate": true,
  "u_height": 1,
  "rack_width": "full",
  "vc_position": 2
}
```

- `front` is `null` when the device type has no front photo or its file is
  missing. `url` is the same-origin media path the device type API returns.
  `aspect` is height / width as the photo is shown, or `null` when the file
  isn't an image the server can read. `scale` is the front display size saved
  with the photo ports (`view.front.scale`), else `null`.
- `markers` are the [photo ports](../dcim/device-catalog.md#photo-ports) of
  the effective layout (the device's own, else its type's) that land on one
  of the node's cabled ports, in layout order. `port` and `port_id` are the
  port as it is called now; `kind` is the marker's kind and `x y w h` its box
  as fractions of the image, `x`/`y` being the centre.
- A marker matches the way the device's faceplate matches it: `{position}`
  becomes the stack member number, then the port's frozen marker key is
  tried, then its name, then either ignoring case and surrounding spaces. A
  renamed port keeps its marker. The match runs over all of the device's
  ports of that kind, so a marker that lands on an uncabled port is left out
  rather than moved to a cabled port that only matches more loosely. Module
  bays and inventory items get none, and a port two markers name keeps the
  first.
- `type_faceplate` is true when the type can draw a schematic faceplate
  instead: a saved faceplate layout with a front, else interface templates.
- `u_height` and `rack_width` (`full` or `half`) are the type's; the Diagram
  draws a half-width type's photo half as wide.
- Only the front is sent.

It costs one query, plus one per port kind the markers of cabled ports use,
whatever the size of the map, and never asks SNMP. Each photo's size is read
from the file header once and cached.

A malformed id in `device`, `devices`, `site`, `location`, `role` or `status`
returns `400 {"detail": "<param>: not a valid id"}`, even in a mode that
ignores the parameter. `devices` takes at most 10,000 ids; more is a 400. An
empty `devices=` is still the device-set mode: an empty map.

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
(and the same 400 on a malformed id) and `collapse_panels` semantics as the
graph endpoint. This is the endpoint
to point an AI assistant at when it needs to answer "what connects to
what" questions.

All three are RBAC-scoped to the caller's `device.view` grant.

### Device palette API

`GET /api/devices/?picker=palette` is the light device list the diagram
builder's palette loads: every device in one response, grouped by role name
and then natural name, with role-less devices last. Each row is `{id, numid,
name, role, device_type, site, location, rack, status, has_photo}`:

- `role` - `{id, name, slug, color, icon, is_patch_panel}`
- `device_type` - `{id, name, model, manufacturer: {id, name} | null}`
- `site`, `location`, `rack` - `{id, name}`
- `status` - `{id, name, slug, color, text_color}`
- `has_photo` - the device type has a front image

Each of those is `null` when the device has none. The device list's filters
all apply: `search`, `site`, `role`, `device_type`, `status`, `tag`
(repeatable, all must match), `rack`, `location`, `region` (and its
sub-regions) and `manufacturer`. The response is paginated like any list, so
`count` is the total and `page_size` caps a page. Rows follow the caller's
`device.view` scope, so a user limited to some sites sees only those devices,
and the query count doesn't grow with the number of devices.

### Saved views API

`/api/topology-views/` is a plain CRUD endpoint, gated by the `topologyview`
view, add, change and delete permissions. `GET /api/topology-views/?picker=1`
lists `{id, numid, name, updated_at}` only, without `state`, for the views
select; one view's state can run to megabytes.

**Stale saves.** A `PATCH` or `PUT` may carry `base_updated_at`: the
`updated_at` of the copy the edits started from. If the view has been saved
since, the write is refused with
`409 {"detail": "This view was saved by someone else since you opened it."}`
and nothing changes. Without it (or with `null`) a save goes through as
before. The field is write-only.

**State.** `state` is a JSON object of at most 8 MB, and keys the server does
not know are kept as sent. The keys the Diagram tab adds are checked; the
older ones (`filters`, `positions`, `positions_by_style` and `zones_by_style`
for the older styles, `hidden`) keep their lenient checks, so views saved by
earlier versions load and save unchanged.

| Key | Shape |
|---|---|
| `positions_by_style.diagram` | the Diagram tab's arrangement, like the other styles' |
| `zones_by_style.diagram[i]` | a zone, plus optional `kind` (`zone` or `band`), `orient` (`h` for a row, `v` for a side band) and `rule` `{by: role\|device_type, ids}` (at most 100 ids, what the band was generated from). `color` is one of the six zone swatches, or `null` or `""` for a neutral band; any other colour string saves as `null`. |
| `filters.diagram` | `{mode: simple\|detailed, face: card\|photo, line: straight\|elbow\|bendy\|cyclical, labels: [subnet, ip, port], fields}`, each optional. `fields` is the view's own card lines: absent or `null` inherits, `[]` is name only, keys as in [Card lines API](#card-lines-api). |
| `links` | per-link overrides keyed by the sorted device pair `"<id>\|<id>"` (lower-case ids): `{line, flip: 1\|-1}`, at most 20,000. `flip` is the side a Cyclical arc bulges to: `-1` above (or left of) the cards, `1` below (or right). |
| `nodes` | per-card overrides keyed by device id: `{face: card\|photo}`, at most 10,000 |
| `notes` | at most 500 `{id, kind: text\|icon, x, y, text, icon: cloud\|globe\|building}`; `id` is unique, `text` at most 200 characters |

A value outside those shapes is a 400 naming the key. Keys are device ids, so
a shared view's `links`, `nodes` and positions can name devices a viewer may
not see; the map shows only the ones they can.

### Card lines API

What a Diagram card shows under the device name is configured at four
levels, most specific first: the device, the saved view, the device role,
then the tenant or deployment global list, else the built-in default
(monitoring pill, IP, Loopback, Serial). An empty list means name only.
The global and per-role lists are edited in
[Settings → Topology](#card-lines).

- `GET /api/topology-card/` - the effective config for the active tenant,
  readable by any member: `{fields, role_overrides, source, available, pills,
  defaults, max_fields}`. `role_overrides` is keyed `role:<slug>`.
- `GET/PUT /api/deployment/topology-card/` (deployment admins) and
  `GET/PUT /api/tenant-settings/topology-card/` (tenant admins, with
  `override` and `deployment_defaults`) edit `card_fields` and
  `role_overrides`.
- `PATCH /api/devices/<id>/` with `{"topology_card": [...]}` sets one
  device's lines (`device.change`); `null` inherits again.

Keys come from `status`, `monitor`, `primary_ip`, `secondary_ip`, `oob_ip`,
`loopback`, `serial`, `asset_tag`, `device_type`, `manufacturer`, `platform`,
`role`, `site`, `location`, `rack`, `tags` and `cf_<key>`, at most 8 per
list; an unknown key is a 400. See
[Tenant settings](../architecture/tenant-settings.md) for the resolution
rules.

On the card the name is bold and centred, and each line under it shows its
value - alone where that is unambiguous, with a short prefix where a bare
value could be taken for another line:

| Key | The card shows |
|---|---|
| `primary_ip`, `secondary_ip` | the address: `10.0.0.11` |
| `loopback` | the address, `+N` when the device has more: `10.255.0.11 +1` |
| `oob_ip` | `OOB 10.9.0.11` |
| `serial` | `SN FDO2231X0AB` |
| `asset_tag` | `Asset A-00123` |
| `rack` | `Rack R12 · U20` |
| `device_type`, `manufacturer`, `platform`, `role`, `site`, `location` | the name |
| `tags` | the tag names, comma separated |
| `cf_<key>` | `Label: value` |

Lines without a value are skipped, and at most six show. `status` and
`monitor` are pills, not lines, and at most one shows, inside the card's
top-left corner: `monitor` shows the monitoring pill while the device is
down or degraded and wins over `status`, which shows the lifecycle status
pill whenever it is listed. A card keeps room for the pill whenever its
list can show one, so a device going down never resizes it.
