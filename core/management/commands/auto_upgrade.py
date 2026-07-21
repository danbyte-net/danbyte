"""auto_upgrade — scheduled check + (windowed) self-upgrade to the latest release.

Run on a timer (see services/danbyte-auto-upgrade.*). No-op unless auto-update is
enabled in Deployment settings; respects the maintenance window (blank = anytime).
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.auto_upgrade import check_and_upgrade
from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Auto-upgrade Danbyte to the latest release when enabled + in window."

    def handle(self, *args, **opts):
        with record_run("auto-upgrade", "Auto-upgrade check") as run:
            result = check_and_upgrade()
            self.stdout.write(str(result))
            if "upgrading" in result:
                run.note(
                    f"Upgrading {result.get('from')} -> {result['upgrading']}",
                    **result,
                )
            elif "skipped" in result:
                run.skip(str(result["skipped"]))
