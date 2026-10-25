"""DRF pagination for every list endpoint.

A list request without ``?page_size=`` answers one page of
``settings.API_PAGE_SIZE`` rows (100 unless the deployment sets
``API_PAGE_SIZE``), with ``count``, ``next`` and ``previous``. A caller that
wants more names it: ``?page_size=`` up to ``settings.API_MAX_PAGE_SIZE``
(10,000), or walks ``next``. The default used to be the 10,000 cap, which made
an unparameterized list of a large tenant hold a sync worker for seconds (#447).
"""
from django.conf import settings
from rest_framework.pagination import PageNumberPagination


class StandardResultsSetPagination(PageNumberPagination):
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
