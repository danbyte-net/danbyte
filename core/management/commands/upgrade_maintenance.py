"""Hold the site behind the maintenance flag while an upgrade starts the new
code, or release it.

    manage.py upgrade_maintenance on [--ttl 900]
    manage.py upgrade_maintenance off

While the flag is set every request but the health probe and the upgrade
status answers 503. A request carrying ``X-Danbyte-Probe`` with the token
from ``DANBYTE_UPGRADE_PROBE`` (the environment, never argv) passes, so the
upgrade can load a real page before users can. The flag expires by itself
after ``--ttl`` seconds should the upgrade die holding it.
"""
from __future__ import annotations

import os

from django.core.management.base import BaseCommand, CommandError

from backups import maintenance


class Command(BaseCommand):
    help = "Set or clear the upgrade maintenance flag."

    def add_arguments(self, parser):
        parser.add_argument("action", choices=["on", "off"])
        parser.add_argument("--ttl", type=int, default=900,
                            help="seconds before the flag expires by itself (default 900)")
        parser.add_argument("--reason", default="upgrade in progress")

    def handle(self, *args, **opts):
        if opts["action"] == "off":
            maintenance.leave()
            self.stdout.write("maintenance off")
            return
        if opts["ttl"] < 30:
            raise CommandError("--ttl must be at least 30 seconds")
        state = maintenance.active()
        if state and not state.get("upgrade"):
            raise CommandError(f"the site is held by something else: {state.get('reason')}")
        maintenance.enter(opts["reason"], ttl=opts["ttl"],
                          probe=os.environ.get("DANBYTE_UPGRADE_PROBE", ""), upgrade=True)
        self.stdout.write(f"maintenance on for at most {opts['ttl']}s")
