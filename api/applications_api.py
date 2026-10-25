"""Applications and installed software over the API (#436).

* ``/api/applications/`` - the tenant's application catalog: CRUD,
  ``?picker=1``, ``?search=``, ``?manufacturer=``, ``?parent=`` (``none`` for
  the roots), ``bulk-delete``. A delete is refused (409) while the
  application has installs or child applications.
* ``/api/applications/<id>/eol/`` - ``PUT {source?, product}`` names the
  end-of-life product, ``DELETE`` clears it; 404 while the feature is off.
* ``/api/installed-software/`` - one application at one version on a device
  or a virtual machine: CRUD, ``?device=``, ``?virtual_machine=``,
  ``?application=``, ``?service=``, ``?search=``, ``bulk-delete``.

Applications are tenant-wide, like platforms. An install belongs to its
device's or VM's site (``SITE_PATHS["installedsoftware"]``), so a site editor
records software on the devices of their own sites only. Every reference -
application, device, VM, service - must be the caller's tenant's.
"""
from __future__ import annotations

import uuid

from django.db.models import Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_field
from rest_framework import serializers
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response

from core.models import Tag
from core.tags import TAGS

from .bulk_delete import SafeBulkDeleteMixin
from .cf_search import cf_text_q
from .models import Application, Device, InstalledSoftware, Manufacturer, Service, VirtualMachine
from .natural import natural
from .serializers import (
    CustomFieldsSerializerMixin,
    ManufacturerMiniSerializer,
    NumIdModelSerializer,
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
    _eol_config,
    _visible_count,
)
from .viewsets import StandardPagination, TenantScopedViewSet, _visible_n

#: How a tree path reads: "Payments › Checkout › checkout-api".
PATH_SEP = " › "


def _paths(context, tenant_id) -> dict:
    """``{application id: [names root → leaf]}`` for a tenant, read once per
    serializer context - one query however many rows show a path."""
    memo = context.setdefault("_application_paths", {})
    got = memo.get(tenant_id)
    if got is None:
        rows = {
            r["id"]: r for r in Application.objects.filter(tenant_id=tenant_id)
            .values("id", "name", "parent_id")
        }
        got = {}
        for pk in rows:
            names, node, seen = [], rows.get(pk), set()
            while node is not None and node["id"] not in seen:
                seen.add(node["id"])
                names.append(node["name"])
                node = rows.get(node["parent_id"])
            got[pk] = names[::-1]
        memo[tenant_id] = got
    return got


class _PathMixin:
    def get_path(self, obj) -> str:
        names = _paths(self.context, obj.tenant_id).get(obj.pk) or [obj.name]
        return PATH_SEP.join(names)

    def get_depth(self, obj) -> int:
        return len(_paths(self.context, obj.tenant_id).get(obj.pk) or [obj.name]) - 1


class ApplicationMiniSerializer(_PathMixin, NumIdModelSerializer):
    path = serializers.SerializerMethodField()
    depth = serializers.SerializerMethodField()

    class Meta:
        model = Application
        fields = ["id", "name", "slug", "path", "depth"]


def _eol_block(app, cfg) -> dict | None:
    """The application's end-of-life block: its product and the cycles its
    installs run, each with the facts as of the last refresh. ``None`` while
    the feature is off."""
    if not cfg.enabled:
        return None
    from compliance.eol import status_of

    if not (app.eol_source and app.eol_product):
        return {"source": None, "product": None, "cycles": []}
    cycles = sorted(app.eol_mappings.all(), key=lambda m: m.cycle, reverse=True)
    return {
        "source": app.eol_source,
        "product": app.eol_product,
        "cycles": [
            {
                "cycle": m.cycle, "status": status_of(m, cfg.warning_days),
                "release_date": m.release_date, "support_until": m.support_until,
                "eol_date": m.eol_date, "lts": m.lts, "latest_version": m.latest_version,
                "synced_at": m.synced_at, "missing": m.missing,
            }
            for m in cycles
        ],
    }


