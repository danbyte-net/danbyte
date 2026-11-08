"""PRTG on the shared external-monitor beat.

``manage.py extmon_sync`` runs every minute (``danbyte-extmon-sync.timer``)
and enqueues the passes each connection is due for: the status read every
``status_interval_seconds`` (the classic API is PRTG's own web server, so not
every minute), the maintenance reconcile on the same cadence when it is on,
the inventory read hourly when it is on, and - with auto apply on - the
apply of ready planned changes after each planning pass. Each job re-checks
every switch when it runs.
"""
from __future__ import annotations

import django_rq
from django.utils import timezone

from monitoring.external.beat import BeatTask, enqueue_due

from .models import PrtgConnection


def enqueue_due_reads(now=None) -> dict:
    from .facts import run_inventory_read
    from .maintenance import run_maintenance_sync
    from .reader import run_status_read
    from .writer import run_auto_apply

    return enqueue_due(
        PrtgConnection.objects.filter(enabled=True, tenant__is_active=True)
        .select_related("tenant"),
        "prtg",
        (
            BeatTask("status", lambda c, at: c.status_due(at), run_status_read, 300),
            BeatTask(
                "maintenance", lambda c, at: c.maintenance_due(at), run_maintenance_sync, 300
            ),
            BeatTask(
                "inventory", lambda c, at: c.inventory_due(at), run_inventory_read, 600
            ),
            BeatTask(
                "apply", lambda c, at: c.auto_apply_due(at), run_auto_apply, 900
            ),
        ),
        queue=django_rq.get_queue("low"),
        now=now or timezone.now(),
    )
