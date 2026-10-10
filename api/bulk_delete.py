"""Bulk delete that behaves like deleting one row at a time.

``POST <list>/bulk-delete/`` with ``{"ids": [...], "dry_run": bool}``:

* the rows come from the viewset's ``get_queryset()``, so they are the
  caller's tenant and rows, and ids from anywhere else fall out;
* a row still in use is skipped with the reason: the viewset's
  :meth:`bulk_blocker` (the same rule its single delete refuses with), or a
  database ``PROTECT`` reference;
* the rest go together through :meth:`bulk_destroy` - one delete, whose
  ``post_delete`` still reaches the change log, webhooks and search for each
  row, plus whatever a single delete does besides (a stack releasing its
  members, a wireless LAN clearing its key from the secret store);
* ``dry_run`` answers the same without deleting, plus what else would go with
  the rows (``impact``), what they let go of but keep (``released``, the
  viewset's :meth:`bulk_released`) and rows worth a second look before they
  go (``notes``, the viewset's :meth:`bulk_notes`), for the confirmation
  dialog.

The cost does not grow with the rows (#282): one collect answers for all of
them, and only a ``PROTECT`` refusal sends it row by row, to name the rows.

The answer is ``{deleted, deleted_ids, skipped: [{id, name, reason}], impact:
[{label, count}], released: [{label, count}], notes: [{id, name, label,
detail}]}``; ``deleted`` counts the rows
asked about, never what was removed along with them.
"""
from __future__ import annotations

import uuid
from collections import Counter

from django.db import DEFAULT_DB_ALIAS, transaction
from django.db.models.deletion import Collector, ProtectedError
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.mixins import DestroyModelMixin
from rest_framework.response import Response

MAX_IDS = 1000


def bulk_ids(request, limit: int | None = None) -> list[str]:
    """The ``ids`` of a bulk call's JSON object: a non-empty list of ids, at
    most ``limit``. Anything else is a 400 that says what is wrong - never a
    500 from the database filter (#280)."""
    if not isinstance(request.data, dict):
        raise ValidationError({"ids": 'Send a JSON object: {"ids": [...]}.'})
    ids = request.data.get("ids") or []
    if not isinstance(ids, list) or not ids:
        raise ValidationError({"ids": "Provide a non-empty list of ids."})
    if limit is not None and len(ids) > limit:
        raise ValidationError({"ids": f"At most {limit} ids per call."})
    out = []
    for v in ids:
        try:
            out.append(str(uuid.UUID(v)))
        except (TypeError, ValueError, AttributeError):
            raise ValidationError({"ids": f"«{v}» is not an id."}) from None
    return out


def plural_label(model) -> str:
    """How a preview names ``model``'s rows: the object-type registry's label
    ("BGP sessions", "prefix lists"), lower-cased unless it opens with an
    acronym; the model's plural name when it is not registered."""
    from auth_api.object_types import _registry

    entry = _registry().get(model._meta.model_name)
    label = entry["label"] if entry else str(model._meta.verbose_name_plural)
    return label if label[:2].isupper() else label[0].lower() + label[1:]


def _protected_reason(exc: ProtectedError) -> str:
    counts = Counter(plural_label(type(o)) for o in exc.protected_objects)
    parts = [f"{n} {label}" for label, n in sorted(counts.items())]
    return "In use: " + ", ".join(parts) + "."


