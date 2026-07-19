"""Evaluate prefix utilization and fire alerts on threshold crossings.

Run periodically by danbyte-utilization.timer.

    manage.py check_utilization
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from monitoring.utilization import evaluate_utilization


class Command(BaseCommand):
    help = "Fire prefix-utilization alerts for prefixes over the threshold."

    def handle(self, *args, **opts):
        r = evaluate_utilization()
        self.stdout.write(
            self.style.SUCCESS(
                f"utilization: {r['fired']} alert(s) fired, "
                f"{r['rearmed']} re-armed (threshold {r['threshold']}%)"
            )
        )
