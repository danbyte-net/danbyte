"""Rebuild CheckState rows from assignments (resolve effective checks).

Runs periodically (every few minutes) so the dispatcher reads flat CheckState
rows by next_run instead of re-walking the CIDR tree each tick.

    manage.py materialise_checks
    manage.py materialise_checks --tenant <uuid>
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.models import Tenant
from monitoring.scheduler import materialise_states


class Command(BaseCommand):
    help = "Materialise CheckState rows for all (or one tenant's) assignments."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", help="Limit to a single tenant id.")

    def handle(self, *args, **opts):
        tenant = None
        if opts.get("tenant"):
            tenant = Tenant.objects.get(id=opts["tenant"])
        result = materialise_states(tenant=tenant)
        self.stdout.write(
            self.style.SUCCESS(
                f"materialised {result['effective_checks']} effective check(s) "
                f"across {result['ips']} IP(s) in {result['tenants']} tenant(s)"
            )
        )
