---
icon: lucide/plug
---

# Pluggables

**DCIM → Catalog → Pluggables** lists the parts Danbyte seats in ports on
3D models: transceivers (an SFP-10G-LR, a generic QSFP), plugs and cords
(an LC duplex, an RJ45 plug, an IEC cord) and one-piece parts (a DAC, an
AOC). They come with [3D model packs](model-packs.md#accessory-types) as
*accessory types*; this page is where you see one on its own, check which
part numbers it covers, and find every port that uses it.

A pluggable is a catalog entry, tenant-wide like a module type. The optics
you own are [transceiver records](inventory.md#transceivers) in each
device's inventory; the [Transceivers list](inventory.md#transceivers-list)
shows them all.

## The list

| Column | Shows |
|---|---|
| **Name** | The part's name, linked to its page. |
| **Kind** | Transceiver, Plug or Cord. |
| **Connector** | What it takes or ends in: `lc`, `mpo`, `rj45`, `dac`… |
| **Fits** | The port types it plugs into. |
| **Standard**, **Wavelength** | A real optic's IEEE / MSA name and wavelength. |
| **Parts** | How many vendor part numbers it stands for; hover for the list. |
| **In use** | The ports that show it and the spare records that name it (see [Usage](#usage)). |
| **Pack** | The pack and version it came with. |

The filter rail narrows by kind, connector, fits, pack and in use. The
search box matches the name, vendor, standard and part numbers.

## A pluggable's page

**Overview:**

- **Part:** kind, vendor, connector, fits, standard, wavelength, reach, and
  how many ports use it.
- **Part numbers:** each part number, with how many transceiver records
  match it (records whose part ID it lists, case and a trailing `=`
  ignored, with no part set by hand).
- **Cable** (plugs and cords): the profile, jacket, pitch and minimum bend
  Danbyte draws the run with.
- **Pack:** the pack and version, the model's file in the pack, its
  triangle count, and the fields **changed by hand** (below).
- **3D model:** the part in the shared viewer - Front, Rear, Top and 3D,
  Fit, fullscreen.
  - **With cord** (a transceiver with a matching cord) seats the cord at
    the transceiver's `port:<connector>` empty, exactly as a device's port
    shows it, so you can check the fit. Without such an empty the cord sits
    at the part's origin.
  - **Cable** previews the colours a cable gives the part's `FIBRE`,
    `LC_BODY` and `CABLE` materials: Neutral, OS2, OS2 APC, OM2, OM3, OM4,
    OM5 or Cat6 ([Colours](model-packs.md#accessory-types)). It opens on
    single-mode for a long-reach optic (1,200 nm and up, or an LR/ER/ZR
    standard) and OM4 for a short-reach one.

**Usage**, **Journal** and **Change log** follow.

### Usage

Every port that shows the part, among the ports you may view:

| Source | Means |
|---|---|
| **Set by hand** | A transceiver record whose **3D part** is set to it. |
| **Part number** | A transceiver record whose part ID one of its part numbers matches. |
| **Fallback** | A port in use with no record that picks it: the generic transceiver of a cabled cage, the cord in a transceiver, the plug in an RJ45 jack ([Which parts a port shows](model-packs.md#which-parts-a-port-shows)). |

Each row has the device, port, site, the record's serial, part ID and
standard, and whether the port is cabled (with the cable's type). A record
that names the part but sits in no port shows as **Spare**. Records count
only for a reader who may view inventory items; cables only for one who
may view cables. Usage is worked out from the port types and records, so it
lists a port whether or not its device has a 3D model.

## Editing

**Edit** (change on pluggables) sets:

- **Fits:** one port type slug per line.
- **Part numbers:** one per line; a duplicate (ignoring case and a trailing
  `=`) is dropped.
- **Standard**, **Wavelength (nm)**, **Reach (m)**.
- **Cable** (plugs and cords only): profile (zip cord, round or ribbon, or
  no cable), jacket, pitch (zip cord and ribbon), a ribbon's jackets (2-8)
  and minimum bend, in mm, with the same limits a pack's `cable:` block
  has. A pack's per-length bends (`min_bend_by_part`) show on the Overview
  and are kept on save.

**Replace model** on the Overview uploads a new model through the same
converter and checks as a module type's (GLB, glTF, STEP, STL…). The upload
reports its triangles against the part's budget (1,500 for a transceiver,
2,000 for a plug or cord) and any empty it lacks for stacking - a
transceiver's `port:<connector>`, a cord's `cable`.

Name, vendor, kind and connector stay the pack's.

### Changed by hand

Each field you change - and the model when you replace it - is marked
**changed by hand**. A pack re-import (the
[install](model-packs.md#installing-in-the-app) or `import_model_pack`)
keeps those fields and reports each one it kept, such as *fits: changed by
hand - kept; the pack says otherwise* or *model: replaced by hand - kept*.
The rest still follow the pack. This is the rule device types follow for
reference modules.

**Give back to pack** on the Pack card clears the marks: the next import
sets those fields from the pack again. Saving a field with the value it
already has marks nothing.

## Deleting

**Delete** (delete on pluggables) removes a part nothing uses: no
transceiver record is set to it, and no port shows it - counting every port
in the tenant, including ones you may not view. A pack re-import brings a
deleted part back.

## Permissions

Pluggables have their own permission, **Pluggables** (`accessorytype`):
view to see the list, pages and change log, change to edit and replace a
model, delete to delete. The built-in roles hold it; a custom role needs it
granted. Site roles read it. Every part belongs to the
active tenant; another tenant's id answers 404.

## Elsewhere

- **Interface page:** the Transceiver row shows a small 3D view of the part
  the port shows - with its cord while cabled, coloured by the cable. Drag
  to turn it; the part's name under it opens the part's page
  ([Interfaces](interfaces.md)).
- **Device → Hardware:** a transceiver's part ID links to its pluggable.
- **[Transceivers list](inventory.md#transceivers-list):** the part IDs
  link the same way.

## API

| Call | Does |
|---|---|
| `GET /api/accessory-types/` | The tenant's parts, each with `in_use`, `hand_edited`, `reach_m` and `pack_import` (`{pack: {name, version}, file, triangles}`). Filters: `kind`, `connector`, `fits` (a port type), `pack` (a pack name), `in_use=true\|false`, `search`. View on pluggables. |
| `GET /api/accessory-types/{id}/` | One part, with `part_records` (`{part number: records}`) and, for a transceiver, `cord` (`{id, name, connector, model_url, cable}`) - the cord that plugs into it. |
| `PATCH /api/accessory-types/{id}/` | Change `fits`, `parts`, `standard`, `wavelength_nm`, `reach_m`, `cable` (null for none; refused on a transceiver). Each field changed joins `hand_edited`. `hand_edited` itself may only shrink: send the fields to keep (`[]` gives them all back to the pack). Change on pluggables. |
| `GET/POST /api/accessory-types/{id}/model/` | Download the model, or replace it with a multipart `file` (checked like any model). The answer carries `model_notes`; `model` joins `hand_edited`. Change on pluggables to write. |
| `GET /api/accessory-types/{id}/usage/` | The [usage](#usage) rows: `device`, `site`, `port` (`{kind, id, name, type}`, null for a spare), `role` (`transceiver`, `plug`, `cord`), `source` (`set`, `part`, `fallback`), `cabled`, `cable_type`, `item` (`{id, name, part_id, serial_number, standard}`). Paged. |
| `DELETE /api/accessory-types/{id}/` | Delete an unused part; `409` while anything uses it. Delete on pluggables. |
| `GET /api/interfaces/{id}/parts/` | The parts one interface shows: `transceiver_part` and `cord_part` (`{id, vendor, name, kind, connector, url}`, the cord with `cable`; `id` is null for a reader who may not view pluggables), `cabled`, `color`, `cable_type`, `port_type`. View on the interface. |

The list and the usage cost a fixed number of queries however many ports
and records the tenant has.
