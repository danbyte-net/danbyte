---
icon: lucide/shield
---

# Zone

A **security zone** — models zone-based firewalling the way Palo Alto (and
most modern firewalls) think about it: interfaces/segments belong to zones,
and policy is written zone-to-zone. Danbyte ships **zero pre-filled zones**;
each tenant defines its own catalog (e.g. `trust`, `untrust`, `dmz`,
`guest-wifi`).

A VLAN can link to a zone (`VLAN.zone`), so "which zone is this segment in?"
is answerable from the VLAN itself. Future firewall-policy modelling builds
on the same rows.

## Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | |
| `tenant` | FK → `Tenant` | required | |
| `name` / `slug` | char(64/80) | required | Slug auto-generates from the name; unique per tenant |
| `color` | char(7) | `""` | Hex badge colour; text colour derives from luminance |
| `description` | text | `""` | |
| `weight` | int | 100 | Sort order in pickers |
| `owning_site` | FK → `Site` | NULL | NULL = global to the tenant; set = [local to that site](../access/site-separation.md) |
| `custom_fields` / `tags` | | | Standard mixins |

## API

`/api/zones/` — standard CRUD (`?picker=1` for the light picker shape,
`?search=`), plus `POST /api/zones/<id>/promote/` and
`POST /api/zones/<id>/assign-site/` for locality (tenant-wide editors only).
RBAC object type: `zone` (IPAM group).

VLANs reference a zone via `zone_id`; deleting a zone leaves its VLANs
zone-less (`SET_NULL`), never deletes them.
