"""Restore a backup inline - the host admin script's entry point.

    manage.py restore_backup <backup id> [--components db,media] --yes
"""
from __future__ import annotations

import sys

from django.core.management.base import BaseCommand, CommandError

from backups.models import Backup
from backups.restore import create_restore, preview, run_restore


class Command(BaseCommand):
    help = "Restore a backup in place (database, media, config). Destructive."

    def add_arguments(self, parser):
        parser.add_argument("backup_id")
        parser.add_argument("--components", default="", help="Comma list; default: what the archive holds.")
        parser.add_argument("--yes", action="store_true", help="Skip the confirmation.")

    def handle(self, *args, **opts):
        backup = Backup.objects.filter(pk=opts["backup_id"]).first()
        if backup is None:
            raise CommandError("No such backup.")
        pv = preview(backup)
        for c in pv["checks"]:
            self.stdout.write(f"[{'ok' if c['ok'] else 'FAIL'}] {c['name']}: {c['detail']}")
        if not pv["can_restore"]:
            raise CommandError("The archive cannot be restored on this host.")
        comps = [c.strip() for c in opts["components"].split(",") if c.strip()] or pv["components"]
        if not opts["yes"]:
            self.stdout.write(f"This replaces {', '.join(comps)} with {backup.filename}. Re-run with --yes.")
            return
        run = run_restore(str(create_restore(backup, comps).id))
        if run is None or run.status != "success":
            self.stderr.write(f"restore failed: {run.error if run else 'no row'}")
            sys.exit(1)
        self.stdout.write(self.style.SUCCESS(f"restored {backup.filename} ({', '.join(comps)})"))
