"""Device profiles over the API.

* ``/api/device-profiles/`` - the catalog: CRUD, ``?search=``, ``?parent=``,
  ``?application_group=``, ``?device=``, ``?virtual_machine=``,
  ``?picker=1``, ``bulk-delete``. Sections are written whole:
  ``application_group_ids`` (ordered), ``add_tag_ids``, ``cf_values``,
  ``platform_id``. A delete is refused (409) while the profile is assigned
  or has child profiles. ``POST <id>/preview/ {device_id | virtual_machine_id}``
  answers what assigning would create, change and skip, and the permissions
  the caller is missing. Nothing is written.
* ``/api/device-profile-assignments/`` - a profile on one device or VM:
  list, ``POST`` (assign → ``{assignment, created}``), ``PATCH`` (position),
  ``DELETE`` (unassign → ``{removed, kept, moved}``), ``?profile=``,
  ``?device=``, ``?virtual_machine=``. ``POST set/`` sets an object's
  profiles exactly, in list order. ``POST <id>/reapply/`` restores what was
  removed by hand. ``POST bulk/`` assigns or unassigns one profile on up to
  :data:`BULK_INLINE` objects at once, more as a background job.

Profiles are a tenant catalog, like application groups. An assignment
belongs to its device's or VM's site (``SITE_PATHS``). Assigning also takes
``add`` on what the profile writes at that site - application group
assignments and installed software for its groups, ``change`` on the object
for its tags, custom fields and platform; unassigning takes ``delete``.
"""
from __future__ import annotations

import re

from django.db import transaction
from django.db.models import Prefetch, Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_field
from rest_framework import serializers
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from api.applications_api import _uuid_param
from api.bulk_delete import SafeBulkDeleteMixin
from api.cf_search import cf_text_q
from api.models import ApplicationGroup, Device, Platform, VirtualMachine
from api.natural import natural
from api.serializers import (
    CustomFieldsSerializerMixin,
    NumIdModelSerializer,
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
)
from api.views import _get_active_tenant
from api.viewsets import StandardPagination, TenantScopedViewSet, _all_n, _visible_n
from core.models import Tag
from core.tags import TAGS

from . import engine
from .models import (
    MAX_DEPTH,
    DeviceProfile,
    DeviceProfileApplicationGroup,
    DeviceProfileAssignment,
)

#: Objects a bulk request handles inline; more go to a background job.
BULK_INLINE = 25
#: The most objects one bulk request may name.
BULK_MAX = 5000

PATH_SEP = " / "


def _path(profile) -> str:
    return PATH_SEP.join(p.name for p in profile.chain())


def _ref(obj, *extra) -> dict | None:
    if obj is None:
        return None
    out = {"id": str(obj.pk), "name": obj.name}
    for k in extra:
        out[k] = getattr(obj, k)
    return out


class DeviceProfileMiniSerializer(NumIdModelSerializer):
    path = serializers.SerializerMethodField()

    class Meta:
        model = DeviceProfile
        fields = ["id", "name", "slug", "color", "path"]

    def get_path(self, obj) -> str:
        return _path(obj)


