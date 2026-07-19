"""Small helpers for tests after status became a ``Status`` FK.

``status_for(tenant)`` get-or-creates a tenant-scoped Status (default slug
"active") usable on every object type, so test fixtures can pass a real Status
instance instead of the old enum string.
"""
from __future__ import annotations

from .models import Status
from .status_registry import STATUSABLE_MODEL_VALUES


def status_for(tenant, slug: str = "active"):
    obj, _ = Status.objects.get_or_create(
        tenant=tenant,
        slug=slug,
        defaults={
            "name": slug.replace("_", " ").title(),
            "available_to": sorted(STATUSABLE_MODEL_VALUES),
            "default_for": sorted(STATUSABLE_MODEL_VALUES) if slug == "active" else [],
        },
    )
    return obj
