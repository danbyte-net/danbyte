"""The Zabbix API surface.

Every viewset carries ``integration_keys = ("zabbix",)`` so the whole surface
404s while the tenant switch is off - a disabled integration is invisible, not
merely inert.
"""
from __future__ import annotations

from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from api.models import Device, IPAddress
from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api import rbac
from integrations.toggles import IntegrationToggleMixin, integration_enabled

from .models import (
    ZabbixAdoptionRule,
    ZabbixChange,
    ZabbixConnection,
    ZabbixHostFacts,
    ZabbixHostLink,
    ZabbixMaintenance,
    ZabbixProvisionRule,
)
from .serializers import (
    ZabbixAdoptionRuleSerializer,
    ZabbixChangeSerializer,
    ZabbixConnectionSerializer,
    ZabbixDefaultsSerializer,
    ZabbixHostLinkSerializer,
    ZabbixMaintenanceSerializer,
    ZabbixProvisionRuleSerializer,
)


class ZabbixConnectionViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("zabbix",)
    queryset = ZabbixConnection.objects.all().order_by("name")
    serializer_class = ZabbixConnectionSerializer

    @action(detail=False, methods=["get"])
    def defaults(self, request):
        """Severities, their default mapping and the statuses they can map
        onto, so the form hard-codes neither Zabbix's enum nor Danbyte's."""
        return Response(
            ZabbixDefaultsSerializer.payload(_get_active_tenant(request))
        )

    @action(detail=True, methods=["get"])
    def templates(self, request, pk=None):
        """Every template on the server, so a rule is picked rather than typed.

        Never fails the request: an unreachable Zabbix means the form falls
        back to typing names, which is worse but still works - and being unable
        to reach the server is not a reason to refuse to edit a rule.
        """
        from .client import ZabbixError
        from .provision import _client

        try:
            client = _client(self.get_object())
            return Response({
                "templates": client.all_templates(),
                # Proxies ride the same request: the rule form wants both, and
                # a second round-trip to a single-threaded API is not free.
                "proxies": client.all_proxies(),
                "error": "",
            })
        except ZabbixError as exc:
            return Response({"templates": [], "proxies": [], "error": str(exc)[:300]})

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Reach the server and describe it. Records what it learned."""
        from .driver import test_connection

        result = test_connection(self.get_object())
        return Response(result, status=200 if result["ok"] else 502)

    @action(detail=True, methods=["get"])
    def scope(self, request, pk=None):
        """Which devices this connection should keep hosts for, and where each
        has got to - linked, waiting on a proposal, or neither."""
        from .provision import scope_report

        return Response({"devices": scope_report(self.get_object())})

    @action(detail=True, methods=["post"])
    def sync(self, request, pk=None):
        """Work out what provisioning would do now - and in auto mode, do it.

        The same entry point the scheduled pass uses, so a button and a timer
        can never drift apart.
        """
        from .provision import sync

        return Response(sync(self.get_object()))

    @action(detail=True, methods=["post"], url_path="sync-maintenance")
    def sync_maintenance(self, request, pk=None):
        """Reconcile Danbyte's windows into Zabbix now. The same function the
        timer and the workflow hooks run, so the button cannot drift."""
        from .maintenance import reconcile

        conn = self.get_object()
        if not conn.sync_maintenance:
            return Response({"detail": "Maintenance sync is off."}, status=400)
        return Response(reconcile(conn))


class ZabbixMaintenanceViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Read-only: a period is written by the reconcile pass, never by hand."""

    integration_keys = ("zabbix",)
    http_method_names = ["get", "head", "options"]
    queryset = ZabbixMaintenance.objects.select_related("event").order_by("-starts_at")
    serializer_class = ZabbixMaintenanceSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection") if self.request else None
        return qs.filter(connection_id=conn) if conn else qs


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

    def perform_destroy(self, instance):
        # Unlinking says "that pairing is wrong", so what the host said about
        # this device stops being an observation of it.
        from .facts import forget

        conn, device = instance.connection, instance.device
        super().perform_destroy(instance)
        forget(conn, device)


class ZabbixChangeViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """The review queue. Changes are proposed by a sync pass, never created
    here - so this offers apply, dismiss, and nothing else."""

    integration_keys = ("zabbix",)
    http_method_names = ["get", "post", "head", "options"]
    queryset = (
        ZabbixChange.objects.select_related("device", "connection")
        .order_by("kind", "-created_at")
    )
    serializer_class = ZabbixChangeSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params if self.request else {}
        conn = params.get("connection")
        if conn:
            qs = qs.filter(connection_id=conn)
        # The queue by default; `?ignored=1` is the dismissed pile, which
        # exists so a mis-click is not a permanent silence.
        return qs.filter(ignored=params.get("ignored") in ("1", "true"))

    @action(detail=True, methods=["post"])
    def restore(self, request, pk=None):
        """Un-dismiss. Back in the queue; the next pass re-checks it anyway."""
        change = ZabbixChange.objects.filter(
            pk=pk, tenant=_get_active_tenant(request), ignored=True
        ).first()
        if change is None:
            return Response({"detail": "Not found."}, status=404)
        change.ignored = False
        change.save(update_fields=["ignored"])
        return Response({"ok": True})

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


class ZabbixProvisionRuleViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Which Zabbix templates a kind of device should carry.

    Rules stack: a device gets the union of every rule that matches it, so
    small statements compose instead of one list per model.
    """

    integration_keys = ("zabbix",)
    queryset = ZabbixProvisionRule.objects.all().order_by("scope", "-created_at")
    serializer_class = ZabbixProvisionRuleSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection") if self.request else None
        return qs.filter(connection_id=conn) if conn else qs

    @action(detail=False, methods=["get"])
    def scopes(self, request):
        """What a rule can be about, and the catalog behind each - so the form
        does not hard-code Danbyte's own object model in TypeScript."""
        return Response({"scopes": [
            {"value": v, "label": label,
             "catalog": _SCOPE_ENDPOINT.get(v, "")}
            for v, label in ZabbixProvisionRule.SCOPE_CHOICES
        ]})


class ZabbixAdoptionRuleViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """Where an adopted host lands, decided by its name, group or address.

    First match wins in weight order - the same shape as the VM placement
    rules, and the same matcher.
    """

    integration_keys = ("zabbix",)
    queryset = (
        ZabbixAdoptionRule.objects.select_related("site", "role", "device_type")
        .order_by("weight", "pattern")
    )
    serializer_class = ZabbixAdoptionRuleSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection") if self.request else None
        return qs.filter(connection_id=conn) if conn else qs


#: Where the SPA fetches the options for each scope.
_SCOPE_ENDPOINT = {
    ZabbixProvisionRule.SCOPE_SITE: "/api/sites/",
    ZabbixProvisionRule.SCOPE_ROLE: "/api/device-roles/",
    ZabbixProvisionRule.SCOPE_PLATFORM: "/api/platforms/",
    ZabbixProvisionRule.SCOPE_TYPE: "/api/device-types/",
    ZabbixProvisionRule.SCOPE_MANUFACTURER: "/api/manufacturers/",
}


class ZabbixHostStatusView(APIView):
    """What Zabbix says about a device's hosts - ``?device=<id>`` or
    ``?ip=<id>`` (resolved through the address's device).

    An empty list means the device is not linked to any host. 404 while the
    integration is off, like the rest of the surface. Read access is the
    device's own: a viewer who may see the device may see what Zabbix says
    about it, and one who may not sees nothing at all.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        tenant = _get_active_tenant(request)
        if tenant is None or not integration_enabled(tenant, "zabbix"):
            raise NotFound("Integration not enabled.")
        device_id = (request.query_params.get("device") or "").strip()
        ip_id = (request.query_params.get("ip") or "").strip()
        if ip_id and not device_id:
            ip = rbac.restrict_queryset(
                IPAddress.objects.filter(tenant=tenant, id=ip_id),
                request.user, tenant, "ipaddress", "view",
            ).first()
            if ip is None or not ip.assigned_device_id:
                return Response([])
            device_id = str(ip.assigned_device_id)
        if not device_id:
            return Response({"detail": "device or ip is required."}, status=400)
        device = rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant, id=device_id),
            request.user, tenant, "device", "view",
        ).first()
        if device is None:
            return Response([])
        return Response(host_status_for(device))


def host_status_for(device) -> list[dict]:
    """One entry per link, with the facts row's status fields and the
    connection's severity map applied so the panel can show a pill in
    Danbyte's words beside Zabbix's own severity."""
    from .severity import clean_map, worst

    links = (
        ZabbixHostLink.objects.filter(device=device, connection__enabled=True)
        .select_related("connection")
        .order_by("connection__name")
    )
    facts_by_conn = {
        f.connection_id: f
        for f in ZabbixHostFacts.objects.filter(device=device)
    }
    out = []
    for link in links:
        conn = link.connection
        f = facts_by_conn.get(conn.id)
        mapping = clean_map(conn.severity_map)
        problems = list(f.problems) if f else []
        out.append({
            "connection": {
                "id": str(conn.id), "name": conn.name, "url": conn.url,
                "read_host_status": conn.read_host_status,
            },
            "host": {"hostid": link.hostid, "name": link.host_name},
            "link": {"matched_by": link.matched_by, "created_here": link.created_here},
            "status": {
                "problems": problems,
                "problem_count": f.problem_count if f else 0,
                "worst_severity": f.worst_severity if f else "",
                "worst_status": worst(
                    (p.get("severity") for p in problems), mapping
                ) if problems else ("up" if f and f.status_polled_at else None),
                "availability": dict(f.availability) if f else {},
                "maintenance": bool(f and f.maintenance),
                "disabled": bool(f and f.disabled),
                "polled_at": f.status_polled_at if f else None,
            },
        })
    return out
