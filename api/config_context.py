"""Config-context resolution.

A device/VM's *rendered config context* is the deep-merge of every active
ConfigContext whose criteria match it, applied in (weight, name) order so the
highest-weight context wins on conflicting keys. Empty criteria for a dimension
match everything.
"""
from __future__ import annotations

import copy


def _region_chain(region):
    """A region and all of its ancestors (so a context on a parent region also
    matches sites nested under it)."""
    seen = []
    node = region
    guard = 0
    while node is not None and guard < 50:
        seen.append(node.pk)
        node = node.parent
        guard += 1
    return set(seen)


def _matches(ctx, *, site, region_pks, role_id, platform_id) -> bool:
    crit = [
        (ctx.sites.all(), site.pk if site else None),
        (ctx.device_roles.all(), role_id),
        (ctx.platforms.all(), platform_id),
    ]
    for qs, value in crit:
        ids = {o.pk for o in qs}
        if ids and value not in ids:
            return False
    region_ids = {r.pk for r in ctx.regions.all()}
    if region_ids and not (region_ids & region_pks):
        return False
    return True


def _deep_merge(base: dict, overlay: dict) -> dict:
    out = dict(base)
    for k, v in (overlay or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def render_config_context(obj):
    """Return ``{"rendered": {...}, "applied": [names]}`` for a device/VM.

    ``obj`` must have ``tenant_id``, ``site``, ``role_id`` and ``platform_id``.
    """
    from .models import ConfigContext

    site = getattr(obj, "site", None)
    region = getattr(site, "region", None) if site else None
    region_pks = _region_chain(region) if region else set()

    contexts = (
        ConfigContext.objects.filter(tenant_id=obj.tenant_id, is_active=True)
        .prefetch_related("sites", "device_roles", "platforms", "regions")
        .order_by("weight", "name")
    )
    rendered: dict = {}
    applied: list[str] = []
    for ctx in contexts:
        if _matches(
            ctx,
            site=site,
            region_pks=region_pks,
            role_id=getattr(obj, "role_id", None),
            platform_id=getattr(obj, "platform_id", None),
        ):
            rendered = _deep_merge(rendered, ctx.data or {})
            applied.append(ctx.name)
    return {"rendered": rendered, "applied": applied}
