"""Refresh the cached release list the update check reads (#478).

Run every six hours by ``danbyte-update-check.timer`` (``run_scheduler`` in a
container). ``GET /api/system/updates/`` only reads the cache this fills, so a
slow or unreachable release repo never holds a web worker. Does nothing when
the update check is disabled (airgapped).

    manage.py update_check
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from core.update_check import refresh


class Command(BaseCommand):
    help = "Fetch the release repo's version list into the update-check cache."

    def handle(self, *args, **opts):
        with record_run("update-check", "Update check") as run:
            entry = refresh()
            if entry is None:
                msg = "update check disabled (airgapped)"
            elif entry["error"]:
                msg = f"release list not read: {entry['error']}"
            else:
                msg = f"{len(entry['releases'])} releases cached"
            self.stdout.write(msg)
            run.note(msg)
