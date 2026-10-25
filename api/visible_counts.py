"""Counts of related rows the reader may view (#438).

A count on a catalog object - the devices on a platform, the racks of a
role - is the number of rows the list it links to shows the reader. The
counted type's view scope (constraints and site scope, as ``restrict_for_view``
applies it to that list) narrows the count, so a site-limited user neither
sees a tab number above a shorter table nor learns what other sites run.

``related_count_expr`` annotates a whole list in one statement;
``related_count`` counts for one object (a detail page, a save response).
Both take the reverse relation's query name on the catalog model.
``path_count_expr`` and ``path_count`` take the counted model and its lookup
path back instead, for a count across more than one relation.
``tagged_count_expr`` and ``tagged_count`` do the same for a tag's usage,
which hangs off the generic ``core.TaggedItem`` instead of a foreign key.
``tenant_count_expr`` and ``tenant_count`` count a tenant's own rows, each
tenant's through the reader's grants in that tenant rather than in the
active one (#448).
"""
from __future__ import annotations

import functools

from django.db.models import Count, Exists, IntegerField, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce

_ACTIVE = object()


def _view_filter(request, slug: str, tenant=_ACTIVE):
    """``Q`` of the ``slug`` rows the request's user may view: ``Q()`` for
    all, ``None`` for none. No request means an internal serialisation,
    which counts everything. The grants are the active tenant's unless
    ``tenant`` names another."""
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
    key = slug if tenant is _ACTIVE else (slug, getattr(tenant, "pk", tenant))
    if key not in memo:
        if tenant is _ACTIVE:
            from api.views import _get_active_tenant

            tenant = _get_active_tenant(request)
        f = rbac.row_filter(user, tenant, slug, "view")
        memo[key] = Q() if f is True else f
    return memo[key]


def _relation(model, rel_name: str):
    rel = model._meta.get_field(rel_name)
    return rel.related_model, rel.field.name


def path_count_expr(request, related, path: str):
    """Per-row count of the ``related`` rows the reader may view whose
    ``path`` leads back to the row. For a count that crosses more than one
    relation, such as the circuits that terminate on a provider network."""
    return _count_subquery(related, _view_filter(request, related._meta.model_name), path)


def _count_subquery(related, f, path: str):
    """Correlated count of the ``related`` rows matching ``f`` whose ``path``
    is the outer row; 0 when ``f`` is ``None`` (nothing granted)."""
    if f is None:
        return Value(0, output_field=IntegerField())
    sub = (
        related._default_manager.filter(f)
        .filter(**{path: OuterRef("pk")})
        .order_by()
        .values(path)
        .annotate(c=Count("pk", distinct=True))
        .values("c")
    )
    return Coalesce(Subquery(sub, output_field=IntegerField()), Value(0))


def path_count(request, related, path: str, pk) -> int:
    """Count of the ``related`` rows the reader may view whose ``path`` is
    ``pk``."""
    f = _view_filter(request, related._meta.model_name)
    if f is None:
        return 0
    return related._default_manager.filter(f).filter(**{path: pk}).distinct().count()


def related_count_expr(request, model, rel_name: str):
    """Per-row count of ``model``'s ``rel_name`` rows the reader may view."""
    related, fk = _relation(model, rel_name)
    return path_count_expr(request, related, fk)


def related_count(request, obj, rel_name: str) -> int:
    """Count of ``obj``'s ``rel_name`` rows the reader may view."""
    related, fk = _relation(type(obj), rel_name)
    return path_count(request, related, fk, obj.pk)


@functools.cache
def _site_scoped_taggables() -> tuple:
    """The taggable models a site scope narrows: the ``SITE_PATHS`` types,
    and the ``CATALOG_SITE_PATHS`` catalogs (narrowed while the tenant runs
    enhanced site separation)."""
    from django.apps import apps
    from taggit.managers import TaggableManager

    from auth_api.site_paths import CATALOG_SITE_PATHS, SITE_PATHS
    from core.models import TaggedItem

    out = []
    for model in apps.get_models():
        slug = model._meta.model_name
        if slug not in SITE_PATHS and slug not in CATALOG_SITE_PATHS:
            continue
        if any(
            isinstance(f, TaggableManager) and f.remote_field.through is TaggedItem
            for f in model._meta.get_fields()
        ):
            out.append(model)
    return tuple(out)


