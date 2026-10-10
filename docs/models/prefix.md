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
| `allocate_from_ranges` | bool | `false` | Only the IP ranges inside the prefix are allocatable: next available, free rows, pools and utilisation come from them; a new address outside every range is refused (see [IPAM objects](../features/ipam-objects.md#ip-ranges)) |
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
like a real VRF for uniqueness - without it, two `(tenant, NULL,
'10.0.10.0/24')` rows would both be allowed.

## Moving a prefix between VRFs

The prefix owns the routing context; its `IPAddress` and `IPRange` children
denormalise it. Changing `vrf` therefore updates every child in one go, so the
prefix and its contents can never disagree about which VRF they are in.

## Computed properties

| Property | Returns | Notes |
|---|---|---|
| `.network` | `ipaddress.IPv4Network \| IPv6Network \| None` | Parsed CIDR |
| `.family` | `4`, `6`, or `None` | Convenience |
| `.utilisation_pct` | `int 0-100 \| None` | Addresses over usable hosts (see below). None for containers, malformed CIDRs and IPv6 prefixes too large to enumerate. With `allocate_from_ranges` on, in either family: used-in-range over the ranges' total size (None until a range exists) |
| `.allocation_summary()` | `{size, used, free, ranges} \| None` | The allocation ranges' accounting (serialised as `allocation`); None when the prefix allocates from its whole network |
| `.allocation_spans()` / `.in_allocation(addr)` | `[(start, end)]` / `bool` | The ranges as integer spans, clipped to the prefix and merged where they overlap, and whether an address falls inside one |

## Usable hosts

One rule decides which addresses of a prefix are hosts. Utilisation, next
available, the Subnet details card (*First usable*, *Last usable*, *Usable
hosts*), **Add pool** and discovery all use it (`api.models.usable_host_count`),
and it is what Python's `ip_network(...).hosts()` yields:

| Prefix | Not hosts | Usable hosts |
|---|---|---|
| IPv4 `/30` and shorter | network and broadcast | size − 2 |
| IPv4 `/31` (RFC 3021) and `/32` | none | size |
| IPv6 `/126` and shorter | the Subnet-Router anycast address, `::` of the prefix (RFC 4291) | size − 1 |
| IPv6 `/127` (RFC 6164) and `/128` | none | size |

IPv6 has no broadcast, so the last address of a `/126` is a host: a `/126`
has three usable hosts, `::1` to `::3`.

## Changing the CIDR

A new CIDR must still hold every address and range on the prefix. Narrowing
or moving a prefix past one is refused with the addresses and ranges that
would fall outside it (the first five of each, and a count). Move or delete
them first, or widen instead. Child prefixes are not stored relations, so
they never block a change - the tree re-nests them.

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

The cost is that "find all children" is O(n) within a VRF - fine for IPAMs at
the scale Danbyte targets.

## Related

- [Prefix CRUD](../features/prefix-crud.md) - the create / edit flow
- [Tree + sections](../features/tree-and-sections.md) - the list rendering
- [Space map](../features/space-map.md) - the per-mask grid view
