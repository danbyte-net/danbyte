"""Network topology graph v2 for the React Flow map.

``GET /api/topology/`` → ``{nodes, edges}``. ``POST`` takes the same query as
a JSON body (a large device set overflows a URL). ``include=card,link_ips,
photo`` opts into enrichment (``api/topology_enrich.py``) and adds ``meta``.

Nodes are devices rendered as *stencil cards*: each carries its cabled ports
(so edges anchor port-to-port, like a wiring diagram), role color, primary IP
and a ``panel`` flag (pass-through-only device).

Edges are cables. Two modes:

* ``collapse_panels=1`` (default) - patch panels are walked *through*
  (front→rear strand→cable→…) so an edge runs interface-to-interface
  end-to-end, annotated with the panels it passed (``via``). Panel-only
  devices drop off the map.
* ``collapse_panels=0`` - raw physical hops; panels appear as nodes.

Filters: ``site`` ``location`` ``role`` ``status`` ``tag`` narrow the device
set. ``device=<id>&depth=N`` focuses the graph on one device's neighbourhood
(BFS over the edge list, default depth 1, neighbours pulled in even when
outside the filter scope).

A device in a virtual chassis the caller may view carries ``vc`` (its
chassis, member number and whether it is the master), and a hand-picked map
(``devices=``) takes ``chassis=``: those chassis' members as they are now.
``GET /api/topology/chassis/`` lists the chassis the Diagram can place.
"""
from __future__ import annotations

import uuid
from collections import deque
from collections.abc import Mapping
from datetime import UTC, datetime

from django.core.exceptions import EmptyResultSet
from django.db import connection
from django.db.models import Count, Min, Prefetch, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ParseError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .models import (
    Cable,
    CableTermination,
    Device,
    FrontPort,
    RearPort,
    VirtualChassis,
)
from .natural import natural, natural_key
from .views import _get_active_tenant
from auth_api import rbac

MAX_DEPTH = 6
# Largest explicit device set (``devices=``) one request may name.
MAX_DEVICE_SET = 10_000
# Most virtual chassis (``chassis=``) one hand-picked map may place.
MAX_CHASSIS_SET = 1_000


# ─── Request parsing ────────────────────────────────────────────────────────
#
# Ids feed UUID filters; a malformed one raised Django's ValidationError from
# the queryset, which the API exception handler doesn't map - a 500. Parse
# them up front into a 400 instead.

def _parse_uuid(raw, param):
    try:
        return str(uuid.UUID(str(raw).strip()))
    except (TypeError, ValueError):
        raise ParseError(f"{param}: not a valid id") from None


def _uuid_param(params, param):
    """The ``param`` id as a canonical UUID string, or None when absent."""
    raw = params.get(param)
    return _parse_uuid(raw, param) if raw else None


def _uuid_list_param(params, param, limit=MAX_DEVICE_SET):
    """The comma-separated ``param`` ids (or a list of them), de-duplicated
    in order. More than ``limit`` ids is a 400."""
    raw = params.get(param) or ""
    items = raw if isinstance(raw, (list, tuple)) else str(raw).split(",")
    items = [x for x in items if str(x).strip()]
    if len(items) > limit:
        raise ParseError(f"{param}: at most {limit:,} ids")
    return list(dict.fromkeys(_parse_uuid(x, param) for x in items))


def _query_params(request):
    """The map's parameters: the query string on GET, the JSON body on POST.
    A device set of a few hundred ids overflows gunicorn's 8190-byte request
    line, so the page POSTs; the body mirrors the query, with lists where the
    query takes comma-separated values."""
    if request.method != "POST":
        return request.query_params
    data = request.data
    if not isinstance(data, Mapping):
        raise ParseError("The body must be a JSON object.")
    return data


def _flag_param(params, param, default=True):
    """A switch: ``0`` (or JSON ``false``) is off, anything else on."""
    raw = params.get(param)
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).strip() != "0"


def _csv_param(params, param):
    """The ``param`` values from a comma-separated string or a JSON list,
    stripped, empties dropped; None when the parameter is absent."""
    if param not in params:
        return None
    raw = params.get(param)
    if raw is None:
        return None
    items = raw if isinstance(raw, (list, tuple)) else str(raw).split(",")
    return [str(x).strip() for x in items if str(x).strip()]


def _include_param(params):
    """The opt-in enrichments ``include`` names; unknown tokens are ignored."""
    from .topology_enrich import INCLUDE_TOKENS

    return frozenset(_csv_param(params, "include") or ()) & INCLUDE_TOKENS


def _card_fields_param(params):
    """A saved view's own card lines (``card_fields``): None when absent
    (inherit), ``[]`` for name only. Keys outside the vocabulary drop."""
    from core.deployment import topology_card_list

    fields = _csv_param(params, "card_fields")
    return None if fields is None else topology_card_list(fields)


# ─── Node payload ────────────────────────────────────────────────────────────

def _devices_qs(tenant):
    return (
        Device.objects.filter(tenant=tenant)
        .select_related("device_type", "site", "location", "role",
                        "status", "primary_ip")
        .annotate(ic=Count("interfaces", distinct=True))
    )


def _status_mini(status, model):
    """The ``StatusMini`` shape plus ``is_default``: whether ``status`` is
    the one applied to a new ``model`` (its ``default_for`` slug)."""
    if status is None:
        return None
    return {
        "id": str(status.id),
        "name": status.name,
        "slug": status.slug,
        "color": status.color,
        "text_color": status.text_color,
        "is_default": model in (status.default_for or []),
    }


def _device_node(d, ports, panel=False):
    """``ports`` = ordered [{name, kind, pair?}] of this device's cabled ends
    - ``pair`` names the rear port sharing the row (front ⇄ rear strand).
    Reads only the relations ``_devices_qs`` joins - no per-node queries."""
    return {
        "id": f"dev:{d.id}",
        "type": "device",
        "data": {
            "device_id": str(d.id),
            "name": d.name,
            "status": d.status.slug if d.status_id else None,
            "status_display": d.status.name if d.status_id else "",
            "status_mini": _status_mini(
                d.status if d.status_id else None, "device"
            ),
            "device_type": d.device_type.name if d.device_type_id else None,
            "device_type_id": str(d.device_type_id) if d.device_type_id else None,
            "role": (
                {"id": str(d.role.id), "name": d.role.name,
                 "slug": d.role.slug, "color": d.role.color,
                 "icon": d.role.icon,
                 "is_patch_panel": d.role.is_patch_panel}
                if d.role_id else None
            ),
            "site": d.site.name if d.site_id else None,
            "location": d.location.name if d.location_id else None,
            "primary_ip": d.primary_ip.ip_address if d.primary_ip_id else None,
            "interface_count": getattr(d, "ic", 0),
            "panel": panel,
            "ports": ports,
        },
    }


# ─── Cable endpoints ─────────────────────────────────────────────────────────

# Point classification + the pass-through walk live in the shared module so
# this builder and api/trace.py can't drift (they did once - see plan A1).
from .cable_points import (  # noqa: E402
    KIND_OF as _KIND_OF,
    POINT_ATTRS as _POINT_ATTRS,
    strand_of as _shared_strand_of,
    term_point as _term_point,
)


# A power feed terminates on a PowerPanel and a circuit end on a Circuit -
# neither has a `device` relation to prefetch, nor a place in device↔device
# topology. Prefetch the device chain only for the device-bearing points and
# pull the other two without a device lookup (an invalid `power_feed__device`
# prefetch 500s the paths endpoint for any cable that terminates on one).
_NON_DEVICE_POINTS = ("power_feed", "circuit_termination")
_DEVICE_POINT_ATTRS = tuple(a for a in _POINT_ATTRS if a not in _NON_DEVICE_POINTS)


def _cables_qs(tenant):
    # Total orders (id / created_at tie-breaks) so a narrowed load visits the
    # cables it shares with a whole-tenant load in the same order (#223).
    return (
        Cable.objects.filter(tenant=tenant)
        .order_by("-created_at", "id")
        .select_related("status")
        .prefetch_related(
            Prefetch(
                "terminations",
                queryset=CableTermination.objects.order_by("end", "created_at", "id"),
            ),
            *[f"terminations__{a}__device" for a in _DEVICE_POINT_ATTRS],
            # The bundle a port belongs to rides on the edge (and on a run's
            # origin) - joined here so neither walks it per cable.
            "terminations__interface__lag__device",
            "terminations__power_feed",
            "terminations__circuit_termination__circuit",
            "terminations__front_port__rear_port",
        )
    )


def _physical_links(tenant):
    """Every device↔device hop a cable makes, with its port names/kinds.

    Returns ``[(cable, dev_a, port_a, kind_a, dev_b, port_b, kind_b)]``.
    """
    return _links_from_cables(_cables_qs(tenant))


def _links_from_cables(cables):
    """The hops of ``cables`` (``_cables_qs`` rows, in its order) - see
    ``_physical_links``."""
    from types import SimpleNamespace

    links = []
    for cab in cables:
        a_ends, b_ends = [], []
        for t in cab.terminations.all():
            kind, obj = _term_point(t)
            if obj is None:
                continue
            # A circuit end has no device, but it IS a real endpoint - without
            # this, a port cabled to the provider's demarc reported "nothing
            # cabled" on its own page (#118). Shim it into the (device, port)
            # shape the walk speaks: the circuit is the "device", the side is
            # the "port".
            if kind == "circuit_termination":
                # site_id: a circuit end sits at a site through its own
                # termination, not through this shim - and callers that place
                # an endpoint on the map read `site_id` off it, so it must
                # exist and be empty rather than be missing.
                dev = SimpleNamespace(
                    id=obj.circuit_id, name=obj.circuit.cid, site_id=None
                )
                port = SimpleNamespace(
                    id=obj.id, name=f"Side {obj.term_side}",
                    device_id=obj.circuit_id, device=dev,
                )
                (a_ends if t.end == "A" else b_ends).append((kind, port))
                continue
            # Power feeds terminate on a PowerPanel (no device_id) - skipped
            # here as before; they have their own surfaces.
            if getattr(obj, "device_id", None) is None:
                continue
            (a_ends if t.end == "A" else b_ends).append((kind, obj))
        for ka, pa in a_ends:
            for kb, pb in b_ends:
                if pa.device_id == pb.device_id:
                    continue
                links.append((cab, pa.device, pa, ka, pb.device, pb, kb))
    return links


# ─── Panel collapse ─────────────────────────────────────────────────────────

