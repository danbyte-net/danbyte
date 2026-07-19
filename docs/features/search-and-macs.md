---
icon: lucide/search
---

# Search & MAC tracking

Danbyte gives you one search box that reaches across everything you've recorded,
plus a dedicated view for tracking MAC addresses across your devices and IPs.

## Global search

The **search box in the topbar** (and the full `/search` results page) looks
across all your major objects at once — **prefixes, IP addresses, devices, sites,
VLANs, VRFs, route targets, and tags** — within your current tenant.

It's a plain substring match, so partial values work: type part of an address, a
device name, a VLAN ID, or a tag and you'll get hits. To use it:

1. Click the search box (or focus it) and start typing.
2. Results appear **grouped by type**, with the most relevant few per group.
3. Click a result — or press **Enter** on it — to jump straight to that object's
   detail page.

The topbar suggester shows a capped preview per group to stay fast. For the
complete list, open the **`/search`** results page, which shows every match with
a jump link on each row.

!!! tip "What to type"
    Anything technical works as a query — a CIDR, an IP, a hostname, a VLAN
    number, a tag. You don't need to choose a category first; search figures out
    what each match is.

## MAC address tracking

The **MAC list** (`/macs`) answers the question "where have I seen this MAC?" It
gathers every MAC address known in your tenant from three places:

- **Device interface ports** that recorded a MAC.
- **IP addresses** that recorded a MAC.
- **First-class MAC objects** you've created (see below).

Each row is one MAC, showing the interfaces and IPs that carry it — so a MAC
that appears on both a switch port and an assigned IP shows up once, with both
links. The row also shows the **description and tags** of any MAC object recorded
for that address.

### First-class MAC objects

Beyond the derived view, a MAC can be a **real object** you manage — with its own
**description, tags, and custom fields**, optionally **assigned to an interface**.
SNMP discovery creates these automatically as it learns hardware addresses, and
you can create them by hand:

- **Add MAC** on the list (or **Add object** on a MAC's detail page) opens a form
  for the address, an optional device + interface, a description, tags, and any
  custom fields you've defined for MAC addresses.
- MAC objects are **tenant-scoped**, **audited** (they appear in the audit log),
  and support **custom fields** — define them under Customize → Custom fields with
  the *MAC addresses* target.

This stays true to Danbyte's zero-pre-filled-data rule: the platform ships the
model, never a starter catalog of MACs. You only ever have the MACs your network
reports or that you deliberately record.

### MAC detail

Click a MAC to open its detail page. At the top, the **MAC objects** section
lists each object recorded for that address — its assigned interface, description,
tags, and custom-field values — with **Edit** and **Delete** actions (permissions
permitting). Below that, it lists every interface (with its device) and every IP
that references the MAC, each linking back to the object. This is the
cross-reference you reach for when chasing:

- a device that moved between ports, or
- an address whose hardware you recognise but whose hostname you don't.

If no object exists yet for a MAC that's only been *seen* (on an interface or IP),
the detail page offers to **create one** so you can annotate it.

!!! note "Deleting a MAC object"
    Removing a MAC object only deletes that annotation — it does **not** clear the
    hardware address stored on the interface or IP. Those keep their recorded
    value, so the MAC still appears in the derived list.
