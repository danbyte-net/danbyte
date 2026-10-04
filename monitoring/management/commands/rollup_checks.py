"""Fold check history into the hourly and daily rollups.

Run every 5 minutes by danbyte-rollups.timer: it rewrites the open hour and
day and closes the ones that just ended. ``--backfill N`` rebuilds N days
from the history still on disk - daily from transitions (kept a year),
latency only as far back as raw results (kept 30 days).

    manage.py rollup_checks
    manage.py rollup_checks --backfill 90
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring import rollups


class Command(BaseCommand):
    help = "Roll check history into hourly and daily rollups."

    def add_arguments(self, parser):
        parser.add_argument(
            "--backfill", type=int, metavar="DAYS", default=0,
            help="Rebuild this many days of rollups from stored history.",
        )

    def handle(self, *args, **opts):
        days = opts["backfill"]
        with record_run("rollup-checks", "Roll up check history") as run:
            r = rollups.backfill(days) if days > 0 else rollups.refresh()
            msg = f"{r['hourly']} hourly and {r['daily']} daily row(s) for {r['tenants']} tenant(s)"
            self.stdout.write(self.style.SUCCESS(msg))
            run.note(msg, **r)
