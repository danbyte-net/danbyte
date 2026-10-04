"""Check that the code on disk runs on this database - the upgrade's last
step before any service starts.

    manage.py upgrade_verify

Nothing pending, nothing applied that the code does not ship, one row of
every table readable through its model, and a few list endpoints answering
without a server error. Exit 1 with the problems listed otherwise.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from core import upgrade_migrate


class Command(BaseCommand):
    help = "Verify the code on disk against the database (used by upgrades)."

    def handle(self, *args, **opts):
        problems, notes = upgrade_migrate.verify()
        for note in notes:
            self.stdout.write(f"note: {note}")
        if problems:
            for p in problems:
                self.stderr.write(p)
            raise CommandError(f"{len(problems)} problem(s): {problems[0]}")
        self.stdout.write("verified")