class DeviceProfileSerializer(
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer,
):
    cf_model = "deviceprofile"

    slug = serializers.SlugField(required=False, allow_blank=True)
    parent = serializers.SerializerMethodField()
    parent_id = TenantScopedPrimaryKeyRelatedField(
        source="parent", queryset=DeviceProfile.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    path = serializers.SerializerMethodField()
    platform = serializers.SerializerMethodField()
    platform_id = TenantScopedPrimaryKeyRelatedField(
        source="platform", queryset=Platform.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    application_groups = serializers.SerializerMethodField()
    application_group_ids = TenantScopedPrimaryKeyRelatedField(
        queryset=ApplicationGroup.objects.all(), many=True, write_only=True, required=False,
    )
    add_tags = TagSerializer(many=True, read_only=True)
    add_tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="add_tags", queryset=Tag.objects.all(), many=True,
        write_only=True, required=False,
    )
    cf_values = serializers.DictField(required=False)
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(), write_only=True, required=False, many=True,
    )
    assignment_count = serializers.SerializerMethodField()
    child_count = serializers.SerializerMethodField()
    effective = serializers.SerializerMethodField()

    class Meta:
        model = DeviceProfile
        fields = [
            "id", "name", "slug", "description", "color", "parent", "parent_id", "path",
            "applies_to_devices", "applies_to_vms", "platform", "platform_id",
            "runbook_url", "notes", "application_groups", "application_group_ids",
            "add_tags", "add_tag_ids", "cf_values", "tags", "tag_ids", "custom_fields",
            "assignment_count", "child_count", "effective", "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_parent(self, obj):
        return _ref(obj.parent, "slug", "color")

    def get_path(self, obj) -> str:
        return _path(obj)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_platform(self, obj):
        return _ref(obj.platform, "slug")

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_application_groups(self, obj):
        return [{"id": str(r.group_id), "name": r.group.name, "slug": r.group.slug}
                for r in obj.application_group_items.all()]

    def get_assignment_count(self, obj) -> int:
        from api.serializers import _visible_count

        n = getattr(obj, "assignment_count_annotated", None)
        return n if n is not None else _visible_count(self, obj, "assignments")

    def get_child_count(self, obj) -> int:
        n = getattr(obj, "child_count_annotated", None)
        return n if n is not None else obj.children.count()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_effective(self, obj):
        """The profile with its parents applied, each item naming the profile
        it comes from. On a single profile only."""
        view = self.context.get("view")
        if getattr(view, "action", None) != "retrieve":
            return None
        out = {kind: [] for kind, _label in engine.SECTIONS}
        for item in engine.profile_items(obj, None):
            row = {"label": item.label, "from": item.source.name,
                   "inherited": item.source.pk != obj.pk}
            if item.kind == engine.KIND_CF:
                row["value"] = item.value
            out[item.kind].append(row)
        return out

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("A name is required.")
        return value

    def validate_color(self, value):
        if value and not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            raise serializers.ValidationError(
                "Enter a 7-char hex colour like #10b981, or leave it empty.")
        return (value or "").lower()

    def validate_application_group_ids(self, value):
        seen = set()
        for g in value:
            if g.pk in seen:
                raise serializers.ValidationError(f"{g.name} is listed twice.")
            seen.add(g.pk)
        return value

    def validate_add_tag_ids(self, value):
        from core.effective_settings import separation_enabled

        tenant = self._tenant()
        if tenant is not None and separation_enabled(tenant):
            local = [t.name for t in value if t.owning_site_id]
            if local:
                raise serializers.ValidationError(
                    f"Site-local tags cannot go on a profile: {', '.join(local)}.")
        return value

    def _tenant(self):
        request = self.context.get("request")
        return _get_active_tenant(request) if request is not None else None

    def _check_parent(self, parent):
        if parent is None:
            return
        inst = self.instance
        chain = parent.chain()
        if inst is not None and any(p.pk == inst.pk for p in chain):
            raise ValidationError({"parent_id": "A profile cannot be its own ancestor."})
        if len(chain) > MAX_DEPTH or (chain and chain[0].parent_id is not None):
            raise ValidationError({"parent_id": f"Profiles nest at most {MAX_DEPTH} deep."})
        height = _height(inst) if inst is not None else 1
        if len(chain) + height > MAX_DEPTH:
            raise ValidationError({"parent_id": f"Profiles nest at most {MAX_DEPTH} deep."})

    def _check_cf_values(self, values, devices: bool, vms: bool):
        from customization.cf_validation import _coerce
        from customization.models import CustomField

        tenant = self._tenant()
        if tenant is None or not values:
            return values
        if not isinstance(values, dict):
            raise ValidationError({"cf_values": "Must be an object."})
        defs = {d.key: d for d in CustomField.objects.filter(tenant=tenant)}
        kinds = [k for k, on in (("device", devices), ("virtualmachine", vms)) if on]
        cleaned, errors = {}, {}
        for key, raw in values.items():
            d = defs.get(key)
            if d is None:
                errors[key] = "No such custom field."
                continue
            wrong = [k for k in kinds if k not in (d.applies_to or [])]
            if wrong:
                errors[key] = ("Not a field of virtual machines." if wrong == ["virtualmachine"]
                               else "Not a field of devices.")
                continue
            if engine.blank(raw):
                continue
            ok, coerced, msg = _coerce(d, raw, tenant)
            if not ok:
                errors[key] = msg
            else:
                cleaned[key] = coerced
        if errors:
            raise ValidationError({"cf_values": errors})
        return cleaned

    def validate(self, attrs):
        inst = self.instance
        if "parent" in attrs:
            self._check_parent(attrs["parent"])
        devices = attrs.get("applies_to_devices",
                            inst.applies_to_devices if inst else True)
        vms = attrs.get("applies_to_vms", inst.applies_to_vms if inst else True)
        if not (devices or vms):
            raise ValidationError(
                {"applies_to_devices": "A profile applies to devices, VMs or both."})
        if "cf_values" in attrs or ("applies_to_devices" in attrs or "applies_to_vms" in attrs):
            values = attrs.get("cf_values", inst.cf_values if inst else {})
            attrs["cf_values"] = self._check_cf_values(values, devices, vms)
        return attrs

    def _save_sections(self, profile, groups, add_tags):
        if add_tags is not None:
            profile.add_tags.set(add_tags)
        if groups is None:
            return
        current = {r.group_id: r for r in profile.application_group_items.all()}
        wanted = [g.pk for g in groups]
        for gid, row in current.items():
            if gid not in wanted:
                row.delete()
        for position, g in enumerate(groups):
            row = current.get(g.pk)
            if row is None:
                DeviceProfileApplicationGroup(
                    tenant_id=profile.tenant_id, profile=profile, group=g, position=position,
                ).save()
            elif row.position != position:
                row.position = position
                row.save(update_fields=["position"])
        # The prefetch predates the write.
        getattr(profile, "_prefetched_objects_cache", {}).pop("application_group_items", None)

    def create(self, validated_data):
        groups = validated_data.pop("application_group_ids", None)
        add_tags = validated_data.pop("add_tags", None)
        with transaction.atomic():
            profile = super().create(validated_data)
            self._save_sections(profile, groups, add_tags)
        return profile

    def update(self, instance, validated_data):
        groups = validated_data.pop("application_group_ids", None)
        add_tags = validated_data.pop("add_tags", None)
        with transaction.atomic():
            profile = super().update(instance, validated_data)
            self._save_sections(profile, groups, add_tags)
        return profile


def _height(profile) -> int:
    """Levels in ``profile``'s subtree, itself included."""
    level, frontier = 1, [profile.pk]
    while True:
        frontier = list(DeviceProfile.objects.filter(parent_id__in=frontier)
                        .values_list("pk", flat=True))
        if not frontier or level > MAX_DEPTH:
            return level
        level += 1


def _slug_for(serializer, tenant):
    from django.utils.text import slugify

    data = serializer.validated_data
    inst = serializer.instance
    name = data.get("name") or (inst.name if inst else "")
    # A rename without a slug keeps the slug: inventories will key on it.
    slug = data.get("slug") or (inst.slug if inst else "") or slugify(name)[:128]
    if not slug:
        raise ValidationError({"name": "Give it a name with letters or digits."})
    data["slug"] = slug
    clash = DeviceProfile.objects.filter(tenant=tenant, slug=slug)
    if inst is not None:
        clash = clash.exclude(pk=inst.pk)
    if clash.exists():
        raise ValidationError({"slug": "Name already in use."})


class _HostSerializer(serializers.Serializer):
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), required=False, allow_null=True,
    )
    virtual_machine_id = TenantScopedPrimaryKeyRelatedField(
        source="virtual_machine", queryset=VirtualMachine.objects.all(),
        required=False, allow_null=True,
    )

    def validate(self, attrs):
        if (attrs.get("device") is None) == (attrs.get("virtual_machine") is None):
            raise serializers.ValidationError(
                {"device_id": "Name exactly one device or virtual machine."})
        return attrs

    @property
    def host(self):
        data = self.validated_data
        return data["device"] if data.get("device") is not None else data["virtual_machine"]


