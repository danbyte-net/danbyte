"""``/api/prtg/sensor-pins/``: sensors and channels pinned to an object's
Overview - the sensor's device or VM, or the IP address, interface (device or
VM) or service the sensor watches.

``GET ?device=<id>`` (or ``virtual_machine``, ``ip_address``, ``interface``,
``vm_interface``, ``service``) lists an object's pins in order, each with its
sensor's summary. ``POST {sensor, channel_id, display}`` pins a channel and
``POST {sensor}`` without a channel pins the whole sensor; with no object
named the pin goes on the sensor's own device or VM, as before. Naming one -
``ip_address: <id>`` and so on, or ``parent: {kind, id}`` - pins it there,
and only a sensor linked to that object may be pinned on it. ``DELETE
<id>/`` unpins; ``POST reorder/ {<parent field>, order: [pin ids]}`` sets the
order of one object's pins.

Every write needs ``prtgsensorpin.change`` - a pin is a view preference on
the object, not a record of its own - and every call needs view on the pinned
object and on the sensor's device or VM. Site scope follows the pinned
object.
"""
from __future__ import annotations

import re
import uuid

from django.db import IntegrityError, transaction
from django.db.models import Max, Q
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from api.models import Interface, IPAddress, Service, VMInterface
from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api import rbac
from integrations.toggles import IntegrationToggleMixin

from . import status as st
from .models import PrtgSensor
from .pins import MAX_PINS, PARENT_FIELDS, PrtgSensorPin
from .viewsets import _visible_devices, _visible_vms

_CHANNEL_ID = re.compile(r"^-?\d{1,15}$")

#: The objects a sensor watches, and how a refusal names them.
_WATCHED = {
    "ip_address": "address",
    "interface": "interface",
    "vm_interface": "interface",
    "service": "service",
}


def _already(channel: str) -> str:
    return "This channel is already pinned." if channel else "This sensor is already pinned."


def _visible(request, tenant, field: str):
    """The caller's viewable objects of one parent kind, in the tenant."""
    if field == "device":
        return _visible_devices(request, tenant)
    if field == "virtual_machine":
        return _visible_vms(request, tenant)
    qs, slug = {
        "ip_address": (IPAddress.objects.filter(tenant=tenant), "ipaddress"),
        "interface": (Interface.objects.filter(device__tenant=tenant), "interface"),
        "vm_interface": (VMInterface.objects.filter(vm__tenant=tenant), "vminterface"),
        "service": (Service.objects.filter(tenant=tenant), "service"),
    }[field]
    return rbac.restrict_queryset(qs, request.user, tenant, slug, "view")


def _parent_asked(data) -> tuple[str, str] | None:
    """The object a request names - ``parent: {kind, id}`` or one parent
    field - as ``(field, id)``; ``None`` when it names none."""
    if not hasattr(data, "get"):
        return None
    asked = []
    parent = data.get("parent")
    if parent is not None:
        if not isinstance(parent, dict):
            raise ValidationError({"parent": "An object: {kind, id}."})
        kind = parent.get("kind")
        if kind not in PARENT_FIELDS:
            raise ValidationError({"parent": f"Kind is one of {', '.join(PARENT_FIELDS)}."})
        asked.append((kind, parent.get("id")))
    asked += [(f, data.get(f)) for f in PARENT_FIELDS if data.get(f)]
    if not asked:
        return None
    if len({f for f, _ in asked}) > 1:
        raise ValidationError({"parent": "Name one object to pin on."})
    field, value = asked[0]
    try:
        return field, str(uuid.UUID(str(value)))
    except ValueError:
        raise ValidationError({field: "Not an id."}) from None


