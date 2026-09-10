"""The Zabbix API surface.

Every viewset carries ``integration_keys = ("zabbix",)`` so the whole surface
404s while the tenant switch is off - a disabled integration is invisible, not
merely inert.
"""
from __future__ import annotations

from rest_framework.decorators import action
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet
from integrations.toggles import IntegrationToggleMixin

from .models import ZabbixChange, ZabbixConnection, ZabbixHostLink
from .serializers import (
    ZabbixChangeSerializer,
    ZabbixConnectionSerializer,
    ZabbixDefaultsSerializer,
    ZabbixHostLinkSerializer,
)


class ZabbixConnectionViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("zabbix",)
    queryset = ZabbixConnection.objects.all().order_by("name")
    serializer_class = ZabbixConnectionSerializer

    @action(detail=False, methods=["get"])
    def defaults(self, request):
        """Severities and their default mapping, so the form can render the
        table without hard-coding Zabbix's enum in TypeScript."""
        return Response(ZabbixDefaultsSerializer.payload())

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Reach the server and describe it. Records what it learned."""
        from .driver import test_connection

        result = test_connection(self.get_object())
        return Response(result, status=200 if result["ok"] else 502)

    @action(detail=True, methods=["post"])
    def sync(self, request, pk=None):
        """Work out what provisioning would do now - and in auto mode, do it.

        The same entry point the scheduled pass uses, so a button and a timer
        can never drift apart.
        """
        from .provision import sync

        return Response(sync(self.get_object()))


class ZabbixHostLinkViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Read-only: a link is made by matching, not by hand.

    Deleting one is the exception - it is how an operator says "that pairing
    is wrong", and the next pass then re-matches from scratch.
    """

    integration_keys = ("zabbix",)
    http_method_names = ["get", "delete", "head", "options"]
    queryset = ZabbixHostLink.objects.select_related("device").order_by("host_name")
    serializer_class = ZabbixHostLinkSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection") if self.request else None
        return qs.filter(connection_id=conn) if conn else qs


class ZabbixChangeViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """The review queue. Changes are proposed by a sync pass, never created
    here - so this offers apply, dismiss, and nothing else."""

    integration_keys = ("zabbix",)
    http_method_names = ["get", "post", "head", "options"]
    queryset = (
        ZabbixChange.objects.select_related("device", "connection")
        .filter(ignored=False)
        .order_by("kind", "-created_at")
    )
    serializer_class = ZabbixChangeSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection") if self.request else None
        return qs.filter(connection_id=conn) if conn else qs

    @action(detail=True, methods=["post"])
    def apply(self, request, pk=None):
        """Do this one write. The operator's act, not Danbyte's."""
        from .client import ZabbixError
        from .provision import apply_change

        change = self.get_object()
        try:
            return Response({"ok": True, "detail": apply_change(change)})
        except ValueError as exc:
            return Response({"ok": False, "detail": str(exc)}, status=400)
        except ZabbixError as exc:
            return Response({"ok": False, "detail": str(exc)}, status=502)

    @action(detail=True, methods=["post"])
    def dismiss(self, request, pk=None):
        """Not now. Kept, so the next pass does not raise it again."""
        change = self.get_object()
        change.ignored = True
        change.save(update_fields=["ignored"])
        return Response({"ok": True})

    @action(detail=False, methods=["post"], url_path="apply-all")
    def apply_all(self, request):
        """Apply every applicable proposal for one connection.

        Ambiguous ones are skipped - they need a person, and "apply all" must
        not quietly resolve them by guessing.
        """
        from api.views import _get_active_tenant

        from .provision import apply_pending

        # Scoped to the active tenant, not just looked up by id: a connection
        # id is a UUID somebody could have from anywhere.
        conn = ZabbixConnection.objects.filter(
            pk=request.data.get("connection"),
            tenant=_get_active_tenant(request),
        ).first()
        if conn is None:
            return Response({"detail": "Unknown connection."}, status=404)
        return Response(apply_pending(conn))