def _require(request, profile, host, op: str) -> None:
    """403 naming what the caller lacks for ``op`` on ``host``."""
    needs = [(engine.host_slug(host), "view"), *engine.required_permissions(profile, host, op)]
    missing = engine.missing_permissions(request.user, _get_active_tenant(request), needs, host)
    if missing:
        raise PermissionDenied(engine.missing_text(missing))


def _refuse(exc: engine.ProfileError):
    return ValidationError({"profile_id": str(exc)})


class DeviceProfileViewSet(SafeBulkDeleteMixin, TenantScopedViewSet):
    rbac_action_map = {"bulk_delete": "delete", "preview": "view"}
    queryset = DeviceProfile.objects.select_related("parent", "platform").order_by(natural("name"))
    serializer_class = DeviceProfileSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return DeviceProfileMiniSerializer
        return DeviceProfileSerializer

    @extend_schema(parameters=[
        OpenApiParameter("search", OpenApiTypes.STR, OpenApiParameter.QUERY),
        OpenApiParameter("picker", OpenApiTypes.STR, OpenApiParameter.QUERY),
    ] + [
        OpenApiParameter(k, OpenApiTypes.UUID, OpenApiParameter.QUERY)
        for k in ("parent", "application_group", "device", "virtual_machine")
    ])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        qs = super().get_queryset()
        if self.get_serializer_class() is DeviceProfileSerializer:
            qs = qs.prefetch_related(
                TAGS, "add_tags",
                Prefetch("application_group_items",
                         queryset=DeviceProfileApplicationGroup.objects.select_related("group")),
            ).annotate(
                assignment_count_annotated=_visible_n(self, "assignments"),
                child_count_annotated=_all_n(DeviceProfile, "children"),
            )
        if not self.request:
            return qs
        params = self.request.query_params
        s = params.get("search", "").strip()
        if s:
            qs = qs.filter(Q(name__icontains=s) | Q(slug__icontains=s)
                           | Q(description__icontains=s) | cf_text_q(qs.model, s))
        parent = _uuid_param(params, "parent")
        if parent:
            qs = qs.filter(parent_id=parent)
        group = _uuid_param(params, "application_group")
        if group:
            qs = qs.filter(application_group_items__group_id=group)
        joined = bool(group)
        for key in ("device", "virtual_machine"):
            v = _uuid_param(params, key)
            if v:
                qs = qs.filter(**{f"assignments__{key}_id": v})
                joined = True
        return qs.distinct() if joined else qs

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        _slug_for(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        _slug_for(serializer, self._tenant_or_403())
        serializer.save()

    @staticmethod
    def _held(objects: int, children: int) -> str | None:
        if objects:
            return (f"Assigned to {objects} object{'s' if objects != 1 else ''}: "
                    "unassign it first.")
        if children:
            return (f"{children} child profile{'s' if children != 1 else ''} inherit "
                    "from it: move or delete them first.")
        return None

    def bulk_blockers(self, rows) -> dict:
        from django.db.models import Count

        ids = [r.pk for r in rows]
        objects = dict(DeviceProfileAssignment.objects.filter(profile_id__in=ids)
                       .values("profile_id").annotate(n=Count("pk"))
                       .values_list("profile_id", "n"))
        children = dict(DeviceProfile.objects.filter(parent_id__in=ids)
                        .values("parent_id").annotate(n=Count("pk"))
                        .values_list("parent_id", "n"))
        return {pk: why for pk in ids
                if (why := self._held(objects.get(pk, 0), children.get(pk, 0)))}

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        why = self._held(obj.assignments.count(), obj.children.count())
        if why:
            return Response({"detail": why}, status=drf_status.HTTP_409_CONFLICT)
        return super().destroy(request, *args, **kwargs)

    @extend_schema(summary="Preview assigning a profile", request=_HostSerializer,
                   responses={200: OpenApiTypes.OBJECT})
    @action(detail=True, methods=["post"])
    def preview(self, request, pk=None):
        """``{device_id | virtual_machine_id}`` → per section what assigning
        would create, change and skip, plus the permissions the caller lacks.
        Nothing is written."""
        profile = self.get_object()
        ser = _HostSerializer(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        host = ser.host
        tenant = _get_active_tenant(request)
        if engine.missing_permissions(request.user, tenant,
                                      [(engine.host_slug(host), "view")], host):
            raise ValidationError({"device_id": "No such object."})
        return Response(engine.preview(profile, host, user=request.user, tenant=tenant))


# ─── assignments ─────────────────────────────────────────────────────────────


class DeviceProfileAssignmentSerializer(serializers.ModelSerializer):
    profile = serializers.SerializerMethodField()
    profile_id = TenantScopedPrimaryKeyRelatedField(
        source="profile", queryset=DeviceProfile.objects.all(), write_only=True,
    )
    device = serializers.SerializerMethodField()
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    virtual_machine = serializers.SerializerMethodField()
    virtual_machine_id = TenantScopedPrimaryKeyRelatedField(
        source="virtual_machine", queryset=VirtualMachine.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    position = serializers.IntegerField(min_value=0, required=False)
    created_by = serializers.SerializerMethodField()

    class Meta:
        model = DeviceProfileAssignment
        fields = ["id", "profile", "profile_id", "device", "device_id", "virtual_machine",
                  "virtual_machine_id", "position", "state", "missing_count", "edited_count",
                  "reconciled_at", "created_by", "created_at"]
        read_only_fields = ["id", "state", "missing_count", "edited_count", "reconciled_at",
                            "created_by", "created_at"]
        validators = []

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_profile(self, obj):
        p = obj.profile
        return {"id": str(p.pk), "name": p.name, "slug": p.slug, "color": p.color}

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_device(self, obj):
        return _ref(obj.device)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_virtual_machine(self, obj):
        return _ref(obj.virtual_machine)

    def get_created_by(self, obj) -> str | None:
        return obj.created_by.get_username() if obj.created_by_id else None

    def validate(self, attrs):
        if self.instance is not None:
            unknown = set(attrs) - {"position"}
            if unknown:
                raise ValidationError({k: "Only the position changes; unassign instead."
                                       for k in unknown})
            return attrs
        if (attrs.get("device") is None) == (attrs.get("virtual_machine") is None):
            raise ValidationError(
                {"device_id": "Assign to exactly one device or virtual machine."})
        return attrs


class _HostProfilesSerializer(_HostSerializer):
    profile_ids = TenantScopedPrimaryKeyRelatedField(
        source="profiles", queryset=DeviceProfile.objects.all(), many=True,
    )

    def validate(self, attrs):
        attrs = super().validate(attrs)
        ids = [p.pk for p in attrs["profiles"]]
        if len(ids) != len(set(ids)):
            raise ValidationError({"profile_ids": "A profile is listed twice."})
        return attrs


class _BulkSerializer(serializers.Serializer):
    profile_id = TenantScopedPrimaryKeyRelatedField(
        source="profile", queryset=DeviceProfile.objects.all())
    action = serializers.ChoiceField(choices=["assign", "unassign"])
    device_ids = serializers.ListField(child=serializers.UUIDField(), required=False,
                                       max_length=BULK_MAX)
    virtual_machine_ids = serializers.ListField(child=serializers.UUIDField(),
                                                required=False, max_length=BULK_MAX)

    def validate(self, attrs):
        if bool(attrs.get("device_ids")) == bool(attrs.get("virtual_machine_ids")):
            raise ValidationError(
                {"device_ids": "Name devices or virtual machines, not both."})
        return attrs


def bulk_one(user, tenant, profile, host, act: str) -> str:
    """One object of a bulk request: the outcome word."""
    hk = engine.host_kwargs(host)
    try:
        if act == "assign":
            if DeviceProfileAssignment.objects.filter(profile=profile, **hk).exists():
                return "unchanged"
            needs = [(engine.host_slug(host), "view"),
                     *engine.required_permissions(profile, host, "assign")]
            if engine.missing_permissions(user, tenant, needs, host):
                return "denied"
            engine.assign(profile, host, user=user)
            return "assigned"
        a = DeviceProfileAssignment.objects.filter(profile=profile, **hk).first()
        if a is None:
            return "unchanged"
        needs = [(engine.host_slug(host), "view"),
                 *engine.required_permissions(profile, host, "unassign")]
        if engine.missing_permissions(user, tenant, needs, host):
            return "denied"
        engine.unassign(a)
        return "unassigned"
    except engine.ProfileError:
        return "refused"


class DeviceProfileAssignmentViewSet(TenantScopedViewSet):
    rbac_action_map = {"set_profiles": "add", "bulk": "add", "reapply": "change"}
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]
    queryset = (
        DeviceProfileAssignment.objects
        .select_related("profile", "device", "virtual_machine", "created_by")
        .order_by("position", "created_at")
    )
    serializer_class = DeviceProfileAssignmentSerializer
    pagination_class = StandardPagination

    @extend_schema(parameters=[
        OpenApiParameter(k, OpenApiTypes.UUID, OpenApiParameter.QUERY)
        for k in ("profile", "device", "virtual_machine")
    ])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        params = self.request.query_params
        for key in ("profile", "device", "virtual_machine"):
            v = _uuid_param(params, key)
            if v:
                qs = qs.filter(**{f"{key}_id": v})
        return qs

    @staticmethod
    def _created(result) -> list[dict]:
        return [{"kind": i.kind, "label": i.label, "from": i.source.name}
                for i in result.created]

    @extend_schema(responses={201: OpenApiTypes.OBJECT})
    def create(self, request, *args, **kwargs):
        self._tenant_or_403()
        ser = self.get_serializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        host = data.get("device") or data.get("virtual_machine")
        profile = data["profile"]
        try:
            engine.check_applies(profile, host)
        except engine.ProfileError as exc:
            raise _refuse(exc) from None
        _require(request, profile, host, "assign")
        try:
            assignment, result = engine.assign(profile, host, position=data.get("position"),
                                               user=request.user)
        except engine.ProfileError as exc:
            raise _refuse(exc) from None
        return Response({
            "assignment": self.get_serializer(assignment).data,
            "created": self._created(result),
        }, status=drf_status.HTTP_201_CREATED)

    def perform_update(self, serializer):
        with transaction.atomic():
            assignment = serializer.save()
            engine.sync_host(assignment.parent)
        assignment.refresh_from_db()

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        _require(request, obj.profile, obj.parent, "unassign")
        return Response(engine.unassign(obj))

    @extend_schema(summary="Re-apply a profile", request=None,
                   responses={200: OpenApiTypes.OBJECT})
    @action(detail=True, methods=["post"])
    def reapply(self, request, pk=None):
        """Bring the object in line with its profiles and restore what this
        assignment wrote and someone removed."""
        obj = self.get_object()
        _require(request, obj.profile, obj.parent, "reapply")
        result = engine.reapply(obj)
        obj.refresh_from_db()
        return Response({
            "assignment": self.get_serializer(obj).data,
            "created": self._created(result),
            "changed": [{"kind": i.kind, "label": i.label} for i in result.changed],
        })

    @extend_schema(summary="Set an object's device profiles", request=_HostProfilesSerializer,
                   responses={200: OpenApiTypes.OBJECT})
    @action(detail=False, methods=["post"], url_path="set")
    def set_profiles(self, request):
        """``{device_id | virtual_machine_id, profile_ids}``: the object's
        profiles become exactly the list, in its order."""
        ser = _HostProfilesSerializer(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        host, profiles = ser.host, ser.validated_data["profiles"]
        have = {a.profile_id: a for a in DeviceProfileAssignment.objects.filter(
            **engine.host_kwargs(host)).select_related("profile")}
        wanted = {p.pk for p in profiles}
        for a in have.values():
            if a.profile_id not in wanted:
                _require(request, a.profile, host, "unassign")
        for p in profiles:
            if p.pk not in have:
                _require(request, p, host, "assign")
            elif have[p.pk].position != profiles.index(p):
                _require_change(request, have[p.pk])
        try:
            out = engine.set_host_profiles(profiles, host, user=request.user)
        except engine.ProfileError as exc:
            raise _refuse(exc) from None
        rows = self.get_queryset().filter(**engine.host_kwargs(host))
        return Response({
            "assigned": [str(i) for i in out["assigned"]],
            "unassigned": [str(i) for i in out["unassigned"]],
            "results": self.get_serializer(rows, many=True).data,
        })

    @extend_schema(summary="Assign or unassign a profile on many objects",
                   request=_BulkSerializer, responses={200: OpenApiTypes.OBJECT,
                                                       202: OpenApiTypes.OBJECT})
    @action(detail=False, methods=["post"])
    def bulk(self, request):
        """``{profile_id, action: assign|unassign, device_ids |
        virtual_machine_ids}``. Up to :data:`BULK_INLINE` objects answer
        inline with each outcome; more run as a background job (``job_id``)."""
        from auth_api import rbac

        tenant = self._tenant_or_403()
        ser = _BulkSerializer(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        act = data["action"]
        if act == "unassign" and not rbac.has_action(
                request.user, tenant, "deviceprofileassignment", "delete"):
            raise PermissionDenied("You may not delete device profile assignments.")
        model, ids = ((Device, data["device_ids"]) if data.get("device_ids")
                      else (VirtualMachine, data["virtual_machine_ids"]))
        ids = list(dict.fromkeys(ids))
        hosts = {h.pk: h for h in model.objects.filter(tenant=tenant, pk__in=ids)}
        foreign = [str(i) for i in ids if i not in hosts]
        if foreign:
            key = "device_ids" if model is Device else "virtual_machine_ids"
            raise ValidationError({key: f"Not found: {', '.join(foreign[:5])}."})
        profile = data["profile"]
        if len(ids) > BULK_INLINE:
            from audit.context import current_request_id, current_via

            from .tasks import enqueue_bulk

            job_id = enqueue_bulk(tenant.pk, request.user.pk, profile.pk, act,
                                  model._meta.model_name, [str(i) for i in ids],
                                  via=current_via(), request_id=current_request_id())
            return Response({"job_id": job_id, "count": len(ids)},
                            status=drf_status.HTTP_202_ACCEPTED)
        results, counts = [], {}
        for i in ids:
            outcome = bulk_one(request.user, tenant, profile, hosts[i], act)
            counts[outcome] = counts.get(outcome, 0) + 1
            results.append({"id": str(i), "name": hosts[i].name, "outcome": outcome})
        return Response({"results": results, "counts": counts})


def _require_change(request, assignment) -> None:
    from auth_api import rbac

    if not rbac.can_act_on(request.user, _get_active_tenant(request),
                           "deviceprofileassignment", "change", assignment):
        raise PermissionDenied("You may not reorder this object's profiles.")