def _strand_of(port, kind, position=1):
    """The opposite side of an internal pass-through, or None for a leaf.
    Front↔rear (patch panel) and outlet→inlet (PDU) - see cable_points.
    A returned partner with ``obj is None`` means the mapping exists but the
    far port is missing (dangling strand); the collapse walk treats that as
    "stop here, keep the node"."""
    strand = _shared_strand_of(kind, port, position)
    if strand is None:
        return None
    pk, obj, pos = strand
    return None if obj is None else (pk, obj, pos)


def _is_splitter_side(kind, port):
    """True when the port belongs to a splitter (the rear input or any front
    output). Splitters are real endpoints in every linear walk - one input
    fans out to N outputs, so 'walking through' with a single partner would
    silently pick one branch and fabricate a path."""
    if kind == "rear_port":
        return port.is_splitter
    if kind == "front_port":
        return port.rear_port.is_splitter
    return False


def _preloaded_strand(links):
    """``_strand_of`` for the collapse walk over ``links``, with the front
    ports of every rear port it can cross loaded in one query - the walk
    asked the database once per rear port crossed (#343). Same front port
    chosen, same objects: ``select_related`` covers what the walk and the
    node rows read off it."""
    rears = {
        link[i].id for link in links for i, k in ((2, 3), (5, 6))
        if link[k] == "rear_port" and not link[i].is_splitter
    }
    if not rears:
        return _strand_of
    fronts: dict = {}
    for fp in (
        FrontPort.objects.filter(rear_port_id__in=rears)
        .select_related("device", "rear_port")
        .order_by("-rear_port_position")
    ):
        fronts.setdefault(fp.rear_port_id, []).append(fp)

    def strand(port, kind, position=1):
        if kind != "rear_port" or port.is_splitter or port.id not in rears:
            return _strand_of(port, kind, position)
        # The front port whose range covers this rear position (as
        # ``cable_points.strands_of`` picks it).
        for fp in fronts.get(port.id, ()):
            if fp.rear_port_position <= position:
                if fp.rear_port_position + (fp.positions or 1) - 1 >= position:
                    return ("front_port", fp, position - fp.rear_port_position + 1)
                return None
        return None

    return strand


def _collapse(links, strand_of=_strand_of):
    """Walk each link that lands on a panel port through the panel until it
    reaches a non-pass-through endpoint. Emits end-to-end links + the set of
    panel device ids that were consumed. ``strand_of`` resolves a panel
    port's pass-through partner (the grouped map passes a preloaded one)."""
    # Index cables by (port kind, port id) for the walk.
    by_port = {}
    for link in links:
        cab, da, pa, ka, db, pb, kb = link
        by_port.setdefault((ka, pa.id), []).append((cab, db, pb, kb))
        by_port.setdefault((kb, pb.id), []).append((cab, da, pa, ka))

    def walk(kind, port, device, position=1, seen=None):
        """From a panel-side endpoint, cross the panel + next cable until a
        non-panel end. Returns (device, port, kind, [panel names]) or None."""
        seen = seen or set()
        vias = []
        while kind in ("front_port", "rear_port"):
            if _is_splitter_side(kind, port):
                # A splitter reached through panels is the walk's endpoint -
                # its fan-out is drawn as its own edges, never collapsed.
                return (device, port, kind, vias)
            if port.id in seen:
                return None  # loop guard
            seen.add(port.id)
            vias.append(device.name)
            strand = strand_of(port, kind, position)
            if strand is None:
                return (device, port, kind, vias[:-1])  # dangling panel port
            skind, sport, spos = strand
            hops = by_port.get((skind, sport.id), [])
            if not hops:
                # Pass-through wired but the far side of the panel is uncabled
                # - the path ends *at the panel*.
                return (device, sport, skind, vias[:-1])
            _, device, port, kind = hops[0]
            position = spos
        return (device, port, kind, vias)

    out = []
    consumed_panels = set()
    emitted = set()
    for cab, da, pa, ka, db, pb, kb in links:
        a_panel = ka in ("front_port", "rear_port") and not _is_splitter_side(ka, pa)
        b_panel = kb in ("front_port", "rear_port") and not _is_splitter_side(kb, pb)
        if not a_panel and not b_panel:
            out.append((cab, da, pa, ka, db, pb, kb, []))
            continue
        if a_panel and b_panel:
            continue  # panel-to-panel mid-segments are covered by the walks
        # One end is a real component, the other a panel - walk through.
        if a_panel:
            da, pa, ka, db, pb, kb = db, pb, kb, da, pa, ka
        res = walk(kb, pb, db)
        if res is None:
            continue
        end_dev, end_port, end_kind, vias = res
        if end_dev.id == da.id:
            continue
        key = tuple(sorted((f"{ka}:{pa.id}", f"{end_kind}:{end_port.id}")))
        if key in emitted:
            continue
        emitted.add(key)
        consumed_panels.update(vias)
        out.append((cab, da, pa, ka, end_dev, end_port, end_kind, vias))
    return out, consumed_panels


# ─── Graph assembly ─────────────────────────────────────────────────────────

def device_scope_q(user, tenant):
    """A ``Q`` bounding devices to the caller's ``device.view`` row/site scope,
    or ``None`` when unrestricted (superuser / unscoped grant). Feed into the
    graph builders' ``scope_q``."""
    from auth_api import rbac

    q = rbac.row_filter(user, tenant, "device", "view")
    return q if (q is not None and q is not True) else None


def viewable_device_ids(user, tenant):
    """Set of device pks the caller may view (for redaction in device_paths)."""
    from auth_api import rbac

    return set(
        rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant), user, tenant, "device", "view"
        ).values_list("id", flat=True)
    )


def _build_graph(tenant, device_filter_q=None, focus_id=None, depth=1,
                 collapse=True, scope_q=None, collect=None):
    """``collect``: an optional dict the assembly fills with the objects
    behind the graph - see ``_graph_from_links``."""
    opts = {"device_filter_q": device_filter_q, "focus_id": focus_id,
            "depth": depth, "collapse": collapse, "scope_q": scope_q,
            "collect": collect}
    if _wants_narrowing(device_filter_q, focus_id, scope_q):
        return _narrowed_graph(tenant, **opts)
    graph, _ = _graph_from_links(tenant, _physical_links(tenant), **opts)
    return graph


# ─── Narrowed cable loading (#223) ──────────────────────────────────────────
#
# A focused or filtered map returns a handful of devices, but building it from
# every cable in the tenant made it cost O(tenant cables). The narrowed loader
# fetches only the cables the returned graph can depend on and feeds them to
# the same assembly, in the same order, so the result is identical:
#
# * every cable on a *returned* device (its ports, edges and pass-through
#   status need all of them) - for a focus, grown ring by ring until the BFS
#   neighbourhood is fully loaded;
# * pass-through closure: a loaded cable landing on a front port pulls in the
#   cables on its rear port, one landing on a rear port pulls in the cables on
#   every front port mapped to it. That covers every panel walk from, and
#   every walk ending at, a returned device, whatever its strand position.
#
# Ports carry at most one cable (per-point unique constraints), so no other
# cable can compete for a walk's hop or a collapsed edge's dedup key.


def _wants_narrowing(device_filter_q, focus_id, scope_q):
    """True when the graph is bounded to a device set (focus, filter or RBAC
    scope) - the unbounded full map still reads the whole table. A focus id
    that is not a UUID keeps the old path (and its error behaviour)."""
    if focus_id:
        try:
            uuid.UUID(str(focus_id))
        except ValueError:
            return False
        return True
    return bool(device_filter_q) or scope_q is not None


def _terminations_touching(tenant, devices, rear_ids, fronts_of_rear_ids):
    """``(cable_id, front_port's rear_port_id, rear_port_id)`` for every end
    of this tenant's cables that have an end on ``devices`` (ids or a
    ``values("id")`` queryset; circuit ids match circuit ends), on a rear port
    in ``rear_ids``, or on a front port mapped to a rear port in
    ``fronts_of_rear_ids``. Light queries - no cable rows are built."""
    # One indexable lookup per point kind, UNIONed - an OR across them makes
    # the planner scan every termination in the tenant.
    ends = CableTermination.objects.filter(cable__tenant=tenant).order_by()
    parts = []
    if devices is not None:
        parts += [
            ends.filter(**{f"{attr}__device_id__in": devices})
            for attr in _DEVICE_POINT_ATTRS
        ]
        parts.append(ends.filter(circuit_termination__circuit_id__in=devices))
    if rear_ids:
        parts.append(ends.filter(rear_port_id__in=rear_ids))
    if fronts_of_rear_ids:
        parts.append(ends.filter(front_port__rear_port_id__in=fronts_of_rear_ids))
    if not parts:
        return []
    parts = [p.values_list("cable_id", flat=True) for p in parts]
    touching = set(parts[0].union(*parts[1:]))
    if not touching:
        return []
    # Every end of those cables: their far ends drive the pass-through
    # closure. (Ids materialised first - nested, the planner may re-run the
    # union per row.)
    return list(
        ends.filter(cable_id__in=touching)
        .values_list("cable_id", "front_port__rear_port_id", "rear_port_id")
    )


def _narrowed_graph(tenant, device_filter_q=None, focus_id=None, depth=1,
                    collapse=True, scope_q=None, collect=None):
    # ``collect`` rides into every assembly pass; each one replaces its keys
    # wholesale, so what's left is the returned graph's.
    opts = {"device_filter_q": device_filter_q, "focus_id": focus_id,
            "depth": depth, "collapse": collapse, "scope_q": scope_q,
            "collect": collect}
    if focus_id:
        pending = {str(focus_id)}
    else:
        base = Device.objects.filter(tenant=tenant)
        if device_filter_q is not None:
            base = base.filter(device_filter_q)
        if scope_q is not None:
            base = base.filter(scope_q)
        pending = base.values("id")
    cable_ids: set = set()
    cables: dict = {}
    loaded: set = set()  # device/circuit ids whose every cable is loaded
    asked_rear: set = set()
    asked_fronts_of: set = set()
    rear_ids: set = set()
    fronts_of: set = set()
    while True:
        rows = _terminations_touching(tenant, pending, rear_ids, fronts_of)
        if focus_id and pending is not None:
            loaded |= pending
        pending = None
        rear_ids, fronts_of = set(), set()
        for cid, front_rear_id, rear_id in rows:
            cable_ids.add(cid)
            if front_rear_id is not None and front_rear_id not in asked_rear:
                asked_rear.add(front_rear_id)
                rear_ids.add(front_rear_id)
            if rear_id is not None and rear_id not in asked_fronts_of:
                asked_fronts_of.add(rear_id)
                fronts_of.add(rear_id)
        if rear_ids or fronts_of:
            continue  # finish the pass-through closure first
        new_ids = cable_ids - cables.keys()
        if new_ids:
            for cab in _cables_qs(tenant).filter(id__in=new_ids):
                cables[cab.id] = cab
        # _cables_qs order: created_at desc, then id (uuid byte order).
        ordered = sorted(cables.values(), key=lambda c: c.id.int)
        ordered.sort(key=lambda c: c.created_at, reverse=True)
        graph, keep = _graph_from_links(
            tenant, _links_from_cables(ordered), narrowed=True, **opts
        )
        if not focus_id:
            return graph
        # The BFS is exact once every device it reached is fully loaded.
        missing = keep - loaded
        if not missing:
            return graph
        pending = missing


