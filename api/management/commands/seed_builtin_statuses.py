"""seed_builtin_statuses — create/merge the built-in Status catalog.

Idempotent. Use it to backfill tenants that predate the runtime seeding
(e.g. created by the 0047 migration on an empty DB), or to repair a tenant whose
catalog drifted. Tenants created through the API are seeded automatically by
``TenantViewSet.perform_create``.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from api.status_registry import seed_builtin_statuses
from core.models import Tenant


class Command(BaseCommand):
    help = "Create/merge the built-in Status catalog for one or all tenants (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--tenant",
            help="Tenant slug or id. Omit to seed every tenant.",
        )

    def handle(self, *args, **opts):
        sel = opts.get("tenant")
        if sel:
            tenant = Tenant.objects.filter(slug=sel).first()
            if tenant is None:
                try:
                    tenant = Tenant.objects.filter(pk=sel).first()
                except (ValueError, ValidationError):  # malformed UUID → no match
                    tenant = None
            if tenant is None:
                raise CommandError(f"No tenant matching {sel!r}.")
            tenants = [tenant]
        else:
            tenants = list(Tenant.objects.all())

        if not tenants:
            self.stdout.write("No tenants exist yet — nothing to seed.")
            return

        for tenant in tenants:
            created = seed_builtin_statuses(tenant)
            self.stdout.write(
                self.style.SUCCESS(f"{tenant.name}: {created} new status(es).")
            )
