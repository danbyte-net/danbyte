"""Application flow requirements over the API.

``/api/application-flow-requirements/`` - the flows an application needs,
with ends that may be "this application" (its hosts) or "the hosts of
another application" as well as an address, range, prefix or any. CRUD,
``bulk-delete`` and:

* ``?application=``, ``?references=<app>`` (requirements whose host end is
  that application), ``?state=``, ``?search=``;
* ``?device=`` / ``?vm=`` - the requirements that apply to that host through
  its installs, each with a ``host`` block (its flows there and why some
  are missing);
* ``POST <id>/resolve/`` - resolve now (the result, or ``{job}``);
* ``POST preview/`` - what a payload would document, without saving;
* ``GET <id>/gaps/`` - hosts without a usable address (a host the caller
  can't view is counted, not named);
* ``GET``/``POST <id>/exclusions/`` and ``DELETE <id>/exclusions/<eid>/``
  (Restore).

A requirement is a tenant-wide catalog, written by tenant-wide editors and
read by the site roles. Every reference must be the active tenant's. Saving
or deleting one resolves it (``api.flow_requirements``).
"""
from __future__ import annotations

import uuid

from django.db import transaction
from django.db.models import Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_field
from rest_framework import serializers
from rest_framework import status as drf_status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from core.hidden_fields import hidden_related_spec
from core.models import Tag
from core.tags import TAGS

from . import flow_requirements as fr
from .application_flows_api import _PORTLESS, END_SLUGS, clean_ports
from .applications_api import _uuid_param
from .bulk_delete import SafeBulkDeleteMixin
from .cf_search import cf_text_q
from .models import (
    Application,
    ApplicationFlow,
    ApplicationFlowRequirement,
    ApplicationFlowRequirementExclusion,
    InstalledSoftware,
    IPAddress,
    IPRange,
    IPRole,
    Prefix,
    Status,
)
from .natural import natural
from .serializers import (
    CustomFieldsSerializerMixin,
    HiddenRelatedFieldsMixin,
    NumIdModelSerializer,
    StatusSerializerMixin,
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
    _HiddenRelatedListSerializer,
    offered_status,
)
from .viewsets import StandardPagination, TenantScopedViewSet

SIDES = ("source", "destination")
FIXED = ("ip", "range", "prefix")
HOST_KINDS = ApplicationFlowRequirement.HOST_KINDS


def _uuid(v):
    try:
        return uuid.UUID(str(v))
    except (TypeError, ValueError):
        return None


def requirement_end(obj, side: str, viewable=None) -> dict:
    """One end for display: ``{kind, id, label, application, address,
    address_role, hidden}``. A fixed end the caller can't view reads
    Hidden (#453)."""
    kind = getattr(obj, f"{side}_kind")
    out = {"kind": kind, "id": None, "label": "Any", "application": None,
           "address": getattr(obj, f"{side}_address") or None, "address_role": None,
           "hidden": False}
    if kind in HOST_KINDS:
        app = obj.application if kind == "self" else getattr(obj, f"{side}_application")
        if app is not None:
            out["application"] = {"id": str(app.pk), "name": app.name}
        out["label"] = ("This application" if kind == "self"
                        else f"Hosts of {app.name if app else '?'}")
        role = getattr(obj, f"{side}_address_role")
        if role is not None:
            out["address_role"] = {"id": str(role.pk), "name": role.name,
                                   "color": getattr(role, "color", "")}
        return out
    if kind == "any":
        return out
    ref = getattr(obj, f"{side}_{kind}")
    if ref is None:
        out["label"] = "?"
        return out
    if viewable and not viewable.may_view(END_SLUGS[kind], ref.pk):
        return {"kind": kind, "id": None, "label": "Hidden", "application": None,
                "address": None, "address_role": None, "hidden": True}
    out["id"] = str(ref.pk)
    out["label"] = (str(ref.ip_address) if kind == "ip"
                    else f"{ref.start_address}-{ref.end_address}" if kind == "range"
                    else str(ref.cidr))
    return out


