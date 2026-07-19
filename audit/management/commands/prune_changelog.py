"""Delete change-log entries past their retention window.

Run daily by danbyte-prune.timer.

    manage.py prune_changelog
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from audit.retention import prune


class Command(BaseCommand):
    help = "Prune change-log entries past CHANGELOG_RETENTION_DAYS."

    def handle(self, *args, **opts):
        r = prune()
        if r["retention_days"]:
            self.stdout.write(
                self.style.SUCCESS(
                    f"pruned {r['deleted']} change-log entr(ies) "
                    f"(> {r['retention_days']}d)"
                )
            )
        else:
            self.stdout.write("change-log pruning disabled (retention = 0)")
