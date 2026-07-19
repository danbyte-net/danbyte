"""RBAC resolution engine — turns a user's ObjectPermissions into effective
actions + queryset constraints, scoped to the active tenant.

Grants only: a user's effective actions for an object type are
the union across every enabled permission assigned to them or one of their
groups that applies in the active tenant. ``constraints`` then limit which rows
— multiple applicable permissions OR together. Superusers bypass everything.
"""
from __future__ import annotations

import logging

from django.core.exceptions import FieldError
from django.db.models import Q

log = logging.getLogger(__name__)


def _is_super(user) -> bool:
    return bool(getattr(user, "is_authenticated", False) and user.is_superuser)


def applicable_permissions(user, tenant):
    """Enabled ObjectPermissions that apply to ``user`` in ``tenant``.

    A permission applies if assigned to the user directly or via one of their
    groups, and either it's tenant-unscoped or the active tenant is in its set.
    """
    from .models import ObjectPermission

    if not getattr(user, "is_authenticated", False):
        return ObjectPermission.objects.none()
    qs = (
        ObjectPermission.objects.filter(enabled=True)
        .filter(Q(users=user) | Q(groups__in=user.groups.all()))
        .prefetch_related("tenants", "sites")
        .distinct()
    )
    out = []
    for perm in qs:
        scoped = perm.tenants.all()
        if scoped and (tenant is None or tenant.pk not in {t.pk for t in scoped}):
            continue
        out.append(perm)
    return out


def effective_actions(user, tenant) -> dict[str, set[str]]:
    """``{object_type_slug: {actions}}`` granted to the user in this tenant.

    ``object_types`` may contain the wildcard ``"*"`` meaning "every registered
    type" — the built-in Administrator/Operator/Read-only groups use it so new
    object types are covered automatically.
    """
    from .object_types import ACTIONS, registry_payload

    all_slugs = [e["slug"] for e in registry_payload()]
    if _is_super(user):
        return {slug: set(ACTIONS) for slug in all_slugs}
    out: dict[str, set[str]] = {}
    for perm in applicable_permissions(user, tenant):
        acts = {a for a in (perm.actions or []) if a in ACTIONS}
        types = perm.object_types or []
        slugs = all_slugs if "*" in types else [t for t in types if t in all_slugs]
        for slug in slugs:
            out.setdefault(slug, set()).update(acts)
    return out


def has_action(user, tenant, slug: str, action: str) -> bool:
    if _is_super(user):
        return True
    return action in effective_actions(user, tenant).get(slug, set())


def constraints_for(user, tenant, slug: str, action: str):
    """Constraint dicts for (slug, action), or ``None`` if not granted at all.

    Returns:
      * ``None``  — the action isn't granted → deny.
      * ``[]``    — granted with no constraints → all rows.
      * ``[{…}]`` — granted; rows matching ANY dict (OR).
    """
    if _is_super(user):
        return []
    granted = False
    dicts: list[dict] = []
    for perm in applicable_permissions(user, tenant):
        types = perm.object_types or []
        if slug not in types and "*" not in types:
            continue
        if action not in (perm.actions or []):
            continue
        granted = True
        c = perm.constraints
        if not c:
            return []  # an unconstrained grant wins → all rows
        if isinstance(c, dict):
            dicts.append(c)
        elif isinstance(c, list):
            dicts.extend(d for d in c if isinstance(d, dict))
    if not granted:
        return None
    return dicts


def _granting_perms(user, tenant, slug: str, action: str):
    """Applicable permissions that grant ``(slug, action)``."""
    out = []
    for perm in applicable_permissions(user, tenant):
        types = perm.object_types or []
        if slug not in types and "*" not in types:
            continue
        if action not in (perm.actions or []):
            continue
        out.append(perm)
    return out


def _perm_q(perm, site_path, action="view") -> Q:
    """Row filter for one granting permission: its ``constraints`` (OR of dicts)
    AND'd with its ``sites`` scope. An empty ``Q()`` means "all rows" (the
    permission is both unconstrained and unscoped).

    NULL-site rule: site FKs are nullable on several scoped types (VLAN,
    Prefix, IPAddress) where NULL means "shared / not tied to one site". A
    site-scoped grant can *view* those shared rows — they're context everyone
    needs — but can never write them (add/change/delete stay strictly
    ``site __in`` scope; shared rows are HQ's to manage). Skipped for the
    ``site`` slug itself, whose path is ``id`` and never NULL.
    """
    c = perm.constraints
    if not c:
        q = Q()
    elif isinstance(c, dict):
        q = Q(**c)
    elif isinstance(c, list):
        q = Q()
        for d in c:
            if isinstance(d, dict):
                q |= Q(**d)
    else:
        q = Q()
    # Site scope: only narrows types that have a site path; others ignore it.
    if site_path:
        site_ids = [s.pk for s in perm.sites.all()]
        if site_ids:
            scope_q = Q(**{f"{site_path}__in": site_ids})
            if action == "view" and site_path != "id":
                scope_q |= Q(**{f"{site_path}__isnull": True})
            q = q & scope_q
    return q


