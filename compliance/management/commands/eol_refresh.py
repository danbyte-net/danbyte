"""Refresh end-of-life data (#8). Daily (danbyte-eol-refresh.timer /
run_scheduler); a no-op until a deployment admin turns the feature on.

    manage.py eol_refresh
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from compliance.eol import refresh
from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Fetch end-of-life data from the enabled sources and update platform mappings."

    def handle(self, *args, **opts):
        with record_run("eol-refresh", "End-of-life data") as run:
            result = refresh()
            if result.get("skipped"):
                run.skip("end-of-life data is off")
                self.stdout.write("end-of-life data is off")
                return
            parts = [
                f"{key}: {r['products']} products, {r['changed']} mapping(s) changed"
                for key, r in result["sources"].items()
            ]
            summary = "; ".join(parts) or "no sources enabled"
            if result["errors"]:
                run.note("; ".join([*parts, *result["errors"]]), **result)
                raise CommandError("; ".join(result["errors"]))
            run.note(summary, **result)
            self.stdout.write(self.style.SUCCESS(summary))
