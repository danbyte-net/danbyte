"""The PRTG API surface.

Every viewset carries ``integration_keys = ("prtg",)`` so the whole surface
404s while the tenant switch is off - a disabled integration is invisible, not
merely inert. The push receiver (:mod:`prtg.hook`) is the one exception: it
has no session and checks the switch itself.
"""
from __future__ import annotations

import uuid

from django.db.models import Case, Count, IntegerField, Max, Q, Value, When
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from api.models import Device, IPAddress, VirtualMachine
from api.views import _get_active_tenant
from api.viewsets import TenantScopedReadViewSet, TenantScopedViewSet
from auth_api import rbac
from integrations.toggles import IntegrationToggleMixin, integration_enabled
from monitoring.external.queue import ChangeQueueMixin

from . import status as st
from .models import PrtgAdoptionRule, PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgSensor
from .serializers import (
    PrtgAdoptionRuleSerializer,
    PrtgChangeSerializer,
    PrtgConnectionSerializer,
    PrtgDefaultsSerializer,
    PrtgDeviceLinkSerializer,
    PrtgSensorSerializer,
)

_TestResult = inline_serializer("PrtgTestResult", fields={
    "ok": serializers.BooleanField(),
    "detail": serializers.CharField(),
    "version": serializers.CharField(),
    "probes": serializers.IntegerField(allow_null=True),
    "sensors": serializers.IntegerField(allow_null=True),
    "v2_available": serializers.BooleanField(allow_null=True),
    "v2_detail": serializers.CharField(),
})

_HookToken = inline_serializer("PrtgHookToken", fields={
    "token": serializers.CharField(),
    "path": serializers.CharField(),
})


class _ByConnection:
    """``?connection=<id>`` narrows a list to one connection."""

    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection") if self.request else None
        return qs.filter(connection_id=conn) if conn else qs


class PrtgConnectionViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("prtg",)
    queryset = PrtgConnection.objects.select_related(
        "adopt_site", "adopt_role", "adopt_device_type"
    ).order_by("name")
    serializer_class = PrtgConnectionSerializer

    @action(detail=False, methods=["get"])
    def defaults(self, request):
        """Status codes, their default states and the states they may map
        onto, so the form hard-codes neither PRTG's codes nor Danbyte's."""
        return Response(PrtgDefaultsSerializer.payload(_get_active_tenant(request)))

    @extend_schema(request=None, responses={200: _TestResult, 502: _TestResult})
    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Reach PRTG and describe it: version, probes, sensors, API v2.
        Records what it learned on the connection."""
        from .connection import test_connection

        result = test_connection(self.get_object())
        return Response(result, status=200 if result["ok"] else 502)

    @action(detail=True, methods=["post"], url_path="status-now")
    def status_now(self, request, pk=None):
        """Read PRTG now: devices, sensors, links, roll-ups. The same pass the
        beat runs, so the button and the timer cannot drift apart."""
        from .client import PrtgError
        from .reader import _stamp, read_status

        conn = self.get_object()
        if not conn.api_key_set:
            return Response({"detail": "No API key is set."}, status=400)
        now = timezone.now()
        try:
            counts = read_status(conn, now)
        except PrtgError as exc:
            _stamp(conn, now, error=str(exc))
            return Response({"detail": str(exc)[:300]}, status=502)
        _stamp(conn, now, summary=counts)
        return Response(counts)

    @action(detail=True, methods=["post"], url_path="maintenance-now")
    def maintenance_now(self, request, pk=None):
        """Reconcile the maintenance pauses now - the pass the beat and a
        changed window run."""
        from .client import PrtgError
        from .maintenance import reconcile

        conn = self.get_object()
        if not (conn.sync_maintenance and conn.api_key_set):
            return Response({"detail": "Maintenance sync is off."}, status=400)
        try:
            counts = reconcile(conn)
        except PrtgError as exc:
            return Response({"detail": str(exc)[:300]}, status=502)
        if counts.get("error"):
            return Response({"detail": counts["error"]}, status=502)
        return Response(counts)

    @action(detail=True, methods=["post"], url_path="plan-now")
    def plan_now(self, request, pk=None):
        """Work out what PRTG should have now and refresh the planned
        changes in the queue. Reads PRTG's devices and groups; writes
        nothing to PRTG."""
        from .client import PrtgError
        from .provision import plan, stamp

        conn = self.get_object()
        if not conn.api_key_set:
            return Response({"detail": "No API key is set."}, status=400)
        now = timezone.now()
        try:
            counts = plan(conn, now=now)
        except PrtgError as exc:
            stamp(conn, now, {"error": str(exc)[:300]})
            return Response({"detail": str(exc)[:300]}, status=502)
        stamp(conn, now, counts)
        return Response(counts)

    @extend_schema(request=None, responses={200: _HookToken})
    @action(detail=True, methods=["post"], url_path="rotate-hook-token")
    def rotate_hook_token(self, request, pk=None):
        """Make a new push token and return it - once. Only its hash is kept,
        so the old token stops working and the new one cannot be read back."""
        from .hook import new_token

        conn = self.get_object()
        token = new_token(conn)
        return Response({"token": token, "path": f"/api/prtg/hook/{token}/"})


class PrtgDeviceLinkViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedViewSet):
    """Read-only: a link is made by matching. Deleting one says "that pairing
    is wrong"; the next pass matches the device from scratch."""

    integration_keys = ("prtg",)
    http_method_names = ["get", "delete", "head", "options"]
    queryset = PrtgDeviceLink.objects.select_related(
        "device", "virtual_machine", "connection"
    ).order_by("name")
    serializer_class = PrtgDeviceLinkSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params if self.request else {}
        if params.get("device"):
            qs = qs.filter(device_id=params["device"])
        if params.get("virtual_machine"):
            qs = qs.filter(virtual_machine_id=params["virtual_machine"])
        return qs


