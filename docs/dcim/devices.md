---
icon: lucide/server
---

# Devices

A **device** is a single physical box - a switch, router, firewall, server, PDU,
anything you rack and cable. This page covers creating one and reading its
detail page.

## Add a device

1. Open **DCIM → Devices** in the sidebar and click **Add device**.
2. Give it a **name** (must be unique within the tenant).
3. Pick a **device type** - the hardware model. The box searches as you type;
   **Search** opens the full picker, which matches on name, model **and part
   number**, and filters by manufacturer, platform, tag, and artwork. That last
   one is more useful than it sounds: a rack elevation only draws properly for
   a type that has images, so *has a front image* answers "which of these will
   render". Don't have the type yet? Create it first on the
   [Device catalog](device-catalog.md) page; it only takes a moment and you'll
   reuse it for every device of that model.
4. Optionally set the **site**, **location**, **role**, **platform**,
   **cluster**, **status**, **serial number**, and **asset tag**.
5. Optionally fill the **built-in extras** - **comments**, **airflow**, and
   **latitude / longitude**. Which optional fields appear is controlled by your
   administrator (see [Built-in fields](#built-in-fields) below), so you may not
   see all of them.
6. Save.

!!! note "Built-in fields vs. custom fields"
    Danbyte ships a curated set of common attributes as built-in device
    fields - including **comments**, **location**, **cluster**, **airflow**
(the device's own value overrides its type's default; the resolved value is
served as `effective_airflow` and drives the 3D room's airflow cones),
    and **latitude** / **longitude**. Comments, location, and the
    coordinates are on by default (coordinates put a device on the
    [site map](../features/site-map.md)); cluster and airflow are opt-in
    under **Settings → Device fields**. Anything beyond that stays a
    [custom field](../features/tags-and-custom-fields.md), in line with the
    zero-pre-filled-data philosophy.

You can also add devices in bulk from a spreadsheet - see
[Import & export](../features/import-export.md).

## Picking a device

Anywhere Danbyte asks you to choose a device - assigning an IP, adding an
interface, terminating a tunnel or L2VPN, attaching a MAC address, adding a
virtual-chassis member, setting a VM's host - you get the same **device
picker**.

- **Type to search.** The picker is a searchable box; start typing a name and
  it narrows as you go. This is all you need when you know roughly what the
  device is called.
- **Advanced search.** When a name isn't enough - you're staring at hundreds of
  devices and want "the access switches in Amsterdam that are active" - click
  the **sliders** button beside the box. A dialog opens where you can filter by
  **tag**, **manufacturer**, **device type**, **role**, **status**, **site**,
  **location**, and **region**, alongside free-text search. Results come back
  in a table (name, type, role, site, status); click a row to select it.

Filtering by a **region** includes every site in that region *and its
sub-regions* - pick "Europe" and you'll see devices in Netherlands → Amsterdam
too, without selecting each child. All filtering runs on the server and
respects your tenant and permission scope, so the picker only ever shows
devices you're allowed to see.

## The device page

Open any device to see its detail page. A slim header shows the name, status,
tags, and description; below it is a row of tabs. If the device is a member of
a switch stack, a **Stack** badge in the header (name, position, master) links
to its [virtual chassis](virtual-chassis.md) - membership is set in the
**Stack membership** section of the device's edit form.

The tab you're on is part of the URL (`?tab=components`), and so is the
**sub-tab** inside the Components tab (`?sub=power`). So
`/devices/<id>?tab=components&sub=power` links a colleague straight at a
device's power ports, and a reload, browser back/forward, or a trip through
another tab and back all keep your place. An unknown value in either param
falls back to the default tab instead of showing an empty pane.

### Overview tab

The default tab lays the device's facts out in four cards:

| Card           | Shows                                                        |
| -------------- | ------------------------------------------------------------ |
| **Device**     | name, status, role, platform, description, comments          |
| **Hardware**   | device type, serial number, asset tag, height (U), airflow   |
| **Location**   | site, location, rack, position, face, coordinates            |
| **Management** | cluster, primary IP, its DNS name, and IP / interface counts |

Technical values (name, serial, asset tag, primary IP, DNS name) have a small
**copy button** so you can grab them in one click.

Devices with ports also get a **Port utilization** card: a segmented bar plus
counts of **connected** (the port terminates a cable), **reserved** (its cable
carries the *Planned* status, or the uncabled port holds a direct
[port reservation](cabling.md#port-reservations)), and **free** ports, broken
down per kind (interfaces, front ports, rear ports). A port can also be
**marked connected** (a one-click bolt action on the port rows, also a
checkbox on the interface / front-port / rear-port forms) when a cable is
physically in it but nobody has documented the cable yet - it counts as
connected, the row shows an *Undocumented* badge with a green tint, the
legend shows how many are *undocumented*, and the flag clears itself the
moment a real cable is attached to the port. Faceplates and photo panels draw
such a port dimmed by default; **Settings → Admin → Faceplates → Light up
ports marked connected** makes them draw it lit, like a cabled one. Reserving works two ways: create
the cable ahead of time as *Planned* and the port counts as held, or reserve
the single port directly when the far end isn't known yet. Most useful on
patch panels and access switches, where "how full is this thing" is the
recurring question (`GET /api/devices/<id>/port-utilization/`).

The card is interactive: **hovering** a legend entry (connected / reserved /
free / undocumented) highlights the matching ports on the Panel above it -
on the photo faceplate and the rendered one alike - and **clicking** it
jumps to the Components tab with the port list pre-filtered
(`?tab=components&sub=interfaces&cabled=free` is linkable). The interface
and front/rear-port tables carry the same **cabled-state chips**
(All · Connected · Reserved · Undocumented · Free) for filtering by hand,
and *Mark connected* is bulk-editable, so ticking a whole undocumented
panel is one selection.

The estate-wide view lives at **DCIM → Connections → Port utilization**:
every device with ports, fullest first, with the same
connected/reserved/free split, site/role/type facets, search and export -
so the patch panel about to run out is the first row you see
(`GET /api/devices/port-utilization/`). The **Devices list** carries the same
number as a **Ports** bar column (like the prefix utilization bar), and
**port utilization rules** on the Alerts → Rules tab can notify when a
device's fill crosses a threshold - see
[Monitoring](../features/monitoring.md#alert-rules).

Any **custom fields** you've defined for devices appear below the cards. If any of the device's IPs are
monitored, a **Monitoring** summary (roll-up badge + per-IP grid) appears at the
**top** of the tab - see [Monitoring](../features/monitoring.md#on-a-device).
The Devices list also has a **Monitoring** column rolling that status up per
device. Where the device physically sits - its **rack elevation** with this
device highlighted - is drawn compactly (front **and** rear side by side) in the
right column; it's hidden for unracked devices. If the device's **type** has a
rack-face image, that front/rear photo shows below the cards too.

### Images

Uploaded photos and diagrams live on their own **Images** tab (rack shots,
labels, cabling pictures, faceplate close-ups). Click **Add image** to upload;
hover an image and click the trash icon to remove it, or click an image to open
the full-size original in a new tab.

Two layouts, chosen with the toggle beside **Add image**. The **list**
(default) names each file with its type, size, dimensions and when it changed,
sortable by name and searchable - and downloads no images at all, so a device
with fifty photos opens instantly; a row's link opens its original. The
**grid** shows the pictures, loading generated thumbnails rather than
originals. The choice is on the page's address (`?images=grid`), so a link
keeps it. The pencil on a row or card renames an image. Uploading and removing require **change**
permission on devices; everyone who can view the device sees the gallery
read-only. Files are stored under `/media/` and served same-origin.

The same **image gallery** appears on **rack**, **site**, and **location**
detail pages (on those it sits in the Overview) - one shared attachment system,
each scoped to its object and gated by that object's change permission.

The rows shown in _italics_ above - comments, airflow, location, coordinates,
and cluster - are **built-in fields** whose visibility is admin-controlled; a
device only shows the ones your administrator has enabled.

## Built-in fields

A handful of commonly-used attributes are promoted to **built-in device
fields** rather than custom fields:

| Field                    | What it holds                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| **Comments**             | Long-form notes about the device (multiline).                                                      |
| **Location**             | The [location](../features/regions-locations.md) within the site where the device lives.           |
| **Cluster**              | The virtualization/compute cluster the device belongs to.                                          |
| **Airflow**              | Cooling direction - front-to-rear, rear-to-front, left-to-right, right-to-left, passive, or mixed. |
| **Latitude / Longitude** | Geographic coordinates of the device.                                                              |

**Visibility is admin-controlled.** Each field can be turned on or off
deployment-wide from **Admin → Settings → Device fields** (requires
`users.manage`), so the device form and Overview only show the fields your
administrator has enabled:

| Field       | Shown by default |
| ----------- | ---------------- |
| `comments`  | Yes              |
| `location`  | Yes              |
| `cluster`   | No               |
| `airflow`   | No               |
| `latitude`  | No               |
| `longitude` | No               |

The setting is stored on the deployment singleton and read/written via
`GET`/`PUT /api/deployment/device-fields/` (a flat object of those six
booleans). Hidden fields disappear from the form and detail page, but any data
already set is preserved. If the setting can't be loaded, Danbyte falls back to
the same defaults.

### Other tabs

| Tab            | What's there                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------- |
| **IPs**        | Every IP address assigned to this device.                                                       |
| **Components** | Four sub-tabs: **Interfaces** (add, edit, and nest ports and attach IPs - see [Interfaces](interfaces.md)), **Console**, **Power**, and **Hardware** (device bays for child devices, module bays for line cards, serial-tracked inventory items, and patch-panel front/rear ports). |
| **Services**   | Application services running on the device.                                                     |
| **Contacts**   | People responsible for the device.                                                              |
| **Config**     | Configuration context and rendered config.                                                      |
| **Journal**    | Free-form notes and a running log you write.                                                    |
| **Change log** | An automatic record of changes - who changed what, when.                                               |

## Status

A device's **status** (active, offline, staged, …) shows as a colored badge.
The available statuses are yours to define - Danbyte doesn't ship a fixed list.

## Custom fields

Need to track something Danbyte doesn't have a field for - a warranty date, an
owner team, a maintenance window? Add a **custom field** for devices and it
appears on every device's form and Overview. See
[Tags & custom fields](../features/tags-and-custom-fields.md).

## Deleting a device

Use the **Delete** button in the device header. You'll be asked to confirm.
Deleting a device removes its interfaces and any IP assignments on them.

## Front panel

The device Overview draws a **front panel** - the device rendered as hardware,
at **true physical scale**: connector cages use their real millimetre
dimensions (SFP narrower than QSFP, RJ45 taller than both) on an
EIA-310-proportioned 1U bar. Ports lay out like the real faceplate (odd
numbers on top, even below, banked in twelves), media groups split where the
connector type changes, and color carries link state UniFi-style: sky for
10G+, emerald for 1G, amber below that, neutral for free ports, dashed for
disabled. Trunk ports carry a top notch. Hover any port for its name, type,
speed, VLAN (access/trunk + native), and IPs - click to open the interface.

Below the panel sits the **Topology card**: **Paths** lists one flat
end-to-end strip per cabled port (panels crossed `front ⇄ rear`, segments in
the cable's color); **Map** shows the React Flow neighbourhood; *Full map*
opens the [topology page](../features/topology.md) focused here. On the
**Interfaces** tab, every cabled row carries a **trace** button (the same
strip in a dialog) and uncabled physical rows a ghosted **connect** button
that pre-seeds the cable form with the port as side A.
The same renderer draws every member of a
[virtual chassis](virtual-chassis.md) in the stack view.

The layout is automatic by default; when the device's **type** has a saved
[faceplate layout](device-catalog.md#faceplate-builder) (built with the
drag-and-drop builder), the panel follows that instead - including console,
power, and aux ports placed on it. Layouts with a **rear side** add a
**Front / Rear** toggle above the panel.

On a **photo faceplate** (a type with
[photo ports](device-catalog.md#photo-ports)), the markers are work surfaces
too, permissions allowing. An **empty module bay** takes a click to seat a
module - the same install dialog as Components → Hardware, stamping the module
type's interfaces onto the device - and the bay marker flips to occupied on
save. The same works in the
[3D room](../features/floor-plans.md#the-3d-room-view): the port card offers
**Install module** on an empty bay and **Edit part** on a hardware marker (the
same part editor the 2D faceplate opens for disk bays and PSUs). A **free**
power / console / aux / front / rear marker connects a cable in place - see
[Cabling](cabling.md#connecting-from-a-port). Removing a module stays on the
Hardware tab.

Racked devices also show a **Rack** card - the whole rack drawn with this
device highlighted, linking to the [rack page](racks.md).

When the device has been **polled over SNMP**, each port also wears a small
**live dot** - emerald for oper-up, red for down, zinc for admin-down - and
the tooltip gains a `live:` line with the observed state and negotiated
speed. The overlay is read-only decoration from the monitoring collector:
observed facts are drawn *over* your intent, never written into it, so the
source of truth stays yours.

### The panel's key

The **speed ramp is always the full scale**, FE → 400G+, at a fixed width. It's a
scale, and a scale only means something if it reads identically on every page -
so it doesn't shrink to the speeds on the panel in front of you. (It briefly did.
With two speeds present, two segments split a fixed-width bar into two enormous
slabs, which looked like a different control rather than a shorter one.)

The **hardware key** does adapt, because its entries are chips and a shorter list
is just a shorter list: a server whose photo panel is nothing but disk bays gets
`Active · Empty`, not the tenant's whole inventory-status catalog.

A virtual chassis draws one key for the whole stack, unioning what its members
drew. In the [3D room](../features/floor-plans.md#the-3d-room-view) the key is
hidden entirely until something photo-anchored is in view.

## Adding many components at once

Any component you add to a device takes a **`[a-b]` range in its name** and
creates one component per number - the same shorthand as a device type's
[component templates](device-catalog.md#component-templates). Type
`Disk[1-5]` and you get Disk1 … Disk5; a live line under the Name field shows
the count and the first/last name before you submit.

It works on every add dialog on the device page:

| Tab           | Components                                                       |
| ------------- | ---------------------------------------------------------------- |
| **Interfaces**| interfaces (**Add interface**)                                   |
| **Console**   | console ports, console server ports                              |
| **Power**     | power ports (inlets), power outlets                              |
| **Hardware**  | inventory parts, patch-panel front and rear ports                |

Everything else on the dialog - type, speed, description, an outlet's inlet and
feed leg, tags - is applied to every component in the range, so a PDU's
`Outlet[1-24]` all hang off the same inlet in one submit. Ranges apply to
**creating** only: editing a component renames that one row.

Notes:

- The ports are created **one at a time, in order**. Names must be unique per
  device, so if one collides the error names the port that clashed and the ones
  created before it stay created.
- A range spanning more than **128** components is left alone and treated as a
  literal name - reach for **Bulk add** on the Interfaces tab instead, which
  goes through a server-side endpoint, preserves zero-padding
  (`Gi1/0/[01-48]`), and silently skips names the device already has. See
  [Interfaces](interfaces.md#add-many-interfaces-at-once).
- **Front ports** advance a second field as they go. A front port claims its own
  strand range on the rear port, and two of them may not share a strand - so the
  range steps the **Start strand** along with the name. `Front[1-24]` against a
  24-strand rear port starting at strand 1 wires the whole trunk through in one
  submit; with a 2-strand connector each port takes the next *pair*. Pick the
  rear port and starting strand once and the rest follows.

## Component descriptions

Every component a device can carry - interfaces, console and console server
ports, power ports and outlets, front and rear ports, aux ports, module and
device bays, inventory parts - has a short free-text **description** for notes:
what's on the far end, why a port is reserved, a ticket reference. It's a single
line (255 characters). Fill it in on the component's add/edit dialog, read it
back as a column in the component's table, and retype it across a whole
selection from the bulk-edit bar.

A component **template** on the device type has one too, and it's copied onto
every component stamped from it - so "reserved for out-of-band" written once on
the type reaches every device built from it. Editing the concrete component's
description afterwards doesn't touch the template.

## Bulk editing components

Every component table - interfaces, console ports, power ports/outlets,
front/rear ports on a device; VM interfaces; and the component templates on a
device type - supports bulk editing. Tick rows and a floating bar appears:

- **Edit** opens a dialog where every field starts on **Keep current**; only
  the fields you explicitly set are applied to the selected rows. Booleans are
  tri-state (keep / yes / no), interface VLAN/VRF offer *Clear*, and tags can
  be added/removed without overwriting each row's other tags.
- **Delete** removes the selection after a confirmation.

Changes go through `POST /api/<component>/bulk-update/` (`{ids, fields}`) and
`bulk-delete/` (`{ids}`) - allow-listed fields per type, tenant-scoped,
audited in the change log like any other edit.
