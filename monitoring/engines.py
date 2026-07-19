"""Resolve *which* monitoring engine runs a check for a given target.

Resolution order, most-specific first — each level inherits from the next when
it has no binding of its own:

    1. the target IP's device **Location**, then walking up its **parent
       locations** (a child set to "inherit" falls through to its parent)
    2. the target IP's **Prefix** binding, when it belongs to a subnet
    3. the target IP's **Site** (direct ``IPAddress.site`` or its prefix's site)
    4. the tenant's **default engine** (``MonitoringSettings.default_engine``)
    5. the tenant's built-in **local** engine (always exists)

Bindings live on the monitoring side (``MonitoringEngineBinding`` — scope +
object_id) so ``api`` never depends on ``monitoring``.
"""
from __future__ import annotations

from .models import (
    MonitoringEngine,
    MonitoringEngineBinding,
    MonitoringSettings,
)


def _binding_engine(tenant, scope, object_id):
    if not object_id:
        return None
    b = (
        MonitoringEngineBinding.objects.filter(
            tenant=tenant, scope=scope, object_id=object_id
        )
        .select_related("engine")
        .first()
    )
    return b.engine if b and b.engine.enabled else None


def _location_chain_engine(tenant, location_id):
    """Walk the location and its ancestors, returning the first bound engine —
    so a child location set to inherit falls through to its parent."""
    if not location_id:
        return None
    from api.models import Location

    seen = set()
    cur = Location.objects.filter(id=location_id).only("id", "parent_id").first()
    while cur is not None and cur.id not in seen and len(seen) < 32:
        seen.add(cur.id)
        engine = _binding_engine(
            tenant, MonitoringEngineBinding.SCOPE_LOCATION, cur.id
        )
        if engine is not None:
            return engine
        cur = (
            Location.objects.filter(id=cur.parent_id)
            .only("id", "parent_id")
            .first()
            if cur.parent_id
            else None
        )
    return None


def engine_for_ip(ip) -> MonitoringEngine:
    """The engine responsible for an ``IPAddress`` (never None — falls back to
    the tenant's local engine)."""
    tenant = ip.tenant
    dev = getattr(ip, "assigned_device", None)

    engine = _location_chain_engine(tenant, dev.location_id if dev else None)
    if engine is None:
        engine = _binding_engine(
            tenant,
            MonitoringEngineBinding.SCOPE_PREFIX,
            ip.prefix_id,
        )
    if engine is None:
        site_id = ip.site_id or (ip.prefix.site_id if ip.prefix_id else None)
        engine = _binding_engine(tenant, MonitoringEngineBinding.SCOPE_SITE, site_id)
    if engine is None:
        default_id = MonitoringSettings.for_tenant(tenant).default_engine_id
        if default_id:
            engine = MonitoringEngine.objects.filter(
                id=default_id, enabled=True
            ).first()
    return engine or MonitoringEngine.local_for(tenant)


def engine_for_prefix(prefix) -> MonitoringEngine:
    """The engine responsible for a **prefix** (never None) — resolved via its
    prefix binding, then site binding, then the tenant default, then local. Used
    to decide which Outpost sweeps a subnet for discovery."""
    tenant = prefix.tenant
    engine = _binding_engine(tenant, MonitoringEngineBinding.SCOPE_PREFIX, prefix.id)
    if engine is None:
        engine = _binding_engine(
            tenant, MonitoringEngineBinding.SCOPE_SITE, prefix.site_id
        )
    if engine is None:
        default_id = MonitoringSettings.for_tenant(tenant).default_engine_id
        if default_id:
            engine = MonitoringEngine.objects.filter(
                id=default_id, enabled=True
            ).first()
    return engine or MonitoringEngine.local_for(tenant)


def engine_for_device(device) -> MonitoringEngine:
    """The engine responsible for a **device** (never None). Same resolution as
    ``engine_for_ip`` but keyed off the device's own location/site — used to
    decide which Outpost runs a device's SNMP discovery."""
    tenant = device.tenant
    engine = _location_chain_engine(tenant, device.location_id)
    if engine is None:
        engine = _binding_engine(
            tenant, MonitoringEngineBinding.SCOPE_SITE, device.site_id
        )
    if engine is None:
        default_id = MonitoringSettings.for_tenant(tenant).default_engine_id
        if default_id:
            engine = MonitoringEngine.objects.filter(
                id=default_id, enabled=True
            ).first()
    return engine or MonitoringEngine.local_for(tenant)


def _location_subtree_ids(tenant, location_ids):
    """All location ids at or under ``location_ids`` (a child inherits a binding
    set on a parent). Adjacency-list BFS — one query per depth, cheap for the
    few levels a location tree has."""
    from api.models import Location

    ids = set(location_ids)
    frontier = list(location_ids)
    while frontier:
        children = list(
            Location.objects.filter(tenant=tenant, parent_id__in=frontier)
            .exclude(id__in=ids)
            .values_list("id", flat=True)
        )
        if not children:
            break
        ids.update(children)
        frontier = children
    return ids


def devices_for_engine(engine):
    """The tenant's devices whose resolved engine is ``engine`` — the candidates
    an Outpost should SNMP-poll. Narrowed to the engine's bound sites +
    location-subtrees, then each confirmed with ``engine_for_device`` (a nested,
    more-specific binding could steal a device back to another engine)."""
    from django.db.models import Q

    from api.models import Device

    tenant = engine.tenant
    bindings = list(
        MonitoringEngineBinding.objects.filter(tenant=tenant, engine=engine)
    )
    site_ids = [b.object_id for b in bindings if b.scope == MonitoringEngineBinding.SCOPE_SITE]
    loc_ids = [b.object_id for b in bindings if b.scope == MonitoringEngineBinding.SCOPE_LOCATION]
    if not site_ids and not loc_ids:
        return []
    all_loc_ids = _location_subtree_ids(tenant, loc_ids) if loc_ids else set()
    candidates = Device.objects.filter(tenant=tenant).filter(
        Q(site_id__in=site_ids) | Q(location_id__in=all_loc_ids)
    ).select_related("primary_ip")
    return [d for d in candidates if engine_for_device(d).id == engine.id]


def set_binding(tenant, scope, object_id, engine):
    """Assign (or clear, when ``engine`` is None) an engine for a site/location.
    Used by the site/location forms. Returns the binding or None."""
    if engine is None:
        MonitoringEngineBinding.objects.filter(
            tenant=tenant, scope=scope, object_id=object_id
        ).delete()
        return None
    obj, _ = MonitoringEngineBinding.objects.update_or_create(
        tenant=tenant, scope=scope, object_id=object_id,
        defaults={"engine": engine},
    )
    return obj


def binding_engine_id(tenant, scope, object_id):
    """The engine id bound to a site/location, or None — for the form to prefill."""
    b = MonitoringEngineBinding.objects.filter(
        tenant=tenant, scope=scope, object_id=object_id
    ).first()
    return str(b.engine_id) if b else None
