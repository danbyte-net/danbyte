"""Record how an upgrade an older upgrader ran ended, for its report.

    manage.py upgrade_report --merge-legacy <file>

The first upgrade off 0.16 is run by 0.16's upgrader, whose status says
neither who started it nor how it ended. The bridge in 0.17's ``migrate``
writes those facts beside the restart unit's list of units; the restart
(``scripts/upgrade/legacy-resume.sh``) runs this once the upgrade finished,
so the Updates page shows the Last upgrade card and the next auto-upgrade
tick mails the report (``core.upgrade_report``).
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.upgrade_report import merge_legacy


class Command(BaseCommand):
    help = "Merge what the migrate bridge recorded into a finished legacy upgrade's status."
    # It runs right after an upgrade, before anything else starts; nothing
    # here needs the checks, and a failing one must not lose the report.
    requires_system_checks: list = []

    def add_arguments(self, parser):
        parser.add_argument("--merge-legacy", metavar="FILE", required=True,
                            help="the bridge's <units>.report.json")

    def handle(self, *args, **opts):
        merged = merge_legacy(opts["merge_legacy"])
        if merged is None:
            self.stdout.write("nothing to merge")
            return
        self.stdout.write(f"recorded the upgrade {merged.get('version_from') or '?'} -> "
                          f"{merged.get('version_to') or '?'} ({merged.get('trigger') or '?'})")
