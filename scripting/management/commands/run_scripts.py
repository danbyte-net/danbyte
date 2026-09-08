"""The scripts tick: fire due schedules, prune old runs, drop dead run
tokens. One row in core/schedule.py runs this every minute."""
from __future__ import annotations

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.scheduled_runs import record_run
from scripting.models import Script
from scripting.schedules import due_scripts, fire, prune
from scripting.tokens import purge_expired


class Command(BaseCommand):
    help = "Run scheduled scripts that are due, then prune old runs."

    def handle(self, *args, **opts):
        with record_run("scripts", "Scheduled scripts") as run:
            now = timezone.localtime()
            fired = [s for s in due_scripts(now) if fire(s, now) is not None]
            pruned = sum(prune(s) for s in Script.objects.filter(schedule_enabled=True))
            tokens = purge_expired()
            if fired:
                run.note(
                    f"started {len(fired)} script(s)",
                    scripts=[str(s.id) for s in fired], pruned=pruned, tokens=tokens,
                )
                self.stdout.write(self.style.SUCCESS(f"started {len(fired)} script(s)"))
            else:
                run.skip("nothing due")
                self.stdout.write("nothing due")
            if pruned or tokens:
                self.stdout.write(f"pruned {pruned} run(s), {tokens} expired run token(s)")
