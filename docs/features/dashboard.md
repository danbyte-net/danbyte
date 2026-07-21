---
icon: lucide/layout-dashboard
---

# Dashboard

The dashboard is your home page — a customizable, at-a-glance view of your
network built from live IPAM, DCIM, and monitoring data for the current tenant.

## Reading the dashboard

The page is a mosaic of tiles:

- **Stat tiles** — single big numbers you can click through to the full list: IP
  addresses, prefixes, devices, sites, VLANs, and firing alerts.
- **Chart widgets** — breakdowns and gauges, such as reachability, IPs by status
  or role, prefixes by family, devices by type or site, and your busiest
  prefixes by utilization. The **donut legends and bars are clickable** — click a
  slice or bar to jump to that object's list (e.g. a *Devices by type* bar → the
  Devices list).
- **Map widgets** — a live **OSM map** of your sites/devices/cables, and a
  **Floor plan** widget that renders one of your floor plans read-only with live
  tile status (monitoring rings + rack utilisation), each linking to its full
  page.

Colours come from your own statuses and roles where you've set them, so the
charts speak your network's language.

## Customizing it

You decide which widgets to show and in what order.

| Action | Effect |
|---|---|
| **Add widget** | Opens a list of widgets you haven't added yet. |
| **× on a widget** | Removes that widget. |
| **Reset** | Restores the default layout. |

!!! note
    Your dashboard layout is saved in your browser, so it's per-device. Setting
    it up again on another computer takes a moment.

## Related

- [Monitoring](monitoring.md) — where reachability and alert data come from.
- [Tags & custom fields](tags-and-custom-fields.md) — define the statuses and
  roles that colour your charts.
