"""Shared filter helpers used by list pages.

The point: every list page that hangs off a taggable model should expose
the same tag-filter rail without each view rewriting the boilerplate. The
helpers here build the context for ``api/_tag_facet.html`` and apply the
``?tag=<slug>&tag=<slug>...`` query into a queryset.

Adding a new tag-filterable list page is a 3-liner in the view:

    qs = apply_tag_filter(qs, request)                       # narrow by ?tag=
    context["tag_facet"] = tag_facet_for(qs, request)        # facet rail
    context["active_filters"] += tag_active_filters(request) # filter chips
"""
from __future__ import annotations

from typing import Iterable

from django.db.models import Count, QuerySet
from django.http import HttpRequest

from core.models import Tag


def apply_tag_filter(qs: QuerySet, request: HttpRequest, *, field: str = "tags") -> QuerySet:
    """Narrow ``qs`` by the ``?tag=<slug>`` query params.

    Multiple tags use AND semantics — a row must carry every selected tag
    (that matches what most users expect: "show
    rows tagged with prod AND core").
    """
    slugs = [s for s in request.GET.getlist("tag") if s]
    for slug in slugs:
        qs = qs.filter(**{f"{field}__slug": slug})
    return qs.distinct() if slugs else qs


def tag_facet_for(
    qs: QuerySet,
    request: HttpRequest,
    *,
    field: str = "tags",
    pre_tag_qs: QuerySet | None = None,
) -> list[dict] | None:
    """Build the tag-facet context for ``api/_tag_facet.html``.

    The list only includes tags actually present on the (pre-tag-filtered)
    queryset — there's no point showing zero-count tags. Returns ``None``
    when no tags exist for this model, so the partial can render as a
    no-op section instead of an empty bordered block.

    ``pre_tag_qs`` is the queryset BEFORE ``apply_tag_filter`` was applied —
    pass it so usage counts reflect "rows that match every other filter",
    not "rows that already match the chosen tags". If omitted we fall back
    to ``qs`` (acceptable; counts then show the post-filter total).
    """
    base = pre_tag_qs if pre_tag_qs is not None else qs
    # The reverse relation manager name is "tagged_items" on Tag — see
    # core.models. Counting through the GenericRelation gets us the tag's
    # usage across the whole table; we want it scoped to *this* queryset
    # so we annotate on the queryset and group.
    ids = list(base.values_list("id", flat=True))
    if not ids:
        return None
    model = base.model
    tag_field = model._meta.get_field(field)
    # Cheapest: tag_id distinct + counts via the taggit through table.
    # django-taggit exposes the through manager as ``tags.through``.
    through = tag_field.remote_field.through
    # The through model has a ``content_object`` GenericFK + ``tag``.
    rows = (
        through.objects
        .filter(content_type__model=model._meta.model_name, object_id__in=ids)
        .values("tag_id")
        .annotate(usage=Count("id"))
    )
    counts = {r["tag_id"]: r["usage"] for r in rows}
    if not counts:
        return []

    selected = set(s for s in request.GET.getlist("tag") if s)
    tags = Tag.objects.filter(id__in=counts.keys()).order_by("name")
    return [
        {
            "tag": t,
            "usage": counts.get(t.id, 0),
            "selected": t.slug in selected,
        }
        for t in tags
    ]


def tag_active_filters(request: HttpRequest) -> list[dict]:
    """Active-filter chip rows for each ``?tag=<slug>`` param, ready to
    drop into the list page's ``active_filters`` context."""
    slugs = [s for s in request.GET.getlist("tag") if s]
    if not slugs:
        return []
    by_slug = {t.slug: t for t in Tag.objects.filter(slug__in=slugs)}
    out = []
    for slug in slugs:
        qs = request.GET.copy()
        vals = qs.getlist("tag")
        if slug in vals:
            vals.remove(slug)
        qs.setlist("tag", vals)
        qs.pop("page", None)
        t = by_slug.get(slug)
        out.append({
            "key": "tag", "value": slug,
            "label": f"Tag: {t.name if t else slug}",
            "drop_qs": qs.urlencode(),
        })
    return out
