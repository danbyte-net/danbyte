"""The OpenAPI schema view, cached after the permission check.

Generating the schema walks every viewset and takes seconds. It is served
public (``SERVE_PUBLIC``), so it is the same for every caller and one copy
per release and language is enough. The copy is cached inside the view,
after DRF has authenticated the request: a page cache in front of the view
would answer before authentication and hand a copy filled by a token client
to anyone.
"""
from __future__ import annotations

from django.core.cache import cache
from django.utils import translation
from drf_spectacular.views import SpectacularAPIView
from rest_framework.response import Response

import danbyte

SCHEMA_CACHE_SECONDS = 60 * 60


class CachedSpectacularAPIView(SpectacularAPIView):
    def _get_schema_response(self, request):
        version = (
            self.api_version or request.version or self._get_version_parameter(request)
        )
        key = "api-schema:{}:{}:{}".format(
            danbyte.__version__, version or "", translation.get_language() or ""
        )
        data = cache.get(key)
        if data is None:
            generator = self.generator_class(
                urlconf=self.urlconf, api_version=version, patterns=self.patterns
            )
            data = generator.get_schema(request=request, public=self.serve_public)
            cache.set(key, data, SCHEMA_CACHE_SECONDS)
        return Response(
            data=data,
            headers={
                "Content-Disposition": (
                    f'inline; filename="{self._get_filename(request, version)}"'
                )
            },
        )
