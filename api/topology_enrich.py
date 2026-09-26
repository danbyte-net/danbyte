"""Opt-in enrichment of the topology graph (``/api/topology/?include=``).

The default map payload stays lean: anything that costs queries is asked for
by name - ``card`` (a Diagram card's lines), ``link_ips`` (each cable pair's
addresses and shared subnets) and ``photo`` (front photos with the markers of
the cabled ports). The summary, grouped, trace and site maps never come here.

An enricher reads the ``collect`` side channel ``_graph_from_links`` filled
while it assembled the graph - the devices behind the nodes, each node's
cabled port objects and each edge's oriented pair objects - so it reuses the
rows already loaded rather than fetching them again. It edits the graph in
place and may add its own key to ``ctx.meta``, which the response carries as
``meta``.
"""
from __future__ import annotations

from dataclasses import dataclass, field

#: What ``include`` may name; anything else is ignored.
INCLUDE_TOKENS = frozenset({"card", "link_ips", "photo"})


@dataclass
class EnrichContext:
    """What every enricher gets.

    ``collect`` is the side channel (``devices``, ``ports``, ``pairs``) - see
    ``api.topology_views._graph_from_links``. ``card_fields`` is a saved
    view's own card lines: None inherits, ``[]`` is name only.
    """

    graph: dict
    collect: dict
    include: frozenset
    tenant: object
    user: object = None
    request: object = None
    card_fields: list | None = None
    meta: dict = field(default_factory=dict)


def enrich(graph, collect, include, *, tenant, user=None, request=None,
           card_fields=None) -> dict:
    """Run the enrichers ``include`` names over ``graph`` (in place) and
    return the response's ``meta``.

    Enrichers run in a fixed order whatever order ``include`` came in, so the
    payload is deterministic.
    """
    ctx = EnrichContext(
        graph=graph,
        collect=collect if collect is not None else {},
        include=frozenset(include),
        tenant=tenant,
        user=user if user is not None else getattr(request, "user", None),
        request=request,
        card_fields=card_fields,
    )
    if "card" in ctx.include:
        enrich_card(ctx)
    if "link_ips" in ctx.include:
        enrich_link_ips(ctx)
    if "photo" in ctx.include:
        enrich_photo(ctx)
    return ctx.meta


#: Card lines whose value is an IP (the device attribute of the same name).
_CARD_IP_KEYS = ("primary_ip", "secondary_ip", "oob_ip")
#: Card lines the node already carries, or that the frontend fills: no value.
_CARD_NODE_KEYS = frozenset(
    {"status", "monitor", "device_type", "role", "site", "location"}
)


def enrich_card(ctx: EnrichContext) -> None:
    """``include=card``: each device node's resolved card lines and their
    values (``node.data.card = {fields, source, values}``), plus
    ``meta.card = {fields, source, uses_monitor}``.

    ``fields`` comes from ``resolve_card_fields`` (device → the query's
    ``card_fields`` → role → tenant/deployment → default). ``values`` holds
    only that node's keys, and only those the node doesn't already carry:
    ``status``, ``monitor``, ``device_type``, ``role``, ``site`` and
    ``location`` have none. A ``cf_<key>`` for a hidden or undefined device
    custom field is dropped from ``fields``.

    The cost is flat in the node count: the effective settings (two
    queries), one IP query, one custom-field query and a prefetch per
    relation - each only when some node shows a key that needs it.
    """
    from core.effective_settings import (
        effective_topology_card,
        resolve_card_fields,
    )

    eff = effective_topology_card(ctx.tenant)
    devices = ctx.collect.get("devices") or {}
    cards = []  # (node data, device, fields, source)
    for node in ctx.graph.get("nodes", ()):
        if node.get("type") != "device":
            continue
        d = devices.get(node["data"].get("device_id"))
        if d is None:
            continue
        fields, source = resolve_card_fields(d, eff, ctx.card_fields)
        cards.append((node["data"], d, fields, source))

    wanted = {key for _data, _d, fields, _src in cards for key in fields}
    visible_cf = _visible_device_cf_keys(ctx.tenant, wanted)
    ips, loopbacks = _card_ips(ctx, cards, wanted)
    _prefetch_card_relations([d for _data, d, _f, _s in cards], wanted)

    for data, d, fields, source in cards:
        fields = [
            k for k in fields if not k.startswith("cf_") or k[3:] in visible_cf
        ]
        values = {}
        for key in fields:
            if key in _CARD_NODE_KEYS:
                continue
            if key in _CARD_IP_KEYS:
                values[key] = _card_ip(ips.get(getattr(d, f"{key}_id")))
            elif key == "loopback":
                values[key] = [_card_ip(ip) for ip in loopbacks.get(d.id, ())]
            elif key.startswith("cf_"):
                values[key] = (d.custom_fields or {}).get(key[3:])
            else:
                values[key] = _CARD_VALUE[key](d)
        data["card"] = {"fields": fields, "source": source, "values": values}

    ctx.meta["card"] = {
        "fields": list(eff["fields"]),
        "source": eff["source"],
        "uses_monitor": any("monitor" in c[2] for c in cards),
    }


