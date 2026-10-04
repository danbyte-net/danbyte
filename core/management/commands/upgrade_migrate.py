"""Apply pending migrations for an upgrade, all or nothing where possible.

    manage.py upgrade_migrate           # migrate; exit 0, 3 or 4
    manage.py upgrade_migrate --plan    # list what would run, change nothing

Exit 0: migrated (or nothing to do). Exit 3: failed, and the database is
exactly as it was - the plan ran in one transaction and rolled back. Exit 4:
failed, and part of the plan may be applied. ``DANBYTE_UPGRADE_ATOMIC_MIGRATE=0``
in the environment (or .env) runs Django's plain migrate instead.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from core import upgrade_migrate as um


class Command(BaseCommand):
    help = "Apply pending migrations in one transaction where possible (used by upgrades)."

    def add_arguments(self, parser):
        parser.add_argument("--plan", action="store_true",
                            help="list the pending migrations and how they would run")
        parser.add_argument("--no-atomic", action="store_true",
                            help="run Django's plain migrate, one transaction per migration")

    def handle(self, *args, **opts):
        if opts["plan"]:
            plan = um.pending_plan()
            allowed, why = um.atomic_allowed(plan)
            for m in plan:
                kind = "" if getattr(m, "atomic", True) else " (non-atomic)"
                self.stdout.write(f"  {m.app_label}.{m.name}{kind}")
            self.stdout.write(f"pending: {len(plan)}")
            if plan:
                self.stdout.write("mode: atomic" if allowed and not opts["no_atomic"]
                                  else f"mode: plain ({why or '--no-atomic'})")
            return
        result = um.run_migrate(atomic=not opts["no_atomic"],
                                verbosity=opts.get("verbosity", 1), stdout=self.stdout)
        for note in result.notes:
            self.stdout.write(f"note: {note}")
        self.stdout.write(f"mode: {result.mode}")
        self.stdout.write(f"migrations: {result.planned}")
        if result.code != um.EXIT_OK:
            state = ("the database is unchanged" if result.code == 3
                     else "part of the plan may be applied")
            raise CommandError(f"migration failed ({state}): {result.error}",
                               returncode=result.code)
