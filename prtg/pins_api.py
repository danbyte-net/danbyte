"""``/api/prtg/sensor-pins/``: channels pinned to a device's or VM's Overview.

``GET ?device=<id>`` or ``?virtual_machine=<id>`` lists an object's pins in
order, each with its sensor's summary; ``POST {sensor, channel_id, display}``
pins a channel (the device or VM is the sensor's own); ``DELETE <id>/``
unpins; ``POST reorder/ {device | virtual_machine, order: [pin ids]}`` sets
the order.

Every write needs ``prtgsensorpin.change`` - a pin is a view preference on
the object, not a record of its own - and every call needs view on the
device or VM. Site scope follows the parent, as for the sensors.
"""
from __future__ import annotations

import re

from django.db import IntegrityError, transaction
from django.db.models import Max, Q
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from integrations.toggles import IntegrationToggleMixin

from . import status as st
from .models import PrtgSensor
from .pins import MAX_PINS, PrtgSensorPin
from .viewsets import _visible_devices, _visible_vms

_CHANNEL_ID = re.compile(r"^-?\d{1,15}$")


class PrtgSensorPinSerializer(serializers.ModelSerializer):
    sensor = serializers.PrimaryKeyRelatedField(queryset=PrtgSensor.objects.none())
    device = serializers.SerializerMethodField()
    virtual_machine = serializers.SerializerMethodField()
    #: Enough of the sensor to draw the tile's header without another call.
    sensor_info = serializers.SerializerMethodField()

    class Meta:
        model = PrtgSensorPin
        fields = [
            "id", "sensor", "channel_id", "display", "position", "device",
            "virtual_machine", "sensor_info", "created_at",
        ]
        read_only_fields = ["id", "position", "device", "virtual_machine", "created_at"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request else None
        if tenant is not None:
            self.fields["sensor"].queryset = PrtgSensor.objects.filter(tenant=tenant)

    @staticmethod
    def _ref(obj):
        return {"id": str(obj.id), "name": obj.name} if obj else None

    def get_device(self, obj) -> dict | None:
        return self._ref(obj.device)

    def get_virtual_machine(self, obj) -> dict | None:
        return self._ref(obj.virtual_machine)

    def get_sensor_info(self, obj) -> dict:
        s = obj.sensor
        return {
            "name": s.name,
            "kind_label": s.kind_label or s.kind,
            "state": s.state or "unknown",
            "status": st.label(s.status_raw) if s.status_raw is not None else "",
            "paused": s.paused,
            "url": s.connection.sensor_url(s.objid),
        }

    def validate_channel_id(self, value):
        value = (value or "").strip()
        if not _CHANNEL_ID.match(value):
            raise ValidationError("A PRTG channel id, like 0, 2 or -4.")
        return value

    def validate(self, attrs):
        request = self.context["request"]
        tenant = _get_active_tenant(request)
        sensor = attrs["sensor"]
        # The device or VM is the sensor's; one the caller cannot see is a
        # sensor they cannot pin.
        if sensor.device_id:
            visible = _visible_devices(request, tenant).filter(id=sensor.device_id).exists()
        else:
            visible = _visible_vms(request, tenant).filter(id=sensor.virtual_machine_id).exists()
        if not visible:
            raise ValidationError({"sensor": "Not found."})
        for field in ("device", "virtual_machine"):
            asked = request.data.get(field) if hasattr(request.data, "get") else None
            if asked and str(asked) != str(getattr(sensor, f"{field}_id") or ""):
                raise ValidationError({field: "The sensor belongs to another object."})
        parent = {"device_id": sensor.device_id, "virtual_machine_id": sensor.virtual_machine_id}
        pins = PrtgSensorPin.objects.filter(tenant=tenant, **parent)
        if pins.filter(sensor=sensor, channel_id=attrs["channel_id"]).exists():
            raise ValidationError({"channel_id": "This channel is already pinned."})
        if pins.count() >= MAX_PINS:
            raise ValidationError({"sensor": f"At most {MAX_PINS} pins on one object."})
        attrs.update(parent)
        return attrs


class PrtgSensorPinViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("prtg",)
    http_method_names = ["get", "post", "delete", "head", "options"]
    queryset = PrtgSensorPin.objects.select_related(
        "sensor", "sensor__connection", "device", "virtual_machine"
    )
    serializer_class = PrtgSensorPinSerializer
    # Pinning is arranging what the object's page shows: one grant for all of it.
    rbac_action_map = {"create": "change", "destroy": "change", "reorder": "change"}

    def get_queryset(self):
        qs = super().get_queryset()
        request = self.request
        tenant = _get_active_tenant(request)
        if tenant is None:
            return qs.none()
        qs = qs.filter(
            Q(device__in=_visible_devices(request, tenant).values("id"))
            | Q(virtual_machine__in=_visible_vms(request, tenant).values("id"))
        )
        p = request.query_params
        if p.get("device"):
            qs = qs.filter(device_id=p["device"])
        if p.get("virtual_machine"):
            qs = qs.filter(virtual_machine_id=p["virtual_machine"])
        return qs.order_by("position", "created_at")

    def create(self, request, *args, **kwargs):
        # The shared wrapper re-checks a create against ``add``; a pin is
        # gated on ``change``, so re-check the saved row against that.
        with transaction.atomic():
            try:
                response = super(TenantScopedViewSet, self).create(request, *args, **kwargs)
            except IntegrityError:
                raise ValidationError({"channel_id": "This channel is already pinned."}) from None
            self._assert_write_in_site_scope(response, "change")
        return response

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        data = serializer.validated_data
        top = PrtgSensorPin.objects.filter(
            tenant=tenant, device_id=data["device_id"],
            virtual_machine_id=data["virtual_machine_id"],
        ).aggregate(m=Max("position"))["m"]
        serializer.save(tenant=tenant, position=0 if top is None else top + 1)

    @action(detail=False, methods=["post"])
    def reorder(self, request):
        """``{device | virtual_machine, order: [pin ids]}``: the pins in that
        order. Every id must be one of the object's pins."""
        device = request.data.get("device")
        vm = request.data.get("virtual_machine")
        order = request.data.get("order")
        if bool(device) == bool(vm):
            raise ValidationError({"device": "Give a device or a virtual machine."})
        if not isinstance(order, list) or not all(isinstance(i, str) for i in order):
            raise ValidationError({"order": "A list of pin ids."})
        pins = self.get_queryset().filter(**({"device_id": device} if device else
                                             {"virtual_machine_id": vm}))
        by_id = {str(p.id): p for p in pins}
        if len(set(order)) != len(order) or set(order) != set(by_id):
            raise ValidationError({"order": "Every pin of the object, once each."})
        with transaction.atomic():
            for i, pid in enumerate(order):
                pin = by_id[pid]
                if pin.position != i:
                    pin.position = i
                    pin.save(update_fields=["position", "updated_at"])
        return Response(self.get_serializer(
            sorted(by_id.values(), key=lambda p: p.position), many=True
        ).data)
