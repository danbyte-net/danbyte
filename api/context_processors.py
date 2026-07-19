"""Template context processors — populate variables every page needs.

``sidebar_tenants`` feeds the tenant switcher in ``_shell.html`` with the list
of switchable tenants the *current user* is allowed to operate within.
"""
from __future__ import annotations


def sidebar_tenants(request):
    """Tenants the user can switch to + the perm slugs they hold.

    ``user_perms`` lets sidebar templates hide forbidden entries with simple
    ``{% if "catalog.edit" in user_perms %}`` checks.
    """
    from auth_api.permissions import user_tenants, user_perms
    if not getattr(request, "user", None) or not request.user.is_authenticated:
        return {"available_tenants": [], "user_perms": set()}
    return {
        "available_tenants": list(
            user_tenants(request.user).order_by("name")
        ),
        "user_perms": set(user_perms(request.user)),
    }


def user_settings(request):
    """Expose the effective per-user prefs that the layout needs.

    Theme, density and stripes need to be available on every page so
    ``_shell.html`` can emit them as meta tags / data attrs and the
    pre-paint scripts (theme.js, stripes init) can pick them up without an
    extra HTTP round-trip.
    """
    if not getattr(request, "user", None) or not request.user.is_authenticated:
        return {"user_prefs": {}}
    from auth_api.user_prefs import get
    from api.views import _get_active_tenant
    tenant = _get_active_tenant(request)
    return {
        "user_prefs": {
            "theme":          get(request.user, "theme", tenant=tenant),
            "table_density":  get(request.user, "table_density", tenant=tenant),
            "table_stripes":  get(request.user, "table_stripes", tenant=tenant),
            "confirm_destructive": get(request.user, "confirm_destructive", tenant=tenant),
            "page_size":      get(request.user, "page_size", tenant=tenant),
        }
    }
