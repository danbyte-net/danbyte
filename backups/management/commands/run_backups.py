"""Schedule tick: enqueue every backup schedule whose next occurrence has
passed. Runs every five minutes (danbyte-backups.timer / run_scheduler).

    manage.py run_backups
"""
from __future__ import annotations

import logging

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from backups.engine import reap_stale
from backups.schedules import due_schedules, fire_schedule
from core.scheduled_runs import record_run

logger = logging.getLogger("danbyte.backups")


class Command(BaseCommand):
    help = "Start the backup schedules that are due."

    def handle(self, *args, **opts):
        with record_run("backups", "Scheduled backups") as run:
            now = timezone.localtime()
            reaped = reap_stale(now)
            fired, failed = [], []
            # One schedule that cannot start must not stop the others; it
            # stays due and the next tick tries it again (#360).
            for schedule in due_schedules(now):
                try:
                    fired.append(fire_schedule(schedule, now))
                except Exception as exc:  # noqa: BLE001
                    logger.exception("backup schedule %s could not start", schedule.name)
                    failed.append(schedule)
                    self.stderr.write(f"{schedule.name}: could not start ({exc})")
            if reaped:
                self.stdout.write(f"marked {reaped} stalled backup(s) failed")
            if failed:
                names = ", ".join(s.name for s in failed)
                started = f"started {len(fired)} backup(s), " if fired else ""
                run.note(f"{started}{len(failed)} could not start: {names}",
                         backups=[str(b.id) for b in fired],
                         failed=[str(s.id) for s in failed], reaped=reaped)
                raise CommandError(f"{len(failed)} backup schedule(s) could not start: {names}")
            if fired:
                run.note(f"started {len(fired)} backup(s)", backups=[str(b.id) for b in fired], reaped=reaped)
                self.stdout.write(self.style.SUCCESS(f"started {len(fired)} backup(s)"))
            else:
                run.skip("nothing due")
                self.stdout.write("nothing due")
