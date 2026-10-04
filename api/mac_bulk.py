"""Bulk removal from the MAC list (#251).

``POST /api/macs/bulk-remove/`` takes MAC *values* - a row on the MAC list is
a value gathered from several places, not one object - and removes them from
the places the caller picks:

* ``remove_objects``   - delete the first-class MAC objects (on by default);
* ``clear_interfaces`` - blank the MAC on the device and VM interfaces that
  carry it;
* ``unpair_ips``       - blank the MAC paired with IP addresses.

``dry_run`` answers with the same counts and writes nothing; the confirm
dialog shows them. Each source is tenant-scoped and checked on its own grant
(``macaddress.delete``, ``interface.change``, ``vminterface.change``,
``ipaddress.change``) and row scope, so a site-scoped operator removes only
what their grants reach. Rows they can see but not change are left alone and
reported as ``skipped``. Every write lands in the change log.

``POST /api/mac-addresses/bulk-delete/`` is the object-id counterpart, the
same ``{ids}`` contract as the other bulk deletes. It is mounted ahead of
the router rather than as an action on ``MACAddressViewSet``.

Cost: clearing and unpairing are a fixed number of queries whatever the
batch. Deleting objects sends the delete signals per object, so each one
still costs about three queries (its change-log row, the webhook lookup,
the search-index drop); the tenant, interface and device those receivers
read come from the rows already loaded here.
"""

from __future__ import annotations

from django.db import router, transaction
from django.db.models.deletion import Collector
from django.db.models.functions import Lower, Trim
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from audit.bulk import log_bulk_update
from auth_api import rbac

from .models import Interface, IPAddress, MACAddress, VMInterface
from .views import _get_active_tenant

#: Most MAC values one request may name.
MAX_BULK_MACS = 2000

# (source key, option that applies it, RBAC slug, action it needs), in the
# order the writes run: pairings and interface strings first, objects last.
SOURCES = (
    ("ips", "unpair_ips", "ipaddress", "change"),
    ("interfaces", "clear_interfaces", "interface", "change"),
    ("vm_interfaces", "clear_interfaces", "vminterface", "change"),
    ("objects", "remove_objects", "macaddress", "delete"),
)
OPTIONS = ("remove_objects", "clear_interfaces", "unpair_ips")


class MacBulkRemoveSerializer(serializers.Serializer):
    values = serializers.ListField(
        child=serializers.CharField(max_length=64),
        allow_empty=False,
        max_length=MAX_BULK_MACS,
        error_messages={"max_length": f"At most {MAX_BULK_MACS} MACs per request."},
    )
    remove_objects = serializers.BooleanField(default=True)
    clear_interfaces = serializers.BooleanField(default=False)
    unpair_ips = serializers.BooleanField(default=False)
    dry_run = serializers.BooleanField(default=False)

    def validate(self, attrs):
        if not attrs["dry_run"] and not any(attrs[o] for o in OPTIONS):
            raise serializers.ValidationError(
                "Choose at least one of remove_objects, clear_interfaces, unpair_ips."
            )
        return attrs


def _source_qs(key: str, tenant):
    """Every row of one source in the tenant, before any RBAC narrowing."""
    # The change log reads each row's tenant and site path, so those come
    # along here rather than one query per row later.
    if key == "objects":
        return _objects(tenant)
    if key == "interfaces":
        return Interface.objects.filter(device__tenant=tenant).select_related("device")
    if key == "vm_interfaces":
        return VMInterface.objects.filter(vm__tenant=tenant).select_related("vm")
    return IPAddress.objects.filter(tenant=tenant).select_related("tenant")


def _objects(tenant):
    return MACAddress.objects.filter(tenant=tenant).select_related(
        "tenant", "assigned_interface__device"
    )


def _delete_objects(rows) -> int:
    """Delete MAC objects that are already loaded.

    Collected from these instances rather than re-read by a queryset delete,
    so the delete signals get the instances with their tenant, interface and
    device in hand. Nothing is suspended: each object still gets its own
    DELETE entry from the audit receiver."""
    if not rows:
        return 0
    collector = Collector(using=router.db_for_write(MACAddress))
    collector.collect(rows)
    _, per_model = collector.delete()
    return per_model.get(MACAddress._meta.label, 0)