class SafeBulkDeleteMixin:
    """Adds ``bulk-delete``; see the module docstring. Declare
    ``rbac_action_map = {"bulk_delete": "delete"}`` on the viewset."""

    def bulk_blocker(self, obj) -> str | None:
        """Why ``obj`` may not be deleted now, or None. Mirror the viewset's
        own ``destroy`` refusal here."""
        return None

    def bulk_blockers(self, rows) -> dict:
        """``{pk: why}`` for the rows that may not be deleted now. Default:
        :meth:`bulk_blocker` row by row; a viewset that can answer for all
        the rows in a few queries overrides this instead."""
        out = {}
        for obj in rows:
            reason = self.bulk_blocker(obj)
            if reason is not None:
                out[obj.pk] = reason
        return out

    def bulk_released(self, obj) -> dict[str, int]:
        """What deleting ``obj`` lets go of without deleting it, as
        ``{label: count}`` - a stack's member devices."""
        return {}

    def bulk_notes(self, rows) -> list[dict]:
        """Rows among ``rows`` (all of which will go) the operator should see
        named first, as ``[{id, name, label, detail}]`` - a power feed still
        cabled to a device. ``label`` groups them in the dialog."""
        return []

    def bulk_collector(self) -> Collector:
        """The collector that works out what a delete takes along."""
        return Collector(using=DEFAULT_DB_ALIAS)

    def bulk_collect_into(self, collector, rows) -> None:
        """Put ``rows``, and what deleting them removes, into ``collector``.
        A viewset whose delete also removes the rows that would otherwise
        hold it (a power panel's feeds) collects those first."""
        collector.collect(rows)

    def bulk_destroy(self, rows) -> None:
        """Delete ``rows`` - for many rows what ``perform_destroy`` is for
        one. A viewset whose single delete does more than delete overrides
        this; until it does, its rows go one at a time."""
        if type(self).perform_destroy is not DestroyModelMixin.perform_destroy:
            for obj in rows:
                self.perform_destroy(obj)
            return
        self.delete_together(rows)

    @staticmethod
    def delete_together(rows) -> None:
        """One queryset delete; every row's ``post_delete`` still fires."""
        type(rows[0])._default_manager.filter(pk__in=[r.pk for r in rows]).delete()

    def _bulk_collect(self, rows):
        """``(reasons, cascade)``: ``{pk: why}`` for the rows a ``PROTECT``
        reference holds, and what deleting the others would also remove, as
        ``{label: count}`` without the rows themselves."""
        reasons: dict = {}
        collector = self.bulk_collector()
        try:
            self.bulk_collect_into(collector, rows)
        except ProtectedError:
            for obj in rows:
                try:
                    self.bulk_collect_into(self.bulk_collector(), [obj])
                except ProtectedError as exc:
                    reasons[obj.pk] = _protected_reason(exc)
            rest = [o for o in rows if o.pk not in reasons]
            collector = self.bulk_collector()
            if rest:
                self.bulk_collect_into(collector, rest)
        cascade = Counter()
        model = type(rows[0]) if rows else None
        n_rows = len(rows) - len(reasons)
        for m, instances in collector.data.items():
            n = len(instances) - (n_rows if m is model else 0)
            if n > 0:
                cascade[plural_label(m)] += n
        for qs in collector.fast_deletes:
            n = qs.count()
            if n:
                cascade[plural_label(qs.model)] += n
        return reasons, cascade

    def _destroy_one_by_one(self, rows, skipped) -> list[str]:
        """The slow way, for when something came to depend on a row after
        the check: each row alone, so only the held ones stay. Returns the
        ids it deleted."""
        done = []
        for obj in rows:
            # Read before deleting: delete() leaves the instance's pk None.
            pk, name = str(obj.pk), str(obj)
            try:
                with transaction.atomic():
                    self.perform_destroy(obj)
            except ProtectedError as exc:
                skipped.append({"id": pk, "name": name, "reason": _protected_reason(exc)})
                continue
            done.append(pk)
        return done

    @action(detail=False, methods=["post"], url_path="bulk-delete")
    def bulk_delete(self, request):
        ids = bulk_ids(request, MAX_IDS)
        dry_run = bool(request.data.get("dry_run"))
        rows = list(self.get_queryset().filter(pk__in=ids))
        skipped, ok = [], []
        blocked = self.bulk_blockers(rows) if rows else {}
        for obj in rows:
            reason = blocked.get(obj.pk)
            if reason is not None:
                skipped.append({"id": str(obj.pk), "name": str(obj), "reason": reason})
            else:
                ok.append(obj)
        impact, released = Counter(), Counter()
        with transaction.atomic():
            reasons, cascade = self._bulk_collect(ok) if ok else ({}, Counter())
            for obj in ok:
                if obj.pk in reasons:
                    skipped.append({"id": str(obj.pk), "name": str(obj),
                                    "reason": reasons[obj.pk]})
            ok = [o for o in ok if o.pk not in reasons]
            for obj in ok:
                released.update(self.bulk_released(obj))
            impact.update(cascade)
            deleted = [str(o.pk) for o in ok]
            # Named before the delete, while the rows are still there.
            notes = self.bulk_notes(ok) if ok else []
            if ok and not dry_run:
                try:
                    with transaction.atomic():
                        self.bulk_destroy(ok)
                except ProtectedError:
                    deleted = self._destroy_one_by_one(ok, skipped)
        return Response(
            {
                "deleted": len(deleted),
                "deleted_ids": deleted,
                "skipped": skipped,
                "impact": [{"label": k, "count": v} for k, v in sorted(impact.items())],
                "released": [
                    {"label": k, "count": v} for k, v in sorted(released.items()) if v
                ],
                "notes": notes,
                "dry_run": dry_run,
            },
            status=drf_status.HTTP_200_OK,
        )
