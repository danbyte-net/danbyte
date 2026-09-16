"""Rebuild the global search index from the source tables.

Runs nightly (danbyte-search-reindex.timer) to catch bulk paths that bypass
the save signals, and after every upgrade.

    manage.py rebuild_search_index [--type device --type prefix]
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from api.search_index import SPECS, rebuild
from core.scheduled_runs import record_run


class Command(BaseCommand):
    help = "Rebuild the global search index (all types, or --type slug …)."

    def add_arguments(self, parser):
        parser.add_argument("--type", action="append", dest="types", default=[],
                            choices=sorted(SPECS), help="Only these object types.")

    def handle(self, *args, **opts):
        with record_run("search-reindex", "Rebuild search index") as run:
            counts = rebuild(opts["types"] or None, log=lambda m: self.stdout.write(m))
            total = sum(counts.values())
            run.note(f"indexed {total} objects across {len(counts)} types", total=total)
            self.stdout.write(self.style.SUCCESS(f"indexed {total} objects"))
