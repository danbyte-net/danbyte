---
icon: lucide/map-pin
---

# Site

A physical location — DC, office, POP, edge.

## Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | |
| `tenant` | FK → `Tenant` | required | |
| `name` | char(255) | required | |
| `location` | char(255) | `""` | Free-form postal address (city, street, …). Labelled **Address** in the UI (to avoid clashing with the `Location` object). The API also exposes it read+write as `address`, an alias of this field — either name works; `location` is kept for backward compatibility. |
| `time_zone` | char(63) | `""` | IANA name (e.g. `Europe/Copenhagen`); validated against the zoneinfo set. The detail page shows the current local time so you can read the offset between sites. |
| `description` | text | `""` | |
| `gateway_policy` | choice | `first` | `first` · `last` · `none` |
| `vrfs` | M2M → `VRF` | empty | Documentation only — "VRFs operating at this site" |
| `tags` | M2M Tag | empty | |
| `custom_fields` | JSONB | `{}` | |

## Constraints

`unique_together = ("tenant", "name")`

## Gateway policy

When a new `Prefix` is created at a site and the prefix's `gateway` field is
empty:

- `first` → the first usable host (network + 1) becomes an `IPAddress(role=gateway)`
- `last` → the last usable host (broadcast − 1) becomes the gateway
- `none` → no autospawn

See [Gateway autospawn](../features/gateway-autospawn.md) for the full flow.

## Detail page

The site page tabs carry live counts (devices, prefixes, VLANs, circuits,
contacts). A **Circuits** tab lists the circuits terminating at the site — a
circuit's termination links to a site, so each site shows the WAN links landing
there, with the far end (another site or a provider network). `GET
/api/circuits/?site=<id>` powers that list.

## Coming in Phase 4

`SiteMasterSubnet` — explicit CIDR blocks "owned" by a site, used to validate
new prefix creation at that site. Until then, a site can host any CIDR.