class PrtgSensorPinSerializer(serializers.ModelSerializer):
    sensor = serializers.PrimaryKeyRelatedField(queryset=PrtgSensor.objects.none())
    #: Blank (or left out) pins the whole sensor.
    channel_id = serializers.CharField(
        max_length=16, required=False, allow_blank=True, default="",
    )
    device = serializers.SerializerMethodField()
    virtual_machine = serializers.SerializerMethodField()
    ip_address = serializers.SerializerMethodField()
    interface = serializers.SerializerMethodField()
    vm_interface = serializers.SerializerMethodField()
    service = serializers.SerializerMethodField()
    #: Enough of the sensor to draw the tile's header without another call.
    sensor_info = serializers.SerializerMethodField()

    class Meta:
        model = PrtgSensorPin
        fields = [
            "id", "sensor", "channel_id", "display", "position", *PARENT_FIELDS,
            "sensor_info", "created_at",
        ]
        read_only_fields = ["id", "position", *PARENT_FIELDS, "created_at"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request else None
        if tenant is not None:
            self.fields["sensor"].queryset = PrtgSensor.objects.filter(tenant=tenant)

    @staticmethod
    def _ref(obj):
        if obj is None:
            return None
        name = getattr(obj, "name", None) or getattr(obj, "ip_address", None) or str(obj)
        return {"id": str(obj.id), "name": str(name)}

    def get_device(self, obj) -> dict | None:
        return self._ref(obj.device)

    def get_virtual_machine(self, obj) -> dict | None:
        return self._ref(obj.virtual_machine)

    def get_ip_address(self, obj) -> dict | None:
        return self._ref(obj.ip_address)

    def get_interface(self, obj) -> dict | None:
        return self._ref(obj.interface)

    def get_vm_interface(self, obj) -> dict | None:
        return self._ref(obj.vm_interface)

    def get_service(self, obj) -> dict | None:
        return self._ref(obj.service)

    def get_sensor_info(self, obj) -> dict:
        s = obj.sensor
        return {
            "name": s.name,
            "kind_label": s.kind_label or s.kind,
            "state": s.state or "unknown",
            "status": st.label(s.status_raw) if s.status_raw is not None else "",
            "paused": s.paused,
            "url": s.connection.sensor_url(s.objid),
            # What a whole-sensor tile shows before the channels are read.
            "last_value": s.last_value,
            "last_check_at": s.last_check_at.isoformat() if s.last_check_at else None,
        }

    def validate_channel_id(self, value):
        value = (value or "").strip()
        if value and not _CHANNEL_ID.match(value):
            raise ValidationError("A PRTG channel id, like 0, 2 or -4.")
        return value

    def validate(self, attrs):
        request = self.context["request"]
        tenant = _get_active_tenant(request)
        sensor = attrs["sensor"]
        # The device or VM is the sensor's; one the caller cannot see is a
        # sensor they cannot pin (its tile reads the sensor's channels).
        owner = "device" if sensor.device_id else "virtual_machine"
        owner_id = getattr(sensor, f"{owner}_id")
        if not owner_id or not _visible(request, tenant, owner).filter(id=owner_id).exists():
            raise ValidationError({"sensor": "Not found."})
        asked = _parent_asked(request.data)
        if asked is None:
            field, parent_id = owner, str(owner_id)
        else:
            field, parent_id = asked
            linked = str(getattr(sensor, f"{field}_id") or "")
            if linked != parent_id:
                if field in _WATCHED:
                    raise ValidationError({
                        field: f"This sensor does not watch this {_WATCHED[field]}; "
                        "pin it on the device or VM instead."
                    })
                raise ValidationError({field: "The sensor belongs to another object."})
            if not _visible(request, tenant, field).filter(id=parent_id).exists():
                raise ValidationError({field: "Not found."})
        parent = {f"{f}_id": (parent_id if f == field else None) for f in PARENT_FIELDS}
        pins = PrtgSensorPin.objects.filter(tenant=tenant, **{f"{field}_id": parent_id})
        channel = attrs.get("channel_id", "")
        if pins.filter(sensor=sensor, channel_id=channel).exists():
            raise ValidationError({"channel_id": _already(channel)})
        if pins.count() >= MAX_PINS:
            raise ValidationError({"sensor": f"At most {MAX_PINS} pins on one object."})
        attrs.update(parent)
        attrs["channel_id"] = channel
        if not channel:
            # A sensor tile draws its primary value; there is nothing to choose.
            attrs["display"] = PrtgSensorPin.AUTO
        return attrs


class PrtgSensorPinViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("prtg",)
    http_method_names = ["get", "post", "delete", "head", "options"]
    queryset = PrtgSensorPin.objects.select_related(
        "sensor", "sensor__connection", "device", "virtual_machine", "ip_address",
        "interface", "vm_interface", "service",
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
        p = request.query_params
        wanted = [f for f in PARENT_FIELDS if p.get(f)]
        for f in wanted:
            try:
                uuid.UUID(str(p[f]))
            except ValueError:
                raise ValidationError({f: "Not an id."}) from None
            qs = qs.filter(**{f"{f}_id": p[f]})
        # View on the pinned object, and on the sensor's device or VM.
        on = Q()
        for f in wanted or PARENT_FIELDS:
            on |= Q(**{f"{f}__in": _visible(request, tenant, f).values("id")})
        qs = qs.filter(on).filter(
            Q(sensor__device__in=_visible_devices(request, tenant).values("id"))
            | Q(sensor__virtual_machine__in=_visible_vms(request, tenant).values("id"))
        )
        return qs.order_by("position", "created_at")

    def create(self, request, *args, **kwargs):
        # The shared wrapper re-checks a create against ``add``; a pin is
        # gated on ``change``, so re-check the saved row against that.
        with transaction.atomic():
            try:
                response = super(TenantScopedViewSet, self).create(request, *args, **kwargs)
            except IntegrityError:
                channel = (request.data.get("channel_id") or "").strip() if hasattr(
                    request.data, "get") else ""
                raise ValidationError({"channel_id": _already(channel)}) from None
            self._assert_write_in_site_scope(response, "change")
        return response

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        data = serializer.validated_data
        parent = {f"{f}_id": data[f"{f}_id"] for f in PARENT_FIELDS}
        top = PrtgSensorPin.objects.filter(tenant=tenant, **parent).aggregate(
            m=Max("position"))["m"]
        serializer.save(tenant=tenant, position=0 if top is None else top + 1)

    @action(detail=False, methods=["post"])
    def reorder(self, request):
        """``{<parent field>, order: [pin ids]}`` - ``device``,
        ``virtual_machine``, ``ip_address``, ``interface``, ``vm_interface``
        or ``service``: the object's pins in that order. Every id must be one
        of the object's pins."""
        named = [f for f in PARENT_FIELDS if request.data.get(f)]
        order = request.data.get("order")
        if len(named) != 1:
            raise ValidationError({"device": "Name one object: a device, VM, address, "
                                             "interface or service."})
        field = named[0]
        try:
            parent_id = str(uuid.UUID(str(request.data[field])))
        except ValueError:
            raise ValidationError({field: "Not an id."}) from None
        if not isinstance(order, list) or not all(isinstance(i, str) for i in order):
            raise ValidationError({"order": "A list of pin ids."})
        pins = self.get_queryset().filter(**{f"{field}_id": parent_id})
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