class PrtgChangeViewSet(
    IntegrationToggleMixin, ChangeQueueMixin, TenantScopedViewSet
):
    """The review queue: apply, dismiss, restore, apply-all (the shared
    actions). Proposals come from the status pass, never from here."""

    integration_keys = ("prtg",)
    http_method_names = ["get", "post", "head", "options"]
    queryset = (
        PrtgChange.objects.select_related("device", "virtual_machine", "connection")
        .order_by("kind", "-created_at")
    )
    serializer_class = PrtgChangeSerializer
    change_model = PrtgChange
    connection_model = PrtgConnection

    def apply_change(self, change) -> str:
        from .adopt import apply_adoption
        from .provision import NOT_YET
        from .reader import apply_link

        if change.planned:
            # Planned writes are shown so the operator sees what Danbyte
            # would do to PRTG; nothing can write them yet.
            raise ValueError(NOT_YET)
        if change.kind == PrtgChange.LINK:
            return apply_link(change)
        if change.kind == PrtgChange.ADOPT:
            return apply_adoption(change)
        raise ValueError("This proposal needs a decision, not an apply.")

    def apply_pending(self, conn) -> dict:
        """Every applicable proposal: links, and adoptions whose placement
        is complete. An adoption still missing a default waits."""
        from monitoring.external.adoption import applicable

        applied, failed = 0, []
        for change in PrtgChange.applicable(conn).select_related(
            "device", "virtual_machine", "connection", "connection__tenant"
        ):
            if change.planned:
                continue
            if change.kind == PrtgChange.ADOPT and not applicable(change.detail or {}):
                continue
            try:
                self.apply_change(change)
                applied += 1
            except ValueError as exc:
                failed.append({"id": str(change.id), "detail": str(exc)})
        return {"applied": applied, "failed": failed}

    def remote_errors(self) -> tuple:
        from .client import PrtgError

        return (PrtgError,)


class PrtgAdoptionRuleViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedViewSet):
    """Where an adopted PRTG device lands. First match wins in weight order."""

    integration_keys = ("prtg",)
    queryset = (
        PrtgAdoptionRule.objects.select_related("site", "role", "device_type")
        .order_by("weight", "pattern")
    )
    serializer_class = PrtgAdoptionRuleSerializer


def _visible_devices(request, tenant):
    return rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant), request.user, tenant, "device", "view",
    )


def _visible_vms(request, tenant):
    return rbac.restrict_queryset(
        VirtualMachine.objects.filter(tenant=tenant), request.user, tenant,
        "virtualmachine", "view",
    )


def _parent_visible(request, tenant, obj) -> bool:
    """Whether the caller may view the device or VM a link or sensor is for."""
    if obj.device_id:
        return _visible_devices(request, tenant).filter(id=obj.device_id).exists()
    return _visible_vms(request, tenant).filter(id=obj.virtual_machine_id).exists()


#: Worst first, for the alarms ordering.
_STATE_RANK = Case(
    When(state="down", then=Value(0)),
    When(state="degraded", then=Value(1)),
    When(state="unknown", then=Value(2)),
    When(state="up", then=Value(3)),
    default=Value(4),
    output_field=IntegerField(),
)

_SENSOR_ORDERINGS = {
    "name": ("name", "objid"),
    "-name": ("-name", "objid"),
    # Worst first, newest problem first within a state.
    "alarms": (
        "_rank", Coalesce("last_down_at", "last_check_at").desc(nulls_last=True), "name",
    ),
}


class PrtgSensorViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedReadViewSet):
    """Every imported sensor. Read-only: the rows are PRTG's.

    Filters: ``connection``, ``device``, ``virtual_machine``, the object a
    sensor watches (``ip_address``, ``interface`` - a device or VM interface -
    and ``service``), ``state``
    (comma-separated; ``paused`` names the paused sensors whatever their
    state), ``kind`` (raw or display name), ``probe``, ``group``,
    ``alarms=1`` (down and degraded only, not paused), ``hide_paused=1``,
    ``search`` (sensor, device, VM, message, PRTG device, object id) and
    ``ordering`` (``name``, ``-name``, ``alarms``).

    ``channels/`` and ``history/`` read PRTG on demand and need view on the
    device or VM as well; ``summary/`` counts per state in one query.
    """

    integration_keys = ("prtg",)
    queryset = PrtgSensor.objects.select_related(
        "device", "virtual_machine", "connection", "link",
        "ip_address", "interface", "vm_interface", "service",
    )
    serializer_class = PrtgSensorSerializer

    def filter_sensors(self, qs):
        p = self.request.query_params if self.request else {}
        for key in ("ip_address", "interface", "service"):
            if p.get(key):
                try:
                    uuid.UUID(str(p[key]))
                except ValueError:
                    raise ValidationError({key: "Not an id."}) from None
        if p.get("ip_address"):
            qs = qs.filter(ip_address_id=p["ip_address"])
        if p.get("interface"):
            # A device interface or a VM interface: the ids never collide.
            qs = qs.filter(Q(interface_id=p["interface"]) | Q(vm_interface_id=p["interface"]))
        if p.get("service"):
            qs = qs.filter(service_id=p["service"])
        if p.get("device"):
            qs = qs.filter(device_id=p["device"])
        if p.get("virtual_machine"):
            qs = qs.filter(virtual_machine_id=p["virtual_machine"])
        if p.get("state"):
            wanted = {v.strip() for v in p["state"].split(",") if v.strip()}
            q = Q(state__in=wanted - {"paused"}) & ~Q(status_raw__in=st.PAUSED)
            if "paused" in wanted:
                q |= Q(status_raw__in=st.PAUSED)
            qs = qs.filter(q)
        if p.get("kind"):
            qs = qs.filter(Q(kind__iexact=p["kind"]) | Q(kind_label__iexact=p["kind"]))
        if p.get("probe"):
            qs = qs.filter(probe_name=p["probe"])
        if p.get("group"):
            qs = qs.filter(group_path=p["group"])
        if p.get("alarms") in ("1", "true"):
            qs = qs.filter(state__in=("down", "degraded")).exclude(status_raw__in=st.PAUSED)
        if p.get("hide_paused") in ("1", "true"):
            qs = qs.exclude(status_raw__in=st.PAUSED)
        term = (p.get("search") or "").strip()
        if term:
            qs = qs.filter(
                Q(name__icontains=term) | Q(device__name__icontains=term)
                | Q(virtual_machine__name__icontains=term) | Q(message__icontains=term)
                | Q(link__name__icontains=term) | Q(kind_label__icontains=term)
                | Q(objid=term)
            )
        return qs

    def get_queryset(self):
        qs = super().get_queryset()
        if self.action in ("list", "summary"):
            qs = self.filter_sensors(qs)
        ordering = (self.request.query_params.get("ordering") if self.request else "") or "name"
        qs = qs.annotate(_rank=_STATE_RANK)
        return qs.order_by(*_SENSOR_ORDERINGS.get(ordering, _SENSOR_ORDERINGS["name"]))

    def _sensor_for_read(self, request):
        sensor = self.get_object()
        tenant = _get_active_tenant(request)
        if not _parent_visible(request, tenant, sensor):
            raise NotFound()
        if not sensor.connection.enabled or not sensor.connection.api_key_set:
            raise NotFound("The PRTG connection is off.")
        return sensor

    @action(detail=False, methods=["get"])
    def summary(self, request):
        """Counts per state for a status strip, in one query: ``down``,
        ``degraded``, ``up``, ``unknown`` over sensors that are not paused,
        ``paused``, ``acknowledged``, ``total``, and ``read_at`` (the latest
        read that saw one of them). Takes the list's filters."""
        qs = self.get_queryset().order_by()
        live = ~Q(status_raw__in=st.PAUSED)
        agg = qs.aggregate(
            total=Count("id"),
            paused=Count("id", filter=Q(status_raw__in=st.PAUSED)),
            acknowledged=Count("id", filter=Q(status_raw=st.DOWN_ACKNOWLEDGED)),
            down=Count("id", filter=live & Q(state="down")),
            degraded=Count("id", filter=live & Q(state="degraded")),
            up=Count("id", filter=live & Q(state="up")),
            unknown=Count("id", filter=live & ~Q(state__in=("down", "degraded", "up"))),
            read_at=Max("last_seen_at"),
        )
        return Response(agg)

    @action(detail=True, methods=["get"])
    def channels(self, request, pk=None):
        """The sensor's channels, read from PRTG at most once per status
        interval (see :mod:`prtg.channels`)."""
        from .channels import read_channels
        from .client import PrtgError

        sensor = self._sensor_for_read(request)
        try:
            return Response(read_channels(sensor))
        except PrtgError as exc:
            return Response({"detail": str(exc)[:300]}, status=502)

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        """``?range=1h|24h|7d`` (1h by default) and optional ``channel=<id>``:
        ``{range, avg, fetched_at, stale, channels: [{id, name, unit, points:
        [{t, v}]}]}``, read from PRTG at most once per range and interval."""
        from .channels import RANGES, read_history
        from .client import PrtgError

        rng = request.query_params.get("range") or "1h"
        if rng not in RANGES:
            return Response({"range": f"One of {', '.join(RANGES)}."}, status=400)
        sensor = self._sensor_for_read(request)
        try:
            data = read_history(sensor, rng)
        except PrtgError as exc:
            return Response({"detail": str(exc)[:300]}, status=502)
        wanted = request.query_params.get("channel")
        channels = [
            {"id": cid, **entry}
            for cid, entry in (data.get("series") or {}).items()
            if wanted in (None, "", cid)
        ]
        return Response({
            "range": data.get("range", rng), "avg": data.get("avg"),
            "fetched_at": data.get("fetched_at"), "stale": bool(data.get("stale")),
            "channels": channels,
        })


