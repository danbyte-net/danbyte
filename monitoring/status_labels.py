"""What a check state is called, in the tenant's own words.

A check always ends in one of the six states in
``api.status_registry.MONITORING_STATES`` - that is the machine's vocabulary,
and alert rules, escalation, flapping and the Outpost protocol are all keyed
off it. What an estate *calls* those states is a different question: "Down" is
"Critical" in one NOC and "Outage" in the next, and the shipped red is not
everybody's red.

So a ``Status`` row may claim a state (``Status.monitoring_state``). Claiming
one renames and recolours it everywhere monitoring is shown, and makes the
status pickable wherever a check state is - a Zabbix severity map, say. One
claimant per state per tenant: the state is what gets stored, so a second
would be indistinguishable after ingest.
"""
from __future__ import annotations

from api.status_registry import MONITORING_STATES


def status_labels(tenant) -> dict[str, dict]:
    """``{state: {id, name, color, text_color}}`` for the states this tenant
    has claimed. States with no claimant are absent - the caller keeps its
    shipped name and colour for those, so nothing has to be duplicated here."""
    if tenant is None:
        return {}
    from api.models import Status

    rows = (
        Status.objects.filter(tenant=tenant)
        .exclude(monitoring_state="")
        .order_by("weight", "name")
    )
    return {
        s.monitoring_state: {
            "id": str(s.id),
            "name": s.name,
            "color": s.color,
            "text_color": s.text_color,
        }
        for s in rows
    }


def status_options(tenant, states=None) -> list[dict]:
    """Check states as pickable options, labelled and coloured by the tenant's
    catalog where it has an opinion and by the shipped names where it does not.

    ``states`` narrows the list - a Zabbix severity only ever maps onto the
    three that carry an operational meaning, not onto ``stale`` or ``skipped``,
    which Danbyte decides for itself.
    """
    labels = status_labels(tenant)
    wanted = list(states) if states is not None else [s for s, _ in MONITORING_STATES]
    shipped = dict(MONITORING_STATES)
    out = []
    for state in wanted:
        override = labels.get(state) or {}
        out.append({
            "value": state,
            "label": override.get("name") or shipped.get(state, state),
            "color": override.get("color", ""),
            "text_color": override.get("text_color", ""),
        })
    return out
