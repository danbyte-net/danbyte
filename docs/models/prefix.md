---
icon: lucide/grip
---

# Prefix

An IP prefix (CIDR), scoped to a `(tenant, VRF)` pair.

## Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | PK |
| `tenant` | FK → `Tenant` | required | |
| `vrf` | FK → `VRF` | NULL (= Global) | |
| `cidr` | char(43) | required | e.g. `10.0.10.0/24`, `2001:db8:1::/64` |
| `status` | choice | `active` | `container` · `active` · `reserved` · `deprecated` |
| `gateway` | inet | NULL | The gateway IP; auto-populated when a child IP is set as gateway |
| `vlan` | FK → `VLAN` | NULL | Optional |
| `site` | FK → `Site` | NULL | Optional |
| `description` | text | `""` | |
| `custom_fields` | JSONB | `{}` | User-defined attributes |
| `tags` | M2M Tag | empty | Via `TaggedItem` |

## Uniqueness

```python
class Meta:
    constraints = [
        UniqueConstraint(
            fields=["tenant", "vrf", "cidr"],
            nulls_distinct=False,
            name="uniq_prefix_tenant_vrf_cidr",
        )
    ]
```

The `nulls_distinct=False` (Postgres 15+) is what makes `vrf=NULL` (Global) act
like a real VRF for uniqueness — without it, two `(tenant, NULL,
'10.0.10.0/24')` rows would both be allowed.

## Computed properties

| Property | Returns | Notes |
|---|---|---|
| `.network` | `ipaddress.IPv4Network \| IPv6Network \| None` | Parsed CIDR |
| `.family` | `4`, `6`, or `None` | Convenience |
| `.utilisation_pct` | `int 0-100 \| None` | None for IPv6, containers, and malformed CIDRs |

## Lifecycle

| Hook | Trigger | Action |
|---|---|---|
| `prefix_create` view | POST | Save → if `gateway` is empty and site has a `gateway_policy`, autospawn an `IPAddress(role=gateway)` |
| `prefix_edit` view | POST | Save → tags updated; gateway/site/vlan can be changed |
| `prefix_detail` view | GET | Render IPs / Children / Map tabs |

## Hierarchy (logical, not stored)

Parent/child is **derived**, never stored. The list view computes depth via
stack-walking sorted prefixes per `(vrf, family)` bucket. This means:

- No "parent_id" FK to maintain
- Deleting a prefix doesn't orphan children
- Re-CIDR'ing automatically re-roots the tree

The cost is that "find all children" is O(n) within a VRF — fine for IPAMs at
the scale Danbyte targets.

## Related

- [Prefix CRUD](../features/prefix-crud.md) — the create / edit flow
- [Tree + sections](../features/tree-and-sections.md) — the list rendering
- [Space map](../features/space-map.md) — the per-mask grid view
