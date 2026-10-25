---
icon: lucide/calendar-clock
---

# Lifecycle overview

**DCIM → Devices → Lifecycle** lists every device and virtual machine
against the end dates that matter to it, soonest first: the hardware's end of
support, the operating system's end of life, the end of the device's
support coverage and the end of life of the software installed on it. It
answers "what goes out of support next, and where?"
across the estate. It is in the sidebar for anyone who may view devices or
virtual machines.

Nothing ships pre-filled. The dates come from what you enter on
[device types and platforms](lifecycle.md), the
[end-of-life data](end-of-life-data.md) you map platforms and applications
to, your [support contracts and warranties](support-coverage.md), and the
[installed software](applications.md) recorded on devices and VMs.

## Sources

Each object gets **one row per source**, so a device with a healthy chassis
and an operating system that ends next month sorts by the operating system,
and the chassis keeps its own row.

| Source | Start | End | Warning window |
|---|---|---|---|
| **Hardware** | the device type's *Released* | its *End of support* | the end-of-life warning window (180 days by default) |
| **OS** | the platform's [effective](lifecycle.md#the-effective-os-date) start | its effective end: *End of support* as entered, else its end-of-life cycle's end of life | the end-of-life warning window |
| **Coverage** | the start of the contract that sets the coverage end | the coverage end: the latest contract end or the warranty end | the tenant's coverage window (90 days by default) |
| **Software** | the install's *Released*, else its cycle's release | the install's *End of support*, else its cycle's end of life | the end-of-life warning window |

- Hardware and coverage rows are devices'; OS rows are devices' and virtual
  machines'. The OS is the object's own platform.
