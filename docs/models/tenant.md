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

- All domain models carry `tenant = FK(Tenant, on_delete=CASCADE)` — deleting a tenant cascades and is therefore a heavy operation
- See [Tenant + VRF](../architecture/tenant-vrf.md) for the wider picture
