"""Resolve *which* monitoring engine runs a check for a given target.

Resolution order, most-specific first - each level inherits from the next when
it has no binding of its own:

    1. the target IP's **Device** binding
    2. the device's **Location**, then walking up its **parent locations** (a
       child set to "inherit" falls through to its parent)
    3. the target IP's **Prefix** binding, when it belongs to a subnet
    4. the target IP's **Site** (direct ``IPAddress.site`` or its prefix's site)
    5. the tenant's **default engine** (``MonitoringSettings.default_engine``)
    6. the tenant's built-in **local** engine (always exists)

``engine_for_target`` reads the same levels minus the prefix for an SNMP poll
target - a device or a virtual machine (``snmp_target.SnmpTarget``) -
``engines_for_targets`` for many at once, and ``targets_for_engine`` is its
inverse for an Outpost's SNMP work list. A VM has no binding or location of its
own, so it resolves by its site, else its cluster's site.

Bindings live on the monitoring side (``MonitoringEngineBinding`` - scope +
object_id) so ``api`` never depends on ``monitoring``.
"""
from __future__ import annotations

from django.db import models

from .engine_drivers import driver_claims_kind, engine_usable
from .models import (
    MonitoringEngine,
    MonitoringEngineBinding,
    MonitoringSettings,
)
from .snmp_target import DEVICE, KINDS, SnmpTarget
from .snmp_target import candidates as snmp_candidates

# ─── Who answered ───────────────────────────────────────────────────────
#
# Three words for where a result came from, for the UI and for filters:
# "local" (the core's own workers), "outpost" (a remote agent), or the driver
# kind ("zabbix"). Not the engine name: an estate with twelve Outposts still
# wants one "Outpost" facet.


def source_of(engine) -> str:
    """The source word for an engine, or for None - which is local."""
    if engine is None:
        return "local"
    kind = getattr(engine, "kind", "") or ""
    if kind in ("", MonitoringEngine.LOCAL):
        return "local"
    if kind == MonitoringEngine.REMOTE:
        return "outpost"
    return kind


def executing_engine(state):
    """The engine that actually runs a state's check, or None for local.

    ``CheckState.engine`` is the *binding* - the engine a target resolved to.
    A driver only answers its own kind, so a ping on a Zabbix-bound device is
    bound to Zabbix and run by the core's workers. The scheduler makes that
    call in ``_unclaimed_driver_states``; this is the same rule read the other
    way round, so a list and a scheduler never disagree about who does what.
    """
    engine = getattr(state, "engine", None)
    if engine is None or engine.kind == MonitoringEngine.LOCAL:
        return None
    if engine.kind == MonitoringEngine.REMOTE:
        return engine
    return engine if driver_claims_kind(engine, state.kind) else None


#: The same rule as an annotation, for lists and facet counts over
#: ``CheckState`` without a Python pass per row. Mirrors the scheduler's
#: prefilter: a driver claims the kind named after it and nothing else.
SOURCE_EXPR = models.Case(
    models.When(engine__isnull=True, then=models.Value("local")),
    models.When(engine__kind=MonitoringEngine.LOCAL, then=models.Value("local")),
    models.When(engine__kind=MonitoringEngine.REMOTE, then=models.Value("outpost")),
    models.When(kind=models.F("engine__kind"), then=models.F("engine__kind")),
    default=models.Value("local"),
    output_field=models.CharField(),
)

