"""Application groups over the API (#436).

* ``/api/application-groups/`` - named sets of applications ("RDS",
  "SCADA"): CRUD, ``?picker=1``, ``?search=``, ``?application=``,
  ``?device=``, ``?virtual_machine=``, ``bulk-delete``. ``members`` is a
  writable ordered list of ``{application_id, version}``; writing it adds,
  removes and re-versions members, and the installs on every assigned host
  follow (``api.applications.set_members``). A delete is refused (409) while
  the group is assigned anywhere.
* ``/api/application-group-assignments/`` - a group on one device or VM:
  list, ``POST`` (assign: records the members' installs), ``DELETE``
  (unassign: removes the untouched installs the group made), ``?group=``,
  ``?device=``, ``?virtual_machine=``. ``POST set/ {device_id |
  virtual_machine_id, group_ids}`` makes a host's groups exactly the list.

Groups are tenant-wide, like applications. An assignment belongs to its
device's or VM's site (``SITE_PATHS["applicationgroupassignment"]``). Assigning
also takes ``add`` on installed software at that site, unassigning ``delete``:
the installs are written as the caller.
"""
from __future__ import annotations

from django.db import IntegrityError, transaction
from django.db.models import Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_field
from rest_framework import serializers
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from core.models import Tag
from core.tags import TAGS

from . import applications as sync
from .applications_api import PATH_SEP, _paths, _uuid_param
from .bulk_delete import SafeBulkDeleteMixin
from .cf_search import cf_text_q
from .models import (
    Application,
    ApplicationGroup,
    ApplicationGroupAssignment,
    ApplicationGroupMember,
    Device,
    InstalledSoftware,
    VirtualMachine,
)
from .natural import natural
from .serializers import (
    CustomFieldsSerializerMixin,
    NumIdModelSerializer,
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
)
from .views import _get_active_tenant
from .viewsets import StandardPagination, TenantScopedViewSet, _all_n, _visible_n


def _app_ref(context, app) -> dict:
    names = _paths(context, app.tenant_id).get(app.pk) or [app.name]
    return {"id": str(app.id), "name": app.name, "slug": app.slug,
            "path": PATH_SEP.join(names)}


def _host_ref(obj) -> dict | None:
    return {"id": str(obj.id), "name": obj.name} if obj is not None else None


class ApplicationGroupMiniSerializer(NumIdModelSerializer):
    class Meta:
        model = ApplicationGroup
        fields = ["id", "name", "slug"]


class ApplicationGroupMemberSerializer(serializers.ModelSerializer):
    application = serializers.SerializerMethodField()
    application_id = TenantScopedPrimaryKeyRelatedField(
        source="application", queryset=Application.objects.all(), write_only=True,
    )
    version = serializers.CharField(max_length=64, required=False, allow_blank=True,
                                    default="")

    class Meta:
        model = ApplicationGroupMember
        fields = ["id", "application", "application_id", "version", "position"]
        read_only_fields = ["id", "position"]
        validators = []

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_application(self, obj):
        return _app_ref(self.context, obj.application)

    def validate_version(self, value):
        return (value or "").strip()


class ApplicationGroupSerializer(
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer,
):
    cf_model = "applicationgroup"

    slug = serializers.SlugField(required=False, allow_blank=True)
    members = ApplicationGroupMemberSerializer(many=True, required=False)
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    member_count = serializers.SerializerMethodField()
    host_count = serializers.SerializerMethodField()
    install_count = serializers.SerializerMethodField()

    class Meta:
        model = ApplicationGroup
        fields = ["id", "name", "slug", "description", "members", "member_count",
                  "host_count", "install_count", "tags", "tag_ids", "custom_fields",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "member_count", "host_count", "install_count",
                            "created_at", "updated_at"]

    def get_member_count(self, obj) -> int:
        n = getattr(obj, "member_count_annotated", None)
        return n if n is not None else obj.members.count()

    def get_host_count(self, obj) -> int:
        from .serializers import _visible_count

        n = getattr(obj, "host_count_annotated", None)
        return n if n is not None else _visible_count(self, obj, "assignments")

    def get_install_count(self, obj) -> int:
        from .serializers import _visible_count

        n = getattr(obj, "install_count_annotated", None)
        return n if n is not None else _visible_count(self, obj, "installs")

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("A name is required.")
        return value

    def validate_members(self, value):
        seen = set()
        for row in value:
            app = row["application"]
            if app.pk in seen:
                raise serializers.ValidationError(f"{app.name} is listed twice.")
            seen.add(app.pk)
        return value

    def _save_members(self, group, rows):
        if rows is None:
            return
        sync.set_members(group, [(r["application"], r.get("version", "")) for r in rows])

    def create(self, validated_data):
        rows = validated_data.pop("members", None)
        with transaction.atomic():
            group = super().create(validated_data)
            self._save_members(group, rows)
        return group

    def update(self, instance, validated_data):
        rows = validated_data.pop("members", None)
        with transaction.atomic():
            group = super().update(instance, validated_data)
            self._save_members(group, rows)
        return group


