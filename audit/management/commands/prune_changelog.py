"""Delete change-log entries past their retention window.

Run daily by danbyte-prune.timer.

    manage.py prune_changelog
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from audit.retention import prune
from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Prune change-log entries past CHANGELOG_RETENTION_DAYS."

    def handle(self, *args, **opts):
        with record_run("prune-changelog", "Prune changelog") as run:
            r = prune()
            if r["retention_days"]:
                run.note(
                    f"pruned {r['deleted']} change-log entr(ies) (> {r['retention_days']}d)",
                    deleted=r["deleted"],
                    retention_days=r["retention_days"],
                )
                self.stdout.write(
                    self.style.SUCCESS(
                        f"pruned {r['deleted']} change-log entr(ies) "
                        f"(> {r['retention_days']}d)"
                    )
                )
            else:
                run.skip("change-log pruning disabled (retention = 0)")
                self.stdout.write("change-log pruning disabled (retention = 0)")
