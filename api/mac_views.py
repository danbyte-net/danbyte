"""MAC address registry for the IPAM MAC page.

``GET /api/macs/`` → every MAC address known in the active tenant, aggregated
from three places: interface hardware addresses, IP↔MAC pairings, and
first-class :class:`~api.models.MACAddress` objects. Each MAC is one row
carrying the interfaces that bear it, the IPs paired with it, and any MAC
objects (with their description / tags) recorded for it.

Full CRUD on the MAC *objects* themselves lives at ``/api/mac-addresses/``
(see :class:`~api.viewsets.MACAddressViewSet`); this module only aggregates.
"""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac

from .models import IPAddress, Interface, MACAddress
from .serializers import TagSerializer
from .views import _get_active_tenant


def _norm(mac: str) -> str:
    return mac.strip().lower()


def _iface_ref(iface) -> dict:
    return {
        "id": str(iface.id),
        "name": iface.name,
        "device": {"id": str(iface.device_id), "name": iface.device.name},
    }


def _mac_object(m: MACAddress, *, with_custom_fields: bool = False) -> dict:
    """Serialize a MAC object for the aggregation views (list / detail)."""
    obj = {
        "id": str(m.id),
        "numid": m.numid,
        "mac_address": m.mac_address,
        "description": m.description,
        "assigned_interface": (
            _iface_ref(m.assigned_interface) if m.assigned_interface_id else None
        ),
        "tags": TagSerializer(m.tags.all(), many=True).data,
    }
    if with_custom_fields:
        obj["custom_fields"] = m.custom_fields or {}
    return obj


@extend_schema(
    summary="List every MAC address known in the active tenant, aggregated from "
    "interfaces, IP↔MAC pairings and first-class MAC objects",
    tags=["mac-addresses"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Aggregated MAC rows: {count, results:[{mac, interfaces[], "
        "ips[], objects[]}]}.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def mac_list_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"count": 0, "results": []})
    if not rbac.has_action(request.user, tenant, "macaddress", "view"):
        return Response({"detail": "macaddress.view required."}, status=403)

    entries: dict[str, dict] = {}

    def bucket(mac: str) -> dict:
        key = _norm(mac)
        if key not in entries:
            entries[key] = {"mac": mac, "interfaces": [], "ips": [], "objects": []}
        return entries[key]

    ifaces = (
        Interface.objects.filter(device__tenant=tenant)
        .exclude(mac_address="")
        .select_related("device")
    )
    for i in ifaces:
        bucket(i.mac_address)["interfaces"].append(_iface_ref(i))

    ips = (
        IPAddress.objects.filter(tenant=tenant)
        .exclude(mac_address="")
        .select_related("assigned_device")
    )
    for ip in ips:
        bucket(ip.mac_address)["ips"].append(
            {
                "id": str(ip.id),
                "ip_address": ip.ip_address,
                "device": (
                    {"id": str(ip.assigned_device_id), "name": ip.assigned_device.name}
                    if ip.assigned_device_id
                    else None
                ),
            }
        )

    # First-class MAC objects — surface even when no interface/IP string carries
    # the address yet, so a standalone object is still listed and its
    # description / tags show on the row.
    objects = (
        MACAddress.objects.filter(tenant=tenant)
        .select_related("assigned_interface__device")
        .prefetch_related("tags")
    )
    for m in objects:
        bucket(m.mac_address)["objects"].append(_mac_object(m))

    results = sorted(entries.values(), key=lambda e: _norm(e["mac"]))
    return Response({"count": len(results), "results": results})


@extend_schema(
    summary="Detail for one MAC address: interfaces bearing it, IPs paired with "
    "it, and first-class MAC objects recorded for it",
    tags=["mac-addresses"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{mac, objects[], interfaces[], ips[]} for the given MAC "
        "address, or 404 when nothing carries it.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def mac_detail_view(request, mac):
    """One MAC address: every interface that bears it, every IP paired with it,
    and every first-class MAC object recorded for it (with the description /
    tags / custom fields you can edit)."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "Not found."}, status=404)
    if not rbac.has_action(request.user, tenant, "macaddress", "view"):
        return Response({"detail": "macaddress.view required."}, status=403)

    key = _norm(mac)
    ifaces = (
        Interface.objects.filter(device__tenant=tenant, mac_address__iexact=key)
        .select_related("device")
        .order_by("device__name", "name")
    )
    ips = (
        IPAddress.objects.filter(tenant=tenant, mac_address__iexact=key)
        .select_related("assigned_device", "assigned_interface", "status")
        .order_by("ip_address")
    )
    objects = (
        MACAddress.objects.filter(tenant=tenant, mac_address__iexact=key)
        .select_related("assigned_interface__device")
        .prefetch_related("tags")
        .order_by("assigned_interface__device__name", "assigned_interface__name")
    )
    if not ifaces.exists() and not ips.exists() and not objects.exists():
        return Response({"detail": "Not found."}, status=404)

    if ifaces.exists():
        display = ifaces.first().mac_address
    elif ips.exists():
        display = ips.first().mac_address
    else:
        display = objects.first().mac_address

    return Response(
        {
            "mac": display,
            "objects": [_mac_object(m, with_custom_fields=True) for m in objects],
            "interfaces": [
                {**_iface_ref(i), "enabled": i.enabled} for i in ifaces
            ],
            "ips": [
                {
                    "id": str(ip.id),
                    "ip_address": ip.ip_address,
                    "status": (
                        {
                            "name": ip.status.name,
                            "color": ip.status.color,
                            "text_color": ip.status.text_color,
                        }
                        if ip.status_id
                        else None
                    ),
                    "device": (
                        {"id": str(ip.assigned_device_id), "name": ip.assigned_device.name}
                        if ip.assigned_device_id
                        else None
                    ),
                    "interface": (
                        {"id": str(ip.assigned_interface_id), "name": ip.assigned_interface.name}
                        if ip.assigned_interface_id
                        else None
                    ),
                }
                for ip in ips
            ],
        }
    )