#: For ``StateTransition`` and ``CheckResult``, whose ``engine`` is the
#: executor already - null means local, and that includes every row written
#: before the column existed.
STAMPED_SOURCE_EXPR = models.Case(
    models.When(engine__isnull=True, then=models.Value("local")),
    models.When(engine__kind=MonitoringEngine.LOCAL, then=models.Value("local")),
    models.When(engine__kind=MonitoringEngine.REMOTE, then=models.Value("outpost")),
    default=models.F("engine__kind"),
    output_field=models.CharField(),
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
    # `enabled` is the operator's switch on the engine; `engine_usable` also
    # asks a driver kind whether it can answer at all. A binding to an engine
    # whose integration is switched off falls through to the next scope rather
    # than pinning the target to an engine that will never claim its checks.
    return b.engine if b and engine_usable(b.engine) else None


def _default_engine(tenant):
    """The tenant's default engine, when it is one that can actually answer.

    Same rule as a binding: a default pointing at an engine whose driver is not
    usable falls through to local, rather than parking every unbound target on
    an engine that will never claim their checks.
    """
    default_id = MonitoringSettings.for_tenant(tenant).default_engine_id
    if not default_id:
        return None
    engine = MonitoringEngine.objects.filter(id=default_id).first()
    return engine if engine is not None and engine_usable(engine) else None


def _location_chain_engine(tenant, location_id):
    """Walk the location and its ancestors, returning the first bound engine -
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
    """The engine responsible for an ``IPAddress`` (never None - falls back to
    the tenant's local engine)."""
    tenant = ip.tenant
    dev = getattr(ip, "assigned_device", None)

    # The device first: "this switch is watched by Zabbix, the rest of the
    # building is ours" has to be sayable without moving a whole site.
    engine = _binding_engine(
        tenant, MonitoringEngineBinding.SCOPE_DEVICE, dev.id if dev else None
    )
    if engine is None:
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
        engine = _default_engine(tenant)
    return engine or MonitoringEngine.local_for(tenant)


def engines_for_prefixes(prefixes) -> dict:
    """``{prefix_id: engine}`` for a page of prefixes in a handful of queries -
    the per-row ``engine_for_prefix`` walk cost three queries per row on the
    prefix list (#179). Same precedence: prefix binding, site binding, the
    tenant default, local."""
    prefixes = list(prefixes)
    if not prefixes:
        return {}
    tenant = prefixes[0].tenant
    ids = {p.id for p in prefixes}
    site_ids = {p.site_id for p in prefixes if p.site_id}
    by_prefix: dict = {}
    by_site: dict = {}
    for b in (
        MonitoringEngineBinding.objects.filter(
            tenant=tenant,
            scope__in=[MonitoringEngineBinding.SCOPE_PREFIX, MonitoringEngineBinding.SCOPE_SITE],
            object_id__in=[*ids, *site_ids],
        )
        .select_related("engine")
    ):
        if not engine_usable(b.engine):
            continue
        target = by_prefix if b.scope == MonitoringEngineBinding.SCOPE_PREFIX else by_site
        target.setdefault(b.object_id, b.engine)
    fallback = _default_engine(tenant) or MonitoringEngine.local_for(tenant)
    return {
        p.id: by_prefix.get(p.id) or by_site.get(p.site_id) or fallback
        for p in prefixes
    }


def engine_for_prefix(prefix) -> MonitoringEngine:
    """The engine responsible for a **prefix** (never None) - resolved via its
    prefix binding, then site binding, then the tenant default, then local. Used
    to decide which Outpost sweeps a subnet for discovery."""
    tenant = prefix.tenant
    engine = _binding_engine(tenant, MonitoringEngineBinding.SCOPE_PREFIX, prefix.id)
    if engine is None:
        engine = _binding_engine(
            tenant, MonitoringEngineBinding.SCOPE_SITE, prefix.site_id
        )
    if engine is None:
        engine = _default_engine(tenant)
    return engine or MonitoringEngine.local_for(tenant)


def engine_for_target(target) -> MonitoringEngine:
    """The engine that polls an SNMP **target** - a device or a VM (never None).

    Same resolution as ``engine_for_ip`` minus the prefix, keyed off the
    object itself: its own binding (devices have one), its location and the
    location's parents (devices), its site - its own, else its location's,
    else its cluster's (``SnmpTarget.site_id``) - the tenant default, local.
    ``engines_for_targets`` reads the same levels for many at once."""
    target = SnmpTarget.of(target)
    tenant = target.tenant
    engine = None
    if target.engine_scope:
        engine = _binding_engine(tenant, target.engine_scope, target.id)
    if engine is None:
        engine = _location_chain_engine(tenant, target.location_id)
    if engine is None:
        engine = _binding_engine(
            tenant, MonitoringEngineBinding.SCOPE_SITE, target.site_id()
        )
    if engine is None:
        engine = _default_engine(tenant)
    return engine or MonitoringEngine.local_for(tenant)


def engine_for_device(device) -> MonitoringEngine:
    """``engine_for_target`` for a device."""
    return engine_for_target(SnmpTarget(DEVICE, device))


def engines_for_targets(tenant, targets) -> dict:
    """``{target.key: engine}`` for many targets in a fixed handful of queries.

    Same precedence as ``engine_for_target``, read from the tenant's bindings,
    location tree and (for VMs without a site) cluster sites loaded once. The
    per-target walk costs several queries a row, which an Outpost that is the
    tenant default would pay for every target on each work fetch, and so
    would the scheduled poller."""
    from api.models import Cluster, Location

    targets = [SnmpTarget.of(t) for t in targets]
    if not targets:
        return {}
    bound: dict = {
        MonitoringEngineBinding.SCOPE_DEVICE: {},
        MonitoringEngineBinding.SCOPE_LOCATION: {},
        MonitoringEngineBinding.SCOPE_SITE: {},
    }
    usable: dict = {}
    for b in MonitoringEngineBinding.objects.filter(
        tenant=tenant, scope__in=list(bound)
    ).select_related("engine"):
        if b.engine_id not in usable:
            usable[b.engine_id] = engine_usable(b.engine)
        if usable[b.engine_id]:
            bound[b.scope][b.object_id] = b.engine
    by_location = bound[MonitoringEngineBinding.SCOPE_LOCATION]
    by_site = bound[MonitoringEngineBinding.SCOPE_SITE]
    tree: dict = {}
    if any(t.location_id for t in targets):
        tree = {
            lid: (parent_id, site_id)
            for lid, parent_id, site_id in Location.objects.filter(
                tenant=tenant
            ).values_list("id", "parent_id", "site_id")
        }
    cluster_ids = {t.cluster_id for t in targets if t.cluster_id and not t.own_site_id}
    cluster_site = (
        dict(
            Cluster.objects.filter(tenant=tenant, id__in=cluster_ids).values_list(
                "id", "site_id"
            )
        )
        if cluster_ids
        else {}
    )
    fallback = _default_engine(tenant) or MonitoringEngine.local_for(tenant)

    out = {}
    for t in targets:
        engine = bound.get(t.engine_scope, {}).get(t.id) if t.engine_scope else None
        cur, seen = t.location_id, set()
        while engine is None and cur and cur not in seen and len(seen) < 32:
            seen.add(cur)
            engine = by_location.get(cur)
            cur = tree.get(cur, (None, None))[0]
        if engine is None:
            site_id = (
                t.own_site_id
                or tree.get(t.location_id, (None, None))[1]
                or cluster_site.get(t.cluster_id)
            )
            engine = by_site.get(site_id)
        out[t.key] = engine or fallback
    return out


def engines_for_devices(tenant, devices) -> dict:
    """``{device_id: engine}`` - ``engines_for_targets`` for devices."""
    resolved = engines_for_targets(tenant, [SnmpTarget(DEVICE, d) for d in devices])
    return {obj_id: engine for (_kind, obj_id), engine in resolved.items()}


def _location_subtree_ids(tenant, location_ids):
    """All location ids at or under ``location_ids`` (a child inherits a binding
    set on a parent). Adjacency-list BFS - one query per depth, cheap for the
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


def targets_for_engine(engine, ids=None, kinds=KINDS) -> list:
    """The tenant's SNMP targets (``SnmpTarget``) whose resolved engine is
    ``engine`` - what an Outpost polls, and the only targets it may report
    for. Narrowed to the engine's bound devices, sites and location subtrees
    (every target when it is the tenant default), then each confirmed with
    ``engines_for_targets`` (a nested, more-specific binding could steal a
    target back to another engine).

    ``ids`` narrows the candidates first, so a check of the few targets an
    Outpost posted results for costs what they cost, not what every target in
    its sites does (#293)."""
    from django.db.models import Q

    tenant = engine.tenant
    bindings = list(
        MonitoringEngineBinding.objects.filter(tenant=tenant, engine=engine)
    )
    site_ids = [b.object_id for b in bindings if b.scope == MonitoringEngineBinding.SCOPE_SITE]
    loc_ids = [b.object_id for b in bindings if b.scope == MonitoringEngineBinding.SCOPE_LOCATION]
    dev_ids = [b.object_id for b in bindings if b.scope == MonitoringEngineBinding.SCOPE_DEVICE]
    # The same levels ``engine_for_target`` reads: a device bound on its own
    # form, and every unbound target when this engine is the tenant default,
    # are this engine's to poll too. Leaving them out answered "Queued on
    # Outpost" to a Poll now the Outpost never saw (#325).
    is_default = MonitoringSettings.for_tenant(tenant).default_engine_id == engine.id
    if not (site_ids or loc_ids or dev_ids or is_default):
        return []
    targets = []
    for kind in kinds:
        qs = snmp_candidates(tenant, kind)
        if not is_default:
            if kind == DEVICE:
                all_loc_ids = _location_subtree_ids(tenant, loc_ids) if loc_ids else set()
                where = (
                    Q(id__in=dev_ids)
                    | Q(site_id__in=site_ids)
                    | Q(location__site_id__in=site_ids)
                    | Q(location_id__in=all_loc_ids)
                )
            else:
                where = Q(site_id__in=site_ids) | Q(
                    site__isnull=True, cluster__site_id__in=site_ids
                )
            qs = qs.filter(where)
        qs = qs.select_related("primary_ip", "tenant")
        if ids is not None:
            qs = qs.filter(id__in=ids)
        targets += [SnmpTarget(kind, o) for o in qs]
    resolved = engines_for_targets(tenant, targets)
    return [t for t in targets if resolved[t.key].id == engine.id]


def devices_for_engine(engine, ids=None):
    """The devices ``targets_for_engine`` hands ``engine``."""
    return [t.obj for t in targets_for_engine(engine, ids, kinds=(DEVICE,))]


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
    """The engine id bound to a site/location, or None - for the form to prefill."""
    b = MonitoringEngineBinding.objects.filter(
        tenant=tenant, scope=scope, object_id=object_id
    ).first()
    return str(b.engine_id) if b else None
