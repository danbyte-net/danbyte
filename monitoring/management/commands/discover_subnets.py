"""ICMP-sweep prefixes flagged for discovery and auto-create new responders.

Opt-in: only runs for tenants with ``discovery_enabled`` and prefixes with
``auto_discover``. Run periodically by danbyte-discover.timer.

    manage.py discover_subnets
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from monitoring.discovery import run_discovery


class Command(BaseCommand):
    help = "Discover responders in auto_discover prefixes and create IPs."

    def handle(self, *args, **opts):
        r = run_discovery()
        self.stdout.write(
            self.style.SUCCESS(
                f"discovery: created {r['created']} IP(s) across "
                f"{r['prefixes']} prefix(es)"
            )
        )