def _graph_from_links(tenant, links, device_filter_q=None, focus_id=None,
                      depth=1, collapse=True, scope_q=None, narrowed=False,
                      collect=None):
    """Assemble ``{nodes, edges}`` from physical ``links``. Returns the graph
    and, for a focus, the BFS neighbourhood (ids) it kept - else None.

    ``collect`` (a dict, optional) is a side channel for the opt-in
    enrichers (``api/topology_enrich.py``). It receives the objects the
    assembly already loaded - no extra queries - for the returned graph only:

    * ``devices`` - ``{device id: Device}`` for every device node;
    * ``ports`` - ``{device id: {(termination kind, port id): port}}``, the
      node's cabled components (``interface``, ``front_port``, …);
    * ``pairs`` - ``{edge id: [(pair, a_obj, a_kind, b_obj, b_kind)]}``,
      each ``pair`` being the payload dict itself, oriented like it.
    """
    keep = None
    # Remove hidden devices before panel-collapse walks are assembled. Filtering
    # only final endpoints allowed an otherwise visible edge to retain a hidden
    # patch panel's name in via.
    if scope_q is not None:
        # Ids only: no joins, no interface count to group by.
        allowed = Device.objects.filter(tenant=tenant).filter(scope_q)
        if narrowed:
            allowed = allowed.filter(
                id__in={link[i].id for link in links for i in (1, 4)}
            )
        allowed_ids = set(allowed.values_list("id", flat=True))
        links = [
            link for link in links
            if link[1].id in allowed_ids and link[4].id in allowed_ids
        ]
    # Pre-collapse: which devices are pure pass-throughs (only front/rear
    # ports cabled)? When their strands are consumed by the collapse they'd
    # otherwise linger as portless, disconnected cards.
    raw_kinds: dict = {}
    for _cab, da, _pa, ka, db, _pb, kb in links:
        raw_kinds.setdefault(str(da.id), set()).add(ka)
        raw_kinds.setdefault(str(db.id), set()).add(kb)
    passthrough_ids = {
        did for did, kinds in raw_kinds.items()
        if kinds <= {"front_port", "rear_port"}
    }
    # Focusing the map ON a patch panel: collapse walks it *through* and then
    # drops the portless husk, leaving an empty graph even though the panel has
    # cables. Show its raw front/rear hops so the panel and the devices cabled
    # to it appear (the device page's Map tab and ?device=<panel>).
    if focus_id and collapse and focus_id in passthrough_ids:
        collapse = False
    if collapse:
        links, _ = _collapse(links, strand_of=_preloaded_strand(links))
    else:
        links = [link + ([],) for link in links]

    # Aggregate hops → device-pair edges (one edge per cable per pair).
    edges = {}
    # device id → ordered {port name: (kind, port object)}
    port_sets: dict[str, dict] = {}
    # ``collect`` only: device id → {(termination kind, id): port object},
    # and edge id → [(pair, a_obj, a_kind, b_obj, b_kind)].
    port_objs: dict[str, dict] = {}
    pair_objs: dict[str, list] = {}
    # cable id → {(termination kind, port id): "A" | "B"}, read off the
    # terminations the cable queryset prefetched (no queries).
    cable_ends: dict = {}

    def end_on(cab, kind, port):
        """The end of ``cab`` a termination sits on, or None when it is not
        one of the cable's own (a run's far end beyond a panel)."""
        ends = cable_ends.get(cab.id)
        if ends is None:
            ends = cable_ends[cab.id] = {}
            for t in cab.terminations.all():
                k, obj = _term_point(t)
                if obj is not None:
                    ends[(k, obj.id)] = t.end
        return ends.get((kind, port.id))

    def note_port(dev, port, kind):
        d = port_sets.setdefault(str(dev.id), {})
        if port.name not in d:
            d[port.name] = (_KIND_OF.get(kind, "interface"), port)
        if collect is not None:
            port_objs.setdefault(str(dev.id), {})[(kind, port.id)] = port

    for cab, da, pa, ka, db, pb, kb, vias in links:
        note_port(da, pa, ka)
        note_port(db, pb, kb)
        ids = sorted((str(da.id), str(db.id)))
        key = (ids[0], ids[1], str(cab.id))
        if key not in edges:
            src, dst = (da, db) if str(da.id) == ids[0] else (db, da)
            edges[key] = {
                "id": f"e:{cab.id}:{ids[0]}:{ids[1]}",
                "source": f"dev:{src.id}",
                "target": f"dev:{dst.id}",
                "type": "cable",
                "data": {
                    "cable_id": str(cab.id),
                    "cable_numid": cab.numid,
                    "cable_type": cab.type,
                    "cable_label": cab.label,
                    "color": cab.color,
                    "status": cab.status.slug if cab.status_id else None,
                    "status_mini": _status_mini(
                        cab.status if cab.status_id else None, "cable"
                    ),
                    "length": str(cab.length) if cab.length is not None else None,
                    "length_unit": cab.length_unit,
                    "speed": None,
                    "via": vias,
                    "pairs": [],
                    # The aggregate each end belongs to, oriented with
                    # source/target - what lets the canvas fold a bundle's
                    # member cables into one edge.
                    "lag": {"a": None, "b": None},
                },
            }
        e = edges[key]
        src_is_a = e["source"] == f"dev:{da.id}"
        a_port, b_port = (pa.name, pb.name) if src_is_a else (pb.name, pa.name)
        # The components themselves (termination kinds: interface,
        # front_port, circuit_termination, …), oriented like a_port/b_port.
        end_a, end_b = ((pa, ka), (pb, kb)) if src_is_a else ((pb, kb), (pa, ka))
        if not e["data"]["pairs"]:
            pa_lag = getattr(pa, "lag", None) if ka == "interface" else None
            pb_lag = getattr(pb, "lag", None) if kb == "interface" else None
            lag_a, lag_b = (pa_lag, pb_lag) if src_is_a else (pb_lag, pa_lag)
            e["data"]["lag"] = {
                "a": {"id": str(lag_a.id), "name": lag_a.name} if lag_a else None,
                "b": {"id": str(lag_b.id), "name": lag_b.name} if lag_b else None,
            }
        # The cable end each termination sits on. A run collapsed through
        # panels ends on another cable: its far end takes the end the run
        # leaves this cable by.
        ends = [end_on(cab, ka, pa), end_on(cab, kb, pb)]
        for i in (0, 1):
            if ends[i] is None and ends[1 - i] is not None:
                ends[i] = "B" if ends[1 - i] == "A" else "A"
        a_end, b_end = ends if src_is_a else ends[::-1]
        pair = {
            "a": f"{da.name if src_is_a else db.name}:{a_port}",
            "b": f"{db.name if src_is_a else da.name}:{b_port}",
            "a_port": a_port,
            "b_port": b_port,
            "a_id": str(end_a[0].id),
            "a_kind": end_a[1],
            "a_end": a_end,
            "b_id": str(end_b[0].id),
            "b_kind": end_b[1],
            "b_end": b_end,
        }
        e["data"]["pairs"].append(pair)
        if collect is not None:
            pair_objs.setdefault(e["id"], []).append(
                (pair, end_a[0], end_a[1], end_b[0], end_b[1])
            )
        # Link speed from either endpoint interface (first non-empty wins) -
        # front/rear panel ports have no speed.
        if not e["data"].get("speed"):
            spd = getattr(pa, "speed", "") or getattr(pb, "speed", "")
            if spd:
                e["data"]["speed"] = spd

    edge_list = list(edges.values())

    # Scope: filtered devices, or the focus device's N-hop neighbourhood.
    if not focus_id:
        base = _devices_qs(tenant)
        if device_filter_q is not None:
            base = base.filter(device_filter_q)
        # RBAC row/site scope - a Site-A viewer's graph must contain only
        # devices they may view (applied to *both* the filtered and focus
        # paths).
        if scope_q is not None:
            base = base.filter(scope_q)
        in_scope = {str(d.id): d for d in base}
    else:
        adj: dict[str, set] = {}
        for e in edge_list:
            s = e["source"][4:]
            t = e["target"][4:]
            adj.setdefault(s, set()).add(t)
            adj.setdefault(t, set()).add(s)
        keep = {focus_id}
        frontier = deque([(focus_id, 0)])
        while frontier:
            nid, d = frontier.popleft()
            if d >= depth:
                continue
            for nb in adj.get(nid, ()):
                if nb not in keep:
                    keep.add(nb)
                    frontier.append((nb, d + 1))
        focus_qs = _devices_qs(tenant).filter(id__in=keep)
        # The focus path rebuilds the device set from the BFS neighbourhood -
        # re-apply the RBAC row/site scope here too, or a Site-A viewer could
        # focus a known Site-B UUID and pull it + its neighbours.
        if scope_q is not None:
            focus_qs = focus_qs.filter(scope_q)
        in_scope = {str(d.id): d for d in focus_qs}

    edge_list = [
        e for e in edge_list
        if e["source"][4:] in in_scope and e["target"][4:] in in_scope
    ]

    # Panel flag: a device is a "panel" when every cabled end on it is a
    # front/rear port (pure pass-through). Uncabled devices aren't panels.
    # In collapse mode, panels whose runs were fully walked through carry no
    # ports anymore - drop them instead of showing disconnected husks
    # (panels that remain endpoints of dangling runs keep their node).
    nodes = []
    for did, d in in_scope.items():
        if collapse and did in passthrough_ids and did not in port_sets:
            continue
        by_name = port_sets.get(did, {})
        role_panel = bool(d.role_id and d.role.is_patch_panel)
        panel = role_panel or (
            bool(by_name) and all(
                k in ("front", "rear") for k, _ in by_name.values()
            )
        )
        # Merge a cabled front port with its strand's cabled rear port into
        # one continuous pass-through row (front ⇄ rear). A rear trunk pairs
        # with its first front; the rest render solo.
        consumed_rears: set[str] = set()
        ports = []
        for name, (kind, obj) in by_name.items():
            if kind != "front":
                continue
            rname = obj.rear_port.name if obj.rear_port_id else None
            if rname and rname in by_name and rname not in consumed_rears                     and by_name[rname][0] == "rear":
                consumed_rears.add(rname)
                ports.append({"name": name, "kind": kind, "pair": rname})
            else:
                ports.append({"name": name, "kind": kind})
        for name, (kind, obj) in by_name.items():
            if kind == "front" or name in consumed_rears:
                continue
            ports.append({"name": name, "kind": kind})
        nodes.append(_device_node(d, ports, panel=panel))

    if collect is not None:
        node_ids = {n["data"]["device_id"] for n in nodes}
        collect["devices"] = {
            did: d for did, d in in_scope.items() if did in node_ids
        }
        collect["ports"] = {
            did: objs for did, objs in port_objs.items() if did in node_ids
        }
        collect["pairs"] = {
            e["id"]: pair_objs.get(e["id"], []) for e in edge_list
        }

    return {"nodes": nodes, "edges": edge_list}, keep


