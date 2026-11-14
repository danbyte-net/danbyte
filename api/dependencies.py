"""Device dependencies: the one write path and the graph (#450).

Every write of a :class:`~api.models.DeviceDependency` - the API, the
spreadsheet import (which saves through the viewset) and later the suggest
confirm - goes through :func:`save_dependency`. It serialises the tenant's
writers with a transaction-scoped advisory lock, normalises a peer, refuses
a cycle with its path, and turns the database's own refusals (a
self-reference, a second relation between the same pair, a grouped peer)
into field errors.

The read side is :func:`load_graph`: the tenant's ``kind=dependency`` edges,
cached per tenant and graph version. Any write bumps the version once its
transaction commits (``post_save``/``post_delete`` here, ``bump_graph_version``
for the bulk paths that skip signals), so a reader never sees a stale graph
for longer than the commit.

:func:`ancestors`, :func:`descendants` and :func:`walk` are pure: they take a
:class:`Graph` and ids and touch no database, so the impact walk, the
device tab and the alert pipeline share one answer. :func:`walk` is the
monotone fixpoint behind "what goes down if this fails": a device is at
**outage** when every upstream of one of its redundancy groups is down, at
**reduced redundancy** when some are; only an outage propagates.
"""
from __future__ import annotations

import uuid
import zlib
from collections import deque
from dataclasses import dataclass, field

from django.core.cache import cache
from django.db import IntegrityError, connection, transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver
from rest_framework.exceptions import ValidationError

from .models import DeviceDependency

OUTAGE = "outage"
REDUCED = "reduced_redundancy"

#: First key of the advisory lock; the second is the tenant's crc32.
LOCK_NAMESPACE = 450
GRAPH_TTL = 300

_PAIR_TAKEN = "These two devices are already related."
_SELF = "A device cannot depend on itself."
_PEER_GROUP = "A peer link has no redundancy group."


# ─── graph cache ────────────────────────────────────────────────────────────

def _version_key(tenant_id) -> str:
    return f"depgraph:ver:{tenant_id}"


def graph_version(tenant_id) -> str:
    key = _version_key(tenant_id)
    ver = cache.get(key)
    if ver is None:
        ver = uuid.uuid4().hex
        # add() so two cold readers agree on one version.
        if not cache.add(key, ver, None):
            ver = cache.get(key) or ver
    return ver


def bump_graph_version(tenant_id) -> None:
    """A new graph version for ``tenant_id`` once the current transaction
    commits (at once outside one)."""
    if tenant_id is None:
        return
    transaction.on_commit(
        lambda: cache.set(_version_key(tenant_id), uuid.uuid4().hex, None)
    )


@receiver(post_save, sender=DeviceDependency)
@receiver(post_delete, sender=DeviceDependency)
def _dependency_changed(sender, instance, **kwargs):
    bump_graph_version(instance.tenant_id)


@dataclass
class Graph:
    """The tenant's dependency edges, by device id (``str``).

    ``up[down][group]`` is the frozenset of upstreams of one redundancy
    group of ``down``; an ungrouped dependency is its own group
    ``_<upstream id>``. ``down[up]`` is the set of its dependents. Peers
    are not in the graph."""

    up: dict[str, dict[str, frozenset]] = field(default_factory=dict)
    down: dict[str, set] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return bool(self.up)

    def upstreams(self, device_id) -> set:
        out: set = set()
        for members in self.up.get(str(device_id), {}).values():
            out |= members
        return out

    def dependents(self, device_id) -> set:
        return set(self.down.get(str(device_id), ()))


def build_graph(edges) -> Graph:
    """A :class:`Graph` from ``(upstream, downstream, redundancy_group)``
    triples."""
    groups: dict[str, dict[str, set]] = {}
    down: dict[str, set] = {}
    for up, dn, group in edges:
        up, dn = str(up), str(dn)
        key = group or f"_{up}"
        groups.setdefault(dn, {}).setdefault(key, set()).add(up)
        down.setdefault(up, set()).add(dn)
    return Graph(
        up={d: {g: frozenset(m) for g, m in gs.items()} for d, gs in groups.items()},
        down=down,
    )


