"""User + tenant preferences — the cascading-default registry.

Every settable preference goes through here so the same lookup rule applies
everywhere:

    user.profile.prefs[key]  →  tenant.prefs[key]  →  DEFAULTS[key]

The first non-missing wins. Booleans are honored when explicitly set (so
turning a default off doesn't fall through to the tenant default). Keys
that aren't in :data:`DEFAULTS` are unknown — fail loudly when read.

Adding a new preference:

  1. Add an entry to :data:`DEFAULTS` with its baseline value.
  2. Add a form field on ``UserSettingsForm`` and/or
     ``AdminTenantSettingsForm`` in ``auth_api/settings_forms.py``.
  3. Read it via ``user_prefs.get(request.user, "key")`` wherever it's
     needed (pagination, density, theme, etc.).
"""
from __future__ import annotations

from typing import Any


# The canonical preference registry. Keep this list short and well-named;
# every key here is a contract with the UI. Comments describe the role.
DEFAULTS: dict[str, Any] = {
    # ─── Tables ──────────────────────────────────────────────────────────
    "page_size":      25,          # Pagination default across list pages.
    "table_density":  "comfortable",  # comfortable | compact
    "table_stripes":  False,       # Striped rows on by default?

    # ─── Visual ──────────────────────────────────────────────────────────
    "theme":          "system",    # system | light | dark — initial render.
    "time_format":    "relative",  # relative | absolute — how timestamps show.

    # ─── Space map ───────────────────────────────────────────────────────
    # Deepest prefix length the subnet map draws, per family. Defaults = the
    # family's natural floor (no extra restriction); a user can make it
    # shallower (e.g. v4 stop at /29) so the map stays scannable.
    "space_map_v4_max": 31,
    "space_map_v6_max": 128,

    # ─── Navigation ──────────────────────────────────────────────────────
    "landing_page":   "/",         # Page to open on first load after login.

    # ─── Safety / confirmations ──────────────────────────────────────────
    "confirm_destructive": True,   # Two-step Confirm button on bulk delete.

    # ─── IPAM defaults (set by admin, used as initial values on create) ──
    "default_ip_status_id": None,   # Status.id or None — picks tenant's is_default
    "default_ip_role_id":   None,   # IPRole.id or None — no role on create
    "gateway_role_id":      None,   # IPRole.id flagged is_gateway — auto-fill on
                                    # site creation. None = use the role with
                                    # is_gateway=True in the tenant catalog.

    # ─── Tenant access ───────────────────────────────────────────────────
    "default_tenant_id":    None,   # Tenant.id to land on at login. None =
                                    # the user's first allowed tenant.
}


#: Page-size options the user picker offers. Centralised so the admin
#: page can show the same list (and so we never accept a smuggled value
#: outside this set).
PAGE_SIZE_CHOICES = (10, 25, 50, 100, 250, 500, 1000, 2000)


def _user_blob(user) -> dict:
    """The user's prefs dict, or {} if the user is anonymous / lacks a profile."""
    if user is None or not getattr(user, "is_authenticated", False):
        return {}
    prof = getattr(user, "profile", None)
    return prof.prefs if prof else {}


def _tenant_blob(tenant) -> dict:
    """Tenant prefs blob, or {} if no tenant."""
    if tenant is None:
        return {}
    return getattr(tenant, "prefs", {}) or {}


def get(user, key: str, *, tenant=None) -> Any:
    """Return the effective value for ``key`` for this user + tenant.

    Lookup order: user blob → tenant blob → :data:`DEFAULTS`. The user
    overrides the tenant default for them specifically; the tenant default
    overrides the global baseline for users who haven't customised.
    """
    if key not in DEFAULTS:
        raise KeyError(f"unknown preference key: {key!r}")
    ub = _user_blob(user)
    if key in ub:
        return ub[key]
    tb = _tenant_blob(tenant)
    if key in tb:
        return tb[key]
    return DEFAULTS[key]


def get_page_size(user, tenant=None) -> int:
    """Convenience for paginator views: clamp to PAGE_SIZE_CHOICES."""
    value = get(user, "page_size", tenant=tenant)
    try:
        value = int(value)
    except (TypeError, ValueError):
        return DEFAULTS["page_size"]
    return value if value in PAGE_SIZE_CHOICES else DEFAULTS["page_size"]


def set_user(user, key: str, value: Any) -> None:
    """Write ``key`` on the user's profile prefs blob and save it."""
    if key not in DEFAULTS:
        raise KeyError(f"unknown preference key: {key!r}")
    prof = user.profile
    blob = dict(prof.prefs or {})
    if value is None:
        blob.pop(key, None)
    else:
        blob[key] = value
    prof.prefs = blob
    prof.save(update_fields=["prefs"])


def set_tenant(tenant, key: str, value: Any) -> None:
    """Admin write: ``key`` on the tenant's prefs blob."""
    if key not in DEFAULTS:
        raise KeyError(f"unknown preference key: {key!r}")
    blob = dict(tenant.prefs or {})
    if value is None:
        blob.pop(key, None)
    else:
        blob[key] = value
    tenant.prefs = blob
    tenant.save(update_fields=["prefs"])
