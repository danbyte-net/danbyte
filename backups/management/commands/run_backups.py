"""Schedule tick: enqueue every backup schedule whose next occurrence has
passed. Runs every five minutes (danbyte-backups.timer / run_scheduler).

    manage.py run_backups
"""
from __future__ import annotations

from django.core.management.base import BaseCommand
from django.utils import timezone

from backups.schedules import due_schedules, fire_schedule
from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Start the backup schedules that are due."

    def handle(self, *args, **opts):
        with record_run("backups", "Scheduled backups") as run:
            now = timezone.localtime()
            fired = [fire_schedule(s, now) for s in due_schedules(now)]
            if fired:
                run.note(f"started {len(fired)} backup(s)", backups=[str(b.id) for b in fired])
                self.stdout.write(self.style.SUCCESS(f"started {len(fired)} backup(s)"))
            else:
                run.skip("nothing due")
                self.stdout.write("nothing due")