class PrtgDeviceStatusView(APIView):
    """What PRTG says about a device - ``?device=<id>`` or ``?ip=<id>``.

    One entry per link. Read access is the device's own: a viewer who may see
    the device may see what PRTG says about it.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        tenant = _get_active_tenant(request)
        if tenant is None or not integration_enabled(tenant, "prtg"):
            raise NotFound("Integration not enabled.")
        device_id = (request.query_params.get("device") or "").strip()
        vm_id = (request.query_params.get("virtual_machine") or "").strip()
        ip_id = (request.query_params.get("ip") or "").strip()
        if vm_id:
            vm = _visible_vms(request, tenant).filter(id=vm_id).first()
            if vm is None:
                return Response([])
            return Response(self._entries(
                PrtgDeviceLink.objects.filter(virtual_machine=vm, connection__enabled=True)
            ))
        if ip_id and not device_id:
            ip = rbac.restrict_queryset(
                IPAddress.objects.filter(tenant=tenant, id=ip_id),
                request.user, tenant, "ipaddress", "view",
            ).first()
            if ip is None or not ip.assigned_device_id:
                return Response([])
            device_id = str(ip.assigned_device_id)
        if not device_id:
            return Response(
                {"detail": "device, virtual_machine or ip is required."}, status=400
            )
        device = _visible_devices(request, tenant).filter(id=device_id).first()
        if device is None:
            return Response([])
        return Response(self._entries(
            PrtgDeviceLink.objects.filter(device=device, connection__enabled=True)
        ))

    @staticmethod
    def _entries(links) -> list:
        from .reader import problems_for

        links = links.select_related("connection").order_by("connection__name")
        return [
            {
                "connection": {"id": str(lk.connection_id), "name": lk.connection.name,
                               "url": lk.connection.url},
                "device": {"objid": lk.objid, "name": lk.name, "host": lk.host,
                           "url": lk.connection.device_url(lk.objid)},
                "link": {"matched_by": lk.matched_by, "tagged": lk.tagged},
                "status": {"state": lk.state or None, "counts": lk.sensor_counts,
                           "problems": problems_for(lk), "read_at": lk.status_read_at},
            }
            for lk in links
        ]


class PrtgDeviceStatesView(APIView):
    """Every linked device's roll-up, for the device list's PRTG column:
    ``{device id: {state, down, warning, url, name}}``. Only devices the
    caller may view; one connection per device (the first by name).
    :class:`PrtgVmStatesView` is the same for virtual machines."""

    permission_classes = [IsAuthenticated]
    parent_field = "device_id"

    def visible(self, request, tenant):
        return _visible_devices(request, tenant)

    def get(self, request):
        tenant = _get_active_tenant(request)
        if tenant is None or not integration_enabled(tenant, "prtg"):
            raise NotFound("Integration not enabled.")
        visible = self.visible(request, tenant).values("id")
        out: dict = {}
        links = (
            PrtgDeviceLink.objects.filter(
                tenant=tenant, connection__enabled=True,
                **{f"{self.parent_field}__in": visible},
            ).select_related("connection").order_by("connection__name")
        )
        for lk in links:
            key = str(getattr(lk, self.parent_field))
            if key in out:
                continue
            counts = lk.sensor_counts or {}
            out[key] = {
                "state": lk.state or None,
                "down": int(counts.get("down", 0) or 0),
                "warning": int(counts.get("degraded", 0) or 0),
                "name": lk.name,
                "url": lk.connection.device_url(lk.objid),
            }
        return Response(out)


class PrtgVmStatesView(PrtgDeviceStatesView):
    """``{vm id: {state, down, warning, url, name}}`` for the VM list."""

    parent_field = "virtual_machine_id"

    def visible(self, request, tenant):
        return _visible_vms(request, tenant)
