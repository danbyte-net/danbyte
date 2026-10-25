"""The PRTG API surface.

Every viewset carries ``integration_keys = ("prtg",)`` so the whole surface
404s while the tenant switch is off - a disabled integration is invisible, not
merely inert.
"""
from __future__ import annotations

from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet
from integrations.toggles import IntegrationToggleMixin

from .models import PrtgConnection
from .serializers import PrtgConnectionSerializer

_TestResult = inline_serializer("PrtgTestResult", fields={
    "ok": serializers.BooleanField(),
    "detail": serializers.CharField(),
    "version": serializers.CharField(),
    "probes": serializers.IntegerField(allow_null=True),
    "sensors": serializers.IntegerField(allow_null=True),
    "v2_available": serializers.BooleanField(allow_null=True),
    "v2_detail": serializers.CharField(),
})


class PrtgConnectionViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("prtg",)
    queryset = PrtgConnection.objects.all().order_by("name")
    serializer_class = PrtgConnectionSerializer

    @extend_schema(request=None, responses={200: _TestResult, 502: _TestResult})
    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Reach PRTG and describe it: version, probes, sensors, API v2.
        Records what it learned on the connection."""
        from .connection import test_connection

        result = test_connection(self.get_object())
        return Response(result, status=200 if result["ok"] else 502)
