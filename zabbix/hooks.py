"""What the Zabbix app does when monitoring's workflow moves.

Registered in :mod:`zabbix.apps` with the shared registries in
:mod:`monitoring.external.hooks`, which own the signal handlers. Every
function here only *queues* work, after the surrounding transaction commits:
the window or the acknowledgement is the decision, and talking to Zabbix about
it is a job with its own re-checks.
"""
from __future__ import annotations

import django_rq
from django.db import transaction

from .checker import KIND

#: The system name Zabbix writes acknowledgements as; an acknowledgement whose
#: ``source`` is this never travels back to Zabbix.
SYSTEM = "zabbix"


def window_changed(tenant_id) -> None:
    """A window of this tenant changed or its event went: reconcile."""
    from .maintenance import schedule_for_tenant

    schedule_for_tenant(tenant_id)


def write_back(alert, acknowledged, actor=None, **kwargs) -> None:
    """Queue the acknowledgement write-back for a Zabbix alert."""
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


# The signal-receiver shapes these had before the registries, kept for any
# caller that still connects or calls them directly.
def on_window_changed(sender, event, **kwargs) -> None:
    window_changed(event.tenant_id)


def on_event_deleted(sender, instance, **kwargs) -> None:
    window_changed(instance.tenant_id)


def on_alert_acknowledged(sender, alert, acknowledged, actor=None, **kwargs) -> None:
    write_back(alert, acknowledged, actor=actor)
