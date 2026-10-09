"""poll_snmp - poll observed SNMP state for every device that resolves a profile.

Schedulable (cron / systemd timer, like the other monitoring beat jobs). Each
run stores facts + interfaces and appends interface counter samples, so repeated
runs build the utilisation series (#84, Phase 2). Devices with no resolvable
profile are skipped, and so are devices an Outpost polls (#325).
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from api.models import Device
from core.models import Tenant
from monitoring.engines import engines_for_devices
from monitoring.models import MonitoringEngine
from monitoring.snmp_poll import poll_device
from monitoring.vc_stack import stack_owner


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

        polled = unreachable = skipped = remote = 0
        for tenant in tenants:
            devices = list(
                Device.objects.filter(tenant=tenant).select_related("primary_ip")
            )
            engines = engines_for_devices(tenant, devices)
            for device in devices:
                # One poll per stack, on its owner - a member would only
                # repeat the same read (#148).
                if device.virtual_chassis_id and stack_owner(device).id != device.id:
                    continue
                # A device an Outpost polls is the Outpost's to poll: a central
                # read would report an outpost-only network unreachable and
                # overwrite the agent's last good observation (#325).
                if engines[device.id].kind == MonitoringEngine.REMOTE:
                    remote += 1
                    continue
                state, reason = poll_device(device, tenant)
                if reason is not None:
                    skipped += 1
                    continue
                polled += 1
                if state.reachable is False:
                    unreachable += 1

        self.stdout.write(self.style.SUCCESS(
            f"Polled {polled} device(s) - {unreachable} unreachable, "
            f"{skipped} skipped (no profile/target), {remote} left to their Outpost."
        ))
