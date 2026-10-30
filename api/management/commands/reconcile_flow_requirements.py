"""Resolve every application flow requirement again.

Heals the generated flows that writes skipping model signals left behind (a
queryset ``update()`` that moved addresses, a host renamed in bulk). Run
daily by danbyte-cleanup.timer, as the system.

    manage.py reconcile_flow_requirements
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from api.flow_requirements import reconcile_all
from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Resolve every application flow requirement (the nightly sweep)."

    def handle(self, *args, **opts):
        with record_run("flow-requirements", "Flow requirements sweep") as run:
            t = reconcile_all()
            summary = (f"{t['requirements']} requirement(s): {t['created']} created, "
                       f"{t['updated']} updated, {t['removed']} removed, "
                       f"{t['released']} kept")
            if t["failed"]:
                summary += f", {t['failed']} failed"
            self.stdout.write(self.style.SUCCESS(f"flow requirements: {summary}"))
            run.note(summary, **t)
