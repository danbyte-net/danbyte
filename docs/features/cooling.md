---
icon: lucide/snowflake
---

# Cooling

Cooling is how heat leaves your racks. Danbyte records it in two halves: how
each piece of **hardware is cooled**, and what each **rack's cooling** can
take and how much heat it removes. Both work without modelling the cooling
plant itself - the units, loops and feeds behind a rack come later in this
release (see [Cooling sources and feeds](#cooling-sources-and-feeds)).

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

A rack with a capability takes only the hardware its cooling can serve,
judged by each device's effective cooling method:

| Rack cooling | Takes hardware cooled by |
|---|---|
| **Air** | air |
| **Hybrid** | air, liquid, hybrid |
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
demand. The rack's **capacity** is what the heat is measured against.

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
capacity, else null) and `mismatched`, the devices its capability does not
take. `cooling_free_w` is the capacity less the allocated heat, null without
a capacity. Both are worked out from the rack's devices as the list already
loads them, so a page of racks costs the same queries whatever stands in
them.

Filters:

| List | Filter | Keeps |
|---|---|---|
| `GET /api/racks/` | `?cooling_capability=liquid` | racks with that capability; `none` for racks without one |
| `GET /api/racks/` | `?cooling_free_w_gte=5000` | racks whose capacity less their allocated heat is at least that many watts - the racks that can still take 5 kW. Racks without a capacity are left out. |
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

Coming in this release: the cooling units and loops in a site, and the feeds
that run from them to the racks they cool.
