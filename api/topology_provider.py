"""Provider networks on the maps (#466): the hub a set of circuits meets at.

A circuit with one end on a site and the other on a provider network (an
MPLS cloud, a carrier's fabric) is drawn as a line from the site side to one
node standing for the provider network - every such circuit to the same
network meets at that node, hub and spoke.

* The topology's device map draws it from the device the site-side
  termination is cabled to, through any patch panels (the panel walk of
  ``topology_views._collapse``); an end that is not cabled to a device on
  the map draws nothing.
* The grouped map draws it from the cabled device's site or location card,
  and when the end is not cabled, from its own site's card (``group_by=site``
  only - a termination names a site, never a location).
* The site map draws it from the termination's site (``site_map_views``).

A circuit with both ends on sites (a provider's point-to-point or MPLS
service between two of your routers) has no hub: when both ends are cabled
to device ports, through any patch panels, the device map draws one
``circuit`` edge between the two devices (``cc:<circuit id>``), and the
grouped map one between their groups when those differ. An end not cabled
to a device the caller may view on the map draws nothing - the far device is
never leaked.

What the caller sees follows their grants: a circuit needs ``circuit.view``,
its network ``providernetwork.view``, and the site its site-side end lands on
``site.view`` - a reader scoped to some sites never gets a node built from a
circuit at a site they can't view. The device map adds the device scope the
graph already carries; devices and panels outside it are dropped before the
walk, so a hidden panel's name never reaches ``via``.

Every call costs a fixed number of queries, whatever the number of circuits.
"""
from __future__ import annotations

from typing import NamedTuple

from auth_api import rbac

from .models import Circuit, CircuitTermination, Device, ProviderNetwork, Site

#: The node type and the edge type these add to a topology graph.
NODE_TYPE = "provider_network"
EDGE_TYPE = "circuit"


class SiteCircuit(NamedTuple):
    """A circuit whose two ends both land on sites."""
    circuit: Circuit
    a_term: CircuitTermination
    z_term: CircuitTermination


class ProviderCircuit(NamedTuple):
    circuit: Circuit
    site_term: CircuitTermination
    pn_term: CircuitTermination

    @property
    def network(self) -> ProviderNetwork:
        return self.pn_term.provider_network


def provider_circuits(user, tenant, sites=None) -> list[ProviderCircuit]:
    """The circuits the caller may view with one end on a provider network
    they may view and the other on a site they may view - ``sites`` (ids)
    narrows those further. Ordered by circuit id (``cid``). Two queries."""
    circuits = rbac.restrict_queryset(
        Circuit.objects.filter(tenant=tenant), user, tenant, "circuit", "view"
    )
    networks = rbac.restrict_queryset(
        ProviderNetwork.objects.filter(tenant=tenant),
        user, tenant, "providernetwork", "view",
    )
    pn_terms = list(
        CircuitTermination.objects.filter(
            circuit__in=circuits.values("id"),
            provider_network__in=networks.values("id"),
        )
        .select_related(
            "provider_network__provider", "circuit__provider",
            "circuit__type", "circuit__status",
        )
        .order_by("circuit__cid", "circuit_id", "term_side")
    )
    if not pn_terms:
        return []
    visible_sites = rbac.restrict_queryset(
        Site.objects.filter(tenant=tenant), user, tenant, "site", "view"
    )
    site_terms = CircuitTermination.objects.filter(
        circuit_id__in={t.circuit_id for t in pn_terms},
        site__in=visible_sites.values("id"),
    ).select_related("site")
    if sites is not None:
        site_terms = site_terms.filter(site_id__in=list(sites))
    site_of: dict = {}
    for t in site_terms.order_by("term_side"):
        site_of.setdefault(t.circuit_id, t)
    out, seen = [], set()
    for t in pn_terms:
        st = site_of.get(t.circuit_id)
        if st is None or t.circuit_id in seen:
            continue
        seen.add(t.circuit_id)
        out.append(ProviderCircuit(t.circuit, st, t))
    return out


