"""The registration API: policies, sensor profiles, PRTG's groups and the
per-object plan preview. Behind the ``prtg`` integration switch like the rest
of ``/api/prtg/``. Nothing here writes to PRTG."""
from __future__ import annotations

from django.utils import timezone
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api import rbac
from integrations.toggles import IntegrationToggleMixin, integration_enabled

from . import sensor_kinds as sk
from .models import PrtgConnection, PrtgCredential, PrtgPolicy, PrtgSensorProfile
from .policy_api import PolicyMatchesMixin
from .registration_serializers import (
    PrtgCredentialSerializer,
    PrtgPolicySerializer,
    PrtgSensorProfileSerializer,
)


class _ByConnection:
    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection") if self.request else None
        return qs.filter(connection_id=conn) if conn else qs


class PrtgPolicyViewSet(
    PolicyMatchesMixin, IntegrationToggleMixin, _ByConnection, TenantScopedViewSet
):
    """Which devices and VMs PRTG should have. Lower priority first.
    ``<id>/matches/`` lists who a policy hits; ``<id>/`` adds ``match_count``."""

    integration_keys = ("prtg",)
    rbac_action_map = {"matches": "view"}
    queryset = PrtgPolicy.objects.select_related(
        "profile", "region", "target_site", "location", "platform", "device_type",
        "device_role",
    ).order_by("priority", "name")
    serializer_class = PrtgPolicySerializer


class PrtgSensorProfileViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedViewSet):
    """Sensor profiles with their definitions nested, in order.

    ``starter/`` makes the starter profile on request (``{connection}``);
    ``kinds/`` lists the sensor kinds and their parameters for the editor.
    A profile a policy or "register all" uses cannot be deleted.
    """

    integration_keys = ("prtg",)
    queryset = PrtgSensorProfile.objects.prefetch_related("definitions").order_by("name")
    serializer_class = PrtgSensorProfileSerializer
    rbac_action_map = {"starter": "add", "kinds": "view"}

    def destroy(self, request, *args, **kwargs):
        profile = self.get_object()
        users = list(profile.policies.values_list("name", flat=True)[:3])
        if PrtgConnection.objects.filter(register_profile=profile).exists():
            users.append("Register all")
        if users:
            return Response(
                {"detail": f"In use by {', '.join(users)}. Pick another profile there first."},
                status=400,
            )
        return super().destroy(request, *args, **kwargs)

    @action(detail=False, methods=["get"])
    def kinds(self, request):
        return Response({"kinds": sk.catalog(), "intervals": list(sk.INTERVALS)})

    @action(detail=False, methods=["post"])
    def starter(self, request):
        """Make the starter profile for a connection: Ping, SNMP uptime,
        SNMP traffic on connected interfaces, HTTPS where a service listens
        on 443. An ordinary profile, edited like any other."""
        from .provision import make_starter

        conn = PrtgConnection.objects.filter(
            pk=request.data.get("connection"), tenant=_get_active_tenant(request)
        ).first()
        if conn is None:
            return Response({"detail": "Unknown connection."}, status=404)
        profile = make_starter(conn)
        return Response(self.get_serializer(profile).data, status=201)


class PrtgCredentialViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedViewSet):
    """Logins a sensor profile can place on a PRTG group or device. The
    secrets are write-only. One a profile or policy places cannot be
    deleted."""

    integration_keys = ("prtg",)
    queryset = PrtgCredential.objects.order_by("name")
    serializer_class = PrtgCredentialSerializer

    def destroy(self, request, *args, **kwargs):
        cred = self.get_object()
        users = [
            p.name for p in PrtgSensorProfile.objects.filter(connection=cred.connection_id)
            if any((e or {}).get("credential") == str(cred.id)
                   for e in (p.credential_placement or {}).values())
        ] + [
            p.name for p in PrtgPolicy.objects.filter(connection=cred.connection_id)
            if any((e or {}).get("credential") == str(cred.id)
                   for e in (p.credential_placement or {}).values())
        ]
        if users:
            return Response(
                {"detail": f"In use by {', '.join(users[:3])}. Pick another credential "
                           "there first."},
                status=400,
            )
        return super().destroy(request, *args, **kwargs)


def _connection(request, tenant):
    conn_id = (request.query_params.get("connection") or "").strip()
    qs = PrtgConnection.objects.filter(tenant=tenant)
    conn = qs.filter(pk=conn_id).first() if conn_id else qs.order_by("name").first()
    if conn is None:
        raise NotFound("Unknown connection.")
    return conn


def _gate(request):
    tenant = _get_active_tenant(request)
    if tenant is None or not integration_enabled(tenant, "prtg"):
        raise NotFound("Integration not enabled.")
    return tenant


class PrtgGroupsView(APIView):
    """PRTG's probes and groups for a connection - ``?connection=<id>`` -
    as the group pickers list them: ``{read_at, groups: [{objid, name, kind,
    path, probe, parent_id}], error}``. Served from what the last read kept;
    ``?refresh=1``, or a list older than one status interval, asks PRTG
    again. Needs view on PRTG policies."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from .client import PrtgError
        from .provision import read_groups

        tenant = _gate(request)
        if not rbac.has_action(request.user, tenant, "prtgpolicy", "view"):
            return Response({"detail": "You may not view PRTG policies."}, status=403)
        conn = _connection(request, tenant)
        now = timezone.now()
        stale = conn.groups_read_at is None or (
            (now - conn.groups_read_at).total_seconds() > conn.cache_seconds
        )
        error = ""
        if (stale or request.query_params.get("refresh") in ("1", "true")) and (
            conn.enabled and conn.api_key_set
        ):
            try:
                read_groups(conn, now=now)
            except PrtgError as exc:
                error = str(exc)[:300]
        return Response({
            "connection": str(conn.id), "read_at": conn.groups_read_at,
            "groups": conn.groups_cache or [], "error": error,
        })


class PrtgPlanView(APIView):
    """What PRTG has and would get for one device or VM - ``?device=<id>``
    or ``?virtual_machine=<id>``: one entry per connection of the tenant,
    with ``linked`` (in PRTG), ``managed`` (Danbyte created it),
    ``registration`` and ``planned`` - see :func:`prtg.provision.preview`.
    PRTG is not asked and nothing is written. Needs view on the object."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        from api.models import Device, VirtualMachine

        from .provision import preview

        tenant = _gate(request)
        device_id = (request.query_params.get("device") or "").strip()
        vm_id = (request.query_params.get("virtual_machine") or "").strip()
        if device_id:
            obj = rbac.restrict_queryset(
                Device.objects.filter(tenant=tenant), request.user, tenant, "device", "view",
            ).filter(id=device_id).first()
        elif vm_id:
            obj = rbac.restrict_queryset(
                VirtualMachine.objects.filter(tenant=tenant), request.user, tenant,
                "virtualmachine", "view",
            ).filter(id=vm_id).first()
        else:
            return Response({"detail": "device or virtual_machine is required."}, status=400)
        if obj is None:
            raise NotFound()
        conns = (
            PrtgConnection.objects.filter(tenant=tenant, enabled=True)
            .order_by("name")
        )
        return Response([preview(conn, obj) for conn in conns])
