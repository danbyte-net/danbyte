"""assign_numids — backfill the per-tenant ``numid`` for existing rows.

Idempotent. Rows created through the ORM get a numid on save; this command
fills in rows that predate the field (or were inserted via ``bulk_create``,
which bypasses ``save()``). Numbers are assigned per (tenant, model) in
creation order, continuing after any numbers already assigned, and the
``NumIdSequence`` counter is advanced so future creates don't collide.
"""
from __future__ import annotations

from django.apps import apps
from django.core.management.base import BaseCommand
from django.db import transaction
from django.db.models import Max

from api.models import NumIdMixin, NumIdSequence


class Command(BaseCommand):
    help = "Backfill per-tenant numid for existing rows (idempotent)."

    def handle(self, *args, **opts):
        models = [
            m for m in apps.get_models()
            if issubclass(m, NumIdMixin) and not m._meta.abstract
            # numid is per-tenant; a NumIdMixin model without its own tenant
            # FK (scoped through a parent) can never be assigned one.
            and any(f.name == "tenant" for f in m._meta.fields)
        ]
        total = 0
        for model in models:
            total += self._backfill_model(model)
        self.stdout.write(self.style.SUCCESS(f"Assigned {total} numid(s)."))

    def _backfill_model(self, model) -> int:
        label = model._meta.label_lower
        assigned = 0
        tenant_ids = (
            model.objects.filter(numid__isnull=True)
            .values_list("tenant_id", flat=True)
            .distinct()
        )
        for tenant_id in list(tenant_ids):
            if tenant_id is None:
                continue
            with transaction.atomic():
                seq, _ = NumIdSequence.objects.select_for_update().get_or_create(
                    tenant_id=tenant_id, model_label=label
                )
                # Start after whatever's already used — the sequence counter or
                # the highest existing numid, whichever is greater.
                existing_max = (
                    model.objects.filter(tenant_id=tenant_id)
                    .aggregate(m=Max("numid"))["m"] or 0
                )
                nxt = max(seq.last_value or 0, existing_max)
                rows = list(
                    model.objects.filter(tenant_id=tenant_id, numid__isnull=True)
                    .order_by("created_at", "id")
                )
                for row in rows:
                    nxt += 1
                    row.numid = nxt
                if rows:
                    model.objects.bulk_update(rows, ["numid"])
                    seq.last_value = nxt
                    seq.save(update_fields=["last_value"])
                    assigned += len(rows)
        if assigned:
            self.stdout.write(f"  {label}: {assigned}")
        return assigned
