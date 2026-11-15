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
the device page, the Topology map and in the API, to fill a maintenance
event's impacts, to send one
[root-cause alert](../features/monitoring.md#root-causes) for a down device
instead of one per device behind it, and to draw them on the
[maps](#on-the-maps).

## Recording dependencies

Four ways in:

- **The device page.** The **Dependencies** tab has **Add upstream** (what
  this device depends on) and **Add dependents** (what depends on it). Pick
  one or more devices, a medium, a redundancy group and a description.
- **DCIM → Connections → Dependencies.** The list of every dependency, with
  **Add dependency** (pick both ends), edit, delete, bulk edit and
  import/export.
- **Import.** A spreadsheet with the columns below
  ([Import & export](../features/import-export.md)).
- **Suggest from cables and LLDP.** **Suggest…** on the Dependencies list
  and on a device's Dependencies tab proposes them for you to review. See
  [Suggest from cables and LLDP](#suggest).

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

## Suggest from cables and LLDP {#suggest}

Cables and LLDP give adjacency but not direction. **Suggest…** reads the
direction from a **core device** you pick (from a device's tab, that
device): Danbyte walks outward from it and proposes that each device
depends on its neighbours one hop closer to the core.

- **What it follows**: cables between two interfaces - through patch
  panels, as the Topology map collapses them - and, with **LLDP** on, the
  LLDP neighbours that have no cable. Console and power cables do not
  count. **Max hops** (8 by default, up to 20) bounds the walk.
- **Two neighbours at the same distance** from the core are ordered by
  their ports: when the link's port is an **uplink** on one side only - the
  interface's *Uplink: Always*, or the
  [MAC tracking uplink](../features/snmp-discovery.md#uplinks) rules (an LLDP neighbour that
  is a switch, a LAG, more learned MACs than *Uplink above*; *Never* wins) -
  that side depends on the other. Neither or both: no proposal.
- **Medium**: Fibre when a cable on the link is a fibre or AOC type,
  Ethernet otherwise and for an LLDP-only link (when your catalog still has
  those two media).
- **Redundancy**: a device with two or more proposed upstreams at the same
  distance gets them in one group, `auto-<core name>`.
- **Already related** pairs (either way, either kind) are skipped and
  counted.

The proposals come up in a table - downstream, upstream, medium, group,
evidence (Cable or LLDP, and *Uplink* when the ports set the direction),
hops and ports. **Nothing is saved** until you tick rows and **Create
selected**. Each row goes through the ordinary create: a row that would make
a cycle, or is outside your sites, is refused with its reason and stays in
the table; the others are saved and leave it.

The walk sees only the devices you may view (a device outside your view is
a dead end, never walked through), over the cables you may view, in your
tenant. Suggesting needs view on device dependencies; creating needs add.

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
  device's peer links. Edit and delete each link in place. When an
  upstream's fastest check runs less often than the
  [root-cause hold](../features/monitoring.md#root-causes), the Upstream
  tree says so: its dependents' alerts will usually go out before it is
  seen down.
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

## On the maps

- **Topology** - **Display ▸ Dependencies** draws them as arrowed lines
  between the cards, in their medium's colour and line style, with the
  redundancy group on the line; right-click a card → **What if this fails?**
  rings what goes down with it. See
  [Topology → Dependencies](../features/topology.md#dependencies).
- **Site map** - **Display → Layers → Dependencies** draws a line between
  two devices with their own coordinates, and one per site pair and medium
  for the rest. See [Site map → Dependencies](../features/site-map.md#dependencies).

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
| `GET /api/devices/<id>/dependencies/?direction=up\|down\|both&depth=3` | The tree for the device tab: `root`, `nodes`, `edges`, `truncated`, and `hold_seconds` with `slow_upstreams` (upstreams checked less often than the root-cause hold). |
| `GET /api/devices/<id>/impact/?limit=500` | What goes down if the device fails. |
| `GET /api/device-dependencies/impact/?device=<id>&device=<id>` | The same for several devices failing together. |
| `/api/dependency-media/` | The media catalog (`?picker=1`). Deleting a medium in use answers 409. |
| `POST /api/device-dependencies/suggest/` | Proposals from cables and LLDP. Body: `core_device` (id), `max_depth` (1-20, default 8), `use_lldp` (default true), `site` (optional: walk only that site's devices and the core). Answers `core`, `max_depth`, `reached` (devices walked, the core included), `skipped_existing`, `truncated` and `proposals`: `key`, `upstream`, `downstream`, `distance`, `direction` (`distance` or `uplink`), `evidence` (`cable` or `lldp`), `medium_guess`, `medium`, `redundancy_group`, `ports`. Saves nothing. |
| `POST /api/device-dependencies/suggest/confirm/` | Creates `rows` (up to 2000; each `upstream_id`, `downstream_id`, and optionally `kind`, `medium_id`, `redundancy_group`, `description`) one by one through the ordinary create. Answers `created` and `results`: per row `{index, ok: true, id}` or `{index, ok: false, errors}`. Needs add on device dependencies. |
| `GET\|POST /api/topology/dependencies/` | The Topology layer: one edge per dependency, `type: "dependency"`, `source` the upstream card (`dev:<id>`), `target` the downstream one, `data` with `dependency_id`, `kind`, `medium`, `redundancy_group`, `description`, `upstream`, `downstream` (names). `?site=` keeps those with an end at that site; `device` (repeat, or comma-separated; a JSON body `{"device": [...]}` with POST) those between the devices named. Needs view on device dependencies (else 403); a row with an end you may not view is left out. |
| `GET /api/site-map/connections/?include=dependencies` | The Site map layer, see [its API](../features/site-map.md#include-dependencies). |

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
