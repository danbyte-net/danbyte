"""Queue due package-inventory runs (#451 B2).

    manage.py inventory_dispatch

Run by ``danbyte-inventory.timer`` every 15 minutes (and ``run_scheduler``
in a container). While ``DANBYTE_DISCOVERY_ENABLED`` is off, or no tenant
has the Discovery integration on, it queues nothing; it still purges
packages removed more than 30 days ago and gives up runs whose worker died.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Queue due inventory profiles; purge long-removed packages."

    def handle(self, *args, **options):
        from discovery.runner import dispatch

        with record_run("inventory", "Package inventory") as rec:
            out = dispatch()
            summary = (f"{out['queued']} runs queued, {out['abandoned']} given up, "
                       f"{out['purged']} removed packages purged")
            rec.note(summary, **out)
            self.stdout.write(self.style.SUCCESS(summary))
