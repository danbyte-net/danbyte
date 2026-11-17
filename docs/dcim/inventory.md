---
icon: lucide/package
---

# Inventory & transceivers

**Inventory items** are the serial-tracked parts of a device that aren't
ports: disks, CPUs, memory, PSUs, fans, controllers and transceivers. They
live on the device's **Components → Hardware** tab, each with a name, kind,
status, manufacturer, part ID, serial, asset tag and description, and the
hardware facts its kind carries (a disk's media and capacity, a CPU's
cores). A part can sit under another part, one level deep.

Add one with **Add → Inventory part** on the device page. A `[1-5]` range in
the name adds one part per number, as on the other component dialogs.

## Transceivers

An inventory item of kind **Transceiver** can record the port it sits in:
which optic is in `Te1/1/3`, its part ID and serial, its standard and reach.
The record is the inventory item - one row, with its status, audit and
journal - linked to the interface.

| Field | Meaning |
|---|---|
| **Port** | The interface it sits in. One transceiver per port. |
| **Standard** | The IEEE / MSA name: `10GBASE-SR`, `100GBASE-SR4`, `1000BASE-T`. The form suggests common ones; any text is allowed. |
| **Connector** | `LC`, `SC`, `MPO-12`, `MPO-16`, `RJ45`, `DAC`, `AOC` or `Other`. |
| **Wavelength (nm)** | 850, 1310, 1550, a CWDM or DWDM channel. |
| **Reach (m)** | The rated reach. |
| **3D part** | The [pluggable](pluggables.md) (accessory type) to draw in the port, set through the API (`accessory_type_id`). Left empty, Danbyte draws the one whose part numbers list the item's part ID. |

**Rules.** Danbyte checks these on every save - the form, the API and bulk edit
alike:

- Only an item of kind **Transceiver** sits in a port. Changing a seated
  item's kind, one at a time or in bulk, is refused until it is taken out.
- The port is on the item's own device. A port an installed module added
  counts.
- The port takes a transceiver: an SFP, SFP+, SFP28, QSFP+, QSFP28, CFP,
  OSFP or other pluggable type (the *pluggable transceivers* and *Fibre
  Channel* groups of the [interface types](type-taxonomy.md)), or `Other`.
- A port holds one transceiver.
- The port, like the item, is in the current tenant. Writing takes change
  rights on inventory items at the device's site.

**When the port goes.** Deleting the interface, uninstalling the module that
added it, or deleting that module keeps the inventory item and clears its
port: the optic was pulled, it didn't vanish. A module re-stamped onto
another type or bay keeps its interfaces, and with them their transceivers.

### Setting a port's transceiver

On an interface of a pluggable type, the Overview's **Interface** card has a
**Transceiver** row: the part ID, serial and standard of the optic in it.

- **Set** opens a dialog that either picks one of the device's free
  transceivers (**From inventory**) or creates one in place (**New**: name,
  part ID, serial, standard, connector, wavelength, reach).
- **Change** does the same for a port that has one; the old one comes out
  and stays in the inventory.
- **Remove** takes it out of the port. The item stays on the device.

The device's inventory form shows **Port**, **Standard**, **Connector**,
**Wavelength** and **Reach** for a transceiver, so a part can be seated from
there too.

### Where transceivers show

- **Hardware tab:** the inventory table's **Port** column names each
  transceiver's port, linked to the interface. Its **Part ID** links to the
  transceiver's [pluggable](pluggables.md) - the one set by hand, else the
  one whose part numbers list it - for a reader who may view module types.
- **[Transceivers list](#transceivers-list):** every transceiver in the
  tenant.
- **Interface page:** the Transceiver row shows the part in 3D, with its
  cord while cabled, linked to its pluggable.
- **Interface lists:** the optional **Transceiver** column (pick it in the
  Columns menu) shows the part ID.
- **3D:** a port with a transceiver draws its part even with no cable in it.
  Once a cable is plugged in, the cord for the transceiver's connector (an
  LC duplex, an MPO trunk, an RJ45 plug in an SFP-T) sits in it, and the 3D
  room's cable run starts at that cord. The connector field picks the cord
  first, before the part's own. A one-piece DAC or AOC shows only while
  cabled. The port's hover card names the part ID and serial. See
  [Which parts a port shows](model-packs.md#which-parts-a-port-shows).

Each of these shows a transceiver only to a reader who may view inventory
items at the device's site; anyone else sees the port without it.

### API

`/api/inventory-items/` carries the fields above: `interface` (`{id, name}`,
written as `interface_id`), `standard`, `wavelength_nm`, `reach_m`,
`connector`, and `accessory_type` (`{id, vendor, name}`, written as
`accessory_type_id`). Read only: `pluggable` (`{id, vendor, name}`, a
transceiver's part - set by hand, else matched by part ID - or null) and
`site` (the device's, `{id, name}`); in the list, `interface` also carries
`cabled` (a cable ends on the port, or it is marked connected). The list
takes `kind=transceiver`, `in_port=true|false`, `site`, `part` (part ID
contains), `standard` (exact, any case) and `cabled=true|false` beside
`device`; `search` also matches the serial, part ID and asset tag. Bulk edit sets `standard`,
`connector`, `wavelength_nm` and `reach_m`. An interface's read carries
`transceiver`: `{id, name, part_id, serial_number, standard}`, or null - also
null for a reader who may not view the item.

## Transceivers list

**DCIM → Transceivers** lists every inventory item of kind transceiver in
the tenant, in a port or spare: part ID, serial, standard, device, port,
whether the port is cabled, site and name. It answers "where is serial
FNS…", "how many SFP-10G-LR are in use" and "which optics are spare".

- **Filters:** part, standard, device, site, and **In a port** / **Spare**
  in the rail; the search box matches the name, serial, part ID, asset tag
  and device.
- **Part ID** links to the transceiver's [pluggable](pluggables.md) for a
  reader who may view module types; **Port** opens the interface.
- It needs view on inventory items, and shows the ones at sites you may
  view. It reads `/api/inventory-items/?kind=transceiver` (above).
