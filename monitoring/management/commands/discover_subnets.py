"""ICMP-sweep prefixes flagged for discovery and auto-create new responders.

Opt-in: only runs for tenants with ``discovery_enabled`` and prefixes with
``auto_discover``. Run periodically by danbyte-discover.timer.

    manage.py discover_subnets
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring.discovery import run_discovery


class Command(BaseCommand):
    help = "Discover responders in auto_discover prefixes and create IPs."

    def handle(self, *args, **opts):
        with record_run("discover", "Subnet discovery") as run:
            r = run_discovery()
            self.stdout.write(
                self.style.SUCCESS(
                    f"discovery: created {r['created']} IP(s) across "
                    f"{r['prefixes']} prefix(es)"
                )
            )
            run.note(
                f"created {r['created']} IP(s) across {r['prefixes']} prefix(es)",
                created=r["created"],
                prefixes=r["prefixes"],
            )
