"""``/api/rack-kits/``: the kits of parts the 3D room builds racks from
(api.rack_kits, docs/dcim/racks.md → Look).

Kits come with model packs; there is nothing to edit by hand. Permissions
are the rack type grant: view to list and read a kit and its models,
delete to delete one (the rack types and racks that named it then draw
Danbyte's own rack). Every row is the active tenant's own.
"""
from __future__ import annotations

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.db.models import Count
from django.utils.text import slugify
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.response import Response

from . import rack_kits
from .models import RackKit
from .pagination import StandardResultsSetPagination


class RackKitSerializer(serializers.ModelSerializer):
    model_url = serializers.SerializerMethodField()
    far_url = serializers.SerializerMethodField()
    rack_type_count = serializers.IntegerField(read_only=True, default=None)

    class Meta:
        model = RackKit
        fields = ["id", "vendor", "name", "frame", "widths_mm", "depths_mm", "colours",
                  "parts", "model_url", "far_url", "pack_import", "rack_type_count",
                  "created_at", "updated_at"]
        read_only_fields = fields

    def _url(self, obj, far: bool):
        doc = rack_kits.kit_doc(obj, None, True)
        return doc and doc["far_url" if far else "model_url"]

    def get_model_url(self, obj) -> str | None:
        return self._url(obj, False)

    def get_far_url(self, obj) -> str | None:
        return self._url(obj, True)


class RackKitViewSet(viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = StandardResultsSetPagination
    serializer_class = RackKitSerializer
    queryset = RackKit.objects.all()

    def _tenant(self):
        from .views import _get_active_tenant

        tenant = _get_active_tenant(self.request)
        if tenant is None:
            raise PermissionDenied("No active tenant selected.")
        return tenant

    def get_queryset(self):
        tenant = self._tenant()
        if not rack_kits.may_view(self.request.user, tenant):
            raise PermissionDenied("You can't view rack types.")
        return RackKit.objects.filter(tenant=tenant).annotate(
            rack_type_count=Count("rack_types", distinct=True))

    def _get(self, pk):
        try:
            obj = self.get_queryset().filter(pk=pk).first()
        except (ValueError, DjangoValidationError):
            obj = None
        if obj is None:
            raise NotFound()
        return obj

    def list(self, request):
        """The tenant's kits. Filters: ``frame``, ``search`` (name or vendor)."""
        from django.db.models import Q

        qs = self.get_queryset()
        p = request.query_params
        if frame := p.get("frame"):
            qs = qs.filter(frame=frame)
        if s := p.get("search", "").strip():
            qs = qs.filter(Q(name__icontains=s) | Q(vendor__icontains=s))
        page = self.paginate_queryset(qs)
        rows = RackKitSerializer(page if page is not None else qs, many=True).data
        return self.get_paginated_response(rows) if page is not None else Response(rows)

    def retrieve(self, request, pk=None):
        return Response(RackKitSerializer(self._get(pk)).data)

    def destroy(self, request, pk=None):
        from auth_api import rbac

        obj = self._get(pk)
        if not rbac.has_action(request.user, obj.tenant, "racktype", "delete"):
            raise PermissionDenied("You can't delete rack types.")
        fields = [f for f in (obj.model_3d, obj.model_3d_far) if f]
        names = [(f.storage, f.name) for f in fields]
        with transaction.atomic():
            obj.delete()
        for storage, name in names:
            storage.delete(name)
        return Response(status=status.HTTP_204_NO_CONTENT)

    @extend_schema(responses={200: OpenApiTypes.BINARY})
    @action(detail=True, methods=["get"], url_path="model")
    def model_file(self, request, pk=None):
        """The kit's parts (binary glTF); ``?far=1`` its far box."""
        return serve_kit(self._get(pk), request)


def serve_kit(kit, request):
    from django.http import Http404

    from . import model_3d

    far = request.query_params.get("far") in ("1", "true")
    field = kit.model_3d_far if far else kit.model_3d
    if not field:
        raise Http404("No 3D model.")
    stem = slugify(kit.name) or "rack-kit"
    return model_3d.serve(field, f"{stem}{'.far' if far else '.kit'}.glb")
