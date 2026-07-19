---
icon: lucide/git-branch
---

# VRF

Routing context inside a tenant. Two prefixes with identical CIDR in different
VRFs are valid and distinct.

## Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | PK |
| `tenant` | FK → `Tenant` | required | |
| `name` | char(100) | required | e.g. `production`, `guest`, `customer-A` |
| `rd` | char(21) | `""` | Route Distinguisher, e.g. `65001:100` |
| `description` | text | `""` | |
| `enforce_unique` | bool | `True` | Reject overlapping child prefixes within this VRF |
| `color` | char(7) | `""` | Optional `#xxxxxx` — shown as the section-header accent |

## Constraints

```python
class Meta:
    ordering = ["name"]
    unique_together = ("tenant", "name")
```

## Global VRF

`Prefix.vrf = NULL` is the **Global VRF**. We deliberately do not seed a
`VRF(name='Global')` row — the absence of a row *is* the Global VRF. This keeps
the data model honest (one fewer row to maintain, no risk of "Global" being
deleted, no name collision with a user-created VRF called Global).

The `nulls_distinct=False` on the `Prefix` and `IPAddress` uniqueness
constraints makes Global behave like a real VRF for uniqueness purposes.

## Related

- `Prefix.vrf` and `IPAddress.vrf` — both nullable FKs
- `Site.vrfs` — M2M (documentation only — "which VRFs operate at this site")
- [Tenant + VRF isolation](../architecture/tenant-vrf.md)
