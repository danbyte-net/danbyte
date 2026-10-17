"""poll_snmp - poll observed SNMP state for every target that resolves a profile.

Schedulable (cron / systemd timer, like the other monitoring beat jobs). Each
run stores facts + interfaces and appends interface counter samples, so repeated
runs build the utilisation series (#84, Phase 2). The targets are the
scheduler's: every device (one per stack) and the VMs that are SNMP targets.
Targets with no resolvable profile are skipped, and so are those an Outpost
polls (#325).
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from core.models import Tenant
from monitoring.snmp_poll import poll_target
from monitoring.snmp_schedule import pollable, split_by_poller


class Command(BaseCommand):
    help = "Poll SNMP observed state for all devices and VMs with a resolved profile."

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
            # A target an Outpost polls is the Outpost's to poll: a central
            # read would report an outpost-only network unreachable and
            # overwrite the agent's last good observation (#325).
            core, outposts = split_by_poller(tenant, pollable(tenant))
            remote += len(outposts)
            for target in core:
                state, reason = poll_target(target, tenant)
                if reason is not None:
                    skipped += 1
                    continue
                polled += 1
                if state.reachable is False:
                    unreachable += 1

        self.stdout.write(self.style.SUCCESS(
            f"Polled {polled} target(s) - {unreachable} unreachable, "
            f"{skipped} skipped (no profile/target), {remote} left to their Outpost."
        ))
