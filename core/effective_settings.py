"""Resolve effective settings: per-tenant override or the deployment default.

Each overridable group on :class:`~core.models.TenantSettings` carries an
``override_*`` toggle. The helpers here return **whichever model instance's
fields should be used** - the tenant row when its toggle is on, else the
:class:`~core.models.DeploymentSettings` singleton. Because TenantSettings
mirrors DeploymentSettings' field names, consumers work unchanged with either
object (``build_email_connection``, the LDAP backend builder, the sharing
gates). The read path never creates rows - no row means "inherit everything".

Deployment-only groups (updates, ``public_base_url``, ``webhook_timeout``,
``outbound_proxy``, config-drift, retention) have no tenant counterpart -
callers keep ``DeploymentSettings.load()`` for those.

See ``docs/architecture/tenant-settings.md``.
"""
from __future__ import annotations


def _deployment():
    from core.models import DeploymentSettings

    return DeploymentSettings.load()


def _tenant_row(tenant):
    """The tenant's settings row, or None. Never get_or_creates."""
    if tenant is None:
        return None
    from core.models import TenantSettings

    return TenantSettings.objects.filter(tenant=tenant).first()


def effective_email(tenant, site=None):
    """The object whose ``email_enabled`` / ``smtp_*`` / ``email_from`` /
    ``secrets["password"]`` to use for outbound mail.

    Three layers, most specific wins: a ``site`` (when given) whose
    ``override_email`` is on → the tenant override → the deployment default.
    All three models mirror the SMTP field names so consumers work unchanged;
    callers with no site context simply omit it (zero behavior change).
    ``site`` may be a Site instance or id.
    """
    if site is not None:
        from .models import SiteSettings

        ss = SiteSettings.objects.filter(site=site, override_email=True).first()
        if ss is not None:
            return ss
    ts = _tenant_row(tenant)
    if ts is not None and ts.override_email:
        return ts
    return _deployment()


def effective_sharing(tenant):
    """The object whose share-link / delegation policy applies."""
    ts = _tenant_row(tenant)
    if ts is not None and ts.override_sharing:
        return ts
    return _deployment()


def effective_separation(tenant):
    """The object whose site-separation policy applies.

    Its own override group (like the floor-plan popover): flipping separation
    must not force a tenant to fork the sharing group. Carries
    ``enhanced_site_separation`` and ``allow_site_settings``.
    """
    ts = _tenant_row(tenant)
    if ts is not None and ts.override_separation:
        return ts
    return _deployment()


def separation_enabled(tenant) -> bool:
    """Whether enhanced site separation is ON for this tenant."""
    return bool(effective_separation(tenant).enhanced_site_separation)


def effective_ui(tenant):
    """The object whose ``human_ids_enabled`` / ``device_field_visibility``
    apply."""
    ts = _tenant_row(tenant)
    if ts is not None and ts.override_ui:
        return ts
    return _deployment()


def effective_digest(tenant):
    """The object whose email-digest schedule/recipients apply (its own
    override group, mirroring email). ``digest_last_run`` is NOT read from here
    - that is tracked per-tenant on TenantSettings."""
    ts = _tenant_row(tenant)
    if ts is not None and ts.override_digest:
        return ts
    return _deployment()


def effective_device_fields(tenant) -> dict:
    """The merged optional-device-field visibility map for this tenant:
    server defaults ← the effective (deployment or tenant) stored values."""
    from core.deployment import DEVICE_FIELD_VISIBILITY_DEFAULTS

    out = dict(DEVICE_FIELD_VISIBILITY_DEFAULTS)
    stored = effective_ui(tenant).device_field_visibility or {}
    for key, val in stored.items():
        if key in out:
            out[key] = bool(val)
    return out


def effective_datetime(tenant):
    """The object whose date/time display defaults apply.

    Its own override group (like separation and the popover): flipping the
    date format must not force a tenant to fork the whole UI-policy group.
    Carries ``date_format`` / ``time_style`` / ``display_timezone``. Per-user
    overrides sit ON TOP of this - see ``auth_api.user_prefs.datetime_prefs``.
    """
    ts = _tenant_row(tenant)
    if ts is not None and ts.override_datetime:
        return ts
    return _deployment()


def effective_datetime_values(tenant) -> dict:
    """The tenant-effective date/time display settings, fully resolved:
    ``{"date_format", "time_style", "timezone"}`` where a blank stored
    timezone falls back to the server's ``TIME_ZONE``."""
    from django.conf import settings

    row = effective_datetime(tenant)
    return {
        "date_format": row.date_format,
        "time_style": row.time_style,
        "timezone": row.display_timezone or settings.TIME_ZONE,
    }


def effective_floorplan_row(tenant):
    """The object whose floor-plan popover config applies.

    Its own override group, NOT ``override_ui`` - that one also governs
    device-field visibility and human IDs, and a tenant shouldn't have to
    override those just to change what a tile popover shows.
    """
    ts = _tenant_row(tenant)
    if ts is not None and ts.override_floorplan_popover:
        return ts
    return _deployment()


