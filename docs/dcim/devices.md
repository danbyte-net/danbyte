---
icon: lucide/server
---

# Devices

A **device** is a single physical box — a switch, router, firewall, server, PDU,
anything you rack and cable. This page covers creating one and reading its
detail page.

## Add a device

1. Open **DCIM → Devices** in the sidebar and click **Add device**.
2. Give it a **name** (must be unique within the tenant).
3. Pick a **device type** — the hardware model. Don't have it yet? Create it
   first on the [Device catalog](device-catalog.md) page; it only takes a moment
   and you'll reuse it for every device of that model.
4. Optionally set the **site**, **location**, **role**, **platform**,
   **cluster**, **status**, **serial number**, and **asset tag**.
5. Optionally fill the **built-in extras** — **comments**, **airflow**, and
   **latitude / longitude**. Which optional fields appear is controlled by your
   administrator (see [Built-in fields](#built-in-fields) below), so you may not
   see all of them.
6. Save.

!!! note "Built-in fields vs. custom fields"
    Danbyte ships a curated set of common attributes as built-in device
    fields — including **comments**, **location**, **cluster**, **airflow**,
    and **latitude** / **longitude**. Comments, location, and the
    coordinates are on by default (coordinates put a device on the
    [site map](../features/site-map.md)); cluster and airflow are opt-in
    under **Settings → Device fields**. Anything beyond that stays a
    [custom field](../features/tags-and-custom-fields.md), in line with the
    zero-pre-filled-data philosophy.

You can also add devices in bulk from a spreadsheet — see
[Import & export](../features/import-export.md).

## Picking a device

Anywhere Danbyte asks you to choose a device — assigning an IP, adding an
interface, terminating a tunnel or L2VPN, attaching a MAC address, adding a
virtual-chassis member, setting a VM's host — you get the same **device
picker**.

- **Type to search.** The picker is a searchable box; start typing a name and
  it narrows as you go. This is all you need when you know roughly what the
  device is called.
- **Advanced search.** When a name isn't enough — you're staring at hundreds of
  devices and want "the access switches in Amsterdam that are active" — click
  the **sliders** button beside the box. A dialog opens where you can filter by
  **tag**, **manufacturer**, **device type**, **role**, **status**, **site**,
  **location**, and **region**, alongside free-text search. Results come back
  in a table (name, type, role, site, status); click a row to select it.

Filtering by a **region** includes every site in that region *and its
sub-regions* — pick "Europe" and you'll see devices in Netherlands → Amsterdam
too, without selecting each child. All filtering runs on the server and
respects your tenant and permission scope, so the picker only ever shows
devices you're allowed to see.

## The device page

Open any device to see its detail page. A slim header shows the name, status,
tags, and description; below it is a row of tabs. If the device is a member of
a switch stack, a **Stack** badge in the header (name, position, master) links
to its [virtual chassis](virtual-chassis.md) — membership is set in the
**Stack membership** section of the device's edit form.

### Overview tab

The default tab lays the device's facts out in four cards:

| Card           | Shows                                                        |
| -------------- | ------------------------------------------------------------ |
| **Device**     | name, status, role, platform, description, comments          |
| **Hardware**   | device type, serial number, asset tag, height (U), airflow   |
| **Location**   | site, location, rack, position, face, coordinates            |
| **Management** | cluster, primary IP, its DNS name, and IP / interface counts |

Technical values (name, serial, asset tag, primary IP, DNS name) have a small
**copy button** so you can grab them in one click. Any **custom fields** you've
defined for devices appear below the cards. If any of the device's IPs are
monitored, a **Monitoring** summary (roll-up badge + per-IP grid) appears at the
**top** of the tab — see [Monitoring](../features/monitoring.md#on-a-device).
The Devices list also has a **Monitoring** column rolling that status up per
device. Where the device physically sits — its **rack elevation** with this
device highlighted — is drawn compactly (front **and** rear side by side) in the
right column; it's hidden for unracked devices. If the device's **type** has a
rack-face image, that front/rear photo shows below the cards too.

### Images

Uploaded photos and diagrams live on their own **Images** tab (rack shots,
labels, cabling pictures, faceplate close-ups). Click **Add image** to upload;
hover an image and click the trash icon to remove it, or click an image to open
the full-size original in a new tab. Uploading and removing require **change**
permission on devices; everyone who can view the device sees the gallery
read-only. Files are stored under `/media/` and served same-origin.

The same **image gallery** appears on **rack**, **site**, and **location**
detail pages (on those it sits in the Overview) — one shared attachment system,
each scoped to its object and gated by that object's change permission.

The rows shown in _italics_ above — comments, airflow, location, coordinates,
and cluster — are **built-in fields** whose visibility is admin-controlled; a
device only shows the ones your administrator has enabled.

## Built-in fields

A handful of commonly-used attributes are promoted to **built-in device
fields** rather than custom fields:

| Field                    | What it holds                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| **Comments**             | Long-form notes about the device (multiline).                                                      |
| **Location**             | The [location](../features/regions-locations.md) within the site where the device lives.           |
| **Cluster**              | The virtualization/compute cluster the device belongs to.                                          |
| **Airflow**              | Cooling direction — front-to-rear, rear-to-front, left-to-right, right-to-left, passive, or mixed. |
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
| **Interfaces** | The device's ports — add, edit, and nest them, and attach IPs. See [Interfaces](interfaces.md). |
| **Services**   | Application services running on the device.                                                     |
| **Hardware**   | Device bays (install child devices), module bays (install/remove line cards), inventory items (serial-tracked parts) and patch-panel front/rear ports.                                                                   |
| **Contacts**   | People responsible for the device.                                                              |
| **Config**     | Configuration context and rendered config.                                                      |
| **Journal**    | Free-form notes and a running log you write.                                                    |
| **History**    | An automatic change log — who changed what, when.                                               |

## Status

A device's **status** (active, offline, staged, …) shows as a colored badge.
The available statuses are yours to define — Danbyte doesn't ship a fixed list.

## Custom fields

Need to track something Danbyte doesn't have a field for — a warranty date, an
owner team, a maintenance window? Add a **custom field** for devices and it
appears on every device's form and Overview. See
[Tags & custom fields](../features/tags-and-custom-fields.md).

## Deleting a device

Use the **Delete** button in the device header. You'll be asked to confirm.
Deleting a device removes its interfaces and any IP assignments on them.

## Front panel

The device Overview draws a **front panel** — the device rendered as hardware,
at **true physical scale**: connector cages use their real millimetre
dimensions (SFP narrower than QSFP, RJ45 taller than both) on an
EIA-310-proportioned 1U bar. Ports lay out like the real faceplate (odd
numbers on top, even below, banked in twelves), media groups split where the
connector type changes, and color carries link state UniFi-style: sky for
10G+, emerald for 1G, amber below that, neutral for free ports, dashed for
disabled. Trunk ports carry a top notch. Hover any port for its name, type,
speed, VLAN (access/trunk + native), and IPs — click to open the interface.

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
drag-and-drop builder), the panel follows that instead — including console,
power, and aux ports placed on it. Layouts with a **rear side** add a
**Front / Rear** toggle above the panel.

Racked devices also show a **Rack** card — the whole rack drawn with this
device highlighted, linking to the [rack page](racks.md).

When the device has been **polled over SNMP**, each port also wears a small
**live dot** — emerald for oper-up, red for down, zinc for admin-down — and
the tooltip gains a `live:` line with the observed state and negotiated
speed. The overlay is read-only decoration from the monitoring collector:
observed facts are drawn *over* your intent, never written into it, so the
source of truth stays yours.

## Bulk editing components

Every component table — interfaces, console ports, power ports/outlets,
front/rear ports on a device; VM interfaces; and the component templates on a
device type — supports bulk editing. Tick rows and a floating bar appears:

- **Edit** opens a dialog where every field starts on **Keep current**; only
  the fields you explicitly set are applied to the selected rows. Booleans are
  tri-state (keep / yes / no), interface VLAN/VRF offer *Clear*, and tags can
  be added/removed without overwriting each row's other tags.
- **Delete** removes the selection after a confirmation.

Changes go through `POST /api/<component>/bulk-update/` (`{ids, fields}`) and
`bulk-delete/` (`{ids}`) — allow-listed fields per type, tenant-scoped,
audited in the change log like any other edit.
