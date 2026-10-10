---
icon: lucide/zap
---

# Power

Power is where you record how electricity reaches your racks - the
**distribution panels** in a site and the **feeds** that run from those panels to
individual racks.

You build it in two layers: **power panels** (the distribution boards) and the
**power feeds** that draw from them.

## Add a power panel

A power panel is a distribution board within a site.

1. Open **Power → Power panels** in the sidebar and click **Add power panel**.
2. Pick the **site** the panel lives in.
3. Optionally pick a **location** in that site - the building, floor or room
   the panel is in. Only the site's locations are offered; changing the site
   clears it.
4. Give it a **name** (must be unique within that site).
5. Optionally add **comments**, tags, and any custom fields.
6. Save.

The **Power panels** list has a **Location** column to sort and filter by. In
the API a panel carries `location` (id and name) and takes `location_id`;
`GET /api/power-panels/?location=<id>` lists a location's panels.

## Add a power feed

A power feed is a circuit running from a panel, optionally delivered to a
specific rack.

1. Open **Power → Power feeds** and click **Add power feed**.
2. Choose the **panel** it comes from, and give the feed a **name** (unique
   within that panel).
3. Optionally point it at a **rack** - the rack this feed powers.
4. Set the electrical details (see below) and a **status**.
5. Save.

### Feed details

| Field | What it records |
|---|---|
| **Status** | planned, active, offline, or failed. |
| **Type** | primary or redundant. |
| **Supply** | AC or DC. |
| **Phase** | single-phase or three-phase. |
| **Voltage** | the supply voltage (volts). |
| **Amperage** | the rated current (amps). |
| **Max utilization** | a percentage ceiling - the most of this feed you plan to draw. |

### Open a feed or a panel

Clicking a name in **Power → Power feeds** or **Power → Power panels** opens
that object's detail page, the same way every other object in Danbyte works.

A **power panel** page has:

- **Overview** - its site and location, how many feeds draw from it,
  comments, and when it was created and last changed.
- **Feeds** - every feed on the panel, the same row the feeds list draws;
  tick feeds to edit or delete several at once.
- **Journal** - your notes on this panel.
- **Change log** - who changed which field, and when.

A **power feed** page has:

- **Overview** - the panel it draws from (a link), the rack it delivers to,
  status and type, and the electrical details (supply, phase, voltage,
  amperage, max utilization).
- **Terminations** - the cables landing on this feed, usually the PDU inlet it
  powers. Follow one to trace the whole power path.
- **Journal** and **Change log**, as above.

!!! note "Max utilization is a plan, not a measurement"
    Danbyte records the ceiling you set. It does not meter the feed, so the
    page states the ceiling rather than a live draw against it.

### Feed status

| Status | Meaning |
|---|---|
| **Planned** | Designed but not yet energized. |
| **Active** | Live and in service. |
| **Offline** | De-energized or administratively down. |
| **Failed** | Faulted or out of service unexpectedly. |

!!! note "Nothing is pre-filled"
    Danbyte ships no sample panels or feeds - you create exactly the ones your
    sites have.

!!! warning "Panels in use can't be deleted"
    If a panel still has feeds attached, Danbyte blocks the delete. Remove or
    reassign those feeds first.

## Editing and deleting several at once

Tick rows in **Power panels** or **Power feeds** - or on a panel's **Feeds**
tab, or a rack's **Power feeds** tab - and a bar with **Edit** and **Delete**
comes up.

**Edit** sets the same value on every selected row; fields left on *Keep*
are untouched, and tags are added or removed rather than replaced.

| List | Bulk-editable fields |
|---|---|
| Power feeds | status, type, supply, phase, voltage, amperage, max utilization, power panel, rack, tags |
| Power panels | site, location, tags |

Each value is checked as the edit form checks it. One bad value, or a move
that would give a panel two feeds of one name (or a site two panels of one
name), refuses the whole edit and nothing is written. A panel's location must
be in its site: a location outside a selected panel's site is refused, and
moving panels that have a location to another site needs the location set
or cleared in the same edit. Every changed row gets
its own entry in the change log.

**Delete** first shows what will happen: the rows that go, what goes with
them, and the rows Danbyte keeps. Feeds cabled to a device are named with the
power port at the other end; the cable loses its end on the feed. A panel
that still has feeds is kept, and **Delete their feeds too** deletes the
panel together with its feeds - only when you may delete every one of those
feeds. More than 1000 rows go 1000 at a time, under one confirmation (see
[Large selections](table-preferences.md#large-selections)).

The calls are `POST /api/power-feeds/bulk-update/` and
`/api/power-panels/bulk-update/` (`{"ids": [...], "fields": {...}}`, tags as
`add_tag_ids` / `remove_tag_ids`), and `bulk-delete/` on both
(`{"ids": [...], "dry_run": true}` for the preview, `"with_feeds": true` on
panels). They need the *change* and *delete* permission on the type, and
reach only the rows your permissions and sites reach. See
[Bulk calls](../reference/api.md#bulk-calls).

## Device power: ports & outlets

Panels and feeds cover power *upstream of the rack*. At the device, two
components complete the chain:

- A **power port** is a device's power **inlet** - where it draws power. It can
  carry the device's **maximum** and **allocated draw** (watts).
- A **power outlet** is a socket on a device that feeds *other* devices - a rack
  PDU's outlets. Each outlet can name the **inlet** on the same device that
  feeds it (so per-inlet load rolls up) and, on three-phase gear, which
  **feed leg** (A/B/C) it's on.

A typical rack: the PDU is a device whose power port **cables to a power
feed**, and whose outlets **cable to the servers' power ports**. All of these
are cable endpoints, so the whole power path is traceable end-to-end like any
other cabling. Manage them on the device's **Power** tab; connector types
(IEC C13/C14, NEMA, ...) come from the standard taxonomy.

A rack's power supply is its primary feeds. Where a rack has none, the
**maximum draw** of its PDUs' inlets stands in, marked as a PDU rating: a
PDU's inlets count as redundant feeds, and two or more PDUs as A and B sides
of which the smaller one is the supply - see
[Racks](../dcim/racks.md) for how a rack rolls power up. A rack's **Power
budget (W)** replaces both when set: demand is then measured against what the
rack may draw, marked *budget*, and the site's Capacity tab counts the racks
on a budget.

To see where power runs short, colour a floor plan's racks by **Power**
([Color by](floor-plans.md#color-by)): each rack's demand over its supply on
the shared scale - green up to the tenant's warning level, amber above it,
red above its critical level (80 % and 95 % unless changed under **Settings →
Tenant policy → Rack capacity**) - and grey with *No data* where a rack has
no supply figure to measure against. The
rack table under the plan sorts by the same share, and a site's
[Capacity](../models/site.md#the-capacity-tab) tab adds the figures up per
floor plan.

## Tags & custom fields

Need to track something extra - a breaker number, a UPS reference, a circuit
drawing? Add a **custom field** for panels or feeds and it appears on every
form. See [Tags & custom fields](tags-and-custom-fields.md).
