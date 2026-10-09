"""The edit form's field rules, for a bulk update (#350).

A bulk update writes with one queryset ``UPDATE``, so neither the serializer
nor the model ever sees the values: an invalid choice was stored, and a value
too long for its column or out of its integer range reached the database and
came back as a 500. The values go through the endpoint's own serializer the
way a PATCH does:

* :func:`clean_bulk_updates` once, field by field (choices, lengths, integer
  ranges, tenant-scoped and site-fenced relations, ``validate_<field>``
  hooks), and
* :meth:`BulkValues.check_rows` per selected row, the serializer's
  object-level ``validate()`` with that row as the instance, so a rule that
  ties a changed field to the rest of the row (an interface's bundle
  settings, a splitter's positions) holds too.

The model's own field validators run as a backstop, for serializers that
declare a field more leniently than its column.
"""
from __future__ import annotations

from django.core.exceptions import FieldDoesNotExist
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework.exceptions import ValidationError
from rest_framework.relations import ManyRelatedField, RelatedField


def _row_errors(detail, row) -> dict:
    """A per-row error, keyed as the serializer keyed it and naming the row,
    so the operator can see which of the selection to leave out."""
    label = str(row)
    if isinstance(detail, dict):
        return {
            key: [f"{label}: {msg}" for msg in (msgs if isinstance(msgs, list) else [msgs])]
            for key, msgs in detail.items()
        }
    msgs = detail if isinstance(detail, list) else [detail]
    return {"fields": [f"{label}: {msg}" for msg in msgs]}


class BulkValues:
    """The cleaned values of one bulk update, ready for the per-row rules."""

    def __init__(self, view, updates: dict, attrs: dict):
        self.view = view
        self.updates = updates
        self.attrs = attrs

    def check_rows(self, rows, written: dict | None = None) -> None:
        """The serializer's object-level ``validate()`` for each row, with the
        row as the instance - what a PATCH of the same values to that row
        would run. The first row that fails raises, named in the message.

        ``written`` is what the endpoint will actually write, when it adds to
        the request (an interface's Always uplink also clears Never): its
        plain values join the checked ones, as a PATCH sending both would.
        """
        serializer_class = self.view.get_serializer_class()
        if serializer_class.validate is serializers.Serializer.validate:
            return
        context = self.view.get_serializer_context()
        attrs = dict(self.attrs)
        if written:
            fields = serializer_class(context=context, partial=True).fields
            for key, value in written.items():
                field = fields.get(key)
                if (
                    field is not None and not field.read_only and field.source == key
                    and not isinstance(field, (RelatedField, ManyRelatedField))
                ):
                    attrs[key] = value
        for row in rows:
            serializer = serializer_class(instance=row, context=context, partial=True)
            try:
                serializer.validate(dict(attrs))
            except ValidationError as exc:
                raise ValidationError(_row_errors(exc.detail, row)) from None
            except DjangoValidationError as exc:
                raise ValidationError(
                    _row_errors(getattr(exc, "message_dict", None) or exc.messages, row)
                ) from None


def clean_bulk_updates(view, updates: dict) -> BulkValues:
    """Check ``updates`` field by field as the endpoint's serializer checks a
    PATCH.

    ``updates`` maps the serializer's write keys (``description``,
    ``vlan_id`` …) to values. Raises a DRF ``ValidationError`` with field
    errors. ``.updates`` of the result holds each plain value in its cleaned
    form (trimmed text, parsed booleans and integers); relation keys keep the
    id they were sent with.
    """
    if not updates:
        return BulkValues(view, updates, {})
    serializer_class = view.get_serializer_class()
    context = view.get_serializer_context()
    probe = serializer_class(context=context, partial=True)
    fields = probe.fields

    data = {k: v for k, v in updates.items() if k in fields and not fields[k].read_only}
    try:
        attrs = probe.to_internal_value(data)
    except ValidationError as exc:
        raise ValidationError(exc.detail) from None

    out = dict(updates)
    for key in data:
        field = fields[key]
        if isinstance(field, (RelatedField, ManyRelatedField)):
            if out[key] == "":
                out[key] = None  # an empty id clears, as the serializer reads it
            continue
        if field.source != key:
            continue
        if key in attrs:
            out[key] = attrs[key]

    # The column's own limits, for a field the serializer declares loosely.
    model = serializer_class.Meta.model
    errors = {}
    for key, value in out.items():
        try:
            model_field = model._meta.get_field(key)
        except FieldDoesNotExist:
            continue
        if model_field.is_relation or not model_field.concrete or isinstance(value, bool):
            continue
        try:
            model_field.run_validators(value)
        except DjangoValidationError as exc:
            errors[key] = exc.messages
    if errors:
        raise ValidationError(errors)
    return BulkValues(view, out, attrs)
