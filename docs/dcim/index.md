# DCIM — physical infrastructure

DCIM (Data Center Infrastructure Management) is where you record the **physical
world**: the gear in your racks, the ports on that gear, and the cables between
them. IPAM tracks addresses; DCIM tracks the things those addresses live on.

If you're new here, this is the order things are usually built in:

```
Manufacturer  →  Device type  →  Device  →  Interfaces  →  Cables
   (Cisco)       (C9300-48P)     (sw-01)    (Gi1/0/1…)     (sw-01 ⇄ sw-02)
```

## The building blocks

| You want to… | Go to | Page |
|---|---|---|
| Add a switch, firewall, server… | **Devices** | [Devices](devices.md) |
| Model a switch stack (StackWise, VC, VSF) | **Virtual chassis** | [Virtual chassis](virtual-chassis.md) |
| Define a hardware model once, reuse it | **Device types / catalog** | [Device catalog](device-catalog.md) |
| Lay out a rack and mount gear in it | **Racks** | [Racks](racks.md) |
| Add ports to a device | **Interfaces** | [Interfaces](interfaces.md) |
| Model LAGs, sub-interfaces, loopbacks | **Virtual interfaces** | [Virtual & aggregate interfaces](virtual-interfaces.md) |
| Put an IP on an interface | **IP assignment** | [Assigning IP addresses](ip-assignment.md) |
| Connect two ports with a cable | **Cabling** | [Cabling & connections](cabling.md) |

## How the pieces fit together

- A **device** is one physical box. It always has a **name** and usually a
  **device type** (which says what model it is) and a **site** (where it lives).
- A **device type** is the reusable template — "Cisco Catalyst 9300, 1U, these
  rack images." You create it once; every device of that model points at it.
- **Interfaces** are the ports on a device. They can hold IP addresses and
  terminate cables.
- **Racks** give devices a physical home — a position and a front/rear face — and
  draw an elevation so you can see what's mounted where.
- **Cables** connect ports together and can be traced end-to-end, even through
  patch panels.

!!! tip "Nothing is pre-filled"
    Danbyte ships **no** sample manufacturers, device types, or statuses — you
    define exactly the ones your network uses. That keeps the catalog clean and
    specific to you. See [Tags & custom fields](../features/tags-and-custom-fields.md)
    for adding your own fields to any of these objects.
