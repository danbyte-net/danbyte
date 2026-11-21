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
with a `model3d:` block added, plus the `.glb` files those blocks name. It
may also carry [accessory types](#accessory-types): the plugs,
transceivers and cord plugs Danbyte seats in cabled ports.

## What is in a pack

```text
pack.yaml                                   # name, version, licence
device-types/Cisco/C9500-48Y4C.yaml
module-types/Cisco/C9K-PWR-650WAC-R.yaml
models/Cisco/C9500-48Y4C.glb                # the chassis
models/Cisco/C9500-48Y4C.far.glb            # its far-distance copy (optional)
models/Cisco/C9K-PWR-650WAC-R.glb           # a module
accessory-types/Generic/RJ45-PLUG.yaml      # a plug for cabled ports
models/Generic/RJ45-PLUG.glb
rack-kits/Generic/CABINET/kit.yaml          # a rack style, as a kit of parts
models/Generic/CABINET.kit.glb
models/Generic/CABINET.far.glb
rack-types/Generic/Generic-42U-600x1000.yaml
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

### Suggested modules

Danbyte extends a device type's `module-bays:` entries with `modules:`, the
part numbers of the module types known to fit the bay:

```yaml
module-bays:
  - name: PS-A
    position: A
    modules: [PWR-C1-350WAC-P, PWR-C1-715WAC-P, PWR-C1-1100WAC-P]
  - name: PS-B
    position: B
    modules: [PWR-C1-350WAC-P, PWR-C1-715WAC-P, PWR-C1-1100WAC-P]
  - name: Network Module
    position: '1'
    modules: [C9300-NM-8X, C9300-NM-2Q, C9300-NM-4M]
```

The list becomes the bay template's
[suggested modules](device-catalog.md#suggested-modules): the install
picker offers the tenant's module types with these part numbers first.
Other tools reading the YAML ignore the key. A list, or one comma-separated
string, of at most 100 part numbers; repeats are dropped, ignoring case.
A part number the pack doesn't ship is fine - another pack or the library
may bring it - and the checker only warns.

## Names the models carry

The models name the nodes Danbyte reads, exactly, in the glTF file:

| Node | Meaning |
|---|---|
| `bay:<module bay name>` | Where an installed module's origin goes. Its place and turn are the module's pose in the chassis. |
| `empty:<module bay name>` | The cover drawn while that bay is empty. |
| `port:<interface name>` | A port, at the opening, pointing out of it. A module's ports keep their template's `{module}` token, for example `port:TwentyFiveGigE{module}/0/1`. Any other port-like component is a `port:` named after its template the same way: a console port (`port:con 0`), a PSU's power inlet (`port:PSU{module}`, from `power-ports:` in the YAML), a chassis power port such as a C9300's `port:StackPower1/A`, an aux, front or rear port. |
| `led:<id>`, `led:port:<interface name>` | A status light: its own mesh, with the material `LED`. |
| `cover:port:<interface name>` | A removable blank or dust plug in a port, such as a StackWise blank or an SFP plug: its own mesh, placed where it sits. Shown while the port is free (export spec v1.5). See [Port covers](#port-covers). |

A module's origin is its mount point: the centre of the bottom edge of its
front face.

### Stack members

A model is authored as **stack member 1**: its ports carry the device
library's names, `port:GigabitEthernet1/0/1`. A type whose interface
templates use the [stack-member token](virtual-chassis.md#position-aware-interface-names),
`GigabitEthernet{position}/0/1`, matches them, and on each member they are
that member's own ports: on member 2 the anchor is `GigabitEthernet2/0/1`.
This holds for chassis ports, module ports, port LEDs, port covers and the
ports placed on generated photos.

The pack's YAML is written the same way, in the device library's spelling
for member 1 (`GigabitEthernet1/0/1`, a module's
`TenGigabitEthernet1/{module}/1`). Danbyte decides which types are stack
members. A device type is **stackable** when:

- its YAML's `meta.stackable` is `true` - for a switch that stacks over
  ordinary ports, such as a Catalyst 9500 in StackWise Virtual; or, unless
  `meta.stackable` is `false`,
- it has a stacking port, in the YAML or on the type: an interface of a
  stack type (`cisco-stackwise-480`, `juniper-vcp`, …) or marked
  `stack: true`, or a StackPower port; or
- it has a module bay whose listed module types carry a stacking interface:
  a stack adapter's bay, such as a C9300L's `StackPort1/1` that takes
  `C9300L-STACK-KIT`.

On import, new or matched, a stackable type whose templates don't use the
token yet takes it, as the manual import's **Stack positions** option names
them: `GigabitEthernet1/0/1` becomes `GigabitEthernet{position}/0/1`.

- Interface and power-port templates only, and only their leading member
  number in the type's own spelling (the token most of its interfaces take):
  `GigabitEthernet0/0`, the management port, stays as written. Module bays
  keep their names, so the models' `bay:` anchors match on every member.
- The type's photo markers and faceplate slots follow the rename, and so
  does its pack record, so the YAML's names still match and nothing reads
  as added or removed.
- Then every device of the type in a stack gets its own member's names:
  member 2's `GigabitEthernet1/0/1` becomes `GigabitEthernet2/0/1`, and its
  installed modules' ports too. Same rows, so cables, IP addresses and
  history stay. A name another port of the device already holds is never
  taken: that port keeps member 1's name and the report lists it. The same
  re-render runs on every import for a type that already uses the token, so
  a member added without the rename catches up.
- The report says what it did, the dry run too: *stack members: 52
  templates take the stack-member token; 159 interfaces renamed on 3 stack
  members.* A second import finds nothing to do. Every rename is an
  ordinary, audited save with the import as the cause.

A **module type** is not renamed: on a stackable device its ports take the
device's member number when they are stamped. The leading member number its
YAML writes as `1` becomes the device's, after `{module}` takes the bay's
position, so member 2's `TenGigabitEthernet1/{module}/1` in the Network
Module bay (position `1`) is `TenGigabitEthernet2/1/1`, and a stack kit's
`StackPort{module}` in the bay at position `1/2` is `StackPort2/2`, the
names the switch itself uses. On a type that is no stack member a module's
ports read as written. They follow the device into, around and out of a
stack like its own ports.

- Only the leading member number counts: `{position}` must be the name's
  first number (`Gi{position}/0/1`, `ge-{position:0}/0/0`). A type that
  counts members from 0 (`{position:0}`) is authored as member 0.
- An exact name always wins. A template literally named
  `GigabitEthernet1/0/1` is matched before a `{position}` one.
- A model may spell the token itself, `port:GigabitEthernet{position}/0/1`.
- An anchor that matches two templates (`Gi{position}/0/1` and
  `Gi{position:1}/0/1`) matches neither, and the scan warns.
- Names never match across members: `port:GigabitEthernet2/0/1` is not
  member 1's port.

### Short interface names

A type may spell its ports short, the way the switch's CLI and SNMP do
(`Gi1/0/1`, `Te1/1/1`), under a model that spells them long
(`port:GigabitEthernet1/0/1`), or the other way round. The interface family
at the front of the name matches either spelling, ignoring case; the
numbers after it must still agree exactly:

| Long | Short |
| --- | --- |
| FastEthernet | Fa |
| GigabitEthernet | Gi, Gig |
| TwoGigabitEthernet | Tw, TwoGigE |
| FiveGigabitEthernet | Fi, FiveGigE |
| TenGigabitEthernet | Te, TenGigE |
| TwentyFiveGigE | Twe, TwentyFiveGigabitEthernet |
| FortyGigabitEthernet | Fo, FortyGigE |
| HundredGigE | Hu, HundredGigabitEthernet, HundredGigEthernet |
| AppGigabitEthernet | Ap |
| Port-channel | Po, PortChannel |
| Ethernet | Eth, Et |
| Management | Mgmt, Ma |

This is the last step: an exact name wins, then the stack-member match
above, and only then the other spelling. Two names that are the same port
spelled two ways (`Gi1/0/1` and `GigabitEthernet1/0/1` on one type) are
ambiguous for `port:Gig1/0/1`, and the scan warns. It applies wherever
anchors meet interfaces: the scan's warnings, the device's 3D ports, port
LEDs, port covers, the ports placed on generated photos and a photo
marker's port. Any other prefix (`ge-0/0/0`, `Vlan10`) matches only as
written. The pack checker still compares a pack's own models and YAML
exactly.

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
its interface or other port names, character for character.

The size also shows when an interface's type is wrong. The
[checker](#checking-a-pack) tells RJ45 jacks (about 11.7 × 8.1 mm at the
mouth, up to 14 × 12 mm round the housing), SFP cages (about 13.7 × 8.6 mm),
QSFP cages (about 18.75 × 8.6 mm) and OSFP cages (about 22.6 × 13 mm) apart
by their long and short sides, with wide margins and gaps between them. It
warns when an interface's openings are clearly another connector's than its
type's, such as a `10gbase-t` type on SFP+ cages: Danbyte would draw RJ45
plugs and copper cables in them. Fix the type in the YAML. A size in a gap,
and types without one of those connectors (XFP, X2, GBIC, stacking), are
not checked.

## What Danbyte does with them

- **Scanning.** Every model saved - from a pack or uploaded on a type's
  **3D model** card - is scanned for these names. The card's **Anchors** row
  and the upload dialog show what was found (*7 bays, 53 ports, 54 LEDs*)
  and, as warnings, what matched nothing: a `bay:` with no module bay of
  that name, a module bay the model has no anchor for, a `port:` that is
  neither an interface nor another port of the type, an LED without the
  `LED` material, a `cover:port:` that is no interface, a `cover:` node
  that is not `cover:port:`. Warnings never block the save.
- **Assembly.** A device draws its chassis, then each installed module
  whose type has a model, posed at the matching `bay:` node. An empty bay
  shows its `empty:` cover; so does a bay whose module has no model yet,
  standing in for it. A cover for a bay the device doesn't have hides. A
  device type's own viewer shows the chassis as modelled, every cover in
  place.
- **Ports.** When the drawn chassis or its installed modules name ports,
  those are the device's port markers in the room and the viewer, and where
  cables end - `{module}` in a module's port becomes the bay's position, as
  in the interface names a module installs. A `port:` that names another
  port-like template is a marker of that kind: a console port takes a
  console cable, a PSU's inlet a cable to a PDU outlet, through the same
  **Connect cable…** in the room, the viewer and the photos. Hand-mapped ports
  ([Map ports](device-catalog.md#model-ports)) are for models that name no
  ports.
- **Distance.** From about 14 m away a model with a far copy draws that
  instead, for the chassis and each part that has one.
- **Racks.** A racked device draws its model in its slot, fitted between
  the ears and to its units: the full model while it is big on screen, the
  far copy when smaller, and the box with its generated face photos
  smaller still. At either level every identical device in the rack (same
  model, same installed modules) shares one instanced draw per part.
  See [Devices in racks](../features/floor-plans.md#the-3d-room-view).
- **Budget.** Every part counts against the room's triangle budget. Past
  it, a floor device draws its chassis alone, then its box; a racked device
  its far copy, then its box. Floor devices spend first.
- **Status LEDs.** The `led:` lights glow with live state. See below.
- **Port covers.** A `cover:port:` blank hides once its port is cabled or
  marked connected. See [Port covers](#port-covers).
- **Plugs.** A cabled port shows what is plugged into it - a transceiver
  and its cord, or a plug - from the pack's accessory types, and the
  room's cable run starts at the cord. See [Accessory types](#accessory-types).

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

**Light.** The viewer and the generated images share one studio light:
AgX tone mapping (Blender's default view), a built-in photo-studio
environment of soft light panels for metal to reflect (no image files),
one key light from the front right, a dim fill, and a softbox close over
the model's back whose falloff gives a lid its soft gradient. The images
average many renders with the key moved across its softbox and a light
moved across the sky, for soft shadows and contact shading in recesses.
**Front** and **Rear** keep a transparent background with no ground; the
**3D** view and the viewer's 3D preset stand the model on a soft shadow.
The 3D room keeps its own light. How the live viewer draws it is under
[How the viewer lights a model](#how-the-viewer-lights-a-model).

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

## How the viewer lights a model

The **3D model** viewer (a type's, a module type's or a device's Overview,
and its fullscreen) aims for a studio product shot rather than a flat
preview:

- **Studio light.** The [studio light](#generated-images) above, with the
  key light and the top softbox casting soft shadows. Their shadow cameras
  are fitted to the model, so modules shade the chassis and ears shade the
  bezel without the blocky edges a room-sized shadow would have.
- **Ambient occlusion.** On a capable graphics card the viewer adds
  screen-space ambient occlusion: port cages, vents, seams and the gaps
  between modules darken a little, as they do in a ray-traced render. Port
  markers, bay outlines, lit LEDs, glass and the ground shadow draw over
  it with their exact colours. A software
  renderer, a browser without WebGL 2 float targets or a device with less
  than 4 GB of memory gets the plain render, shadows and all. To force
  either in one browser, set `danbyte:viewer-look` in its local storage to
  `full` or `plain`.
- **Baked occlusion from packs.** A model that carries its own baked
  ambient occlusion - an `occlusionTexture` on a second UV set
  (`TEXCOORD_1`), export spec v1.8 - uses it everywhere it is drawn: the
  viewer, the generated images, the room and its racks (full and far
  copies alike), modules and covers included; a lit LED glows over it. It
  darkens the light a part takes from its surroundings (the studio
  environment and ambient light), which is most of the studio's. The viewer's screen-space occlusion is
  then lighter, so the two don't add up to soot. gltfpack's `-cc`
  compression keeps both UV sets; nothing needs to change on import.

The room and its racks keep plain rendering: hundreds of devices at once
can't afford the extra passes. Uploading a model through the converter
(STEP, OBJ, …) keeps a glb's second UV set; **Simplify** drops the UV sets
and so the textures that use them.

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
- **Where.** In the 3D room - on floor devices and racked ones - and the
  device's 3D viewer, polled every 30 seconds without reloading the model:
  one request for every model the room draws. On rack-face images that list LED
  positions, the same lights are drawn as small hardware lights over the
  photo.

The YAML import checks every entry. An unknown source, a `modules.status`
without bays, a bad `only` or an unknown key is dropped with a note, and an
exact key the model has no `led:` for is noted. The stored bindings are
validated again on save.

## Installing in the app

**Settings → Device library → 3D model packs** lists the packs installed in
the tenant, grouped under the [bundle](#bundles) they came from: name,
version, licence, author, how many types they brought, and when and by whom
they were installed. **Install pack…** adds one:

1. **Upload** a `.zip` of the pack or of a [bundle](#bundles) (the way in
   for an airgapped install),
   or give its **URL**. A URL must be `https`, under the configured pack
   source or on an allowed host; see
   [the settings](../reference/settings.md#3d-model-packs-model_pack_).
2. Danbyte **checks** it in the background: it downloads it, refuses an
   unsafe archive, runs the [pack checker](#checking-a-pack) and a **dry
   run** of the import. The dialog shows the result: the types it would
   create or update, with each type's notes (its model scan, photos,
   reference modules), every error and warning the checker found, and
   [what the pack needs](#requires).
3. **Install** applies it, again in the background, with an optional
   **Replace hand-uploaded photos** (the `--replace-photos` of the command
   below) and **Update from pack** (`--overwrite`: what the dry run lists as
   *kept* takes the pack's values; see
   [What a re-import changes](#what-a-re-import-changes)). A pack with check
   errors can't be installed in the app; fix the pack, or import it with the
   command.

Nothing changes before Install. The install is one transaction: a failure
leaves every type as it was. Each change lands in the type's change log
under the installer's name, with *Pack import: <name> <version>* as its
cause. The pack's own page shows what it changed (**Types**, with a link to
each), the checker's table (**Models**) and findings (**Checks**), its
other versions and its change log.

**Reinstalling.** Installing a pack whose `id` is already installed (a new
version, or the same one again) updates the types it matches, and the older
record becomes *Replaced*. The dry run names the installed version and lists,
per type, what the install would add, update, remove and keep.

**Forget** removes the pack's record and nothing else: the device and
module types, their models and photos stay. There is no uninstall: a pack
replaces models and photos on types that devices use, and undoing that
can't know what was there before or what has been changed since. To take a
model off a type, remove it on the type.

Who may: reading the list takes view on device types. Installing and
forgetting take tenant admin rights plus add and change on device types and
module types, unconstrained and on every site, because a pack's types are
the whole tenant's. The background jobs check these again when they run.

A pack that is checked but never installed is dropped after a day; a check
or install that stops (a worker restart) is marked failed after two hours.

### Bundles

A **bundle** is one download holding several packs: the library's
`cisco-catalyst` bundle holds the Catalyst 9200, 9300 and 9500 packs, Cisco
optics and generic connectors; `danbyte-starter` holds every pack. Packs stay
what Danbyte tracks; a bundle has no entries of its own.

```text
danbyte-starter-1.6.23/
  bundle.yaml          # id, name, description, version, packs: [{id, name, version}]
  packs/
    generic-connectors/  # a complete pack folder, with its pack.yaml
    cisco-optics/
    …
```

**Install pack…** takes a bundle zip like a pack zip. The check runs the
[pack checker](#checking-a-pack) and a dry run **per pack**, in the order
`bundle.yaml` lists them, and shows a row per pack: a tick, its status, what
it would create and update, its errors and warnings, what it needs, and,
unfolded, its types and findings.

| Status | Means |
|---|---|
| Ready | No check errors; not installed yet. |
| Errors | Check errors: not installed. |
| Installed | This version is installed. Installing again updates its types. |
| Update | Another version is installed. |

Above the rows are the bundle's own problems: a pack `bundle.yaml` lists
that the archive doesn't hold (an error on that pack), a folder under
`packs/` it doesn't list (a warning; not installed), a list entry that isn't
a pack id, and a pack whose `pack.yaml` `id` or `version` isn't what
`bundle.yaml` says (an error on that pack).

**Install** applies the ticked packs (all of them unless you untick some),
in the bundle's order, each **in its own transaction**: a pack with check
errors is skipped and reported, a pack whose install fails is rolled back
and reported, and the others still install. *Replace hand-uploaded photos*
and *Update from pack* apply to every ticked pack. Each pack's changes land
in the change log with its own *Pack import: <name> <version>* cause. The
dialog then lists each pack as Installed, Skipped or Failed, with why.

Each installed pack gets **its own record**, as when installed alone, naming
the bundle it came from (*From bundle* on its page). The list groups packs
under their bundle. The bundle's own row (its page shows the per-pack check
and what the install did) is kept like a pack's; forgetting it leaves the
packs' records, which keep the bundle's name.

**Installing a bundle again** matches each pack by its `id`: the same
version updates that pack's record, a new version gets a new record and the
older one becomes *Replaced*. A later single-pack install of one of them
replaces just that pack. The types are matched by manufacturer and part
number as always, and each type's pack link (its `pack_state`) moves to the
pack that imported it last.

**A pack from before the split.** A tenant may have one pack record that
held everything (an early *Cisco Catalyst 9500* that also carried the 9200,
9300 and optics). Installing the split packs updates the same types, nothing
is duplicated, and once none of that record's types names it any more (they
all moved to the split packs) it becomes *Replaced*. While some of its types
are still its own (only part of the bundle installed), it stays installed.

A pack's dry run is against the tenant as it is: a pack that builds on
another pack of the same bundle may show notes the install won't have,
because the packs install in order. Module part numbers in another pack of
the bundle count as found for the checker.

### What a pack requires {#requires}

`pack.yaml` may list the packs a pack needs, by id:

```yaml
id: cisco-catalyst-9300
requires: [generic-connectors]
```

The check lists each one as **Installed** (with its version), **In bundle**
or **Missing**. Missing is a warning, never a refusal: a switch without plug
models still works. For a missing pack:

- with a pack catalog configured
  ([`MODEL_PACK_CATALOG_URL`](../reference/settings.md#3d-model-packs-model_pack_),
  the library's `packs.json`) that lists it, an **Install with it** tick
  downloads it, checks it and installs it **first**. The download passes the
  same guards as any pack URL (under the pack source or an allowed host,
  `https`, redirects only to allowed hosts, the size cap, the outbound-request
  guard), its SHA-256 must be the catalog's when the catalog gives one, and
  its `pack.yaml` `id` must be the one asked for; a pack with check errors is
  skipped. Its own `requires` are listed on its page, not followed.
- otherwise (airgapped, no catalog, or not listed) the warning names the zip
  to get, `<id>-<version>.zip` - the library builds every pack at one
  version - to upload as well.

### Security limits

A pack is data. Nothing in it is executed, and nothing is extracted to
disk: each file is read into memory and goes through the same validators
as an upload. The archive is refused as a whole when:

- an entry's path is absolute, has a drive, a backslash or `..`, or isn't
  plain;
- an entry is a symbolic link or another non-regular file, is encrypted, or
  is in the archive twice;
- a file isn't one a pack holds: `.yaml`, `.yml`, `.glb`, `.webp`, `.png`
  or `.md` (hidden files, `__MACOSX/` and a working folder's `release/` and `report/` are ignored, never read);
- a file is over its cap: a model over
  [`DEVICE_MODEL_MAX_BYTES`](../reference/settings.md#device-3d-models-device_model_max_bytes),
  an image over 8 MB, a YAML over 2 MB, a Markdown file over 1 MB;
- a file over 1 MB inflates more than 200 times, there are more than 5,000
  entries, or the whole unpacks to more than 1 GB.

Every `.glb` is checked like an upload, and every image must be a WebP or
PNG that Pillow verifies, at most 4,096 px a side. The upload is capped at
`MODEL_PACK_MAX_BYTES`, and so is a download, which also passes the
outbound-request guard and may only be redirected to an allowed host. The
archive's SHA-256 is recorded, and an install refuses an archive that
changed since its check.

A [bundle](#bundles) is one archive and gets **one** set of these limits,
not one per pack: the upload cap, the 5,000 entries and the 1 GB unpacked
total are for the whole bundle, and each file has its cap as in a pack, so a
bundle is never a way round a limit. A path that leaves its pack folder
(`packs/<id>/../…`) refuses the whole bundle. The starter bundle (43 MB, 293
files, 60 MB unpacked) fits the default cap, so an airgapped install uploads
it in one go.

## Checking a pack

The pack checker runs the review Danbyte gives a pack before shipping or
installing it, against the export spec:

```bash
.venv/bin/python manage.py check_model_pack ./cisco-catalyst-9500
.venv/bin/python manage.py check_model_pack cisco-catalyst-9500.zip --json
```

It prints a row per type (triangles and size of the model and its far
copy, bays, ports, LEDs, errors, warnings) and every finding, and exits `1`
when there is an error, `0` otherwise. A [bundle](#bundles) is checked pack by
pack, with the bundle's own problems first; it fails when any pack or the
bundle has an error, and `--json` gives `{ok, bundle, problems, packs: [{id,
name, version, report}]}`. `--json` prints the report for CI. It
writes nothing and reads no database, unless `--tenant <slug>` is given: a
render's module part number may then be a module type the tenant has.

| Check | Error | Warning |
|---|---|---|
| Archive | A refusal from [the limits above](#security-limits). | |
| `pack.yaml` | Missing; no `name`, `id`, `version` or `license`; `types` lists a part with no YAML. | No `types`; a YAML it doesn't list; a `requires` entry that isn't a pack id. |
| Accessory types | No `name`; a `kind` other than `plug`, `transceiver`, `cord`, `blanking`, `cable-manager` or `shelf`; no usable `fits` (a rack part: no `u_height` of 1 to 10, or 0 for a cable manager); `model3d.file` missing, outside the pack or not a valid `.glb`. | A `fits` entry that isn't a type slug; `parts` not a list, or an entry that isn't a part number; a `wavelength_nm` that isn't a whole number of nm; a `cable:` block that isn't usable (unknown `profile`, no `jacket_mm`, a size that isn't a positive number of mm, a ribbon without a `count` of 2-8 or a `pitch_mm` at least its jacket, a key Danbyte doesn't read), a `min_bend_by_part` entry that isn't a positive size or names a part the accessory doesn't list, or one on a transceiver; a part number two accessory types list; over the triangle budget (a transceiver 1,500, a cord or plug 2,000); a transceiver with a connector but no `port:<connector>` empty; a cord with a `cable:` block but no `cable` empty; a part `types: accessory:` doesn't list. |
| Rack kits | No `name`; a `frame` other than `cabinet`, `4-post`, `2-post` or `wall-cabinet`; `model3d.file` or `far` missing from the pack or not a valid `.glb`; no `post:segment` in the model. | No far box; over the budget (the kit 20,000 triangles, its far box 2,000); a stretched part without `danbyte_ref_mm`, or a `danbyte_stretch` that isn't `x`, `y`, `z` or a mix; a door without its `hinge` empty; a pathway without its sizes; a part name Danbyte doesn't read; a `colours` entry that isn't a hex colour; a kit `types: rack-kit:` doesn't list. |
| Rack types | No `manufacturer` or `model`; a `look.kit` that is no kit in the pack (or the tenant). | A `look:` value Danbyte doesn't know; a rack type `types: rack-type:` doesn't list. |
| Models | Not a valid `.glb`; over the triangle budget (chassis 150,000, far 15,000; module 30,000, far 3,000) or the size budget (8 MB, far 1 MB). | A model no YAML names; no far copy on a chassis or on a module of 5,000 triangles or more. |
| Names | `bay:` with no module bay in the YAML; `bay:` in a module; `empty:` without its `bay:`; `port:` with no interface or other port (console, power, aux, front or rear port) in the YAML, `led:port:` with no interface (module names with `{module}`, as written); a name twice; an LED not on the `LED` material; the far copy missing a `bay:`, `empty:` or `led:` of the full model. | A module bay without a `bay:`; interfaces without a `port:`. |
| LEDs | A `leds:` entry that doesn't parse or names no `led:` in the model; on a module type, a `led:` without an entry. | On a chassis, a `led:` without an entry (it stays off); a glob matching nothing. |
| Port sizes | | Ports without `danbyte_w` / `danbyte_h`; an interface whose opening is clearly another connector's: an RJ45 (`*base-t`) type on an SFP-sized opening, an SFP type on a QSFP- or RJ45-sized one, a QSFP type on an SFP-sized one, and so on. |
| Suggested modules | A `module-bays` entry's `modules` that isn't a list of part numbers. | A part number in neither the pack nor the tenant. |
| Renders | A file missing, not a WebP or PNG, or without a transparent background; a front or rear not exactly the type's face frame at 2,000 px across; `model_sha256` missing or not the `.glb`'s; `modules` naming a bay the YAML or the model lacks, or a part number in neither the pack nor the tenant. | No front or rear render; renders on a module type. |

The in-app check runs the same checker, with the tenant.

## Port covers

A `cover:port:<interface name>` mesh is a blank or dust plug that comes
out when a cable goes in: the StackWise blanks on a C9300's stack ports, the
two halves of its StackPower blank (`cover:port:StackPower1/A` and `/B`, one
per power port), an SFP cage's plug. Cage and jack geometry that is always there stays part of
the chassis.

- **When it shows.** On a device, a cover shows while its port is free and
  hides once the port has a cable on it or is marked connected. Removing
  the cable brings it back on the next poll (30 seconds).
- **Names.** The name is matched as a `port:` anchor's: authored as stack
  member 1 (`cover:port:StackPort1/1` is member 2's `StackPort2/1`), and a
  module's covers keep `{module}`, which takes the bay's position.
- **Where.** In the device's 3D viewer and in the 3D room, on floor and
  racked devices. A rack's models are drawn instanced, one draw for
  every identical device; a cover there is hidden for each device on its
  own.
- **Types.** A device type has no cabling: its viewer, its generated images
  and a pack's rendered photos show every cover. A device's own **Render
  faces** hides the covers of its ports in use.
- **Power ports.** A cover named after a power port (a StackPower port)
  hides once a cable is on that power port.
- **Scope.** Only the interfaces and power ports the reader may view count.
  Without view on them every cover stays as modelled, so the cabling doesn't
  show.

## Accessory types

When a port is in use, Danbyte shows what is plugged into it: an RJ45 plug
with its boot, an SFP transceiver with its LC duplex cord, a DAC head, an
IEC cord in a power inlet, a USB console plug. Each is an **accessory
type**: one small part per file, seated at the port's `port:` anchor and
coloured from the cable.

```text
accessory-types/Generic/RJ45-PLUG.yaml
models/Generic/RJ45-PLUG.glb
```

```yaml
name: RJ45-PLUG
kind: plug                     # plug | transceiver | cord
connector: rj45
fits: [1000base-t, 2.5gbase-t, 5gbase-t, 10gbase-t, 100base-tx, rj-45]
model3d:
  file: models/Generic/RJ45-PLUG.glb
```

`pack.yaml` lists them under `types: accessory: [RJ45-PLUG, …]`.

| Key | Meaning |
|---|---|
| `name` | The part's name, unique with its folder (the vendor, `Generic` above). |
| `kind` | `transceiver` (a module in a cage, which takes a cord), `plug` (a cord or plug: `RJ45-PLUG`, `LC-DUPLEX`, `MPO-12`, `IEC-C13`) or `cord` (a one-piece part: a DAC or AOC, body and cable together). |
| `connector` | What it takes or ends in: `rj45`, `lc`, `mpo`, `dac`, `aoc`, `iec-c13`, `usb-mini-b`… A transceiver's connector names the cord it takes; a cord's says which transceivers it plugs into. |
| `fits` | The interface, front port, console port and power port type slugs it plugs into (`10gbase-x-sfpp`, `lc-duplex`, `rj-45`, `iec-60320-c14`). |
| `model3d.file` | The part's model. Its origin is where it meets the port, +Z out along the cable, +Y up - the same as the `port:` empty in Blender, so the part seats itself. (Blender's glTF exporter turns every empty so its arrow is the node's local +Y; Danbyte turns it back before seating a part, on host ports, a transceiver's `port:<connector>` and a cord's `cable` empty.) |
| `parts` | Optional. A real transceiver's vendor part numbers - every one this model stands for, as printed on the label (`SFP-10G-SR`, not `SFP-10G-SR=`). |
| `standard` | Optional. The IEEE / MSA name: `10GBASE-SR`, `100GBASE-SR4`. |
| `wavelength_nm` | Optional. The nominal wavelength in nm; leave it out for copper. |
| `cable` | Optional, on a cord or plug. How Danbyte draws the run from its `cable` empty (below). |

**Transceivers and cords are separate parts** (export spec §13 v1.9). A
transceiver's model holds the module alone, plus an empty
**`port:<connector>`** (`port:lc`, `port:mpo`, `port:rj45`) on its
receptacle face: centred between the bores, +Z out, +Y up. Danbyte seats
the cord at that empty. A cord's origin is its mating face, and its stub
ends in an empty named **`cable`**: +Z along the cable, +Y up, a zip
cord's or ribbon's jackets along ±X, centred on it (turn the empty so its X
runs the way the jackets lie). Both ends of a cable use the same cord model.

A real transceiver, modelled by its part number:

```yaml
name: SFP-10G-SR
kind: transceiver
connector: lc
fits: [10gbase-x-sfpp]
parts: [SFP-10G-SR, SFP-10G-SR-S, SFP-10G-SR-X]
standard: 10GBASE-SR
wavelength_nm: 850
model3d:
  file: models/Cisco/SFP-10G-SR.glb
```

A generic one per cage type - `SFP-GENERIC`, `QSFP-GENERIC`, with
`parts: []` - stands in for a cabled cage with no transceiver recorded.

A cord, with its run:

```yaml
name: LC-DUPLEX
kind: plug
connector: lc
fits: [lc-duplex, lc-apc-duplex]   # LC panel front ports
cable:
  profile: zipcord      # zipcord (two jackets side by side) | round | ribbon
  jacket_mm: 1.8        # each jacket's diameter
  pitch_mm: 1.84        # zipcord and ribbon: centre to centre
  min_bend_mm: 30
model3d:
  file: models/Generic/LC-DUPLEX.glb
```

| `cable` key | Meaning |
|---|---|
| `profile` | `zipcord`: two jackets side by side, `pitch_mm` apart. `round`: one jacket. `ribbon`: `count` jackets side by side, `pitch_mm` apart. |
| `jacket_mm` | Each jacket's diameter. Needed. |
| `pitch_mm` | Centre-to-centre spacing. A zip cord's defaults to, and is never less than, `jacket_mm`; a ribbon needs one no less than `jacket_mm`. A round cable has none. |
| `count` | A ribbon's jackets, 2 to 8. Needed for a ribbon; a zip cord is always two, a round cable one. |
| `min_bend_mm` | Optional. The tightest bend Danbyte draws where there is room. |
| `min_bend_by_part` | Optional. `{part number: mm}` for a length that needs a wider bend than `min_bend_mm`. A recorded cable whose label is that part number bends by it. A part the accessory's `parts` doesn't list is kept with a warning. |

Sizes are positive numbers of mm (up to 50 for a jacket, 100 for a pitch,
2,000 for a bend). A ribbon without a usable `count` or `pitch_mm` is left
out with a warning. A block Danbyte can't use is left out with a warning;
the cord then draws, and its run is drawn as before.

### Stack-cable heads {#stack-cable-heads}

A switch stack's [stack cables](virtual-chassis.md#in-3d) seat a head at
each end: one `kind: cord` part per stack port family, listing every
length it stands for in `parts`, with a `cable:` block for the run.

```yaml
name: STACK-T1
kind: cord
connector: stack
fits: [cisco-stackwise-480, cisco-stackwise-1t]
parts: [STACK-T1-50CM, STACK-T1-1M, STACK-T1-3M]
cable:
  profile: ribbon
  count: 3
  pitch_mm: 11.2
  jacket_mm: 6.1
  min_bend_mm: 41
  min_bend_by_part:
    STACK-T1-3M: 82
model3d:
  file: models/Cisco/STACK-T1.glb
```

`connector: stack` marks a stack-cable head for every vendor. It names no
medium (not fibre, copper or DAC), so the head is never picked for a data
port's cable, and the pack check doesn't flag it. Danbyte picks the head by the stack port's type (`fits`): the part whose
`parts` lists a recorded cable's label first, else the first by vendor and
name. A port of a generic family type takes a family member's head when no
part fits it exactly - most device-type libraries type StackWise ports plain
`cisco-stackwise`:

| Port type | Takes a head that fits, in this order |
|---|---|
| `cisco-stackwise` | `cisco-stackwise-480`, `-1t`, `-320`, `-160`, `-80` |
| `extreme-summitstack` | `extreme-summitstack-512`, `-256`, `-128` |

The head's `parts` are also the lengths [Record
cable](virtual-chassis.md#record-a-derived-cable) offers and the label
[auto-connect](virtual-chassis.md#auto-connect) gives a cable (its shortest
part): a part number ending in a plain length (`-50CM`, `-1M`, `-150CM`)
sets the cable's length too. The run is drawn between the two heads' `cable` empties in the head's
`cable:` profile: one round jacket, or a zip cord's or ribbon's jackets side
by side along the empties' ±X, untwisted, hanging in a loop behind the
stack ([how a cable hangs](virtual-chassis.md#in-3d)). An `END_BAND` ring on
the head is yellow at the cable's A end and green at its B end. A recorded
cable whose label names
a `min_bend_by_part` length bends by it; a derived ring uses `min_bend_mm`. Without a
fitting part, a plain cable runs between the port anchors. A stack over data
ports needs no special part: mark the interfaces `stack: true` in the device
type's YAML (a Danbyte key, ignored elsewhere; it sets the template's
**Stack port**) and their DAC, optic or RJ45 head is used.

StackPower ports take a head the same way. They are the chassis'
`power-ports` of type `cisco-stackpower` (a Danbyte type, like the stacking
interface types), each with its `port:` empty and its own
`cover:port:` blank, and the cord fits that type:

```yaml
# device-types/Cisco/C9300-48P.yaml
power-ports:
  - name: StackPower1/A
    type: cisco-stackpower
  - name: StackPower1/B
    type: cisco-stackpower
---
# accessory-types/Cisco/CAB-SPWR.yaml
name: CAB-SPWR
kind: cord
connector: stack
fits: [cisco-stackpower]
parts: [CAB-SPWR-30CM, CAB-SPWR-150CM]
cable: {profile: round, jacket_mm: 8.5, min_bend_mm: 40}
```

Its `END_BAND` follows Cisco's marking - green on the end that may only go
into a switch, yellow on the end that may also go into an XPS - and between
two switches is coloured as any stack cable's, yellow at A and green at B
([StackPower in 3D](virtual-chassis.md#stackpower)).

### Which parts a port shows

A port shows parts once it has a cable on it, is marked connected, or
holds a [transceiver record](inventory.md#transceivers) the reader may
view. Per port Danbyte draws up to two parts:

| Port has | Cable in it | Danbyte draws |
|---|---|---|
| a transceiver record | no | the transceiver |
| a transceiver record | yes | the transceiver, plus the cord at its `port:<connector>` |
| no record, a cage (SFP, QSFP…) | yes, fibre | the generic transceiver (`SFP-GENERIC`) and the cord |
| no record, an SFP cage | yes, twisted pair | a copper SFP-T and an `RJ45-PLUG` at its `port:rj45` |
| no record | yes, DAC or AOC | the one-piece DAC or AOC alone, at the port |
| no transceiver: an RJ45 jack, an LC panel port, a power inlet | yes | the plug or cord alone, at the port's anchor |

- **The transceiver.** A record's **3D part** when one is set by hand, else
  the accessory type whose `parts` lists the record's part ID. The match
  ignores case and a trailing `=` (the spare-part suffix): a record
  `sfp-10g-sr=` draws `SFP-10G-SR`. When two accessory types list the same
  part number, the first by vendor and name wins. A record whose part no
  model stands for shows the generic transceiver for its cage.
- **The generic transceiver** is a `kind: transceiver` part that fits the
  cage, of the cable's medium (optical for fibre, `rj45` for twisted pair),
  without `parts` before a real optic. A cable with no type, one the reader
  may not view, or a port only marked connected takes the optical one.
- **The cord** is the `plug` or `cord` whose `connector` is the record's
  connector, else the transceiver's, else the cable's (`lc` for fibre,
  `rj45` for twisted pair). `mpo-12` takes an `mpo` cord. A part that fits
  a cage is never taken as a cord.
- **A one-piece part** (`kind: cord`, or a `plug` that fits the cage) takes
  the port alone and shows only while the port is cabled. A record whose
  part is one, such as `SFP-H10GB-CU3M`, shows nothing without a cable.
- **A port with no transceiver** takes the part whose `fits` names its type.
  When several fit, the cable's type decides: a DAC cable (`dac-active`,
  `dac-passive`) takes the `dac` part, a fibre cable (`mmf…`, `smf…`,
  `aoc`) an optical one, a twisted-pair cable (`cat…`) an RJ45 one.
- A cable of a type no fitting part matches shows nothing rather than a
  wrong part. No part fits: the port shows nothing more than today (its
  [cover](#port-covers) hidden).

**Where they sit.** The transceiver at the port's `port:` anchor; the cord
at the transceiver's `port:<connector>` empty - the cord's connector first,
then the transceiver's, else the transceiver's only `port:` empty - and at
the port's own anchor when there is no transceiver or its model has no such
empty. A cord waits for its transceiver's model to load.

**Colours.** Danbyte sets four materials; everything else keeps its own:

| Material | Colour |
|---|---|
| `CABLE` (copper jackets and boots, power cords, DACs) | the cable's colour, grey when it has none |
| `FIBRE` (fibre jackets, matching boots) | the cable's colour, else by type: OS1/OS2 yellow, OM1/OM2 orange, OM3/OM4 aqua, OM5 lime |
| `LC_BODY` (LC bodies and the duplex clip) | by type: single-mode UPC blue, APC green, OM1/OM2 beige, OM3/OM4 aqua, OM5 lime |
| `END_BAND` (v1.12: a ring that tells a cable's two ends apart, such as a stack cable head's) | by the cable's side at the port: the A end yellow, the B end green; grey when no side is known |

APC is an `-apc` port or front-port type (`lc-apc-duplex`) or connector.
Plain `mmf` counts as OM1/OM2, `smf` as OS1/OS2, `aoc` as OM3/OM4. A cable
the reader may not view leaves all four grey. The Pluggables page's
preview shows an `END_BAND` as an A end.

**Cable runs from a cord.** In the [3D room](../features/floor-plans.md#the-3d-room-view),
where a cord is drawn at an end, the cable's run starts at the cord's
`cable` empty and leaves straight along its +Z, so it continues the stub.
With the cord's `cable:` block the run takes its cross-section at life size
(times the View menu's cable scale): a zip cord as two jackets side by side,
a ribbon as its `count`, centred on the route, carried along it without
twisting from the `cable` empty's +Y and turned evenly to meet the far
end's; a round cable as one jacket. Corners bend no tighter than
`min_bend_mm` - or the `min_bend_by_part` entry the cable's label names -
where the route leaves room; between two
close ports it bends as tightly as it must. A fibre run with a cord takes
the `FIBRE` colour. An end without a cord drawn - a far copy, or a device
without a model - starts at the port as before.

### Show, ghost or hide {#pluggables-show-ghost-hide}

The seated parts are the **Pluggables**. Each viewer chooses how they draw,
in the device viewer's toolbar (**Pluggables**) or the 3D room's View menu
(**Pluggables**, under Cables). The choice is kept in this browser and
shared by the device viewer, a rack's 3D view and the room.

| Choice | What draws |
|---|---|
| **Show** (default) | The transceivers, cords and plugs as they are. |
| **Ghost** | The same parts at a quarter opacity, greyed, so the port markers read through them. |
| **Hide** | No parts: the bare faceplate. Cable runs start at the port again. Port covers stay hidden on ports in use. |

While the device viewer's **Ports** is on, the parts ghost for as long as
it is on, unless they are hidden. The hovered or selected port keeps its
own part solid.

With the parts ghosted, each port's [marker](../features/floor-plans.md#port-markers-on-3d-models)
draws its wash on the front of the part in it - the transceiver's nose, or
the cord's mating face - instead of at the cage mouth behind it, and the
rims draw about twice as thick. A hovered or selected port's wash moves to
the front in every mode. The markers keep their depth test, so they never
show through the chassis from behind or the side.

**Cost.** Each part loads once for the whole room and draws instanced: 48
SFPs with 48 cords cost the meshes of two parts, not 96 copies. Parts show
only on a device's full model: in its 3D viewer and in the 3D room up
close, on the floor and in racks. A far copy draws none, so no far LOD is
needed. Budgets: a transceiver 1,500 triangles, a cord or plug 2,000.

**Picking.** A part hovers, clicks and right-clicks as the port it sits
in: the port's pick reaches out over it. The port's hover card names the
recorded transceiver's part ID and serial under the port name.

**Scope.** Only the ports the reader may view count, as for covers. The
cable's colour and type are read only from cables the reader may view, and
a transceiver record counts only for a reader who may view inventory
items. Accessory types are tenant-wide, like module types. A reader who
may view pluggables downloads a part once for the room
(`/api/accessory-types/{id}/model/`); anyone else gets it through the
device (`/api/devices/{id}/accessory-model/{accessory id}/`).

Until a pack with accessory types is installed, cabled ports show no plug.

**Pluggables page.** DCIM → Catalog → [Pluggables](pluggables.md) lists the
tenant's accessory types with how many ports use each, shows one in the 3D
viewer with its cord seated and the cable colours previewed, and lets an
editor change its fits, part numbers, standard, wavelength, reach and
cable, or replace its model. A field changed there is kept by the next
pack import ([Changed by hand](pluggables.md#changed-by-hand)).

## Rack kits {#rack-kits}

Danbyte builds every rack from its own data - height in U, rail width,
outer width and depth, rail depth and its [Look](racks.md#look) - so a
pack doesn't carry one model per rack size. It carries a **rack kit**: one
style of rack as named parts, which the 3D view assembles to each rack
(the export spec §14).

```yaml
# rack-kits/Generic/CABINET/kit.yaml
name: CABINET
frame: cabinet                # cabinet | 4-post | 2-post | wall-cabinet
model3d:
  file: models/Generic/CABINET.kit.glb
  far: models/Generic/CABINET.far.glb
widths_mm: [600, 800]
depths_mm: [1000, 1200]
colours: { black: "#1b1c1e", grey: "#c9ccce" }
pathways:                     # optional: the vertical managers its racks have
  installed: [path:vertical:left:front, path:vertical:right:front,
              path:vertical:left:rear, path:vertical:right:rear]
```

`pack.yaml` lists kits under `types: rack-kit: [CABINET, …]`.

The kit's model holds every part as a named object, modelled in place for a
600 × 1000 mm, 42U reference cabinet:

| Part | How the 3D view uses it |
|---|---|
| `post:segment` | Exactly 1U of a rail post. Repeated for every unit at each post - front and rear, left and right (mirrored), two mid-depth posts on a 2-post frame - its rail face on the rack's rail plane. Every segment of a rack draws in one instanced draw call. Required. |
| `post:top`, `post:bottom` | Each post's end pieces: the bottom one under unit 1, the top one over the top unit, beside the post as modelled. |
| `beam:width`, `beam:depth`, `corner:top`, `corner:bottom` | The frame. One of each is modelled: corners go to the four corners top and bottom, a width beam front and rear, a depth beam left and right, and the beams again at the bottom corners. A 2-post frame's tie beam is single. |
| `top:vented`, `top:solid`, `top:fans`, `top:brush` | The roof the Look's Top names (else solid, else vented); none for Top *None*. |
| `base:plinth`, `base:casters`, `base:feet`, `base:plate`, `base:panel` | The base the Look names - casters and feet at the four corners - or, when the kit hasn't got it, one it has; none for Base *None*. `base:plate` for a 2-post frame, `base:panel` (the bottom) for a wall cabinet whatever its Base. |
| `side:panel` | Side panels, in solid mode, when the Look has them. One modelled is mirrored for the other side. |
| `side:panel:edge`, `side:panel:infill` | A split side panel (v1.15), drawn in place of `side:panel` when the kit has both: the edge at the bottom and mirrored to the top, the infill stretched between, so the edge keeps its size at any height. |
| `door:perforated`, `door:glass`, `door:solid` | The leaf the door type names; a split door is two half-width leaves. The rear door is the front one turned round. |
| `door:<kind>:stile`, `door:<kind>:rail`, `door:<kind>:infill` | A split leaf (v1.15), drawn in place of the whole `door:<kind>` when the kit has all three: the stile at the hinge edge (it carries the `hinge` empty) and mirrored to the free edge, the rail at the bottom and mirrored to the top, the infill stretched between - so a half-width split leaf keeps 30 mm frame members. A glass infill in alpha BLEND (`RACK_Glass_Smoked`) is drawn see-through, after the gear behind it. |
| `door:handle`, `door:hinge`, `door:lock` | Hardware, swinging with its leaf at its own size, at its distance to the leaf's nearer edges. |
| `wall:bracket` | A wall cabinet's mounting plate. |
| `label:u` | One unit of a post's U-number strip, beside the holes. Danbyte draws the strip on every post and, with U numbers on, prints the rack's own numbering on it. |
| `channel:0u:<left\|right>:<front\|rear>` | An empty: a 0U channel. A side-mounted 0U device (a vertical PDU) is seated on it - its back on the empty, facing the empty's +Z - in place of where Danbyte puts it without a kit. |
| `pdu:bracket` | A child of a `channel:0u:` empty: the bar a seated 0U device hangs on, drawn behind each one, as long as it. |

The import also reads the kit's [pathways](racks.md#pathways) (spec §14
v1.13), stored with the kit (`pathways` on `/api/rack-kits/`) and given to
every rack built from it:

| Part | What Danbyte records |
|---|---|
| `path:vertical:<left\|right>:<front\|rear\|full>` | A vertical manager or channel on that side and face, the rack's full height. Its child empty `path` gives `danbyte_inner_w` / `danbyte_inner_d` (mm) and `danbyte_kind` (`finger`, `d-ring`, `channel`, `lacing`). The ones `kit.yaml` lists under `pathways: installed:` are installed; without the list a cabinet installs its front and rear ones, other frames one per side (rear, else full depth, else front). The others are add-ons a rack can show. v1.16: `danbyte_open` on the `path` empty (`front`, `rear`, `inner`, `outer`, `ends`) is the side cables enter from, `danbyte_pitch_mm` its finger pitch, and a part `<name>:cover` its cover. |
| `entry:<top\|bottom\|side>:<name>` | A cable entry: `danbyte_w` / `danbyte_h` (mm) and `danbyte_kind` (`open`, `brush`, `gland`, `sealed`), with its place across and back as a share of the roof or base it is a child of. A rack takes the entries of the roof and base its Look draws. |
| `channel:0u:<left\|right>:<front\|rear>` | A 0U channel: `danbyte_depth` (mm behind the front rail), `danbyte_len_u` (its length at the reference height; a taller rack keeps the units it leaves free) and its lower end above unit 1. |

A `path` without its sizes, or an entry without `danbyte_w` / `danbyte_h`,
is noted on import and by the checker. The 3D views draw each shown
manager in its [place](racks.md#pathways) and the cables along it
([In 3D](racks.md#cable-ways-3d)); `brush:*` meshes come with their roof or
base and are not noted. Any other name with a `:` is
noted on import.

**How a kit fits a rack.** The import reads the kit's reference rack from
its `post:segment` (stored as its *fit*): unit 1's height above the floor,
the front rail's distance behind the front (the glTF z = 0 plane, or a
frame part ahead of it such as a 2-post's base plate), the frame above the
top unit and the post's size. A rack built from the kit stands its gear on
those: unit 1 at the kit's height, the front rail at its inset, the rear
rail `rail_depth_mm` behind it, and the rack as tall as its units plus the
kit's frame. The posts stay beside the rail opening (moved out for a 21"
or 23" rail) whatever the outer width; a cabinet's or wall cabinet's frame,
panels, roof and base fill its outer box. An open frame is as wide as its
kit and as deep as its rails: a 4-post's rear members are its front ones
turned round onto the rear rail, a 2-post keeps the kit's depth round its
one rail. A kit imported before 0.21 has no fit and stands on Danbyte's
own 100 mm base until it is imported again.

Every part is fitted to the rack: one that isn't stretched keeps its size
and moves with the nearer edge of the cabinet (a corner, a caster); a part
with the custom property `danbyte_stretch` (`x`, `y`, `z` in Blender's axes,
or a mix) is stretched along those axes so both its ends keep their distance
to the cabinet's edges. Its tiling textures are rescaled so holes keep their
real size: the repeat is taken as covering `danbyte_ref_mm` (1000 mm by
default), or one tile per `danbyte_tile_mm` on a material without a
transform. A stretched part may be modelled in place at its size in the
reference cabinet, or as a `danbyte_ref_mm` (1000 mm) mesh with its origin
at its start: Danbyte then lays it out at its reference size first, across
symmetric about the centre, front to back as far from the rear as it starts
from the front of the kit's first `depths_mm` (so list the reference depth
first), and up to the roof's underside. Door hardware moves with its leaf at
its own size. Objects with Blender's `.001` suffixes are the same part. The
`FRAME` material takes the rack's colour; everything else keeps its own.
A door's `hinge` empty gives its hinge side as modelled; Danbyte mirrors it
for the other. A kit's baked ambient occlusion is left off: its parts are
repeated per unit or moved from where they were baked, so a bake would show
as patches and seams. The import records each `channel:0u:` empty's place
and facing; a kit imported before 0.21 seats no 0U devices until it is
imported again. Without a channel, a 0U device on an open frame is bolted to
the outer side of a post (the rear one on a 4-post, unless its face is
front), and in a cabinet stands between its front and rear posts. A door
gets a second `door:hinge`, mirrored up its leaf.

The far box (`model3d.far`) is fitted to the rack's outer box and drawn at
middle distance; far off the room draws its plain box, as for every rack. An
open frame (2-post, 4-post) is never drawn as a box: at middle and far
distance it is Danbyte's own posts and beams.
Without a kit, or while it loads, a rack is Danbyte's own drawing of its
Look. A reader who may view rack types loads one copy of a kit for the
whole room (`/api/rack-kits/{id}/model/`); anyone else who may view the
rack loads it through the rack (`/api/racks/{id}/kit-model/`).

Rack kits are a tenant's own, like accessory types, under the rack type
grant: view to list and read them, delete to delete one (its rack types
and racks then draw Danbyte's rack). There is nothing to edit by hand: a
re-import replaces them, pathways included - a rack's changes to a kit
pathway stay, the rest follows the new kit. `GET /api/rack-kits/` lists them (`frame`,
`search`), `GET /api/rack-kits/{id}/model/` serves the parts and
`?far=1` the far box.

### Rack types from a pack

```yaml
# rack-types/Generic/Generic-42U-600x1000.yaml
manufacturer: Generic
model: Generic 42U 600x1000 cabinet
u_height: 42
width: 19
outer_width_mm: 600
outer_depth_mm: 1000
rail_depth_mm: 740
look:
  kit: CABINET
  front_door: perforated
  rear_door: split-perforated
  hinge: left
  side_panels: true
  top: vented
  base: plinth
  colour: black
```

A rack type file is a [library rack type](racks.md#rack-types) with
`outer_width_mm` / `outer_depth_mm` (millimetres, beside the library's
`outer_width` / `outer_unit`), `rail_depth_mm` and the `look:` block. A
type that names a kit but no `frame` takes the kit's frame; `top: none`,
`base: none` and `base: plate` are read, and `rail_depth_mm: 0` (a 2-post's
missing rear rail) is the same as leaving it out. A re-import updates the
Look of a type it matches by name.
`pack.yaml` lists them under `types: rack-type: [<model>, …]`.

### Rack accessories {#rack-accessories}

Three more accessory kinds are rack parts, not port parts: `blanking`
(`BLANK-1U`, `BLANK-2U`), `cable-manager` (`CM-1U-BRUSH`, `CM-2U-FINGER`…)
and `shelf` (`SHELF-1U-FIXED`, `SHELF-2U-SLIDING`). They fit no port, so
they have no `fits:`, and give their height instead:

```yaml
name: BLANK-1U
kind: blanking
u_height: 1
model3d:
  file: models/Generic/BLANK-1U.glb
```

Their origin is a device's: the front of the ears. A rack's
[blanking fill](racks.md#look) draws the blanking parts in its empty units,
put in from the front: the ears' back on the front rail's face, two empty
units taking a `BLANK-2U`.
Cable managers and shelves are imported and listed on the Pluggables page;
the 3D view doesn't place them yet. A cable manager's model may carry a
`path` empty (`danbyte_inner_w`, `danbyte_inner_d`, `danbyte_kind`): its
inner channel is recorded with it (`pathway` on `/api/accessory-types/`).

A **vertical** cable manager such as `CM-VERT-2POST` is `kind:
cable-manager` with `u_height: 0`: it takes no units. It is a model a
rack's or rack type's vertical [pathway](racks.md#pathways) can be (its
**Model**), which then takes its type and inner size from it.

```yaml
name: CM-VERT-2POST
kind: cable-manager
u_height: 0
model3d:
  file: models/Generic/CM-VERT-2POST.glb
```

## Importing a pack

A pack can also be imported with a management command, from a folder or a
`.zip` of one:

```bash
.venv/bin/python manage.py import_model_pack ./cisco-catalyst-9500 --tenant acme
.venv/bin/python manage.py import_model_pack ./cisco-catalyst-9500 --tenant acme --apply
```

- Each YAML is matched to an existing type by **manufacturer and part
  number** (by name when it has no part number). A type that isn't there is
  created from the YAML, with its templates. A matched device or module
  type's templates, bay module lists, lifecycle dates (device types) and
  links follow the YAML, keeping what was changed in Danbyte: see
  [What a re-import changes](#what-a-re-import-changes).
- The matched or created type gets the pack's model and far model,
  replacing what it had, with the scan's report per type. A hand-made port
  mapping on the replaced model is cleared.
- The run is a **dry run** unless `--apply` is given: everything is read,
  checked and scanned, the report printed, and nothing kept. `--overwrite`
  is the app's **Update from pack**.
- Accessory types are matched by folder (vendor) and name, created or
  updated, and get the pack's model. They are reported as *accessory type*
  rows. A field [changed by hand](pluggables.md#changed-by-hand) on the
  Pluggables page - and a model replaced there - is kept, with a note.
- Rack kits are matched by folder (vendor) and name, created or updated,
  and get the pack's kit and far models (*rack kit* rows). Rack types are
  matched by name: a new one is created from its YAML; a matched one gets
  the YAML's Look and its `meta` (below), nothing else (*rack type* rows). A `look.kit` names a
  kit of the pack - imported first - or one the tenant has.
- Models no YAML names are listed and not imported.
- A device type with [rendered photos](#rendered-photos) gets them as its
  faces, with its reference modules, ports and LEDs. A face uploaded by
  hand is kept unless `--replace-photos` is given.
- A device type left without current [generated images](#generated-images)
  is reported as *images: pending*. They render in a browser, so the type's
  page offers them to its next editor.
- Applied changes land in each type's change log as system writes, with
  *Pack import: <name> <version>* as their cause.

A bundle imports pack by pack, in its order, each in its own transaction;
`--only` picks packs:

```bash
.venv/bin/python manage.py import_model_pack danbyte-starter-1.6.23.zip --tenant acme
.venv/bin/python manage.py import_model_pack danbyte-starter-1.6.23.zip --tenant acme \
    --only generic-connectors,cisco-optics --apply
```

Each pack's section prints its check's errors, what it needs and the import
report. Like a lone pack, the command imports a pack with check errors (the
app skips it) and keeps no pack record.

Importing a lone YAML with a `model3d:` block (the device library import)
creates the type and skips the block, with a note: the files come with the
pack.

## What a re-import changes

A pack's YAML changes between versions: an interface's type is corrected
(`cisco-stackwise` to `cisco-stackwise-480`), StackPower ports are added, a
bay's module list grows, an interface becomes a module bay (a C9200's
StackPort, now a stack adapter's bay). A re-import brings each matched
device and module type in line with its YAML, and keeps what was changed in
Danbyte since.

To tell the two apart, each import records on the type what the pack said:
every template it listed with the values it gave, the lifecycle dates, the
documents it linked and the whole `meta` block (`pack_state`, read-only). On
the next import, field by field:

| The type's value | Re-import |
|---|---|
| equals what the last import set | takes the YAML's value (*updated*) |
| equals the YAML's value | nothing to do |
| is empty | takes the YAML's value |
| differs from both | kept (*kept your edit*) |

Templates (interfaces, console and console-server ports, power ports and
outlets, front and rear ports, module bays, device bays; a module type's
interfaces and power ports), by name - a new interface or power port is
`{position}`-named on a type whose interfaces are
([Stack members](#stack-members)):

- One the YAML has and the type lacks is **added**; one the last import
  added and someone removed since stays removed (*kept your removal*).
- One the YAML no longer has is **removed** only when the last import set it,
  it is unchanged since, and nothing depends on it: a front port still on a
  rear port, an outlet on a power port, a faceplate slot or port marker
  placed by hand, a module port of an installed module. Otherwise it is
  kept, and the report says why (*changed here*, *still in use*, *not in the
  pack*). The record keeps every template name an import listed, so a
  template the pack dropped versions ago still counts as the pack's.
- A bay's [suggested modules](#suggested-modules) merge: part numbers the
  pack added since the last import join the bay's list, ones it dropped
  leave it, ones added here stay.

A type imported before this record existed (from the device library, or an
earlier pack import) has nothing to compare with, so everything on it counts
as its own: missing templates and empty fields are filled in, differences
are reported as *kept*, and nothing is removed. The record is written then,
so the next import compares against it.

**Update from pack** (`--overwrite`) lets the YAML win: every *kept* value
takes the pack's, and removed ones come back. A template the YAML doesn't
have is removed only when **a pack once added it** - some earlier import
recorded its name on the type - and nothing depends on it, even if it was
changed here. A template no import ever recorded (made by hand, or by the
device library import before packs) is kept and reported (*kept 16
interfaces not from a pack: GigabitEthernet1/1/1, …*). On a type with no
record at all, Update from pack updates values and adds what is missing,
removes nothing, and says so (*no earlier pack record: nothing removed*).
Documents added or edited here are still left alone.

The import doesn't change a device, with two exceptions: a stack member
type's devices in a stack get their own member's port names
([Stack members](#stack-members)), and a port that becomes a module bay
(next section). The report counts the devices of a type
whose components no longer match its templates (*devices: 3 of 5 out of
step*); the type's **Sync devices** adds and removes their components.
Existing components keep the values they were made with, and an installed
module keeps the ports it was stamped with.

### A port that becomes a module bay {#port-to-module-bay}

A pack can move a fixed port into a module: a C9300L's `StackPort1/1` and
`StackPort1/2` interfaces become two bays of those names that take
`C9300L-STACK-KIT` or `C9300L-STACK-KIT2`, whose `StackPort{module}`
renders to the same name in the bay at position `1/1`. The C9200 already
works this way with `C9200-STACK-KIT`. When a re-import removes an
interface or power port template **and** the type has a bay whose module
list names a module type of the tenant (by part number) that, installed in
that bay, makes a port of exactly that name, the import carries the type's
devices over, in the same transaction:

- **The bay.** Every device of the type gets the bay, when it has none of
  that name, as a new device of the type would.
- **A port in use moves onto a module.** A module of a matching type is
  installed in the bay and the device's existing port becomes that
  module's port: the same row, so its cables, stack links, IP addresses,
  history and monitoring stay. No second port is made. A field that still
  holds what the removed template gave takes the module template's value
  (`cisco-stackwise` becomes `cisco-stackwise-320`); a field changed here
  keeps its value. The module's description says the pack update added it.
- **A port not in use stays.** Nothing is installed that the switch may not
  have, and nothing is deleted. The report lists them (*kept 4 interfaces
  StackPort1/1, StackPort1/2 on 2 devices, not in use - install a module in
  the bay or delete them*). Installing a kit in the bay can
  [adopt](device-catalog.md#adopting-existing-components) a port of the
  kit's type; **Sync devices** removes it.
- A bay that already holds a module, or whose module would clash with
  another port of the device, is left alone and reported.

A port is **in use** when it has a cable (recorded, auto-connected by its
stack, or marked connected); when its device is a member of a stack and the
port is a stack port (the [derived ring](virtual-chassis.md#in-3d) runs
through it); when anything points at it (an IP or MAC address, a LAG,
bridge or sub-interface member, a transceiver, a reservation, a power
outlet, a routing or monitoring record); when it has its own VLAN, VRF, LAG,
bridge, parent or MACsec setting, or tags; or when it was edited here (a
label, a custom field value, a description other than its template's).

**Which module.** A bay that takes several module types gets the first in
its list whose port has the port's own type, else the type of the port at
the cable's other end, else a type of its stacking family
(`cisco-stackwise` covers `cisco-stackwise-480`, `-320`, `-80`, …), else
the first in the list. The two C9300L kits have the same port, so a
C9300L gets `C9300L-STACK-KIT`.

The dry run reports it per type:

```text
- devices: added module bays StackPort1/1, StackPort1/2 to 4 devices: …
- devices: installed 4 C9200L-STACK-KIT modules in StackPort1/1, StackPort1/2
  on 2 devices, each holding the existing port it replaces: …
- devices: moved 4 interfaces onto the modules - cables, stack links and history stay
- devices: kept 4 interfaces StackPort1/1, StackPort1/2 on 2 devices, not in use - …
```

Every change is an ordinary save in the change log with the pack as its
cause, in the importing tenant only. A second import removes no template
and does nothing here. A type whose template was removed by an earlier
import is not revisited: install the kit by hand and adopt the port.

The dry run (the app's check, or the command without `--apply`) shows each
type's changes in its notes, grouped: *added 2 power ports: StackPower1/A,
StackPower1/B*, *updated 2 interfaces, type cisco-stackwise →
cisco-stackwise-480: StackPort1/1, StackPort1/2*, *removed 2 interfaces:
StackPort1/1, StackPort1/2*, *kept your edit on 1 interface, type
2.5gbase-t (the pack has 1000base-t): GigabitEthernet1/0/1*. The install is
the same run, kept: one transaction for the pack, each change in the change
log with the pack as its cause, in the importing tenant only.

## Meta {#meta}

A YAML's `meta:` block (the export spec's §8) describes the hardware:

```yaml
meta:
  category: switch
  roles: [core, aggregation, campus]
  family: "Catalyst 9500"
  summary: "40-port 1/10G SFP/SFP+ 1RU core/aggregation switch."
  stackable: true                  # StackWise Virtual: a stack member type
  lifecycle:
    release_date: 2017-06          # YYYY-MM-DD, or YYYY-MM
    end_of_sale: "2024-04-30"
    end_of_support: "2029-04-30"
    source: "https://www.cisco.com/…/c9500-12q-c9500-24q-c9500-40x-eol.html"
  links:
    - { kind: datasheet, title: "Cisco Catalyst 9500 Series Data Sheet", url: "https://…" }
    - { kind: eol-notice, url: "https://…" }
```

What Danbyte does with it, on a new and a matched type alike, with the same
rule for changes made here as the templates:

| Key | Device type | Module type | Rack type | Accessory type, rack kit |
|---|---|---|---|---|
| `lifecycle` dates | the [lifecycle](../features/lifecycle.md) fields | kept in the record | kept in the record | kept in the record |
| `lifecycle.source` | the vendor notice URL | kept in the record | kept in the record | kept in the record |
| `links` | link documents on the **Documents** tab | link documents on the **Documents** tab | kept in the record | kept in the record |
| `summary` | the description, while it is empty | the description, while it is empty | the description, while it is empty | kept in the record |
| `stackable` | `true` or `false`: whether the type is a [stack member](#stack-members), over what its ports say | kept in the record | kept in the record | kept in the record |
| `category`, `family`, `roles`, `sources` | kept in the record | kept in the record | kept in the record | kept in the record |

Only device types have lifecycle fields; device and module types have a
Documents tab. The other kinds keep the whole block in their record (an
accessory type's and rack kit's in `pack_import`), so nothing is lost and a
later Danbyte can use it: a module type's lifecycle dates stay in its
record. A module type imported before module types took documents holds its
links only there; its next import creates the documents.

- **Dates.** A key the pack leaves out leaves the field alone: Danbyte
  never guesses. A month-only date is stored as the first of the month for
  `release_date` and the month's last day for an end date, since the
  fields hold whole dates. An unreadable date is skipped with a note.
- **Links.** One link document per URL, named by its `title` (or by its
  kind: *Data sheet*, *Installation guide*, …), in a category by its kind:
  *Datasheet*, *Install guide*, *Config guide*, *Product page*, *EoL
  notice*, *EoL listing*, *Support*, *Software*, *White paper*
  (`white-paper`), *Other*. A category is
  created in the tenant the first time a link needs it, or one of yours of
  the same name is used; it is an ordinary, editable category. A
  re-import renames a document it made when the title changes and removes
  one the pack dropped, unless it was edited here. A document you added -
  also one with the same URL - is never touched. A link must be a public
  `http(s)` URL; Danbyte doesn't fetch it at import (the
  [dead-link check](../features/documents.md#dead-link-checking) does,
  through the outbound-request guards).
- **Links in `comments`.** The Markdown links in the YAML's `comments`
  (`[… Data Sheet](https://…)`, as the community device type library writes
  them) join `links` as link documents, after them: a URL in `links` wins,
  and the category comes from the link text (*Datasheet*, *Install guide*,
  *Config guide*, *EoL notice*, else *Other*). They are tracked in the
  record like the others, so a re-import keeps your removal or edit. A new
  type's description is the plain text of `comments` (empty when they are
  nothing but links); on a matched type whose description still holds the
  YAML's `comments` word for word, the description becomes that plain text.
  See [Vendor links in comments](device-catalog.md#importing-from-the-netbox-devicetype-library).
- **Summary.** Becomes the description only while that is empty; a type
  created from a pack already has the plain text of the YAML's `comments`
  there, so the summary fills it when those were only links.

## API

| Call | Does |
|---|---|
| `GET /api/model-packs/` | The tenant's packs and bundles, newest first; `?status=installed` (comma-separated statuses: `checking`, `checked`, `refused`, `installing`, `installed`, `failed`, `replaced`), `?kind=pack` or `bundle`. Each row has `kind`, `requires` (pack ids) and `bundle` (`{id, slug, name, version}` of the bundle a pack came from - `id` null once the bundle's row is forgotten - or null). View on device types. |
| `GET /api/model-packs/{id}/` | One pack, with `report` (`check`: the checker's report; `import`: the dry run; `installed`: the version installed before; `needs`: each required pack's `{id, state, installed, zip, available}`, `state` `installed`, `bundle` or `missing`, `available` the catalog's `{url, name, version, sha256, size}`; `catalog_error`), `result` (what the install did: `created`, `matched`, `errors`, `types`, and `requires`: the required packs installed with it), `files`, `history` and `needs` (the required packs as they stand now). A bundle's `report` has `bundle` (its `bundle.yaml`), `problems` (`[{level, message}]`) and `packs`: a section per pack with `id`, `name`, `version`, `license`, `author`, `description`, `requires`, `files`, `check`, `import`, `installed`, `needs`, `installable` and `status` (`ready`, `errors`, `installed`, `update`); its `result` has `packs`: per pack `{id, name, version, status, reason, record, created, matched, errors, superseded}`, `status` `installed`, `skipped`, `failed` (or `refused`, for a required pack). Each of `types` has `kind`, `path`, `name`, `action`, `id`, `notes` and, for device and module types, `changes` (`added`, `updated`, `removed`, `kept`). |
| `POST /api/model-packs/` | Add a pack or a bundle: a multipart `file` (`.zip`) or JSON `{"url": …}`. Answers `202` with the row; poll it while `status` is `checking`. `413` over the size cap. Install rights. |
| `POST /api/model-packs/{id}/install/` | Install a checked pack without check errors, or a checked bundle with at least one (`installable`). Body `{"replace_photos": bool, "overwrite": bool, "packs": [id, …], "with": [id, …]}` (`overwrite`: Update from pack; `packs`: a bundle's packs to install, default all - one with check errors is skipped; `with`: missing required packs the catalog offers, installed first). `202`; poll while `installing`. `400` for a `packs` id not in the bundle or a `with` id the catalog doesn't offer; `409` for a pack that isn't checked, has errors, a bundle with nothing installable picked, or while another installs. |
| `DELETE /api/model-packs/{id}/` | Forget the pack: the record and its archive. The types stay. Forgetting a bundle leaves its packs' records. |
| `GET /api/model-packs/limits/` | `max_bytes`, `source_url`, `catalog_url`, `allowed_hosts`, `downloads` (false when airgapped) and `can_install`. |
| `GET/POST/DELETE /api/module-types/{id}/model/` | A module type's model, as for device types. View / change on the module type. |
| `GET/POST/DELETE /api/{device-types,module-types,devices}/{id}/model-far/` | The far copy. Needs the full model first; removing the full model removes it too. |
| `GET /api/devices/{id}/module-model/{module id}/` (and `module-model-far/`) | An installed module's model, through its device. |
| `GET /api/device-types/{id}/studio/` | What the image renderer needs: the model, `frame_mm` (`[width, height]`), the bays with their reference modules' models and `leds`, the components by name (`ports`: `[kind, type]`), the `token` of the model state, `pending`, `generated`, `hand_made` and `sources` (as `images_source` below). View on the type. |
| `POST /api/device-types/{id}/studio/` | Stores a rendered set (multipart): `front_image`, `rear_image`, `iso_image` (WebP or PNG), `image_ports` and `image_leds` (JSON), `token` (a stale one answers 400) and `overwrite` - the hand-made targets to replace, comma-separated. Answers `written`, `kept` and the type. Change on the type. |
| `GET /api/devices/{id}/studio/` | The same for a device's own faces: its components, its modules' LED bindings, the port covers to hide (`covers`, `bay_covers`) and the plugs in its cabled ports (`plugs`), as on `/api/device-leds/`. View on the device. |
| `GET /api/accessory-types/` (and `{id}/`) | The tenant's [accessory types](#accessory-types): `vendor`, `name`, `kind`, `connector`, `fits`, `parts`, `standard`, `wavelength_nm`, `reach_m`, `cable`, `model_url`, `pack_import`, `hand_edited`, `in_use`. View on module types. Editing, usage and delete: [Pluggables → API](pluggables.md#api). |
| `GET /api/accessory-types/{id}/model/` | An accessory type's model. View on module types; a `POST` replaces it (change). |
| `GET /api/devices/{id}/accessory-model/{accessory id}/` | The same through a device, for a reader who may view the device but not module types. |
| `GET /api/device-leds/?devices=<id>,<id>…` | What the status LEDs show now. Also `?device=<id>` or `?rack=<id>`. POST the same keys as a JSON body for long lists (`{"devices": [...]}`). Any other parameter is a 400. |
| `GET/POST /api/devices/{id}/locate/` | The [locate beacon](devices.md#locate). |

A device type's read carries `iso_image`, `image_leds`, `model_reference`
(bay name → module type id, writable with `PATCH`, null for covers) and, on
the detail read, `images_pending` and `images_source`. `images_source` gives
`front`, `rear` and `iso` as `pack`, `generated`, `uploaded` or null, and
`pack` as `{name, version, current, note}` when a face came from a pack.

An upload's answer carries `model_scan`: `summary`, `counts` (`bays`,
`empties`, `ports`, `leds`, `port_covers`) and `warnings`. A type's or device's detail read
carries the same as `model_3d_scan`. A device's `model_3d_effective` (and the
floor plan scene's device `model`) adds `far_url`, `empty_mode` and `bays`:
each of its module bays with `installed` and the installed module type's
model URLs as `part` (`url`, `far_url`), or null.

`/api/device-leds/` answers `{as_of, poll_seconds, devices, stacks}`. Each device
the reader may view has `leds` (the chassis' lit lights by id, such as
`SYS` or `port:Te1/0/1`), `bays` (each bay's installed module's lit lights
by id, `{module}` resolved to the bay's position) and `locate`. `covers`
lists the chassis' port covers to hide, by their names in the model, and
`bay_covers` each bay's installed module's, `{module}` resolved. `plugs`
lists the [accessory types](#accessory-types) seated in its ports:
each `{port, bay, name, port_type, cabled, color, cable_type, transceiver,
transceiver_part, cord_part}` - the `port:` anchor as drawn (in the module
at `bay`, null for the chassis), the device's port it stands for and its
type, whether a cable is in the port (false for a port listed only for its
transceiver record), the cable's colour (`#rrggbb`, or null) and type (""
when unknown), and the record's `{part_id, serial}` or null.
`transceiver_part` (`{url, kind, connector}`) sits at the anchor;
`cord_part` (`{url, kind, connector, cable}`, `cable` the cord's `cable:`
block or null) at the transceiver's `port:<connector>`, or at the anchor
when there is no transceiver. Either may be null; a port with a record
that draws nothing is still listed, for its hover card. A switch stack
member also has `stack` (`{id, name, position, master, master_name}`, or
null), `stack_plugs` (rows like `plugs`, plus `derived`, for the ends of its
[stack cables](virtual-chassis.md#in-3d) and StackPower cables; those
ports are not in `plugs`) and `stack_covers` (the covers only a derived ring hides - the viewer hides
them while stacks are drawn). `stacks` lists the stacks among the devices:
`{id, name, master, members: [{device, name, position}], links}`, each link
`{a, b, kind, derived, cable, color, label}` with ends `{device, port,
name}` (the anchor as drawn and the interface or power port); `kind` is
`data` for a stack cable, `power` for a [StackPower](virtual-chassis.md#stackpower)
cable. A light left
out is off. A state is `green`, `amber`, `red`, `blue` or `neutral`, with
`_blink` added when it blinks. The query count is the same for one device
as for five hundred.
