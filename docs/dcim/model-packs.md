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
    PSU:    { source: "modules.status: PS-*" }
    FAN:    { source: "modules.status: FAN *" }
    "port:*": { source: interface.oper_status }
```

| Key | Meaning |
|---|---|
| `file` | The model, a path inside the pack. Checked like any [upload](device-catalog.md#format-rules). |
| `far` | A low-detail copy drawn from a distance. Optional. |
| `up`, `front`, `fit` | As the [3D model settings](device-catalog.md#3d-models). Packs follow glTF's Y up, front +Z, so these are normally left out. |
| `empty` | What an empty bay shows: its cover (`filler`, the default), the modelled hole (`hole`, also drawn by the cover node), or `nothing`. |
| `leds` | Which data each status light shows. See [Status LEDs](#status-leds). |
| `renders` | Device types: rack-face photos rendered in Blender. See [Rendered photos](#rendered-photos). |

## Names the models carry

The models name the nodes Danbyte reads, exactly, in the glTF file:

| Node | Meaning |
|---|---|
| `bay:<module bay name>` | Where an installed module's origin goes. Its place and turn are the module's pose in the chassis. |
| `empty:<module bay name>` | The cover drawn while that bay is empty. |
| `port:<interface name>` | A port, at the opening, pointing out of it. A module's ports keep their template's `{module}` token, for example `port:TwentyFiveGigE{module}/0/1`. |
| `led:<id>`, `led:port:<interface name>` | A status light: its own mesh, with the material `LED`. |

A module's origin is its mount point: the centre of the bottom edge of its
front face.

### Port sizes

A `port:` empty may carry the exact size of its opening as custom
properties, exported as glTF node `extras` (export spec v1.4):

| Extra | Meaning |
|---|---|
| `danbyte_w` | The opening's width in metres, along the empty's local X as seen from the front. |
| `danbyte_h` | Its height in metres, along the empty's local Y. |
| `danbyte_r` | Optional corner radius in metres, capped at half the short side. |

Measure the cage or jack mouth, not the cage body. The scan stores the
size with the port's anchor, its parents' scale applied (the empty's own
display size is not), along with the opening's width axis. The 3D viewer
and the room draw each port marker as a rounded rectangle exactly that
size, turned with the empty, and generated photo ports use it for their
box. A port with no size, or a size above 0.5 m, uses the standard size
for its port type instead. A module's ports keep their size through the
bay's pose. Bay names must equal the type's module bay names and port names
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
- **Status LEDs.** The `led:` lights glow with live state. See below.

Module models come from the module type. A reader who may view the device
and its modules but not the module types still sees them: the device serves
them (`/api/devices/{id}/module-model/{module id}/`).

## Generated images

A device type with a model can have its rack-face images made from it:
**Generate images** on the type's **3D model** card. The browser renders
the model - with the same loader, materials and studio light as the 3D
viewer - and shows what it made before anything is stored:

- **Front** and **Rear**: straight-on (orthographic) views fitted exactly to
  the rack face - the type's width, else 19 inches (half that for half-width
  gear) - by its rack units, so they drop into a rack slot as they are.
  2000 px wide, WebP. Their photo calibration is set to the face's width.
- **3D**: a three-quarter view, 1600 × 1200, from the front, right and a
  little above. It shows beside the title on the type's and its devices'
  pages and in spec sheets and PDF reports.
- **Photo ports**: every `port:` node is placed on the face it points out
  of, as a [photo port](device-catalog.md#photo-ports). Its box is the
  opening the model names ([port sizes](#port-sizes)), else sized from the
  component's type: an SFP, QSFP or OSFP cage, an RJ45 jack, a USB port, a
  power inlet and so on. `{module}` in a module's port becomes the
  bay's position. A name that matches no component is placed as an
  interface and listed in the dialog's notes.
- **LEDs**: every `led:` node is placed on the face it sits on, with its own
  outline, as `image_leds` - the photo-port shape with kind `led`, the LED
  id as `name`, the module's bay as `bay` and its binding as `source`
  (`port:*` covers port LEDs).

**What the bays show.** By default each bay shows its cover. **Modules** →
**Edit** on the card picks a module type per bay - a *reference
configuration*, such as both power supplies and both fan trays - and the
images show those. A bay must be one of the type's module bays and the
chassis model must have its `bay:` node; the module type must be the
tenant's, one you may view, with a model of its own.

**Nothing made by hand is replaced unasked.** A face uploaded by hand (or
fetched from the library) and a photo-port map placed by hand are kept
unless you tick them in the dialog; ports are not placed on a face that
stays hand-made. Uploading a face or moving a marker by hand makes it
hand-made again.

**Pending.** The card shows **Pending** while an image is missing or was
made from an older state: a new or replaced model, other reference
modules, another size. Uploading a model on the card offers the images
straight away; a [pack import](#importing-a-pack) marks each device type it
gives a model with *images: pending*, and the type's next editor sees the
badge.

**A device's own faces.** A device whose installed modules differ from its
type's can **Render faces** on its 3D model card: the same render with its
own modules, to view and download. **Save photo ports** keeps the port map
as the device's [photo-port override](devices.md); a device keeps drawing
its type's images.

## Rendered photos

A pack can ship each device type's faces rendered in Blender, which look
better than a browser render. Danbyte imports them as the type's photos and
places the ports and LEDs on them itself.

```yaml
model3d:
  file: models/Cisco/C9500-48Y4C.glb
  renders:
    front: models/Cisco/C9500-48Y4C.front.webp
    rear:  models/Cisco/C9500-48Y4C.rear.webp
    iso:   models/Cisco/C9500-48Y4C.iso.webp
    model_sha256: <sha256 of C9500-48Y4C.glb>
    modules:                 # what the renders show: bay → module part number
      PS-0:  C9K-PWR-650WAC-R
      FAN 0: C9K-T1-FANTRAY