class ApplicationFlowRequirementSerializer(
    HiddenRelatedFieldsMixin, CustomFieldsSerializerMixin, StatusSerializerMixin,
    TaggableSerializerMixin, NumIdModelSerializer,
):
    cf_model = "applicationflowrequirement"
    hidden_related = hidden_related_spec("api.applicationflowrequirement")

    application = serializers.SerializerMethodField()
    application_id = TenantScopedPrimaryKeyRelatedField(
        source="application", queryset=Application.objects.all(), write_only=True,
        required=False,
    )
    source = serializers.SerializerMethodField()
    destination = serializers.SerializerMethodField()
    source_application_id = TenantScopedPrimaryKeyRelatedField(
        source="source_application", queryset=Application.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    destination_application_id = TenantScopedPrimaryKeyRelatedField(
        source="destination_application", queryset=Application.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    source_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="source_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    source_range_id = TenantScopedPrimaryKeyRelatedField(
        source="source_range", queryset=IPRange.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    source_prefix_id = TenantScopedPrimaryKeyRelatedField(
        source="source_prefix", queryset=Prefix.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    destination_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="destination_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    destination_range_id = TenantScopedPrimaryKeyRelatedField(
        source="destination_range", queryset=IPRange.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    destination_prefix_id = TenantScopedPrimaryKeyRelatedField(
        source="destination_prefix", queryset=Prefix.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    source_address_role_id = TenantScopedPrimaryKeyRelatedField(
        source="source_address_role", queryset=IPRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    destination_address_role_id = TenantScopedPrimaryKeyRelatedField(
        source="destination_address_role", queryset=IPRole.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    protocol_display = serializers.CharField(source="get_protocol_display", read_only=True)
    direction_display = serializers.CharField(source="get_direction_display", read_only=True)
    exclusions = serializers.SerializerMethodField()
    host = serializers.SerializerMethodField()
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )

    class Meta:
        model = ApplicationFlowRequirement
        fields = [
            "id", "application", "application_id", "name", "description",
            "source", "source_kind", "source_application_id", "source_ip_id",
            "source_range_id", "source_prefix_id", "source_address", "source_address_role_id",
            "destination", "destination_kind", "destination_application_id",
            "destination_ip_id", "destination_range_id", "destination_prefix_id",
            "destination_address", "destination_address_role_id",
            "family", "pairing", "protocol", "protocol_display", "ports",
            "direction", "direction_display", "status", "status_id",
            "state", "state_detail", "generated_count", "gap_count", "resolved_at",
            "exclusions", "host", "tags", "tag_ids", "custom_fields",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "state", "state_detail", "generated_count", "gap_count",
                            "resolved_at", "created_at", "updated_at"]
        validators = []  # the unique name is checked in validate() as a field error
        list_serializer_class = _HiddenRelatedListSerializer

    def hidden_fields(self, obj) -> set[str]:
        # The ends are read through ``source``/``destination``, which hide
        # an end themselves; there is no separate field to drop.
        return set()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_application(self, obj):
        a = obj.application
        return {"id": str(a.pk), "name": a.name, "slug": a.slug}

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_source(self, obj):
        return requirement_end(obj, "source", self._viewable())

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_destination(self, obj):
        return requirement_end(obj, "destination", self._viewable())

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_exclusions(self, obj):
        rows = getattr(obj, "_prefetched_objects_cache", {}).get("exclusions")
        if rows is None:
            rows = obj.exclusions.all()
        return [{"id": str(e.pk), "label": e.label, "binding_key": e.binding_key,
                 "created_at": e.created_at} for e in rows]

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_host(self, obj):
        """The requirement on the host the list was asked for (``?device=``
        or ``?vm=``), else null."""
        host = self.context.get("host")
        if not host:
            return None
        return fr.host_summary(obj, host[0], host[1])

    def validate_name(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("A name is required.")
        return value

    def validate_ports(self, value):
        try:
            return clean_ports(value)
        except serializers.ValidationError as exc:
            detail = exc.detail.get("ports") if isinstance(exc.detail, dict) else exc.detail
            raise serializers.ValidationError(detail) from None

    def validate_status_id(self, value):
        return offered_status(value, ApplicationFlow, self.instance)

    def _side(self, attrs, side, app) -> None:
        inst = self.instance
        get = lambda k: attrs[k] if k in attrs else getattr(inst, k, None)  # noqa: E731
        kind = get(f"{side}_kind") or ("self" if side == "source" else "app")
        attrs[f"{side}_kind"] = kind
        refs = {"app": f"{side}_application", "ip": f"{side}_ip",
                "range": f"{side}_range", "prefix": f"{side}_prefix"}
        for k, field in refs.items():
            if k != kind:
                attrs[field] = None
            elif get(field) is None:
                what = "an application" if k == "app" else {
                    "ip": "an address", "range": "a range", "prefix": "a prefix"}[k]
                raise serializers.ValidationError({f"{field}_id": f"Pick {what}."})
        if kind == "app" and app is not None and get(f"{side}_application") == app:
            raise serializers.ValidationError({
                f"{side}_application_id": "That is this application - pick "
                                          "“This application” instead."})
        address_key = f"{side}_address"
        role_key = f"{side}_address_role"
        if kind in HOST_KINDS:
            mode = get(address_key) or ("primary" if kind == "self" else "service")
            attrs[address_key] = mode
            if mode == "role":
                if get(role_key) is None:
                    raise serializers.ValidationError({f"{role_key}_id": "Pick a role."})
            else:
                attrs[role_key] = None
        else:
            attrs[address_key] = ""
            attrs[role_key] = None

    def validate(self, attrs):
        attrs = super().validate(attrs)
        inst = self.instance
        get = lambda k: attrs[k] if k in attrs else getattr(inst, k, None)  # noqa: E731
        app = get("application")
        if app is None:
            raise serializers.ValidationError({"application_id": "Pick an application."})
        if inst is not None and "application" in attrs and attrs["application"] != inst.application:
            raise serializers.ValidationError(
                {"application_id": "A requirement stays with its application."})
        for side in SIDES:
            self._side(attrs, side, app)
        if "self" not in (attrs["source_kind"], attrs["destination_kind"]):
            raise serializers.ValidationError({
                "source_kind": "One end must be this application."})
        proto = get("protocol") or "tcp"
        if proto in _PORTLESS and get("ports"):
            raise serializers.ValidationError(
                {"ports": f"{proto.upper()} carries no ports - clear them "
                          "or pick TCP, UDP or TCP/UDP."}
            )
        name = get("name") or ""
        clash = ApplicationFlowRequirement.objects.filter(application=app, name=name)
        if inst is not None:
            clash = clash.exclude(pk=inst.pk)
        # A preview saves nothing, so the name it carries may still clash.
        if not self.context.get("preview") and clash.exists():
            raise serializers.ValidationError(
                {"name": "This application already has a requirement by that name."}
            )
        return attrs


def _tenant_from(view):
    from .views import _get_active_tenant

    return _get_active_tenant(view.request)


class ApplicationFlowRequirementViewSet(SafeBulkDeleteMixin, TenantScopedViewSet):
    queryset = (
        ApplicationFlowRequirement.objects.select_related(
            "application", "status", "source_application", "destination_application",
            "source_ip", "source_range", "source_prefix",
            "destination_ip", "destination_range", "destination_prefix",
            "source_address_role", "destination_address_role",
        )
        .prefetch_related(TAGS, "exclusions")
        .order_by(natural("application__name"), natural("name"))
    )
    serializer_class = ApplicationFlowRequirementSerializer
    pagination_class = StandardPagination
    rbac_action_map = {"bulk_delete": "delete", "preview": "view", "gaps": "view",
                       "resolve": "change", "restore": "change"}

    @extend_schema(parameters=[
        OpenApiParameter(k, OpenApiTypes.UUID, OpenApiParameter.QUERY)
        for k in ("application", "references", "device", "vm")
    ] + [
        OpenApiParameter("state", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         enum=[c for c, _ in ApplicationFlowRequirement.STATE_CHOICES]),
        OpenApiParameter("search", OpenApiTypes.STR, OpenApiParameter.QUERY),
    ])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def _host_param(self):
        if not self.request:
            return None
        for key in ("device", "vm"):
            v = _uuid_param(self.request.query_params, key)
            if v:
                return ("device" if key == "device" else "vm", v)
        return None

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        host = self._host_param()
        if host:
            ctx["host"] = host
        return ctx

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        params = self.request.query_params
        app = _uuid_param(params, "application")
        if app:
            qs = qs.filter(application_id=app)
        ref = _uuid_param(params, "references")
        if ref:
            qs = qs.filter(Q(source_application_id=ref) | Q(destination_application_id=ref))
        state = params.get("state")
        if state:
            if state not in {c for c, _ in ApplicationFlowRequirement.STATE_CHOICES}:
                raise ValidationError({"state": "Unknown value."})
            qs = qs.filter(state=state)
        host = self._host_param()
        if host:
            tenant = _tenant_from(self)
            field = "device_id" if host[0] == "device" else "virtual_machine_id"
            apps = InstalledSoftware.objects.filter(
                tenant=tenant, **{field: host[1]}).values("application_id")
            qs = qs.filter(Q(application_id__in=apps) | Q(source_application_id__in=apps)
                           | Q(destination_application_id__in=apps))
        s = params.get("search", "").strip()
        if s:
            qs = qs.filter(Q(name__icontains=s) | Q(description__icontains=s)
                           | Q(application__name__icontains=s) | Q(ports__icontains=s)
                           | cf_text_q(qs.model, s))
        return qs

    def _viewable(self):
        from auth_api.rbac import ViewableRows

        user = self.request.user
        if getattr(user, "is_superuser", False):
            return None
        return ViewableRows(user, _tenant_from(self))

    def _resolved(self, req, reason: str) -> dict:
        """Resolve after a write: inline, or queued once the write commits."""
        return fr.run_or_enqueue(req, reason=reason)

    def _respond(self, req, status_code, resolution):
        req = self.get_queryset().get(pk=req.pk)
        data = self.get_serializer(req).data
        data["resolution"] = resolution
        return Response(data, status=status_code)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        tenant = self._tenant_or_403()
        if serializer.validated_data.get("status") is None:
            serializer.validated_data["status"] = Status.objects.filter(
                tenant=tenant, default_for__contains=["applicationflow"]).first()
        req = serializer.save(tenant=tenant)
        return self._respond(req, drf_status.HTTP_201_CREATED,
                             self._resolved(req, "requirement added"))

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop("partial", False)
        instance = self.get_object()
        serializer = self.get_serializer(instance, data=request.data, partial=partial)
        serializer.is_valid(raise_exception=True)
        req = serializer.save()
        return self._respond(req, drf_status.HTTP_200_OK,
                             self._resolved(req, "requirement edited"))

    def perform_destroy(self, instance):
        with transaction.atomic():
            fr.release_all(instance)
            instance.delete()

    @extend_schema(request=None, responses={200: OpenApiTypes.OBJECT})
    @action(detail=True, methods=["post"], url_path="resolve")
    def resolve(self, request, pk=None):
        """Re-resolve now: the counts, or ``{job}`` for large work."""
        req = self.get_object()
        return Response(self._resolved(req, "re-resolved by hand"))

    @extend_schema(request=None, responses={200: OpenApiTypes.OBJECT})
    @action(detail=True, methods=["get"], url_path="gaps")
    def gaps(self, request, pk=None):
        return Response(fr.gaps_payload(self.get_object(), self._viewable()))

    @extend_schema(request=ApplicationFlowRequirementSerializer,
                   responses={200: OpenApiTypes.OBJECT})
    @action(detail=False, methods=["post"], url_path="preview")
    def preview(self, request):
        """What a payload would document, without saving. ``id`` previews an
        edit of that requirement."""
        data = request.data if isinstance(request.data, dict) else {}
        instance = None
        if data.get("id"):
            instance = self.get_queryset().filter(pk=_uuid(data["id"])).first()
        ser = self.get_serializer(instance, data=data, partial=instance is not None,
                                  context={**self.get_serializer_context(), "preview": True})
        ser.is_valid(raise_exception=True)
        tenant = self._tenant_or_403()
        attrs = {k: v for k, v in ser.validated_data.items()
                 if k not in ("tags", "custom_fields")}
        if instance is not None:
            req = ApplicationFlowRequirement.objects.get(pk=instance.pk)
            for k, v in attrs.items():
                setattr(req, k, v)
        else:
            req = ApplicationFlowRequirement(tenant=tenant, **attrs)
            req.pk = None
        return Response(fr.preview(req, self._viewable()))

    @extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
    @action(detail=True, methods=["get", "post"], url_path="exclusions")
    def exclusions(self, request, pk=None):
        """``GET`` the pairs excluded; ``POST {binding_key, label}`` adds one
        and removes its generated flow."""
        req = self.get_object()
        if request.method == "POST":
            key = str(request.data.get("binding_key") or "").strip()
            if not key or "|" not in key or len(key) > 255:
                raise ValidationError({"binding_key": "A pair key."})
            label = str(request.data.get("label") or key)[:255]
            exclude_pair(req, key, label, request.user)
        rows = ApplicationFlowRequirementExclusion.objects.filter(requirement=req)
        return Response([{"id": str(e.pk), "label": e.label, "binding_key": e.binding_key,
                          "created_at": e.created_at} for e in rows])

    @extend_schema(request=None, responses={204: None})
    @action(detail=True, methods=["delete"], url_path=r"exclusions/(?P<eid>[^/.]+)")
    def restore(self, request, pk=None, eid=None):
        """Restore an excluded pair: the next resolution documents it again."""
        req = self.get_object()
        row = ApplicationFlowRequirementExclusion.objects.filter(
            requirement=req, pk=_uuid(eid)).first()
        if row is None:
            return Response({"detail": "Not found."}, status=drf_status.HTTP_404_NOT_FOUND)
        label = row.label
        with transaction.atomic():
            row.delete()
            fr._journal(req.tenant_id, "api.applicationflowrequirement", req,
                        f"Restored the excluded pair {label}.")
        self._resolved(req, "excluded pair restored")
        return Response(status=drf_status.HTTP_204_NO_CONTENT)


def exclude_pair(req, key: str, label: str, user, *, verb: str = "Excluded") -> None:
    """Record that ``key`` is left out of ``req`` and remove its generated
    flow, with a journal note on the requirement."""
    from audit.context import cause

    with transaction.atomic():
        _row, created = ApplicationFlowRequirementExclusion.objects.get_or_create(
            requirement=req, binding_key=key,
            defaults={"tenant_id": req.tenant_id, "label": label[:255],
                      "created_by": user if getattr(user, "pk", None) else None},
        )
        if created:
            fr._journal(req.tenant_id, "api.applicationflowrequirement", req,
                        f"{verb} the pair {label}.")
        with cause(f"Requirement '{req.name}': pair excluded"):
            for flow in ApplicationFlow.objects.filter(requirement=req, binding_key=key):
                flow.delete()