def effective_floorplan_popover(tenant) -> dict:
    """The floor-plan tile popover config for this tenant.

    ``{"fields": [...], "tile_overrides": {scope: [...]}}`` - the global ordered
    field list plus per-scope lists, where a scope is ``tt:<tile-type-slug>`` or
    ``role:<device-role-slug>``. A scope that is ABSENT inherits ``fields``; only
    genuinely-different types store their own list. (Our netbox-map plugin
    instead seeds a copy of the global list onto every tile type, which then
    drifts silently as the global changes - inheritance avoids that whole class
    of bug.)

    Unknown keys are dropped on read as well as write, so a field removed from
    the registry - or a custom field the tenant deleted - can never reach the
    client.
    """
    from core.deployment import (
        FLOORPLAN_POPOVER_FIELD_DEFAULTS,
        clean_popover_fields,
        clean_popover_overrides,
    )

    row = effective_floorplan_row(tenant)
    return {
        "fields": clean_popover_fields(row.floorplan_popover_fields)
        or list(FLOORPLAN_POPOVER_FIELD_DEFAULTS),
        "tile_overrides": clean_popover_overrides(
            row.floorplan_popover_tile_overrides
        ),
    }


def effective_topology_card_row(tenant):
    """The object whose topology card-line config applies - its own override
    group, like the floor-plan popover."""
    ts = _tenant_row(tenant)
    if ts is not None and ts.override_topology_card:
        return ts
    return _deployment()


def effective_topology_card(tenant) -> dict:
    """The topology card-line config for this tenant.

    ``{"fields": [...], "role_overrides": {"role:<slug>": [...]},
    "source": "tenant"|"deployment"|"default"}``. ``source`` names where
    ``fields`` came from: ``default`` when the effective row stores no list.
    A tenant override replaces the deployment's global AND per-role lists
    wholesale (the floor-plan precedent). ``[]`` means name only at every
    level; unknown keys are dropped on read.
    """
    from core.deployment import (
        TOPOLOGY_CARD_FIELD_DEFAULTS,
        clean_topology_card_overrides,
        topology_card_list,
    )
    from core.models import TenantSettings

    row = effective_topology_card_row(tenant)
    fields = topology_card_list(row.topology_card_fields)
    if fields is None:
        fields, source = list(TOPOLOGY_CARD_FIELD_DEFAULTS), "default"
    else:
        source = "tenant" if isinstance(row, TenantSettings) else "deployment"
    return {
        "fields": fields,
        "role_overrides": clean_topology_card_overrides(
            row.topology_card_role_overrides
        ),
        "source": source,
    }


def resolve_card_fields(device, eff, view_fields=None) -> tuple[list, str]:
    """The card lines one device shows, and the level that chose them.

    First hit wins: the device's own ``topology_card`` → the saved view's
    ``view_fields`` → the device role's list in ``eff["role_overrides"]`` →
    ``eff["fields"]`` (tenant or deployment global, else the built-in
    default). A list replaces rather than merges, and ``[]`` (name only) is a
    hit. ``eff`` is :func:`effective_topology_card`, computed once per request;
    load ``device.role`` with the device to keep this query-free.

    Returns ``(fields, source)`` with ``source`` one of ``device``, ``view``,
    ``role``, ``tenant``, ``deployment`` or ``default``.
    """
    from core.deployment import topology_card_list

    own = topology_card_list(getattr(device, "topology_card", None))
    if own is not None:
        return own, "device"
    view = topology_card_list(view_fields)
    if view is not None:
        return view, "view"
    if getattr(device, "role_id", None) is not None:
        scoped = eff["role_overrides"].get(f"role:{device.role.slug}")
        if scoped is not None:
            return list(scoped), "role"
    return list(eff["fields"]), eff["source"]


# ─── LDAP directory selection (login-time; no active tenant yet) ────────────
def ldap_directory_chain(username: str):
    """Ordered login candidates: ``[(config, owner_tenant, search_username)]``.

    1. ``user@domain`` whose domain matches a tenant's ``ldap_login_domains``
       (override_ldap + ldap_enabled + server URI set) → ONLY that tenant's
       directory, searched as the local part. The Django username keeps the
       full ``user@domain`` form (collision-proof against bare names).
    2. Otherwise: the deployment directory first (when enabled + configured),
       then every overriding tenant directory ordered by tenant slug
       (deterministic). First successful bind wins; failures fall through to
       Django's ModelBackend for local accounts, as before.
    """
    from core.models import TenantSettings

    username = (username or "").strip()
    chain: list[tuple[object, object | None, str]] = []

    overriding = list(
        TenantSettings.objects.filter(
            override_ldap=True, ldap_enabled=True
        ).exclude(ldap_server_uri="").select_related("tenant").order_by("tenant__slug")
    )

    if "@" in username:
        local, _, domain = username.rpartition("@")
        domain = domain.lower()
        if local:
            for ts in overriding:
                domains = [str(d).lower().lstrip("@") for d in (ts.ldap_login_domains or [])]
                if domain in domains:
                    return [(ts, ts.tenant, local)]

    dep = _deployment()
    if dep.ldap_enabled and dep.ldap_server_uri:
        chain.append((dep, None, username))
    for ts in overriding:
        chain.append((ts, ts.tenant, username))
    return chain