def _edges(tenant_id, exclude_pk=None):
    qs = DeviceDependency.objects.filter(
        tenant_id=tenant_id, kind=DeviceDependency.KIND_DEPENDENCY,
    )
    if exclude_pk is not None:
        qs = qs.exclude(pk=exclude_pk)
    return qs.values_list("upstream_id", "downstream_id", "redundancy_group")


def load_graph(tenant_id) -> Graph:
    """The tenant's dependency graph, from the cache when its version is
    current."""
    key = f"depgraph:{tenant_id}:{graph_version(tenant_id)}"
    graph = cache.get(key)
    if graph is None:
        graph = build_graph(_edges(tenant_id))
        cache.set(key, graph, GRAPH_TTL)
    return graph


# ─── pure walks ─────────────────────────────────────────────────────────────

def _bfs(adjacent, roots, max_depth=None) -> dict:
    """``{id: depth}`` of everything reachable from ``roots`` (depth 0,
    not included) through ``adjacent(id)``."""
    seen: dict = {}
    start = {str(r) for r in roots}
    queue = deque((r, 0) for r in start)
    while queue:
        node, depth = queue.popleft()
        if max_depth is not None and depth >= max_depth:
            continue
        for nxt in adjacent(node):
            if nxt in start or nxt in seen:
                continue
            seen[nxt] = depth + 1
            queue.append((nxt, depth + 1))
    return seen


def ancestors(graph: Graph, roots, max_depth=None) -> dict:
    """Every device ``roots`` depend on, transitively: ``{id: depth}``."""
    return _bfs(graph.upstreams, roots, max_depth)


def descendants(graph: Graph, roots, max_depth=None) -> dict:
    """Every device that depends on ``roots``, transitively: ``{id: depth}``."""
    return _bfs(graph.dependents, roots, max_depth)


@dataclass
class Walk:
    """What :func:`walk` found: ``levels`` per affected device (the failed
    roots left out), its ``depth`` from the nearest root and ``via``, the
    failed upstreams it hangs off."""

    levels: dict = field(default_factory=dict)
    depth: dict = field(default_factory=dict)
    via: dict = field(default_factory=dict)


def walk(graph: Graph, failed) -> Walk:
    """The monotone fixpoint from the ``failed`` devices.

    A device goes down when every upstream of one of its redundancy groups
    is down; it then takes its own dependents with it. A device with only
    part of a group down has reduced redundancy, which does not propagate.
    """
    failed = {str(f) for f in failed}
    down = set(failed)
    depth = {f: 0 for f in failed}
    order: list = []
    queue = deque(failed)
    while queue:
        node = queue.popleft()
        for dep in graph.down.get(node, ()):
            if dep in down:
                continue
            groups = graph.up.get(dep, {})
            if any(members <= down for members in groups.values()):
                down.add(dep)
                order.append(dep)
                depth[dep] = 1 + min(depth[u] for u in graph.upstreams(dep) if u in depth)
                queue.append(dep)
    out = Walk()
    for dep in order:
        out.levels[dep] = OUTAGE
        out.depth[dep] = depth[dep]
        out.via[dep] = sorted(u for u in graph.upstreams(dep) if u in down)
    touched = set()
    for node in down:
        touched |= graph.down.get(node, set())
    for dep in touched - down:
        ups = [u for u in graph.upstreams(dep) if u in down]
        out.levels[dep] = REDUCED
        out.depth[dep] = 1 + min(depth[u] for u in ups)
        out.via[dep] = sorted(ups)
    return out


def outage_levels(graph: Graph, failed) -> dict:
    """``{device id: "outage" | "reduced_redundancy"}`` for everything the
    ``failed`` devices affect; the failed devices themselves are left out."""
    return walk(graph, failed).levels


