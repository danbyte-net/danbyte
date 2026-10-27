# Enhanced site separation

Big organisations often run **one tenant with many sites**, each with local IT
that runs its own site - and must not touch anyone else's. Enhanced site
separation makes each site behave like a **mini-tenant** for site-scoped
users, while HQ (admins and users with cross-site grants) keeps full
visibility and control.

It's **off by default**. Turn it on under **Settings → Separation → Site separation**: the page
opens on the install-wide default, and its **This tenant** scope carries the
override.

## Who counts as "site-scoped"

A user whose write permissions all carry a **sites** limit - the shape the
[Site editor role](../features/permissions.md#site-roles-local-it-in-one-click)
creates. Admins, superusers, and anyone holding an *unscoped* write grant are
never affected by this mode.

## What it changes

With the switch **off**, the write *boundary* is already enforced: a
site-scoped editor can't create, move, or bulk-edit objects into a foreign
site - the server rolls such writes back. The mode adds strictness and
ergonomics on top:

| | Off (default) | On |
|---|---|---|
| Site pickers in forms | offer every site | offer only the user's editable site(s); locked when there's exactly one |
| Referencing another site's objects (a prefix, a device …) as a write target | rejected after save (403) | also rejected at validation (400) - the picker simply doesn't offer them |
| Creating without picking a site | refused (the object would be site-less, which site-scoped users may never write) | the site is filled in automatically for single-site users; IPs inherit their prefix's site |
| Reading other sites | per the user's read grants | **unchanged** - separation fences *writes*, never reads |
| Shared (site-less) objects - e.g. a company-wide supernet | readable, never writable | same |

!!! note "Reads stay open on purpose"
    The common pattern is *"local IT edits their site, sees everything"* -
    the Site editor recipe grants exactly that. Separation doesn't narrow
    reads, so cross-site troubleshooting keeps working. If someone should
    only *see* their own site, give them the **Site viewer** role instead.

!!! note "Read scope is honoured everywhere"
    When a grant *is* site- or tenant-scoped (the **Site viewer** role, or any
    `ObjectPermission` with `sites`/`tenants` set), that scope applies uniformly
    - not just on the primary list and detail pages, but on every secondary
    surface that reaches related rows: global search, a tag's *usage* panel,
    custom-field scope previews, prefix space maps, device topology/traces, the
    site map, generic CSV/JSON imports (including the objects a row *references*
    by name), automation-target deploys, monitoring-engine stats, and audit /
    journal history. A Site-A viewer never sees Site-B rows through a side door,
    and a note can only be attached to an object the author may actually view.

    A row the viewer *may* read never names a related row they can't: an IP
    address shows its prefix, device, interface, switch and VM as empty when
    those belong to another site - in the API, the spreadsheet export and the
    context line of a search hit.

    Counts on catalog objects count only what the reader may view: a
    platform's devices and virtual machines, a device type's or role's
    devices, a manufacturer's device and module types, a rack or cabinet
    role's racks, a status's usage, a region's sites, and the like. So do a
    tag's usage, a contact's or contact role's assignments, a custom-field
    group's fields, the circuits on a provider network, a cluster's or VM
    group's virtual machines, a location's devices, racks and cabinets, a
    cabinet's devices, a floor plan's tiles, an L2VPN's VTEPs, a module
    type's interface templates, and the sub-groups of regions, platform
    groups and contact groups. A tenant's sites, prefixes, VLANs and IP
    addresses count the same way, each tenant by the grants held in it, and
    a tenant group counts only the tenants the reader can open. A prefix's
    child prefixes, IP addresses, static routes and DNS records count only
    the ones the reader may view; its utilisation still measures every
    address in it. The number on a tab matches the table under it, and says
    nothing about other sites.

## Which rows belong to a site

A row belongs to a site through its own site, or through the object it hangs
off:

- an **IP address** - its own site, else its prefix's. An address inside
  Site B's prefix is Site B's even when the prefix doesn't copy its site onto
  addresses; only an address in a site-less prefix is shared;
- a **service** - its device's or VM's site, else its address's;
- **NAT rules, virtual chassis, site-map markers** - their device's (the
  master's, for a virtual chassis);
- **IP ranges, DHCP scopes** - their prefix's; DHCP reservations and leases,
  their scope's prefix's;
- **VLAN groups** - their site, else their cluster's;
- **circuit terminations** - their own site, else the site of the VM whose
  interface they land on;
- **FHRP group assignments, tunnel and L2VPN terminations** - their
  interface's device or VM (an L2VPN's VLAN, for a VLAN termination);
- **routing rows** - BGP address families, redistributions and IGP
  interfaces, their instance's device or VM; VTEP memberships, their VTEP's
  device;
