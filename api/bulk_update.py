"""The field-level ``bulk-update`` write every bulk-editable list shares.

:class:`BulkUpdateMixin` is the endpoint, :class:`FieldWriteAllowList` the
declaration of which fields a field-level write may set. They live apart from
``api.viewsets`` so :mod:`api.bulk_edit` can build on them while the viewsets
build on it in turn; ``api.viewsets`` re-exports both.
"""
from __future__ import annotations

from django.db import transaction
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from audit.bulk import apply_and_log_bulk_tags, log_bulk_update

from .bulk_delete import MAX_IDS, bulk_ids
from .bulk_validation import clean_bulk_updates
from .models import Status
from .views import _get_active_tenant


class FieldWriteAllowList:
    """Which model fields a *field-level* write path may set on this model.

    Two consumers read this declaration:

    * :meth:`ComponentBulkMixin.bulk_update`, which **enforces** it, and
    * :mod:`api.editable_fields`, which turns it into editor metadata for bulk
      edit and for planning's planned changes.

    Declaring it in one place rather than inside either consumer is what stops
    the metadata endpoint becoming a third list that can silently disagree with
    the two that already exist.

    A viewset built on :class:`api.bulk_edit.BulkEditMixin` is the exception:
    its ``bulk-update`` takes its ``BulkEditSpec`` instead, so the fields a
    plan may change and the fields a bulk edit offers can differ.

    ``editable_*`` is the current spelling. The ``bulk_*`` names predate it and
    stay authoritative, so the existing component viewsets need no edit. Note
    the consequence: adding ``editable_*`` to a viewset that *does* have a
    ``bulk-update`` endpoint also makes those fields bulk-editable.
    """

    editable_str_fields: tuple = ()
    editable_bool_fields: tuple = ()
    editable_int_fields: tuple = ()
    editable_fk_fields: dict = {}

    bulk_str_fields: tuple = ()
    bulk_bool_fields: tuple = ()
    bulk_int_fields: tuple = ()          # nullable ints
    bulk_fk_fields: dict = {}            # "vlan_id" → tenant-scoped model

    @classmethod
    def field_write_allow_list(cls) -> dict:
        """``{"str": (...), "bool": (...), "int": (...), "fk": {...}}``."""
        return {
            "str": (*cls.editable_str_fields, *cls.bulk_str_fields),
            "bool": (*cls.editable_bool_fields, *cls.bulk_bool_fields),
            "int": (*cls.editable_int_fields, *cls.bulk_int_fields),
            "fk": {**cls.editable_fk_fields, **cls.bulk_fk_fields},
        }


def _bulk_status_offered(status_id, model, key="status_id") -> None:
    """A bulk edit may only set a status the catalog offers ``model`` - as the
    form and the API's single edit (``serializers.offered_status``). Run it
    after the tenant check: the status is then known to be the tenant's."""
    from .status_registry import status_label, status_offered

    if not status_id:
        return
    status = Status.objects.filter(pk=status_id).first()
    if status is not None and not status_offered(status, model):
        raise ValidationError(
            {key: f"“{status.name}” isn't a status for {status_label(model)}."}
        )


