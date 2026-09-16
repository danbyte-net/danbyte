"""Direct database access - **trusted scripts only**.

Importing this module requires a configured Django, which a sandboxed run
does not have; there it raises with a message pointing back at ``db``.

``objects(slug)`` is the safe door: the queryset comes back already
restricted to what the run-as user may see, through the same RBAC helper
the API uses. ``model(slug)`` hands you the class itself with no scoping -
worker-privilege code, which is exactly why marking a script trusted needs
its own permission.
"""
from __future__ import annotations

from typing import Any

_UNTRUSTED = (
    "This script is not trusted, so it has no database access. Use `db` "
    "(the API client) instead, or ask an administrator to mark the script "
    "trusted."
)


def _django():
    try:
        from django.apps import apps  # noqa: F401
    except Exception as exc:  # noqa: BLE001 - sandboxed run: no Django at all
        raise RuntimeError(_UNTRUSTED) from exc
    from django.apps import apps

    if not apps.ready:
        raise RuntimeError(_UNTRUSTED)
    return apps


def model(slug: str) -> Any:
    """The model class for an object-type slug (``"device"``). Unscoped."""
    _django()
    from auth_api.object_types import model_for

    found = model_for(slug)
    if found is None:
        raise LookupError(f"Unknown object type: {slug}")
    return found


def objects(slug: str, *, user=None, tenant=None):
    """A queryset of ``slug`` restricted to what the run-as user may view.

    Defaults to the run's user and tenant, which the runner puts in the
    environment - so `objects("device")` inside a script is already the
    right subset, with no arguments.
    """
    import os

    _django()
    from django.contrib.auth import get_user_model

    from auth_api import rbac
    from core.models import Tenant

    cls = model(slug)
    qs = cls._default_manager.all()
    if user is None:
        user_id = os.environ.get("DANBYTE_RUN_AS_ID", "")
        user = get_user_model().objects.filter(pk=user_id).first() if user_id else None
    if tenant is None:
        tenant_id = os.environ.get("DANBYTE_TENANT_ID", "")
        tenant = Tenant.objects.filter(pk=tenant_id).first() if tenant_id else None
    if tenant is not None and _has_field(cls, "tenant"):
        qs = qs.filter(tenant=tenant)
    if user is None:
        return qs.none()
    return rbac.restrict_queryset(qs, user, tenant, slug, "view")


def _has_field(cls, name: str) -> bool:
    return any(f.name == name for f in cls._meta.concrete_fields)
