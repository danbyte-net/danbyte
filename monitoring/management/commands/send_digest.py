"""Send scheduled email digests.

Run daily by a systemd timer (see services/danbyte-digest.timer); each active
tenant is gated by its own effective config (daily, or weekly on the configured
weekday) and last-sent date. Use --tenant/--force to send one now (for testing).

    manage.py send_digest
    manage.py send_digest --tenant acme --force
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Send scheduled monitoring email digests to tenants that are due."

    def add_arguments(self, parser):
        parser.add_argument(
            "--tenant",
            help="Send immediately for this tenant (slug or id), ignoring the "
            "schedule. Implies a one-off send.",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="With --tenant: send even if the digest is disabled.",
        )

    def handle(self, *args, **opts):
        with record_run("digest", "Email digest") as run:
            from core.models import Tenant
            from monitoring.digest import run_scheduled_digests, send_tenant_digest

            from monitoring.cert_digest import (
                run_scheduled_cert_digests,
                send_cert_digest,
            )

            slug = opts.get("tenant")
            if slug:
                tenant = (
                    Tenant.objects.filter(slug=slug).first()
                    or Tenant.objects.filter(id=slug).first()
                )
                if tenant is None:
                    raise CommandError(f"No tenant matching {slug!r}")
                force = opts.get("force", False)
                ok = send_tenant_digest(tenant, force=force)
                cert_ok = send_cert_digest(tenant, force=force)
                if ok or cert_ok:
                    self.stdout.write(self.style.SUCCESS(
                        f"digest sent for {tenant.name} "
                        f"(monitoring={ok}, certificate={cert_ok})"))
                    run.note(f"one-off digest sent for {tenant.name}", count=1)
                else:
                    self.stdout.write(
                        "not sent (disabled, or no recipients configured)"
                    )
                    run.note(
                        f"one-off digest not sent for {tenant.name} "
                        "(disabled or no recipients)",
                        count=0,
                    )
                return

            count = run_scheduled_digests()
            cert_count = run_scheduled_cert_digests()
            self.stdout.write(self.style.SUCCESS(
                f"sent {count} monitoring + {cert_count} certificate digest(s)"))
            total = count + cert_count
            if total:
                run.note(
                    f"sent {count} monitoring + {cert_count} certificate digest(s)",
                    count=total)
            else:
                run.skip("no tenants due this cycle")
