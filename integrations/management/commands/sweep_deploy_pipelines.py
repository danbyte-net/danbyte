"""Fail pipeline steps that waited too long for their reported result, and
move their runs on. Runs on the scripts tick (core/schedule.py)."""
from __future__ import annotations

from django.core.management.base import BaseCommand

from integrations.pipelines import sweep_timeouts


class Command(BaseCommand):
    help = "Fail deploy pipeline steps whose result did not arrive in time."

    def handle(self, *args, **opts):
        n = sweep_timeouts()
        self.stdout.write(f"timed out {n} step(s)" if n else "nothing timed out")