def _card_ip(ip):
    """``{id, address, cidr}``, or None. ``cidr`` reads the prefix only when
    the address has no ``mask_length`` - load it with ``prefix``."""
    if ip is None:
        return None
    return {"id": str(ip.id), "address": ip.ip_address, "cidr": ip.cidr or ip.ip_address}


def _card_ips(ctx, cards, wanted):
    """``({ip id: IPAddress}, {device id: [loopback IPAddress]})`` in one
    tenant-filtered query.

    Primary, secondary and OOB addresses are device attributes: they show
    wherever the device does, as on the device API. Loopbacks - addresses
    with the IP role ``loopback`` assigned to the device - are IP rows in
    their own right and pass the caller's ``ipaddress.view`` scope.
    """
    from django.db.models import BooleanField, Case, Q, Value, When

    from auth_api import rbac

    from .models import IPAddress

    if not wanted & {*_CARD_IP_KEYS, "loopback"}:
        return {}, {}
    direct, loop_devices = set(), set()
    for _data, d, fields, _src in cards:
        for key in _CARD_IP_KEYS:
            ip_id = getattr(d, f"{key}_id")
            if key in fields and ip_id:
                direct.add(ip_id)
        if "loopback" in fields:
            loop_devices.add(d.id)
    base = IPAddress.objects.filter(tenant=ctx.tenant)
    loop_q = None
    if loop_devices and ctx.user is not None:
        visible = rbac.restrict_queryset(
            base, ctx.user, ctx.tenant, "ipaddress", "view"
        )
        if not visible.query.is_empty():
            loop_q = Q(role__slug="loopback")
            if visible is not base:
                # A scoped grant: its row filter, as a subquery of this one.
                loop_q &= Q(id__in=visible.values("id"))
    if not direct and loop_q is None:
        return {}, {}
    cond = Q(id__in=direct) if direct else Q()
    if loop_q is not None:
        cond |= Q(assigned_device_id__in=loop_devices) & loop_q
    rows = base.filter(cond).select_related("prefix")
    if loop_q is not None:
        # Which rows are viewable loopbacks: an address can also be a
        # device's primary IP, fetched whatever the caller's IP scope.
        rows = rows.annotate(card_loop=Case(
            When(loop_q, then=Value(True)),
            default=Value(False),
            output_field=BooleanField(),
        ))
    ips, loopbacks = {}, {}
    for ip in rows:
        ips[ip.id] = ip
        if getattr(ip, "card_loop", False) and ip.assigned_device_id in loop_devices:
            loopbacks.setdefault(ip.assigned_device_id, []).append(ip)
    return ips, loopbacks


def _visible_device_cf_keys(tenant, wanted) -> set:
    """The keys of the tenant's device custom fields a card may show (not
    hidden) - queried only when some card lists a ``cf_`` line."""
    if not any(k.startswith("cf_") for k in wanted):
        return set()
    from customization.models import CustomField

    return set(
        CustomField.objects.filter(
            tenant=tenant, hidden=False, applies_to__contains=["device"]
        ).values_list("key", flat=True)
    )


def _prefetch_card_relations(devices, wanted) -> None:
    """Load the relations the wanted lines read, once for every device."""
    from django.db.models import prefetch_related_objects

    lookups = []
    if "platform" in wanted:
        lookups += ["platform", "device_type__platform"]
    if "manufacturer" in wanted:
        lookups.append("device_type__manufacturer")
    if "rack" in wanted:
        lookups.append("rack")
    if "tags" in wanted:
        lookups.append("tags")
    if devices and lookups:
        prefetch_related_objects(devices, *lookups)


def _card_platform(d):
    """The device's own platform, else its type's (``effective_platform``)."""
    p = d.platform if d.platform_id else None
    if p is None and d.device_type_id and d.device_type.platform_id:
        p = d.device_type.platform
    return {"id": str(p.id), "name": p.name} if p else None


def _card_manufacturer(d):
    dt = d.device_type if d.device_type_id else None
    m = dt.manufacturer if dt is not None and dt.manufacturer_id else None
    return {"id": str(m.id), "name": m.name} if m else None


def _card_rack(d):
    if not d.rack_id:
        return None
    return {"id": str(d.rack.id), "name": d.rack.name, "position": d.position}


def _card_tags(d):
    return [
        {"name": t.name, "slug": t.slug, "color": t.color} for t in d.tags.all()
    ]


#: The value of every other card line, read from a device whose relations
#: ``_prefetch_card_relations`` loaded.
_CARD_VALUE = {
    "serial": lambda d: d.serial_number,
    "asset_tag": lambda d: d.asset_tag,
    "platform": _card_platform,
    "manufacturer": _card_manufacturer,
    "rack": _card_rack,
    "tags": _card_tags,
}


def enrich_link_ips(ctx: EnrichContext) -> None:
    """``include=link_ips``: each cable pair's addresses and the subnets both
    ends share. Not built yet."""


def enrich_photo(ctx: EnrichContext) -> None:
    """``include=photo``: each device node's front photo with the markers of
    its cabled ports (``node.data.photo``). Not built yet."""
