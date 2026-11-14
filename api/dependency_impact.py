"""What goes down if a device fails, and the dependency tree (#450).

:func:`impact` follows the contract of ``api.feed_impact.affected`` (#434):
the walk (``api.dependencies.walk``) runs on every dependency of the tenant,
so a device's level never depends on what the caller may see; the answer
lists only the devices the caller may view. Each is at **outage** when a
whole redundancy group of its upstreams goes down with the roots, at
**reduced redundancy** when part of one does; only an outage propagates.
``impacts`` is in the shape the maintenance event create and ``ingest`` take,
so planning maintenance on a device prefills its impact list with its
dependents.

:func:`tree` is the device tab's view: the dependencies up and down from one
device to a depth, over the dependency rows the caller may view. A device on
the way the caller may not view is a "Hidden" node, so the shape of the tree
still reads.
"""
from __future__ import annotations

from collections import deque

from auth_api import rbac

from .dependencies import OUTAGE, REDUCED, load_graph, walk
from .models import Device, DeviceDependency

DEFAULT_LIMIT = 500
MAX_LIMIT = 5000
DEFAULT_DEPTH = 3
MAX_DEPTH = 10
MAX_NODES = 1000

_LEVEL_ORDER = {OUTAGE: 0, REDUCED: 1}


def clamp(raw, default: int, top: int) -> int:
    """A positive whole-number query value, at most ``top``."""
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return default
    return max(1, min(n, top))


def _site(d):
    return {"id": str(d.site_id), "name": d.site.name} if d.site_id else None


def impact(user, tenant, roots, limit: int = DEFAULT_LIMIT) -> dict:
    """What fails with the ``roots`` (device ids)."""
    root_ids = {str(r) for r in roots}
    result = walk(load_graph(tenant.pk), root_ids)
    visible = {
        str(d.pk): d
        for d in rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant, pk__in=[*result.levels, *root_ids]),
            user, tenant, "device", "view",
        ).select_related("site", "rack")
    }
    listed = sorted(
        (pk for pk in result.levels if pk in visible),
        key=lambda pk: (_LEVEL_ORDER[result.levels[pk]], result.depth[pk],
                        visible[pk].name.lower()),
    )
    counts = {OUTAGE: 0, REDUCED: 0}
    for pk in listed:
        counts[result.levels[pk]] += 1
    truncated = len(listed) > limit
    listed = listed[:limit]
    root_rows = sorted((visible[r] for r in root_ids if r in visible),
                       key=lambda d: d.name.lower())

    def mini(pk):
        d = visible[pk]
        return {"id": pk, "name": d.name}

    devices = [
        {
            "id": pk,
            "name": visible[pk].name,
            "level": result.levels[pk],
            "depth": result.depth[pk],
            "via": [mini(v) for v in result.via[pk] if v in visible],
            "site": _site(visible[pk]),
            "rack": ({"id": str(visible[pk].rack_id), "name": visible[pk].rack.name}
                     if visible[pk].rack_id else None),
        }
        for pk in listed
    ]
    impacts = [
        {"object_type": "device", "object_id": str(d.pk), "level": OUTAGE} for d in root_rows
    ] + [
        {"object_type": "device", "object_id": d["id"], "level": d["level"]} for d in devices
    ]
    return {
        "root": [{"id": str(d.pk), "name": d.name} for d in root_rows],
        "devices": devices,
        "counts": counts,
        "truncated": truncated,
        "impacts": impacts,
    }


def _medium(m):
    if m is None:
        return None
    return {"id": str(m.pk), "name": m.name, "color": m.color, "text_color": m.text_color,
            "icon": m.icon, "line_style": m.line_style}


