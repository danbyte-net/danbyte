"""Device dependencies over the API (#450).

``/api/dependency-media/`` - the editable catalog a dependency's medium
comes from, as the IP roles (``?picker=1``, search, ``usage_count``). A
medium still in use is not deleted: 409 with the count.

``/api/device-dependencies/`` - "the downstream device depends on the
upstream one", or a ``peer`` link between equals. CRUD, ``bulk-update``
(medium, redundancy group, description, tags and custom fields - never the
ends or the kind), ``bulk-delete``, import/export (``api.io``) and these
filters:

* ``?upstream=``, ``?downstream=``, ``?device=`` (either end), ``?kind=``,
  ``?medium=``, ``?redundancy_group=`` (``?group=``), ``?site=`` (either
  end's site), ``?tag=``, ``?search=`` (``?q=``).

Both ends must be devices of the active tenant the caller may view; a UUID
from another tenant or outside the caller's view is "not found". A
dependency belongs to its downstream's site, else its upstream's
(``SITE_PATHS["devicedependency"]``), so a site editor records the
dependencies of their sites' devices. Every write goes through
``api.dependencies.save_dependency``, which refuses a cycle with its path.
An end the caller may not view reads as ``null``.
"""
from __future__ import annotations

import uuid as _uuid

from django.db.models import Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_field
from rest_framework import serializers
from rest_framework import status as drf_status
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from core.hidden_fields import hidden_related_spec
from core.models import Tag
from core.tags import TAGS

from .bulk_edit import BulkEditMixin, BulkEditSpec
from .cf_search import cf_text_q
from .dependencies import bump_graph_version, save_dependency
from .models import DependencyMedium, Device, DeviceDependency
from .natural import natural
from .serializers import (
    CustomFieldsSerializerMixin,
    HiddenRelatedFieldsMixin,
    NumIdModelSerializer,
    ObjectPermsSerializerMixin,
    OwningSiteSerializerMixin,
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
    _HiddenRelatedListSerializer,
    _visible_count,
)
from .views import _get_active_tenant
from .viewsets import NATURAL_NAME, TenantScopedViewSet, _IpCatalogViewSet, _tag_params_filter

# ─── media ──────────────────────────────────────────────────────────────────

class DependencyMediumPickerSerializer(NumIdModelSerializer):
    text_color = serializers.CharField(read_only=True)

    class Meta:
        model = DependencyMedium
        fields = ["id", "name", "slug", "color", "text_color", "icon", "line_style", "weight"]


class DependencyMediumSerializer(OwningSiteSerializerMixin, ObjectPermsSerializerMixin,
                                 NumIdModelSerializer):
    text_color = serializers.CharField(read_only=True)
    slug = serializers.SlugField(required=False, allow_blank=True)
    usage_count = serializers.SerializerMethodField()

    def get_usage_count(self, obj) -> int:
        v = getattr(obj, "usage_count_annotated", None)
        return v if v is not None else _visible_count(self, obj, "dependencies")

    class Meta:
        model = DependencyMedium
        fields = ["owning_site", "owning_site_id", "permissions", "id", "name", "slug",
                  "color", "text_color", "description", "weight", "icon", "line_style",
                  "usage_count", "created_at", "updated_at"]
        read_only_fields = ["id", "text_color", "usage_count", "created_at", "updated_at"]


class DependencyMediumViewSet(_IpCatalogViewSet):
    queryset = DependencyMedium.objects.all().order_by("weight", NATURAL_NAME)
    serializer_class = DependencyMediumSerializer
    picker_serializer_class = DependencyMediumPickerSerializer
    usage_relation = "dependencies"

    def destroy(self, request, *args, **kwargs):
        """A medium in use stays: 409 with how many dependencies use it
        (every one, also those the caller may not view)."""
        obj = self.get_object()
        n = obj.dependencies.count()
        if n:
            return Response(
                {"detail": f"{n} dependenc{'ies' if n != 1 else 'y'} use this medium."},
                status=drf_status.HTTP_409_CONFLICT,
            )
        return super().destroy(request, *args, **kwargs)


