"""LDAP / Active Directory authentication — optional and DB-driven.

Configuration lives on :class:`core.models.DeploymentSettings` (the admin UI),
not Django settings, so it changes at runtime without a redeploy. The directory
backend is only built when ``ldap_enabled`` is on, and ``python-ldap`` /
``django-auth-ldap`` are imported lazily so the rest of the app runs whether or
not they're installed.

Group membership is **explicitly mapped**: on each login a user's Danbyte groups
are re-synced from the directory groups they belong to, via
:class:`auth_api.models.LDAPGroupMapping` (each → an ``auth.Group`` carrying
ObjectPermissions). Only mapped directory groups grant anything — the directory
can't accidentally widen access.
"""
from __future__ import annotations

import logging

from django.contrib.auth.backends import ModelBackend

logger = logging.getLogger("danbyte.ldap")


def ldap_available() -> bool:
    """True when the optional native deps are importable."""
    try:
        import ldap  # noqa: F401
        import django_auth_ldap  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


# ─── pure, testable group mapping ────────────────────────────────────────────
def group_is_tenant_safe(group, tenant) -> bool:
    """May a *tenant-scoped* mapping grant ``group``? Only when every enabled
    ObjectPermission attached to the group is tenant-narrowed to exactly that
    tenant (non-empty ``tenants`` ⊆ {tenant}). Stops a tenant admin mapping a
    directory group onto e.g. the built-in Administrator group (whose
    permissions are tenant-unscoped) and minting deployment admins."""
    perms = group.object_permissions.filter(enabled=True).prefetch_related("tenants")
    for perm in perms:
        scoped = list(perm.tenants.all())
        if not scoped or any(t.pk != tenant.pk for t in scoped):
            return False
    return True


def danbyte_groups_for_dns(group_dns, tenant=None):
    """The Danbyte ``auth.Group``s mapped from a set of directory group DNs.

    ``tenant=None`` → deployment-directory mappings only (tenant IS NULL);
    a tenant → that tenant's own mappings, each re-checked against
    :func:`group_is_tenant_safe` at sync time so a later widening of a group's
    permissions can't be laundered through an old mapping. DN comparison is
    case-insensitive (AD DNs are). Returns a queryset.
    """
    from django.contrib.auth.models import Group

    from .models import LDAPGroupMapping

    wanted = {(d or "").strip().lower() for d in (group_dns or ()) if d}
    if not wanted:
        return Group.objects.none()
    mappings = LDAPGroupMapping.objects.filter(
        tenant__isnull=True if tenant is None else False,
        **({} if tenant is None else {"tenant": tenant}),
    ).select_related("group")
    ids = []
    for m in mappings:
        if m.ldap_group_dn.strip().lower() not in wanted:
            continue
        if tenant is not None and not group_is_tenant_safe(m.group, tenant):
            logger.warning(
                "LDAP: skipping mapping %r for tenant %s — group %r carries "
                "permissions not narrowed to this tenant",
                m.ldap_group_dn, tenant.slug, m.group.name,
            )
            continue
        ids.append(m.group_id)
    return Group.objects.filter(id__in=ids)


def sync_user_groups(user, group_dns, tenant=None) -> None:
    """Replace the user's Danbyte group membership with the mapped set."""
    user.groups.set(list(danbyte_groups_for_dns(group_dns, tenant=tenant)))


def mark_ldap_user(user, source_tenant=None) -> None:
    """Stamp the account's auth source and (for tenant directories) which
    tenant's directory owns it — the anchor the bind guards check."""
    from .models import UserProfile

    prof, _ = UserProfile.objects.get_or_create(user=user)
    updates = []
    if prof.auth_source != "ldap":
        prof.auth_source = "ldap"
        updates.append("auth_source")
    want_id = source_tenant.pk if source_tenant is not None else None
    if prof.ldap_source_tenant_id != want_id:
        prof.ldap_source_tenant_id = want_id
        updates.append("ldap_source_tenant")
    if updates:
        prof.save(update_fields=updates)


def assert_public_ldap_uri(cfg) -> None:
    """SSRF-guard a per-tenant directory URI (TenantSettings). Deployment
    directories are operator-trusted and skipped. Raises SSRFError on an
    internal/metadata/loopback host so a tenant admin can't turn the LDAP bind
    into an internal port scanner."""
    from urllib.parse import urlparse

    from core.models import TenantSettings

    if not isinstance(cfg, TenantSettings):
        return
    uri = cfg.ldap_server_uri or ""
    parsed = urlparse(uri)
    host = parsed.hostname
    if not host:
        return  # empty URI — the backend build will no-op anyway
    port = parsed.port or (636 if parsed.scheme == "ldaps" else 389)
    from core.ssrf import assert_public_host

    assert_public_host(host, port)


