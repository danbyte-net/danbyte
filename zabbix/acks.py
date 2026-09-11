"""Acknowledgement write-back (#162 phase 5).

Acknowledging a Danbyte alert that Zabbix raised acknowledges the Zabbix
problems behind it, with the operator's name and note, so the NOC reading
either screen sees the same "somebody has this". Clearing it clears it there.

A job, never inline: the acknowledgement in Danbyte is the decision and must
not wait on - or fail because of - a network call to another system.
"""
from __future__ import annotations

import logging

from django.utils import timezone

from integrations.toggles import integration_enabled
from monitoring.models import Alert, CheckState

from .checker import KIND
from .client import ZabbixClient, ZabbixError
from .driver import _connection

log = logging.getLogger("zabbix.acks")


def _message(acknowledged: bool, actor: str, note: str) -> str:
    verb = "Acknowledged" if acknowledged else "Unacknowledged"
    head = f"{verb} in Danbyte by {actor}" if actor else f"{verb} in Danbyte"
    return f"{head}: {note}" if note else head


def write_ack(alert_id: str, acknowledged: bool, actor: str = "") -> dict:
    alert = (
        Alert.objects.filter(pk=alert_id)
        .select_related("tenant", "target_ip", "template")
        .first()
    )
    if alert is None:
        return {"skipped": "gone"}
    if alert.kind != KIND:
        return {"skipped": "not a Zabbix alert"}
    if not integration_enabled(alert.tenant, "zabbix"):
        return {"skipped": "integration off"}
    state = (
        CheckState.objects.filter(
            target_ip=alert.target_ip, template=alert.template, kind=KIND
        )
        .select_related("engine")
        .first()
    )
    if state is None or state.engine_id is None:
        return {"skipped": "no check state"}
    conn = _connection(state.engine)
    if conn is None or not conn.write_acknowledgements or not conn.token_set:
        return {"skipped": "write-back off"}
    # The problems the last poll saw - the ones the alert is about. An alert
    # that outlived them has nothing in Zabbix left to acknowledge.
    problems = (state.last_detail or {}).get("problems") or []
    eventids = [str(p["eventid"]) for p in problems if isinstance(p, dict) and p.get("eventid")]
    if not eventids:
        return {"skipped": "no open problems"}

    client = ZabbixClient(
        conn.api_url, (conn.credentials or {}).get("token", ""), verify_tls=conn.verify_tls
    )
    stamp = {
        "eventids": eventids,
        "acknowledged": acknowledged,
        "at": timezone.now().isoformat(),
        "error": "",
    }
    try:
        client.acknowledge(
            eventids,
            message=_message(acknowledged, actor, alert.ack_note if acknowledged else ""),
            acknowledge=acknowledged,
        )
    except ZabbixError as exc:
        stamp["error"] = str(exc)[:500]
        log.warning("zabbix ack write-back for %s failed: %s", alert_id, exc)
    # One key, merged into the detail as it is now - the alert's own detail
    # keeps changing underneath while the poll runs.
    fresh = Alert.objects.filter(pk=alert.pk).values_list("detail", flat=True).first() or {}
    Alert.objects.filter(pk=alert.pk).update(detail={**fresh, "zabbix_ack": stamp})
    return stamp