def tree(user, tenant, device, depth: int = DEFAULT_DEPTH, direction: str = "both") -> dict:
    """The dependencies of ``device`` up and down to ``depth`` hops, and its
    peers, over the rows the caller may view."""
    rows = list(
        rbac.restrict_queryset(
            DeviceDependency.objects.filter(tenant=tenant),
            user, tenant, "devicedependency", "view",
        ).select_related("medium").order_by("pk")
    )
    ups: dict = {}
    downs: dict = {}
    peers = []
    root = str(device.pk)
    for r in rows:
        u, d = str(r.upstream_id), str(r.downstream_id)
        if r.kind == DeviceDependency.KIND_PEER:
            if root in (u, d):
                peers.append(r)
            continue
        ups.setdefault(d, []).append(r)
        downs.setdefault(u, []).append(r)

    def collect(adjacent, far_end):
        seen = {root}
        edges = []
        truncated = False
        queue = deque([(root, 0)])
        while queue:
            node, level = queue.popleft()
            if level >= depth:
                if adjacent.get(node):
                    truncated = True
                continue
            for r in adjacent.get(node, ()):
                nxt = far_end(r)
                if nxt not in seen and len(seen) >= MAX_NODES:
                    truncated = True
                    continue
                edges.append(r)
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append((nxt, level + 1))
        return edges, truncated

    up_edges, up_trunc = (
        collect(ups, lambda r: str(r.upstream_id)) if direction in ("up", "both") else ([], False)
    )
    down_edges, down_trunc = (
        collect(downs, lambda r: str(r.downstream_id))
        if direction in ("down", "both") else ([], False)
    )
    edges = [*up_edges, *down_edges, *peers]
    ids = {root}
    for r in edges:
        ids.update((str(r.upstream_id), str(r.downstream_id)))
    visible = {
        str(d.pk): d
        for d in rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant, pk__in=list(ids)),
            user, tenant, "device", "view",
        ).select_related("site", "role", "status")
    }
    checks = _device_checks(tenant, list(visible))
    # A device the caller may not view keeps its place under a key of its
    # own, never its id.
    hidden: dict = {}

    def key(pk):
        if pk in visible:
            return pk
        return hidden.setdefault(pk, f"hidden-{len(hidden) + 1}")

    def node(pk):
        d = visible.get(pk)
        if d is None:
            return {"id": key(pk), "name": "Hidden", "hidden": True, "site": None,
                    "role": None, "status": None, "check": None}
        return {
            "id": pk,
            "name": d.name,
            "hidden": False,
            "site": _site(d),
            "role": ({"id": str(d.role_id), "name": d.role.name, "color": d.role.color}
                     if d.role_id else None),
            "status": ({"id": str(d.status_id), "name": d.status.name,
                        "color": d.status.color, "text_color": d.status.text_color}
                       if d.status_id else None),
            "check": checks.get(pk),
        }

    def edge(r):
        return {
            "id": str(r.pk),
            "upstream": key(str(r.upstream_id)),
            "downstream": key(str(r.downstream_id)),
            "kind": r.kind,
            "medium": _medium(r.medium),
            "redundancy_group": r.redundancy_group,
            "description": r.description,
        }

    # Upstreams checked less often than the root-cause hold (#450): their
    # dependents' alerts usually go out before they are seen down.
    from monitoring.root_cause import slow_upstreams

    up_ids = {str(r.upstream_id) for r in up_edges} & set(visible)
    hold, slow = slow_upstreams(tenant, up_ids)
    return {
        "root": node(root),
        "nodes": [node(pk) for pk in sorted(ids - {root})],
        "edges": [edge(r) for r in edges],
        "depth": depth,
        "truncated": {"up": up_trunc, "down": down_trunc},
        "hold_seconds": hold,
        "slow_upstreams": [
            {"id": pk, "name": visible[pk].name, "interval_seconds": slow[pk]}
            for pk in sorted(slow, key=lambda p: visible[p].name)
        ],
    }


def _device_checks(tenant, device_ids) -> dict:
    """The worst live check status per device, as the maps read it."""
    if not device_ids:
        return {}
    from monitoring.models import CheckState
    from monitoring.rollup import worst_status

    by_device: dict = {}
    for dev, status in CheckState.objects.filter(
        tenant=tenant, target_ip__assigned_device_id__in=device_ids,
    ).values_list("target_ip__assigned_device_id", "status"):
        by_device.setdefault(str(dev), []).append(status)
    return {pk: worst_status(s) for pk, s in by_device.items()}