def _slug_for(serializer, tenant):
    from django.utils.text import slugify

    data = serializer.validated_data
    inst = serializer.instance
    name = data.get("name") or (inst.name if inst else "")
    # A rename without a slug keeps the slug: inventories key on it.
    slug = data.get("slug") or (inst.slug if inst else "") or slugify(name)[:128]
    if not slug:
        raise ValidationError({"name": "Give it a name with letters or digits."})
    data["slug"] = slug
    clash = ApplicationGroup.objects.filter(tenant=tenant, slug=slug)
    if inst is not None:
        clash = clash.exclude(pk=inst.pk)
    if clash.exists():
        raise ValidationError({"slug": "Name already in use."})


class ApplicationGroupViewSet(SafeBulkDeleteMixin, TenantScopedViewSet):
    rbac_action_map = {"bulk_delete": "delete"}
    queryset = ApplicationGroup.objects.all().order_by(natural("name"))
    serializer_class = ApplicationGroupSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return ApplicationGroupMiniSerializer
        return ApplicationGroupSerializer

    @extend_schema(parameters=[
        OpenApiParameter("search", OpenApiTypes.STR, OpenApiParameter.QUERY),
        OpenApiParameter("picker", OpenApiTypes.STR, OpenApiParameter.QUERY),
    ] + [
        OpenApiParameter(k, OpenApiTypes.UUID, OpenApiParameter.QUERY)
        for k in ("application", "device", "virtual_machine")
    ])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        from django.db.models import Prefetch

        qs = super().get_queryset()
        if self.get_serializer_class() is ApplicationGroupSerializer:
            qs = qs.prefetch_related(
                TAGS,
                Prefetch("members", queryset=ApplicationGroupMember.objects
                         .select_related("application")),
            ).annotate(
                member_count_annotated=_all_n(ApplicationGroup, "members"),
                host_count_annotated=_visible_n(self, "assignments"),
                install_count_annotated=_visible_n(self, "installs"),
            )
        if not self.request:
            return qs
        params = self.request.query_params
        s = params.get("search", "").strip()
        if s:
            qs = qs.filter(Q(name__icontains=s) | Q(slug__icontains=s)
                           | Q(description__icontains=s) | cf_text_q(qs.model, s))
        app = _uuid_param(params, "application")
        if app:
            qs = qs.filter(members__application_id=app)
        for key in ("device", "virtual_machine"):
            v = _uuid_param(params, key)
            if v:
                qs = qs.filter(**{f"assignments__{key}_id": v})
        return qs.distinct() if (app or params.get("device")
                                 or params.get("virtual_machine")) else qs

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        _slug_for(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        _slug_for(serializer, self._tenant_or_403())
        serializer.save()

    @staticmethod
    def _held(hosts: int) -> str | None:
        if not hosts:
            return None
        return f"Assigned to {hosts} host{'s' if hosts != 1 else ''}: unassign it first."

    def bulk_blockers(self, rows) -> dict:
        from django.db.models import Count

        ids = [r.pk for r in rows]
        hosts = dict(
            ApplicationGroupAssignment.objects.filter(group_id__in=ids)
            .values("group_id").annotate(n=Count("pk")).values_list("group_id", "n")
        )
        return {pk: why for pk in ids if (why := self._held(hosts.get(pk, 0)))}

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        why = self._held(obj.assignments.count())
        if why:
            return Response({"detail": why}, status=drf_status.HTTP_409_CONFLICT)
        return super().destroy(request, *args, **kwargs)


# ─── assignments ─────────────────────────────────────────────────────────────


class ApplicationGroupAssignmentSerializer(serializers.ModelSerializer):
    group = serializers.SerializerMethodField()
    group_id = TenantScopedPrimaryKeyRelatedField(
        source="group", queryset=ApplicationGroup.objects.all(), write_only=True,
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
    install_count = serializers.SerializerMethodField()

    class Meta:
        model = ApplicationGroupAssignment
        fields = ["id", "group", "group_id", "device", "device_id", "virtual_machine",
                  "virtual_machine_id", "install_count", "created_at"]
        read_only_fields = ["id", "install_count", "created_at"]
        validators = []

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_group(self, obj):
        g = obj.group
        return {"id": str(g.id), "name": g.name, "slug": g.slug}

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_device(self, obj):
        return _host_ref(obj.device)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_virtual_machine(self, obj):
        return _host_ref(obj.virtual_machine)

    def get_install_count(self, obj) -> int:
        """The installs the group made on this host that are still its."""
        n = getattr(obj, "install_count_annotated", None)
        if n is not None:
            return n
        return InstalledSoftware.objects.filter(group_id=obj.group_id,
                                                **sync._host_of(obj)).count()

    def validate(self, attrs):
        device, vm = attrs.get("device"), attrs.get("virtual_machine")
        if (device is None) == (vm is None):
            raise serializers.ValidationError(
                {"device_id": "Assign to exactly one device or virtual machine."})
        host = {"device": device} if device is not None else {"virtual_machine": vm}
        if ApplicationGroupAssignment.objects.filter(group=attrs["group"], **host).exists():
            raise serializers.ValidationError({"group_id": "Already assigned here."})
        return attrs


class _HostGroupsSerializer(serializers.Serializer):
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), required=False, allow_null=True,
    )
    virtual_machine_id = TenantScopedPrimaryKeyRelatedField(
        source="virtual_machine", queryset=VirtualMachine.objects.all(),
        required=False, allow_null=True,
    )
    group_ids = TenantScopedPrimaryKeyRelatedField(
        source="groups", queryset=ApplicationGroup.objects.all(), many=True,
    )

    def validate(self, attrs):
        if (attrs.get("device") is None) == (attrs.get("virtual_machine") is None):
            raise serializers.ValidationError(
                {"device_id": "Name exactly one device or virtual machine."})
        return attrs