class BulkUpdateMixin(FieldWriteAllowList):
    """``bulk-update`` on its own: the field-level bulk write that
    :class:`ComponentBulkMixin` and the routing lists (#314) share.

    POST ``bulk-update`` {ids: [...], fields: {...}} - only keys present in
    ``fields`` are touched, and only keys :meth:`bulk_update_allow_list`
    names are accepted (an unknown key is a 400, never silently dropped).
    Tenant-scoped FKs re-validate against the active tenant since
    ``qs.update`` bypasses the serializer's scoped fields. Selection is scoped
    by ``get_queryset`` (tenant + RBAC rows), so foreign ids silently fall out.
    """

    bulk_tags = False                    # add_tag_ids / remove_tag_ids
    #: The custom-field model slug when ``fields.custom_fields`` is accepted:
    #: ``{key: value}``, only the keys sent change, a null clears.
    bulk_cf_model: str | None = None
    rbac_action_map = {"bulk_update": "change"}

    def _bulk_ids(self, request):
        return bulk_ids(request, MAX_IDS)

    def bulk_row_updates(self, rows: list, updates: dict) -> dict:
        """Hook for what a ``Model.save()`` would derive per row and a
        queryset ``update()`` skips (a VM's group, dropped when it moves
        cluster): ``{pk: {attname: value}}``, written and logged with the
        row. ``rows`` hold the values from before the write. Default: none."""
        return {}

    def after_bulk_update(self, pks: list, updates: dict) -> None:
        """Hook run after the bulk write's transaction, for follow-up work on
        the written rows (planning a PRTG change). Default: none."""

    def bulk_update_allow_list(self) -> dict:
        """What ``bulk-update`` accepts, as ``field_write_allow_list()``
        shapes it. Default: the viewset's whole field-write allow-list."""
        return self.field_write_allow_list()

    def normalize_bulk_updates(self, updates: dict) -> dict:
        """Hook for model-level invariants that ``Model.save()`` would enforce
        but a queryset ``update()`` skips. Default: unchanged."""
        return updates

    def check_bulk_rows(self, rows: list, updates: dict) -> None:
        """Hook for invariants that span other rows (a serializer's
        ``validate``), checked against the selected rows before the queryset
        ``update()``. Raise ``ValidationError`` to refuse. Default: none."""

    @action(detail=False, methods=["post"], url_path="bulk-update")
    def bulk_update(self, request):
        ids = self._bulk_ids(request)
        fields = request.data.get("fields") or {}
        if not isinstance(fields, dict) or not fields:
            raise ValidationError({"fields": "Provide at least one field to update."})

        spec = self.bulk_update_allow_list()
        allowed = {*spec["str"], *spec["bool"], *spec["int"], *spec["fk"]}
        tag_keys = {"add_tag_ids", "remove_tag_ids"} if self.bulk_tags else set()
        if self.bulk_cf_model:
            tag_keys.add("custom_fields")
        unknown = set(fields) - allowed - tag_keys
        if unknown:
            raise ValidationError({
                k: f"Not bulk-editable here. Allowed: {sorted(allowed | tag_keys)}"
                for k in sorted(unknown)
            })

        tenant = _get_active_tenant(request)
        cf_sets, cf_clears = {}, set()
        if "custom_fields" in fields:
            from customization.cf_validation import clean_custom_field_patch

            cf_sets, cf_clears, cf_errors = clean_custom_field_patch(
                tenant, self.bulk_cf_model, fields["custom_fields"]
            )
            if cf_errors:
                raise ValidationError({"custom_fields": cf_errors})
        model = self.get_queryset().model
        updates = {}
        for k in spec["str"]:
            if k in fields:
                v = "" if fields[k] is None else str(fields[k])
                # Choice-backed CharFields validate against the model's own
                # choice list (flatchoices flattens the grouped ones), so a
                # typo'd slug is a 400 rather than a silently written value.
                # "" always passes - it's how bulk edit clears the field.
                valid = dict(model._meta.get_field(k).flatchoices)
                if valid and v and v not in valid:
                    # Short lists name their options; the long ones (216 interface
                    # types) would bury the message, so point at the endpoint.
                    opts = sorted(valid)
                    hint = (
                        ", ".join(opts) if len(opts) <= 12
                        else "see /api/dcim/choices/"
                    )
                    raise ValidationError(
                        {k: f"'{v}' is not a valid choice. Options: {hint}"}
                    )
                updates[k] = v
        for k in spec["bool"]:
            if k in fields:
                if not isinstance(fields[k], bool):
                    raise ValidationError({k: "Must be true or false."})
                updates[k] = fields[k]
        for k in spec["int"]:
            if k in fields:
                v = fields[k]
                if v is not None and (isinstance(v, bool) or not isinstance(v, int)):
                    raise ValidationError({k: "Must be an integer or null."})
                updates[k] = v
        for k in spec["fk"]:
            if k in fields:
                updates[k] = fields[k] or None
        # Lengths, ranges, choices and tenant-scoped relations as the edit
        # form's PATCH checks them (#350); the row rules run below.
        checked = clean_bulk_updates(self, updates)
        updates = checked.updates
        for k, model in spec["fk"].items():
            if k in fields:
                v = fields[k]
                if v and not model.objects.filter(pk=v, tenant=tenant).exists():
                    raise ValidationError({k: "Not found in this tenant."})
                if model is Status:
                    _bulk_status_offered(v, self.get_queryset().model, k)
                updates[k] = v or None

        qs = self.get_queryset().filter(pk__in=ids)
        with transaction.atomic():
            _rows = list(qs)
            updates = self.normalize_bulk_updates(updates)
            checked.check_rows(_rows, updates)
            self.check_bulk_rows(_rows, updates)
            updated = qs.update(**updates) if updates else qs.count()
            per_row = self.bulk_row_updates(_rows, updates)
            if cf_sets or cf_clears:
                per_row = _merge_bulk_custom_fields(_rows, cf_sets, cf_clears, per_row)
            for pk, extra in per_row.items():
                if extra:
                    qs.model._default_manager.filter(pk=pk).update(**extra)
            if updates or per_row:
                log_bulk_update(_rows, updates, per_row=per_row)
            # Marking ports connected fulfils any hold on them.
            if updates.get("mark_connected"):
                from .models import release_reservations_for

                release_reservations_for(qs.model, [r.pk for r in _rows])
            if self.bulk_tags:
                apply_and_log_bulk_tags(
                    qs,
                    fields.get("add_tag_ids") or [],
                    fields.get("remove_tag_ids") or [],
                    tenant=tenant,
                )
            self._assert_bulk_write_in_site_scope(
                [row.pk for row in _rows], action="change"
            )
        self.after_bulk_update([row.pk for row in _rows], updates)
        return Response({"updated": updated}, status=drf_status.HTTP_200_OK)


def _merge_bulk_custom_fields(rows, sets: dict, clears: set, per_row: dict) -> dict:
    """Each row's ``custom_fields`` with ``sets`` laid over it and ``clears``
    dropped, added to ``per_row`` where it changes - the keys a bulk edit
    did not name keep each row's own value."""
    out = {pk: dict(extra) for pk, extra in per_row.items()}
    for r in rows:
        old = r.custom_fields or {}
        new = {k: v for k, v in old.items() if k not in clears}
        new.update(sets)
        if new != old:
            out.setdefault(r.pk, {})["custom_fields"] = new
    return out
