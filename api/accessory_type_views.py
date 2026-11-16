"""``/api/accessory-types/``: the parts seated in cabled ports on 3D models
(api.port_plugs, docs/dcim/model-packs.md → Accessory types).

Read only - accessory types come with model packs. Reading takes view on
module types, as the parts arrive beside them; every row is the active
tenant's own. ``model/`` serves a part's ``.glb`` like a type's model
(api.model_3d.serve).
"""
from __future__ import annotations

from django.utils.text import slugify
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import permissions, serializers, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.response import Response

from .models import AccessoryType
from .pagination import StandardResultsSetPagination


class AccessoryTypeSerializer(serializers.ModelSerializer):
    model_url = serializers.SerializerMethodField()

    class Meta:
        model = AccessoryType
        fields = ["id", "vendor", "name", "kind", "connector", "fits", "parts", "standard",
                  "wavelength_nm", "cable", "model_url", "created_at", "updated_at"]
        read_only_fields = fields

    def get_model_url(self, obj):
        from .model_3d import version_of

        if not obj.model_3d:
            return None
        return f"/api/accessory-types/{obj.pk}/model/?v={version_of(obj.model_3d)}"


class AccessoryTypeViewSet(viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated]
    pagination_class = StandardResultsSetPagination
    serializer_class = AccessoryTypeSerializer
    queryset = AccessoryType.objects.all()

    def get_queryset(self):
        from .port_plugs import may_view_types
        from .views import _get_active_tenant

        tenant = _get_active_tenant(self.request)
        if tenant is None:
            raise PermissionDenied("No active tenant selected.")
        if not may_view_types(self.request.user, tenant):
            raise PermissionDenied("You can't view module types.")
        return AccessoryType.objects.filter(tenant=tenant)

    def _get(self, pk):
        try:
            obj = self.get_queryset().filter(pk=pk).first()
        except (ValueError, Exception):  # noqa: BLE001 - a malformed id
            obj = None
        if obj is None:
            raise NotFound()
        return obj

    def list(self, request):
        qs = self.get_queryset()
        page = self.paginate_queryset(qs)
        rows = AccessoryTypeSerializer(page if page is not None else qs, many=True).data
        return self.get_paginated_response(rows) if page is not None else Response(rows)

    def retrieve(self, request, pk=None):
        return Response(AccessoryTypeSerializer(self._get(pk)).data)

    @extend_schema(responses={200: OpenApiTypes.BINARY})
    @action(detail=True, methods=["get"], url_path="model")
    def model_file(self, request, pk=None):
        """The part's 3D model (binary glTF)."""
        from django.http import Http404

        from .model_3d import serve

        obj = self._get(pk)
        if not obj.model_3d:
            raise Http404("No 3D model.")
        return serve(obj.model_3d, f"{slugify(obj.name) or 'accessory'}.glb")
