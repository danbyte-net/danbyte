"""Counts of related rows the reader may view (#438).

A count on a catalog object - the devices on a platform, the racks of a
role - is the number of rows the list it links to shows the reader. The
counted type's view scope (constraints and site scope, as ``restrict_for_view``
applies it to that list) narrows the count, so a site-limited user neither
sees a tab number above a shorter table nor learns what other sites run.

``related_count_expr`` annotates a whole list in one statement;
``related_count`` counts for one object (a detail page, a save response).
Both take the reverse relation's query name on the catalog model.
"""
from __future__ import annotations

from django.db.models import Count, IntegerField, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce


def _view_filter(request, slug: str):
    """``Q`` of the ``slug`` rows the request's user may view: ``Q()`` for
    all, ``None`` for none. No request means an internal serialisation,
    which counts everything."""
    if request is None:
        return Q()
    user = getattr(request, "user", None)
    if not getattr(user, "is_authenticated", False):
        return None
    from auth_api import rbac
    from auth_api.object_types import is_registered

    if not is_registered(slug):
        return Q()
    memo = getattr(request, "_visible_count_filters", None)
    if memo is None:
        memo = {}
        try:
            request._visible_count_filters = memo
        except AttributeError:
            pass
    if slug not in memo:
        from api.views import _get_active_tenant

        f = rbac.row_filter(user, _get_active_tenant(request), slug, "view")
        memo[slug] = Q() if f is True else f
    return memo[slug]


def _relation(model, rel_name: str):
    rel = model._meta.get_field(rel_name)
    return rel.related_model, rel.field.name


def related_count_expr(request, model, rel_name: str):
    """Per-row count of ``model``'s ``rel_name`` rows the reader may view."""
    related, fk = _relation(model, rel_name)
    f = _view_filter(request, related._meta.model_name)
    if f is None:
        return Value(0, output_field=IntegerField())
    sub = (
        related._default_manager.filter(f)
        .filter(**{fk: OuterRef("pk")})
        .order_by()
        .values(fk)
        .annotate(c=Count("pk", distinct=True))
        .values("c")
    )
    return Coalesce(Subquery(sub, output_field=IntegerField()), Value(0))


def related_count(request, obj, rel_name: str) -> int:
    """Count of ``obj``'s ``rel_name`` rows the reader may view."""
    related, fk = _relation(type(obj), rel_name)
    f = _view_filter(request, related._meta.model_name)
    if f is None:
        return 0
    return related._default_manager.filter(f).filter(**{fk: obj.pk}).distinct().count()
