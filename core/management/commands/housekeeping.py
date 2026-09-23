"""Remove the files Danbyte leaves behind: old rollback archives, surplus
before-upgrade backups, wheels from earlier releases, the downloaded bundle,
abandoned work folders and old rotated logs. See core.housekeeping.

    manage.py housekeeping             # remove what is stale
    manage.py housekeeping --dry-run   # only say what would go

Runs daily from the danbyte-prune timer and at the end of every upgrade.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core import housekeeping


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):.1f} MB"


class Command(BaseCommand):
    help = "Remove stale upgrade leftovers, surplus backups and old rotated logs."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true",
                            help="Report what would be removed, remove nothing.")

    def handle(self, *args, **opts):
        if opts["dry_run"]:
            rep = housekeeping.report()
            for row in rep["stale"]:
                self.stdout.write(f"{row['label']}: {row['count']} ({_mb(row['bytes'])})")
            self.stdout.write(f"would free {_mb(rep['stale_bytes'])}")
            return
        out = housekeeping.run()
        for row in out["removed"]:
            if row["count"]:
                self.stdout.write(f"{row['label']}: removed {row['count']} ({_mb(row['bytes'])})")
        self.stdout.write(f"housekeeping freed {_mb(out['freed_bytes'])}")
