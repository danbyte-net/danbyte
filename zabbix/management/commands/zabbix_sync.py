"""Enqueue due Zabbix syncs.

Run on a timer by danbyte-zabbix-sync.timer.

    manage.py zabbix_sync
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from zabbix.sync_tasks import enqueue_due_syncs


class Command(BaseCommand):
    help = "Enqueue due Zabbix provisioning syncs."

    def handle(self, *args, **opts):
        with record_run("zabbix-sync", "Zabbix sync") as run:
            r = enqueue_due_syncs()
            self.stdout.write(
                self.style.SUCCESS(f"zabbix sync: {r['queued']} queued")
            )
            run.note(f"{r['queued']} queued", **r)
