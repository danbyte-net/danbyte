"""Bulk edit and safe bulk delete from one declaration per list (#314).

A list viewset mixes in :class:`BulkEditMixin` and names the fields its
bulk edit offers::

    bulk_edit = BulkEditSpec(fields=("status_id", "description", "vrf_id"))

That one tuple is the whole per-type spec. Everything else is derived from
the model, the way ``api.editable_fields`` derives editor metadata:

* ``POST <list>/bulk-update/`` accepts exactly those keys - a relation key
  (``*_id``) is checked against its related model in the active tenant,
  booleans and integers by their column type - and runs the values through
  the list's own serializer as a ``PATCH`` would (``api.bulk_validation``);
* ``GET <list>/bulk-edit-fields/`` describes the same keys for the shared
  bulk-edit dialog (kind, label, option source), so the dialog has no field
  list of its own to drift;
* ``POST <list>/bulk-delete/`` is :class:`~api.bulk_delete.SafeBulkDeleteMixin`
  - preview, kept rows, each row removed as its single delete removes it.

``bulk_keep_referenced`` keeps a row other records still point at by a
nullable reference or a many-to-many, which a delete would silently cut (a
routing policy that sessions import, a keychain a peer group uses). A
``PROTECT`` reference keeps the row anyway.
"""
from __future__ import annotations

import dataclasses
from collections import Counter, defaultdict
from dataclasses import dataclass

from django.core.exceptions import FieldDoesNotExist
from django.db import IntegrityError, models
from django.db.models import Count
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.response import Response

from .bulk_delete import SafeBulkDeleteMixin, plural_label
from .viewsets import BulkUpdateMixin


@dataclass(frozen=True)
class BulkEditSpec:
    """What a list's bulk edit offers.

    ``fields`` are the serializer's write keys in dialog order
    (``status_id``, ``description``, ``peer_group_id``). ``tags`` adds the
    add/remove tag pickers. ``status_model`` is the ``Status.available_to``
    scope when it is not the model's own slug (the routing instances share
    ``routinginstance``)."""

    fields: tuple[str, ...] = ()
    tags: bool = True
    status_model: str | None = None


def _model_field(model, key: str):
    """The model field behind a write key: ``vrf_id`` → ``vrf``. A key
    that names no field raises ``FieldDoesNotExist`` - a spec typo fails
    loudly rather than offering nothing."""
    name = key[:-3] if key.endswith("_id") else key
    try:
        f = model._meta.get_field(name)
    except FieldDoesNotExist:
        return model._meta.get_field(key)
    return f if (f.is_relation or name == key) else model._meta.get_field(key)


def _in_use_reason(counts: Counter) -> str:
    parts = [f"{n} {label}" for label, n in sorted(counts.items())]
    return "In use: " + ", ".join(parts) + "."


class BulkEditMixin(SafeBulkDeleteMixin, BulkUpdateMixin):
    """``bulk-update``, ``bulk-edit-fields`` and ``bulk-delete`` from one
    :class:`BulkEditSpec`; see the module docstring."""

    bulk_edit = BulkEditSpec()
    #: Keep a row that other records reference by a nullable FK or an M2M.
    bulk_keep_referenced = False
    rbac_action_map = {
        "bulk_delete": "delete",
        "bulk_update": "change",
        "bulk_edit_fields": "change",
    }

    @property
    def bulk_tags(self) -> bool:  # read by BulkUpdateMixin.bulk_update
        return self.bulk_edit.tags

    def bulk_update_allow_list(self) -> dict:
        model = self.queryset.model
        out = {"str": [], "bool": [], "int": [], "fk": {}}
        for key in self.bulk_edit.fields:
            f = _model_field(model, key)
            if f.is_relation:
                out["fk"][key] = f.related_model
            elif isinstance(f, models.BooleanField):
                out["bool"].append(key)
            elif isinstance(f, models.IntegerField):
                out["int"].append(key)
            else:
                out["str"].append(key)
        return {k: (tuple(v) if isinstance(v, list) else v) for k, v in out.items()}

    @action(detail=False, methods=["post"], url_path="bulk-update")
    def bulk_update(self, request):
        # A unique path (a static route's device, VRF, prefix and next hop)
        # can only collide once the values land; answer it as a single
        # PATCH does, with nothing written.
        try:
            return super().bulk_update(request)
        except IntegrityError:
            return Response(
                {"detail": "Two rows would end up the same - change fewer at a time "
                           "or pick other values."},
                status=drf_status.HTTP_409_CONFLICT,
            )

    @action(detail=False, methods=["get"], url_path="bulk-edit-fields")
    def bulk_edit_fields(self, request):
        """The bulk-edit dialog's fields, described as
        ``/api/editable-fields/`` describes a field."""
        from .editable_fields import _describe

        model = self.queryset.model
        spec = self.bulk_update_allow_list()
        out = []
        for key in self.bulk_edit.fields:
            target = spec["fk"].get(key)
            d = _describe(model, key, target_model=target, is_fk=target is not None)
            if d is None:
                continue
            if d.kind == "status" and self.bulk_edit.status_model:
                d = dataclasses.replace(d, status_model=self.bulk_edit.status_model)
            out.append(d.payload())
        return Response({"fields": out, "tags": self.bulk_edit.tags})

    def bulk_blockers(self, rows) -> dict:
        out = super().bulk_blockers(rows)
        if not self.bulk_keep_referenced or not rows:
            return out
        ids = [r.pk for r in rows]
        uses: dict = defaultdict(Counter)
        for rel in type(rows[0])._meta.related_objects:
            if not (rel.many_to_many or getattr(rel, "on_delete", None) is models.SET_NULL):
                continue
            name = rel.field.name
            label = plural_label(rel.related_model)
            found = (
                rel.related_model._base_manager.filter(**{f"{name}__in": ids})
                .values(name).annotate(n=Count("pk", distinct=True))
            )
            for row in found:
                uses[row[name]][label] += row["n"]
        for pk, counts in uses.items():
            if pk not in out:
                out[pk] = _in_use_reason(counts)
        return out
