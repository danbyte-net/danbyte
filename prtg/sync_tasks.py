"""PRTG on the shared external-monitor beat.

``manage.py extmon_sync`` runs every minute (``danbyte-extmon-sync.timer``)
and enqueues the connections whose status read is due - every
``status_interval_seconds``, not every minute: the classic API is PRTG's own
web server. The job re-checks every switch when it runs.
"""
from __future__ import annotations

import django_rq
from django.utils import timezone

from monitoring.external.beat import BeatTask, enqueue_due

from .models import PrtgConnection


def enqueue_due_reads(now=None) -> dict:
    from .reader import run_status_read

    return enqueue_due(
        PrtgConnection.objects.filter(enabled=True, tenant__is_active=True)
        .select_related("tenant"),
        "prtg",
        (BeatTask("status", lambda c, at: c.status_due(at), run_status_read, 300),),
        queue=django_rq.get_queue("low"),
        now=now or timezone.now(),
    )
