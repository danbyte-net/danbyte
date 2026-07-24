"""poll_hardware — refresh hardware inventory + health on a schedule.

Runs the BMC (Redfish) collector and the custom SNMP sensors for every device
that has them configured, reconciling drives/CPUs/RAM/PSUs/fans and flipping
inventory-item statuses (OK→active, failed→failed). The button on the device
page does the same for one device; this is the periodic beat (systemd timer
``danbyte-hardware``), so a failed disk turns red without anyone clicking.

Scheduled scope, kept bounded:
  * every device with an enabled ``RedfishEndpoint``;
  * every device whose type a ``SnmpSensor`` targets, plus — when a tenant has
    an all-types sensor — every device with a primary IP.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from api.models import Device
from core.models import Tenant
from monitoring.models import RedfishEndpoint, SnmpSensor
from monitoring.redfish import poll_endpoint
from monitoring.snmp_sensors import poll_device_sensors


class Command(BaseCommand):
    help = "Poll BMC (Redfish) + custom SNMP sensors for all configured devices."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", help="Tenant slug or id. Omit for all.")

    def handle(self, *args, **opts):
        sel = opts.get("tenant")
        if sel:
            tenant = (
                Tenant.objects.filter(slug=sel).first()
                or Tenant.objects.filter(pk=sel).first()
            )
            if tenant is None:
                raise CommandError(f"No tenant matching {sel!r}.")
            tenants = [tenant]
        else:
            tenants = list(Tenant.objects.filter(is_active=True))

        redfish = sensors = flips = errors = 0
        for tenant in tenants:
            # BMC endpoints.
            for ep in RedfishEndpoint.objects.filter(
                tenant=tenant, enabled=True
            ).select_related("device"):
                poll_endpoint(ep)
                redfish += 1
                if ep.reachable is False:
                    errors += 1

            # Sensor devices: type-scoped targets, plus all-with-IP when an
            # all-types sensor exists.
            enabled = SnmpSensor.objects.filter(tenant=tenant, enabled=True)
            if not enabled.exists():
                continue
            type_ids = set(
                enabled.exclude(device_type__isnull=True)
                .values_list("device_type_id", flat=True)
            )
            has_global = enabled.filter(device_type__isnull=True).exists()
            q = Q(device_type_id__in=type_ids)
            if has_global:
                q |= Q(primary_ip__isnull=False)
            for device in Device.objects.filter(tenant=tenant).filter(q).distinct():
                result = poll_device_sensors(device, tenant)
                sensors += 1
                flips += result.get("flipped", 0)
                if result.get("error"):
                    errors += 1

        self.stdout.write(self.style.SUCCESS(
            f"Hardware poll: {redfish} BMC, {sensors} sensor device(s), "
            f"{flips} status change(s), {errors} error(s)."
        ))
