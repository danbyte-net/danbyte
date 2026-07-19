---
icon: lucide/ethernet-port
---

# Interfaces

**Interfaces** are the ports on a device. They're where you attach IP addresses
and terminate cables. Each interface belongs to exactly one device, and its name
must be unique on that device.

You'll usually manage interfaces from a device's **Interfaces** tab, but they
also have their own list and detail pages.


## Physical extras

Interfaces carry the bread-and-butter switch fields: **management only**
(out-of-band — badged `mgmt` in the device's interface table), **duplex**
(half/full/auto), **PoE mode + type** (PD/PSE, 802.3af→bt and passive
variants), and **WWN** for Fibre Channel. Interface *templates* carry
mgmt-only and PoE too, so they stamp onto new devices — and the
devicetype-library importer maps `poe_mode`/`poe_type` from library files.

## Add an interface

From a device's **Interfaces** tab, click **Add interface**, then fill in:

| Field | What it's for |
|---|---|
| **Name** | The port name, e.g. `GigabitEthernet0/1`, `eth0`, `ae1`. |
| **Type** | The physical/logical media — pick from the dropdown (see below). |
| **Speed** | Link speed. Free text with suggestions (`1G`, `10G`, `100G`, …). |
| **MTU** | Maximum transmission unit, e.g. 1500 or 9000. |
| **VLAN** | An optional VLAN association. |
| **MAC address** | The port's hardware address. |
| **Enabled** | Whether the port is administratively up. |

### Interface type

The **Type** dropdown is a searchable list of standard media types, organised
into **sub-categories**:

- **Ethernet by speed** — Fast Ethernet through 800G and 1.6T, including
  media-specific optics (`10gbase-lr`, `100gbase-dr`, BiDi variants)
- **Pluggable transceivers** — SFP, SFP+, SFP28, QSFP+, QSFP28, QSFP-DD,
  OSFP, … (the *cage*, when the medium depends on the inserted optic)
- **Backplane Ethernet, Wireless, Cellular, SONET/SDH, Fibre Channel,
  InfiniBand, Serial/WAN, Broadband, PON, Stacking**
- **Virtual** — for logical ports (see [Virtual interfaces](virtual-interfaces.md))

Start typing (e.g. `sfp28`, `10gbase-lr`, `qsfp`) to filter across all groups.
Type is optional — leave it blank if you don't care to record it. The full
taxonomy, and when to pick a fixed-media slug vs a transceiver slug:
[Interface & cable types](type-taxonomy.md).

### Speed

Speed is a free-text field with a **dropdown of common values** (`10M` … `800G`)
so you can pick quickly or type your own.

## Add many interfaces at once

Switches have a lot of ports. From the **Interfaces** tab, click **Bulk add** to
create a whole range in one go. Enter a pattern with a numeric range in brackets
and watch the live preview:

| Pattern | Expands to |
|---|---|
| `eth[0-47]` | eth0, eth1, … eth47 |
| `Gi1/0/[01-48]` | Gi1/0/01 … Gi1/0/48 (zero-padding preserved) |

Names that already exist on the device are skipped, so re-running is safe.

## Edit many at once

Tick the rows you want and a bar floats up from the bottom — **Edit** opens a
dialog that applies your changes to every selected interface.

Each field starts on **Keep current** and is left untouched unless you change it,
so you can retype one field across 48 ports without disturbing the rest.
Choice-backed fields — type, 802.1Q mode, duplex — are searchable dropdowns
listing the real values, grouped the same way as the single-interface form; each
also offers a **Clear** row to blank the field. Free-text fields (speed,
description) pair a checkbox with an input: tick the box to arm the field.

The same bar appears on the console, power, and port tabs, and on a device
type's component templates.

## What you see in the list

On the device's **Interfaces** tab, each row shows the name, type, enabled state,
speed, VLAN, cable count, and any **IP addresses** attached to it. Sub-interfaces
are indented under their parent, and aggregate members show their LAG — see
[Virtual & aggregate interfaces](virtual-interfaces.md).

## Attaching IP addresses

Two buttons on each interface row — **+ Add IP** and **Assign IP** — let you put
an address on the port without leaving the page. See
[Assigning IP addresses](ip-assignment.md).

## The interface detail page

Click an interface name to open its page. It shows the device, type, speed, MTU,
VLAN, MAC, any parent/LAG/bridge relationships, the IPs assigned to it, and a
cable trace. From here you can also add or assign IPs.

## VM interfaces

Virtual machines have interfaces too — managed from a VM's **Interfaces** tab —
and they carry the same L2/L3 context as device ports:

| Field | What it records |
|---|---|
| **802.1Q mode** | *Access* (untagged only), *Tagged* (a trunk), or *Tagged (all VLANs)*. |
| **VLAN** | The untagged / native VLAN. |
| **Tagged VLANs** | The VLANs carried on a trunk (mode = tagged). |
| **VRF** | The VRF the interface routes in. |

So a VLAN-trunked or VRF-scoped VM NIC is modelled exactly like a physical one
(and imports from NetBox without data loss). VM interfaces don't cable or nest —
no type, LAG, parent, or bridge.
