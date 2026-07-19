"""DRF pagination for the SPA.

The React app loads a full result set per list view and does its own
client-side filtering, faceting, sorting and grouping (see the facet rails in
the list routes). A small server page size therefore silently hides data — the
table only ever sees page 1. So default to a high page size while still exposing
``?limit=``/``?page=`` for callers (and future server-side paging) that want it.
"""
from rest_framework.pagination import PageNumberPagination


class StandardResultsSetPagination(PageNumberPagination):
    # High enough to return an entire tenant's list in one response for typical
    # self-hosted inventories; bounded so a pathological table can't dump
    # unbounded rows. Override per-request with ?limit=.
    page_size = 10000
    page_size_query_param = "page_size"  # matches existing ?page_size= callers
    # Cap client-requested page size at the default: the SPA's "whole list"
    # fetch still works, but ?page_size=100000 can't be used to force
    # serialization of an amplified, memory-heavy response (DoS).
    max_page_size = 10000
