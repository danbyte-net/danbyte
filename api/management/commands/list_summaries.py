"""Build and reconcile the stored list summaries (#527, #535).

    manage.py list_summaries                  # every tenant, every kind
    manage.py list_summaries --kind mac       # one kind
    manage.py list_summaries --tenant <slug>  # one tenant
    manage.py list_summaries --missing        # only summaries never built
    manage.py list_summaries --check          # count the drift, write nothing
    manage.py list_summaries --restart        # start an unfinished build over

Works off the pending marks, then walks every key a batch at a time: a
summary never built is built (resuming an interrupted build where it
stopped), a built one is reconciled - only the rows that differ from their
sources are written, and their number is the drift reported. Each batch
commits on its own, so the lists stay usable throughout; a tenant's list
says *building* until its first build finishes.

Runs at the end of every upgrade and nightly (the search-reindex unit), and
on a container's start. ``--check`` exits 1 when it finds drift.
"""
from __future__ import annotations

import time

from django.core.management.base import BaseCommand, CommandError

from api import list_summaries
from core.models import Tenant


class Command(BaseCommand):
    help = "Build or reconcile the stored list summaries (MAC list, port utilization)."

    def add_arguments(self, parser):
        parser.add_argument("--kind", action="append", default=None,
                            help="mac or port; repeat for several (default: all).")
        parser.add_argument("--tenant", default=None, help="A tenant's slug or id.")
        parser.add_argument("--missing", action="store_true",
                            help="Only build summaries that were never built.")
        parser.add_argument("--check", action="store_true",
                            help="Count the rows that differ from their sources; write nothing.")
        parser.add_argument("--restart", action="store_true",
                            help="Start an unfinished build over instead of resuming it.")
        parser.add_argument("--batch", type=int, default=list_summaries.BUILD_BATCH)

    def handle(self, *args, **opts):
        known = list_summaries.kinds()
        wanted = opts["kind"] or sorted(known)
        bad = [k for k in wanted if k not in known]
        if bad:
            raise CommandError(f"Unknown kind: {', '.join(bad)} (known: {', '.join(sorted(known))}).")
        tenants = Tenant.objects.order_by("name")
        if opts["tenant"]:
            t = opts["tenant"]
            tenants = tenants.filter(slug=t) if not _is_uuid(t) else tenants.filter(pk=t)
            if not tenants.exists():
                raise CommandError(f"No tenant {t!r}.")
        drift_total = 0
        for tenant in tenants:
            for kind in wanted:
                built = list_summaries.is_built(kind, tenant)
                if opts["missing"] and built:
                    continue
                started = time.monotonic()
                if opts["check"]:
                    drift = list_summaries.reconcile(kind, tenant, fix=False)
                    drift_total += drift
                    self.stdout.write(f"{tenant.name}: {kind} - {drift} rows differ")
                    continue
                list_summaries.flush(kind, tenant)
                walked, written = list_summaries.build(
                    kind, tenant, restart=opts["restart"], batch=opts["batch"])
                verb = "reconciled" if built else "built"
                self.stdout.write(
                    f"{tenant.name}: {kind} {verb} - {walked} rows walked, {written} written "
                    f"in {time.monotonic() - started:.1f} s"
                )
        if opts["check"] and drift_total:
            raise SystemExit(1)


def _is_uuid(v: str) -> bool:
    import uuid

    try:
        uuid.UUID(v)
    except ValueError:
        return False
    return True
