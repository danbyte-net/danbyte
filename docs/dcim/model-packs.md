---
icon: lucide/package
---

# 3D model packs

A **model pack** brings 3D models for a family of hardware: a chassis
model per device type and a model per module type (power supplies, fans,
network modules, line cards). Danbyte puts each device together from the
parts it has installed, so a switch with one PSU and an empty second bay
shows exactly that in the [3D room](../features/floor-plans.md#the-3d-room-view)
and in the device's 3D viewer.

A pack is the device type and module type YAML of the
[device library](device-catalog.md#importing-from-the-netbox-devicetype-library)
with a `model3d:` block added, plus the `.glb` files those blocks name.

## What is in a pack

```text
pack.yaml                                   # name, version, licence
device-types/Cisco/C9500-48Y4C.yaml
module-types/Cisco/C9K-PWR-650WAC-R.yaml
models/Cisco/C9500-48Y4C.glb                # the chassis
models/Cisco/C9500-48Y4C.far.glb            # its far-distance copy (optional)
models/Cisco/C9K-PWR-650WAC-R.glb           # a module
```

The `model3d:` block of a type's YAML:

```yaml
model3d:
  file: models/Cisco/C9500-48Y4C.glb      # path inside the pack
  far: models/Cisco/C9500-48Y4C.far.glb   # optional
  empty: filler                           # filler | hole | nothing
  leds:
    SYS:    { source: device.status }
    BEACON: { source: device.locate }
    "port:*": { source: interface.oper_status }
```

| Key | Meaning |
|---|---|
| `file` | The model, a path inside the pack. Checked like any [upload](device-catalog.md#format-rules). |
| `far` | A low-detail copy drawn from a distance. Optional. |
| `up`, `front`, `fit` | As the [3D model settings](device-catalog.md#3d-models). Packs follow glTF's Y up, front +Z, so these are normally left out. |
| `empty` | What an empty bay shows: its cover (`filler`, the default), the modelled hole (`hole`, also drawn by the cover node), or `nothing`. |
| `leds` | Which data each status light shows: `device.status`, `device.locate`, `module.status`, `interface.oper_status` or `none`. Stored with the type; the lights themselves are not drawn yet. |

## Names the models carry

The models name the nodes Danbyte reads, exactly, in the glTF file:

| Node | Meaning |
|---|---|
| `bay:<module bay name>` | Where an installed module's origin goes. Its place and turn are the module's pose in the chassis. |
| `empty:<module bay name>` | The cover drawn while that bay is empty. |
| `port:<interface name>` | A port, at the opening, pointing out of it. A module's ports keep their template's `{module}` token, for example `port:TwentyFiveGigE{module}/0/1`. |
| `led:<id>`, `led:port:<interface name>` | A status light: its own mesh, with the material `LED`. |

A module's origin is its mount point: the centre of the bottom edge of its
front face. Bay names must equal the type's module bay names and port names
its interface names, character for character.

## What Danbyte does with them

- **Scanning.** Every model saved - from a pack or uploaded on a type's
  **3D model** card - is scanned for these names. The card's **Anchors** row
  and the upload dialog show what was found (*7 bays, 53 ports, 54 LEDs*)
  and, as warnings, what matched nothing: a `bay:` with no module bay of
  that name, a module bay the model has no anchor for, a `port:` that is no
  interface, an LED without the `LED` material. Warnings never block the
  save.
- **Assembly.** A device draws its chassis, then each installed module
  whose type has a model, posed at the matching `bay:` node. An empty bay
  shows its `empty:` cover; so does a bay whose module has no model yet,
  standing in for it. A cover for a bay the device doesn't have hides. A
  device type's own viewer shows the chassis as modelled, every cover in
  place.
- **Ports.** When the drawn chassis or its installed modules name ports,
  those are the device's port markers in the room and the viewer, and where
  cables end - `{module}` in a module's port becomes the bay's position, as
  in the interface names a module installs. Hand-mapped ports
  ([Map ports](device-catalog.md#model-ports)) are for models that name no
  ports.
- **Distance.** From about 14 m away a model with a far copy draws that
  instead, for the chassis and each part that has one.
- **Budget.** Every part counts against the room's triangle budget. Past
  it, a device draws its chassis alone, then its box.

Module models come from the module type. A reader who may view the device
and its modules but not the module types still sees them: the device serves
them (`/api/devices/{id}/module-model/{module id}/`).

## Importing a pack

A pack is imported with a management command, from a folder or a `.zip` of
one:

```bash
.venv/bin/python manage.py import_model_pack ./cisco-catalyst-9500 --tenant acme
.venv/bin/python manage.py import_model_pack ./cisco-catalyst-9500 --tenant acme --apply
```

- Each YAML is matched to an existing type by **manufacturer and part
  number** (by name when it has no part number). A type that isn't there is
  created from the YAML, with its templates.
- The matched or created type gets the pack's model and far model,
  replacing what it had, with the scan's report per type. A hand-made port
  mapping on the replaced model is cleared.
- The run is a **dry run** unless `--apply` is given: everything is read,
  checked and scanned, the report printed, and nothing kept.
- Models no YAML names are listed and not imported.
- Applied changes land in each type's change log as system writes, with the
  pack's name and version as their cause.

Importing a lone YAML with a `model3d:` block (the device library import)
creates the type and skips the block, with a note: the files come with the
pack.

## API

| Call | Does |
|---|---|
| `GET/POST/DELETE /api/module-types/{id}/model/` | A module type's model, as for device types. View / change on the module type. |
| `GET/POST/DELETE /api/{device-types,module-types,devices}/{id}/model-far/` | The far copy. Needs the full model first; removing the full model removes it too. |
| `GET /api/devices/{id}/module-model/{module id}/` (and `module-model-far/`) | An installed module's model, through its device. |

An upload's answer carries `model_scan`: `summary`, `counts` (`bays`,
`empties`, `ports`, `leds`) and `warnings`. A type's or device's detail read
carries the same as `model_3d_scan`. A device's `model_3d_effective` (and the
floor plan scene's device `model`) adds `far_url`, `empty_mode` and `bays`:
each of its module bays with `installed` and the installed module type's
model URLs as `part` (`url`, `far_url`), or null.