@extend_schema(
    summary="Logical (VLAN-rail) topology - devices and VMs on their VLANs",
    tags=["topology"],
    request=None,
    parameters=[
        OpenApiParameter(name="site", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Limit physical devices to a site id."),
        OpenApiParameter(name="role", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Limit physical devices to a role id."),
        OpenApiParameter(name="vlan_group", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Limit rails to one VLAN group id."),
        OpenApiParameter(name="include_vms", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="'0' hides virtual machines (default on)."),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "`{rails, nodes}` - VLANs as rails (id, vlan_id, name, effective "
            "color, group, status) and attached devices/VMs (status_mini, "
            "role) with per-interface attachments ({rail, iface, tagged, "
            "iface_id}). Hybrid physical + virtual, RBAC-scoped."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_logical_view(request):
    """The L2 picture: VLANs as rails, everything attached to them - physical
    devices via Interface.vlan/tagged_vlans, VMs via VMInterface -
    on one hybrid diagram. Rail color = the VLAN's own color, else its
    zone's. Rails, devices and VMs carry their status (``StatusMini``) and
    devices and VMs their role (id, name, color), so the diagram colors
    them from data."""
    from .models import VLAN, Device, Interface, VirtualMachine, VMInterface

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"rails": [], "nodes": []})
    dev_q = rbac.row_filter(request.user, tenant, "device", "view")
    if dev_q is None:
        return Response({"detail": "device.view required."}, status=403)

    p = request.query_params
    devs = Device.objects.filter(tenant=tenant)
    if dev_q is not True:
        devs = devs.filter(dev_q)
    if p.get("site"):
        devs = devs.filter(site_id=p["site"])
    if p.get("role"):
        devs = devs.filter(role_id=p["role"])

    nodes: dict = {}
    rail_ids: set = set()

    def role_of(obj):
        r = obj.role if obj.role_id else None
        return (
            {"id": str(r.id), "name": r.name, "color": r.color} if r else None
        )

    def add(kind, obj, sub, vlan_id, iface, tagged, iface_id=None):
        key = f"{kind}:{obj.id}"
        n = nodes.get(key)
        if n is None:
            status = obj.status if obj.status_id else None
            n = nodes[key] = {
                "kind": kind, "id": str(obj.id), "name": obj.name,
                # ``status`` stays the display name for older readers;
                # ``status_mini`` carries its color.
                "status": status.name if status else None,
                "status_mini": _status_mini(
                    status, "device" if kind == "device" else "virtualmachine"
                ),
                "role": role_of(obj),
                "sub": sub, "attachments": [],
            }
        n["attachments"].append(
            # iface_id → the diagram's leg labels click through to the
            # interface page (device interfaces only; VM interfaces have no
            # page of their own).
            {"rail": str(vlan_id), "iface": iface, "tagged": tagged,
             "iface_id": str(iface_id) if iface_id else None}
        )
        rail_ids.add(vlan_id)

    ifaces = (
        Interface.objects.filter(device__in=devs)
        .filter(Q(vlan__isnull=False) | Q(tagged_vlans__isnull=False))
        .select_related("device__role", "device__status")
        .prefetch_related("tagged_vlans")
        .distinct()
    )
    for i in ifaces:
        d = i.device
        sub = d.role.name if d.role_id else None
        if i.vlan_id:
            add("device", d, sub, i.vlan_id, i.name, False, iface_id=i.id)
        for v in i.tagged_vlans.all():
            add("device", d, sub, v.id, i.name, True, iface_id=i.id)

    if p.get("include_vms", "1") != "0":
        vms = rbac.restrict_queryset(
            VirtualMachine.objects.filter(tenant=tenant),
            request.user, tenant, "virtualmachine", "view",
        )
        # A site filter bounds VMs too - and a VM with no site is NOT "every
        # site", it's unknown, so it drops out of a site-scoped view.
        if p.get("site"):
            vms = vms.filter(site_id=p["site"])
        vifs = (
            VMInterface.objects.filter(vm__in=vms)
            .filter(Q(vlan__isnull=False) | Q(tagged_vlans__isnull=False))
            .select_related("vm__status", "vm__cluster", "vm__role")
            .prefetch_related("tagged_vlans")
            .distinct()
        )
        for i in vifs:
            vm = i.vm
            sub = vm.cluster.name if vm.cluster_id else None
            if i.vlan_id:
                add("vm", vm, sub, i.vlan_id, i.name, False)
            for v in i.tagged_vlans.all():
                add("vm", vm, sub, v.id, i.name, True)

    vlans = (
        VLAN.objects.filter(id__in=rail_ids)
        .select_related("zone", "group", "status")
        .order_by("vlan_id")
    )
    if p.get("vlan_group"):
        vlans = vlans.filter(group_id=p["vlan_group"])
    kept = {str(v.id) for v in vlans}
    rails = [
        {
            "id": str(v.id),
            "vlan_id": v.vlan_id,
            "name": v.name,
            "color": v.color or (v.zone.color if v.zone_id else ""),
            "group": v.group.name if v.group_id else None,
            "status": _status_mini(v.status if v.status_id else None, "vlan"),
        }
        for v in vlans
    ]
    out_nodes = []
    for n in nodes.values():
        n["attachments"] = [a for a in n["attachments"] if a["rail"] in kept]
        if n["attachments"]:
            out_nodes.append(n)
    out_nodes.sort(key=lambda n: (n["kind"], natural_key(n["name"])))
    return Response({"rails": rails, "nodes": out_nodes})


@extend_schema(
    summary="Compact topology summary (adjacency, site rollups) for programmatic/AI use",
    tags=["topology"],
    request=None,
    parameters=[
        OpenApiParameter(name="site", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Filter devices by site id."),
        OpenApiParameter(name="role", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Filter devices by role id."),
        OpenApiParameter(name="status", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Filter devices by status id."),
        OpenApiParameter(name="tag", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Filter devices by tag slug."),
        OpenApiParameter(name="collapse_panels", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Walk patch panels through (default '1')."),
    ],
    responses={
        200: OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description=(
                "`{device_count, cable_count, sites, inter_site_links, adjacency}` "
                "- the cabling graph without port-level noise, sized for an LLM "
                "context or scripted analysis. Same filters and RBAC scope as "
                "`/api/topology/`."
            ),
        ),
        400: OpenApiResponse(description="`{detail: \"<param>: not a valid id\"}`"),
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_summary_view(request):
    """The topology as plain facts: per-device neighbor lists (cable counts,
    media types, panels crossed) plus site rollups and inter-site link
    aggregates. Built from the same collapse walk as the graph endpoint, so
    an AI reading this sees exactly what the map shows."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"device_count": 0, "cable_count": 0, "sites": [],
                         "inter_site_links": [], "adjacency": []})
    dev_q = rbac.row_filter(request.user, tenant, "device", "view")
    if dev_q is None:
        return Response({"detail": "device.view required."}, status=403)
    scope_q = None if dev_q is True else dev_q

    p = request.query_params
    collapse = p.get("collapse_panels", "1") != "0"
    g = _build_graph(tenant, device_filter_q=_filter_q(p),
                     collapse=collapse, scope_q=scope_q)

    name_of, site_of, role_of = {}, {}, {}
    for n in g["nodes"]:
        d = n["data"]
        name_of[n["id"]] = d["name"]
        site_of[n["id"]] = d["site"] or "Unassigned"
        role_of[n["id"]] = d["role"]["name"] if d.get("role") else None

    # One entry per device pair, whatever the cable count.
    pairs: dict = {}
    for e in g["edges"]:
        key = tuple(sorted((e["source"], e["target"])))
        ent = pairs.setdefault(key, {"cables": 0, "types": set(), "via": set()})
        ent["cables"] += 1
        t = e["data"].get("cable_type")
        if t:
            ent["types"].add(t)
        for v in e["data"].get("via") or []:
            ent["via"].add(v)

    neighbors: dict = {nid: [] for nid in name_of}
    site_links: dict = {}
    for (a, b), ent in pairs.items():
        row = {"cables": ent["cables"], "types": sorted(ent["types"]),
               "via_panels": sorted(ent["via"])}
        neighbors[a].append({"device": name_of[b], **row})
        neighbors[b].append({"device": name_of[a], **row})
        sa, sb = site_of[a], site_of[b]
        if sa != sb:
            skey = tuple(sorted((sa, sb)))
            site_links[skey] = site_links.get(skey, 0) + ent["cables"]

    site_counts: dict = {}
    for s in site_of.values():
        site_counts[s] = site_counts.get(s, 0) + 1

    adjacency = [
        {
            "device": name_of[nid],
            "role": role_of[nid],
            "site": site_of[nid],
            "neighbors": sorted(nbrs, key=lambda r: natural_key(r["device"])),
        }
        for nid, nbrs in neighbors.items()
    ]
    adjacency.sort(key=lambda r: natural_key(r["device"]))
    return Response({
        "device_count": len(name_of),
        "cable_count": len(g["edges"]),
        "sites": [
            {"name": s, "devices": c}
            for s, c in sorted(site_counts.items())
        ],
        "inter_site_links": [
            {"a": a, "b": b, "cables": c}
            for (a, b), c in sorted(site_links.items())
        ],
        "adjacency": adjacency,
    })


# ─── Grouped map (#343) ─────────────────────────────────────────────────────
#
# One node per site/location, one edge per group pair - computed without the
# device graph, so its cost follows the number of groups, not the tenant. The
# result is exactly what grouping the device graph gives:
#
# * a node counts the graph's device nodes in its group: every device in the
#   filter and RBAC scope (an aggregate query), less the pure pass-through
#   panels the collapse walks through and drops;
# * an edge counts the graph's cable edges between two groups, in the order
#   the graph lists them.
#
# Only cables with an end on a device that has a cabled front/rear port can be
# walked through a panel or decide whether a panel drops. Those are loaded as
# plain rows and run through the same ``_collapse`` walk; every other cable is
# a plain device-to-device hop, counted in SQL.

_GROUP_ATTRS = ("site", "location")
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class _Pt:
    """A cable end (or a device) for the grouped map's panel walk: the
    attributes ``_collapse`` reads, nothing else."""

    __slots__ = ("id", "name", "device_id", "device", "is_splitter",
                 "rear_port", "rear_port_position")

    def __init__(self, id, device=None, is_splitter=False, rear_port=None,
                 rear_port_position=1):
        self.id = id
        self.name = id  # a via label only, never read here
        self.device = device
        self.device_id = device.id if device is not None else None
        self.is_splitter = is_splitter
        self.rear_port = rear_port
        self.rear_port_position = rear_port_position


def _scoped_devices(tenant, device_filter_q, scope_q):
    qs = Device.objects.filter(tenant=tenant)
    if device_filter_q is not None:
        qs = qs.filter(device_filter_q)
    if scope_q is not None:
        qs = qs.filter(scope_q)
    return qs


def _order_key(created_at, cable_id, rank):
    """Where an edge sits in the device graph's edge order: newest cable
    first, then cable id, then its place among the cable's hops."""
    return (_EPOCH - created_at, uuid.UUID(str(cable_id)).int, rank)


def _panel_cable_ids(tenant):
    """Ids of this tenant's cables with an end on a device that has a cabled
    front or rear port."""
    # Ids first, then one indexable lookup per point kind: nested as
    # subqueries, the planner may re-run them per termination.
    ends = CableTermination.objects.filter(cable__tenant=tenant).order_by()
    found = ends.filter(front_port__isnull=False).values_list(
        "front_port__device_id", flat=True
    ).union(
        ends.filter(rear_port__isnull=False).values_list(
            "rear_port__device_id", flat=True
        )
    )
    panels = list(found)
    if not panels:
        return set()
    parts = [
        ends.filter(**{f"{attr}__device_id__in": panels})
        .values_list("cable_id", flat=True)
        for attr in _DEVICE_POINT_ATTRS
    ]
    return set(parts[0].union(*parts[1:]))


def _panel_cable_edges(tenant, cable_ids, scope_q):
    """The device graph's edges on ``cable_ids`` and the panels it drops,
    from rows rather than model objects.

    Returns ``({(device id, device id, cable id): (order key, cable type)},
    dropped device ids)``."""
    attrs = [a for a in _POINT_ATTRS if a != "power_feed"]
    cols = ["cable_id", "cable__created_at", "cable__type", "end"]
    for attr in attrs:
        cols.append(f"{attr}_id")
        cols.append("circuit_termination__circuit_id"
                    if attr == "circuit_termination" else f"{attr}__device_id")
    cols += ["front_port__rear_port_id", "front_port__rear_port_position",
             "front_port__rear_port__is_splitter", "rear_port__is_splitter"]
    fr_rear, fr_pos, fr_split, rp_split = range(len(cols) - 4, len(cols))
    rows = (
        CableTermination.objects.filter(cable_id__in=cable_ids)
        .order_by("-cable__created_at", "cable_id", "end", "created_at", "id")
        .values_list(*cols)
    )

    devices: dict = {}
    rears: dict = {}

    def device(did):
        d = devices.get(did)
        if d is None:
            d = devices[did] = _Pt(did)
        return d

    # Hops in the device graph's order (``_links_from_cables``); a circuit
    # end stands in as its circuit, like the shim there.
    links = []
    cab, a_ends, b_ends = None, [], []

    def flush():
        for ka, pa in a_ends:
            for kb, pb in b_ends:
                if pa.device_id != pb.device_id:
                    links.append((cab, pa.device, pa, ka, pb.device, pb, kb))

    for row in rows:
        if cab is None or row[0] != cab[0]:
            if cab is not None:
                flush()
            cab, a_ends, b_ends = (row[0], row[1], row[2]), [], []
        for i, attr in enumerate(attrs):
            pid, owner = row[4 + 2 * i], row[5 + 2 * i]
            if pid is None:
                continue
            if owner is None:
                break
            if attr == "front_port":
                rid = row[fr_rear]
                rear = rears.get(rid)
                if rear is None and rid is not None:
                    rear = rears[rid] = _Pt(rid, is_splitter=row[fr_split])
                port = _Pt(pid, device(owner), rear_port=rear,
                           rear_port_position=row[fr_pos])
            else:
                port = _Pt(pid, device(owner),
                           is_splitter=attr == "rear_port" and bool(row[rp_split]))
            (a_ends if row[3] == "A" else b_ends).append((attr, port))
            break
    if cab is not None:
        flush()

    if scope_q is not None:
        reached = {d for link in links for d in (link[1].id, link[4].id)}
        allowed = set(
            Device.objects.filter(tenant=tenant, id__in=reached)
            .filter(scope_q).values_list("id", flat=True)
        )
        links = [
            link for link in links
            if link[1].id in allowed and link[4].id in allowed
        ]

    raw_kinds: dict = {}
    for _cab, da, _pa, ka, db, _pb, kb in links:
        raw_kinds.setdefault(da.id, set()).add(ka)
        raw_kinds.setdefault(db.id, set()).add(kb)
    passthrough = {
        did for did, kinds in raw_kinds.items()
        if kinds <= {"front_port", "rear_port"}
    }

    # A rear port's front ports, for the walk's rear → front strand.
    rear_ends = {
        link[i].id for link in links for i, k in ((2, 3), (5, 6))
        if link[k] == "rear_port"
    }
    fronts: dict = {}
    if rear_ends:
        for fid, rid, start, span in (
            FrontPort.objects.filter(rear_port_id__in=rear_ends)
            .order_by("-rear_port_position")
            .values_list("id", "rear_port_id", "rear_port_position", "positions")
        ):
            fronts.setdefault(rid, []).append((fid, start, span))

    def strand(port, kind, position=1):
        """``strand_of`` over the loaded rows. A splitter side never gets
        here: the walk stops at it first."""
        if kind == "front_port":
            if port.rear_port is None:
                return None
            return ("rear_port", port.rear_port,
                    port.rear_port_position + (position - 1))
        if kind == "rear_port" and not port.is_splitter:
            for fid, start, span in fronts.get(port.id, ()):
                if start <= position:
                    if start + (span or 1) - 1 >= position:
                        return ("front_port", _Pt(fid), position - start + 1)
                    return None
        return None

    out, _ = _collapse(links, strand_of=strand)

    edges: dict = {}
    noted = set()
    for idx, (cab, da, _pa, _ka, db, _pb, _kb, _vias) in enumerate(out):
        noted.add(da.id)
        noted.add(db.id)
        lo, hi = sorted((da.id, db.id), key=str)
        key = (lo, hi, cab[0])
        if key not in edges:
            edges[key] = (_order_key(cab[1], cab[0], idx), cab[2])
    return edges, passthrough - noted


_PLAIN_EDGES_SQL = """
WITH f AS MATERIALIZED (
    SELECT DISTINCT sub.id, sub.grp FROM ({f_sql}) AS sub (id, grp)
),
-- Each cable's ends on devices in scope, A and B apart, in the order the
-- device graph pairs them. Grouped per cable rather than self-joined, so
-- the plan stays linear whatever the planner thinks of the row counts.
per_cable AS (
    SELECT t.cable_id,
           array_agg(f.id ORDER BY t.created_at, t.id)
               FILTER (WHERE t.{end} = 'A') AS a_dev,
           array_agg(f.grp ORDER BY t.created_at, t.id)
               FILTER (WHERE t.{end} = 'A') AS a_grp,
           array_agg(f.id ORDER BY t.created_at, t.id)
               FILTER (WHERE t.{end} = 'B') AS b_dev,
           array_agg(f.grp ORDER BY t.created_at, t.id)
               FILTER (WHERE t.{end} = 'B') AS b_grp
    FROM {term} t
    JOIN {cable} c ON c.id = t.cable_id
    {joins}
    JOIN f ON f.id = COALESCE({devices})
    WHERE c.tenant_id = %s
      AND t.cable_id NOT IN (SELECT unnest(%s::uuid[]))
    GROUP BY t.cable_id
),
links AS (
    SELECT p.cable_id,
           LEAST(a.dev, b.dev) AS lo, GREATEST(a.dev, b.dev) AS hi,
           CASE WHEN a.dev < b.dev THEN a.grp ELSE b.grp END AS glo,
           CASE WHEN a.dev < b.dev THEN b.grp ELSE a.grp END AS ghi,
           a.i * 100000 + b.i AS rk
    FROM per_cable p
    CROSS JOIN LATERAL unnest(p.a_dev, p.a_grp) WITH ORDINALITY AS a (dev, grp, i)
    CROSS JOIN LATERAL unnest(p.b_dev, p.b_grp) WITH ORDINALITY AS b (dev, grp, i)
    WHERE a.dev <> b.dev AND a.grp IS DISTINCT FROM b.grp
),
edges AS (
    SELECT DISTINCT ON (cable_id, lo, hi) cable_id, glo, ghi, rk
    FROM links ORDER BY cable_id, lo, hi, rk
)
SELECT e.glo, e.ghi, c.type, COUNT(*),
       (array_agg(c.created_at ORDER BY c.created_at DESC, c.id, e.rk))[1],
       (array_agg(c.id ORDER BY c.created_at DESC, c.id, e.rk))[1],
       (array_agg(e.rk ORDER BY c.created_at DESC, c.id, e.rk))[1]
FROM edges e JOIN {cable} c ON c.id = e.cable_id
GROUP BY e.glo, e.ghi, c.type
"""


def _plain_cable_edges(tenant, f_qs, attr, skip_cable_ids):
    """``(group, group, cable type, edge count, first edge's cable
    created_at, cable id, rank)`` per group pair and type: the device
    graph's edges between two groups on the cables outside
    ``skip_cable_ids``, which are plain device-to-device hops. One query;
    the device scope is ``f_qs``'s own SQL. A scope Django proves empty
    (an RBAC constraint such as ``name__in: []``) has no SQL to embed: no
    devices, so no edges (#368)."""
    qn = connection.ops.quote_name
    term = CableTermination._meta
    try:
        f_sql, f_params = (
            f_qs.order_by().values_list("id", f"{attr}_id").query.sql_with_params()
        )
    except EmptyResultSet:
        return []
    devices, joins = [], []
    for i, point in enumerate(_DEVICE_POINT_ATTRS):
        field = term.get_field(point)
        model = field.related_model._meta
        joins.append(
            f"LEFT JOIN {qn(model.db_table)} p{i} ON p{i}.id = t.{qn(field.column)}"
        )
        devices.append(f"p{i}.{qn(model.get_field('device').column)}")
    sql = _PLAIN_EDGES_SQL.format(
        f_sql=f_sql,
        end=qn(term.get_field("end").column),
        devices=", ".join(devices),
        term=qn(term.db_table),
        cable=qn(Cable._meta.db_table),
        joins="\n    ".join(joins),
    )
    params = [*f_params, str(tenant.pk), [str(c) for c in skip_cable_ids]]
    with connection.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def _grouped_graph(tenant, group_by, device_filter_q=None, collapse=True,
                   scope_q=None):
    """The device graph aggregated by site or location: one node per group
    (device count + role breakdown), one edge per group pair carrying the
    cable count and media types. Counts only devices in the filter and RBAC
    scope, so hidden devices never leak in. A fixed number of queries,
    whatever the tenant's size (#343)."""
    attr = group_by if group_by in _GROUP_ATTRS else "location"
    f_qs = _scoped_devices(tenant, device_filter_q, scope_q)

    def gid(raw):
        return str(raw) if raw is not None else "none"

    agg: dict = {}

    def add_edge(a, b, ctype, count, order):
        if a == b:
            return  # intra-group cabling stays inside the group card
        ent = agg.setdefault(
            tuple(sorted((a, b))),
            {"cable_count": 0, "types": set(), "first": order},
        )
        ent["cable_count"] += count
        if ctype:
            ent["types"].add(ctype)
        ent["first"] = min(ent["first"], order)

    # Cables a panel walk can touch: the device graph's own walk, on rows.
    dropped: set = set()
    panel_cables = _panel_cable_ids(tenant) if collapse else set()
    if panel_cables:
        edges, dropped = _panel_cable_edges(tenant, panel_cables, scope_q)
        ends = {d for key in edges for d in key[:2]}
        group_of = {
            did: gid(g) for did, g in
            f_qs.filter(id__in=ends).values_list("id", f"{attr}_id")
        }
        for (lo, hi, _cid), (order, ctype) in edges.items():
            if lo in group_of and hi in group_of:
                add_edge(group_of[lo], group_of[hi], ctype, 1, order)

    # Every other cable: device-to-device hops, counted in SQL.
    for glo, ghi, ctype, count, created, cid, rank in _plain_cable_edges(
        tenant, f_qs, attr, panel_cables
    ):
        add_edge(gid(glo), gid(ghi), ctype, count, _order_key(created, cid, rank))

    # Devices per group and role, less the panels the walk dropped; rows in
    # the order of their first device by name, as the graph lists devices.
    rows = (
        Device.objects.filter(tenant=tenant, id__in=f_qs.values("id"))
        .exclude(id__in=dropped)
        .order_by()
        .values(f"{attr}_id", f"{attr}__name", "role_id", "role__name",
                "role__color")
        .annotate(n=Count("id"), first=Min("name"))
        .order_by("first")
    )
    groups: dict = {}
    for row in rows:
        g = row[f"{attr}_id"]
        grp = groups.setdefault(gid(g), {
            "name": row[f"{attr}__name"] if g is not None else "Unassigned",
            "device_count": 0, "roles": {},
        })
        grp["device_count"] += row["n"]
        if row["role_id"] is not None:
            r = grp["roles"].setdefault(row["role__name"], {
                "name": row["role__name"], "color": row["role__color"],
                "count": 0,
            })
            r["count"] += row["n"]

    nodes = [
        {
            "id": f"grp:{key}",
            "type": "group",
            "data": {
                "group_id": key if key != "none" else None,
                "kind": group_by,
                "name": v["name"],
                "device_count": v["device_count"],
                "roles": sorted(
                    v["roles"].values(), key=lambda r: (-r["count"], r["name"])
                ),
            },
        }
        for key, v in sorted(groups.items(), key=lambda kv: natural_key(kv[1]["name"]))
    ]
    edges = [
        {
            "id": f"ge:{a}:{b}",
            "source": f"grp:{a}",
            "target": f"grp:{b}",
            "type": "group",
            "data": {"cable_count": v["cable_count"], "types": sorted(v["types"])},
        }
        for (a, b), v in sorted(agg.items(), key=lambda kv: kv[1]["first"])
    ]
    return {"nodes": nodes, "edges": edges}


# ─── Virtual chassis ────────────────────────────────────────────────────────
#
# A chassis is its own RBAC type: its name and membership reach the map only
# for a caller who may view it, and only for the members they may view as
# devices (the graph is already bounded to those).

def _chassis_scope(user, tenant):
    """The chassis the caller may view in ``tenant``: a queryset, or None
    when they may view none."""
    vc_q = rbac.row_filter(user, tenant, "virtualchassis", "view")
    if vc_q is None:
        return None
    qs = VirtualChassis.objects.filter(tenant=tenant)
    return qs if vc_q is True else qs.filter(vc_q)


def _with_chassis(graph, user, tenant):
    """Put ``vc: {id, name, position, master}`` on every device node whose
    chassis the caller may view - one query, whatever the map's size."""
    chassis = _chassis_scope(user, tenant)
    ids = [
        n["data"]["device_id"] for n in graph.get("nodes", ())
        if n.get("type") == "device" and n["data"].get("device_id")
    ]
    if chassis is None or not ids:
        return graph
    rows = (
        Device.objects.filter(
            tenant=tenant, id__in=ids, virtual_chassis__in=chassis
        )
        .values_list("id", "vc_position", "virtual_chassis_id",
                     "virtual_chassis__name", "virtual_chassis__master_id")
    )
    of = {
        str(dev): {
            "id": str(vc), "name": name, "position": pos,
            "master": master == dev,
        }
        for dev, pos, vc, name, master in rows
    }
    for n in graph["nodes"]:
        vc = of.get(n["data"].get("device_id")) if n.get("type") == "device" else None
        if vc:
            n["data"]["vc"] = vc
    return graph


def _placed_chassis_q(user, tenant, chassis_ids):
    """The devices of the placed chassis (``chassis=``) the caller may view,
    as a filter: members as they are now, so a member added since the map
    was saved is on it and one removed is not. None when none count."""
    if not chassis_ids:
        return None
    chassis = _chassis_scope(user, tenant)
    if chassis is None:
        return None
    return Q(virtual_chassis__in=chassis.filter(id__in=chassis_ids))


def _filter_q(params):
    """The device filter from ``site location role status tag``; a malformed
    id is a 400 (``ParseError``)."""
    q = Q()
    for param in ("site", "location", "role", "status"):
        value = _uuid_param(params, param)
        if value:
            q &= Q(**{f"{param}_id": value})
    tag = params.get("tag")
    if tag:
        if not isinstance(tag, str):
            raise ParseError("tag: not a valid slug")
        q &= Q(tags__slug=tag)
    return q


_GRAPH_200 = OpenApiResponse(
    response=OpenApiTypes.OBJECT,
    description=(
        "`{nodes, edges}` for the React Flow map - device stencil-card "
        "nodes with cabled ports and cable edges (port-to-port pairs, via "
        "panels), scoped to the caller's device.view grant. With `include`, "
        "also `meta` and the enrichment each token names."
    ),
)
_GRAPH_400 = OpenApiResponse(
    description=(
        "A malformed id in `device`, `devices`, `chassis`, `site`, "
        "`location`, `role` or `status` "
        "(`{detail: \"<param>: not a valid id\"}`), more than "
        f"{MAX_DEVICE_SET:,} `devices` or {MAX_CHASSIS_SET:,} `chassis`, or "
        "(POST) a body that is not a JSON object."
    ),
)


@extend_schema(
    methods=["GET"],
    summary="Network topology graph (devices as nodes, cables as edges)",
    tags=["topology"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="collapse_panels",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "Walk patch panels through end-to-end (default '1'); '0' shows "
                "raw physical hops with panels as nodes."
            ),
        ),
        OpenApiParameter(
            name="device",
            type=OpenApiTypes.UUID,
            location=OpenApiParameter.QUERY,
            description="Focus the graph on one device's neighbourhood (by id).",
        ),
        OpenApiParameter(
            name="depth",
            type=OpenApiTypes.INT,
            location=OpenApiParameter.QUERY,
            description=f"BFS depth around the focus device (1–{MAX_DEPTH}, default 1).",
        ),
        OpenApiParameter(
            name="site",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by site id.",
        ),
        OpenApiParameter(
            name="location",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by location id.",
        ),
        OpenApiParameter(
            name="role",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by role id.",
        ),
        OpenApiParameter(
            name="status",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by status id.",
        ),
        OpenApiParameter(
            name="tag",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Filter devices by tag slug.",
        ),
        OpenApiParameter(
            name="group_by",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "'site' or 'location': aggregate to one node per group "
                "(device count + role breakdown) with cable-count edges "
                "between groups. Ignores device/depth focus and `include`."
            ),
        ),
        OpenApiParameter(
            name="devices",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "Comma-separated device ids: the induced subgraph on exactly "
                "this set (the custom-map builder). Overrides focus/filters. "
                f"At most {MAX_DEVICE_SET:,} ids; POST the query for large sets."
            ),
        ),
        OpenApiParameter(
            name="chassis",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "With `devices`: comma-separated virtual chassis ids whose "
                "members join the set, as they are now (the chassis the "
                "caller may view; unknown ids are ignored). At most "
                f"{MAX_CHASSIS_SET:,} ids."
            ),
        ),
        OpenApiParameter(
            name="include",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "Comma-separated opt-in enrichment: `card`, `link_ips`, "
                "`photo`. Unknown tokens are ignored. Adds `meta` to the "
                "response."
            ),
        ),
        OpenApiParameter(
            name="card_fields",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description=(
                "Comma-separated card lines of a saved view, over the role "
                "and global lists (`include=card`). Empty = name only."
            ),
        ),
    ],
    responses={200: _GRAPH_200, 400: _GRAPH_400},
)
@extend_schema(
    methods=["POST"],
    summary="Network topology graph, the query as a JSON body",
    tags=["topology"],
    request=inline_serializer(
        name="TopologyQuery",
        fields={
            "devices": serializers.ListField(
                child=serializers.UUIDField(), required=False,
                max_length=MAX_DEVICE_SET,
            ),
            "chassis": serializers.ListField(
                child=serializers.UUIDField(), required=False,
                max_length=MAX_CHASSIS_SET,
            ),
            "device": serializers.UUIDField(required=False),
            "depth": serializers.IntegerField(
                required=False, min_value=1, max_value=MAX_DEPTH
            ),
            "site": serializers.UUIDField(required=False),
            "location": serializers.UUIDField(required=False),
            "role": serializers.UUIDField(required=False),
            "status": serializers.UUIDField(required=False),
            "tag": serializers.CharField(required=False),
            "collapse_panels": serializers.BooleanField(required=False),
            "group_by": serializers.ChoiceField(
                choices=["site", "location"], required=False
            ),
            "include": serializers.ListField(
                child=serializers.ChoiceField(
                    choices=["card", "link_ips", "photo"]
                ),
                required=False,
            ),
            "card_fields": serializers.ListField(
                child=serializers.CharField(), required=False
            ),
        },
    ),
    responses={200: _GRAPH_200, 400: _GRAPH_400},
)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def topology_view(request):
    """The map. POST is a read too: it takes the same query as a JSON body,
    for device sets too long for a URL."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"nodes": [], "edges": []})
    # Row/site scope: a scoped grant limits the graph to viewable devices;
    # None (denied) → 403, True (unscoped) → no extra filter.
    dev_q = rbac.row_filter(request.user, tenant, "device", "view")
    if dev_q is None:
        return Response({"detail": "device.view required."}, status=403)
    scope_q = None if dev_q is True else dev_q

    p = _query_params(request)
    collapse = _flag_param(p, "collapse_panels")
    # Every id is parsed before any query: a malformed one is a 400, even in
    # a mode that ignores it.
    focus = _uuid_param(p, "device")
    device_ids = _uuid_list_param(p, "devices")
    chassis_ids = _uuid_list_param(p, "chassis", limit=MAX_CHASSIS_SET)
    filter_q = _filter_q(p)
    try:
        depth = max(1, min(MAX_DEPTH, int(p.get("depth", 1))))
    except (TypeError, ValueError, OverflowError):
        # OverflowError: a JSON body's 1e999 parses as infinity.
        depth = 1

    # Aggregated mode: one node per site/location. Focus is device-level and
    # doesn't apply here, nor does enrichment (there are no device cards).
    group_by = p.get("group_by")
    if group_by in ("site", "location"):
        return Response(_grouped_graph(
            tenant, group_by,
            device_filter_q=filter_q,
            collapse=collapse,
            scope_q=scope_q,
        ))
    include = _include_param(p)
    card_fields = _card_fields_param(p)

    # Explicit device set - the custom-map builder's induced subgraph. The
    # parameter's PRESENCE selects the mode: an empty value is an empty map
    # (a builder you just opened), never a fall-through to the full graph.
    custom_set = "devices" in p and p.get("devices") is not None
    set_q = None
    if custom_set:
        focus = None
        set_q = Q(id__in=device_ids)
        placed = _placed_chassis_q(request.user, tenant, chassis_ids)
        if placed is not None:
            set_q |= placed

    # The enrichers read the objects the assembly already loaded instead of
    # querying them again; nobody else pays for the bookkeeping.
    collect = {} if include else None
    graph = _build_graph(
        tenant,
        device_filter_q=(
            set_q if custom_set
            else (filter_q if not focus else None)
        ),
        focus_id=focus,
        depth=depth,
        collapse=collapse,
        scope_q=scope_q,
        collect=collect,
    )
    _with_chassis(graph, request.user, tenant)
    if include:
        from .topology_enrich import enrich

        graph["meta"] = enrich(
            graph, collect, include,
            request=request, user=request.user, tenant=tenant,
            card_fields=card_fields,
        )
    return Response(graph)


@extend_schema(
    summary="Virtual chassis the Diagram can place",
    tags=["topology"],
    parameters=[
        OpenApiParameter(
            name="q",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Only chassis whose name contains this.",
        ),
    ],
    responses={
        200: inline_serializer(
            name="TopologyChassisList",
            fields={
                "results": serializers.ListField(
                    child=inline_serializer(
                        name="TopologyChassis",
                        fields={
                            "id": serializers.UUIDField(),
                            "name": serializers.CharField(),
                            "master_id": serializers.UUIDField(allow_null=True),
                            "members": serializers.ListField(
                                child=inline_serializer(
                                    name="TopologyChassisMember",
                                    fields={
                                        "id": serializers.UUIDField(),
                                        "name": serializers.CharField(),
                                        "vc_position": serializers.IntegerField(
                                            allow_null=True
                                        ),
                                    },
                                )
                            ),
                        },
                    )
                )
            },
        ),
        403: OpenApiResponse(
            description="No view on devices or on virtual chassis."
        ),
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def topology_chassis_view(request):
    """The chassis a Diagram palette offers: those the caller may view, each
    with the members they may view as devices (by member number, then
    name). A chassis with no such member is left out; its master's id only
    when that member is one of them."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"results": []})
    dev_q = rbac.row_filter(request.user, tenant, "device", "view")
    chassis = _chassis_scope(request.user, tenant)
    if dev_q is None or chassis is None:
        return Response(
            {"detail": "device.view and virtualchassis.view required."},
            status=403,
        )
    q = str(request.query_params.get("q") or "").strip()[:128]
    if q:
        chassis = chassis.filter(name__icontains=q)
    members = Device.objects.filter(tenant=tenant)
    if dev_q is not True:
        members = members.filter(dev_q)
    members = members.only("id", "name", "vc_position", "virtual_chassis")
    chassis = (
        chassis.only("id", "name", "master_id")
        .prefetch_related(Prefetch("members", queryset=members, to_attr="seen"))
        .order_by(natural("name"), "id")
    )
    results = []
    for vc in chassis:
        seen = sorted(
            vc.seen,
            key=lambda d: (
                d.vc_position is None, d.vc_position or 0, natural_key(d.name)
            ),
        )
        if not seen:
            continue
        ids = {d.id for d in seen}
        results.append({
            "id": str(vc.id),
            "name": vc.name,
            "master_id": str(vc.master_id) if vc.master_id in ids else None,
            "members": [
                {"id": str(d.id), "name": d.name, "vc_position": d.vc_position}
                for d in seen
            ],
        })
    return Response({"results": results})


def device_paths(device, viewable_ids=None):
    """Flat end-to-end runs for every cabled port on a device - the cable
    page's path-strip design, one strip per port. Each run alternates
    ``seg`` (a cable) and ``chip`` (a device + the ports the run used on it);
    panels are crossed front⇄rear like the topology collapse.

    ``viewable_ids`` (a set of device pks, or None = unrestricted) bounds which
    devices' names/ids are revealed - a run that crosses into a device the
    caller can't view renders a redacted ``(restricted)`` chip instead of
    leaking its name/ports (site-scope safe)."""
    from .fiber_colors import fiber_color, is_fiber_type
    from .models import FiberSettings

    links = _physical_links(device.tenant)
    palette = FiberSettings.for_tenant(device.tenant).colors
    by_port = {}
    for cab, da, pa, ka, db, pb, kb in links:
        by_port.setdefault((ka, pa.id), []).append((cab, db, pb, kb))
        by_port.setdefault((kb, pb.id), []).append((cab, da, pa, ka))

    def seg(cab, strand=None):
        s = {
            "t": "seg",
            "cable_id": str(cab.id),
            "cable_numid": cab.numid,
            "label": cab.type or "cable",
            "cable_label": cab.label or None,
            "color": cab.color or None,
            "fiber": is_fiber_type(cab.type),
            "fiber_count": cab.fiber_count or None,
        }
        # On a strand-bearing fibre trunk, tag which strand this run threads
        # through (its colour). Skip 2-strand duplex patch cords - the strand
        # there is just TX/RX, not informative on the path.
        if strand and is_fiber_type(cab.type) and (cab.fiber_count or 0) > 2:
            col = fiber_color(strand, palette)
            s["strand"] = strand
            s["strand_color"] = {"name": col["name"], "hex": col["hex"]}
        return s

    def chip(dev, port_pairs, panel):
        """``port_pairs`` = [(port_obj, kind)] - interface ports carry their
        id so the frontend can make the name itself a click target."""
        # A circuit end: the "device" is the circuit, the chip links there.
        if any(k == "circuit_termination" for _, k in port_pairs):
            return {
                "t": "chip", "device_id": str(dev.id), "device": dev.name,
                "ports": [{"name": p.name, "interface_id": None}
                          for p, _ in port_pairs],
                "panel": panel, "circuit": True,
            }
        # Redact devices outside the caller's view scope - a physical run can
        # cross into another site's device; show that a hop exists without
        # leaking its identity.
        if viewable_ids is not None and dev.id not in viewable_ids:
            return {"t": "chip", "device_id": None, "device": "(restricted)",
                    "ports": [], "panel": panel, "restricted": True}
        return {
            "t": "chip",
            "device_id": str(dev.id),
            "device": dev.name,
            "ports": [
                {
                    "name": p.name,
                    # Printed name ("X1-P1") for panels whose names stay
                    # template-generic - the trace shows both.
                    "label": getattr(p, "label", "") or "",
                    "interface_id": str(p.id) if k == "interface" else None,
                }
                for p, k in port_pairs
            ],
            "panel": panel,
        }

    def trace_outward(dev, port, kind, position, seen):
        """Follow front⇄rear pass-throughs outward from a cabled hop until a real
        endpoint (or a dead-end). Returns ``(steps, complete)`` - steps starts
        with a chip and alternates chip/seg, always ending on a chip."""
        steps = []
        complete = True
        while True:
            if kind not in ("front_port", "rear_port"):
                steps.append(chip(dev, [(port, kind)], False))
                break
            if _is_splitter_side(kind, port):
                # A splitter legitimately ends the run - its N outputs are
                # separate runs, not a continuation.
                steps.append(chip(dev, [(port, kind)], False))
                break
            if port.id in seen:
                complete = False
                steps.append(chip(dev, [(port, kind)], True))
                break
            seen.add(port.id)
            strand = _strand_of(port, kind, position)
            if strand is None:
                complete = False
                steps.append(chip(dev, [(port, kind)], True))
                break
            skind, sport, spos = strand
            hops = by_port.get((skind, sport.id), [])
            steps.append(chip(dev, [(port, kind), (sport, skind)], True))
            if not hops:
                complete = False  # the strand's far side is uncabled
                break
            cab2, dev, port, kind = hops[0]
            steps.append(seg(cab2, strand=spos))
            position = spos
        return steps, complete

    runs = []
    seen_runs = set()  # frozenset(cable_ids) → drop mirror-image duplicates
    for cab, da, pa, ka, db, pb, kb in links:
        # Orient so this device is the origin; a cable touching it on both
        # ends yields two runs (one per port), which is what you'd expect.
        for (odev, oport, okind, fdev, fport, fkind) in (
            (da, pa, ka, db, pb, kb),
            (db, pb, kb, da, pa, ka),
        ):
            if odev.id != device.id:
                continue

            is_panel = okind in ("front_port", "rear_port") and not _is_splitter_side(
                okind, oport
            )
            seen = {oport.id}

            if is_panel:
                # This device IS a patch panel: draw the whole run *through* it -
                # the panel sits mid-path (highlighted), with the far endpoints on
                # each side - instead of a fragment that starts at the panel.
                right, a_complete = trace_outward(fdev, fport, fkind, 1, seen)
                left = []
                b_complete = True
                ports_here = [(oport, okind)]
                partner = _strand_of(oport, okind, 1)
                if partner is not None:
                    skind, sport, spos = partner
                    ports_here.append((sport, skind))
                    seen.add(sport.id)
                    bhops = by_port.get((skind, sport.id), [])
                    if bhops:
                        cabB, bdev, bport, bkind = bhops[0]
                        bsteps, b_complete = trace_outward(bdev, bport, bkind, spos, seen)
                        # Reverse so the far end reads left→panel.
                        left = list(reversed([seg(cabB, strand=spos), *bsteps]))
                    else:
                        b_complete = False  # partner side uncabled
                panel_chip = chip(odev, ports_here, True)
                panel_chip["origin"] = True
                steps = [*left, panel_chip, seg(cab), *right]
                complete = a_complete and b_complete
            else:
                # Endpoint origin (interface / console / power / splitter): start
                # at this device's port and trace one way to the far end.
                origin_chip = chip(odev, [(oport, okind)], False)
                origin_chip["origin"] = True
                right, complete = trace_outward(fdev, fport, fkind, 1, seen)
                steps = [origin_chip, seg(cab), *right]

            # A panel's run is discovered from both its front and rear port (and
            # both cable orientations) - collapse those to one by cable set.
            cable_ids = frozenset(
                s["cable_id"] for s in steps if s["t"] == "seg" and s.get("cable_id")
            )
            # Identify a run by its cables AND the ports it touches. The
            # ports set collapses mirror images (a panel's run found from its
            # front and again from its rear is one run) while keeping a
            # breakout's legs apart - they share a cable but end elsewhere.
            touched = frozenset(
                (st.get("device_id"), p["name"])
                for st in steps
                if st["t"] == "chip"
                for p in st.get("ports", [])
            )
            run_key = (cable_ids, touched)
            if cable_ids and run_key in seen_runs:
                continue
            seen_runs.add(run_key)

            origin = {"name": oport.name, "kind": _KIND_OF.get(okind, "interface")}
            # A LAG member's run belongs to its aggregate - the overview groups
            # the bundle's links under it (the aggregate may sit on another
            # stack member).
            olag = getattr(oport, "lag", None) if okind == "interface" else None
            if olag is not None:
                origin["lag"] = {"id": str(olag.id), "name": olag.name,
                                 "device": olag.device.name,
                                 "elsewhere": olag.device_id != device.id}
            runs.append({"origin": origin, "steps": steps, "complete": complete})
    # One cable leaving one port, landing in several places, is a breakout -
    # emit it as ONE run carrying its legs so the UI can draw the fan instead
    # of listing the same cable once per leg.
    grouped: list[dict] = []
    index: dict[tuple, dict] = {}
    for r in runs:
        cables = tuple(
            s["cable_id"] for s in r["steps"]
            if s["t"] == "seg" and s.get("cable_id")
        )
        key = (r["origin"]["name"], cables)
        first = index.get(key)
        if first is None:
            index[key] = r
            grouped.append(r)
            continue
        # Second+ landing for this port/cable: keep the shared head, collect
        # the tails as legs.
        head = 2  # origin chip + its segment
        first.setdefault("legs", [first["steps"][head:]])
        first["legs"].append(r["steps"][head:])
        first["complete"] = first["complete"] and r["complete"]
    grouped.sort(key=lambda r: natural_key(r["origin"]["name"]))
    return {"runs": grouped}


def cable_strand_path(cable, strand):
    """End-to-end path of ONE fibre strand of a (trunk) cable. Strand k maps to
    position k on each rear-port end; we walk that position out through the
    panels on both sides to the far devices, so the run reads
    device-A ═ panel ═ TRUNK (strand k) ═ panel ═ device-B, coloured by the
    strand's TIA-598-C colour. Same seg/chip shape as ``device_paths`` so the
    frontend renders it with the existing path strip."""
    from .fiber_colors import fiber_color
    from .models import FiberSettings

    tenant = cable.tenant
    links = _physical_links(tenant)
    by_port = {}
    for cab, da, pa, ka, db, pb, kb in links:
        by_port.setdefault((ka, pa.id), []).append((cab, db, pb, kb))
        by_port.setdefault((kb, pb.id), []).append((cab, da, pa, ka))

    palette = FiberSettings.for_tenant(tenant).colors
    col = fiber_color(strand, palette)

    def seg(cab, trunk=False):
        s = {
            "t": "seg",
            "cable_id": str(cab.id),
            "cable_numid": cab.numid,
            "label": cab.type or "cable",
            "cable_label": cab.label or None,
            "color": cab.color or None,
        }
        if trunk:
            s["strand"] = strand
            s["strand_color"] = {"name": col["name"], "hex": col["hex"]}
        return s

    def dev_chip(dev, port, kind):
        return {
            "t": "chip", "device_id": str(dev.id), "device": dev.name,
            "panel": False,
            "ports": [{
                "name": port.name,
                "interface_id": str(port.id) if kind == "interface" else None,
            }],
        }

    def panel_chip(dev, inp, outp):
        ports = [{"name": inp.name, "interface_id": None}]
        if outp is not None:
            ports.append({"name": outp.name, "interface_id": None})
        return {
            "t": "chip", "device_id": str(dev.id), "device": dev.name,
            "panel": True, "ports": ports,
        }

    def offbox_chip(kind, port):
        """A chip for an endpoint that isn't on a device: a power feed hangs
        off a panel, a circuit end off a circuit. Both are real endpoints, so
        they render as a chip named by whatever they do hang off."""
        if kind == "circuit_termination":
            owner, name = port.circuit, f"Side {port.term_side}"
        else:
            owner, name = port.power_panel, port.name
        return {
            "t": "chip", "device_id": str(owner.id),
            "device": getattr(owner, "name", None) or owner.cid,
            "panel": False,
            "ports": [{"name": name, "interface_id": None}],
            **({"circuit": True} if kind == "circuit_termination" else {}),
        }

    def walk_out(kind, port):
        """Steps from the cable end outward (crossing panels at `strand`) to the
        far endpoint, ordered cable→far. Returns (steps, complete)."""
        steps, seen, position = [], set(), strand
        dev = getattr(port, "device", None)
        if dev is None:
            return [offbox_chip(kind, port)], True
        while True:
            if kind not in ("front_port", "rear_port"):
                steps.append(dev_chip(dev, port, kind))
                return steps, True
            if _is_splitter_side(kind, port):
                # The cable's far end is a splitter - a real endpoint.
                steps.append(dev_chip(dev, port, kind))
                return steps, True
            if port.id in seen:
                steps.append(panel_chip(dev, port, None))
                return steps, False
            seen.add(port.id)
            s = _strand_of(port, kind, position)
            if s is None:  # dangling strand - ends at the panel
                steps.append(panel_chip(dev, port, None))
                return steps, False
            skind, sport, spos = s
            steps.append(panel_chip(dev, port, sport))
            hops = [
                h for h in by_port.get((skind, sport.id), [])
                if h[0].id != cable.id
            ]
            if not hops:  # panel's far side uncabled
                return steps, False
            _, dev, port, kind = hops[0]
            steps.append(seg(hops[0][0]))
            position = spos

    a = b = None
    for t in cable.terminations.all():
        k, o = _term_point(t)
        if o is None:
            continue
        if t.end == "A" and a is None:
            a = (k, o)
        elif t.end == "B" and b is None:
            b = (k, o)

    a_steps, a_ok = walk_out(*a) if a else ([], False)
    b_steps, b_ok = walk_out(*b) if b else ([], False)
    steps = list(reversed(a_steps)) + [seg(cable, trunk=True)] + b_steps
    return {
        "strand": strand,
        "color": {"name": col["name"], "hex": col["hex"]},
        "cable": {
            "id": str(cable.id),
            "label": cable.label or None,
            "type": cable.type,
        },
        "steps": steps,
        "complete": a_ok and b_ok,
    }


def _enriched(graph, collect, include, request, tenant):
    """``graph`` with the ``include`` enrichments and their ``meta`` (the
    map's ``include=card,link_ips``), as the caller may see them."""
    if include:
        from .topology_enrich import enrich

        graph["meta"] = enrich(
            graph, collect, include,
            request=request, user=getattr(request, "user", None), tenant=tenant,
        )
    return graph


def trace_device_graph(tenant, trace_graph, scope_q=None, include=frozenset(),
                       request=None):
    """A device-level graph (the map's device cards) for the devices a trace
    passes through, with the traced cables marked. Panels are shown
    (collapse off) so the full physical path renders. ``scope_q`` bounds
    nodes to the caller's viewable devices (site scope); ``include`` adds the
    map's enrichments (``card``, ``link_ips``) and ``meta``."""
    from django.db.models import Q

    dev_ids = {
        n["data"]["device_id"]
        for n in trace_graph["nodes"]
        if n.get("type") == "device" and n["data"].get("device_id")
    }
    cable_ids = {
        e["data"].get("cable_id")
        for e in trace_graph["edges"]
        if e.get("type") == "cable" and e["data"].get("cable_id")
    }
    if not dev_ids:
        return {"nodes": [], "edges": []}
    collect = {} if include else None
    g = _build_graph(tenant, device_filter_q=Q(id__in=dev_ids), collapse=False,
                     scope_q=scope_q, collect=collect)
    for e in g["edges"]:
        e["data"]["marked"] = e["data"].get("cable_id") in cable_ids
    return _enriched(g, collect, include, request, tenant)


def device_trace_map(device, scope_q=None, include=frozenset(), request=None):
    """Device-page mini map: the device's 1-hop neighbourhood with panels
    collapsed. Kept as the DeviceViewSet ``map`` action's implementation.
    ``scope_q`` bounds the graph to the caller's viewable devices (site
    scope); ``include`` adds the map's enrichments and ``meta``."""
    collect = {} if include else None
    graph = _build_graph(
        device.tenant, focus_id=str(device.id), depth=1, collapse=True,
        scope_q=scope_q, collect=collect,
    )
    return _enriched(graph, collect, include, request, device.tenant)


def map_include(request):
    """The ``include`` a device map or a trace asks for: ``card`` and
    ``link_ips`` (a photo is the map's own). Unknown tokens are ignored."""
    return _include_param(request.query_params) & {"card", "link_ips"}
