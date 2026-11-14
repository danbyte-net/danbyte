---
icon: lucide/git-fork
---

# Device dependency

*The downstream device depends on the upstream device* (#450). How to use
them is in [Device dependencies](../dcim/dependencies.md).

## DeviceDependency

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | |
| `numid` | int | assigned | Per-tenant [object number](../features/object-numbers.md) |
| `tenant` | FK → `Tenant` | required | |
| `upstream` | FK → `Device` | required | `CASCADE`, related name `dependents`. For a peer: the lower UUID |
| `downstream` | FK → `Device` | required | `CASCADE`, related name `dependencies`. For a peer: the higher UUID |
| `kind` | char(16) | `dependency` | `dependency` or `peer` |
| `medium` | FK → `DependencyMedium` | NULL | `PROTECT`: a medium in use is not deleted |
| `redundancy_group` | char(64) | `""` | Scoped to the downstream; empty = a group of its own |
| `description` | char(200) | `""` | |
| `comments` | text | `""` | |
| `custom_fields` / `tags` | | | Standard mixins |

Every defaulted column has a database default, so an older process can
still insert during a rolling upgrade.

**Constraints**

| Name | Rule |
|---|---|
| `devdep_no_self` | `upstream` differs from `downstream`. |
| `devdep_one_per_pair` | Unique on `(LEAST(upstream, downstream), GREATEST(upstream, downstream), tenant)`: one relation per device pair, which refuses a duplicate, the reverse dependency and a peer beside a dependency. |
| `devdep_peer_no_group` | A peer has no redundancy group. |

Indexes on `(tenant, upstream)`, `(tenant, downstream)` and `(tenant, kind)`.

Longer cycles are refused in the one write path,
`api.dependencies.save_dependency`: it takes a transaction-scoped advisory
lock per tenant (`pg_advisory_xact_lock(450, crc32(tenant))`), reads the
edges fresh, and refuses a dependency whose downstream already reaches its
upstream, naming the path. The API, bulk edit and import all save through
it.

**Site path:** `downstream__site|upstream__site` - the downstream's site,
else the upstream's. RBAC object type `devicedependency` (DCIM). Audited:
the device's Change log shows its dependencies' entries.

## DependencyMedium

An editable per-tenant catalog, the same shape as the IP roles.

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | |
| `tenant` | FK → `Tenant` | required | |
| `name` / `slug` | char(64/80) | required | Slug auto-generates; unique per tenant |
| `color` | char(7) | `""` | |
| `icon` | char(64) | `""` | Lucide icon name |
| `line_style` | char(8) | `solid` | `solid`, `dashed` or `dotted` - how the maps draw it |
| `description` | text | `""` | |
| `weight` | int | 100 | Sort order |
| `owning_site` | FK → `Site` | NULL | NULL = global; set = [local to that site](../access/site-separation.md) |

RBAC object type `dependencymedium` (DCIM); catalog locality
`owning_site`. Seeded per tenant with six rows (Ethernet, Fibre, Radio,
VPN/tunnel, LTE/5G, Satellite) by migration `api 0274`, `bootstrap` and
tenant create - only for a tenant with no media, so a deleted row stays
deleted.

## The graph

`api.dependencies.load_graph(tenant)` returns the tenant's `kind=dependency`
edges, cached per tenant and graph version for five minutes; every write
bumps the version once its transaction commits. The walks
(`ancestors`, `descendants`, `walk`, `outage_levels`) are pure functions over
that graph: a device is at **outage** when every upstream of one of its
redundancy groups is down, at **reduced redundancy** when some are, and only
an outage propagates.