class ApplicationSerializer(
    _PathMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer,
):
    cf_model = "application"

    slug = serializers.SlugField(required=False, allow_blank=True)
    parent = serializers.SerializerMethodField()
    parent_id = TenantScopedPrimaryKeyRelatedField(
        source="parent", queryset=Application.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    path = serializers.SerializerMethodField()
    depth = serializers.SerializerMethodField()
    manufacturer = ManufacturerMiniSerializer(read_only=True)
    manufacturer_id = TenantScopedPrimaryKeyRelatedField(
        source="manufacturer", queryset=Manufacturer.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    eol = serializers.SerializerMethodField()
    install_count = serializers.SerializerMethodField()
    child_count = serializers.SerializerMethodField()

    class Meta:
        model = Application
        fields = ["id", "name", "slug", "parent", "parent_id", "path", "depth",
                  "manufacturer", "manufacturer_id", "eol_source", "eol_product", "eol",
                  "description", "tags", "tag_ids", "custom_fields",
                  "install_count", "child_count", "created_at", "updated_at"]
        # The product is set through /eol/, which also redoes the installs.
        read_only_fields = ["id", "eol_source", "eol_product", "install_count",
                            "child_count", "created_at", "updated_at"]

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_parent(self, obj):
        p = obj.parent
        return {"id": str(p.id), "name": p.name} if p else None

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_eol(self, obj):
        return _eol_block(obj, _eol_config(self.context))

    def get_install_count(self, obj) -> int:
        n = getattr(obj, "install_count_annotated", None)
        return n if n is not None else _visible_count(self, obj, "installs")

    def get_child_count(self, obj) -> int:
        n = getattr(obj, "child_count_annotated", None)
        return n if n is not None else obj.children.count()

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("A name is required.")
        return value

    def validate_parent_id(self, value):
        if value is not None and self.instance is not None:
            node, seen = value, set()
            while node is not None and node.pk not in seen:
                if node.pk == self.instance.pk:
                    raise serializers.ValidationError("This would create a cycle.")
                seen.add(node.pk)
                node = node.parent
        return value


def _ref(obj) -> dict | None:
    return {"id": str(obj.id), "name": obj.name} if obj is not None else None


class InstalledSoftwareSerializer(
    CustomFieldsSerializerMixin, TaggableSerializerMixin, NumIdModelSerializer,
):
    cf_model = "installedsoftware"

    application = serializers.SerializerMethodField()
    application_id = TenantScopedPrimaryKeyRelatedField(
        source="application", queryset=Application.objects.all(), write_only=True,
        required=False,
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
    service = serializers.SerializerMethodField()
    service_id = TenantScopedPrimaryKeyRelatedField(
        source="service", queryset=Service.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    cycle = serializers.CharField(max_length=64, required=False, allow_blank=True)
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    eol = serializers.SerializerMethodField()
    effective_release = serializers.SerializerMethodField()
    effective_end = serializers.SerializerMethodField()
    effective_source = serializers.SerializerMethodField()
    list_columns_exclude = ("effective_release", "effective_end", "effective_source")

    class Meta:
        model = InstalledSoftware
        fields = ["id", "application", "application_id", "device", "device_id",
                  "virtual_machine", "virtual_machine_id", "version", "cycle",
                  "cycle_manual", "service", "service_id", "release_date",
                  "end_of_support", "eol", "effective_release", "effective_end",
                  "effective_source", "source", "last_seen", "description",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "cycle_manual", "created_at", "updated_at"]
        validators = []  # the unique set is checked in validate() as a field error

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_application(self, obj):
        a = obj.application
        names = _paths(self.context, a.tenant_id).get(a.pk) or [a.name]
        return {"id": str(a.id), "name": a.name, "slug": a.slug,
                "path": PATH_SEP.join(names)}

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_device(self, obj):
        return _ref(obj.device)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_virtual_machine(self, obj):
        return _ref(obj.virtual_machine)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_service(self, obj):
        return _ref(obj.service)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_eol(self, obj):
        from compliance.eol import payload

        return payload(obj, _eol_config(self.context))

    def _effective(self, obj):
        from compliance.eol import effective_dates, mapping_of

        cfg = _eol_config(self.context)
        return effective_dates(obj.release_date, obj.end_of_support,
                               mapping_of(obj) if cfg.enabled else None, cfg.enabled)

    @extend_schema_field(OpenApiTypes.DATE)
    def get_effective_release(self, obj):
        return self._effective(obj).start

    @extend_schema_field(OpenApiTypes.DATE)
    def get_effective_end(self, obj):
        return self._effective(obj).end

    @extend_schema_field(OpenApiTypes.STR)
    def get_effective_source(self, obj) -> str | None:
        return self._effective(obj).source

    def validate_version(self, value):
        return (value or "").strip()

    def validate_cycle(self, value):
        return (value or "").strip()

    def validate(self, attrs):
        attrs = super().validate(attrs)
        inst = self.instance
        get = lambda k: attrs[k] if k in attrs else getattr(inst, k, None)  # noqa: E731
        app, device, vm = get("application"), get("device"), get("virtual_machine")
        if app is None:
            raise serializers.ValidationError({"application_id": "Pick an application."})
        if (device is None) == (vm is None):
            raise serializers.ValidationError(
                {"device_id": "Install on exactly one device or virtual machine."}
            )
        svc = get("service")
        if svc is not None and (
            svc.device_id != getattr(device, "pk", None)
            or svc.virtual_machine_id != getattr(vm, "pk", None)
        ):
            raise serializers.ValidationError(
                {"service_id": "The service must be on the same device or virtual machine."}
            )
        version = get("version") or ""
        clash = InstalledSoftware.objects.filter(
            application=app, device=device, virtual_machine=vm, version=version,
        )
        if inst is not None:
            clash = clash.exclude(pk=inst.pk)
        if clash.exists():
            raise serializers.ValidationError(
                {"version": "This version is already recorded here."}
            )
        if "cycle" in attrs:
            # A cycle given by hand sticks; a blank one is derived again.
            attrs["cycle_manual"] = bool(attrs["cycle"])
        return attrs


# ─── viewsets ────────────────────────────────────────────────────────────────


def _uuid_param(params, key):
    v = params.get(key)
    if not v:
        return None
    try:
        return uuid.UUID(v)
    except ValueError:
        raise ValidationError({key: "A valid UUID."}) from None


def _slug_for(serializer, tenant):
    from django.utils.text import slugify

    data = serializer.validated_data
    inst = serializer.instance
    name = data.get("name") or (inst.name if inst else "")
    # A rename without a slug keeps the slug: it is the import key.
    slug = data.get("slug") or (inst.slug if inst else "") or slugify(name)[:128]
    if not slug:
        raise ValidationError({"name": "Give it a name with letters or digits."})
    data["slug"] = slug
    clash = Application.objects.filter(tenant=tenant, slug=slug)
    if inst is not None:
        clash = clash.exclude(pk=inst.pk)
    if clash.exists():
        raise ValidationError({"slug": "Name already in use."})


class ApplicationViewSet(SafeBulkDeleteMixin, TenantScopedViewSet):
    rbac_action_map = {"bulk_delete": "delete"}
    queryset = Application.objects.all().order_by(natural("name"))
    serializer_class = ApplicationSerializer
    pagination_class = StandardPagination

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return ApplicationMiniSerializer
        return ApplicationSerializer

    @extend_schema(parameters=[
        OpenApiParameter("search", OpenApiTypes.STR, OpenApiParameter.QUERY),
        OpenApiParameter("manufacturer", OpenApiTypes.UUID, OpenApiParameter.QUERY),
        OpenApiParameter("parent", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         description="An application id, or `none` for the roots."),
        OpenApiParameter("picker", OpenApiTypes.STR, OpenApiParameter.QUERY),
    ])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        qs = super().get_queryset()
        if self.get_serializer_class() is ApplicationSerializer:
            qs = qs.select_related("parent", "manufacturer").prefetch_related(
                TAGS, "eol_mappings",
            ).annotate(
                install_count_annotated=_visible_n(self, "installs"),
                child_count_annotated=_visible_n(self, "children"),
            )
        if not self.request:
            return qs
        params = self.request.query_params
        s = params.get("search", "").strip()
        if s:
            qs = qs.filter(Q(name__icontains=s) | Q(slug__icontains=s)
                           | Q(description__icontains=s) | cf_text_q(qs.model, s))
        mfr = _uuid_param(params, "manufacturer")
        if mfr:
            qs = qs.filter(manufacturer_id=mfr)
        parent = params.get("parent")
        if parent == "none":
            qs = qs.filter(parent__isnull=True)
        elif parent:
            qs = qs.filter(parent_id=_uuid_param(params, "parent"))
        return qs

    def perform_create(self, serializer):
        tenant = self._tenant_or_403()
        _slug_for(serializer, tenant)
        serializer.save(tenant=tenant)

    def perform_update(self, serializer):
        _slug_for(serializer, self._tenant_or_403())
        serializer.save()

    @staticmethod
    def _held(installs: int, children: int) -> str | None:
        parts = []
        if installs:
            parts.append(f"{installs} install{'s' if installs != 1 else ''}")
        if children:
            parts.append(f"{children} child application{'s' if children != 1 else ''}")
        return "In use: " + " and ".join(parts) + "." if parts else None

    def bulk_blockers(self, rows) -> dict:
        from django.db.models import Count

        ids = [r.pk for r in rows]
        installs = dict(
            InstalledSoftware.objects.filter(application_id__in=ids)
            .values("application_id").annotate(n=Count("pk")).values_list("application_id", "n")
        )
        children = dict(
            Application.objects.filter(parent_id__in=ids)
            .values("parent_id").annotate(n=Count("pk")).values_list("parent_id", "n")
        )
        out = {}
        for pk in ids:
            why = self._held(installs.get(pk, 0), children.get(pk, 0))
            if why:
                out[pk] = why
        return out

    def destroy(self, request, *args, **kwargs):
        obj = self.get_object()
        why = self._held(obj.installs.count(), obj.children.count())
        if why:
            return Response({"detail": why}, status=drf_status.HTTP_409_CONFLICT)
        return super().destroy(request, *args, **kwargs)

    @extend_schema(
        summary="An application's end-of-life product",
        request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT},
    )
    @action(detail=True, methods=["get", "put", "delete"], url_path="eol")
    def eol(self, request, pk=None):
        """``PUT {source?, product}`` names the product; each install's
        version picks its cycle. ``DELETE`` clears it. 404 while end-of-life
        data is off."""
        from compliance.eol import load_config
        from compliance.eol_sources import SOURCES
        from compliance.models import EolProduct

        from .applications import set_product

        cfg = load_config()
        if not cfg.enabled:
            raise NotFound("End-of-life data is off.")
        app = self.get_object()
        if request.method == "DELETE":
            set_product(app, "", "")
            return Response(status=drf_status.HTTP_204_NO_CONTENT)
        if request.method == "PUT":
            data = request.data if isinstance(request.data, dict) else {}
            source = str(data.get("source") or next(iter(SOURCES)))
            name = str(data.get("product") or "").strip()
            if source not in SOURCES:
                raise ValidationError({"source": "Unknown source."})
            if not name:
                raise ValidationError({"product": "Pick a product."})
            if not EolProduct.objects.filter(source=source, name=name).exists():
                raise ValidationError({"product": "Not in the catalog - refresh or import it."})
            set_product(app, source, name)
        app = Application.objects.prefetch_related("eol_mappings").get(pk=app.pk)
        return Response(_eol_block(app, cfg))


class InstalledSoftwareViewSet(SafeBulkDeleteMixin, TenantScopedViewSet):
    rbac_action_map = {"bulk_delete": "delete"}
    queryset = (
        InstalledSoftware.objects.select_related(
            "application", "device", "virtual_machine", "service", "eol_mapping",
        )
        .prefetch_related(TAGS)
        .order_by(natural("application__name"), "version")
    )
    serializer_class = InstalledSoftwareSerializer
    pagination_class = StandardPagination

    @extend_schema(parameters=[
        OpenApiParameter(k, OpenApiTypes.UUID, OpenApiParameter.QUERY)
        for k in ("device", "virtual_machine", "application", "service")
    ] + [OpenApiParameter("search", OpenApiTypes.STR, OpenApiParameter.QUERY)])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        params = self.request.query_params
        for key, field in (("device", "device_id"), ("virtual_machine", "virtual_machine_id"),
                           ("application", "application_id"), ("service", "service_id")):
            v = _uuid_param(params, key)
            if v:
                qs = qs.filter(**{field: v})
        s = params.get("search", "").strip()
        if s:
            qs = qs.filter(Q(application__name__icontains=s) | Q(version__icontains=s)
                           | Q(description__icontains=s) | cf_text_q(qs.model, s))
        return qs
