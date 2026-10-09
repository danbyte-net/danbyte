"""assign_numids - backfill the per-tenant ``numid`` for existing rows.

Idempotent. Rows created through the ORM get a numid on save; this command
fills in rows that predate the field (or were inserted via ``bulk_create``,
which bypasses ``save()``). Numbers are assigned per (tenant, model) in
creation order, continuing after any numbers already assigned, and the
``NumIdSequence`` counter is advanced so future creates don't collide.

Work is done in bounded batches, each in its own short transaction (#362):
the allocator row is locked only while one batch is numbered, so creates in
the same tenant wait milliseconds rather than for the whole backfill, and an
interrupted run leaves every finished batch committed, gap-free, with the
counter matching. Running it again picks up where it stopped.
"""
from __future__ import annotations

from django.apps import apps
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Max

from api.models import NumIdMixin, NumIdSequence

DEFAULT_BATCH_SIZE = 500


class Command(BaseCommand):
    help = "Backfill per-tenant numid for existing rows (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
            help=f"Rows numbered per transaction (default {DEFAULT_BATCH_SIZE}).",
        )

    def handle(self, *args, **opts):
        batch_size = opts["batch_size"]
        if batch_size < 1:
            raise CommandError("--batch-size must be at least 1.")
        models = [
            m for m in apps.get_models()
            if issubclass(m, NumIdMixin) and not m._meta.abstract
            # numid is per-tenant; a NumIdMixin model without its own tenant
            # FK (scoped through a parent) can never be assigned one.
            and any(f.name == "tenant" for f in m._meta.fields)
        ]
        total = 0
        for model in models:
            total += self._backfill_model(model, batch_size)
        self.stdout.write(self.style.SUCCESS(f"Assigned {total} numid(s)."))

    def _backfill_model(self, model, batch_size: int) -> int:
        label = model._meta.label_lower
        assigned = 0
        # order_by() clears the model's default ordering: left in, DISTINCT
        # runs over the ordering columns too and yields one tenant per row.
        tenant_ids = (
            model.objects.filter(numid__isnull=True)
            .order_by()
            .values_list("tenant_id", flat=True)
            .distinct()
        )
        for tenant_id in list(tenant_ids):
            if tenant_id is None:
                continue
            # Numbers already on rows that never went through the counter
            # (older imports): the backfill starts above them. Read once - the
            # counter itself tracks everything handed out after this.
            existing_max = (
                model.objects.filter(tenant_id=tenant_id)
                .aggregate(m=Max("numid"))["m"] or 0
            )
            while True:
                n = self._assign_batch(model, label, tenant_id, existing_max, batch_size)
                assigned += n
                if n < batch_size:
                    break
        if assigned:
            self.stdout.write(f"  {label}: {assigned}")
        return assigned

    def _assign_batch(self, model, label, tenant_id, floor: int, batch_size: int) -> int:
        """Number the next ``batch_size`` unnumbered rows of one tenant in a
        single short transaction; returns how many were numbered."""
        with transaction.atomic():
            NumIdSequence.objects.get_or_create(tenant_id=tenant_id, model_label=label)
            seq = NumIdSequence.objects.select_for_update().get(
                tenant_id=tenant_id, model_label=label
            )
            # Lock the rows too, so one deleted mid-batch can't burn a number
            # and leave a gap.
            rows = list(
                model.objects.select_for_update()
                .filter(tenant_id=tenant_id, numid__isnull=True)
                .order_by("created_at", "id")
                .only("pk", "numid")[:batch_size]
            )
            if not rows:
                return 0
            nxt = max(seq.last_value or 0, floor)
            for row in rows:
                nxt += 1
                row.numid = nxt
            model.objects.bulk_update(rows, ["numid"])
            seq.last_value = nxt
            seq.save(update_fields=["last_value"])
            return len(rows)
