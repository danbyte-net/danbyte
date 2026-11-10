"""Read the running software version again (#451): from the stored SNMP
facts and from the current Oxidized configurations, after an upgrade or after
a platform's version pattern changed.

    manage.py extract_software_versions [--tenant <id>] [--platform <id>]
        [--source all|snmp|oxidized] [--enqueue]

A version a person typed or imported is never replaced. The Oxidized re-read
fetches every confirmed link's config from Oxidized.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from api.software_versions import SOURCES_REREAD, reextract, run_reextract


class Command(BaseCommand):
    help = (
        "Read device and VM software versions from stored SNMP sysDescr facts and "
        "Oxidized configurations."
    )

    def add_arguments(self, parser):
        parser.add_argument("--tenant", help="Only this tenant (id).")
        parser.add_argument("--platform", help="Only objects on this platform (id).")
        parser.add_argument(
            "--source", choices=("all", *SOURCES_REREAD), default="all",
            help="Read only SNMP facts or only Oxidized configurations (default both).",
        )
        parser.add_argument(
            "--enqueue", action="store_true",
            help="Run as a background job on the low queue instead of here.",
        )

    def handle(self, *args, tenant=None, platform=None, source="all", enqueue=False, **opts):
        sources = SOURCES_REREAD if source == "all" else (source,)
        if enqueue:
            import django_rq

            job = django_rq.get_queue("low").enqueue(
                run_reextract, tenant, platform, sources, job_timeout=1800
            )
            self.stdout.write(f"Queued {job.id}.")
            return
        n = reextract(tenant_id=tenant, platform_id=platform, sources=sources)
        self.stdout.write(f"{n} version{'s' if n != 1 else ''} updated.")
