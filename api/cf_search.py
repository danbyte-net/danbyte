"""Search inside custom-field values.

An imported NetBox id, an asset number typed into a custom field - people
search for those the same way they search for a name, so every search bar
matches the object's ``custom_fields`` JSON as text too.
"""
from __future__ import annotations

from django.db.models import Q, TextField
from django.db.models.functions import Cast


def cf_text_q(model, q: str, base=None) -> Q:
    """``Q`` selecting rows of ``model`` whose custom-field values contain
    ``q`` (case-insensitive, any key). Empty for models without custom
    fields, so it can be OR-ed in anywhere."""
    if not q or not any(f.name == "custom_fields" for f in model._meta.fields):
        return Q(pk__in=[])
    qs = base if base is not None else model._default_manager.all()
    hits = (
        qs.annotate(_cf_text=Cast("custom_fields", TextField()))
        .filter(_cf_text__icontains=q)
        .values("pk")
    )
    return Q(pk__in=hits)
