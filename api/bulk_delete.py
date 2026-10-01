"""Bulk delete that behaves like deleting one row at a time.

``POST <list>/bulk-delete/`` with ``{"ids": [...], "dry_run": bool}``:

* the rows come from the viewset's ``get_queryset()``, so they are the
  caller's tenant and rows, and ids from anywhere else fall out;
* each row goes through ``perform_destroy`` - the hooks a single delete runs
  (a stack releasing its members, a wireless LAN clearing its key from the
  secret store) run for every row, and the audit signals log each delete once;
* a row still in use is skipped with the reason: the viewset's
  :meth:`bulk_blocker` (the same rule its single delete refuses with), or a
  database ``PROTECT`` reference;
* ``dry_run`` answers the same without deleting, plus what else would go with
  the rows (``impact``), for the confirmation dialog.

The answer is ``{deleted, deleted_ids, skipped: [{id, name, reason}], impact:
[{label, count}]}``; ``deleted`` counts the rows asked about, never what was
removed along with them.
"""
from __future__ import annotations

from collections import Counter

from django.db import DEFAULT_DB_ALIAS, transaction
from django.db.models.deletion import Collector, ProtectedError
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

MAX_IDS = 1000


def _protected_reason(exc: ProtectedError) -> str:
    counts = Counter(o._meta.verbose_name_plural for o in exc.protected_objects)
    parts = [f"{n} {label}" for label, n in sorted(counts.items())]
    return "In use: " + ", ".join(parts) + "."


class SafeBulkDeleteMixin:
    """Adds ``bulk-delete``; see the module docstring. Declare
    ``rbac_action_map = {"bulk_delete": "delete"}`` on the viewset."""

    def bulk_blocker(self, obj) -> str | None:
        """Why ``obj`` may not be deleted now, or None. Mirror the viewset's
        own ``destroy`` refusal here."""
        return None

    def _bulk_collect(self, obj):
        """``(reason, cascade)``: the PROTECT refusal, else what a delete
        would also remove, as ``{model: count}`` without ``obj`` itself."""
        collector = Collector(using=DEFAULT_DB_ALIAS)
        try:
            collector.collect([obj])
        except ProtectedError as exc:
            return _protected_reason(exc), {}
        cascade = Counter()
        for model, instances in collector.data.items():
            n = len(instances) - (1 if model is type(obj) else 0)
            if n > 0:
                cascade[model._meta.verbose_name_plural] += n
        for qs in collector.fast_deletes:
            n = qs.count()
            if n:
                cascade[qs.model._meta.verbose_name_plural] += n
        return None, cascade

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = request.data.get("ids") or []
        if not isinstance(ids, list) or not ids:
            raise ValidationError({"ids": "Provide a non-empty list of ids."})
        if len(ids) > MAX_IDS:
            raise ValidationError({"ids": f"At most {MAX_IDS} ids per call."})
        dry_run = bool(request.data.get("dry_run"))
        rows = list(self.get_queryset().filter(pk__in=ids))
        deleted, skipped = [], []
        impact = Counter()
        with transaction.atomic():
            for obj in rows:
                # Read before deleting: delete() leaves the instance's pk None.
                pk, name = str(obj.pk), str(obj)
                reason = self.bulk_blocker(obj)
                cascade = {}
                if reason is None:
                    reason, cascade = self._bulk_collect(obj)
                if reason is not None:
                    skipped.append({"id": pk, "name": name, "reason": reason})
                    continue
                if dry_run:
                    impact.update(cascade)
                    deleted.append(pk)
                    continue
                try:
                    with transaction.atomic():
                        self.perform_destroy(obj)
                except ProtectedError as exc:
                    skipped.append({"id": pk, "name": name, "reason": _protected_reason(exc)})
                    continue
                impact.update(cascade)
                deleted.append(pk)
        return Response(
            {
                "deleted": len(deleted),
                "deleted_ids": deleted,
                "skipped": skipped,
                "impact": [{"label": k, "count": v} for k, v in sorted(impact.items())],
                "dry_run": dry_run,
            },
            status=drf_status.HTTP_200_OK,
        )
