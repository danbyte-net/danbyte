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
| `location` | char(255) | `""` | Free-form (city, address, …) |
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

## Coming in Phase 4

`SiteMasterSubnet` — explicit CIDR blocks "owned" by a site, used to validate
new prefix creation at that site. Until then, a site can host any CIDR.
