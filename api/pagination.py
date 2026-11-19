"""DRF pagination for every list endpoint.

A list request without ``?page_size=`` answers one page of
``settings.API_PAGE_SIZE`` rows (100 unless the deployment sets
``API_PAGE_SIZE``), with ``count``, ``next`` and ``previous``. A caller that
wants more names it: ``?page_size=`` up to ``settings.API_MAX_PAGE_SIZE``
(2,000 unless the deployment sets ``API_MAX_PAGE_SIZE``), or walks ``next``.
The default used to be a 10,000 cap, which made an unparameterized list of a
large tenant hold a sync worker for seconds (#447); the cap itself was 10,000
until a few such pages held every worker (#452). Pages above
``API_LARGE_PAGE_THRESHOLD`` (1,000) are also limited per token or user
(``core.middleware.LargePageGuardMiddleware``).

Every page is cut from a total order: a list sorted by a column that can
repeat (a VLAN ID, a timestamp) gets the primary key as its last term, so
walking the pages returns each row exactly once (#529). And a page reads
its ids first, then those rows in full (#532, :func:`api.list_table.
page_by_ids`): a deep page or a sort on a joined column costs about what
page 1 does.
"""
from django.conf import settings
from django.db.models import F, QuerySet
from django.db.models.expressions import OrderBy
from rest_framework.pagination import PageNumberPagination


def _unique_term(model, term) -> bool:
    """Is ``term`` (an ORDER BY term) a column no two rows share?"""
    if isinstance(term, OrderBy):
        term = term.expression
    if isinstance(term, F):
        name = term.name
    elif isinstance(term, str):
        name = term.lstrip("-")
    else:
        return False
    if name in ("pk", "?"):
        return name == "pk"
    if "__" in name:
        return False
    try:
        field = model._meta.get_field(name)
    except Exception:  # noqa: BLE001 - an annotation, not a field
        return False
    return bool(getattr(field, "primary_key", False) or getattr(field, "unique", False))


def stable_order(queryset):
    """``queryset`` with a total order: the primary key appended when its
    ORDER BY can tie (#529). Unordered querysets get the key alone. Union
    and ``values()`` querysets are returned as they are: their ORDER BY may
    only name what they select."""
    if not isinstance(queryset, QuerySet):
        return queryset
    q = queryset.query
    if q.combinator or queryset._fields is not None or q.is_sliced or q.extra_order_by:
        return queryset
    if q.order_by:
        terms = list(q.order_by)
    elif q.default_ordering and queryset.model._meta.ordering:
        terms = list(queryset.model._meta.ordering)
    else:
        terms = []
    if terms and _unique_term(queryset.model, terms[-1]):
        return queryset
    return queryset.order_by(*terms, "pk")


def _pages_by_ids(queryset) -> bool:
    """Can ``queryset`` be paged by its ids first? Not a DISTINCT (its ORDER
    BY must be in its SELECT), a union, a ``values()`` list or a grouped
    aggregate: those are paged in one query as before."""
    if not isinstance(queryset, QuerySet):
        return False
    q = queryset.query
    return not (
        q.distinct or q.combinator or queryset._fields is not None or q.is_sliced
        or q.group_by is not None or q.extra or q.extra_order_by
    )


class StablePagination(PageNumberPagination):
    """Pages cut from a total order (#529), by ids first (#532)."""

    def paginate_queryset(self, queryset, request, view=None):
        queryset = stable_order(queryset)
        if not _pages_by_ids(queryset):
            return super().paginate_queryset(queryset, request, view)
        from .list_table import page_by_ids

        parent = super()
        rows = page_by_ids(queryset, lambda ids: parent.paginate_queryset(ids, request, view))
        if rows is not None:
            self.page.object_list = rows
        return rows


class StandardResultsSetPagination(StablePagination):
    page_size_query_param = "page_size"

    # Read per request rather than frozen at import, so the setting (and a
    # test's override_settings) always applies.
    @property
    def page_size(self) -> int:
        return settings.API_PAGE_SIZE

    @property
    def max_page_size(self) -> int:
        # Bounded so ?page_size=100000 can't force serialization of an
        # amplified, memory-heavy response (DoS).
        return settings.API_MAX_PAGE_SIZE
