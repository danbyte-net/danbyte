"""Resolve an instance's Site id for the change-log / journal ``object_site_id``.

Captured at write time so row/site RBAC on the audit trail keeps working after
the underlying object is deleted (a DELETE entry outlives its row, so its site
can't be re-derived later). Uses the same ``site_paths`` map the RBAC engine
uses, so "what site is this row in?" has one definition across the codebase.
"""
from __future__ import annotations

import uuid

# A row that IS site-bound but whose site we can't resolve (the object was
# already gone at backfill time) gets this sentinel instead of NULL. NULL means
# "genuinely shared / no site" and stays visible to site-scoped viewers; the
# sentinel is never in any real site scope, so those rows fail closed (visible
# only to superusers / unscoped grants) rather than leaking as "shared".
UNKNOWN_SITE = uuid.UUID(int=0)


def entry_site_id(instance):
    """The Site pk for ``instance`` via its ``site_paths`` path, or None when
    the type has no site (global catalogs) or the path can't be resolved
    (a missing intermediate FK). Reads FK ``*_id`` columns where possible to
    avoid extra queries on the write path.

    Passes the instance's own tenant to ``site_path_for`` so catalog types that
    are only site-bound under enhanced separation resolve correctly for THAT
    tenant (a None tenant would silently treat every catalog as site-less)."""
    from auth_api.site_paths import site_path_for

    slug = instance._meta.model_name
    tenant = getattr(instance, "tenant", None)
    path = site_path_for(slug, tenant)
    if not path:
        return None
    if path == "id":  # the Site model itself
        return instance.pk
    parts = path.split("__")
    obj = instance
    # Walk intermediate FKs (e.g. device__site → obj.device), then read the
    # final FK's id column directly.
    for part in parts[:-1]:
        obj = getattr(obj, part, None)
        if obj is None:
            return None
    return getattr(obj, f"{parts[-1]}_id", None)
