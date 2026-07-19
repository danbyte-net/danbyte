"""poll_snmp — poll observed SNMP state for every device that resolves a profile.

Schedulable (cron / systemd timer, like the other monitoring beat jobs). Each
run stores facts + interfaces and appends interface counter samples, so repeated
runs build the utilisation series (#84, Phase 2). Devices with no resolvable
profile are skipped.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from api.models import Device
from core.models import Tenant
from monitoring.snmp_poll import poll_device


class Command(BaseCommand):
    help = "Poll SNMP observed state for all devices with a resolved profile."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", help="Tenant slug or id. Omit for all.")

    def handle(self, *args, **opts):
        sel = opts.get("tenant")
        if sel:
            tenant = Tenant.objects.filter(slug=sel).first()
            if tenant is None:
                try:
                    tenant = Tenant.objects.filter(pk=sel).first()
                except (ValueError, Exception):  # noqa: BLE001
                    tenant = None
            if tenant is None:
                raise CommandError(f"No tenant matching {sel!r}.")
            tenants = [tenant]
        else:
            tenants = list(Tenant.objects.filter(is_active=True))

        polled = unreachable = skipped = 0
        for tenant in tenants:
            devices = Device.objects.filter(tenant=tenant).select_related("primary_ip")
            for device in devices:
                state, reason = poll_device(device, tenant)
                if reason is not None:
                    skipped += 1
                    continue
                polled += 1
                if state.reachable is False:
                    unreachable += 1

        self.stdout.write(self.style.SUCCESS(
            f"Polled {polled} device(s) — {unreachable} unreachable, "
            f"{skipped} skipped (no profile/target)."
        ))