- Software rows are one per [install](applications.md#installed-software):
  a device running PostgreSQL 16 and Java 17 has two. The cycle comes from
  the install's version and the application's end-of-life product; dates
  entered on the install win, as on a platform.
- An OS cycle's dates count only while end-of-life data is on; what you
  entered on the platform always wins.
- A coverage row names its contract, or *Warranty* when the warranty reaches
  further. A contract you may not view reads *Contract*, with no number and
  no start.

The **status** is each source's own: *Supported*, *Support ending*, *End of
life* or *Unknown* for hardware, OS and software (from the end and the end-of-life
warning window), *Covered*, *Expiring*, *Expired* or *Not covered* for
coverage.

## Windows

Every row falls in one fixed window, the same for every source, so sources
compare on one scale:

| Window | When |
|---|---|
| Past | The end has passed. An end of life counts from its day; a coverage end is the last covered day. A cycle its source marks end of life without a date is Past too. |
| ≤ 90 d | Ends within 90 days. |
| ≤ 180 d | Within 180 days. |
| ≤ 1 y | Within a year. |
| Later | Later than that - or never: an open-ended contract, or a cycle its source says is maintained without a date. |
| No date | No end and no state: no dates entered, nothing mapped, nothing covers the device. |

Rows with no date are counted but left out of the list unless you ask for
them.

## The page

Above the table, a **count chip per window** - *Past 12*, *≤ 90 d 7*, … *No
date 41* - counts every row you may view, whatever the rail has ticked.
Clicking a chip ticks that window in the **Window** facet; clicking it again
unticks it. *No date* also lists the undated rows.

| Column | Shows |
|---|---|
| Object | The device or VM, linked |
| Kind | Device or VM |
| Source | Hardware, OS, Coverage or Software |
| Item | The device type, the platform, the contract number (or *Contract* when you may not view it), *Warranty*, or the application and version - linked |
| Status | The source's own badge |
| Lifetime | The [lifetime bar](lifecycle.md#the-lifetime-bar): the share used and a countdown, the date in its tooltip - with *Entered* or *endoflife.date* on an OS row. No end but a state is that state's badge (*End of life*, *Open-ended*) |
| End | The end date; on a software row it links to the application's End of life card |
| Days left | Negative once past; the default order |
| Site, Role, Manufacturer | The device's or VM's own |

*Application* (software rows, linked), *Window*, *Tenant* and *Tags* are
in the **Columns** menu. The rail has facets for Source, Application,
Window, Status, Site, Role, Manufacturer, Kind and Tag,
and **Show undated** adds the rows with no date. The search box matches the
object and the item.

- **Deep links** - the facets live in the URL, so a link lands filtered:
  `/lifecycle?source=coverage&window=90` is the coverage that ends within 90
  days, `/lifecycle?window=past` everything already past,
  `/lifecycle?source=software&application=<id>` one application's installs
  (its page's *Installs* count links there). `undated=1` shows the undated
  rows.
- **Export** - the table's **Download** menu (CSV, Excel, HTML, print)
  exports the rows as filtered, or the ticked ones; the Lifetime column
  exports its end date and the Status column its label.
- **Saved views** - the page keeps its own views, separate from the Devices
  list's.

With no dated rows at all, the page says where the dates come from: device
types, platforms and **Settings → General → End-of-life data**.

## Versions view

**Objects | Versions** in the header switches the page. **Versions** counts
the devices and virtual machines per platform and running
[software version](lifecycle.md#where-the-running-version-comes-from) -
one row per platform and version, sorted by platform, then version in
natural order (`17.9.4` before `17.9.4a` before `17.10.1`). Objects with no
version recorded are a *No version* row of their platform.

| Column | Shows |
|---|---|
| Platform | The object's own platform, linked; *No platform* without one |
| Version | The running version |
| Devices, VMs | How many run it - each count links to the Devices or Virtual machines list filtered to that platform and version (and the view's sites and roles) |
| Target | *On target* or *Off target* against the platform's target version; empty without a version or a target |
| Source | How many of them got the version from each source: *SNMP 12 · Manual 2* |

The rail filters by **Site**, **Platform** and **Role**; the counts follow
it. The search box matches the platform and the version. The view's link is
`/lifecycle?view=versions`, with `site`, `platform` and `role` ids in the
URL when filtered.

## Permissions

The overview shows what you may view and nothing else:

- Devices and virtual machines are cut to your grants, site scope included.
  Without a grant on devices there are no hardware, coverage or device OS
  rows; without one on virtual machines no VM rows. Software rows need a
  grant on installed software and on the device or VM they run on.
- A contract's number and start show only on a contract you may view.
- The Versions view counts the devices and VMs you may view, site scope
  included; the rail's options list only their sites, platforms and roles.

## API

`GET /api/lifecycle/` - any signed-in user with an active tenant; the rows
follow the grants above.

| Parameter | |
|---|---|
| `source` | Comma-separated: `hardware`, `os`, `coverage`, `software`. Default: all. |
| `site` | A site id: only that site's devices and VMs. |
| `undated` | `1` also lists the rows with no date. |

```json
{
  "results": [
    {
      "object": {"id": "…", "name": "core-sw-01", "kind": "device"},
      "source": "os",
      "item": {"type": "platform", "id": "…", "name": "IOS XE 17.9",
               "date_source": "endoflife_date"},
      "status": "ending",
      "start": "2022-08-01",
      "end": "2026-11-30",
      "days_left": 39,
      "window": "d90",
      "site": {"id": "…", "name": "HQ"},
      "role": {"id": "…", "name": "Core", "color": "#2563eb"},
      "tenant": {"id": "…", "name": "Acme"},
      "manufacturer": {"id": "…", "name": "Cisco"},
      "tags": []
    }
  ],
  "counts": {"past": 3, "d90": 7, "d180": 4, "y1": 12, "later": 210, "none": 41},
  "windows": {"eol_warning_days": 180, "coverage_warning_days": 90},
  "eol_enabled": true
}
```

- `kind` is `device` or `virtualmachine`; `item.type` is `devicetype`,
  `platform`, `supportcontract`, `warranty` or `application`. `item.date_source`
  on an OS or software row is `entered` or the end-of-life source; a software
  row also carries `application`, `version` and `install` (the install id).
- `days_left` is negative once the end has passed; `end` and `days_left` are
  `null` without a date. `window` is `past`, `d90`, `d180`, `y1`, `later` or
  `none`.
- `counts` covers every row the request reaches, the undated ones included,
  whether or not they are listed.
- Rows come sorted by window, then days left.

The rows are read in a fixed number of queries however large the estate is,
and worked out when they are read, so a window moves with the calendar.

`GET /api/lifecycle/versions/` - the Versions view.

| Parameter | |
|---|---|
| `site`, `platform`, `role` | An id, or several comma-separated; `none` for objects without one. Ids of another tenant match nothing. |

```json
{
  "results": [
    {
      "platform": {"id": "…", "name": "IOS-XE", "target_version": "17.9.5"},
      "version": "17.9.4a",
      "devices": 12,
      "virtual_machines": 1,
      "on_target": false,
      "sources": {"snmp": 11, "manual": 2}
    }
  ],
  "facets": {
    "site": [{"id": "…", "name": "HQ", "count": 40}],
    "platform": [{"id": "…", "name": "IOS-XE", "count": 13}],
    "role": [{"id": null, "name": "", "count": 3}]
  }
}
```

`platform` is `null` for objects without one; `version` is `""` for the
objects with no version. `on_target` is `null` without a version or a
target. `sources` keys are the version sources, `none` for no source.
`facets` count the objects you may view before the filters.
