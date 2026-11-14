"""Root causes on the Alerts page (#450): list, detail and acknowledge.

An incident is visible to whoever may view its root device (site-aware,
the device's own grant); the alerts it explains are listed through the
alert list's own scope, so a site-scoped viewer sees the incident's counts
but only the alerts on addresses they may view.
"""
from __future__ import annotations

from django.db.models import Q
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.views import _get_active_tenant

from .models import RootCauseIncident
from .serializers import AlertSerializer, RootCauseIncidentSerializer

_LIVE = [RootCauseIncident.OPEN, RootCauseIncident.RECOVERING]


def _incidents(request, tenant):
    from .views import _scope_device_keyed

    return _scope_device_keyed(
        request, tenant, RootCauseIncident.objects.filter(tenant=tenant)
    ).select_related("device", "acknowledged_by", "merged_into__device")


@extend_schema(
    summary="Root-cause incidents for the active tenant",
    tags=["monitoring"],
    request=None,
    parameters=[
        OpenApiParameter(name="status", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         enum=["open", "resolved", "all"],
                         description="open (default: open and recovering), "
                         "resolved, or all."),
        OpenApiParameter(name="q", type=OpenApiTypes.STR, location=OpenApiParameter.QUERY,
                         description="Root device name contains."),
        OpenApiParameter(name="device", type=OpenApiTypes.UUID,
                         location=OpenApiParameter.QUERY,
                         description="Incidents of this root device."),
    ],
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT,
                              description="``{counts, results}``."),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def root_causes_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"counts": {}, "results": []})
    base = _incidents(request, tenant)
    counts = {
        "open": base.filter(status__in=_LIVE).count(),
        "resolved": base.filter(status=RootCauseIncident.RESOLVED).count(),
    }
    qs = base
    status = request.query_params.get("status", "open")
    if status == "open":
        qs = qs.filter(status__in=_LIVE)
    elif status == "resolved":
        qs = qs.filter(status=RootCauseIncident.RESOLVED)
    q = (request.query_params.get("q") or "").strip()
    if q:
        qs = qs.filter(device__name__icontains=q)
    device = request.query_params.get("device")
    if device:
        qs = qs.filter(device_id=device)
    rows = list(qs.order_by("-opened_at")[:200])
    return Response({"counts": counts,
                     "results": RootCauseIncidentSerializer(rows, many=True).data})


@extend_schema(
    summary="One root-cause incident with the alerts it explains",
    tags=["monitoring"],
    request=None,
    responses=OpenApiResponse(response=OpenApiTypes.OBJECT,
                              description="``{incident, alerts, root_alerts}``."),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def root_cause_detail_view(request, incident_id):
    from .views import _alert_base, _annotate_silenced

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    inc = _incidents(request, tenant).filter(pk=incident_id).first()
    if inc is None:
        return Response({"detail": "Not found."}, status=404)
    related = ("target_ip", "template", "acknowledged_by", "root_cause__device")
    alerts = list(
        _alert_base(request, tenant).filter(root_cause=inc)
        .exclude(target_ip__assigned_device_id=inc.device_id)
        .select_related(*related).order_by("-opened_at")[:500]
    )
    root_alerts = list(
        _alert_base(request, tenant)
        .filter(target_ip__assigned_device_id=inc.device_id)
        .filter(Q(status="firing") | Q(resolved_at__gte=inc.opened_at))
        .select_related(*related).order_by("-opened_at")[:50]
    )
    _annotate_silenced(tenant, alerts + root_alerts)
    return Response({
        "incident": RootCauseIncidentSerializer(inc).data,
        "alerts": AlertSerializer(alerts, many=True).data,
        "root_alerts": AlertSerializer(root_alerts, many=True).data,
    })


@extend_schema(
    summary="Acknowledge a root-cause incident and its root's alerts",
    tags=["monitoring"],
    request=None,
    parameters=[
        OpenApiParameter(name="action", type=OpenApiTypes.STR,
                         location=OpenApiParameter.QUERY,
                         description="Pass 'unack' to clear the acknowledgement."),
    ],
    responses=RootCauseIncidentSerializer,
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def root_cause_ack_view(request, incident_id):
    """Acknowledging an incident acknowledges the root's firing alerts the
    caller may see, through the one acknowledgement path."""
    from .alerts import set_acknowledged
    from .views import _alert_base

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant."}, status=403)
    inc = _incidents(request, tenant).filter(pk=incident_id).first()
    if inc is None:
        return Response({"detail": "Not found."}, status=404)
    ack = request.query_params.get("action") != "unack"
    note = str((request.data or {}).get("note", "") or "")[:255]
    if ack:
        inc.acknowledged_at, inc.acknowledged_by, inc.ack_note = (
            timezone.now(), request.user, note)
    else:
        inc.acknowledged_at, inc.acknowledged_by, inc.ack_note = None, None, ""
    inc.save(update_fields=["acknowledged_at", "acknowledged_by", "ack_note", "updated_at"])
    for alert in (
        _alert_base(request, tenant)
        .filter(target_ip__assigned_device_id=inc.device_id, status="firing")
        .select_related("target_ip", "template")
    ):
        if (alert.acknowledged_at is not None) != ack:
            set_acknowledged(alert, ack, actor=request.user, note=note)
    return Response(RootCauseIncidentSerializer(inc).data)
