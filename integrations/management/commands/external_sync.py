"""Enqueue due external syncs (Windows DHCP/DNS connections).

Run on a timer by danbyte-external-sync.timer.

    manage.py external_sync
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from integrations.sync_tasks import enqueue_due_syncs


class Command(BaseCommand):
    help = "Enqueue due Windows DHCP/DNS and virtualization sync jobs."

    def handle(self, *args, **opts):
        with record_run("external-sync", "External sync (DHCP/DNS)") as run:
            r = enqueue_due_syncs()
            self.stdout.write(
                self.style.SUCCESS(f"external sync: {r['windows_queued']} windows, "
                f"{r['virt_queued']} virt queued")
            )
            run.note(
                f"{r['windows_queued']} windows, {r['virt_queued']} virt", **r
            )
