"""Tiny cross-cutting helpers for CRUD forms.

These helpers let any create view opt into:

  - "Save and add more" — submit button that, on a successful save, redirects
    back to the same create form with the *non-unique* fields the user just
    entered carried over via GET so they can keep typing the next row.
  - Initial seeding from GET — the redirect target reads its initial values
    out of ``request.GET`` so the round-trip works without view-specific glue.

Designed to compose with both bound Django ``Form``/``ModelForm`` and with
the ``forms.PrefixForm``-style helpers that wrap a model save with a side
effect (tag string, gateway autospawn).

Usage in a create view::

    if form.is_valid():
        form.save()
        ...
        resp = save_and_add_more_redirect(
            request,
            view_name="api:prefix-create",
            form=form,
            sticky_fields=["status", "site", "vrf", "description"],
        )
        if resp is not None:
            return resp
        return redirect("api:prefix-detail", pk=...)

And on the GET path::

    initial = initial_from_get(request, ["status", "site", "vrf", "description"])
"""

from __future__ import annotations

from typing import Iterable, Optional
from urllib.parse import urlencode

from django.http import HttpRequest, HttpResponse
from django.shortcuts import redirect
from django.urls import reverse


SAVE_AND_ADD_MORE_FLAG = "_save_and_add_more"


def _normalize(value):
    """Reduce form-cleaned values to something URL-safe.

    Model instances become their primary key. Sequences are kept as a list so
    ``urlencode(doseq=True)`` can lay them out as repeated query params.
    """
    if value in (None, "", [], (), set()):
        return None
    if hasattr(value, "pk"):
        return str(value.pk)
    if isinstance(value, (list, tuple, set)):
        out = [_normalize(v) for v in value]
        return [v for v in out if v is not None] or None
    return str(value)


def save_and_add_more_redirect(
    request: HttpRequest,
    *,
    view_name: str,
    form,
    sticky_fields: Iterable[str],
    view_kwargs: Optional[dict] = None,
) -> Optional[HttpResponse]:
    """Return a redirect response if the user clicked "Save and add more".

    Returns ``None`` if the standard save path should run instead. The caller
    is expected to check the return value::

        resp = save_and_add_more_redirect(request, view_name="...", form=form,
                                          sticky_fields=[...])
        if resp is not None:
            return resp
    """
    if not request.POST.get(SAVE_AND_ADD_MORE_FLAG):
        return None

    cleaned = getattr(form, "cleaned_data", {}) or {}
    params: list[tuple[str, str]] = []
    for field in sticky_fields:
        norm = _normalize(cleaned.get(field))
        if norm is None:
            continue
        if isinstance(norm, list):
            for v in norm:
                params.append((field, v))
        else:
            params.append((field, norm))

    url = reverse(view_name, kwargs=view_kwargs or {})
    if params:
        url = f"{url}?{urlencode(params, doseq=True)}"
    return redirect(url)


def initial_from_get(request: HttpRequest, fields: Iterable[str]) -> dict:
    """Pull the named fields out of ``request.GET`` into a Django form initial.

    Multi-value GET keys collapse to a list (M2M-friendly). Returns only keys
    that were actually present so it composes cleanly with other initial
    sources (``initial.update(initial_from_get(...))``).
    """
    initial: dict = {}
    for field in fields:
        values = request.GET.getlist(field)
        if not values:
            continue
        initial[field] = values[0] if len(values) == 1 else values
    return initial
