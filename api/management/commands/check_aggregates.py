"""List aggregates stored more than once under different spellings (#381).

Migration ``api 0203`` stores every aggregate prefix in canonical form unless
that would duplicate another aggregate of the same tenant. Those pairs are
left untouched and listed here, so an operator can merge them (move the
description, tags and custom fields to one, delete the other). Read-only.
"""
from django.core.management.base import BaseCommand

from api.aggregate_normalise import plan
from api.models import Aggregate
from core.models import Tenant


class Command(BaseCommand):
    help = "List aggregates that are the same block stored under different spellings."

    def handle(self, *args, **options):
        rows = list(Aggregate.objects.values_list("pk", "tenant_id", "prefix"))
        updates, collisions = plan(rows)
        if updates:
            self.stdout.write(
                f"{len(updates)} aggregate(s) not yet in canonical form; "
                "run migrate to normalise them."
            )
        if not collisions:
            self.stdout.write("No duplicate aggregates.")
            return
        names = dict(Tenant.objects.values_list("pk", "name"))
        for tenant_id, block, members in collisions:
            spelled = ", ".join(f"{prefix} ({pk})" for pk, prefix in members)
            self.stdout.write(f"{names.get(tenant_id, tenant_id)}: {block} is stored as {spelled}")
        self.stdout.write(
            f"{len(collisions)} duplicate block(s). Merge each into one aggregate."
        )