def find_path(graph_down: dict, start: str, goal: str) -> list | None:
    """The shortest path ``start`` → … → ``goal`` along ``graph_down``
    (upstream → dependents), or ``None``."""
    prev = {start: None}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        if node == goal:
            path = []
            while node is not None:
                path.append(node)
                node = prev[node]
            return path[::-1]
        for nxt in graph_down.get(node, ()):
            if nxt not in prev:
                prev[nxt] = node
                queue.append(nxt)
    return None


# ─── the write path ─────────────────────────────────────────────────────────

def _lock_key(tenant_id) -> int:
    """The tenant's crc32 as a signed 32-bit key."""
    n = zlib.crc32(str(tenant_id).encode())
    return n - (1 << 32) if n >= (1 << 31) else n


def lock_tenant(tenant_id) -> None:
    """Serialise the tenant's dependency writers until the transaction ends."""
    with connection.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s, %s)",
                    [LOCK_NAMESPACE, _lock_key(tenant_id)])


def _names(ids) -> dict:
    from .models import Device

    return dict(Device.objects.filter(pk__in=list(ids)).values_list("pk", "name"))


def cycle_path(obj) -> list | None:
    """The devices a new or changed dependency would close a cycle through,
    as ``[downstream, …, upstream, downstream]``, or ``None``. Reads the
    edges fresh, so call it under :func:`lock_tenant`."""
    if obj.kind != DeviceDependency.KIND_DEPENDENCY:
        return None
    up, down = str(obj.upstream_id), str(obj.downstream_id)
    graph_down: dict = {}
    for u, d, _g in _edges(obj.tenant_id, exclude_pk=obj.pk if obj.pk else None):
        graph_down.setdefault(str(u), set()).add(str(d))
    # The new edge up → down closes a cycle when down already reaches up.
    path = find_path(graph_down, down, up)
    return None if path is None else [*path, down]


def _check_pair(obj) -> None:
    """The database's refusals, answered before it raises."""
    if obj.upstream_id == obj.downstream_id:
        raise ValidationError({"downstream_id": [_SELF]})
    if obj.kind == DeviceDependency.KIND_PEER and obj.redundancy_group:
        raise ValidationError({"redundancy_group": [_PEER_GROUP]})
    a, b = obj.upstream_id, obj.downstream_id
    clash = DeviceDependency.objects.filter(tenant_id=obj.tenant_id).filter(
        upstream_id__in=[a, b], downstream_id__in=[a, b],
    )
    if obj.pk:
        clash = clash.exclude(pk=obj.pk)
    if clash.exists():
        raise ValidationError({"upstream_id": [_PAIR_TAKEN]})


def save_dependency(obj) -> DeviceDependency:
    """Validate and save ``obj``; raises DRF ``ValidationError`` with field
    errors (``upstream_id``, ``downstream_id``, ``redundancy_group``)."""
    obj.normalise()
    obj.redundancy_group = (obj.redundancy_group or "").strip()
    with transaction.atomic():
        lock_tenant(obj.tenant_id)
        _check_pair(obj)
        path = cycle_path(obj)
        if path is not None:
            names = _names(path)
            text = " → ".join(names.get(_as_uuid(p), "?") for p in path)
            raise ValidationError({"upstream_id": [f"This would make a cycle: {text}."]})
        try:
            with transaction.atomic():
                obj.save()
        except IntegrityError as exc:
            raise ValidationError(_integrity_detail(exc)) from None
    return obj


def _as_uuid(value):
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return value


def _integrity_detail(exc) -> dict:
    text = str(exc)
    if "devdep_no_self" in text:
        return {"downstream_id": [_SELF]}
    if "devdep_peer_no_group" in text:
        return {"redundancy_group": [_PEER_GROUP]}
    return {"upstream_id": [_PAIR_TAKEN]}