def _grant_tenant_membership(user, tenant) -> None:
    """A successful tenant-directory login grants access to THAT tenant only."""
    from .models import UserProfile

    prof, _ = UserProfile.objects.get_or_create(user=user)
    prof.tenants.add(tenant)
    if prof.current_tenant_id is None:
        prof.current_tenant = tenant
        prof.save(update_fields=["current_tenant"])


def _existing_owner(username: str):
    """(user, profile) for an existing account with this username, or (None,
    None). Case-insensitive, matching django-auth-ldap's default behavior."""
    from django.contrib.auth import get_user_model

    u = get_user_model().objects.filter(username__iexact=username).first()
    return (u, getattr(u, "profile", None)) if u else (None, None)


def _candidate_may_bind(final_username: str, owner_tenant) -> bool:
    """Pre-bind ownership guard — evaluated BEFORE any directory I/O.

    A tenant directory may only match an account it owns (auth_source="ldap"
    and ldap_source_tenant == that tenant) or a username that doesn't exist yet
    — so a tenant-configured (possibly malicious) directory can never
    authenticate as a local user, a deployment-LDAP user, or another tenant's
    user. The deployment directory keeps its historical semantics (it may adopt
    a local account) but refuses accounts owned by a tenant directory."""
    user, prof = _existing_owner(final_username)
    if user is None:
        return True
    src_tenant_id = getattr(prof, "ldap_source_tenant_id", None)
    if owner_tenant is None:
        return src_tenant_id is None
    return (
        prof is not None
        and prof.auth_source == "ldap"
        and src_tenant_id == owner_tenant.pk
    )


def _post_bind_ok(user, owner_tenant) -> bool:
    """Defense-in-depth re-check on the row the directory actually bound —
    catches the backend producing a different username than predicted. Profiles
    are created lazily (no signals), so a user with NO profile is a fresh
    account created by this very bind (OK — it gets stamped right after);
    otherwise the same ownership rules as the pre-bind guard apply."""
    prof = getattr(user, "profile", None)
    if prof is None:
        return True
    src_tenant_id = prof.ldap_source_tenant_id
    if owner_tenant is None:
        return src_tenant_id is None
    return prof.auth_source == "ldap" and src_tenant_id == owner_tenant.pk


# ─── django-auth-ldap wiring (lazy) ──────────────────────────────────────────
def _configured_backend(dep, django_username_map=None):
    """A django-auth-ldap backend configured from a settings object — the
    DeploymentSettings singleton or a TenantSettings row (mirrored field names)
    — or None if the deps are missing. ``django_username_map`` optionally
    rewrites the LDAP login name into the stored Django username (domain-routed
    tenant logins keep the full ``user@domain`` form)."""
    try:
        import ldap
        from django_auth_ldap.backend import LDAPBackend
        from django_auth_ldap.config import (
            GroupOfNamesType,
            LDAPSearch,
            NestedActiveDirectoryGroupType,
            PosixGroupType,
        )
    except Exception:  # noqa: BLE001
        logger.warning("LDAP enabled but python-ldap/django-auth-ldap unavailable")
        return None

    # A tenant admin (untrusted) controls a per-tenant directory URI — SSRF-guard
    # it so the bind can't reach internal services / cloud metadata. Deployment
    # directories are set by a trusted operator (may be internal on-prem), so
    # they're exempt (allowlist via DANBYTE_SSRF_ALLOWLIST if needed).
    assert_public_ldap_uri(dep)

    backend = LDAPBackend()
    s = backend.settings  # built from (empty) AUTH_LDAP_* defaults; we override
    s.SERVER_URI = dep.ldap_server_uri
    s.BIND_DN = dep.ldap_bind_dn
    s.BIND_PASSWORD = (dep.secrets or {}).get("ldap_bind_password", "")
    s.USER_SEARCH = LDAPSearch(
        dep.ldap_user_search_base,
        ldap.SCOPE_SUBTREE,
        dep.ldap_user_search_filter or "(sAMAccountName=%(user)s)",
    )
    if dep.ldap_group_search_base:
        s.GROUP_SEARCH = LDAPSearch(
            dep.ldap_group_search_base, ldap.SCOPE_SUBTREE, "(objectClass=*)"
        )
        s.GROUP_TYPE = {
            "ad": NestedActiveDirectoryGroupType,
            "group_of_names": GroupOfNamesType,
            "posix": PosixGroupType,
        }.get(dep.ldap_group_type, NestedActiveDirectoryGroupType)()
    s.USER_ATTR_MAP = {
        "first_name": dep.ldap_attr_first_name or "givenName",
        "last_name": dep.ldap_attr_last_name or "sn",
        "email": dep.ldap_attr_email or "mail",
    }
    s.ALWAYS_UPDATE_USER = True
    s.MIRROR_GROUPS = False  # we map explicitly, not by name
    s.FIND_GROUP_PERMS = False
    s.CACHE_TIMEOUT = 0
    # OPT_REFERRALS=0 is required for Active Directory: a subtree search on a
    # domain base (DC=…) returns referrals which python-ldap otherwise chases
    # with an anonymous bind — AD rejects that and the whole authenticate()
    # fails even though the user's own bind succeeded. The admin test/browse
    # endpoints already did this; the auth path was missing it (issue #152).
    opts: dict = {
        ldap.OPT_REFERRALS: 0,
        ldap.OPT_PROTOCOL_VERSION: 3,
    }
    if dep.ldap_ignore_cert:
        opts[ldap.OPT_X_TLS_REQUIRE_CERT] = ldap.OPT_X_TLS_NEVER
        opts[ldap.OPT_X_TLS_NEWCTX] = 0
    s.CONNECTION_OPTIONS = opts
    s.START_TLS = bool(dep.ldap_start_tls)
    if dep.ldap_require_group:
        s.REQUIRE_GROUP = dep.ldap_require_group
    if django_username_map is not None:
        # Instance attribute shadows the method; django-auth-ldap calls
        # backend.ldap_to_django_username(name) to pick the stored username.
        backend.ldap_to_django_username = django_username_map
    return backend


