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

Colours come from your own statuses and roles where you've set them, so the
charts speak your network's language.

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
| **Drag the ⠿ handle** | Reorder - the other tiles re-flow live as you drag, and the order saves on drop. |
| **× on a widget** | Removes that widget. |
| **Reset** | Restores the built-in default layout. |
| **Set as new-user default** *(admins)* | Saves your current layout as the starting dashboard for new users of the tenant. |

!!! note
    Your own dashboard layout is saved in your browser, so it's per-device. New
    users start from the tenant's admin-set default (if one is set), otherwise
    the built-in layout.

## Related

- [Monitoring](monitoring.md) - where reachability and alert data come from.
- [Tags & custom fields](tags-and-custom-fields.md) - define the statuses and
  roles that colour your charts.
