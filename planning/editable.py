"""Thin bridge from planning to :mod:`api.editable_fields`.

Exists so the error message a user sees when they name an unplannable field is
written once, and names the fields that *are* available.
"""
from __future__ import annotations

from rest_framework.exceptions import ValidationError

from api.editable_fields import field_for, fields_for


def descriptor_or_400(model, key: str):
    """The field descriptor for ``key``, or a 400 listing what is plannable."""
    spec = field_for(model, key) if key else None
    if spec is not None:
        return spec
    available = ", ".join(sorted(d.key for d in fields_for(model))) or "nothing"
    raise ValidationError({
        "field": (
            f"Not plannable on "
            f"{model._meta.verbose_name_plural}. Plannable: {available}."
        )
    })
