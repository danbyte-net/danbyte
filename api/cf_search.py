"""Search inside custom-field values.

An imported NetBox id, an asset number typed into a custom field - people
search for those the same way they search for a name, so every search bar
matches the object's ``custom_fields`` JSON as text too.
"""
from __future__ import annotations

import re

from django.db.models import Q, TextField, UUIDField
from django.db.models.functions import Cast

_HEX_PREFIX = re.compile(r"[0-9a-fA-F]{6,}(?:-[0-9a-fA-F-]*)?")


def id_search_q(model, q: str) -> Q:
    """``Q`` matching a row of ``model`` by the identifier printed on its
    label: the per-tenant number (``numid``) when ``q`` is a number, or the
    start of its UUID when ``q`` is six or more hex characters - what fits on
    a cable flag and gets read out loud. Empty when ``q`` is neither."""
    q = (q or "").strip()
    if not q:
        return Q(pk__in=[])
    out = Q(pk__in=[])
    if q.isdigit() and any(f.name == "numid" for f in model._meta.fields):
        out |= Q(numid=int(q))
    if _HEX_PREFIX.fullmatch(q) and isinstance(model._meta.pk, UUIDField):
        out |= Q(pk__istartswith=q)
    return out


def cf_text_q(model, q: str, base=None) -> Q:
    """``Q`` selecting rows of ``model`` whose custom-field values contain
    ``q`` (case-insensitive, any key), or whose printed identifier (number or
    UUID prefix, :func:`id_search_q`) is ``q``. Every list's search chain ends
    with this, so typing the id off a label finds the object anywhere. Empty
    for models with neither, so it can be OR-ed in anywhere."""
    out = id_search_q(model, q)
    if not q or not any(f.name == "custom_fields" for f in model._meta.fields):
        return out
    qs = base if base is not None else model._default_manager.all()
    hits = (
        qs.annotate(_cf_text=Cast("custom_fields", TextField()))
        .filter(_cf_text__icontains=q)
        .values("pk")
    )
    return out | Q(pk__in=hits)