def restrict_queryset(qs, user, tenant, slug: str, action: str):
    """Filter ``qs`` to the rows the user may act on. Tenant scoping is applied
    separately (by the viewset); this adds, per granting permission, its row
    ``constraints`` AND its ``sites`` scope — OR'd across permissions. A single
    unconstrained + unscoped grant opens every row."""
    if _is_super(user):
        return qs
    perms = _granting_perms(user, tenant, slug, action)
    if not perms:
        return qs.none()  # not granted at all
    from .site_paths import site_path_for

    site_path = site_path_for(slug, tenant)
    big_q = Q()
    for perm in perms:
        pq = _perm_q(perm, site_path, action)
        if not pq:
            return qs  # an unconstrained, unscoped grant opens everything
        big_q |= pq
    try:
        return qs.filter(big_q)
    except FieldError:
        # A malformed constraint/site path shouldn't leak data — deny.
        log.warning("RBAC: bad constraint/site on %s/%s", slug, action)
        return qs.none()


def row_filter(user, tenant, slug: str, action: str):
    """Per-object access decision for ``(slug, action)``, cacheable per request.

    Returns ``None`` (not granted → deny), ``True`` (all rows → allow), or a
    ``Q`` to test a single row against. Site- *and* constraint-aware — the
    per-object companion to :func:`restrict_queryset`, so the UI Edit/Delete flag
    matches what the queryset (and the write guard) actually enforce.
    """
    if _is_super(user):
        return True
    perms = _granting_perms(user, tenant, slug, action)
    if not perms:
        return None
    from .site_paths import site_path_for

    site_path = site_path_for(slug, tenant)
    big_q = Q()
    for perm in perms:
        pq = _perm_q(perm, site_path, action)
        if not pq:
            return True  # an unconstrained, unscoped grant → all rows
        big_q |= pq
    return big_q


def site_scope(user, tenant, slug: str, action: str):
    """The set of site ids the user is restricted to for ``(slug, action)``.

    * ``None``  — unrestricted (superuser, type has no site, or at least one
                  granting permission is site-unscoped).
    * ``set()`` — not granted at all.
    * ``{ids}`` — every granting permission is site-scoped; the union of sites.
    """
    if _is_super(user):
        return None
    from .site_paths import site_path_for

    if site_path_for(slug, tenant) is None:
        return None
    perms = _granting_perms(user, tenant, slug, action)
    if not perms:
        return set()
    ids: set = set()
    for perm in perms:
        sids = {s.pk for s in perm.sites.all()}
        if not sids:
            return None  # an unscoped grant → any site
        ids |= sids
    return ids


def editable_sites(user, tenant):
    """The set of site ids ``user`` may *edit* (is a local site-editor of).

    Aggregates :func:`site_scope` for the ``change`` action across every
    site-bound object type. Returns:

    * ``None``  — may edit any site (superuser, or an unscoped change grant on
                  some site-bound type).
    * ``set()`` — edits no site (no change grant anywhere).
    * ``{ids}`` — every change grant is site-scoped; the union of those sites.

    Used to gate delegated invites: a site editor may only invite viewers to
    sites in this set.
    """
    if _is_super(user):
        return None
    from .site_paths import SITE_PATHS

    ids: set = set()
    granted = False
    for slug in SITE_PATHS:
        # "site" scopes itself; "sitesettings" is the settings-admin surface —
        # holding it must not make someone an infrastructure editor (with the
        # delegation and create-defaulting powers that implies).
        if slug in ("site", "sitesettings"):
            continue
        scope = site_scope(user, tenant, slug, "change")
        if scope is None:
            return None  # an unscoped change grant → any site
        if scope:
            granted = True
            ids |= scope
    return ids if granted else set()


def object_matches_constraints(obj, cons) -> bool:
    """Whether ``obj`` satisfies a non-empty OR-of-dicts constraint set.

    ``cons`` is the list of dicts returned by :func:`constraints_for` for the
    *constrained* case (caller has already handled ``None`` / ``[]``). One
    indexed ``pk`` lookup; a malformed constraint denies rather than opens.
    """
    q = Q()
    for d in cons:
        q |= Q(**d)
    try:
        return type(obj)._default_manager.filter(pk=obj.pk).filter(q).exists()
    except (FieldError, ValueError, TypeError):
        log.warning("RBAC: bad constraint evaluating object access: %r", cons)
        return False


def can_act_on(user, tenant, slug: str, action: str, obj) -> bool:
    """Whether ``user`` may perform ``action`` on this *specific* ``obj``.

    Site- *and* constraint-aware — delegates to :func:`row_filter` so it
    enforces the exact same scope as ``restrict_queryset`` (an
    ``ObjectPermission`` narrowed by ``sites`` returns ``False`` for an object
    at another site, not just for a constraint mismatch). Cheap in the common
    cases — superuser, ungranted, and fully-open grants never touch the DB;
    only a scoped grant runs a single ``pk`` lookup.
    """
    if _is_super(user):
        return True
    q = row_filter(user, tenant, slug, action)
    if q is None:
        return False  # not granted
    if q is True:
        return True  # granted, no row/site scope
    return type(obj)._default_manager.filter(q, pk=obj.pk).exists()
