---
icon: lucide/hash
---

# Object numbers (human-readable IDs)

Every object in Danbyte has a UUID primary key — globally unique, stable, safe in
URLs, but not something you'd read out over the phone or stencil onto a cable. So
alongside the UUID, each object also carries a **`numid`**: a short, sequential,
**per-tenant** number. A cable physically tagged "27" can map to cable **#27**;
tenant A's **#30** and tenant B's **#30** are different objects that never
collide.

This makes Danbyte friendlier to operators and far easier to migrate onto from
other IPAM/DCIM tools, where every object has exactly this kind of integer id.

## How numbering works

- **Per tenant, per type.** Each `(tenant, object-type)` pair has its own counter
  starting at 1. Devices, cables, prefixes, VLANs… each count independently
  within a tenant.
- **Allocated once, then stable.** A number is assigned the first time an object
  is saved with a tenant set, and never changes afterward — editing, moving, or
  re-saving the object keeps its `numid`.
- **The UUID is still the key.** `numid` is purely additive. Foreign keys, URLs,
  and tenant isolation all still run on the UUID; the number is a human-facing
  label on top.
- **Allocation is race-safe.** The counter is advanced under a row lock, so two
  concurrent creates can't be handed the same number.

Numbers are surfaced as a **Number** column on list pages (toggle it in the
**Columns** menu) and a **Number** field on detail pages.

## The Cable label

Cables also gained a free-form **`label`** field. A cable now
renders by preference as its **label**, else **#`numid`**, else its UUID — so a
cable never shows up as a bare UUID in a picker or a connection list.

## The "Human-readable IDs" toggle

**Settings → Deployment → Human-readable IDs** controls whether the UI surfaces
`numid` (the **Number** columns and fields). It's **on** by default.

!!! note "The toggle is display-only"
    Numbering always happens per-tenant in the background regardless of the
    toggle — the switch only governs whether the number is shown in the
    interface. Turning it off doesn't stop allocation or change any object's
    number; turning it back on reveals the same numbers again.

## Backfilling existing data

The `numid` field is allocated on save, and bulk inserts (`bulk_create`) skip
`save()` to stay fast — so rows that predate the feature, or were imported in
bulk, start out **unnumbered**. Assign them in one idempotent pass:

```bash
python manage.py assign_numids
```

It walks every tenant-scoped model, numbers any rows still missing a `numid` in
creation order (1-based, no gaps), and advances each tenant/type counter so the
**next** object created continues right where the backfill left off. Running it
again is a no-op — already-numbered rows are left alone, so it's safe to re-run
after any large import.

!!! tip "Run it after a fresh install or a bulk import"
    A `migrate` adds the column but doesn't backfill existing rows. After
    upgrading an instance that already has data — or after importing a batch via
    `bulk_create` / the import tools — run `assign_numids` once to number
    everything.

## Which objects get a number

All directly tenant-scoped objects — Device, Cable, Prefix, IPAddress, Rack,
VLAN, VRF, Circuit, Site, and the rest of the catalog and instance models.

**Not numbered:** catalog/choice rows that aren't tenant-scoped (e.g. statuses)
and device-child objects that have no direct tenant of their own (interfaces,
ports, cable terminations) — a `numid` needs a tenant to scope its counter
against.