```

**The camera.** Front and rear are orthographic and framed to the rack face,
exactly like a [generated image](#generated-images): width W is the type's
width (0.4826 m for 19 inches, 0.2413 m for half width), height H is
`u_height × 0.04445` m, 2000 px across and `round(2000 × H / W)` px high
(2000 × 184 for 1U). Front looks along the model's front, rear from behind
and not mirrored. The 3D view is 1600 × 1200 from the front right, a little
above. All three are WebP or PNG with a transparent background. The full
contract for whoever renders the pack is the export spec's section 12
("Photos rendered in Blender").

**What the import checks.** Each file must be in the pack and be a WebP or
PNG. A front or rear that isn't exactly the type's frame size is skipped
with a note, and so is a missing file. The other faces still import.
`model_sha256` must be the sha256 of the pack's `.glb`. If it isn't, or is
missing, the renders are still imported but marked out of date.

**Reference modules.** `modules` maps each bay to the part number of the
module the renders show. The import looks for the tenant's module type with
that part number, preferring the chassis' manufacturer, and sets the type's
**Modules** (`model_reference`) to match. That way a later browser render
and the LEDs show the same parts. A part number with no module type with a
model, such as a module the pack doesn't ship yet, is noted and its bay left
as a cover. The photos are still used. The import changes the reference
only when nobody has changed it since: it is empty, or it is still what the
last pack import set. A reference you set yourself is kept.

**Ports and LEDs.** The server places them on the rendered faces without a
browser, with the same maths and port-box table as a browser render. It
projects the chassis model's `port:` and `led:` nodes and each reference
module's, posed by its bay's transform. A port node that gives its own
opening size uses it. Otherwise the box comes from the component's type.
The photo calibration is set to the face's width.

**Where a photo came from.** The **Images** row of the 3D model card names
the source of the faces: *From pack Cisco Catalyst 9500 1.1.0*,
*Generated* (a browser render) or *Uploaded* (by hand or from the library).
When faces differ, each source lists its faces.

**Replacing.** Pack photos count as generated photos:

- A pack import replaces pack photos and browser renders.
- It keeps a face uploaded by hand, and photo ports placed by hand, unless
  you pass `--replace-photos`.
- **Generate images** replaces pack photos without asking, for when you
  want a render of your own configuration.

**Out of date.** Pack photos are current while all of these hold:

- The type still has the model they were rendered from: the sha256 matched
  at import, and the model hasn't been replaced since.
- The face frame is the same.
- The reference modules are the ones `modules` names, by part number.

Otherwise the card shows **Pending**, as for generated images, with the
reason on the info icon when the import gave one.

## Status LEDs

A type's `leds:` block binds each `led:<id>` light to a source. A key is an
LED id without the `led:` prefix, or a glob: `port:*` covers every
`led:port:` light. An exact key beats a glob. A light with no entry stays
off.

| Source | The light shows |
|---|---|
| `device.status` | Whether the device is up. Monitoring decides, by the rule root-cause alerting uses: the checks on the primary IP, or on every assigned IP when there is no primary. Down is red. Failing within its fall, or degraded, is blinking amber. Up is green. Only stale checks is off. A lifecycle status that is not in service (planned, or a grey one) is off whatever the checks say. Without monitoring the light shows only an amber or red lifecycle status: green means Danbyte has seen it up. |
| `module.status` | The installed module's status. A module with no status reads as its device's lifecycle status. |
| `modules.status` | The worst status of the modules installed in the bays that match a glob: `"modules.status: PS-*"`, or `{source: modules.status, bays: ["PS-*"]}`. For a chassis' front PSU and FAN lights. |
| `interface.oper_status` | A `port:<name>` light: the interface's state from the last SNMP poll. Up is green, testing is amber, anything else is off, and so is a poll that went stale. A device SNMP doesn't poll at all shows what Danbyte records: green for an enabled port that is cabled or marked connected. |
| `device.locate` | The [locate beacon](devices.md#locate): blinking blue while it is on. |
| `none` | A light Danbyte doesn't drive. Always off. |

An entry may add `only: [red]` (any of `green`, `amber`, `red`, `blue`) so
the light is lit only in those states. A PSU's FAIL light is
`{ source: module.status, only: [red] }`.

- **Colours.** Green, amber, red and blue, plus a dim white *neutral*.
  Unknown or stale data is off: a light never shows a state Danbyte doesn't
  know.
- **Lifecycle colours.** A status counts by its own colour in the status
  catalog, never by its name. A green swatch is green, amber and orange are
  amber, red is red. Grey, blue, or a status flagged *planned* or *excludes
  capacity*, is off. Recolouring a status recolours its lights.
- **Blinking.** Warnings and the beacon blink once a second, every light in
  step. With *reduce motion* set in the viewer's system, lights hold a
  steady colour.
- **Scope.** A reader sees the lights of the devices they may view.
  Without view on the device's deciding IP addresses, `device.status` is
  neutral. Without view on an interface, its port light is neutral. Without
  view on modules, the module lights are neutral. A light never leaks a
  state the reader couldn't read elsewhere.
- **Where.** In the 3D room and the device's 3D viewer, polled every 30
  seconds without reloading the model. On rack-face images that list LED
  positions, the same lights are drawn as small hardware lights over the
  photo.

The YAML import checks every entry. An unknown source, a `modules.status`
without bays, a bad `only` or an unknown key is dropped with a note, and an
exact key the model has no `led:` for is noted. The stored bindings are
validated again on save.

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
- A device type with [rendered photos](#rendered-photos) gets them as its
  faces, with its reference modules, ports and LEDs. A face uploaded by
  hand is kept unless `--replace-photos` is given.
- A device type left without current [generated images](#generated-images)
  is reported as *images: pending*. They render in a browser, so the type's
  page offers them to its next editor.
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
| `GET /api/device-types/{id}/studio/` | What the image renderer needs: the model, `frame_mm` (`[width, height]`), the bays with their reference modules' models and `leds`, the components by name (`ports`: `[kind, type]`), the `token` of the model state, `pending`, `generated`, `hand_made` and `sources` (as `images_source` below). View on the type. |
| `POST /api/device-types/{id}/studio/` | Stores a rendered set (multipart): `front_image`, `rear_image`, `iso_image` (WebP or PNG), `image_ports` and `image_leds` (JSON), `token` (a stale one answers 400) and `overwrite` - the hand-made targets to replace, comma-separated. Answers `written`, `kept` and the type. Change on the type. |
| `GET /api/devices/{id}/studio/` | The same for a device's own faces: its components and its modules' LED bindings. View on the device. |
| `GET /api/device-leds/?devices=<id>,<id>…` | What the status LEDs show now. Also `?device=<id>` or `?rack=<id>`. POST the same keys as a JSON body for long lists (`{"devices": [...]}`). Any other parameter is a 400. |
| `GET/POST /api/devices/{id}/locate/` | The [locate beacon](devices.md#locate). |

A device type's read carries `iso_image`, `image_leds`, `model_reference`
(bay name → module type id, writable with `PATCH`, null for covers) and, on
the detail read, `images_pending` and `images_source`. `images_source` gives
`front`, `rear` and `iso` as `pack`, `generated`, `uploaded` or null, and
`pack` as `{name, version, current, note}` when a face came from a pack.

An upload's answer carries `model_scan`: `summary`, `counts` (`bays`,
`empties`, `ports`, `leds`) and `warnings`. A type's or device's detail read
carries the same as `model_3d_scan`. A device's `model_3d_effective` (and the
floor plan scene's device `model`) adds `far_url`, `empty_mode` and `bays`:
each of its module bays with `installed` and the installed module type's
model URLs as `part` (`url`, `far_url`), or null.

`/api/device-leds/` answers `{as_of, poll_seconds, devices}`. Each device
the reader may view has `leds` (the chassis' lit lights by id, such as
`SYS` or `port:Te1/0/1`), `bays` (each bay's installed module's lit lights
by id, `{module}` resolved to the bay's position) and `locate`. A light left
out is off. A state is `green`, `amber`, `red`, `blue` or `neutral`, with
`_blink` added when it blinks. The query count is the same for one device
as for five hundred.