def tagged_count_expr(request):
    """Per-tag count of the tagged rows the reader may view.

    ``core.TaggedItem`` is generic - (content_type, object_id) - so there is
    no foreign key for ``related_count_expr`` to follow. A row of a
    site-scoped type counts when the reader may view the object it tags, one
    ``EXISTS`` per such type; a type the reader may not view counts nothing.
    Rows of other types count as they are, as does every row for a reader
    no scope narrows.
    """
    from django.contrib.contenttypes.models import ContentType

    from core.models import TaggedItem

    cts = ContentType.objects.get_for_models(*_site_scoped_taggables())
    # Only the types that carry a tag at all: the others add nothing to any
    # count, and each narrowed type costs a subquery to build and plan.
    present = set(
        ContentType.objects.filter(pk__in=[ct.pk for ct in cts.values()])
        .filter(Exists(TaggedItem.objects.filter(content_type=OuterRef("pk"))))
        .values_list("pk", flat=True)
    )
    hidden, narrowed = [], []
    for model, ct in cts.items():
        if ct.pk not in present:
            continue
        f = _view_filter(request, model._meta.model_name)
        if f is None:
            hidden.append(ct.pk)
        elif f:  # Q() is every row: nothing to narrow
            narrowed.append((ct.pk, model, f))
    rows = TaggedItem.objects.filter(tag=OuterRef("pk"))
    if hidden or narrowed:
        shown = ~Q(content_type_id__in=hidden + [ct for ct, _, _ in narrowed])
        for ct, model, f in narrowed:
            mine = model._default_manager.filter(f).filter(pk=OuterRef("object_id"))
            shown |= Q(content_type_id=ct) & Q(Exists(mine))
        rows = rows.filter(shown)
    sub = rows.order_by().values("tag").annotate(c=Count("pk")).values("c")
    return Coalesce(Subquery(sub, output_field=IntegerField()), Value(0))


def tagged_count(request, tag) -> int:
    """Count of ``tag``'s tagged rows the reader may view."""
    from core.models import Tag

    n = (
        Tag.objects.filter(pk=tag.pk)
        .annotate(n=tagged_count_expr(request))
        .values_list("n", flat=True)
        .first()
    )
    return n or 0


def _tenants_filter(request, related, fk: str, tenants):
    """``Q`` of the ``related`` rows the reader may view in any of
    ``tenants`` - each tenant's rows (``fk`` is the tenant field) through the
    grants the reader holds in that tenant. ``Q()`` for all, ``None`` for
    none."""
    user = getattr(request, "user", None)
    if request is None or (getattr(user, "is_authenticated", False) and user.is_superuser):
        return Q()
    from auth_api import rbac

    tenants = list(tenants)
    rbac.prime_permissions(user, tenants)  # one read of the grants for all
    slug = related._meta.model_name
    out, narrowed = Q(), False
    for tenant in tenants:
        f = _view_filter(request, slug, tenant)
        if f is None:
            narrowed = True
            continue
        if f:
            narrowed = True
        out |= Q(**{fk: tenant.pk}) & f
    if not narrowed:
        return Q()
    return out if out else None


def tenant_count_expr(request, rel_name: str, tenants):
    """Per-tenant count of its ``rel_name`` rows the reader may view, for a
    list of the ``tenants`` it can show."""
    from core.models import Tenant

    related, fk = _relation(Tenant, rel_name)
    return _count_subquery(related, _tenants_filter(request, related, fk, tenants), fk)


def tenant_count(request, tenant, rel_name: str) -> int:
    """Count of ``tenant``'s ``rel_name`` rows the reader may view."""
    related, fk = _relation(type(tenant), rel_name)
    f = _tenants_filter(request, related, fk, [tenant])
    if f is None:
        return 0
    return related._default_manager.filter(f).filter(**{fk: tenant.pk}).distinct().count()


def view_filter(request, model):
    """``Q`` of the ``model`` rows the reader may view in the active tenant:
    ``Q()`` for all, ``None`` for none. For a count worked out in Python over
    rows read from the database, such as a prefix's descendants."""
    return _view_filter(request, model._meta.model_name)
