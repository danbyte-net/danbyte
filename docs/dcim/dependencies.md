---
icon: lucide/git-fork
---

# Device dependencies

Cables and LLDP say which devices are connected. They do not say which way
the service flows, or which links back each other. A **device dependency**
records that: *the downstream device depends on the upstream device*. An
access switch depends on its distribution switch, a remote site's router
depends on the radio link, the radio depends on the core.

Danbyte uses the dependencies to answer "what goes down if this fails?" on
the device page and in the API, and to fill a maintenance event's impacts.

## Recording dependencies

Three ways in:

- **The device page.** The **Dependencies** tab has **Add upstream** (what
  this device depends on) and **Add dependents** (what depends on it). Pick
  one or more devices, a medium, a redundancy group and a description.
- **DCIM → Connections → Dependencies.** The list of every dependency, with
  **Add dependency** (pick both ends), edit, delete, bulk edit and
  import/export.
- **Import.** A spreadsheet with the columns below
  ([Import & export](../features/import-export.md)).

| Field | What it records |
|---|---|
| **Downstream** | The device that depends. |
| **Upstream** | The device it depends on. |
| **Kind** | *Dependency*, or *Peer* for a link between equals (two core routers). Impact ignores peers. |
| **Medium** | What the dependency runs over, from the [media catalog](#media). Optional. |
| **Redundancy group** | Upstreams of one device that back each other. See [Redundancy](#redundancy). |
| **Description / comments** | A short note, and long-form notes. |

Tags and custom fields work as on any other object.

### What Danbyte refuses

- A device that depends on itself.
- A second relation between the same two devices, in either direction. That
  also refuses the reverse of an existing dependency and a peer link beside
  one. The database enforces it.
- A cycle: a dependency whose upstream already depends, through any chain,
  on its downstream. The error names the path, for example
  `This would make a cycle: core-1 → dist-2 → acc-7 → core-1.` The check
  runs for every write (the dialog, the API, bulk paths and import, in a
  dry run too), and two people saving at the same time cannot slip a cycle
  past it.
- A peer link with a redundancy group.

A peer is stored the same way round whichever device you pick first.

## Redundancy

Dependencies of one device that share a **redundancy group** back each
other. The device is down only when **every** upstream in the group is down,
and has **reduced redundancy** when some are. A dependency without a group
is a group of its own: if that upstream fails, the device fails.

For example, `acc-7` depends on `dist-1` and `dist-2`, both in the group
`uplinks`. If `dist-1` fails, `acc-7` loses redundancy; if both fail,
`acc-7` goes down and takes its own dependents with it. Reduced redundancy
does not travel further down.

The group name is free text, scoped to the downstream device: `uplinks` on
one device has nothing to do with `uplinks` on another. "N of M" redundancy
(two of three uplinks needed) is not modelled yet.

## The Dependencies tab

The device page's **Dependencies** tab, after **Services**, has two views:

- **Dependencies** - two trees. **Upstream** is what the device depends on,
  **Dependents** is what depends on it, each to a depth you pick (3 by
  default, up to 10). Each device shows its status and its live check state;
  each link shows its medium and redundancy group. A device you may not view
  shows as *Hidden* so the shape of the tree still reads. **Peers** lists the
  device's peer links. Edit and delete each link in place.
- **What if this fails?** - the devices that would go down with this one
  (*Outage*) or lose redundancy, each with the upstream it hangs off. **Plan
  maintenance** opens a new [maintenance event](../features/maintenance.md#from-a-devices-dependents)
  with the device and these devices as its impacts.

The device's **Change log** tab also lists the changes to its dependencies.

## Media

A **dependency medium** is what a dependency runs over. Media are an
editable catalog under **DCIM → Devices → Dependency media**: a name, a
colour, an icon and a **line** style (solid, dashed or dotted) the maps use.

Every tenant starts with six media: *Ethernet*, *Fibre*, *Radio*,
*VPN/tunnel*, *LTE/5G* and *Satellite*. They are seeded so the add dialog
offers something on day one; rename, recolour or delete them freely. A
tenant that already has media is never re-seeded, so a deleted medium does
not come back on upgrade. A medium still in use cannot be deleted - give its
dependencies another medium first.

Under [enhanced site separation](../access/site-separation.md) a medium can
be local to a site, like the other catalogs.

## Permissions and sites

Two RBAC object types, both in the DCIM group: `devicedependency` and
`dependencymedium`.

A dependency belongs to its **downstream** device's site, else its
upstream's. A site editor records the dependencies of their sites' devices;
the upstream may be another site's device, but the editor must be able to
view it. A device outside your view, or another tenant's, is "not found".
In a list, an end you may not view reads *Hidden*. The one-click site roles
include dependencies, and read the media.

"What if this fails?" is worked out over **every** dependency, so a
device's level never depends on what you can see; the answer lists only the
devices you may view. It needs view on device dependencies.

## Import columns

`upstream`, `downstream`, `medium`, `redundancy_group`, `description`,
`tags`, and optionally `kind` and `comments`. Devices are matched by name
(an ambiguous name needs its id), the medium by slug. A row that would make
a cycle is refused with its path; the rest of the file still imports.

## API

| Endpoint | What it does |
|---|---|
| `/api/device-dependencies/` | CRUD. Write `upstream_id`, `downstream_id`, `kind`, `medium_id`, `redundancy_group`, `description`, `comments`, `tag_ids`, `custom_fields`. Filters: `upstream`, `downstream`, `device` (either end), `kind`, `medium`, `redundancy_group`, `site` (either end's), `tag`, `search`. |
| `/api/device-dependencies/bulk-update/` | Medium, redundancy group, description, tags and custom fields. Never the ends or the kind. |
| `/api/device-dependencies/bulk-delete/` | The shared safe bulk delete. |
| `GET /api/devices/<id>/dependencies/?direction=up\|down\|both&depth=3` | The tree for the device tab: `root`, `nodes`, `edges`, `truncated`. |
| `GET /api/devices/<id>/impact/?limit=500` | What goes down if the device fails. |
| `GET /api/device-dependencies/impact/?device=<id>&device=<id>` | The same for several devices failing together. |
| `/api/dependency-media/` | The media catalog (`?picker=1`). Deleting a medium in use answers 409. |

The impact answer:

```json
{"root": [{"id": "…", "name": "core-1"}],
 "devices": [{"id": "…", "name": "acc-7", "level": "outage", "depth": 2,
              "via": [{"id": "…", "name": "dist-2"}],
              "site": {"id": "…", "name": "HQ"}, "rack": null}],
 "counts": {"outage": 37, "reduced_redundancy": 4},
 "truncated": false,
 "impacts": [{"object_type": "device", "object_id": "…", "level": "outage"}]}
```

`limit` defaults to 500 (at most 5000); `truncated` says more were cut.
`counts` counts the devices you may view. `impacts` is the roots and the
listed devices, in the shape a maintenance event create takes.

The model is described in [Device dependency](../models/device-dependency.md).
