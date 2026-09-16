"""Make a backup right now, inline - what the upgrade scripts and the host
admin script call.

    manage.py backup_now [--components db,media,config] [--target Local]
                         [--kind manual|pre_upgrade]
"""
from __future__ import annotations

import sys

from django.core.management.base import BaseCommand, CommandError

from backups.engine import create_backup, run_backup
from backups.models import COMPONENTS, BackupTarget
from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Make a backup now (database, media, config) and store it on a target."

    def add_arguments(self, parser):
        parser.add_argument("--components", default=",".join(COMPONENTS),
                            help="Comma list of db,media,config (default all).")
        parser.add_argument("--target", default="", help="Target name (default: the default target).")
        parser.add_argument("--kind", default="manual", choices=["manual", "pre_upgrade"])

    def handle(self, *args, **opts):
        comps = [c.strip() for c in opts["components"].split(",") if c.strip()]
        bad = [c for c in comps if c not in COMPONENTS]
        if bad:
            raise CommandError(f"Unknown component(s): {', '.join(bad)}")
        target = None
        if opts["target"]:
            target = BackupTarget.objects.filter(name=opts["target"]).first()
            if target is None:
                raise CommandError(f"No backup target named {opts['target']!r}.")
        with record_run("backup-now", "Backup now") as run:
            backup = create_backup(kind=opts["kind"], components=comps, target=target)
            backup = run_backup(str(backup.id))
            if backup is None or backup.status != "success":
                err = backup.error if backup else "backup row vanished"
                run.note(f"failed: {err}")
                self.stderr.write(f"backup failed: {err}")
                sys.exit(1)
            run.note(f"{backup.filename} ({backup.size} bytes) on {backup.target.name}",
                     backup=str(backup.id))
            self.stdout.write(f"{backup.id} {backup.location}")
