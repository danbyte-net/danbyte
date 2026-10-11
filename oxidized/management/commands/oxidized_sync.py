"""Enqueue the Oxidized node syncs that are due (#385).

Run every minute by danbyte-oxidized-sync.timer, or by ``run_scheduler`` in
a container. Each connection syncs on its own interval when **Sync
automatically** is on; see ``oxidized.schedule``.

    manage.py oxidized_sync
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from oxidized.schedule import dispatch


class Command(BaseCommand):
    help = "Enqueue automatic Oxidized node syncs that are due."

    def handle(self, *args, **opts):
        with record_run("oxidized-sync", "Oxidized node sync") as run:
            r = dispatch()
            if r.get("enabled") is False:
                self.stdout.write("automatic Oxidized sync is off")
                run.skip("off for every connection")
                return
            summary = (
                f"enqueued {r['enqueued']} of {r['due']} due connection(s), "
                f"{r['connections']} on automatic sync"
            )
            self.stdout.write(self.style.SUCCESS(summary))
            run.note(summary, **r)
