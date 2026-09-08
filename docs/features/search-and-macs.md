---
icon: lucide/search
---

# Search & MAC tracking

Danbyte gives you one search box that reaches across everything you've recorded,
plus a dedicated view for tracking MAC addresses across your devices and IPs.

## Global search

Press **⌘K / Ctrl+K** anywhere (or **/** outside a text field, or click the
search box in the topbar) and start typing. One ranked list comes back across
every object type in your current tenant - devices, prefixes, IP addresses
and ranges, sites, racks, VLANs, VRFs, VMs, interfaces, MAC addresses,
circuits, tunnels, wireless LANs, ASNs, aggregates, contacts, the catalog
objects, tags and more. Arrow keys move, **Enter** opens the highlighted hit,
and **See all results** opens the full `/search` page with type tabs and
paging. The palette's empty state lists what you opened and searched
recently in this browser.

### How matching works

- **Accents and case don't matter**: `aarhus`, `arhus` and `Århus` are the
  same word to search (the Danish `aa` folds to `å`), as are `Næstved` and
  `naestved`.
- **Typos still land**: matching is trigram similarity, so a near miss ranks
  below the exact hits instead of vanishing.
- **Ranking**: an exact name first, then a name that starts with the query,
  then one containing it, then matches in descriptions, comments, serials
  and custom-field values, with the object type weighing in (a device
  outranks a catalog row with the same match).
- **IP or CIDR**: an address query also lists the prefixes that contain it,
  most specific first; an exact prefix comes top.
- **Short id**: an all-digit query matches the number printed on labels and
  short links. Every type numbers from 1, so add a type token to pin it.
- **VLAN id** matches the VLAN.

### Narrowing with tokens

Add `key:value` pairs to the query; the value is matched as a prefix of the
name or slug, so `site:aar` is enough:

| Token | Narrows to |
|---|---|
| `type:device` | one object type (`type:vm`, `type:ip`, `type:prefix`, `type:mac`, …) |
| `site:aarhus` | objects at that site |
| `role:core` | device, rack, IP or VLAN role |
| `status:active` | status |
| `tag:dc` | tagged with it |
| `platform:`, `vrf:`, `cluster:`, `provider:`, `manufacturer:`, `group:`, `rack:`, `vlan:` | the matching relation |

A query of tokens alone (`type:device site:aarhus`) browses everything that
matches, sorted by name.

### Access

Every hit is checked against your permissions for its type, including site
scope, before it is returned - search never shows an object its page would
refuse.

### The index

Search runs on one index table that every save and delete keeps current. A
nightly job rebuilds it to catch bulk edits, and an upgrade rebuilds it
after migrating. `manage.py rebuild_search_index` does it by hand (add
`--type device` to limit it). Custom-field **values** are indexed too, so an
imported NetBox id or an asset number finds its object, hidden or not; each
list's own filter box keeps matching them as well.

## MAC address tracking

The **MAC list** (`/macs`) answers the question "where have I seen this MAC?" It
gathers every MAC address known in your tenant from four places:

- **Device interface ports** that recorded a MAC.
- **Virtual machine interfaces** that recorded a MAC (linked to the VM's
  Components tab, since VM interfaces have no page of their own).
- **IP addresses** that recorded a MAC.
- **First-class MAC objects** you've created (see below).

Each row is one MAC, showing the interfaces and IPs that carry it - so a MAC
that appears on both a switch port and an assigned IP shows up once, with both
links. The row also shows the **description and tags** of any MAC object recorded
for that address.

The MAC detail page additionally lists **SNMP sightings** - the polled devices
whose ARP or MAC tables observed the address, with the IP or port involved. A
MAC clicked on a device's monitoring cards therefore always resolves, even
when nothing in Danbyte carries it yet: the page says where it was seen
instead of returning "not found".

### Vendors

Every MAC shows its **vendor**, resolved from the address prefix:

- The **IEEE OUI registry** - loaded under **Settings → Deployment → General →
  MAC vendors** from a CSV: the
  [maclookup.app database](https://maclookup.app/downloads/csv-database) or the
  IEEE `oui.csv` / `mam.csv` / `oui36.csv`. Fetch it by URL or upload the
  file. **Fetch through the browser** (on by default for an airgapped
  install) makes your browser download the CSV and post it, so the server
  never needs internet; when the source refuses cross-origin downloads,
  save the file and use Upload CSV. The import runs in the background and
  can be repeated whenever the registry moves; it is deployment-wide and
  not bundled, so a fresh install shows no vendors until it is loaded.
- **Vendor ranges** (button on the MAC list) - prefixes your organisation
  assigns itself, such as a VM cluster's locally-administered block, with the
  label you choose. A range is tenant-scoped and beats the registry at the
  same prefix length; the longest match always wins.
- A MAC with the **locally-administered bit** set that matches no range
  reads *Locally administered* rather than blank.
- A MAC object can carry a **vendor override** for hardware the registry
  gets wrong.

The vendor is a column and a click-to-filter facet on the MAC list, a badge
on the MAC page, and follows the MAC on an interface page. **Next free in
range** in the Add MAC dialog hands out the lowest address in one of your
ranges that no interface, VM interface, IP pairing, or MAC object already uses.

### First-class MAC objects

Beyond the derived view, a MAC can be a **real object** you manage - with its own
**description, tags, and custom fields**, optionally **assigned to an interface**.
SNMP discovery creates these automatically as it learns hardware addresses, and
you can create them by hand:

- **Add MAC** on the list (or **Add object** on a MAC's detail page) opens a form
  for the address, an optional device + interface, a description, tags, and any
  custom fields you've defined for MAC addresses.
- MAC objects are **tenant-scoped**, **audited** (they appear in the audit log),
  and support **custom fields** - define them under Customize → Custom fields with
  the *MAC addresses* target.

This stays true to Danbyte's zero-pre-filled-data rule: the platform ships the
model, never a starter catalog of MACs. You only ever have the MACs your network
reports or that you deliberately record.

### MAC detail

Click a MAC to open its detail page. At the top, the **MAC objects** section
lists each object recorded for that address - its assigned interface, description,
tags, and custom-field values - with **Edit** and **Delete** actions (permissions
permitting). Below that, it lists every interface (with its device), every VM
interface (with its VM), and every IP that references the MAC, each linking
back to the object. A MAC shown on a VM's Components tab is the same link. This is the
cross-reference you reach for when chasing:

- a device that moved between ports, or
- an address whose hardware you recognise but whose hostname you don't.

If no object exists yet for a MAC that's only been *seen* (on an interface or IP),
the detail page offers to **create one** so you can annotate it.

!!! note "Deleting a MAC object"
    Removing a MAC object only deletes that annotation - it does **not** clear the
    hardware address stored on the interface or IP. Those keep their recorded
    value, so the MAC still appears in the derived list.

!!! note "Deleting the interface a MAC sits on"
    A MAC outlives its port: delete the interface and the MAC object stays,
    unassigned, keeping its tags and history. The one exception is when that
    address is *already* on file unassigned for the tenant - which happens once
    discovery has seen it twice. Only one unassigned record per address is kept,
    so the assignment record goes away with the interface instead of creating a
    duplicate.
