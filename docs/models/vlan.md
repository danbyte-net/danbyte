---
icon: lucide/route
---

# VLAN

L2 namespace, tenant-scoped (intentionally NOT VRF-scoped — VLANs and VRFs are
different layers).

## Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | |
| `tenant` | FK → `Tenant` | required | |
| `vlan_id` | int | required | 1–4094 |
| `name` | char(255) | required | Free-form label |
| `site` | FK → `Site` | NULL | Optional |
| `description` | text | `""` | |

## Constraints

`unique_together = ("tenant", "vlan_id")`

## Notes

- VLAN IDs are L2-scope; they don't belong to a VRF. A single VRF can carry traffic from many VLANs and vice versa.
- The display string is `"VLAN {vlan_id}: {name}"`.
