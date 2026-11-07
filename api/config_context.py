"""Config-context resolution.

A device/VM's *rendered config context* is the deep-merge of every active
ConfigContext whose criteria match it, applied in (weight, name) order so the
highest-weight context wins on conflicting keys. Empty criteria for a dimension
match everything; a dimension with members matches when the object has any of
them (OR within a dimension, AND across dimensions). Tags are one more such
dimension: the object matches when it carries any of the context's tags.

The object's own ``local_context_data`` is merged after every context, so it
wins over all of them whatever their weight.
"""
from __future__ import annotations

import copy

from django.core.exceptions import ValidationError

#: The source label the rendered view gives an object's own data.
LOCAL_SOURCE_NAME = "Local context data"


def validate_context_object(value):
    """Context data is a JSON object (``None``/empty is no data)."""
    if value is not None and not isinstance(value, dict):
        raise ValidationError("Context data must be a JSON object.")


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


def _matches(ctx, *, site, region_pks, role_id, platform_id, tag_pks) -> bool:
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
    ctx_tags = {t.pk for t in ctx.tags.all()}
    if ctx_tags and not (ctx_tags & tag_pks):
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


def _tag_pks(obj) -> set:
    if getattr(obj, "pk", None) is None or not hasattr(obj, "tags"):
        return set()
    from core.tags import tags_of

    return {t.pk for t in tags_of(obj)}


def render_config_context(obj):
    """Return the rendered context of a device/VM::

        {"rendered": {...}, "applied": [context names],
         "sources": [{"kind": "context", "id", "name", "weight"}, ...,
                     {"kind": "local", "name": "Local context data"}]}

    ``applied`` lists the matching contexts in merge order; ``sources`` is the
    same plus the object's own data last, when it has any. ``obj`` must have
    ``tenant_id``, ``site``, ``role_id`` and ``platform_id``.
    """
    from .models import ConfigContext

    site = getattr(obj, "site", None)
    region = getattr(site, "region", None) if site else None
    region_pks = _region_chain(region) if region else set()
    tag_pks = _tag_pks(obj)

    contexts = (
        ConfigContext.objects.filter(tenant_id=obj.tenant_id, is_active=True)
        .prefetch_related("sites", "device_roles", "platforms", "regions", "tags")
        .order_by("weight", "name")
    )
    rendered: dict = {}
    applied: list[str] = []
    sources: list[dict] = []
    for ctx in contexts:
        if _matches(
            ctx,
            site=site,
            region_pks=region_pks,
            role_id=getattr(obj, "role_id", None),
            platform_id=getattr(obj, "platform_id", None),
            tag_pks=tag_pks,
        ):
            rendered = _deep_merge(rendered, ctx.data or {})
            applied.append(ctx.name)
            sources.append({
                "kind": "context", "id": str(ctx.pk), "name": ctx.name,
                "weight": ctx.weight,
            })
    local = getattr(obj, "local_context_data", None)
    if isinstance(local, dict) and local:
        rendered = _deep_merge(rendered, local)
        sources.append({"kind": "local", "name": LOCAL_SOURCE_NAME})
    return {"rendered": rendered, "applied": applied, "sources": sources}
