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
- paste the **YAML itself**, or
- **upload** the `.yaml` files.

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

### Rack-face images

On a device type's detail page you can upload a **front image** and a **rear
image** of the hardware. These get painted onto the device wherever it appears in
a [rack elevation](racks.md), with the device name overlaid — so a rack diagram
looks like the real thing. Use the **Front / Rear** toggle on the rack to switch
faces. The same images also render read-only on each **device's** Overview tab,
so you can see the hardware without opening the type.

### Jumping to the devices

The **Devices** count on a device type's detail page is a link: it opens the
[Devices](devices.md) table pre-filtered to that type (the Type facet is
seeded from the URL), so you land on exactly those devices — the same
foreign-key linkage used throughout Danbyte to keep related objects one click
apart.

### Component templates

A device type owns **component templates** — the ports the hardware ships
with: interfaces, console port(s), power inlets, PDU outlets, and patch-panel
rear/front ports. When you create a device of the type, Danbyte **stamps every
template into a real component** on the device, so a "C9300-48P" arrives with
its 48 interfaces, console port, and two PSU inlets already in place — no
hand-typing ports per device.

Manage them on the device type's **Components** tab, which splits the component
kinds — Interfaces, Console ports, Console server ports, Power ports, Power
outlets, Rear ports, Front ports, **Aux ports**, and **Services** — into
sub-tabs with counts. **Aux ports** are the catch-all for connectors the other
kinds don't cover: USB (A/B/C/mini/micro), video outputs (HDMI, VGA, DVI,
DisplayPort), SD/microSD slots, RJ11, audio jacks, and grounding lugs — so a
device type can model *everything* on its panel. Template names support
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
- **Click a group** to edit its **label**, **1 or 2 rows**, and **banking**
  (visual gaps every N ports) in the toolbar, or add **blank** cages and
  silk-screen **label** text.
- **Save** stores the layout on the device type — every device of the type
  (including each member of a [virtual chassis](virtual-chassis.md); `{position}`
  names resolve per member) renders it, and devices with a rear side get a
  **Front / Rear** toggle on their panel. **Reset to auto** deletes it.

Templates renamed or deleted after a layout was saved render as dashed
**ghost** cages, and the tab counts them so you can tidy up. Interfaces the
layout doesn't place are appended automatically — nothing silently disappears.

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
components — PSUs, fans, CPUs, discrete SFPs. Templates on the device type
(Components → Inventory) stamp onto new devices; on the device page's
**Hardware** tab you can add/edit parts with manufacturer, part ID, serial
and asset tag, and nest them one level (a fan tray containing fans). Roles
are just [tags](../features/tags-and-custom-fields.md) — no pre-filled role
catalog, per the zero-data rule.

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