# ─── dependencies ───────────────────────────────────────────────────────────

class ViewableDeviceField(TenantScopedPrimaryKeyRelatedField):
    """A device of the active tenant the caller may view; any other id is
    "not found", never "forbidden".

    Not the site-separation fence of other references: a dependency's other
    end may be another site's device (an upstream router at the hub). The
    caller must be able to view it; the dependency itself still lands in the
    caller's write scope through its downstream's site (the post-save check)."""

    def get_queryset(self):
        request = self.context.get("request") if self.context else None
        qs = self.queryset.all()
        if request is None:
            return qs
        from auth_api import rbac

        tenant = _get_active_tenant(request)
        if tenant is None:
            return qs.none()
        return rbac.restrict_queryset(qs.filter(tenant=tenant), request.user, tenant,
                                      "device", "view")


def device_end(device) -> dict | None:
    if device is None:
        return None
    site = device.site
    return {"id": str(device.pk), "name": device.name,
            "site": {"id": str(site.pk), "name": site.name} if site else None}


class _SavedThroughService:
    """Create and update through ``save_dependency`` (lock, cycle check,
    field errors)."""

    def create(self, validated_data):
        obj = DeviceDependency(**validated_data)
        return save_dependency(obj)

    def update(self, instance, validated_data):
        for key, value in validated_data.items():
            setattr(instance, key, value)
        return save_dependency(instance)


