---
icon: lucide/users
---

# Tenant

The hard-isolation scope. Lives in `core.models`.

## Fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | UUID | `uuid4()` | PK |
| `org` | FK → `Organization` | required | The SaaS install owner |
| `group` | FK → `TenantGroup` | `null` | Optional slot in the org's tenant-group tree (see below) |
| `name` | char(255) | required | Human label |
| `slug` | slug | required | URL-safe; unique within `org` |
| `color` | char(7) | `""` | Optional `#xxxxxx` — shown as a sidebar dot |
| `description` | text | `""` | |
| `is_active` | bool | `True` | Inactive tenants are hidden from the switcher |
| `created_at` / `updated_at` | timestamp | auto | |

## Constraints

```python
class Meta:
    unique_together = [("org", "slug"), ("org", "name")]
    ordering = ["name"]
```

## Tenant groups

`TenantGroup` (also in `core.models`) is a **self-nesting tree for organizing
tenants** — *Customers → Enterprise → acme*. Groups are **org-scoped** (like the
tenants they organize, not tenant-scoped), carry `name` / `slug` (unique per
org) / `parent` / `description`, and are cycle-guarded — a group can't be its
own ancestor. Deleting a group nulls its children's `parent` and its tenants'
`group`; it never deletes tenants.

Manage groups on the **Tenants** page, where each tenant can be dropped into a
group on its form. NetBox `tenantgroup` hierarchies import losslessly.

## Deleting a tenant

Deleting a tenant is a **full teardown**: it permanently removes the tenant and
everything it owns — prefixes, IPs, VLANs, devices, sites, circuits, and its
per-tenant catalogs (statuses, roles, VRFs, …). The single-delete dialog makes
you **type the tenant name to confirm** (GitHub-style) and shows the record
counts first.

Structural catalogs reference their tenant with `on_delete=PROTECT` (a guard
against accidental mass deletion), so the delete is done as a deliberate,
ordered cascade through those protections inside one transaction — if anything
fails, nothing is removed. Very large tenants can take a while (it may delete
millions of monitoring/audit rows).

## Bulk actions

Select tenants on the **Tenants** list to reveal a bulk bar:

- **Edit** — set the **tenant group** or **active status** for all selected
  tenants at once (`POST /api/tenants/bulk-update/`).
- **Delete** — force-delete every selected tenant and all its data, after a
  single confirmation (`POST /api/tenants/bulk-delete/`).

Both are gated by the same `tenant` `change` / `delete` RBAC as single edits.

## Resolution

The active tenant is resolved on every request:

```python
def _get_active_tenant(request=None):
    if request is not None:
        tid = request.session.get("current_tenant_id")
        if tid:
            t = Tenant.objects.filter(pk=tid, is_active=True).first()
            if t is not None:
                return t
    return Tenant.objects.filter(is_active=True).first()
```

So:

- Session-stored `current_tenant_id` → that tenant
- Otherwise → first active tenant

The switcher UI (Phase 2) will POST to a route that updates `current_tenant_id`.

## Related

- Domain data carries `tenant = FK(Tenant, on_delete=CASCADE)`; structural catalogs (Status, VRF, Site, Manufacturer, DeviceRole, …) use `on_delete=PROTECT`, so a tenant delete is a deliberate ordered cascade (see [Deleting a tenant](#deleting-a-tenant)) — a heavy operation
- See [Tenant + VRF](../architecture/tenant-vrf.md) for the wider picture
