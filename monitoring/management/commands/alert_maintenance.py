"""Run periodic alert maintenance — renotify, escalation, flap dampening (A5).

Run on a timer by danbyte-alert-maintenance.timer.

    manage.py alert_maintenance
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring.escalation import run_alert_maintenance


class Command(BaseCommand):
    help = "Renotify / escalate / flap-dampen firing alerts."

    def handle(self, *args, **opts):
        with record_run("alert-maintenance", "Alert maintenance") as run:
            r = run_alert_maintenance()
            self.stdout.write(
                self.style.SUCCESS(
                    f"alert maintenance: {r['flapping']} flapping, "
                    f"{r['escalated']} escalated, {r['renotified']} renotified"
                )
            )
            run.note(
                f"{r['flapping']} flapping, {r['escalated']} escalated, "
                f"{r['renotified']} renotified",
                flapping=r["flapping"],
                escalated=r["escalated"],
                renotified=r["renotified"],
            )
