# Enhanced site separation

Big organisations often run **one tenant with many sites**, each with local IT
that runs its own site — and must not touch anyone else's. Enhanced site
separation makes each site behave like a **mini-tenant** for site-scoped
users, while HQ (admins and users with cross-site grants) keeps full
visibility and control.

It's **off by default**. Turn it on under **Settings → Deployment → Site
separation** (install-wide default) or per tenant under **Settings → This
tenant → General → Site separation** (override).

## Who counts as "site-scoped"

A user whose write permissions all carry a **sites** limit — the shape the
[Site editor role](../features/permissions.md#site-roles-local-it-in-one-click)
creates. Admins, superusers, and anyone holding an *unscoped* write grant are
never affected by this mode.

## What it changes

With the switch **off**, the write *boundary* is already enforced: a
site-scoped editor can't create, move, or bulk-edit objects into a foreign
site — the server rolls such writes back. The mode adds strictness and
ergonomics on top:

| | Off (default) | On |
|---|---|---|
| Site pickers in forms | offer every site | offer only the user's editable site(s); locked when there's exactly one |
| Referencing another site's objects (a prefix, a device …) as a write target | rejected after save (403) | also rejected at validation (400) — the picker simply doesn't offer them |
| Creating without picking a site | refused (the object would be site-less, which site-scoped users may never write) | the site is filled in automatically for single-site users; IPs inherit their prefix's site |
| Reading other sites | per the user's read grants | **unchanged** — separation fences *writes*, never reads |
| Shared (site-less) objects — e.g. a company-wide supernet | readable, never writable | same |

!!! note "Reads stay open on purpose"
    The common pattern is *"local IT edits their site, sees everything"* —
    the Site editor recipe grants exactly that. Separation doesn't narrow
    reads, so cross-site troubleshooting keeps working. If someone should
    only *see* their own site, give them the **Site viewer** role instead.

## Creating prefixes: your space, or a fresh one

A site editor can create prefixes two ways:

1. **Carve inside your own site's space** — allocate a child of any prefix
   already assigned to your site. This is the normal "here's your /18, subnet
   it however you like" flow.
2. **Stand up a brand-new range that collides with nothing** — a *dark* or
   non-routed subnet (say a private `192.168.50.0/24` for an isolated lab). As
   long as it overlaps **no** existing prefix — not the shared/global space,
   not another site's — it's allowed and stamped to your site.

What you can't do is overlap someone else's space: carving inside the shared
(site-less) supernet, or inside another site's range, is refused with a clear
message. That's what keeps a site's "dark" ranges from colliding with the
global plan.

!!! note "Cleaner errors"
    Trying to create a prefix that already exists, or (in a VRF that rejects
    overlaps) one that partially overlaps another, now returns a plain
    *"already exists"* / *"overlaps …"* message instead of a server error.

## Local vs global catalog entries

Catalogs — tags, device types, manufacturers, statuses, IP roles, VRFs, route
targets, custom fields, [zones](../models/zone.md) — are shared per tenant.
With separation **on**, they gain a locality dimension so a site can't "fix"
(break) what every other site relies on:

- Every catalog entry is either **Global** (usable everywhere, badge
  "Global") or **Local — \<site\>** (visible and usable only within that
  site).
- A site-scoped user **sees** global entries plus their own site's local
  ones; other sites' local entries don't exist for them.
- They can **edit or delete only their own local entries** — global entries
  are read-only, and referencing them (a device on a global device type, a
  global tag on a prefix) is always fine.
- Anything they **create** becomes local to their site automatically —
  including device types imported from YAML (and any manufacturers the
  import mints along the way).
- **Promote / re-home**: tenant-wide editors (HQ, admins) can promote a good
  local entry to global, or assign a global one to a site, from the entry's
  detail page.
- VLANs use their existing *site* field as locality: HQ pushes site-less
  (shared) VLANs everyone can read; sites create their own.

With separation **off**, the locality stamp is kept but not enforced —
catalogs behave tenant-wide exactly as before.

!!! warning "Tags are tenant-scoped now (independent of this mode)"
    Tags used to live in one global table — every tenant saw every other
    tenant's tag names. Tags now belong to the tenant that created them; a
    migration assigned existing tags to the tenant(s) using them (cloning a
    tag that several tenants shared). Old, never-used tags remain visible to
    all tenants but only a superuser can edit or delete them.

## Rollout notes

- The tenant override is its own group — overriding separation does **not**
  detach the tenant from deployment defaults for sharing or UI policy.
- Flipping the switch off restores the default behaviour exactly; nothing is
  migrated either way.
- The companion switch **"Let site admins manage their site's settings"**
  unlocks **Settings → This site**: local IT overrides their site's email
  relay (more groups later). A *site admin* is a site editor of that site, or
  anyone holding a `sitesettings` permission scoped to it — grantable to
  users or groups, so you can build a "Site X admins" group. Tenant admins
  can always edit any site's settings. Site alerts about that site's objects
  then use the site relay; sign-in codes and digests stay tenant-level.
