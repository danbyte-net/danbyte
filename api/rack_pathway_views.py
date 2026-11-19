"""``/api/rack-pathways/``: the cable pathways of racks and rack types
(api.rack_pathways, docs/dcim/racks.md → Pathways).

The rows are what someone changed or added: an overlay of an inherited
pathway (``key`` set) or a pathway of its own. ``resolved/?rack=<id>`` (or
``?rack_type=<id>``) is the merged list - the kit's or the frame's, the
type's, the rack's - with each item's source; ``pin/`` makes the rack's row
for an inherited pathway so something can point at it.

Permissions are the ``rackpathway`` grant, scoped by the rack's site (a
rack type's rows have no site: shared to read, written only by those not
bound to sites); a rack type's rows also need change on rack types, as
they change every rack of the type.
"""
from __future__ import annotations

import uuid

from django.db import transaction
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from . import rack_pathways as rp
from .models import AccessoryType, Device, Rack, RackPathway, RackType
from .serializers import TenantScopedPrimaryKeyRelatedField
from .views import _get_active_tenant
from .viewsets import StandardPagination, TenantScopedViewSet


def _ref(obj):
    return {"id": str(obj.pk), "name": str(obj.name)} if obj is not None else None


class RackPathwaySerializer(serializers.ModelSerializer):
    rack_id = TenantScopedPrimaryKeyRelatedField(
        source="rack", queryset=Rack.objects.all(), required=False, allow_null=True)
    rack_type_id = TenantScopedPrimaryKeyRelatedField(
        source="rack_type", queryset=RackType.objects.all(), required=False, allow_null=True)
    accessory_type_id = TenantScopedPrimaryKeyRelatedField(
        source="accessory_type", queryset=AccessoryType.objects.all(), required=False,
        allow_null=True)
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), required=False, allow_null=True)

    class Meta:
        model = RackPathway
        fields = ["id", "rack_id", "rack_type_id", "key", "kind", "subkind", "side", "face",
                  "surface", "u_from", "u_to", "offset_mm", "depth_mm", "x_mm", "y_mm",
                  "inner_w_mm", "inner_d_mm", "fill_limit_pct", "accessory_type_id",
                  "device_id", "name", "description", "hidden", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]
        # One row per key and owner: rack_pathways.check says so as a field
        # error (DRF's own would make both owners required).
        validators: list = []

    def validate(self, attrs):
        inst = self.instance
        if inst is not None:
            for f, src in (("rack_id", "rack"), ("rack_type_id", "rack_type"), ("key", "key")):
                if src in attrs and attrs[src] != getattr(inst, src):
                    raise ValidationError({f: "Can't be changed; delete the row and add another."})
        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request else None
        row = RackPathway(tenant=tenant) if inst is None else RackPathway(
            **{f.attname: getattr(inst, f.attname) for f in RackPathway._meta.concrete_fields})
        if inst is not None:
            row._state.adding = False
        for k, v in attrs.items():
            setattr(row, k, v)
        if row.tenant_id is None:
            raise PermissionDenied("No active tenant selected.")
        errors = rp.check(row)
        if errors:
            raise ValidationError(errors)
        return attrs


def _uuid(params, name):
    raw = params.get(name)
    if not raw:
        return None
    try:
        return uuid.UUID(str(raw))
    except ValueError as exc:
        raise ValidationError({name: "Not an id."}) from exc


def item_doc(it: dict) -> dict:
    """A resolved pathway as the API gives it."""
    out = {k: v for k, v in it.items() if k not in ("accessory_type", "device")}
    out["accessory_type"] = _ref(it.get("accessory_type"))
    out["device"] = _ref(it.get("device"))
    return out