def site_circuits(user, tenant) -> list[SiteCircuit]:
    """The circuits the caller may view with both ends on sites, ordered by
    circuit id (``cid``). One query beyond the grant lookup."""
    circuits = rbac.restrict_queryset(
        Circuit.objects.filter(tenant=tenant), user, tenant, "circuit", "view"
    )
    by_circuit: dict = {}
    for t in (
        CircuitTermination.objects.filter(
            circuit__in=circuits.values("id"), site__isnull=False
        )
        .select_related(
            "site", "circuit__provider", "circuit__type", "circuit__status",
        )
        .order_by("circuit__cid", "circuit_id", "term_side")
    ):
        by_circuit.setdefault(t.circuit_id, {})[t.term_side] = t
    return [
        SiteCircuit(sides["A"].circuit, sides["A"], sides["Z"])
        for sides in by_circuit.values()
        if "A" in sides and "Z" in sides
    ]


# ─── Payload pieces ─────────────────────────────────────────────────────────

def circuit_color(circuit) -> str:
    """A circuit line's colour: its type's, else its status's - as the site
    map's circuit lines."""
    if circuit.type_id and circuit.type.color:
        return circuit.type.color
    return circuit.status.color if circuit.status_id else ""


def circuit_ref(circuit) -> dict:
    from .topology_views import _status_mini

    return {
        "id": str(circuit.id),
        "cid": circuit.cid,
        "provider": {"id": str(circuit.provider_id), "name": circuit.provider.name},
        "type": (
            {"id": str(circuit.type_id), "name": circuit.type.name,
             "color": circuit.type.color}
            if circuit.type_id else None
        ),
        "status": _status_mini(
            circuit.status if circuit.status_id else None, "circuit"
        ),
        "commit_rate_kbps": circuit.commit_rate_kbps,
    }


def network_ref(pn) -> dict:
    return {
        "id": str(pn.id),
        "name": pn.name,
        "service_id": pn.service_id,
        "provider": {"id": str(pn.provider_id), "name": pn.provider.name},
    }


def termination_ref(term) -> dict:
    return {
        "id": str(term.id),
        "side": term.term_side,
        "port_speed_kbps": term.port_speed_kbps,
        "upstream_speed_kbps": term.upstream_speed_kbps,
    }


def node_id(pn) -> str:
    return f"pn:{pn.id}"


def _node(pn, rows) -> dict:
    return {
        "id": node_id(pn),
        "type": NODE_TYPE,
        "data": {
            "kind": NODE_TYPE,
            "provider_network_id": str(pn.id),
            **network_ref(pn),
            "circuit_count": len(rows),
            "circuits": [
                {
                    **circuit_ref(r.circuit),
                    "site": {"id": str(r.site_term.site_id),
                             "name": r.site_term.site.name},
                }
                for r in rows
            ],
        },
    }


def _edge(row, source, data) -> dict:
    c = row.circuit
    return {
        "id": f"ce:{c.id}",
        "source": source,
        "target": node_id(row.network),
        "type": EDGE_TYPE,
        "data": {
            "circuit": circuit_ref(c),
            "provider_network": network_ref(row.network),
            "termination": termination_ref(row.site_term),
            "site": {"id": str(row.site_term.site_id),
                     "name": row.site_term.site.name},
            "color": circuit_color(c),
            "status": c.status.slug if c.status_id else None,
            "status_mini": circuit_ref(c)["status"],
            "via": [],
            **data,
        },
    }


def _attach(graph, used: list) -> dict:
    """Add the network nodes and circuit edges of ``used`` -
    ``[(row, edge)]`` - to ``graph``: one node per network, its circuits
    those that drew."""
    by_pn: dict = {}
    for row, edge in used:
        by_pn.setdefault(row.network.id, (row.network, []))[1].append(row)
        graph["edges"].append(edge)
    for pn, rows in sorted(
        by_pn.values(), key=lambda v: (v[0].name.lower(), str(v[0].id))
    ):
        graph["nodes"].append(_node(pn, rows))
    return graph


# ─── The walk from a circuit end to a device ───────────────────────────────

def cabled_ends(tenant, rows, scope_q=None, collapse=True) -> dict:
    """``{site-side termination id: (device, port, kind, vias)}`` - the
    device port each end is cabled to, through patch panels with
    ``collapse`` (else the device the cable lands on, panel or not). Only
    devices in ``scope_q`` count; panels outside it are not crossed."""
    return cabled_terminations(
        tenant, {r.circuit.id for r in rows}, {r.site_term.id for r in rows},
        scope_q, collapse,
    )