def _carrying(qs, keys: set[str]):
    """Rows whose MAC is one of ``keys``, compared as the MAC list groups them
    (trimmed, lower case)."""
    return qs.annotate(_mac_key=Lower(Trim("mac_address"))).filter(_mac_key__in=keys)


def _plan(user, tenant, key: str, slug: str, action: str, keys: set[str]):
    """What one source would do: the rows the caller may act on, and how many
    rows they can see but not act on."""
    rows = _carrying(_source_qs(key, tenant), keys)
    visible = set(
        rbac.restrict_queryset(rows, user, tenant, slug, "view").values_list("pk", flat=True)
    )
    if not rbac.has_action(user, tenant, slug, action):
        return False, [], len(visible)
    allowed = list(rbac.restrict_queryset(rows, user, tenant, slug, action))
    skipped = len(visible - {r.pk for r in allowed})
    return True, allowed, skipped


def _apply(key: str, rows) -> int:
    pks = [r.pk for r in rows]
    if not pks:
        return 0
    if key == "objects":
        return _delete_objects(rows)
    model = rows[0].__class__
    n = model.objects.filter(pk__in=pks).update(mac_address="")
    log_bulk_update(rows, {"mac_address": ""})
    return n


@extend_schema(
    summary="Remove MAC values: delete their MAC objects, clear them from "
    "interfaces, unpair them from IPs",
    tags=["mac-addresses"],
    request=MacBulkRemoveSerializer,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{dry_run, macs, sources:{objects, interfaces, vm_interfaces, "
        "ips: {permitted, count, skipped, applied}}}. `count` is the rows the "
        "caller may act on (or did, when `applied`); `skipped` the rows they "
        "can see but not change.",
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mac_bulk_remove_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    user = request.user
    if not rbac.has_action(user, tenant, "macaddress", "view"):
        raise PermissionDenied("macaddress.view required.")

    ser = MacBulkRemoveSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    data = ser.validated_data
    dry_run = data["dry_run"]
    keys = {v.strip().lower() for v in data["values"]} - {""}

    if not dry_run:
        # An option nothing grants is refused outright, not quietly skipped.
        for option in OPTIONS:
            if not data[option]:
                continue
            needs = [(s, a) for _, o, s, a in SOURCES if o == option]
            if not any(rbac.has_action(user, tenant, s, a) for s, a in needs):
                raise PermissionDenied(" or ".join(f"{s}.{a}" for s, a in needs) + " required.")

    sources = {}
    with transaction.atomic():
        for key, option, slug, action in SOURCES:
            permitted, rows, skipped = _plan(user, tenant, key, slug, action, keys)
            applied = permitted and not dry_run and data[option]
            count = _apply(key, rows) if applied else len(rows)
            sources[key] = {
                "permitted": permitted,
                "count": count,
                "skipped": skipped,
                "applied": applied,
            }
    return Response({"dry_run": dry_run, "macs": len(keys), "sources": sources})


class MacBulkDeleteSerializer(serializers.Serializer):
    ids = serializers.ListField(
        child=serializers.UUIDField(),
        allow_empty=False,
        max_length=MAX_BULK_MACS,
        error_messages={"max_length": f"At most {MAX_BULK_MACS} MAC objects per request."},
    )


@extend_schema(
    summary="Delete MAC address objects by id",
    tags=["mac-addresses"],
    request=MacBulkDeleteSerializer,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="{deleted}. Ids outside the tenant or the caller's delete "
        "scope are left alone.",
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mac_object_bulk_delete_view(request):
    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    user = request.user
    if not rbac.has_action(user, tenant, "macaddress", "delete"):
        raise PermissionDenied("macaddress.delete required.")
    ser = MacBulkDeleteSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    qs = _objects(tenant).filter(pk__in=ser.validated_data["ids"])
    with transaction.atomic():
        rows = list(rbac.restrict_queryset(qs, user, tenant, "macaddress", "delete"))
        deleted = _delete_objects(rows)
    return Response({"deleted": deleted})