class DanbyteLDAPBackend(ModelBackend):
    """Façade backend listed in ``AUTHENTICATION_BACKENDS``.

    When LDAP is enabled it delegates authentication to a freshly configured
    django-auth-ldap backend, then re-syncs the user's Danbyte groups from the
    directory. When disabled (or the deps are missing) ``authenticate`` returns
    ``None`` so the next backend (``ModelBackend`` for local accounts) runs.

    It extends ``ModelBackend`` only to inherit ``get_user`` (session reload);
    authorization is RBAC's job, not Django model perms.
    """

    def authenticate(self, request, username=None, password=None, **kwargs):
        if not username or not password:
            return None
        from core.effective_settings import ldap_directory_chain

        try:
            chain = ldap_directory_chain(username)
        except Exception:  # noqa: BLE001
            logger.exception("LDAP directory chain resolution failed")
            return None

        for cfg, owner_tenant, search_name in chain:
            # Domain-routed logins store the full user@domain Django username
            # (collision-proof); plain logins keep the name as typed.
            domain_routed = search_name != username
            final_username = username if domain_routed else search_name
            username_map = (
                (lambda _n, _final=final_username: _final) if domain_routed else None
            )

            # Ownership guard BEFORE any directory I/O — a tenant-configured
            # directory must never bind an account it doesn't own.
            if not _candidate_may_bind(final_username, owner_tenant):
                logger.warning(
                    "LDAP: %s directory refused for existing account %r "
                    "(ownership mismatch)",
                    owner_tenant.slug if owner_tenant else "deployment",
                    final_username,
                )
                continue

            backend = _configured_backend(cfg, django_username_map=username_map)
            if backend is None:
                return None  # deps missing — no point trying further
            try:
                user = backend.authenticate(
                    request, username=search_name, password=password
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "LDAP authentication error (%s directory)",
                    owner_tenant.slug if owner_tenant else "deployment",
                )
                continue
            if user is None:
                continue
            # Defense in depth: re-check ownership on the row actually bound.
            if not _post_bind_ok(user, owner_tenant):
                logger.warning(
                    "LDAP: post-bind ownership mismatch for %r — rejected",
                    user.get_username(),
                )
                return None
            try:
                mark_ldap_user(user, owner_tenant)
                if owner_tenant is not None:
                    _grant_tenant_membership(user, owner_tenant)
                group_dns = getattr(
                    getattr(user, "ldap_user", None), "group_dns", None
                )
                if group_dns is not None:
                    sync_user_groups(user, group_dns, tenant=owner_tenant)
            except Exception:  # noqa: BLE001
                logger.exception("LDAP group sync failed for %s", username)
            return user
        return None
