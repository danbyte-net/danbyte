"""Delete CheckResult / StateTransition rows past their retention window.

Run daily by danbyte-prune.timer.

    manage.py prune_check_results
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from monitoring.retention import prune


class Command(BaseCommand):
    help = "Prune monitoring time-series rows past their retention window."

    def handle(self, *args, **opts):
        r = prune()
        self.stdout.write(
            self.style.SUCCESS(
                f"pruned {r['results_deleted']} result(s) (> {r['result_retention_days']}d) "
                f"and {r['transitions_deleted']} transition(s) "
                f"(> {r['transition_retention_days']}d)"
            )
        )
