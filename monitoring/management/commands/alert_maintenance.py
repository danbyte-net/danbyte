"""Run periodic alert maintenance — renotify, escalation, flap dampening (A5).

Run on a timer by danbyte-alert-maintenance.timer.

    manage.py alert_maintenance
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from monitoring.escalation import run_alert_maintenance


class Command(BaseCommand):
    help = "Renotify / escalate / flap-dampen firing alerts."

    def handle(self, *args, **opts):
        r = run_alert_maintenance()
        self.stdout.write(
            self.style.SUCCESS(
                f"alert maintenance: {r['flapping']} flapping, "
                f"{r['escalated']} escalated, {r['renotified']} renotified"
            )
        )
