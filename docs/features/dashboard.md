---
icon: lucide/layout-dashboard
---

# Dashboard

The dashboard is your home page - a customizable, at-a-glance view of your
network built from live IPAM, DCIM, and monitoring data for the current tenant.

## Reading the dashboard

The page is a mosaic of tiles:

- **Stat tiles** - single big numbers you can click through to the full list: IP
  addresses, prefixes, devices, sites, VLANs, and firing alerts.
- **Chart widgets** - breakdowns and gauges, such as reachability, IPs by status
  or role, prefixes by family, devices by type or site, and your busiest
  prefixes by utilization. The **donut legends and bars are clickable** - click a
  slice or bar to jump to that object's list (e.g. a *Devices by type* bar → the
  Devices list).
- **Map widgets** - a live **OSM map** of your sites/devices/cables, and a
  **Floor plan** widget that renders one of your floor plans read-only with live
  tile status (monitoring rings + rack utilisation), each linking to its full
  page.
- **Certificate widgets** - **Certificate health** (expiry buckets across the
  whole inventory), **Expiring certificates** (expired or within 30 days), and
  **Expired certificates** (already past expiry). Add them from *Add widget*.
- **Activity widgets** - **Changelog** (the latest audit changes across the
  tenant: who changed what, each linking to the full change and out to the audit
  log) and **Recent activity** (latest monitoring status changes).
- **Monitoring widgets** - **Availability** (seven days, time reachable over
  time measured, as a gauge), **Alerts per day** (opened against resolved, the
  last seven days), **Latency** (median and 95th percentile per hour over
  the week, one check kind at a time, busiest first), **Flapping** (the checks currently flagged, with a
  link to confirm them) and **Status history** (the status strips of the
  addresses and devices you pick - the same strip and availability figure
  their Monitoring tabs draw, over 1h to 90d, refreshed every minute; pick
  them while editing the dashboard - tick several in the picker, or in its
  advanced search, and add them in one go - up to twelve per widget, and add
  the widget more than once to watch different sets). Add them from *Add
  widget*; all follow the same site scoping as the monitoring pages.

Colours come from your own statuses and roles where you've set them, so the
charts speak your network's language. A donut fills the tile: in a wide tile
the legend sits beside the ring and takes only the width its names need; in a
narrow one the ring sits on top and the legend flows underneath.

Every chart segment is a **deep link**: click a slice or bar (or a legend row)
and it opens the matching list already filtered - *IPs by status* → the IP list
for that status, *Devices by type* → those devices, *Firing alerts by severity*
→ the alerts list, and so on. The monitoring **Certificate & key health** tiles
work the same way.

## Customizing it

Click **Edit layout** to rearrange; the dashboard stays clean and read-only
otherwise. In edit mode each tile gets a drag grip and a remove button.

| Action | Effect |
|---|---|
| **Edit layout / Done** | Toggle edit mode on/off. |
| **Add widget** | Opens a list of widgets you haven't added yet. |
| **Drag the ⠿ handle** | Move the widget - it snaps to grid cells and the others re-pack live. |
| **Drag the corner grip** | Resize - also snapping to cells. Each widget has sensible min/max sizes, so the changelog can go full-width (or near full-screen) while a small gauge can't be stretched into empty border. |
| **× on a widget** | Removes that widget. |
| **Reset** | Drops *your* layout: you fall back to the tenant's admin-set default when one exists, else the built-in layout. |
| **Set as new-user default** *(admins)* | Saves your current layout as the starting dashboard for new users of the tenant. (Until 0.17 a layout saved this way was ignored and new users got the built-in one.) |

Widgets cope with their given size: lists and tables scroll inside the tile,
charts sit centred, and the map / floor plan stretch to fill.

!!! note
    Your layout (positions **and** sizes) is saved **to your account**, so it
    follows you across browsers and devices. A layout saved before this
    existed is picked up from the browser and adopted automatically - nothing
    resets. New users start from the tenant's admin-set default (if one is
    set), otherwise the built-in layout.

## Named dashboards

Besides your own dashboard, you can build named ones: "Aarhus DC", "Core
SLA", the NOC wall. The dashboard title is a switcher. It lists your own
dashboard, every named one you can see, and **All dashboards**
(`/dashboards`), where **New dashboard** starts one.

A named dashboard has its own layout and settings:

| Setting | What it does |
|---|---|
| **Who sees it** | Only you, everyone in the tenant, or chosen groups. You can share with groups you are in; someone who manages users can share with any group. |
| **Time frame** | 24 hours, 7, 30 or 90 days, for the monitoring charts and the figure widgets. |
| **Refresh** | When opened, or every 30 seconds up to 15 minutes. |
| **Scope** | Sites, regions, device roles, device types, tags and SLAs. Widgets that support it show only what matches. Empty means everything. |

Only the owner can edit a named dashboard. Anyone who can see one can
**Duplicate** it into a private copy of their own, or pick **Open as my
dashboard**, so that the Dashboard link opens it instead of their own layout.
**Stop opening this one**, or **My dashboard** in the switcher, goes back.

Every widget loads its data with the **viewer's** permissions, never the
owner's. A shared dashboard shows each viewer only what they could already
see.

A scope narrows what the widgets count:

- **Devices** match on their own site, role, type and tags.
- **Addresses** match on their site, their prefix's site or their device's
  site, and on their device's role and type.
- **Prefixes** match on their site and tags.
- An **SLA** scope means the addresses of that agreement's members.
- **Monitoring widgets** (check status, alerts, availability, latency,
  flapping, recent activity) follow the scoped addresses.
- The **figure widgets** below take the whole scope.
- **Counts of VLANs, VRFs, cables, interfaces, BGP sessions and static
  routes** stay tenant-wide.

### TV mode

**TV** shows the dashboard full screen with nothing else on the page, for a
wall display. To cycle through several dashboards, give the URL a list:
`/dashboards/<id>?tv=1&cycle=<id1>,<id2>,<id3>&every=60`. Each dashboard
stays up for `every` seconds, 10 at the least.

### Widgets for SLAs and monitoring figures

| Widget | What it shows |
|---|---|
| **SLA** | One agreement's figure against its target. A bar shows the error budget spent, with a mark for how much of the period has gone. Pick the agreement while editing; add the widget more than once for several. |
| **SLAs** | Every active agreement with this period's figure and budget left. |
| **Availability by group** | Availability per site, role, device type or check type, worst first. |
| **Slowest against normal** | The checks furthest above their own usual latency. |
| **Coverage** | How much of the time was measured, overall and per check type. |
| **Maintenance** | Maintenance and outage events not yet closed, soonest first. |

The figure widgets read the [rollups](monitoring.md#rollups), so they cover
the whole time frame even beyond the raw results' thirty days.

## Related

- [Monitoring](monitoring.md) - where reachability and alert data come from.
- [Tags & custom fields](tags-and-custom-fields.md) - define the statuses and
  roles that colour your charts.
