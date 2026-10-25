"""Read the running software version again from the stored SNMP facts
(#451): after an upgrade, or after a platform's version pattern changed.

    manage.py extract_software_versions [--tenant <id>] [--platform <id>] [--enqueue]

A version a person typed or imported is never replaced.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from api.software_versions import reextract, run_reextract


class Command(BaseCommand):
    help = "Read device and VM software versions from stored SNMP sysDescr facts."

    def add_arguments(self, parser):
        parser.add_argument("--tenant", help="Only this tenant (id).")
        parser.add_argument("--platform", help="Only objects on this platform (id).")
        parser.add_argument(
            "--enqueue", action="store_true",
            help="Run as a background job on the low queue instead of here.",
        )

    def handle(self, *args, tenant=None, platform=None, enqueue=False, **opts):
        if enqueue:
            import django_rq

            job = django_rq.get_queue("low").enqueue(
                run_reextract, tenant, platform, job_timeout=1800
            )
            self.stdout.write(f"Queued {job.id}.")
            return
        n = reextract(tenant_id=tenant, platform_id=platform)
        self.stdout.write(f"{n} version{'s' if n != 1 else ''} updated.")