def cabled_terminations(tenant, circuit_ids, term_ids, scope_q=None,
                        collapse=True) -> dict:
    """``{termination id: (device, port, kind, vias)}`` for the terminations
    ``term_ids`` of the circuits ``circuit_ids`` - see ``cabled_ends``. A
    fixed number of queries, whatever the number of circuits."""
    from .topology_views import _collapse, _links_around, _preloaded_strand

    links = _links_around(tenant, set(circuit_ids)) if circuit_ids else []
    if not links:
        return {}
    if scope_q is not None:
        reached = {
            link[i].id for link in links for i, k in ((1, 3), (4, 6))
            if link[k] != "circuit_termination"
        }
        allowed = set(
            Device.objects.filter(tenant=tenant, id__in=reached)
            .filter(scope_q).values_list("id", flat=True)
        ) if reached else set()
        links = [
            link for link in links
            if all(
                link[k] == "circuit_termination" or link[i].id in allowed
                for i, k in ((1, 3), (4, 6))
            )
        ]
    if collapse:
        out, _ = _collapse(links, strand_of=_preloaded_strand(links))
    else:
        out = [link + ([],) for link in links]
    wanted = set(term_ids)
    ends: dict = {}
    for _cab, da, pa, ka, db, pb, kb, vias in out:
        for k1, p1, d2, p2, k2 in ((ka, pa, db, pb, kb), (kb, pb, da, pa, ka)):
            if k1 == "circuit_termination" and k2 != "circuit_termination" \
                    and p1.id in wanted:
                ends.setdefault(p1.id, (d2, p2, k2, list(vias)))
    return ends


# ─── Site-to-site circuits ──────────────────────────────────────────────────

def site_edge_id(circuit) -> str:
    return f"cc:{circuit.id}"


def _end_ref(term, end) -> dict:
    dev, port, kind, vias = end
    return {
        "side": term.term_side,
        "termination": termination_ref(term),
        "site": {"id": str(term.site_id), "name": term.site.name},
        "device": {"id": str(dev.id), "name": dev.name},
        "port": {"id": str(port.id), "name": port.name, "kind": kind},
        "via": list(vias),
    }


def _site_edge(row, source, target, a_end, z_end, pairs=True) -> dict:
    """The line between a site-to-site circuit's two ends, side A the
    source. ``pairs`` - the port pair the device map anchors it to."""
    c = row.circuit
    a = _end_ref(row.a_term, a_end)
    z = _end_ref(row.z_term, z_end)
    ref = circuit_ref(c)
    data = {
        "circuit": ref,
        "color": circuit_color(c),
        "status": c.status.slug if c.status_id else None,
        "status_mini": ref["status"],
        "ends": [a, z],
        "via": a["via"] + z["via"],
    }
    if pairs:
        data["pairs"] = [{
            "a": f"{a['device']['name']}:{a['port']['name']}",
            "b": f"{z['device']['name']}:{z['port']['name']}",
            "a_port": a["port"]["name"],
            "b_port": z["port"]["name"],
            "a_id": a["port"]["id"],
            "a_kind": a["port"]["kind"],
            "b_id": z["port"]["id"],
            "b_kind": z["port"]["kind"],
        }]
    return {
        "id": site_edge_id(c),
        "source": source,
        "target": target,
        "type": EDGE_TYPE,
        "data": data,
    }


def _ensure_port(node, port, kind) -> None:
    """Give a device card the row a circuit line anchors to: a scoped map
    drops the cable to the circuit end before the cards are built, and the
    port's row with it."""
    from .topology_views import _KIND_OF

    ports = node["data"].setdefault("ports", [])
    if any(port.name in (p.get("name"), p.get("pair")) for p in ports):
        return
    ports.append({"name": port.name, "kind": _KIND_OF.get(kind, "interface")})


def _load(user, tenant, scope_q, collapse):
    """The provider-network circuits, the site-to-site circuits and where
    every end of both is cabled - one walk for the two."""
    rows = provider_circuits(user, tenant)
    pairs = site_circuits(user, tenant)
    if not rows and not pairs:
        return rows, pairs, {}
    ends = cabled_terminations(
        tenant,
        {r.circuit.id for r in rows} | {p.circuit.id for p in pairs},
        {r.site_term.id for r in rows}
        | {t.id for p in pairs for t in (p.a_term, p.z_term)},
        scope_q, collapse,
    )
    return rows, pairs, ends


