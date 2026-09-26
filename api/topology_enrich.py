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


#: At most this many addresses per pair end, and shared subnets per pair.
LINK_IPS_MAX = 8


def enrich_link_ips(ctx: EnrichContext) -> None:
    """``include=link_ips``: each cable pair's addresses and the subnets both
    ends share.

    Every pair gets ``a_ips`` / ``b_ips`` (``address/length`` strings, at
    most 8 per end), ``subnets`` - ``[{cidr, family, a, b, a_via, b_via}]``,
    at most 8, IPv4 first - and ``subnets_truncated``. Every cable edge gets
    ``data.subnets``, the union of its pairs' subnet cidrs.

    An end's addresses are those on its interface, then on its LAG, then on
    its own sub-interfaces, then on the LAG's (``a_via`` / ``b_via`` names
    the interface when it isn't the cabled port). Two ends share a subnet
    when ``address/length`` gives the same network on both, the length
    being the address's own mask length, else its prefix's: a /31 inside an
    aggregate stays a /31. VRFs are not compared - a cable joins its ends
    whatever their routing tables. Host routes (/32, /128) and virtual
    addresses (an IP role with ``is_virtual``) are left out.

    Addresses pass the caller's ``ipaddress.view`` scope, so an end whose
    address is hidden shares nothing. Without the grant nothing is added
    and nothing is queried; with it, two queries whatever the map's size -
    the sub-interfaces, then the addresses.
    """
    from auth_api import rbac

    from .models import IPAddress

    pairs_by_edge = ctx.collect.get("pairs") or {}
    visible = rbac.restrict_queryset(
        IPAddress.objects.filter(tenant=ctx.tenant),
        ctx.user, ctx.tenant, "ipaddress", "view",
    )
    if not pairs_by_edge or visible.query.is_empty():
        return

    ports = {}  # interface id → the cabled Interface
    for rows in pairs_by_edge.values():
        for _pair, a_obj, a_kind, b_obj, b_kind in rows:
            for obj, kind in ((a_obj, a_kind), (b_obj, b_kind)):
                if kind == "interface":
                    ports[obj.id] = obj
    children = _link_children(ctx.tenant, ports)
    addrs = _link_addresses(visible, ports, children)

    # interface id → [(via, address, network, address string, cidr)]
    cands = {}

    def end(obj, kind):
        if kind != "interface":
            return ()
        if obj.id not in cands:
            steps = [(None, obj.id)]
            if obj.lag_id:
                steps.append((obj.lag.name, obj.lag_id))
            steps += children.get(obj.id, [])
            if obj.lag_id:
                steps += children.get(obj.lag_id, [])
            cands[obj.id] = [
                (via, *row) for via, iid in steps for row in addrs.get(iid, ())
            ]
        return cands[obj.id]

    edges = {e["id"]: e for e in ctx.graph.get("edges", ())}
    for edge_id, rows in pairs_by_edge.items():
        union = {}
        for pair, a_obj, a_kind, b_obj, b_kind in rows:
            a_end, b_end = end(a_obj, a_kind), end(b_obj, b_kind)
            pair["a_ips"] = list(dict.fromkeys(c[4] for c in a_end))[:LINK_IPS_MAX]
            pair["b_ips"] = list(dict.fromkeys(c[4] for c in b_end))[:LINK_IPS_MAX]
            subnets = _shared_subnets(a_end, b_end)
            pair["subnets"] = subnets[:LINK_IPS_MAX]
            pair["subnets_truncated"] = len(subnets) > LINK_IPS_MAX
            for s in subnets:
                union.setdefault(s["cidr"], s["family"])
        edge = edges.get(edge_id)
        if edge is not None:
            edge["data"]["subnets"] = sorted(union, key=union.get)


def _link_children(tenant, ports) -> dict:
    """``{parent id: [(name, id)]}``: the sub-interfaces of the cabled
    ports and of their LAGs, by name - one query, none without ports."""
    from .models import Interface

    parents = set(ports) | {p.lag_id for p in ports.values() if p.lag_id}
    children = {}
    if not parents:
        return children
    rows = (
        Interface.objects.filter(device__tenant=tenant, parent_id__in=parents)
        .order_by("name", "id")
        .values_list("id", "parent_id", "name")
    )
    for cid, pid, name in rows:
        children.setdefault(pid, []).append((name, cid))
    return children


def _link_addresses(visible, ports, children) -> dict:
    """``{interface id: [(address, network, address string, cidr)]}`` for the
    link addresses on the cabled ports, their LAGs and their sub-interfaces,
    lowest first - one query through the caller's IP scope. Host routes and
    virtual addresses are dropped."""
    import ipaddress

    ids = set(ports) | {p.lag_id for p in ports.values() if p.lag_id}
    ids |= {cid for kids in children.values() for _name, cid in kids}
    if not ids:
        return {}
    rows = (
        visible.filter(assigned_interface_id__in=ids)
        .exclude(role__is_virtual=True)
        .select_related("prefix")
        .only("id", "ip_address", "mask_length", "assigned_interface_id", "prefix__cidr")
    )
    out = {}
    for ip in rows:
        cidr = ip.cidr
        try:
            net = ipaddress.ip_network(cidr, strict=False)
            addr = ipaddress.ip_address(ip.ip_address)
        except (TypeError, ValueError):
            continue  # no length, or one that doesn't fit the family
        if net.prefixlen == net.max_prefixlen:
            continue  # a host route, not a link address
        out.setdefault(ip.assigned_interface_id, []).append(
            (addr, net, ip.ip_address, cidr)
        )
    for found in out.values():
        found.sort(key=lambda row: (row[0].version, int(row[0])))
    return out


def _shared_subnets(a_end, b_end) -> list:
    """The networks both ends hold an address in, IPv4 first, then in the
    A end's order; each pairs the first address on either side."""
    b_by_net = {}
    for via, addr, net, text, _cidr in b_end:
        b_by_net.setdefault(net, []).append((via, addr, text))
    found = {}
    for rank, (a_via, a_addr, net, a_text, _cidr) in enumerate(a_end):
        if net in found:
            continue
        b = next(
            (row for row in b_by_net.get(net, ()) if row[1] != a_addr), None
        )
        if b is None:
            continue
        found[net] = (net.version, rank, {
            "cidr": str(net),
            "family": net.version,
            "a": a_text,
            "b": b[2],
            "a_via": a_via,
            "b_via": b[0],
        })
    return [s for _v, _r, s in sorted(found.values(), key=lambda t: t[:2])]


def enrich_photo(ctx: EnrichContext) -> None:
    """``include=photo``: each device node's front photo with the markers of
    its cabled ports (``node.data.photo``). Not built yet."""
