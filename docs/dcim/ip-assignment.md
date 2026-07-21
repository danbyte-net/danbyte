---
icon: lucide/link
---

# Assigning IP addresses

There are two ways to put an IP address on an interface, and you can do both
without leaving the device or interface page. Each interface row (on the device's
**Interfaces** tab and on the interface detail page) has two buttons:

- **+ Add IP** — create a brand-new IP address and attach it here.
- **Assign IP** — attach an IP that **already exists** in Danbyte.

## Add a new IP

Click **+ Add IP**. The IP form opens already knowing which device and interface
you're working on, so you only fill in the address itself.

### Why you pick a subnet first

Every IP address belongs to a **subnet** (prefix), and the subnet is what tells
Danbyte the **VRF** and **site** the address lives in. Typing just `1.1.1.1/24`
isn't enough — nothing in that string says which VRF or which site it belongs to.

So the form opens with a **Subnet** picker. To find the right one quickly:

1. (Optional) narrow by **Site** and/or **VRF**.
2. Pick the **Subnet** — the list filters to subnets in that site/VRF.
3. The network part of the address is filled in for you; just type the host part.
4. Set status, role, DNS name, etc., and save.

## Assign an existing IP

Click **Assign IP** to open the picker. Because a large network can hold
**millions** of addresses, the picker never lists them all — you narrow it down:

1. Filter by **Site**, **VRF**, and/or **Subnet**.
2. Or type part of an **address or DNS name** in the search box.
3. Pick the address from the (capped) results list and click **Assign**.

If the IP was attached somewhere else, the picker shows you where — assigning it
here moves it.

## Seeing what's attached

Wherever interfaces are listed, the **IP addresses** column shows the addresses
on each port, so it's obvious which interfaces are in use. The interface detail
page has a dedicated **IP addresses** section with the same two buttons.

!!! tip "The other direction still works"
    You can also start from the IP itself: open or create an IP, and set its
    **device** and **interface** on the IP form. All roads lead to the same place.

## Switch / switch-port link (L2 edge)

Separately from the interface an IP is *configured on* (above), you can record
which **access switch** and **physical port** a host is reached *through* — the
L2 edge. Two columns, **Switch** and **Switch port**, appear on the IP table,
and the IP form has a **Switch** device picker with a dependent **Switch port**
dropdown (pick the switch — or a stack member — then its port). Setting the port
keeps the switch in sync with the port's device; a virtual chassis is shown
alongside the port when the device is a stack member. Set it manually, or via the
API (`switch_id` / `switch_interface_id` on `/api/ips/`).

### Discovering it from SNMP (accept manually)

Danbyte can *suggest* the switch/port from a switch's SNMP data — it never writes
it automatically (Danbyte is your source of truth). Polling a switch collects
its **ARP table** (IP → MAC) and its **MAC-address / bridge-forwarding table**
(MAC → port); joining them yields *"IP 10.0.0.5 is behind SW1 · Gi0/1"*. These
appear as **switch link** suggestions in the switch device's **SNMP drift**
inbox (Device → SNMP), where you **Accept** each one (or **Sync all**) exactly
like other discovered facts. Accepting sets the IP's Switch + Switch port. This
runs through the normal SNMP path, so it works both locally and via Outposts.
