---
icon: lucide/snowflake
---

# Cooling

Cooling is how heat leaves your racks. Danbyte records how each piece of
**hardware is cooled**, what each **rack's cooling** can take and how much
heat it removes, and - optionally - the **cooling plant** behind it: the
units in a site and the loops that run from them to racks (see
[Cooling sources and feeds](#cooling-sources-and-feeds)).

## How hardware is cooled

A [device type](../dcim/device-catalog.md#device-types) carries two cooling
facts:

| Field | What it records |
|---|---|
| **Cooling** | How the hardware is cooled: **Air**, **Liquid**, **Hybrid** or **Immersion**. Blank reads as air. |
| **Heat output (W)** | The heat the hardware gives off, where that is not its allocated draw - for gear whose power does not all turn into heat in the rack. Blank counts its draw. |

Both sit in the device type form's **Chassis** card, and the type's page
shows them in its **Hardware** card - *Air (default)* where the type sets no
method.

A **device** takes its type's cooling unless it sets its own: **Cooling** on
the device is an override, blank (*Inherit*) takes the type's. What the
device ends up with - its own, else its type's, else air - is its
*effective* cooling method, which the device's **Hardware** card shows,
marked *(from type)* when it is not the device's own. The device's own field
is a [built-in field](../dcim/devices.md#built-in-fields), hidden until an
administrator turns on **Cooling method** under **Settings → Device fields**.

A [module type](../dcim/device-catalog.md#module-types) records its own
cooling method as well, on its form and page. It is a fact about the module
and does not change its host device's.

The Devices, Device types and Module types lists offer a **Cooling** column -
a device's effective method, a type's own - hidden until you tick it in
**Columns**; where the rows differ, the rail filters by it.

## A rack's cooling

A [rack](../dcim/racks.md) carries what its cooling takes and how much heat
it removes:

| Field | What it records |
|---|---|
| **Capability** | **Air** - room air only. **Hybrid** - air and a liquid loop. **Liquid** - a liquid loop only. **Immersion** - a tank. Blank: not recorded. |
| **Capacity** | The heat the rack's cooling removes, in kW on the form and watts in the API. |

Set them in the **Cooling** section of the rack form, next to the power
budget. A [rack type](../dcim/racks.md#rack-types) carries both too, in the
same section of its form: picking the type on a rack fills them in, and
**Sync type** reports and copies them where a rack has drifted from its
model.

## Which hardware a rack takes

Air-cooled hardware - a device whose effective cooling method is air, set or
left blank - goes in any rack: switches, PDUs and patch panels sit in a
liquid rack or beside an immersion tank as anywhere else. Liquid, hybrid and
immersion hardware goes only where the rack's capability serves it:

| Rack cooling | Takes liquid, hybrid and immersion hardware cooled by |
|---|---|
| **Air** | none of them |
| **Hybrid** | liquid, hybrid |
| **Liquid** | liquid, hybrid |
| **Immersion** | immersion |

A rack without a capability takes anything. A device the rack does not take
is refused - *Rack R12 is air-cooled; this device type is liquid-cooled.* -
on the field that changed: **Rack** when it is placed, **Device type** when
it is re-typed, **Cooling** when its own method is changed. The rule holds on
every write: the form, the API and the
[spreadsheet import](import-export.md), and a device's own method is checked
even while the field is hidden.

Making a rack's capability stricter is allowed. Its devices stay where they
are and nothing is judged again until a device's placement, type or own
method changes, so they keep editing from their forms. The rack page's
**Capacity** card counts them - *2 mismatched* beside the capability - and
the count opens the **Devices** tab on **Mismatched cooling**, which lists
just those devices with their cooling. Moving a rack to another site takes
its devices along in their rack, so the move has nothing new to judge.

## Heat load and capacity

A rack's **heat** adds up its devices: each device's type **heat output**
where it has one, else the power the device draws - the allocated draw where
you recorded it, the nameplate (maximum) sum beside it. Devices with power
outlets are distributors (PDUs) and add no heat, as they add no power
demand. The rack's **capacity** is what the heat is measured against:
its own capacity, else what its primary cooling feeds deliver (see
[Capacity](#capacity)).

The figure reads like a rack's [power](power.md): **heat / capacity**
(`3.2 kW / 10 kW`, in W below 1 kW), the nameplate sum standing in - marked
*nameplate* - where nothing is allocated, red when the heat is over the
capacity, and *No capacity* for a rack giving off heat with none recorded. It
is the **Cooling** row of the rack page's **Capacity** card, under
**Cooling capability**, and the racks list's **Cooling** column: a bar on the
racks' one scale - green up to the tenant's warning level, amber above it,
red above its critical level (80 % and 95 % unless changed under **Settings →
Tenant policy → Rack capacity**) - offered in **Columns**, hidden until you
tick it, sorting by the share of the capacity the heat takes; the rail
filters by capability. A site's [Capacity](../models/site.md#capacity) API
adds the racks up.

## On the floor plan

**Display → Color by → Cooling** colours a floor plan's racks - in 2D and in
the 3D room - by their heat over their cooling capacity, on the same scale,
grey with *No data* where a rack has no capacity
([Color by](floor-plans.md#color-by)). The rack table under the plan gains a
**Cooling** column, the tile popover a **Cooling** field (off by default,
picked under **Settings → Floor plans → Tile popover**), and a rack's card
in the 3D room a **Cooling** row under **Power**. The figure refreshes with
the plan's 30-second live state, which carries each rack tile's `cooling`.
A site's [Capacity](../models/site.md#the-capacity-tab) tab measures by
**Cooling** too and adds its racks' heat up.

## In the API

| Object | Fields |
|---|---|
| Device type | `cooling_method`, `heat_output_w` |
| Module type | `cooling_method` |
| Device | `cooling_method` (blank inherits), and the read-only `effective_cooling_method` |
| Rack type | `cooling_capability`, `cooling_capacity_w` |
| Rack | `cooling_capability`, `cooling_capacity_w`, and the read-only `cooling` and `cooling_free_w` |

A rack's `cooling` holds `available_w` (its capacity, 0 without one),
`heat_allocated_w`, `heat_maximum_w`, `supply` (`budget` when the rack has a
capacity, `feed` when its primary cooling feeds give one, else null) and
`mismatched`, the devices its capability does not take. `cooling_free_w` is
the capacity less the allocated heat, null without a capacity. Both are worked out from the rack's devices as the list already
loads them, so a page of racks costs the same queries whatever stands in
them.

Filters:

| List | Filter | Keeps |
|---|---|---|
| `GET /api/racks/` | `?cooling_capability=liquid` | racks with that capability; `none` for racks without one |
| `GET /api/racks/` | `?cooling_free_w_gte=5000` | racks whose capacity (their own, else their primary feeds') less their allocated heat is at least that many watts - the racks that can still take 5 kW. Racks without a capacity are left out. |
| `GET /api/devices/` | `?cooling_method=liquid` | devices whose *effective* method is that one |
| `GET /api/devices/` | `?cooling_mismatch=1` | devices whose rack does not take their effective method; `0` the rest |

A value outside the lists, or a figure that is no whole number, is a 400.
Watts are whole numbers. `GET /api/dcim/choices/` serves the two lists as
`cooling_method` and `cooling_capability`, each option a `value` and a
`label`. The fields travel with a device-type
[bundle](../dcim/device-catalog.md#bundles) and through the
[spreadsheet import and export](import-export.md); a rack-type file takes
`cooling_capability` and `cooling_capacity_w` keys (see
[Rack types](../dcim/racks.md#rack-types)).

## Cooling sources and feeds

The cooling plant mirrors [power](power.md): **cooling sources** are the units
in a site - chillers, CRAHs, in-row units - and **cooling feeds** the loops
that run from them to racks. Find both under **Power & cooling** in the
sidebar.

### Cooling sources

1. Open **Power & cooling → Cooling sources** and click **Add cooling source**.
2. Pick the **site**, and optionally a **location** in it - only the site's
   locations are offered.
3. Give it a **name**, unique within the site.
4. Set what it is and what it carries:

| Field | What it records |
|---|---|
| **Type** | Chiller, Cooling tower, Dry cooler, CRAC, CRAH, In-row or Other. |
| **Status** | Planned, Active, Offline or Failed - rows of the [Statuses catalog](catalogs-and-settings.md#statuses), available to *Cooling sources*. |
| **Fluid** | Air, Water, Glycol, Dielectric, Refrigerant or Other. |
| **Rated capacity** | The heat the unit removes, in kW on the form and watts in the API. |
| **Redundancy group** | Free text shared by units that back each other up - *N+1*, *A*, *B*. |
| **Device** | The device that is or monitors the unit, for its interfaces, checks and alerts. |

A source page has **Overview** (the unit, its load and any planned
maintenance), **Feeds**, **Affected**, **Journal** and **Change log**. A
source that still has feeds cannot be deleted - remove or move them first.

### Cooling feeds

A feed is one loop - its supply and its return - from a source to a rack.

1. Open **Power & cooling → Cooling feeds** and click **Add cooling feed**.
2. Choose the **source** and give the feed a **name**, unique within the source.
3. Optionally pick the **rack** it cools - only racks in the source's site.
4. Set the loop:

| Field | What it records |
|---|---|
| **Type** | Primary, or Redundant - a spare loop that takes over when the primary fails. |
| **Rated capacity** | The heat the loop carries away, in kW on the form. |
| **Max utilization** | The share of the rating the rack may load, 80 % unless changed. |
| **Flow** | Litres per minute. |
| **Supply / Return temperature** | °C, to one decimal. |
| **Connector** | Free text - the quick-disconnect or flange the loop lands on. |

A feed page has **Overview**, whose **Loop** card holds the figures above and
the feed's load, then **Affected**, **Journal** and **Change log**. A rack's
page lists its loops on a **Cooling feeds** tab next to **Power feeds**.

A feed's site is its source's. A rack with a feed from its site cannot be
[moved to another site](../dcim/racks.md) - the move names the feeds, as it
does power feeds - until the feed is moved or its rack cleared.

### Capacity

A rack's cooling **capacity** comes from the first of:

1. its own **Capacity** (`cooling_capacity_w`), marked *budget*;
2. its **primary** cooling feeds: each feed's rated capacity × its max
   utilization, added up (watts, rounded down), marked *feed*;
3. nothing - *No capacity*.

Redundant feeds never add to the supply: the rack is meant to run on its
primaries. Wherever the rack's cooling figure shows - the rack page, the
racks list, the floor plan and a site's Capacity tab - it follows this order,
and `?cooling_free_w_gte=` filters by the same supply.

Each **feed** shows its rack's heat against what the feed delivers (rating ×
max utilization). A redundant feed is measured against the whole rack too,
marked *redundant*: it must carry the rack alone when the primary fails.

Each **source** shows the heat of every rack its feeds reach - a rack fed
twice by one source counts once - against the source's rated capacity, and
how many racks that is.

### Affected

The **Affected** tab of a cooling source or feed - and of a
[power panel or feed](power.md#affected) - walks downstream: source → its
feeds → the racks they deliver to → the devices in those racks. Each rack and
device carries the impact work on the source would have:

| Level | When |
|---|---|
| **Outage** | The rack has no other feed of the same kind. |
| **Reduced redundancy** | Another feed - from another source, or one not part of the work - still serves the rack. |

The tab lists only what you may view. **Plan maintenance** opens a new
[maintenance event](maintenance.md#from-a-source-or-feed) with these impacts
filled in: the source or feed itself and its feeds as *Outage*, the racks and
devices at their level. Once the event is saved, the source's Overview shows
it under **Planned maintenance & outages**, and a confirmed window silences
the impacted devices' alerts.

### On the floor plan

A floor-plan tile links to a cooling source like it links to a power panel:
**Inspector → Link → Cooling source**, picking from the tenant's sources. The
tile popover shows the source's type, status, rated capacity and load, and
opens its page. In the 3D room such a tile stays a ghost box, as panel tiles
do. See [Floor plans](floor-plans.md#the-editor).

### Many at once

Tick rows in **Cooling sources** or **Cooling feeds** - or on a source's
**Feeds** tab, or a rack's **Cooling feeds** tab - for **Edit** and
**Delete**, as with [power](power.md#editing-and-deleting-several-at-once):

| List | Bulk-editable fields |
|---|---|
| Cooling sources | site, location, type, status, fluid, rated capacity, redundancy group, tags |
| Cooling feeds | source, rack, status, type, rated capacity, max utilization, connector, tags |

A source with feeds is kept by a bulk delete unless **Delete their feeds
too** is ticked and you may delete every one of them. Every row gets its own
change-log entry. Both types travel through the
[spreadsheet import and export](import-export.md): a source is matched by
site and name, a feed by source and name.

### Cooling plant API

| Endpoint | Purpose |
|---|---|
| `GET/POST /api/cooling-sources/` | List and create. Filters: `search`, `site`, `location`, `type`, `status`, `rack` (sources with a feed to it); `?picker=1` returns id and name only. |
| `GET/PATCH/DELETE /api/cooling-sources/{id}/` | Read, edit, delete - a `409` while feeds run from it. |
| `GET /api/cooling-sources/{id}/affected/` | The downstream racks and devices, and `impacts` ready for a maintenance event. |
| `GET/POST /api/cooling-feeds/` | List and create. Filters: `search`, `source`, `site` (the source's), `rack`, `type`, `status`. |
| `GET /api/cooling-feeds/{id}/affected/` | As for a source. |
| `POST …/bulk-update/`, `…/bulk-delete/` | On both, as on power panels and feeds; `"with_feeds": true` on sources. |

A source carries `capacity` - `available_w` (its rating, 0 without one),
`heat_allocated_w`, `heat_maximum_w`, `racks` - and a feed `capacity` with
`available_w` (rating × max utilization), `rated_w`, the rack's
`heat_allocated_w` and `heat_maximum_w`, and `redundant`. `affected` answers
`feeds`, `racks` and `devices` (each with its `level`) and `impacts`, a list
of `{object_type, object_id, level}`.

`GET /api/dcim/choices/` serves `cooling_source_types`, `cooling_fluids` and
`cooling_feed_types`. The RBAC types are `coolingsource` and `coolingfeed`
(**Power & cooling** in the permission editor); a site-limited grant reaches
a source by its site and a feed by its source's site. Both are audited and
searchable.
