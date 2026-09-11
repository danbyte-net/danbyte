"""What the Zabbix app does when monitoring's workflow moves.

Connected in :mod:`zabbix.apps`. Every handler only *queues* work, after the
surrounding transaction commits: the window or the acknowledgement is the
decision, and talking to Zabbix about it is a job with its own re-checks.
"""
from __future__ import annotations

import django_rq
from django.db import transaction

from .checker import KIND


def on_window_changed(sender, event, **kwargs) -> None:
    from .maintenance import schedule_for_tenant

    schedule_for_tenant(event.tenant_id)


def on_event_deleted(sender, instance, **kwargs) -> None:
    from .maintenance import schedule_for_tenant

    schedule_for_tenant(instance.tenant_id)


def on_alert_acknowledged(sender, alert, acknowledged, actor=None, **kwargs) -> None:
    if alert.kind != KIND:
        return
    from .acks import write_ack

    name = ""
    if actor is not None:
        name = (getattr(actor, "get_full_name", lambda: "")() or "").strip()
        name = name or actor.get_username()
    alert_id = str(alert.id)

    def _go():
        django_rq.get_queue("low").enqueue(
            write_ack, alert_id, bool(acknowledged), name, job_timeout=120
        )

    transaction.on_commit(_go)
