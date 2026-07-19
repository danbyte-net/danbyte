"""DRF enforcement for RBAC object permissions.

``RBACViewSetMixin`` is mixed into the shared tenant-scoped viewset bases so
every endpoint inherits enforcement at once. The object-type slug is derived
from the viewset's model (``queryset.model``); a viewset may override with
``rbac_object_type``. Unregistered types are *not* RBAC-controlled (legacy
"any authenticated user in the tenant" behaviour) so rollout is incremental.
"""
from __future__ import annotations

from rest_framework.permissions import SAFE_METHODS, BasePermission

from . import rbac
from .object_types import is_registered


def _object_type(view) -> str | None:
    slug = getattr(view, "rbac_object_type", None)
    if slug:
        return slug
    qs = getattr(view, "queryset", None)
    model = getattr(qs, "model", None)
    if model is None:
        return None
    return model._meta.model_name


def _action_for(view, request) -> str:
    """Map the DRF action / HTTP method to a permission action.

    A viewset may declare ``rbac_action_map = {"bulk_delete": "delete", ...}``
    to override the default for custom @actions — without it every mutating
    @action maps to ``change``, which under-demands ``bulk-delete`` (should
    need ``delete``) and ``bulk-create`` (should need ``add``). The map flows
    into BOTH gates: the type-level permission check and the row-level
    queryset restriction.
    """
    a = getattr(view, "action", None)
    declared = getattr(view, "rbac_action_map", {}).get(a)
    if declared:
        return declared
    if a in ("list", "retrieve", "metadata"):
        return "view"
    if a == "create":
        return "add"
    if a in ("update", "partial_update"):
        return "change"
    if a == "destroy":
        return "delete"
    # Custom @action: safe reads → view, anything that writes → change.
    return "view" if request.method in SAFE_METHODS else "change"


def _active_tenant(request):
    from api.views import _get_active_tenant

    return _get_active_tenant(request)


class DeploymentAdminForWrites(BasePermission):
    """Reads follow whatever other permission classes allow; any write
    (create/update/delete or a mutating @action) requires a DEPLOYMENT admin.

    Used on the global identity/RBAC viewsets (Users, Groups, ObjectPermissions)
    — those objects are deployment-wide, so a *tenant*-scoped ``change-user``
    grant must not let a tenant admin edit users/groups/permissions and thereby
    escalate to global admin (issue #59+ escalation)."""

    message = "Deployment admin required to modify users, groups, or permissions."

    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return True
        from .permissions import can_manage_deployment

        return can_manage_deployment(request.user)

    def has_object_permission(self, request, view, obj):
        return self.has_permission(request, view)


class RBACObjectPermission(BasePermission):
    """Grants the request only if the user has the mapped action on the
    viewset's object type (in the active tenant). Row-level scoping is handled
    by the queryset restriction in the mixin."""

    def has_permission(self, request, view):
        user = request.user
        if not getattr(user, "is_authenticated", False):
            return False
        if user.is_superuser:
            return True
        slug = _object_type(view)
        if slug is None:
            return True  # non-model viewset — it gates itself
        if not is_registered(slug):
            # Fail CLOSED: a model exposed through an RBAC-gated viewset but
            # missing from the registry must not silently grant every tenant
            # member access. Register it in auth_api/object_types.py.
            return False
        return rbac.has_action(user, _active_tenant(request), slug, _action_for(view, request))


def restrict_for_view(view, qs):
    """Apply the user's RBAC row constraints for the current action to ``qs``.

    Called from the tenant-scoped base `get_queryset` (which builds the tenant
    filter itself and doesn't chain to super), so this is the single place the
    constraint restriction lands. No-op for anonymous, superuser, or
    unregistered (non-controlled) object types.
    """
    request = getattr(view, "request", None)
    user = getattr(request, "user", None)
    if user is None or not getattr(user, "is_authenticated", False):
        return qs
    slug = _object_type(view)
    if slug is None or not is_registered(slug):
        return qs
    action = _action_for(view, request)
    if action == "add":
        return qs
    return rbac.restrict_queryset(qs, user, _active_tenant(request), slug, action)


class RBACViewSetMixin:
    """Adds `RBACObjectPermission` to the viewset's permissions. Queryset row
    restriction is applied via `restrict_for_view` inside the tenant base's
    `get_queryset`. Mix into the shared bases so every endpoint inherits it."""

    def get_permissions(self):
        return [*super().get_permissions(), RBACObjectPermission()]
