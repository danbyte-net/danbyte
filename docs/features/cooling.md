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

A **device** takes its type's cooling unless it sets its own: **Cooling** on
the device is an override, blank inherits. What the device ends up with - its
own, else its type's, else air - is its *effective* cooling method. The
device's own field is a [built-in field](../dcim/devices.md#built-in-fields),
hidden until an administrator turns on **Cooling method** under **Settings →
Device fields**.

A [module type](../dcim/device-catalog.md#module-types) records its own
cooling method as well. It is a fact about the module and does not change its
host device's.

## A rack's cooling

A [rack](../dcim/racks.md) carries what its cooling takes and how much heat
it removes:

| Field | What it records |
|---|---|
| **Capability** | **Air** - room air only. **Hybrid** - air and a liquid loop. **Liquid** - a liquid loop only. **Immersion** - a tank. Blank: not recorded. |
| **Capacity** | The heat the rack's cooling removes, in kW on the form and watts in the API. |

A [rack type](../dcim/racks.md#rack-types) carries both too: picking the type
fills them in, and **Sync type** reports and copies them where a rack has
drifted from its model.

## In the API

| Object | Fields |
|---|---|
| Device type | `cooling_method`, `heat_output_w` |
| Module type | `cooling_method` |
| Device | `cooling_method` (blank inherits), and the read-only `effective_cooling_method` |
| Rack type | `cooling_capability`, `cooling_capacity_w` |
| Rack | `cooling_capability`, `cooling_capacity_w` |

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
