"""Delete CheckResult / StateTransition rows past their retention window.

Run daily by danbyte-prune.timer.

    manage.py prune_check_results
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring.retention import prune


class Command(BaseCommand):
    help = "Prune monitoring time-series rows past their retention window."

    def handle(self, *args, **opts):
        with record_run("prune-results", "Prune check results") as run:
            r = prune()
            self.stdout.write(
                self.style.SUCCESS(
                    f"pruned {r['results_deleted']} result(s) (> {r['result_retention_days']}d) "
                    f"and {r['transitions_deleted']} transition(s) "
                    f"(> {r['transition_retention_days']}d)"
                )
            )
            run.note(
                f"pruned {r['results_deleted']} result(s), "
                f"{r['transitions_deleted']} transition(s)",
                results_deleted=r["results_deleted"],
                transitions_deleted=r["transitions_deleted"],
                result_retention_days=r["result_retention_days"],
                transition_retention_days=r["transition_retention_days"],
            )
