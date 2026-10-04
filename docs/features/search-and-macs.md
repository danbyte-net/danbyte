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
paging. Every hit carries what tells similar objects apart: its status pill
and its site, location, rack, role, type, device, VRF, VLAN or cluster. The palette's empty state lists what you opened and searched
recently in this browser.

### Settings

Below the object results, a **Settings** group lists the settings your query
matches - the individual setting where there is one, so "session timeout"
opens Security scrolled to that card rather than to the top of the page. Only
settings you may edit are listed. The settings section has its own search box
as well; this is the same catalog, reachable without opening it first.

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
- **MAC address**, in any notation - `3c:52:82:aa:10:44`, `3C-52-82-AA-10-44`,
  `3c52.82aa.1044`, `3c5282-aa1044` or `3c5282aa1044` - finds every interface,
  IP and MAC object carrying it, and the first hit is the port the MAC is
  [located](#where-is-this-mac) on: `Gi1/0/5 · sw-acc-03 · learned here,
  VLAN 10`. That hit follows your interface permissions like any other. The
  palette also offers **Look up MAC 3c:52:82:aa:10:44**, which opens the MAC
  page itself. Part of a MAC is matched as text for now.

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
`--type device` to limit it). Each row keeps its name and text in folded
form (lowercase, accents stripped) next to the original, so matching never
folds at query time. A one- or two-character query, which no index can
serve, ranks names first and reads descriptions only when they could still
reach the list - the results are the same as a full match. Custom-field
**values** are indexed too, so an
imported NetBox id or an asset number finds its object, hidden or not; each
list's own filter box keeps matching them as well.

## MAC address tracking

The **MAC list** (`/macs`) has two tabs. **Recorded** answers the question
"where have I recorded this MAC?" It gathers every MAC address known in your
tenant from four places:

- **Device interface ports** that recorded a MAC.
- **Virtual machine interfaces** that recorded a MAC (linked to the VM's
  Components tab, since VM interfaces have no page of their own).
- **IP addresses** that recorded a MAC.
- **First-class MAC objects** you've created (see below).

Each row is one MAC, showing the interfaces and IPs that carry it - so a MAC
that appears on both a switch port and an assigned IP shows up once, with both
links. The row also shows the **description and tags** of any MAC object recorded
for that address.

**Learned** is the network's own MAC table - see
[the Learned list](#the-learned-list).

The MAC detail page additionally shows what polling observed, on its
**Observed** tab: a **Ports** table - every switch port that learned the
address, with device, port, VLAN, role (Access or Uplink), first and last
seen and Present / Gone - and an **ARP** table of the devices whose ARP
tables paired it with an IP. A MAC that moved is two port rows, one gone and
one present. A MAC clicked on a device's monitoring cards therefore always
resolves, even when nothing in Danbyte carries it yet: the page says where it
was seen instead of returning "not found". The page takes the address in any
notation.

Both pages need MAC address view permission, and each source is then cut to
what you may view on its own: interfaces, VM interfaces, IP addresses and MAC
objects each follow their view permission, with its site scope and row
constraints. An IP's device and interface are named only when you may view
them too, and SNMP sightings list only devices and VMs you may view. A viewer
limited to one site never learns another site's addresses or ports through a
shared MAC; a MAC that only such rows carry is not listed at all.

### Where is this MAC? {#where-is-this-mac}

Polled switches report which MACs they learned on which port, and Danbyte
keeps each as a [sighting](snmp-discovery.md#mac-tables) with first and last
seen. From those, a MAC page answers three questions - the **Location**,
**IP** and **Name** rows of its overview card:

- **Location** - the port the MAC really sits on: device, port, VLAN (with
  the Danbyte VLAN that number means at the switch's site), since when, and
  when it was last seen - `sw-acc-03 · Gi1/0/5 · 10 · Users`, `since … ·
  seen 3m ago`. Uplinks never win while any switch reports the MAC
  on an access port; when none does - an unmanaged desk switch, a switch
  Danbyte doesn't poll - the Location is the nearest uplink, marked
  **behind uplink**: `Behind sw-core-01 · Eth1/5` with an `uplink` chip whose
  tooltip says why the port is one. A MAC no switch reports any more reads
  **Gone**, with when it was last seen. How a port counts as an uplink, and
  the overrides, are
  under [Uplinks](snmp-discovery.md#uplinks); the exact tie-breaks under
  [Location](snmp-discovery.md#mac-location).
- **IP** - from the ARP table of any polled router, L3 switch, firewall or
  virtual router (only the tenant's **ARP sources**, when it names some),
  DHCP leases and reservations, and IP addresses paired with the MAC. Each IP
  says where it came from: `ARP on sw-core-01`, `DHCP lease`, …
- **Name** - a Danbyte interface, VM interface or MAC object carrying the
  MAC (`srv-db-01 · eth0`) first, then reverse DNS, DNS records and DHCP
  host names for its IPs, each with its source.

A MAC that moved shows as two sightings, one gone and one present; gone
sightings stay for the tenant's **Forget MACs unseen for** window (30 days by
default) and are the MAC's history. Nothing here writes: learned MACs never
become MAC objects or change an IP address on their own.

`GET /api/macs/<mac>/` returns these as `location`, `ips_observed` (each IP
with its sources) and `names` / `name`, next to the existing keys.

#### The Learned list {#the-learned-list}

The **Learned** tab of `/macs` is the network-wide learned table: one row per
MAC at its Location - MAC, Vendor, Device, Port (an `uplink` chip when the MAC
is only seen behind one), VLAN, IP, Name, First seen and Last seen - 50 to a
page, ordered by MAC. The rail filters by **Site**, **Device**, **VLAN** (the
VID) and **State** (Present, Gone or All; the State column shows when the
list can mix them), and the search box takes a MAC in any notation, part of
one, or a device or port name. Download takes every match, not just the page.
A gone MAC shows the access port it was last seen on rather than an uplink
that kept it a little longer, and under a filter, a row the filter matches.

It reads `GET /api/monitoring/mac-sightings/`, paged on the server (`page`,
`page_size`, at most 500). It filters by `site`, `device` and `vlan` (against
where each MAC is located), `state` (`present`, `gone`, `all`), `kind`
(`access` or `behind_uplink`), and `q`.

#### Who sees what

Everything follows the viewer's permissions, type by type. Sightings and
Locations come only from devices you may view - a MAC whose access port sits
on a switch you can't see is located behind the nearest uplink you can, never
on the hidden switch. An IP read from a router's ARP table shows only when you
may view that router or an IP address row with that address, and the router
is named only when you may view it. DHCP leases and reservations follow their
own view permissions, DNS records theirs, interfaces and VM interfaces
theirs. The Learned list needs view on MAC addresses as well.

### Vendors

Every MAC shows its **vendor**, resolved from the address prefix:

- The **IEEE OUI registry** - loaded under **Settings → Branding & identity →
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

An address inside one of your own ranges is handed out **once**. The button
only proposes an address, so two people with the dialog open can be offered
the same one; whoever saves second is refused with the next free address.
Outside your ranges a MAC may sit on several interfaces - a VRRP or anycast
gateway MAC does - so that rule applies to owned ranges only.

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

### Removing MACs in bulk

Tick rows on the MAC list - the header box ticks the page, and **Select all
N** then takes every row the filters show (see
[Selecting rows](table-preferences.md#selecting-rows)). **Remove** on the
selection bar opens a confirmation that lists the first few selected
addresses with the interfaces and IPs each one is attached to, then asks
where to remove them from, with a count for each:

- **Delete MAC objects** (on by default) - the first-class objects with their
  description, tags and custom fields.
- **Clear from interfaces** - blanks the MAC on the device and VM interfaces
  that carry it.
- **Unpair from IP addresses** - blanks the MAC paired with those IPs.

Each choice needs its own permission: *delete* on MAC addresses, *change* on
interfaces or VM interfaces, *change* on IP addresses. A site-scoped operator
removes only what their grants reach; rows they can see but not change are
left alone, and the dialog says how many. A choice they hold no grant for
stays off. Every deletion and cleared field lands in the change log.

MACs learned by an integration (DHCP lease sync, virtualization sync) come
back on its next sync unless they are also gone at the source.

The API behind it is `POST /api/macs/bulk-remove/` with
`{values, remove_objects, clear_interfaces, unpair_ips, dry_run}`: `values`
are the MAC addresses (at most 2000 per call), and `dry_run: true` returns
the same per-source counts without writing anything. The list sends a bigger
selection 2000 at a time and adds the counts up (see
[Large selections](table-preferences.md#large-selections)).

To delete MAC objects by id instead, `POST /api/mac-addresses/bulk-delete/`
takes `{ids}` (at most 2000) and answers `{deleted}`, like the other bulk
deletes. It needs *delete* on MAC addresses; ids in another tenant or outside
the caller's site scope are left alone.

Clearing and unpairing cost the same few queries whatever the batch size.
Deleting objects writes one change-log entry per object and tells webhooks
and the search index about each one, so a delete of 2000 objects runs
several thousand short queries in one transaction.
