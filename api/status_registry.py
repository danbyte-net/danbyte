"""Registry of object types that carry a user-definable ``Status``.

Mirrors ``customization.CUSTOMIZABLE_MODELS`` (the custom-field ``applies_to``
pattern): a status's ``available_to`` / ``default_for`` lists are validated
against ``STATUSABLE_MODEL_VALUES``. The migration seeds built-in statuses per
tenant from the values each model historically used, colouring them from
``BUILTIN_STATUS_COLORS`` so "Active" reads the same everywhere.
"""
from __future__ import annotations

# slug → human label. Keep in sync with the models whose ``status`` FKs Status
# and with the frontend STATUSABLE_MODELS list.
STATUSABLE_MODELS = [
    ("ipaddress", "IP addresses"),
    ("device", "Devices"),
    ("prefix", "Prefixes"),
    ("iprange", "IP ranges"),
    ("rack", "Racks"),
    ("cluster", "Clusters"),
    ("virtualmachine", "Virtual machines"),
    ("cable", "Cables"),
    ("circuit", "Circuits"),
    ("powerfeed", "Power feeds"),
    ("wirelesslan", "Wireless LANs"),
    ("tunnel", "Tunnels"),
    ("location", "Locations"),
]
STATUSABLE_MODEL_VALUES = {m[0] for m in STATUSABLE_MODELS}

# Built-in status value → swatch hex, grouped by meaning (emerald = healthy,
# amber = transitional, red = bad, neutral zinc = inactive/none).
BUILTIN_STATUS_COLORS = {
    "active": "#10b981",
    "connected": "#10b981",
    "available": "#10b981",
    "reserved": "#f59e0b",
    "staged": "#f59e0b",
    "staging": "#f59e0b",
    "provisioning": "#f59e0b",
    "deprovisioning": "#f59e0b",
    "decommissioning": "#f59e0b",
    "offline": "#ef4444",
    "failed": "#ef4444",
    "deprecated": "#ef4444",
    "planned": "#a1a1aa",
    "inventory": "#a1a1aa",
    "container": "#a1a1aa",
    "disabled": "#a1a1aa",
    "not_connected": "#71717a",
    "decommissioned": "#71717a",
    "retired": "#71717a",
}

# (model slug, ModelName, default status value) — drives the data migration's
# per-tenant seeding + backfill. ModelName resolved via apps.get_model("api", …).
STATUS_MODEL_SEEDS = [
    ("ipaddress", "IPAddress", None),  # already FKs Status; seeding handled separately
    ("device", "Device", "active"),
    ("prefix", "Prefix", "active"),
    ("iprange", "IPRange", "active"),
    ("rack", "Rack", "active"),
    ("cluster", "Cluster", "active"),
    ("virtualmachine", "VirtualMachine", "active"),
    ("cable", "Cable", "connected"),
    ("circuit", "Circuit", "active"),
    ("powerfeed", "PowerFeed", "active"),
    ("wirelesslan", "WirelessLAN", "active"),
    ("tunnel", "Tunnel", "active"),
    ("location", "Location", "active"),
]

# Built-in status values per object type, mirroring the historical per-model
# enums (the ``STATUS_CHOICES`` constants that 0047 replaced with a Status FK).
# This is the source of truth for the built-in catalog that every tenant should
# start with — see ``seed_builtin_statuses``. The default for each type comes
# from ``STATUS_MODEL_SEEDS``.
STATUS_MODEL_VALUES = {
    "ipaddress": ["active", "reserved", "deprecated"],
    "device": ["active", "planned", "staged", "offline", "inventory", "decommissioning"],
    "prefix": ["container", "active", "reserved", "deprecated"],
    "iprange": ["active", "reserved", "deprecated"],
    "rack": ["active", "planned", "reserved", "available", "deprecated"],
    "cluster": ["active", "planned", "staging", "offline", "decommissioning"],
    "virtualmachine": ["active", "offline", "planned", "staged", "decommissioning"],
    "cable": ["connected", "planned", "not_connected", "decommissioning"],
    "circuit": ["planned", "provisioning", "active", "offline", "deprovisioning", "decommissioned"],
    "powerfeed": ["planned", "active", "offline", "failed"],
    "wirelesslan": ["active", "reserved", "disabled", "deprecated"],
    "tunnel": ["planned", "active", "disabled"],
    "location": ["active", "planned", "decommissioning", "retired"],
}

# model slug → default status value (None for ipaddress → fall back to "active").
_STATUS_DEFAULTS = {slug: (default or "active") for slug, _mn, default in STATUS_MODEL_SEEDS}


def seed_builtin_statuses(tenant, *, Status=None):
    """Idempotently create/merge the built-in ``Status`` catalog for ``tenant``.

    Creates a shared ``Status`` row per built-in value (merging into any existing
    row with the same slug) and extends its ``available_to`` / ``default_for``
    scope for every object type that uses it. Safe to call repeatedly — on tenant
    creation (``TenantViewSet.perform_create``), from ``manage.py
    seed_builtin_statuses`` / ``manage.py bootstrap``, or to backfill an existing
    tenant. Returns the number of new ``Status`` rows created.

    The migration ``0047_unified_status`` only seeded values that *existing*
    objects already used, so a fresh install (or any tenant created after the
    migration ran) never received the built-in catalog — this function closes
    that gap.
    """
    if Status is None:
        from api.models import Status  # local import: keeps this module Django-free

    cache = {s.slug: s for s in Status.objects.filter(tenant=tenant)}
    created = 0
    for model_slug, values in STATUS_MODEL_VALUES.items():
        default_value = _STATUS_DEFAULTS.get(model_slug, "active")
        for value in values:
            s = cache.get(value)
            if s is None:
                s = Status.objects.create(
                    tenant=tenant,
                    name=value.replace("_", " ").title(),
                    slug=value,
                    color=BUILTIN_STATUS_COLORS.get(value, ""),
                    available_to=[],
                    default_for=[],
                )
                cache[value] = s
                created += 1
            changed = False
            if model_slug not in (s.available_to or []):
                s.available_to = (s.available_to or []) + [model_slug]
                changed = True
            if value == default_value and model_slug not in (s.default_for or []):
                s.default_for = (s.default_for or []) + [model_slug]
                changed = True
            if changed:
                s.save(update_fields=["available_to", "default_for"])
    return created


def resolve_status(tenant, value, model_slug=None, *, Status=None):
    """The tenant's ``Status`` for a value given as a **slug or human name**,
    matched case-insensitively (``"container"``, ``"Active"``, ``"in use"`` all
    resolve). Assumes the built-in catalog is seeded — call
    ``seed_builtin_statuses(tenant)`` first. Falls back to the object type's
    default, then to ``active``/any, so seeders always get a usable FK; returns
    ``None`` only when the tenant has no statuses at all.
    """
    if Status is None:
        from api.models import Status  # local import — keep this module Django-free

    raw = (value or "").strip()
    slug = raw.lower().replace(" ", "-").replace("_", "-")
    qs = Status.objects.filter(tenant=tenant)
    s = qs.filter(slug=slug).first() or qs.filter(name__iexact=raw).first()
    if s is None and model_slug:
        s = qs.filter(default_for__contains=[model_slug]).first()
    if s is None:
        s = qs.filter(slug="active").first() or qs.first()
    return s