# ─── Topology graphs ────────────────────────────────────────────────────────

def add_to_device_graph(graph, user, tenant, scope_q=None, collapse=True) -> dict:
    """Add the provider networks the device map's cards are cabled to: one
    node per network and one edge per circuit, from the card whose port the
    site-side end is cabled to. A site-to-site circuit whose two ends are
    cabled to cards on the map is one edge between them. An end not cabled
    to a card on the map draws nothing."""
    cards = {
        n["data"]["device_id"]: n for n in graph.get("nodes", ())
        if n.get("type") == "device"
    }
    if not cards:
        return graph
    rows, pairs, ends = _load(user, tenant, scope_q, collapse)
    used = []
    for row in rows:
        end = ends.get(row.site_term.id)
        if end is None:
            continue
        dev, port, kind, vias = end
        if str(dev.id) not in cards:
            continue
        cid = row.circuit.cid
        used.append((row, _edge(row, f"dev:{dev.id}", {
            "device": {"id": str(dev.id), "name": dev.name},
            "port": {"id": str(port.id), "name": port.name, "kind": kind},
            "via": vias,
            "pairs": [{
                "a": f"{dev.name}:{port.name}",
                "b": f"{row.network.name}:{cid}",
                "a_port": port.name,
                "b_port": cid,
                "a_id": str(port.id),
                "a_kind": kind,
                "b_id": str(row.site_term.id),
                "b_kind": "circuit_termination",
            }],
        })))
    _attach(graph, used)
    for p in pairs:
        a_end, z_end = ends.get(p.a_term.id), ends.get(p.z_term.id)
        if a_end is None or z_end is None:
            continue
        a_card = cards.get(str(a_end[0].id))
        z_card = cards.get(str(z_end[0].id))
        if a_card is None or z_card is None or a_card is z_card:
            continue
        _ensure_port(a_card, a_end[1], a_end[2])
        _ensure_port(z_card, z_end[1], z_end[2])
        graph["edges"].append(
            _site_edge(p, a_card["id"], z_card["id"], a_end, z_end)
        )
    return graph


def add_to_grouped_graph(graph, user, tenant, group_by, device_q, scope_q=None,
                         collapse=True) -> dict:
    """Add the provider networks to a grouped map: an edge per circuit from
    the card of the group its cabled device belongs to, or - not cabled,
    grouped by site - from its own site's card. A site-to-site circuit whose
    ends are cabled to devices in two groups is a line between their cards;
    within one group it stays inside the card, as cables do. ``device_q`` is
    the map's device set (filters and scope) as a queryset; only cards on
    the map draw."""
    groups = {
        n["data"]["group_id"] for n in graph.get("nodes", ())
        if n.get("type") == "group" and n["data"].get("group_id")
    }
    if not groups:
        return graph
    rows, pairs, ends = _load(user, tenant, scope_q, collapse)
    reached = {end[0].id for end in ends.values()}
    group_of = {
        str(did): str(g) if g is not None else None
        for did, g in device_q.filter(id__in=reached)
        .values_list("id", f"{group_by}_id")
    } if reached else {}
    used = []
    for row in rows:
        end = ends.get(row.site_term.id)
        extra = {}
        if end is not None:
            dev, port, kind, vias = end
            gid = group_of.get(str(dev.id))
            if gid is None:
                continue  # cabled to a device this map leaves out
            extra = {
                "device": {"id": str(dev.id), "name": dev.name},
                "port": {"id": str(port.id), "name": port.name, "kind": kind},
                "via": vias,
            }
        elif group_by == "site":
            gid = str(row.site_term.site_id)
        else:
            continue
        if gid not in groups:
            continue
        used.append((row, _edge(row, f"grp:{gid}", extra)))
    _attach(graph, used)
    for p in pairs:
        a_end, z_end = ends.get(p.a_term.id), ends.get(p.z_term.id)
        if a_end is None or z_end is None:
            continue
        ga = group_of.get(str(a_end[0].id))
        gz = group_of.get(str(z_end[0].id))
        if ga is None or gz is None or ga == gz:
            continue
        if ga not in groups or gz not in groups:
            continue
        graph["edges"].append(_site_edge(
            p, f"grp:{ga}", f"grp:{gz}", a_end, z_end, pairs=False
        ))
    return graph