class RackPathwayViewSet(TenantScopedViewSet):
    queryset = RackPathway.objects.select_related(
        "rack", "rack_type", "accessory_type", "device__device_type")
    serializer_class = RackPathwaySerializer
    pagination_class = StandardPagination
    rbac_action_map = {"resolved": "view", "pin": "add"}

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request and self.action == "list":
            p = self.request.query_params
            rack = _uuid(p, "rack")
            if rack:
                qs = qs.filter(rack_id=rack)
            rt = _uuid(p, "rack_type")
            if rt:
                qs = qs.filter(rack_type_id=rt)
        return qs.order_by("created_at", "id")

    def _type_grant(self, row):
        """A rack type's rows change every rack of the type: change on rack
        types too."""
        from auth_api import rbac

        if row.rack_type_id and not rbac.has_action(
                self.request.user, _get_active_tenant(self.request), "racktype", "change"):
            raise PermissionDenied("Changing a rack type's pathways needs change on rack types.")

    def perform_create(self, serializer):
        self._type_grant(RackPathway(rack_type=serializer.validated_data.get("rack_type")))
        super().perform_create(serializer)

    def perform_update(self, serializer):
        self._type_grant(serializer.instance)
        serializer.save()

    def perform_destroy(self, instance):
        self._type_grant(instance)
        instance.delete()

    def _rack(self, pk, action_="view"):
        from auth_api import rbac

        tenant = self._tenant_or_403()
        qs = rbac.restrict_queryset(Rack.objects.filter(tenant=tenant), self.request.user,
                                    tenant, "rack", action_)
        rack = qs.select_related("rack_type__kit", "kit").filter(pk=pk).first()
        if rack is None:
            raise NotFound("No such rack.")
        return rack

    @extend_schema(responses=OpenApiTypes.OBJECT)
    @action(detail=False, methods=["get"])
    def resolved(self, request):
        """The merged pathways of ``?rack=`` or ``?rack_type=``."""
        from auth_api import rbac

        p = request.query_params
        rack_id, rt_id = _uuid(p, "rack"), _uuid(p, "rack_type")
        if (rack_id is None) == (rt_id is None):
            raise ValidationError({"rack": "Give a rack or a rack type."})
        tenant = self._tenant_or_403()
        rows = RackPathway.objects.filter(pk__in=self.get_queryset().values("pk"))
        if rack_id is not None:
            rack = self._rack(rack_id)
            items = rp.resolve_rack(
                rack, rows=rp.rows_of(rows.filter(rack=rack)),
                type_rows=rp.rows_of(rows.filter(rack_type_id=rack.rack_type_id))
                if rack.rack_type_id else None)
            fr = rp.Frame.of_rack(rack)
            devices = self._devices(rack, items, tenant)
            cables = self._cables(rack, tenant)
        else:
            qs = rbac.restrict_queryset(RackType.objects.filter(tenant=tenant), request.user,
                                        tenant, "racktype", "view")
            rt = qs.select_related("kit").filter(pk=rt_id).first()
            if rt is None:
                raise NotFound("No such rack type.")
            items = rp.resolve_type(rt, rows=rp.rows_of(rows.filter(rack_type=rt)))
            fr = rp.Frame.of_type(rt)
            devices = {}
            cables = None
        docs = []
        for it in items:
            d = item_doc(it)
            if it["kind"] == "channel":
                d["devices"] = devices.get(it["id"], [])
            if cables is not None:
                d["cables"] = cables.get(it["id"], 0) if it["id"] else 0
            docs.append(d)
        return Response({
            "frame": fr.frame, "kit": _ref(fr.kit), "units": [fr.start, fr.top_unit],
            "fill_limit_pct": rp.DEFAULT_FILL_PCT, "items": docs,
        })

    def _devices(self, rack, items, tenant) -> dict[str, list]:
        """The 0U devices in each of the rack's channel rows, as far as the
        reader may view them."""
        from auth_api import rbac

        ids = [it["id"] for it in items if it["kind"] == "channel" and it["id"]]
        if not ids:
            return {}
        qs = rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant, rack=rack, mount_pathway_id__in=ids),
            self.request.user, tenant, "device", "view")
        out: dict[str, list] = {}
        for d in qs.order_by("name").only("id", "name", "mount_pathway_id"):
            out.setdefault(str(d.mount_pathway_id), []).append({"id": str(d.pk), "name": d.name})
        return out

    def _cables(self, rack, tenant) -> dict[str, int] | None:
        """``{pathway id: cables}`` - the recorded cable ways through each of
        the rack's pathways (api.cable_ways), of the cables the reader may
        view; None without a grant on cable ways."""
        from auth_api import rbac

        from .cable_scope import restrict_cables
        from .cable_ways import counts_by_pathway
        from .models import Cable, CableWay

        if not rbac.has_action(self.request.user, tenant, "cableway", "view"):
            return None
        ways = rbac.restrict_queryset(CableWay.objects.filter(tenant=tenant, rack=rack),
                                      self.request.user, tenant, "cableway", "view")
        ids = restrict_cables(Cable.objects.filter(tenant=tenant, pk__in=ways.values("cable_id")),
                              self.request.user, tenant, "view").values_list("pk", flat=True)
        return counts_by_pathway(rack, cable_ids=list(ids))

    @extend_schema(request=OpenApiTypes.OBJECT, responses=RackPathwaySerializer)
    @action(detail=False, methods=["post"])
    def pin(self, request):
        """``{rack_id, key}``: the rack's row for its pathway ``key``, made
        when there is none (an overlay that changes nothing) - so a device
        or a cable way can point at an inherited pathway."""
        data = request.data if isinstance(request.data, dict) else {}
        try:
            rack_id = uuid.UUID(str(data.get("rack_id") or ""))
        except ValueError as exc:
            raise ValidationError({"rack_id": "Not an id."}) from exc
        key = str(data.get("key") or "")
        if not key:
            raise ValidationError({"key": "This field is required."})
        tenant = self._tenant_or_403()
        with transaction.atomic():
            rack = self._rack(rack_id)
            Rack.objects.select_for_update().filter(pk=rack.pk).first()
            existed = rack.pathways.filter(key=key).exists() or key.startswith("manual:")
            row = rp.pin(rack, key, tenant=tenant)
            if row is None:
                raise ValidationError({"key": "Not a pathway of this rack."})
            response = Response(RackPathwaySerializer(row).data,
                                status=status.HTTP_200_OK if existed else status.HTTP_201_CREATED)
            self._assert_write_in_site_scope(response, "add")
        return response