def _require_in_scope(request, model, pks, slug, act):
    """403 unless the caller may ``act`` on every row of ``pks`` - the
    type grant and its site scope."""
    from auth_api import rbac

    user = request.user
    if user.is_superuser:
        return
    pks = list(pks)
    tenant = _get_active_tenant(request)
    if not rbac.has_action(user, tenant, slug, act):
        raise PermissionDenied(f"You may not {act} {model._meta.verbose_name_plural}.")
    if not pks:
        return
    base = model._default_manager.filter(pk__in=pks)
    if rbac.restrict_queryset(base, user, tenant, slug, act).count() != len(set(pks)):
        raise PermissionDenied(
            f"Some {model._meta.verbose_name_plural} are outside your permission scope.")


class ApplicationGroupAssignmentViewSet(TenantScopedViewSet):
    rbac_action_map = {"set_groups": "add"}
    http_method_names = ["get", "post", "delete", "head", "options"]
    queryset = (
        ApplicationGroupAssignment.objects.select_related("group", "device", "virtual_machine")
        .order_by(natural("group__name"))
    )
    serializer_class = ApplicationGroupAssignmentSerializer
    pagination_class = StandardPagination

    @extend_schema(parameters=[
        OpenApiParameter(k, OpenApiTypes.UUID, OpenApiParameter.QUERY)
        for k in ("group", "device", "virtual_machine")
    ])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        params = self.request.query_params
        for key in ("group", "device", "virtual_machine"):
            v = _uuid_param(params, key)
            if v:
                qs = qs.filter(**{f"{key}_id": v})
        return qs

    def perform_create(self, serializer):
        self._tenant_or_403()
        data = serializer.validated_data
        try:
            with transaction.atomic():
                assignment, created = sync.assign_group(
                    data["group"], device=data.get("device"),
                    virtual_machine=data.get("virtual_machine"),
                )
                _require_in_scope(self.request, InstalledSoftware,
                                  [i.pk for i in created], "installedsoftware", "add")
        except IntegrityError:
            raise ValidationError({"group_id": "Already assigned here."}) from None
        serializer.instance = assignment

    def _release_check(self, assignments):
        pks = InstalledSoftware.objects.filter(_installs_q(assignments)).values_list(
            "pk", flat=True)
        _require_in_scope(self.request, InstalledSoftware, pks, "installedsoftware", "delete")

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        with transaction.atomic():
            self._release_check([obj])
            counts = sync.unassign_group(obj)
        return Response(counts)

    @extend_schema(
        summary="Set a host's application groups",
        request=_HostGroupsSerializer, responses={200: OpenApiTypes.OBJECT},
    )
    @action(detail=False, methods=["post"], url_path="set")
    def set_groups(self, request):
        """``{device_id | virtual_machine_id, group_ids}``: assign the
        missing groups, unassign the others."""
        ser = _HostGroupsSerializer(data=request.data, context=self.get_serializer_context())
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        host = ({"device": data["device"]} if data.get("device") is not None
                else {"virtual_machine": data["virtual_machine"]})
        wanted = {g.pk for g in data["groups"]}
        with transaction.atomic():
            gone = list(ApplicationGroupAssignment.objects.filter(**host)
                        .exclude(group_id__in=wanted))
            if gone:
                _require_in_scope(request, ApplicationGroupAssignment,
                                  [a.pk for a in gone], "applicationgroupassignment", "delete")
                self._release_check(gone)
            before = set(InstalledSoftware.objects.filter(**host).values_list("pk", flat=True))
            out = sync.set_host_groups(data["groups"], **host)
            new = ApplicationGroupAssignment.objects.filter(
                group_id__in=out["assigned"], **host).values_list("pk", flat=True)
            _require_in_scope(request, ApplicationGroupAssignment, new,
                              "applicationgroupassignment", "add")
            made = set(InstalledSoftware.objects.filter(**host).values_list("pk", flat=True))
            _require_in_scope(request, InstalledSoftware, made - before,
                              "installedsoftware", "add")
        rows = self.get_queryset().filter(**host)
        return Response({
            "assigned": [str(g) for g in out["assigned"]],
            "unassigned": [str(g) for g in out["unassigned"]],
            "results": self.get_serializer(rows, many=True).data,
        })


def _installs_q(assignments) -> Q:
    """The installs the assignments' groups made on their hosts."""
    q = Q(pk__in=[])
    for a in assignments:
        q |= Q(group_id=a.group_id, **sync._host_of(a))
    return q