- **virtual disks, virtual switches** - their VM's, their cluster's;
- **power feeds, cooling feeds** - their power panel's, their cooling
  source's;
- **DNS records and drift, certificate bindings** - their IP address's;
- **config snapshots and state, BMC endpoints, port-utilization rules, Zabbix
  host links and pending changes, virtualization changes** - their device's
  or VM's.

A site-limited grant narrows all of these, for reading and writing. Types
that only *refer* to a site-bound row stay tenant-wide: FHRP groups, wireless
LANs, prefix-list rules, notification channels, virtualization networks and
placement rules, Zabbix connections and adoption rules. Check assignments,
monitoring policies, alert rules and silences follow the object they target.

Circuits, tunnels and L2VPNs are tenant-wide, but their ends are not: a
circuit, tunnel or L2VPN lists only the terminations the reader may view.

## Creating prefixes: your space, or a fresh one

A site editor can create prefixes two ways:

1. **Carve inside your own site's space** - allocate a child of any prefix
   already assigned to your site. This is the normal "here's your /18, subnet
   it however you like" flow.
2. **Stand up a brand-new range that collides with nothing** - a *dark* or
   non-routed subnet (say a private `192.168.50.0/24` for an isolated lab). As
   long as it overlaps **no** existing prefix - not the shared/global space,
   not another site's - it's allowed and stamped to your site.

What you can't do is overlap someone else's space: carving inside the shared
(site-less) supernet, or inside another site's range, is refused with a clear
message. That's what keeps a site's "dark" ranges from colliding with the
global plan.

!!! note "Cleaner errors"
    Trying to create a prefix that already exists, or (in a VRF that rejects
    overlaps) one that partially overlaps another, now returns a plain
    *"already exists"* / *"overlaps …"* message instead of a server error.

## Local vs global catalog entries

Catalogs - tags, device types, manufacturers, statuses, IP roles, VRFs, route
targets, custom fields, [zones](../models/zone.md) - are shared per tenant.
With separation **on**, they gain a locality dimension so a site can't "fix"
(break) what every other site relies on:

- Every catalog entry is either **Global** (usable everywhere, badge
  "Global") or **Local - \<site\>** (visible and usable only within that
  site).
- A site-scoped user **sees** global entries plus their own site's local
  ones; other sites' local entries don't exist for them.
- They can **edit or delete only their own local entries** - global entries
  are read-only, and referencing them (a device on a global device type, a
  global tag on a prefix) is always fine.
- Anything they **create** becomes local to their site automatically -
  including device types imported from YAML (and any manufacturers the
  import mints along the way).
- **Promote / re-home**: tenant-wide editors (HQ, admins) can promote a good
  local entry to global, or assign a global one to a site, from the entry's
  detail page.
- VLANs use their existing *site* field as locality: HQ pushes site-less
  (shared) VLANs everyone can read; sites create their own.

With separation **off**, the locality stamp is kept but not enforced -
catalogs behave tenant-wide exactly as before.

The [site roles](../features/permissions.md#site-roles-local-it-in-one-click)
read the catalogs their objects use, a silo editor and a viewer included: with
separation on, global entries and their own sites' local ones; with it off,
the tenant's whole catalog. Catalogs without locality - device roles,
platforms, rack and cabinet types, and the like - read tenant-wide either way.

!!! warning "Tags are tenant-scoped now (independent of this mode)"
    Tags used to live in one global table - every tenant saw every other
    tenant's tag names. Tags now belong to the tenant that created them; a
    migration assigned existing tags to the tenant(s) using them (cloning a
    tag that several tenants shared). Old, never-used tags remain visible to
    all tenants but only a superuser can edit or delete them; pickers mark
    them with a `global` chip.

    A tag name exists once among what a tenant sees - its tags, its sites'
    local tags and the global ones (case ignored) - so a site-local tag can't
    reuse a tenant-wide or global tag's name. Older same-name pairs are
    resolved with **Merge into…** on the Tags list, which only merges into a
    tag of the same site, a tenant-wide tag or a global one
    ([details](../features/tags-and-custom-fields.md#unique-names)).

## Rollout notes

- The tenant override is its own group - overriding separation does **not**
  detach the tenant from deployment defaults for sharing or UI policy.
- Flipping the switch off restores the default behaviour exactly; nothing is
  migrated either way.
- The companion switch **"Let site admins manage their site's settings"**
  unlocks the **This site** scope on **Settings → Email**: local IT overrides
  their site's mail relay (more groups later). A *site admin* is a site editor of that site, or
  anyone holding a `sitesettings` permission scoped to it - grantable to
  users or groups, so you can build a "Site X admins" group. Tenant admins
  can always edit any site's settings. Site alerts about that site's objects
  then use the site relay; sign-in codes and digests stay tenant-level.
