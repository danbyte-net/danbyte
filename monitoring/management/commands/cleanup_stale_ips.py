"""Delete discovered IPs that have been unreachable past the grace period.

Opt-in + conservative: only tenants with ``cleanup_enabled``, and only IPs
marked ``discovered`` (user-entered IPs are never removed). Run daily by
danbyte-cleanup.timer.

    manage.py cleanup_stale_ips
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring.discovery import cleanup_stale_ips


class Command(BaseCommand):
    help = "Delete stale, auto-discovered IPs per tenant cleanup settings."

    def handle(self, *args, **opts):
        with record_run("cleanup-ips", "Stale-IP cleanup") as run:
            r = cleanup_stale_ips()
            self.stdout.write(
                self.style.SUCCESS(f"cleanup: deleted {r['deleted']} stale discovered IP(s)")
            )
            run.note(
                f"deleted {r['deleted']} stale discovered IP(s)",
                deleted=r["deleted"],
            )
