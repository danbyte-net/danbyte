"""``/api/device-leds/``: what the status LEDs of a set of devices show now
(api.led_state), which port covers to hide (api.port_covers) and which
plugs to seat in cabled ports (api.port_plugs), for the
3D room, the device viewer and LED overlays on rack-face images. Light enough to poll every 30 seconds; the query count
does not grow with the number of devices.

``GET ?devices=<id>,<id>…`` (or ``?device=<id>``, or ``?rack=<id>`` for the
devices mounted in a rack). A scene with hundreds of devices POSTs the same
parameters as a JSON body (``{"devices": [...]}``) to stay under the request
line limit; a POST changes nothing. Devices the reader may not view, or
outside the active tenant, are left out without a word.
"""
from __future__ import annotations

from collections.abc import Mapping

from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import ParseError, PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac

from .led_state import MAX_DEVICES, LedStates

#: How often a client should ask again (seconds).
POLL_SECONDS = 30
#: Every parameter the endpoint reads (strict: anything else is a 400).
PARAMS = frozenset({"devices", "device", "rack"})
_IGNORED = frozenset({"format", "_", "strict"})


def _params(request):
    if request.method != "POST":
        return request.query_params
    data = request.data
    if not isinstance(data, Mapping):
        raise ParseError("The body must be a JSON object.")
    return data


@extend_schema(
    summary="Status LED states for a set of devices",
    parameters=[
        OpenApiParameter("devices", str, description="Comma-separated device ids "
                         f"(at most {MAX_DEVICES})."),
        OpenApiParameter("device", str, description="One device id."),
        OpenApiParameter("rack", str, description="Every device mounted in this rack."),
    ],
    responses={200: OpenApiTypes.OBJECT},
)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def device_leds_view(request):
    """``{as_of, poll_seconds, devices: {id: {leds, bays, locate, covers,
    bay_covers, plugs}}}``:
    ``leds`` the chassis' lit LEDs by id (``SYS``, ``port:Te1/0/1``),
    ``bays`` each bay's installed module's lit LEDs, ``locate`` the beacon
    while it is on. An LED left out is off. States are green, amber, red,
    blue or neutral, ``_blink`` appended when blinking. ``covers`` names
    the chassis' port covers to hide (its ports in use: cabled or marked
    connected, among the interfaces the reader may view) and ``bay_covers``
    each installed module's (api.port_covers). ``plugs`` lists the parts
    seated in cabled ports and in ports holding a transceiver record -
    ``{port, bay, name, port_type, cabled, color, cable_type, transceiver,
    transceiver_part, cord_part}`` - when the tenant has accessory types
    (api.port_plugs)."""
    from .models import Device, Rack
    from .topology_views import _parse_uuid, _uuid_list_param
    from .views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    params = _params(request)
    unknown = sorted(set(params.keys()) - PARAMS - _IGNORED)
    if unknown:
        raise ParseError(
            f"Unknown parameters: {', '.join(unknown)}. This endpoint reads "
            f"{', '.join(sorted(PARAMS))}."
        )
    ids = _uuid_list_param(params, "devices", limit=MAX_DEVICES)
    one = params.get("device")
    if one:
        ids.append(_parse_uuid(one, "device"))
    qs = Device.objects.none()
    if ids:
        qs = Device.objects.filter(tenant=tenant, pk__in=ids)
    rack_id = params.get("rack")
    if rack_id:
        rack_id = _parse_uuid(rack_id, "rack")
        rack = rbac.restrict_queryset(
            Rack.objects.filter(tenant=tenant, pk=rack_id), request.user, tenant,
            "rack", "view",
        ).first()
        if rack is not None:
            qs = qs | Device.objects.filter(tenant=tenant, rack=rack)
    devices = list(
        rbac.restrict_queryset(qs, request.user, tenant, "device", "view")
        .select_related("status", "device_type")
        .order_by()[:MAX_DEVICES]
    )
    loader = LedStates(request.user, tenant, now=timezone.now())
    return Response({
        "as_of": loader.now.isoformat(),
        "poll_seconds": POLL_SECONDS,
        "devices": loader.payload(devices),
    })
