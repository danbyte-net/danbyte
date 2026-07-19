"""Built-in IP roles, seeded per tenant.

Migrations 0003/0007 seeded these for tenants that existed when they ran, but a
tenant created afterwards (via `bootstrap` or the Tenants API) got none — so the
gateway role was missing and the site gateway-policy autospawn had no role to
apply. `bootstrap` and `TenantViewSet.perform_create` call `seed_builtin_roles`
so every tenant starts with the catalog. Idempotent (keyed on slug).
"""
from __future__ import annotations

# (slug, name, color, weight, is_gateway, is_virtual, icon)
BUILTIN_IP_ROLES = [
    ("gateway", "Gateway", "#10b981", 10, True, False, "arrow-right"),
    ("virtual", "Virtual", "#10b981", 15, True, True, "crown"),
    ("active", "Active", "#f59e0b", 20, False, False, "crown"),
    ("standby", "Standby", "#f59e0b", 21, False, False, "crown-off"),
    ("loopback", "Loopback", "#3b82f6", 25, False, False, ""),
    ("vip", "VIP", "#f59e0b", 30, False, False, ""),
    ("hsrp", "HSRP", "#a855f7", 40, False, False, ""),
    ("vrrp", "VRRP", "#8b5cf6", 50, False, False, ""),
    ("anycast", "Anycast", "#06b6d4", 60, False, False, ""),
    ("secondary", "Secondary", "#71717a", 70, False, False, ""),
]


def seed_builtin_roles(tenant) -> int:
    """Idempotently create the built-in IP roles for `tenant`. Returns the count
    of newly created roles."""
    from api.models import IPRole

    created = 0
    for slug, name, color, weight, is_gw, is_virt, icon in BUILTIN_IP_ROLES:
        _, was_created = IPRole.objects.get_or_create(
            tenant=tenant,
            slug=slug,
            defaults={
                "name": name,
                "color": color,
                "weight": weight,
                "is_gateway": is_gw,
                "is_virtual": is_virt,
                "icon": icon,
            },
        )
        created += int(was_created)
    return created
