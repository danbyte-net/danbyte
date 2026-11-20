---
icon: lucide/boxes
---

# Inventory & stock

Danbyte keeps one inventory of physical parts across the tenant: every
[inventory item](inventory.md) - transceivers in ports, disks, PSUs and
fans on devices - and every installed [module](device-catalog.md#module-types),
plus the **stock pool**: parts that are on no device, kept at a site and
location ("Spares cabinet", "Transceiver box 3").

A part keeps its serial, part ID, asset tag, tags and change log through
every move: from a port to stock, from stock into another device's port,
from a module bay to a shelf and back.

## Where a part is

An inventory item has exactly one home:

| Home | Meaning |
|---|---|
| **In a port** | A transceiver seated in an interface of its device. |
| **On a device** | A part recorded on a device, in no port: a disk, a fan, a spare optic kept in the chassis. |
| **In stock** | On no device: at a **site** and, optionally, a **location** there. |

An installed module is **in a bay**. A module taken out into inventory
becomes an inventory item of kind **Module** that remembers its module
type; installed again, it is a module again. Both forms share one id, so
the unit has one history.

The database holds this: an item has a device, or a site (with a location
of that site), never both and never neither. Items recorded before the
stock pool keep their device.

## Inventory states

Where a part stands is its **status**, from the tenant's
[status catalog](../features/catalogs-and-settings.md#statuses) - edit, rename, recolour or add
statuses there. Every tenant gets these for inventory items:

| Status | Meaning |
|---|---|
| **Active** | In service on its device. The default for a new item. |
| **Spare** | Kept on a device, not in use. |
| **In Stock** | In the stock pool. |
| **RMA** | Sent back, or going back, to the vendor. |
| **Scrapped** | Written off. |
| **Planned**, **Failed**, **Empty** | As before: on order, broken, an empty bay. |

Moves set the status, so it stays true without upkeep: a part moved to stock
becomes **In Stock**, one kept on its device **Spare**, one seated in a port
the default (**Active**). A move can name another status (Scrap / RMA
does). A tenant that removed one of these statuses keeps the part's status
as it was. In Stock, RMA and Scrapped are added to existing tenants by the
upgrade, the same way the other built-in statuses are; a tenant's own
status with the same slug is left as it is.

A module in a bay carries the module statuses (Active, Failed…) as before.

## Removing a part

**Remove** on a transceiver (the interface's Overview) or a module (the
device's Hardware tab, or a bay in the 3D viewer) asks where it goes:

- **Move to stock** (the default): pick the **site** - the device's site to
  start with - and a **location**. The location last used for that site is
  offered first (remembered in your browser).
- **Keep on device**: the part stays on the device, out of its port or bay,
  as **Spare**.
- **Scrap / RMA**: like Move to stock, with a status - **RMA** to start
  with, or **Scrapped**.
- **Delete** (modules only): removes the module and its record, as Remove
  did before.

Taking a module out removes the interfaces and power ports it brought, as
before; their cables and addresses follow the usual
[module rules](device-catalog.md#module-types). The stock item keeps the
module's type, serial, asset tag, description and tags, and the custom
fields whose definition applies to inventory items too.

## Installing from stock

- **Set transceiver** on an interface has three sources: **On this
  device** (its spare optics), **From stock** and **New**. From stock lists
  the transceivers in stock that fit the port - their
  [pluggable](pluggables.md) lists the port's type - and those whose part is
  not known, the device's site first, then the other sites you may view.
  With nothing spare on the device the dialog opens on From stock, or on New
  when stock has none either.
- **Install…** on an empty module bay offers **New** or **From stock**: a
  module kept in stock is installed with its type, serial and history, its
  interfaces stamped as on any install (and refused, or adopted, the same
  way).

A part installed on a device takes a name free on that device: its own, or
its own with a number after it.

## The Inventory page

**DCIM → Inventory** lists every part: name, part ID, serial, status, kind,
where it is, its device with its port or bay, site, location, manufacturer,
asset tag, description and when it last changed.

- **All**, **Stock** and **Counts** views. Stock is the stock pool alone.
  Counts groups the parts by part number (else name), kind, manufacturer,
  site and location, with how many there are - "how many SFP-10G-SR are in
  the AMS spares box".
- **Filters:** status, kind, where, site, location and manufacturer in the
  rail, and the search box (name, part ID, serial, asset tag, device,
  description). Every column sorts. **Download** exports the filtered list
  as CSV or Excel.
- **PDF report…** makes the [inventory report](#inventory-report) of what
  the filters show.

It is paged and counted on the server. It needs view on inventory items or
modules, and shows each to a reader who may view that type at its site.

## Inventory report

**PDF report…** on the Inventory page makes a PDF of the parts the page's
filters show. It holds, as ticked:

- **Totals** - how many by status, and by kind;
- **Counts per part** - per part number, manufacturer, kind, site and
  location;
- **Items** - every part with its serial, asset tag, status, device and
  port or bay, site and location (at most 20,000 rows; the rest are counted).

The header names the filters. Paper, orientation and an optional cover
(the tenant's [report cover](../features/reports.md#cover-page)) are picked in the
dialog; **Print** opens it in a tab to print. A report too large to render
in time is refused with what fits - narrow the filters or leave out the
items.

## Permissions

- An item in stock is scoped by its site, as a part on a device is scoped
  by the device's: a site-scoped grant sees and changes only the stock at
  its sites (RBAC path `device__site|site`).
- **Move** needs change on inventory items where the part is and where it
  lands. **Taking a module out** needs delete on modules (it removes the
  module's interfaces, as Remove did) and add on inventory items where it
  lands. **Installing a module from stock** needs change on inventory items
  and add on modules at the bay's device.
- Every id in a request - site, location, device, port, bay, status - must
  be in the current tenant.
- Moves are in the change log of the item (and of the module, for a module
  taken out or installed).

## API

| Endpoint | Does |
|---|---|
| `GET /api/inventory-items/?home=stock` | The stock pool. `home` takes `stock`, `device`, `port` (comma-separated); also `location`, `status` (ids), `fits=<interface type>` (transceivers that fit, or whose part is unknown) and `near_site=<id>` (that site's first). |
| `POST /api/inventory-items/` | Creates an item on a device (`device_id`) or in stock (`site_id`, `location_id`). |
| `POST /api/inventory-items/{id}/move/` | `{site_id, location_id?, status_id?}` to stock, or `{device_id}` / `{interface_id}` onto a device or into a port. |
| `POST /api/inventory-items/{id}/install-module/` | `{module_bay_id, status_id?, adopt_components?}`: the module kept in stock into a bay; answers the module, as an install does. |
| `POST /api/modules/{id}/remove/` | `{site_id, location_id?, status_id?}` or `{device_id}`: the module out of its bay as an inventory item. |
| `GET /api/inventory/` | The Inventory page's rows (items and installed modules): `view=table`, `f_<facet>`, `ordering`, `search`, `page`, `page_size`. Facets: `home`, `kind`, `status`, `site`, `location`, `manufacturer`, `device`, `module_type`. |
| `GET /api/inventory/facets/`, `/api/inventory/table-ids/` | The rail's counts, every matching id. |
| `GET /api/inventory/counts/` | The Counts view: `{part, kind, manufacturer, site, location, count}` rows, same filters; `ordering` by `part`, `kind`, `manufacturer`, `site`, `location` or `count`. |
| `GET|POST /api/inventory/report/` | Describes, or makes, the inventory report: `{title, filters: {f_…, search}, sections: [totals, counts, items], options: {paper, orientation, cover, cover_title, cover_subtitle, cover_project, cover_background, sensitivity_label}}`; `?estimate=1`, `?print=1`. |

An inventory item's read carries `home` (`port`, `device` or `stock`),
`site` (its device's, else its stock site), `location` and `module_type`.
Writing `site_id` moves an item off its device; writing `device_id` moves it
out of stock.

The Inventory page reads a database view (`api_inventory_entry`) over the
items and modules; a migration that alters a column it reads drops and
recreates it (`core.tests_migration_safety` checks it).
