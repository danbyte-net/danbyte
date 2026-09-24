"""Keep every active SLA's figures current.

Run every 15 minutes by danbyte-sla.timer: recomputes each agreement's open
period, closes the period that ended, recomputes closed periods while
exclusions may still be added, and freezes them after the grace window.

    manage.py sla_compute
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring import sla


class Command(BaseCommand):
    help = "Recompute SLA figures and close finished periods."

    def handle(self, *args, **opts):
        with record_run("sla-compute", "Compute SLA figures") as run:
            r = sla.refresh()
            msg = f"{r['agreements']} agreement(s), {r['failed']} failed"
            self.stdout.write(self.style.SUCCESS(msg))
            run.note(msg, **r)
