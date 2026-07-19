"""Permission registry + helpers.

Permissions are plain string slugs grouped by area: ``prefixes.view``,
``ips.edit``, ``catalog.edit``, etc. ``ROLE_PRESETS`` maps each named role
to the perms it implicitly gets; custom-role users fall back to the explicit
list stored on their UserProfile.

Use :func:`user_has_perm` everywhere; never inspect ``user.profile.role``
directly, since superusers and (later) impersonation should also pass.
"""
from __future__ import annotations

from functools import wraps

from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.shortcuts import render


# (slug, friendly label, area) — `area` groups them on the edit form.
PERMISSIONS: list[tuple[str, str, str]] = [
    ("prefixes.view",   "View prefixes",                                  "IPAM"),
    ("prefixes.edit",   "Create / edit prefixes",                         "IPAM"),
    ("prefixes.delete", "Delete prefixes",                                "IPAM"),
    ("ips.view",        "View IP addresses",                              "IPAM"),
    ("ips.edit",        "Create / edit IPs",                              "IPAM"),
    ("ips.delete",      "Delete IPs",                                     "IPAM"),
    ("vrf.view",        "View VRFs + route targets",                      "IPAM"),
    ("vrf.edit",        "Edit VRFs + route targets",                      "IPAM"),
    ("devices.view",    "View devices",                                   "Devices"),
    ("devices.edit",    "Create / edit devices + types + manufacturers",  "Devices"),
    ("devices.delete",  "Delete devices",                                 "Devices"),
    ("catalog.edit",    "Edit catalogs (tags, IP roles + statuses, VLANs, sites)", "Governance"),
    ("import.run",      "Run import / export",                            "Governance"),
    ("tenants.switch",  "Switch active tenant",                           "Tenants"),
    ("tenants.edit",    "Create / edit tenants",                          "Tenants"),
    ("users.manage",    "Manage users + assign permissions",              "Admin"),
    ("jobs.manage",     "View + manage background jobs (queues, workers)", "Admin"),
]
PERM_SLUGS = [p[0] for p in PERMISSIONS]


ROLE_PRESETS: dict[str, list[str]] = {
    "reader": [s for s, *_ in PERMISSIONS if s.endswith(".view") or s == "tenants.switch"],
    "admin": list(PERM_SLUGS),
    # "custom" reads from UserProfile.permissions.
}


def user_perms(user) -> list[str]:
    """All permission slugs effectively granted to ``user``."""
    if not getattr(user, "is_authenticated", False):
        return []
    if user.is_superuser:
        return list(PERM_SLUGS)
    profile = getattr(user, "profile", None)
    if profile is None:
        return []
    if profile.role == "admin":
        return list(ROLE_PRESETS["admin"])
    if profile.role == "reader":
        return list(ROLE_PRESETS["reader"])
    return list(profile.permissions or [])


def user_has_perm(user, perm: str) -> bool:
    return perm in user_perms(user)


def can_manage_admin(user, tenant=None) -> bool:
    """May ``user`` reach the deployment-admin surfaces (Email, LDAP, Monitoring
    settings, Users/Groups/Permissions)?

    Mirrors ``can_manage_users`` in ``me_json``: superusers and the legacy
    ``users.manage`` slug pass, **and** so does anyone with RBAC ``change`` on
    the ``user`` object type — so an Administrator provisioned purely through an
    RBAC group (no legacy ``role``) isn't wrongly blocked. Pass the active
    ``tenant`` when you have one; ``None`` still honours tenant-unscoped grants
    (the built-in Administrator permission is unscoped).
    """
    if not getattr(user, "is_authenticated", False):
        return False
    if user.is_superuser or "users.manage" in user_perms(user):
        return True
    from .rbac import effective_actions

    return "change" in effective_actions(user, tenant).get("user", set())


def can_manage_deployment(user) -> bool:
    """May ``user`` edit **deployment-wide** settings (global email/LDAP
    defaults, updates, device-field defaults)?

    Stricter than :func:`can_manage_admin`: a tenant-narrowed admin grant does
    NOT pass. Passes for superusers, the legacy ``users.manage`` slug (legacy
    slugs are inherently global), or an RBAC ``change``-on-``user`` grant whose
    ObjectPermission has NO tenant narrowing — ``effective_actions(user, None)``
    skips every tenant-scoped grant (see rbac.applicable_permissions), so it is
    exactly the unscoped grant set.
    """
    if not getattr(user, "is_authenticated", False):
        return False
    if user.is_superuser or "users.manage" in user_perms(user):
        return True
    from .rbac import effective_actions

    return "change" in effective_actions(user, None).get("user", set())


def user_tenants(user):
    """QuerySet of Tenants this user is allowed to operate within.

    Admins and superusers always see every active tenant in the org. A
    reader/custom user is restricted to the tenants explicitly granted on
    their UserProfile.
    """
    from core.models import Tenant
    if not getattr(user, "is_authenticated", False):
        return Tenant.objects.none()
    if user.is_superuser:
        return Tenant.objects.filter(is_active=True)
    profile = getattr(user, "profile", None)
    if profile is None:
        return Tenant.objects.none()
    if profile.role == "admin":
        return Tenant.objects.filter(is_active=True)
    return profile.tenants.filter(is_active=True)


def user_can_access_tenant(user, tenant) -> bool:
    if tenant is None:
        return False
    return user_tenants(user).filter(pk=tenant.pk).exists()


def require_perm(perm: str):
    """View decorator. 403s unauthenticated / under-permissioned users."""
    def deco(view_func):
        @wraps(view_func)
        @login_required
        def wrapper(request, *args, **kwargs):
            if not user_has_perm(request.user, perm):
                return render(request, "api/no_perm.html", {
                    "needed_perm": perm,
                }, status=403)
            return view_func(request, *args, **kwargs)
        return wrapper
    return deco
