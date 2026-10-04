"""Check every SLA agreement's burn-rate alerts.

Run every minute by danbyte-sla-burn.timer: computes each rule's long and
short window, and notifies as a rule starts or stops firing.

    manage.py sla_burn
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring import sla_burn


class Command(BaseCommand):
    help = "Evaluate SLA burn-rate alerts."

    def handle(self, *args, **opts):
        with record_run("sla-burn", "Check SLA burn rates") as run:
            r = sla_burn.run()
            msg = f"{r['agreements']} agreement(s), {r['failed']} failed"
            self.stdout.write(self.style.SUCCESS(msg))
            run.note(msg, **r)
