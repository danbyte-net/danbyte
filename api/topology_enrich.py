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


def enrich_card(ctx: EnrichContext) -> None:
    """``include=card``: each device node's resolved card lines and their
    values (``node.data.card``), plus ``meta.card``. Not built yet."""


def enrich_link_ips(ctx: EnrichContext) -> None:
    """``include=link_ips``: each cable pair's addresses and the subnets both
    ends share. Not built yet."""


def enrich_photo(ctx: EnrichContext) -> None:
    """``include=photo``: each device node's front photo with the markers of
    its cabled ports (``node.data.photo``). Not built yet."""
