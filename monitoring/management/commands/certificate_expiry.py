"""Sweep certificate bindings and reconcile their expiry alerts.

Run daily by ``danbyte-certificate-expiry.timer``. The reactive path (every
``tls_cert`` observation) already opens and resolves alerts for the endpoints it
just saw; this sweep is what makes *time passing* enough - a certificate crosses
the 30-day line whether or not anything scanned it today.

    manage.py certificate_expiry
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from core.site_tls import renew_self_signed_if_due
from monitoring.cert_expiry import sweep


class Command(BaseCommand):
    help = "Open/update/resolve certificate expiry alerts for every endpoint."

    def handle(self, *args, **opts):
        with record_run("certificate-expiry", "Certificate expiry") as run:
            r = sweep()
            # Danbyte's own self-signed certificate, when it runs short.
            try:
                if renew_self_signed_if_due():
                    self.stdout.write("site certificate: self-signed pair regenerated")
            except Exception as exc:  # noqa: BLE001 - never fail the sweep over it
                self.stderr.write(f"site certificate: renewal failed: {exc}")
            self.stdout.write(
                self.style.SUCCESS(
                    f"certificate expiry: {r['checked']} endpoints, "
                    f"{r['opened']} opened, {r['updated']} updated, "
                    f"{r['resolved']} resolved, {r['stale']} stale"
                )
            )
            run.note(
                f"{r['checked']} endpoints, {r['opened']} opened, "
                f"{r['updated']} updated, {r['resolved']} resolved",
                **r,
            )
