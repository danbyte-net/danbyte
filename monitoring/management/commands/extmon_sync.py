"""Enqueue due passes for every external monitor on the shared beat.

    manage.py extmon_sync              # entries without a timer of their own
    manage.py extmon_sync --only NAME  # one entry, own timer or not

Systems with a timer of their own (Zabbix: ``danbyte-zabbix-sync.timer``)
are skipped unless named, so this never doubles them.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring.external.beat import run_beat


class Command(BaseCommand):
    help = "Enqueue due external-monitoring passes (status, sync, maintenance)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--only", action="append", default=None, metavar="NAME",
            help="Run only this beat entry (repeatable).",
        )

    def handle(self, *args, **opts):
        with record_run("extmon-sync", "External monitoring sync") as run:
            out = run_beat(names=opts["only"])
            queued = sum(
                n for counts in out.values() for n in (counts or {}).values()
                if isinstance(n, int)
            )
            if not out:
                run.skip("no external monitor on the beat")
            else:
                run.note(f"{queued} queued", **out)
            self.stdout.write(
                self.style.SUCCESS(f"external monitoring: {queued} queued")
            )