class DeviceDependencySerializer(
    HiddenRelatedFieldsMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin,
    _SavedThroughService, NumIdModelSerializer,
):
    cf_model = "devicedependency"
    # The other end may be another site's device (#453 shape).
    hidden_related = hidden_related_spec("api.devicedependency")

    upstream = serializers.SerializerMethodField()
    upstream_id = ViewableDeviceField(
        source="upstream", queryset=Device.objects.all(), write_only=True, required=False,
    )
    downstream = serializers.SerializerMethodField()
    downstream_id = ViewableDeviceField(
        source="downstream", queryset=Device.objects.all(), write_only=True, required=False,
    )
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    medium = DependencyMediumPickerSerializer(read_only=True)
    medium_id = TenantScopedPrimaryKeyRelatedField(
        source="medium", queryset=DependencyMedium.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(), write_only=True, required=False, many=True,
    )

    class Meta:
        model = DeviceDependency
        fields = ["id", "numid", "upstream", "upstream_id", "downstream", "downstream_id",
                  "kind", "kind_display", "medium", "medium_id", "redundancy_group",
                  "description", "comments", "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "created_at", "updated_at"]
        list_serializer_class = _HiddenRelatedListSerializer

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_upstream(self, obj):
        return device_end(obj.upstream)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_downstream(self, obj):
        return device_end(obj.downstream)

    def validate_redundancy_group(self, value):
        return (value or "").strip()

    def validate(self, attrs):
        attrs = super().validate(attrs)
        inst = self.instance
        get = lambda k: attrs[k] if k in attrs else getattr(inst, k, None)  # noqa: E731
        if get("upstream") is None:
            raise serializers.ValidationError({"upstream_id": "Pick the upstream device."})
        if get("downstream") is None:
            raise serializers.ValidationError({"downstream_id": "Pick the downstream device."})
        if get("upstream").pk == get("downstream").pk:
            raise serializers.ValidationError(
                {"downstream_id": "A device cannot depend on itself."}
            )
        if get("kind") == DeviceDependency.KIND_PEER and (get("redundancy_group") or ""):
            raise serializers.ValidationError(
                {"redundancy_group": "A peer link has no redundancy group."}
            )
        return attrs


def _uuid_param(params, key):
    raw = params.get(key)
    if not raw:
        return None
    try:
        return _uuid.UUID(str(raw))
    except ValueError:
        raise ValidationError({key: "Not a valid id."}) from None


class DeviceDependencyViewSet(BulkEditMixin, TenantScopedViewSet):
    queryset = (
        DeviceDependency.objects.select_related(
            "upstream__site", "downstream__site", "medium",
        )
        .prefetch_related(TAGS)
        .order_by(natural("downstream__name"), natural("upstream__name"))
    )
    serializer_class = DeviceDependencySerializer
    bulk_edit = BulkEditSpec(
        fields=("medium_id", "redundancy_group", "description"), custom_fields=True,
    )

    @extend_schema(parameters=[
        OpenApiParameter(k, OpenApiTypes.UUID, OpenApiParameter.QUERY)
        for k in ("upstream", "downstream", "device", "medium", "site")
    ] + [
        OpenApiParameter("kind", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         enum=[c for c, _ in DeviceDependency.KIND_CHOICES]),
        OpenApiParameter("redundancy_group", OpenApiTypes.STR, OpenApiParameter.QUERY),
        OpenApiParameter("tag", OpenApiTypes.STR, OpenApiParameter.QUERY, many=True),
        OpenApiParameter("search", OpenApiTypes.STR, OpenApiParameter.QUERY),
    ])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        params = self.request.query_params
        for key, field in (("upstream", "upstream_id"), ("downstream", "downstream_id"),
                           ("medium", "medium_id")):
            v = _uuid_param(params, key)
            if v:
                qs = qs.filter(**{field: v})
        v = _uuid_param(params, "device")
        if v:
            qs = qs.filter(Q(upstream_id=v) | Q(downstream_id=v))
        v = _uuid_param(params, "site")
        if v:
            qs = qs.filter(Q(upstream__site_id=v) | Q(downstream__site_id=v))
        kind = params.get("kind")
        if kind:
            if kind not in {c for c, _ in DeviceDependency.KIND_CHOICES}:
                raise ValidationError({"kind": "dependency or peer."})
            qs = qs.filter(kind=kind)
        group = params.get("redundancy_group", params.get("group"))
        if group is not None and group != "":
            qs = qs.filter(redundancy_group=group.strip())
        qs = _tag_params_filter(qs, params)
        s = (params.get("search") or params.get("q") or "").strip()
        if s:
            qs = qs.filter(
                self._visible_name_q("upstream", s) | self._visible_name_q("downstream", s)
                | Q(description__icontains=s) | Q(redundancy_group__icontains=s)
                | Q(medium__name__icontains=s) | cf_text_q(qs.model, s)
            )
        return qs

    def _visible_name_q(self, end: str, value: str) -> Q:
        """``<end>__name`` matched only on a device the caller may view, so
        a search never answers for a hidden end."""
        from auth_api import rbac

        match = Q(**{f"{end}__name__icontains": value})
        user = self.request.user
        tenant = _get_active_tenant(self.request)
        if tenant is None or getattr(user, "is_superuser", False):
            return match
        f = rbac.row_filter(user, tenant, "device", "view")
        if f is True:
            return match
        if f is None:
            return Q(pk__in=[])
        return match & Q(**{f"{end}__in": Device.objects.filter(f).values("pk")})

    def check_bulk_rows(self, rows: list, updates: dict) -> None:
        if (updates.get("redundancy_group") or "") and any(
            r.kind == DeviceDependency.KIND_PEER for r in rows
        ):
            raise ValidationError(
                {"redundancy_group": "A peer link has no redundancy group - "
                                     "leave the peers out of the selection."}
            )

    def normalize_bulk_updates(self, updates: dict) -> dict:
        if "redundancy_group" in updates:
            updates["redundancy_group"] = (updates["redundancy_group"] or "").strip()
        return updates

    def after_bulk_update(self, pks: list, updates: dict) -> None:
        tenant = _get_active_tenant(self.request)
        if tenant is not None:
            bump_graph_version(tenant.pk)
