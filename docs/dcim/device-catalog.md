---
icon: lucide/box
---

# Device catalog

Before you add devices, it helps to define the **catalog** they draw from:
who makes the hardware, what models exist, and how you classify devices. You
build this once and reuse it across every device.

There are five catalog objects, each with its own sidebar page:

| Object | Answers | Example |
|---|---|---|
| **Manufacturer** | Who makes it? | Cisco, Juniper, Dell |
| **Device type** | What model is it? | Catalyst 9300-48P |
| **Device role** | What job does it do? | Access switch, core, firewall |
| **Platform** | What OS does it run? | IOS-XE, JunOS, PAN-OS |
| **Platform group** | What OS family is that? | Windows, Linux, network NOS |

## Manufacturers

The vendor. Create a manufacturer with a **name** (and optional URL and
description) before — or while — creating its device types.

!!! note "Can't delete a manufacturer?"
    A manufacturer can't be deleted while device types still reference it. Remove
    or reassign those device types first. The delete dialog tells you when this is
    the case.

## Device types

A **device type** is the reusable hardware template — "a Catalyst 9300-48P is 1U
tall, made by Cisco, model C9300-48P." Every device of that model points at the
same type, so you describe the hardware once.

Fields:

- **Manufacturer**, **model**, **part number**
- **Platform** — optional default OS for devices of this type. A device
  without a platform of its own inherits it — see
  [effective platform](#platform-groups-and-the-effective-platform)
- **Height (U)** — how many rack units it occupies
- **Rack width** — full (default) or **half**, for gear like a Mellanox SN2010
  where two units mount side-by-side in one U (see
  [half-width devices](racks.md#half-width-devices))
- **Full depth** — occupies both rack faces (default). Shallow gear unticks
  this and frees the opposite face in [rack elevations](racks.md#rack-elevations)
- **Airflow**, **weight** — hardware facts (airflow also exists per device as
  an override)
- **Description**, **tags**, **custom fields**

Device types accept [custom fields](../features/tags-and-custom-fields.md)
(target **Device types**) — handy for catalog-level attributes such as a
warranty window or an end-of-life date that belongs to the model, not the
individual device.

### Importing from the NetBox devicetype-library

You rarely have to type a hardware model in by hand. The community
[devicetype-library](https://github.com/netbox-community/devicetype-library)
(public domain) holds thousands of ready-made definitions, and Danbyte's
component templates use the same taxonomy — so they import 1:1. Click
**Import** on the Device types page and either:

- paste **GitHub links** to `.yaml` files in the library (one per line —
  regular `blob` links work, they're converted automatically),
- paste a **folder link** — a `/tree/` URL such as
  `…/device-types/Cisco` — to import every device type in it (one
  manufacturer at a time; the importer lists the folder over the GitHub API
  and pulls each file),
- paste the **YAML itself**, or
- **upload** the `.yaml` files.

The whole `device-types` folder is thousands of files — too many for one
synchronous import, so pull it a manufacturer (or a few) at a time.

Manufacturers are created as needed. Everything Danbyte models — interfaces,
console/console-server ports, power ports/outlets, front/rear ports,
**module bays**, **device bays** (+ subdevice role, exclude-from-utilisation),
**inventory items**, plus **full-depth, airflow, and weight** — comes across, and
the library's **elevation images** are downloaded automatically when the file
declares them. **Module-type files** (`module-types/…`) import through the
same dialog — auto-detected. **Every construct in the library schema now
maps** — anything unrecognised in a file would still be reported, never
silently dropped.

**Stackable switches:** the upstream library has no stack-position concept, so
its port names are literal (`GigabitEthernet1/0/1`).
Tick **Stackable** during import and Danbyte rewrites the leading slot digit
to the [`{position}` token](virtual-chassis.md#position-aware-interface-names)
(`1/…` → `{position}/…`, Juniper-style `0/…` → `{position:0}/…`) so one
imported type serves every member of a stack.

### Filtering a long catalog {#filtering}

Import a vendor folder or two and the catalog runs to hundreds of models, so the
Device types list carries a full filter rail. The search box still matches name
and model; the rail narrows by:

| Facet | Picks out |
|---|---|
| **Manufacturer** | one vendor's models |
| **U** | a height range — 1U top-of-rack gear, or everything ≥ 4U |
| **Images** | whether the type has a [rack-face photo](#rack-face-images) at all |
| **Faceplate** | how its devices draw their panel: **Photo ports**, **Custom** or **Auto** |
| **Usage** | **In use** vs **Unused** — catalog entries no device is built from |
| **Lifecycle** | [vendor lifecycle state](../features/lifecycle.md) — what's end-of-life |
| **Scope** | site-local vs tenant-wide entries, where the deployment scopes catalogs per site |
| **Tags** | any tag; the chips in the Tags column toggle the same filter |

Facets stack (**Cisco** + **Unused** + **End of life** is the prune list), and
the count chip beside the title always reports what survived them. A facet that
can't split the rows you have — every type global, nothing laid out yet — hides
itself rather than take up rail space.

Two columns carry what the rail filters on. **Images** shows which faces exist
(**Front**, **Rear**, or `—`), and **Faceplate** reads *Photo ports* when
[markers are placed on a photo](#photo-ports), *Custom* when a
[faceplate layout](#faceplate-builder) is saved, and a muted *Auto* when the
panel is drawn automatically — so **Images: Yes** plus **Faceplate: Auto** is
exactly the queue of types you have a photo for but haven't marked up yet. Hide
either column from the **Columns** menu if you don't work with panels; the
filters stay.

### Deleting types in bulk {#bulk-delete}

Tick the checkbox on any row and a bar appears at the bottom of the list with
the selection count, **Export** (CSV / Excel / JSON of just those rows) and
**Delete**. The selection is drawn from the rows the rail is currently showing,
so the usual prune — **Cisco** + **Unused** + **End of life**, select all,
delete — clears a vendor's dead models in one pass. The bar only appears if you
hold `delete` on device types.

The confirm names up to five of the types and, crucially, **sums the devices
attached to the whole selection**: *"12 devices use these types — they'll keep
working but lose their type reference."* Deleting a type never deletes its
devices; `Device.device_type` is nulled, so those devices keep running,
untyped, until you point them at another type. What *does* go with the type is
its own [component templates](#component-templates), faceplate and photo-port
markers.

Deletion runs through `POST /api/device-types/bulk-delete/` (`{ids}`) and
returns `{"deleted": n}` — a count of **types**, not of the templates that
cascaded with them. The submitted ids are re-checked server-side against your
tenant and, where the deployment scopes catalogs per site, your site scope: an
id you can see but not write (a tenant-wide entry, or one local to another
site) is skipped rather than deleted, so `n` can be smaller than the number you
selected. Every removal lands in the change log.

### Rack-face images

On a device type's detail page you can upload a **front image** and a **rear
image** of the hardware. These get painted onto the device wherever it appears in
a [rack elevation](racks.md), with the device name overlaid — so a rack diagram
looks like the real thing. Use the **Front / Rear** toggle on the rack to switch
faces. The same images also render read-only on each **device's** Overview tab,
so you can see the hardware without opening the type.

### Recovering lost images {#reimport-images}

Images live in the media folder; the device types live in the database. Lose
the media folder — disk corruption, a restore that skipped `media/`, a botched
migration between hosts — and every type still *lists* an image it no longer
has. **Reimport images** on the Device types page (needs `change` on device
types) rebuilds exactly that: it matches your **existing** types against a
devicetype-library-layout repository and re-downloads their elevation images.
Nothing is created, renamed, or otherwise modified — only the two image fields
are written, and every write lands in the change log.

Point it at a repository in whichever form you have handy — plain
`owner/name`, a `github.com` URL (optionally `/tree/<ref>`), or a full https
base such as an internal mirror. The default is Danbyte's
[device-library](https://github.com/danbyte-net/device-library) fork, which
keeps the upstream layout: images at
`elevation-images/<Manufacturer>/<slug>.front|rear.png`. Matching reuses the
import's own naming: the slug embedded in a surviving image filename first
(it's still in the database even when the file is gone), then
vendor-prefixed slugs derived from the type's name, part number and model.

**Dry run** classifies without writing: **matched** (the repo has images for
it), **no match**, or **has images** (both faces present *and their files
actually exist on disk*). Apply is **fill-gaps-only** by default — a face is
written only when its field is empty *or* the field is set but the file is
missing from storage. That second case is the whole point: after media loss
the database still says "has image", and Danbyte treats it as a gap rather
than trusting the stale reference. Tick **overwrite** to replace intact
images too, e.g. after switching to a repo with better photos. A repo that's
unreachable mid-run marks the affected faces `fetch failed` and carries on —
one bad fetch never aborts the batch.

Small catalogs answer synchronously with a per-type report; anything over
~50 types runs in the background with the same pollable progress as the
[folder import](#importing-from-the-netbox-devicetype-library). The API is
`POST /api/device-types/reimport-images/` (`{"repo": …}`, flags `?dry_run=1`
/ `?overwrite=1`), which either returns the report or `202` + a run to poll
at `import-runs/<id>/`.

**Airgapped deployments** (update checks disabled) get a clean refusal
instead of a hanging timeout — no outbound request is attempted. Recovery
there is the offline route: restore the media folder from a backup, or
re-upload images per type; [bundles](#bundles) stay the offline carrier for
*definitions*, but they deliberately reference images rather than embed
them, so they can't restore the files themselves.

### Jumping to the devices

The **Devices** count on a device type's detail page is a link: it opens the
[Devices](devices.md) table pre-filtered to that type (the Type facet is
seeded from the URL), so you land on exactly those devices — the same
foreign-key linkage used throughout Danbyte to keep related objects one click
apart.

### Share a device type as a bundle {#bundles}

Teaching Danbyte a piece of hardware is real work: stamp the component
templates, draw the [faceplate](#faceplate-builder), place the photo-port
markers on the rear image, find the vendor OID that reports drive health. All of
it is knowledge about the **model** — identical for everyone who owns that box.

A **bundle** is that work in one file. On a device type, **Export bundle**
downloads everything that makes the model work:

- every component template (interfaces, console, power, panel ports, bays)
- the faceplate layout and the photo-port markers
- inventory-item templates (the disk bays a chassis ships with)
- the [custom SNMP sensors](../features/snmp-discovery.md#sensors) bound to it

**Import bundle** on the device-type list reads one back. It **previews first** —
importing a file from elsewhere should never be blind — showing what would be
created, and only then offering to apply it.

Three rules make a bundle safe to accept from anyone:

- **No credentials.** Sensors poll with *your* deployment's own
  [SNMP profile](../features/snmp-discovery.md#snmp-profiles); a bundle
  references nothing secret.
- **Imported sensors are observe-only.** Whatever the file says, they arrive as
  `drift` — they surface differences for review and can never overwrite a status
  you set. Switch one to automatic yourself if you want that.
- **Nothing is overwritten silently.** A device type you already have is skipped
  unless you tick *Update the device type if it already exists* (which needs
  change access, not just add).

Ids never travel — manufacturers, an outlet's inlet, a front port's rear port all
move as **names** and are re-resolved locally. Anything that can't be resolved is
reported, never dropped in silence. Photo-port coordinates are normalized 0–1, so
they line up at any resolution of the same photo; if the bundle was built against
an image you don't have, the import says so — upload it on the device type and
the markers land correctly.

API: `GET /api/device-types/{id}/library-export/` and
`POST /api/device-types/import-bundle/?dry_run=1&replace=1`.

## Component templates

A device type owns **component templates** — the ports the hardware ships
with: interfaces, console port(s), power inlets, PDU outlets, and patch-panel
rear/front ports. When you create a device of the type, Danbyte **stamps every
template into a real component** on the device, so a "C9300-48P" arrives with
its 48 interfaces, console port, and two PSU inlets already in place — no
hand-typing ports per device.

Manage them on the device type's **Components** tab, which splits the component
kinds — Interfaces, Console ports, Console server ports, Power ports, Power
outlets, Rear ports, Front ports, **Aux ports**, and **Services** — into
sub-tabs with counts. The open sub-tab is part of the URL
(`?tab=components&sub=power-port`), so you can link someone straight at one
kind, and reload or back/forward without losing your place.

**Aux ports** are the catch-all for connectors the other kinds don't cover: USB
(A/B/C/mini/micro), video outputs (HDMI, VGA, DVI, DisplayPort), SD/microSD
slots, RJ11, audio jacks, and grounding lugs — so a device type can model
*everything* on its panel. Template names support
two shorthands: a **`[1-24]` range** creates one template per port in a single
add, and a **`{position}` token** resolves to the device's stack member number
when components are stamped (and renames ports when a device changes stack
position) — see [virtual chassis](virtual-chassis.md#position-aware-interface-names).
Tick rows to reveal a bulk bar with **Edit**, **Rename**, **Clone**, and
**Delete**:

- **Rename** — find/replace across the selected templates' names (optional
  regex), with a live before→after preview. Ideal for renumbering a bank of
  ports (`Gi` → `GigabitEthernet`, `1/0/` → `2/0/`). It refuses names that would
  collide.
- **Clone** — duplicate the selected templates, applying a find/replace so the
  copies get new names (e.g. clone `1/0/*` to `2/0/*` for a second line card);
  with no find/replace the copies get a “ copy” suffix. The same bulk bar (and
  actions) works on a real device's Interfaces too.

Notes:

- Materialisation happens on **device create** (and skips any name the device
  already has, so imports that pre-create ports are safe). Existing devices are
  not retro-modified when you edit templates — but each device has a **Sync
  from type** button (see below) to back-fill the changes on demand.
- Power **outlet** templates can reference the power **inlet** template that
  feeds them; front-port templates map onto rear-port template positions — the
  same relationships the concrete components carry.
- **Service** templates (name · protocol · ports) stamp a **Service** onto each
  new device; tick **Monitor** and those services are watched from the moment
  the device has an IP — fleet-wide service monitoring configured in one place.
  See [service monitoring](../../architecture/service-monitoring.md).

### Sync an existing device to its type

Editing a device type's templates doesn't touch devices that already exist. To
push the changes onto one, open the device and click **Sync from type** (top-
right, next to Edit). It opens a **preview** first — no changes until you
confirm:

- **Add** (safe, always applied on confirm) — components the type defines that
  the device is missing (e.g. interfaces added to the type after the device was
  built). Shown as green chips.
- **Not in type** (amber chips) — components on the device with no matching
  template: hand-added ports, SNMP-discovered interfaces, or components dropped
  from the type. These are **kept by default**.
- Tick **Also remove the components not defined by the type** to delete those
  extras. This is **destructive** — it cascades their cabling and IP
  assignments — so the dialog turns the affected chips red and warns when any
  interface being removed carries IPs. The button becomes a red *Sync & remove
  extras*.

Faceplate slots and photo markers count as expectations too: a port drawn on
the layout that no template defines still shows under **Add**, and confirming
stamps it as a bare component (type "other") for you to refine — so a marked
port never points at nothing after a sync. Front-port markers are the one
exception (they need a rear-port mapping a marker can't express) and are left
as ghosts on the render.

Sync is name-based (it never renames or retypes existing components) and needs
`device.change`.
- Per the zero-pre-filled-data rule, no templates ship — but the type/connector
  dropdowns follow the standard taxonomies, so imported
  device-type definitions carry over.

### Faceplate builder

Every device draws its **front panel** at true physical scale — connector
cages are sized from the real form-factor dimensions (an SFP28 cage renders
narrower than the QSFP28 beside it; an RJ45 jack is taller than both), laid
out on an EIA-310-proportioned 1U bar. With no configuration, Danbyte lays the
panel out **automatically**: ports group by slot, split where the media type
changes, fill two rows belly-to-belly (odd on top), and bank in twelves — the
way real 1U hardware is built.

When the automatic layout isn't how *your* hardware looks, open the device
type's **Faceplate** tab and build it yourself. The canvas **is** the panel —
the same true-scale drawing devices render, with every cage draggable:

- Toggle between the **Front** and **Rear** sides — each is its own layout,
  and a port lives on exactly one of them.
- **Drag templates** from the palette (all eight component kinds — interfaces,
  console, power, aux, panel ports) onto the panel; reorder by dragging,
  drop onto the dashed **+** zone to start a new group, double-click a cage to
  remove it.
- **Drag a module bay** from the palette to drop a **placeholder** where the
  bay physically sits. On a device, the installed module's faceplate composes
  **into that spot** (`{module}` resolves to the bay position); an empty bay
  shows a labelled placeholder cage. A bay you don't place still appends its
  module at the end, as before — so old layouts keep working.
- **Click a group** to edit its **label**, **rows** (1–4), and **banking**
  (visual gaps every N ports) in the toolbar, or add **blank** cages and
  silk-screen **label** text.
- On a **multi-U** device the panel splits into one lane per rack unit; the
  toolbar's **U** control picks a group's unit. Set **U tall** to have a group
  span several units — the lanes it covers merge into one taller canvas (no
  separate **+** zone), handy for devices whose ports don't line up on U
  boundaries.
- **Save** stores the layout on the device type — every device of the type
  (including each member of a [virtual chassis](virtual-chassis.md); `{position}`
  names resolve per member) renders it, and devices with a rear side get a
  **Front / Rear** toggle on their panel. **Reset to auto** deletes it.

Templates renamed or deleted after a layout was saved render as dashed
**ghost** cages, and the tab counts them so you can tidy up. Interfaces the
layout doesn't place are appended automatically — nothing silently disappears.

### Photo ports (anchoring ports on a real image) {#photo-ports}

When a device type has a front and/or rear **[image](#rack-face-images)**, a
**Photo ports** tab appears. Instead of the schematic cage layout, you place
port markers **directly on the photo** — drag an interface (or console / power
/ panel port) template from the palette onto the image, then position it
precisely: drag it, grab the corner handle to resize, nudge with the **arrow
keys** (Shift = coarser), or type exact **X / Y / W / H** percentages. A
**fine-grid snap** keeps rows aligned. Coordinates are stored normalized
(0–1), so they scale to any render size.

What the **port hover card** shows is configurable deployment-wide under
**Settings → Component popover**: an ordered field list (name, type, state,
VLAN, live SNMP facts, IPs, description, MAC, MTU, LAG, tags — defaults to the
first six). A field with no value on that port simply doesn't render, so a
rich list costs nothing on sparse interfaces. The same list applies to the
schematic and the photo faceplate alike.

Once a type has an image **and** at least one placed marker, its devices show
the **photo faceplate** in place of the schematic one — each marker matched to
the device's real interface by name (so it carries the same state colour, live
SNMP dot, hover card and link), and the markers also render **on the device's
face in the [3D room view](../features/floor-plans.md#the-3d-room-view)**.
Types without photo ports keep using the schematic faceplate builder above.

The palette also offers the type's **[inventory-item](#inventory-items)
templates** under *Hardware* — place disk bays, PSUs and other parts on the
photo the same way. Hardware markers resolve to the device's real parts by
name and are coloured by the **part's status** (a *Failed* disk reads red on
the faceplate and in 3D); hovering shows the part's media, capacity, speed,
status and serial. Hardware markers are informational — they never join the
cable-connect flow.

**[Module bay](#module-types) templates** are placeable too, under *Module bays
(line cards)* — mark where a chassis's card slots physically are. Because a
slot is a broad rectangle rather than a connector-sized sliver, a dropped bay
marker starts at **20 % × 45 %** instead of the port default; resize it from
there like any other marker.

A bay marker answers one question — **is this slot free?** — so it is drawn as
occupancy, not speed and not health: a bay with a module seated in it is
**filled**, an empty one is the same faint outline an idle port wears. Hovering
(2D) or clicking (3D) names the installed module type and its serial, or reads
**Empty**. On a device *type* there is no device yet, so every bay draws as
empty — that is the honest answer, not an error. The key under the panel lists
only the occupancies actually on screen, and only when the panel carries bay
markers at all. Bays are informational here too; install and remove modules on
the device's **Hardware** tab.

Note the split with the schematic [faceplate builder](#faceplate-builder),
which stays port-only: there a bay is a **group placeholder** whose installed
module's own faceplate gets composed in, while the photo builder marks the
slot's real position on the artwork.

## Device bays (chassis nesting)

A **parent** chassis (blade enclosure, FEX parent) declares **device bays**
on its type (Components → Device bays) and sets **Subdevice role: parent**;
blade/child models set **child** (usually 0U). Devices of the parent type get
concrete bays stamped, and the device page's **Hardware** tab shows a **Device
bays** table — *Install…* puts a whole child device in a bay (it keeps its
own ports, IPs and lifecycle; the bay records where it physically lives).
Unlike [modules](#module-types), a bay's occupant is an independent device.

Types can also tick **Exclude from utilisation** (blanking panels, cable
management): they render in elevations but don't count toward the rack's
used-units number.

## Inventory items

**Inventory items** are serial-tracked physical parts that aren't cabled
components — disks, CPUs, RAM, PSUs, fans, discrete SFPs. Templates on the
device type (Components → Inventory) stamp onto new devices; on the device
page's **Hardware** tab you can add/edit parts with manufacturer, part ID,
serial and asset tag, and nest them one level (a fan tray containing fans).
Roles are just [tags](../features/tags-and-custom-fields.md) — no pre-filled
role catalog, per the zero-data rule.

Each part also carries its **hardware identity and health**:

- **Kind** — what the part is: Disk, CPU, RAM, PSU, Fan, GPU, Controller,
  Transceiver, or Other (the default for pre-existing parts).
- **Media** (disks) — NVMe, SSD (SATA/SAS), HDD, or Tape.
- **Capacity** with a unit picker (KB → PB; stored in bytes, so it's
  backwards- and future-proof).
- **Speed** — a dropdown of the common industry values for the part in front of
  you: spindle rates for an HDD (5400/7200/10K/15K RPM), the bus for flash
  (SATA 6Gb/s, SAS 12/24Gb/s, PCIe 3.0–5.0 x4), memory grades for RAM
  (DDR4-3200, DDR5-5600), LTO generations for tape. The field stays free text,
  so any vendor's wording still fits — the list is there to keep eight disks
  from being recorded eight different ways.
- **Status** — the part's lifecycle/health from the shared
  [status catalog](../features/catalogs-and-settings.md): every tenant gets
  **Active / Planned / Failed / Spare** for inventory items (extensible like
  any other status). Marking a disk *Failed* colours it red wherever the part
  is shown.

Templates carry kind/media/capacity/speed too, so a device type modelled with
eight `Bay {position}` NVMe templates stamps ready-described disks onto every
new device.

### Bulk-editing parts

On the device's **Hardware** tab, tick the checkbox on one or more parts (the
header checkbox selects all) — a bulk bar floats up:

- **Edit** opens a *keep/set* dialog: anything left on **Keep current** is
  untouched; set **Status** (mark eight disks *Failed* in one go), **Kind**,
  **Media**, **Capacity** (value + KB…PB unit), **Speed**, **Part ID**,
  **Description**, or add/remove **tags** — applied to every selected part.
- **Rename** does find/replace across the selected names (regex optional),
  with a live preview.
- **Clone** duplicates the selected parts under new names.
- **Delete** removes them after a confirmation.

The same bulk bar (and the same keyboard-free flow) is used on the interface
and port tables, so one habit covers every component list.

## Module types

A **module type** is a pluggable hardware model — a line card, uplink module,
or PSU sled (e.g. a Cisco `C9300-NM-8X`). It lives under **DCIM → Module
types** and carries its own **interface templates**, whose names may use the
**`{module}` token**: when a module is installed into a device's bay, the
token resolves to the bay's *position* (`TenGigabitEthernet1/{module}/1` in
bay position 1 → `…1/1/1`), and the [`{position}` stack
token](virtual-chassis.md#position-aware-interface-names) still applies after.

The workflow:

1. Give a device type **module bay** templates (Components → Module bays) —
   each bay names the slot and sets its position. Optionally pick a **Default
   module** on a bay template: a module of that type is pre-installed when the
   bay is stamped onto a new device, and seated into an empty matching bay when
   you **sync from type** on an existing device (see below).
2. Devices of the type get concrete bays stamped at creation, with any default
   modules already seated.
3. On the device page's **Hardware** tab, **Install…** a module type into an
   empty bay — its interfaces appear on the device (and its faceplate)
   instantly. **Remove** takes exactly those interfaces away again.

A **default module** only decides what's *pre-seated* — it never locks a bay.
Sync-from-type fills empty matching bays with the default but **never
overwrites** a module you installed (or deliberately left out until the next
sync), so hand-placed hardware is safe.

Module types have their own **Faceplate** tab — the same drag-and-drop
builder device types get, with the module's interface templates as the
palette. When a module with a saved faceplate is installed in a device, its
layout is **composed into the device's render** — at the bay's placeholder if
the device type's layout places that bay, otherwise appended (`{module}` in
slot names resolves to the bay position, so the cages light up with the real
interfaces' state). Editing a module type's faceplate refreshes every device
that has one of its modules installed.

Module-type YAMLs from the devicetype-library import through the same
**Import** dialog — they're auto-detected (no `u_height`), so you can paste
`module-types/...` links right next to device types.

## Device roles

A **role** classifies what a device *does* — access switch, distribution, core,
firewall, load balancer. Roles carry a color so devices group visually in lists.
Roles also accept [custom fields](../features/tags-and-custom-fields.md) (target
**Device roles**) — for example a service tier or an escalation team.

## Platforms

A **platform** is the operating system / NOS a device runs — IOS-XE, JunOS,
PAN-OS, Cumulus. Platforms are handy for filtering and for configuration
rendering.

### Platform groups and the effective platform

**Platform groups** (their own sidebar page) organise platforms into families —
"Windows", "Linux", "Others" — and can **nest** via an optional parent group
(e.g. "Debian family" under "Linux"). A platform optionally points at one
group. Groups are catalog objects like the rest: tenant-scoped, empty until
you define them, and deletable only once no platform references them.

A **device type** can also carry an optional **platform** — the OS the
hardware generically runs. That gives every device an **effective platform**:

- the device's **own** platform, when set — e.g. the type says *Windows*
  (generic) but this box runs *Windows 11 22H2*;
- otherwise the **type's** platform (the fallback).

The device's stored platform field is untouched — the fallback is derived and
read-only (`effective_platform` on the device API). The device Overview shows
the inherited value with a *(from type)* hint, so you can tell an explicit
platform from an inherited one at a glance.

## Lifecycle (EoS / EoL)

Device types and platforms both carry optional vendor lifecycle dates —
released, end of sale, end of security updates, end of support — which drive
a lifetime progress bar and an at-risk badge across the catalog, the devices
table, and each device's overview. See
[Hardware & OS lifecycle](../features/lifecycle.md).

---

All five are **yours to define** — Danbyte ships none of them, so your catalog
contains exactly the vendors, models, roles, platforms, and platform groups
your network uses.
