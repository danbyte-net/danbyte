"""The starter dependency media, seeded per tenant (#450).

A useful starting catalog (CLAUDE.md "deliberate seeds"): six media a
dependency usually runs over, so the add dialog offers something on a fresh
tenant. Every row can be renamed, recoloured or deleted. Migration 0274 seeds
the tenants that existed when it ran; ``bootstrap`` and
``TenantViewSet.perform_create`` call :func:`seed_builtin_media` for the
rest. A tenant that already has media is left alone, so a medium someone
deleted is not brought back by an upgrade.
"""
from __future__ import annotations

# (slug, name, color, weight, icon, line_style)
BUILTIN_MEDIA = [
    ("ethernet", "Ethernet", "#3b82f6", 10, "cable", "solid"),
    ("fibre", "Fibre", "#f97316", 20, "spline", "solid"),
    ("radio", "Radio", "#8b5cf6", 30, "radio-tower", "dashed"),
    ("vpn", "VPN/tunnel", "#14b8a6", 40, "lock", "dotted"),
    ("lte-5g", "LTE/5G", "#ec4899", 50, "signal", "dashed"),
    ("satellite", "Satellite", "#64748b", 60, "satellite", "dotted"),
]


def seed_builtin_media(tenant, *, DependencyMedium=None) -> int:
    """Create the starter media for ``tenant`` when it has none. Returns the
    number of new rows. A data migration passes its historical model."""
    if DependencyMedium is None:
        from api.models import DependencyMedium

    if DependencyMedium.objects.filter(tenant=tenant).exists():
        return 0
    created = 0
    for slug, name, color, weight, icon, line_style in BUILTIN_MEDIA:
        _, was_created = DependencyMedium.objects.get_or_create(
            tenant=tenant, slug=slug,
            defaults={"name": name, "color": color, "weight": weight,
                      "icon": icon, "line_style": line_style, "description": ""},
        )
        created += int(was_created)
    return created
