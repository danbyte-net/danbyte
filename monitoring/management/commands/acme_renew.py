"""Re-issue ACME certificates that are near expiry.

Run several times a day by ``danbyte-acme-renew.timer`` - step-ca's default
24-hour certs must be renewed well within the day. Each certificate is renewed
once it is two-thirds through its own lifetime, so the same cadence safely covers
both short-lived and 90-day certs.

    manage.py acme_renew
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring.acme_renew import renew_due


class Command(BaseCommand):
    help = "Re-issue ACME certificates that have crossed their renewal point."

    def handle(self, *args, **opts):
        with record_run("acme-renew", "ACME renewal") as run:
            r = renew_due()
            self.stdout.write(
                self.style.SUCCESS(
                    f"acme renewal: {r['checked']} checked, {r['renewed']} renewed, "
                    f"{r['skipped_manual']} manual-skipped, {r['in_flight']} in-flight"
                )
            )
            run.note(
                f"{r['checked']} checked, {r['renewed']} renewed, "
                f"{r['skipped_manual']} manual-skipped",
                **r,
            )
