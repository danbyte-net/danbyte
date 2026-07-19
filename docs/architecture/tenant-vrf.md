---
icon: lucide/shield-check
---

# Tenant + VRF isolation

The two stacked scopes that make Danbyte safe for MSPs and large enterprises.

## Tenant

A `Tenant` is the **hard isolation boundary**. For an MSP, one tenant per
customer. For a single-company deployment, one tenant.

| | |
|---|---|
| **Model** | `core.Tenant` |
| **PK** | UUID |
| **Parent** | `core.Organization` (the SaaS install) |
| **Visibility** | Tenants are *never displayed together*. The UI shows one tenant at a time. |
| **Switcher** | Sidebar dropdown (Phase 2 — UI hook is in place; lands shortly) |
| **Session storage** | `request.session['current_tenant_id']` |

Every domain object has a `tenant` FK:

- `Site`, `VRF`, `Prefix`, `IPAddress`, `VLAN`, `Device`, `DeviceType`, `Cable`

There is **no tenant column** in any list — by construction, every list is
already scoped to a single tenant.

## VRF

A `VRF` is a **routing context** inside a tenant. Two prefixes with identical
CIDR in different VRFs are valid and distinct — that's the whole point of L3VPN-style
separation.

| | |
|---|---|
| **Model** | `api.VRF` |
| **PK** | UUID |
| **Fields** | `name`, `rd` (route distinguisher), `description`, `enforce_unique`, `color` |
| **Parent** | `Tenant` |

`Prefix.vrf` and `IPAddress.vrf` are nullable; `NULL` means the **Global VRF**.

## The uniqueness trick

The constraint that makes overlapping CIDRs work cleanly:

```python
class Prefix(models.Model):
    tenant = FK(Tenant)
    vrf    = FK(VRF, null=True)
    cidr   = CharField

    class Meta:
        constraints = [
            UniqueConstraint(
                fields=['tenant', 'vrf', 'cidr'],
                nulls_distinct=False,                       # ← Postgres 15+
                name='uniq_prefix_tenant_vrf_cidr',
            )
        ]
```

The `nulls_distinct=False` is critical: without it, PostgreSQL would treat two
`(tenant, NULL, '10.0.10.0/24')` rows as distinct (because two NULLs aren't
equal in SQL by default). With it, Global behaves like a real VRF for
uniqueness purposes — exactly one `10.0.10.0/24` is allowed per `(tenant,
Global)`, and exactly one per `(tenant, production)`, etc.

Same constraint applies to `IPAddress`: `(tenant, vrf, ip_address)`.

## Reading the prefix list with VRFs

When `sort=cidr` (the default), the list view groups prefixes by `(vrf,
family)` before computing depth — so:

1. **Depth resets per VRF.** `10.0.0.0/16` in `production` doesn't pretend to
   parent `10.0.10.0/24` in `lab`.
2. **Families don't cross.** An IPv4 `/16` never claims an IPv6 child.
3. **Each VRF gets its own section header** with name, RD, and prefix count.
4. **Global comes first**, then named VRFs alphabetically.

```text
▾ VRF · Global         25 prefixes
   10.0.0.0/16
     └ 10.0.10.0/24
     └ 10.0.20.0/24
   …

▾ VRF · production     3 prefixes        RD 65001:100
   10.0.0.0/16                                ← same CIDR, different VRF — fine
     └ 10.0.10.0/24
     └ 10.0.20.0/24

▾ VRF · lab            2 prefixes        RD 65001:200
   10.10.0.0/16
     └ 10.10.10.0/24
```

## What gets inherited

When creating a child prefix from a parent's "Add child prefix" button or
clicking an allocate row in the chooser:

- **VRF** is copied from the parent (so a child of a production prefix lands in `production`)
- **Site** is copied from the parent
- **VLAN** is copied from the parent (you can clear it)

The form shows a small green confirmation chip: *"Inheriting site + VLAN from
parent 10.0.10.0/24"*.

## What's enforced where

| Constraint | Where |
|---|---|
| Same `(tenant, vrf, cidr)` rejected | `PrefixForm.clean()` (clean error) + DB `UniqueConstraint` (failsafe) |
| Same `(tenant, vrf, ip_address)` rejected | `IPAddressForm.clean_ip_address()` + DB |
| IP must fall inside its parent prefix | `IPAddressForm.clean_ip_address()` |
| CIDR must be valid (canonical form) | `PrefixForm.clean_cidr()` (uses `ipaddress.ip_network`) |
| Cross-tenant queries | Every view's `Prefix.objects.filter(tenant=tenant)` — soft (caller responsibility); add a `TenantOwnedManager` later for safety |

## What's not yet wired

- A tenant switcher in the sidebar UI (the data hook is in place — Phase 2)
- VRF management page (CRUD via Django admin only, for now)
- `Site.vrfs` M2M is documentation only — not used in any validation today
- Per-tenant tag scoping (tags are still global — Phase 5)
