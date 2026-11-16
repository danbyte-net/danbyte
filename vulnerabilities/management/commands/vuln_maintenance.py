"""Daily vulnerability upkeep (#451): expired exceptions reopen their
matches and notify once; resolved matches older than 365 days are deleted.
The second command of danbyte-vuln-refresh (and run_scheduler's row).
Expiry is skipped while vulnerability data is off; the purge always runs.

    manage.py vuln_maintenance
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from vulnerabilities import maintenance
from vulnerabilities.models import VulnerabilitySettings


class Command(BaseCommand):
    help = "Expire vulnerability exceptions and purge old resolved matches."

    def handle(self, *args, **opts):
        with record_run("vuln-maintenance", "Vulnerability upkeep") as rec:
            expired = {"exceptions": 0, "reopened": 0}
            if VulnerabilitySettings.load().enabled:
                expired = maintenance.expire_exceptions()
            purged = maintenance.purge_resolved()
            summary = (f"{expired['exceptions']} exceptions expired, "
                       f"{expired['reopened']} matches reopened, "
                       f"{purged} resolved matches purged")
            rec.note(summary, **{k: v for k, v in expired.items()}, purged=purged)
            self.stdout.write(self.style.SUCCESS(summary))
