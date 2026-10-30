"""Application flows over the API (#163).

``/api/application-flows/`` - the traffic an application needs, from one end
to another on a protocol and ports. CRUD, ``bulk-update``, ``bulk-delete``,
``?picker=1`` and these filters:

* ``?application=``, ``?status=``, ``?service=``, ``?protocol=``,
  ``?direction=``, ``?search=``;
* ``?prefix=`` and ``?range=`` - flows with that prefix or range at either
  end;
* ``?ip=`` - flows with that address at either end, or a prefix or range
  that contains it (same VRF);
* ``?device=`` / ``?vm=`` - the same for every address assigned to the
  device or virtual machine.

Each end is exactly one of an address, a range, a prefix or "any". Every
reference must be the active tenant's. A flow belongs to the site of its
first end that has one (``SITE_PATHS["applicationflow"]``).

A flow a requirement made (``generated``, ``api.flow_requirements``) keeps
its ends, name and application: a write that changes them is a 400 "Detach
it first". An edit to its protocol, ports, direction, status or service is
kept as an override the resolver leaves alone. ``?requirement=`` and
``?generated=`` filter; ``POST <id>/detach/`` makes it hand-made and
``POST <id>/follow/`` drops its overrides. Deleting one records an
exclusion on its requirement, so it is not made again.
"""
from __future__ import annotations

from django.db import transaction
from django.db.models import Q
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_field
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from core.hidden_fields import PermissionHiddenFieldsMixin, hidden_related_spec
from core.models import Tag
from core.tags import TAGS

from .applications_api import PATH_SEP, _paths, _uuid_param
from .bulk_edit import BulkEditMixin, BulkEditSpec
from .cf_search import cf_text_q
from .flow_names import END_SLUGS, FlowNames
from .models import (
    Application,
    ApplicationFlow,
    IPAddress,
    IPRange,
    Prefix,
    Service,
    Status,
)
from .natural import natural
from .serializers import (
    CustomFieldsSerializerMixin,
    HiddenRelatedFieldsMixin,
    IPMiniSerializer,
    NumIdModelSerializer,
    StatusSerializerMixin,
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
    _clean_port_spec,
    _HiddenRelatedListSerializer,
)
from .views import _get_active_tenant
from .viewsets import StandardPagination, TenantScopedViewSet

SIDES = ("source", "destination")
#: The reference kinds of an end, in the order a reader looks for them.
END_KINDS = ("ip", "range", "prefix")

_PORTLESS = ("icmp", "any")


def clean_ports(value) -> str:
    """``"80,443, 8000-8100"`` → ``"80, 443, 8000-8100"``: each part a port
    or an inclusive range, checked as a NAT rule's ports are."""
    parts = [p.strip() for p in str(value or "").split(",")]
    parts = [p for p in parts if p]
    return ", ".join(_clean_port_spec(p, "ports") for p in parts)


def _range_label(r) -> str:
    return f"{r.start_address}-{r.end_address}"




def hidden_end(kind: str) -> dict:
    """An end the caller may not view: its kind, nothing that names it."""
    return {"kind": kind, "id": None, "label": "Hidden", "device": None, "vm": None,
            "hidden": True}


def end_payload(flow, side: str, viewable=None) -> dict:
    """One end for display: ``{kind, id, label, device, vm, hidden}`` - the
    device or virtual machine when the end is an address assigned to one.
    With ``viewable`` (``rbac.ViewableRows``) an end the caller may not view
    is :func:`hidden_end`, and a device or VM they may not view is left out
    (#453)."""
    kind, obj = flow.end(side)
    out = {"kind": kind, "id": None, "label": "Any", "device": None, "vm": None,
           "hidden": False}
    if obj is None:
        return out
    if viewable and not viewable.may_view(END_SLUGS[kind], obj.pk):
        return hidden_end(kind)
    out["id"] = str(obj.pk)
    if kind == "ip":
        out["label"] = str(obj.ip_address)
        if obj.assigned_device_id and (
            not viewable or viewable.may_view("device", obj.assigned_device_id)
        ):
            out["device"] = {"id": str(obj.assigned_device_id),
                             "name": obj.assigned_device.name}
        if obj.assigned_vm_id and (
            not viewable or viewable.may_view("virtualmachine", obj.assigned_vm_id)
        ):
            out["vm"] = {"id": str(obj.assigned_vm_id), "name": obj.assigned_vm.name}
    elif kind == "range":
        out["label"] = _range_label(obj)
    else:
        out["label"] = obj.cidr
    return out


END_SCHEMA = OpenApiTypes.OBJECT


class _FlowNamesMixin(PermissionHiddenFieldsMixin):
    """A generated flow's name with an end the caller may not view as
    Hidden, in the API, the picker and the export (``api.flow_names``)."""

    def _flow_names(self) -> FlowNames:
        viewable = self._viewable() if hasattr(self, "_viewable") else None
        return FlowNames.for_context(self.context, viewable)

    def prime_related(self, rows) -> None:
        if hasattr(super(), "prime_related"):
            super().prime_related(rows)
        self._flow_names().prime(rows)

    def masked_fields(self, obj) -> dict:
        out = dict(super().masked_fields(obj))
        names = self._flow_names()
        if names.masks(obj):
            out["name"] = names.name(obj)
        # The export's column: the pair's key names its rows by id.
        if names.key_hidden(getattr(obj, "binding_key", "")):
            out["binding_key"] = None
        return out

    def masked_columns(self) -> set[str]:
        out = set(super().masked_columns())
        if self._flow_names().active:
            out |= {"name", "binding_key"}
        return out


class ApplicationFlowMiniSerializer(_FlowNamesMixin, NumIdModelSerializer):
    application = serializers.SerializerMethodField()

    class Meta:
        model = ApplicationFlow
        fields = ["id", "name", "application"]
        list_serializer_class = _HiddenRelatedListSerializer

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_application(self, obj):
        return {"id": str(obj.application_id), "name": obj.application.name}


class ApplicationFlowSerializer(
    _FlowNamesMixin, HiddenRelatedFieldsMixin, CustomFieldsSerializerMixin,
    StatusSerializerMixin,
    TaggableSerializerMixin, NumIdModelSerializer,
):
    cf_model = "applicationflow"
    # An end at another site's address, range or prefix - and the device or
    # VM it names - shows only to a caller who may view it (#453, as #413).
    hidden_related = hidden_related_spec("api.applicationflow")

    application = serializers.SerializerMethodField()
    application_id = TenantScopedPrimaryKeyRelatedField(
        source="application", queryset=Application.objects.all(), write_only=True,
        required=False,
    )
    source_ip = IPMiniSerializer(read_only=True)
    source_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="source_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    source_range = serializers.SerializerMethodField()
    source_range_id = TenantScopedPrimaryKeyRelatedField(
        source="source_range", queryset=IPRange.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    source_prefix = serializers.SerializerMethodField()
    source_prefix_id = TenantScopedPrimaryKeyRelatedField(
        source="source_prefix", queryset=Prefix.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    destination_ip = IPMiniSerializer(read_only=True)
    destination_ip_id = TenantScopedPrimaryKeyRelatedField(
        source="destination_ip", queryset=IPAddress.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    destination_range = serializers.SerializerMethodField()
    destination_range_id = TenantScopedPrimaryKeyRelatedField(
        source="destination_range", queryset=IPRange.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    destination_prefix = serializers.SerializerMethodField()
    destination_prefix_id = TenantScopedPrimaryKeyRelatedField(
        source="destination_prefix", queryset=Prefix.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    source = serializers.SerializerMethodField()
    destination = serializers.SerializerMethodField()
    protocol_display = serializers.CharField(source="get_protocol_display", read_only=True)
    direction_display = serializers.CharField(source="get_direction_display", read_only=True)
    service = serializers.SerializerMethodField()
    service_id = TenantScopedPrimaryKeyRelatedField(
        source="service", queryset=Service.objects.all(),
        write_only=True, required=False, allow_null=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    requirement = serializers.SerializerMethodField()
    source_install = serializers.SerializerMethodField()
    destination_install = serializers.SerializerMethodField()

    class Meta:
        model = ApplicationFlow
        fields = ["id", "numid", "application", "application_id", "name", "description",
                  "source", "source_ip", "source_ip_id", "source_range", "source_range_id",
                  "source_prefix", "source_prefix_id", "source_any",
                  "destination", "destination_ip", "destination_ip_id",
                  "destination_range", "destination_range_id",
                  "destination_prefix", "destination_prefix_id", "destination_any",
                  "protocol", "protocol_display", "ports", "direction", "direction_display",
                  "status", "status_id", "service", "service_id",
                  "requirement", "generated", "overridden_fields",
                  "source_install", "destination_install",
                  "tags", "tag_ids", "custom_fields", "created_at", "updated_at"]
        read_only_fields = ["id", "numid", "generated", "overridden_fields",
                            "created_at", "updated_at"]
        validators = []  # the unique name is checked in validate() as a field error
        list_serializer_class = _HiddenRelatedListSerializer

    def prime_related(self, rows) -> None:
        super().prime_related(rows)
        viewable = self._viewable()
        if not viewable:
            return
        ips = [getattr(obj, f"{side}_ip") for obj in rows for side in SIDES]
        ips = [ip for ip in ips if ip is not None]
        viewable.prime("device", {ip.assigned_device_id for ip in ips})
        viewable.prime("virtualmachine", {ip.assigned_vm_id for ip in ips})

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_application(self, obj):
        a = obj.application
        names = _paths(self.context, a.tenant_id).get(a.pk) or [a.name]
        return {"id": str(a.id), "name": a.name, "slug": a.slug,
                "path": PATH_SEP.join(names)}

    def _range(self, r):
        if r is None:
            return None
        return {"id": str(r.id), "start_address": str(r.start_address),
                "end_address": str(r.end_address), "label": _range_label(r)}

    def _prefix(self, p):
        return {"id": str(p.id), "cidr": p.cidr} if p is not None else None

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_source_range(self, obj):
        return self._range(obj.source_range)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_destination_range(self, obj):
        return self._range(obj.destination_range)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_source_prefix(self, obj):
        return self._prefix(obj.source_prefix)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_destination_prefix(self, obj):
        return self._prefix(obj.destination_prefix)

    @extend_schema_field(END_SCHEMA)
    def get_source(self, obj):
        return end_payload(obj, "source", self._viewable())

    @extend_schema_field(END_SCHEMA)
    def get_destination(self, obj):
        return end_payload(obj, "destination", self._viewable())

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_service(self, obj):
        s = obj.service
        return {"id": str(s.id), "name": s.name} if s is not None else None

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_requirement(self, obj):
        r = obj.requirement
        return {"id": str(r.pk), "name": r.name} if r is not None else None

    def _install(self, inst):
        """``{id, application, version, host}`` - the install behind a host
        end ("because WMS client 4.2 is on wms-07")."""
        if inst is None:
            return None
        host = inst.device if inst.device_id else inst.virtual_machine
        kind = "device" if inst.device_id else "vm"
        return {"id": str(inst.pk), "application": inst.application.name,
                "version": inst.version,
                "host": {"kind": kind, "id": str(host.pk), "name": host.name}}

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_source_install(self, obj):
        return self._install(obj.source_install)

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_destination_install(self, obj):
        return self._install(obj.destination_install)

    def _guard_generated(self, attrs) -> None:
        """A generated row keeps what its requirement decides - its ends,
        name and application. Changing one needs a detach first; a payload
        that repeats the current value is fine."""
        inst = self.instance
        if inst is None:
            return
        if not inst.generated:
            # A detached or released flow keeps its generated name: a payload
            # that repeats it as this caller reads it (masked) keeps it too.
            if (inst.name_generated and "name" in attrs and attrs["name"] != inst.name
                    and attrs["name"] == self._flow_names().name(inst)):
                attrs.pop("name")
            return
        locked = ["application", "name"]
        for side in SIDES:
            locked += [f"{side}_{k}" for k in END_KINDS] + [f"{side}_any"]
        for key in locked:
            if key not in attrs:
                continue
            new, old = attrs[key], getattr(inst, key)
            if key == "name" and new == self._flow_names().name(inst):
                # The name as this caller reads it (masked) repeats it; the
                # stored name stays.
                attrs.pop("name")
                continue
            if (getattr(new, "pk", new) or None) != (getattr(old, "pk", old) or None):
                field = key if key in ("name",) else (
                    "application_id" if key == "application" else key.split("_")[0])
                raise serializers.ValidationError(
                    {field: "Generated by a requirement - detach it first."})

    def update(self, instance, validated_data):
        """An edit to a generated row's protocol, ports, direction, status
        or service is kept as an override. Renaming a detached or released
        flow makes the name the user's: it is no longer masked."""
        if instance.name_generated and validated_data.get("name", instance.name) != instance.name:
            instance.name_generated = False
        if instance.generated:
            changed = set(instance.overridden_fields or [])
            for name in ("protocol", "ports", "direction", "status", "service"):
                if name not in validated_data:
                    continue
                new, old = validated_data[name], getattr(instance, name)
                if (getattr(new, "pk", new) or None) != (getattr(old, "pk", old) or None):
                    changed.add(name)
            instance.overridden_fields = sorted(changed)
        return super().update(instance, validated_data)

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

    def _side(self, attrs, side) -> None:
        """Settle one end: a payload that names one kind clears the others,
        and exactly one must be left."""
        keys = [f"{side}_{k}" for k in END_KINDS] + [f"{side}_any"]
        given = [k for k in keys if k in attrs]
        inst = self.instance
        if given:
            chosen = any(bool(attrs[k]) for k in given)
            for k in keys:
                if k not in attrs:
                    if chosen:
                        attrs[k] = False if k.endswith("_any") else None
                    elif inst is not None:
                        attrs[k] = getattr(inst, k)
        elif inst is not None:
            return
        n = sum(1 for k in keys if attrs.get(k))
        if n != 1:
            raise serializers.ValidationError({
                side: "Pick exactly one: an address, a range, a prefix or any."
            })

    def validate(self, attrs):
        attrs = super().validate(attrs)
        inst = self.instance
        get = lambda k: attrs[k] if k in attrs else getattr(inst, k, None)  # noqa: E731
        app = get("application")
        if app is None:
            raise serializers.ValidationError({"application_id": "Pick an application."})
        for side in SIDES:
            self._side(attrs, side)
        self._guard_generated(attrs)
        proto = get("protocol") or "tcp"
        if proto in _PORTLESS and get("ports"):
            raise serializers.ValidationError(
                {"ports": f"{proto.upper()} carries no ports - clear them "
                          "or pick TCP, UDP or TCP/UDP."}
            )
        svc = get("service")
        dest_ip = get("destination_ip")
        if svc is not None and dest_ip is not None and not (
            svc.ip_address_id == dest_ip.pk
            or (svc.device_id and svc.device_id == dest_ip.assigned_device_id)
            or (svc.virtual_machine_id and svc.virtual_machine_id == dest_ip.assigned_vm_id)
        ):
            raise serializers.ValidationError(
                {"service_id": "The service must answer on the destination address."}
            )
        name = get("name") or ""
        clash = ApplicationFlow.objects.filter(application=app, name=name)
        if inst is not None:
            clash = clash.exclude(pk=inst.pk)
        if clash.exists():
            raise serializers.ValidationError(
                {"name": "This application already has a flow by that name."}
            )
        return attrs


# ─── involvement filters ─────────────────────────────────────────────────────

#: Which address column a scope reads: one address, or a device's or VM's.
_IP_SCOPES = {"ip": "id", "device": "assigned_device_id", "vm": "assigned_vm_id"}


def _containing(model, table: str, match: str, tenant_id, column: str, value) -> list:
    """Ids of the tenant's ``model`` rows (prefixes or ranges) that hold one
    of the tenant's addresses whose ``column`` is ``value``, in the same
    VRF. ``column`` comes from ``_IP_SCOPES``, never from the request."""
    sql = (
        f"EXISTS (SELECT 1 FROM api_ipaddress ip WHERE ip.{column} = %s "
        f"AND ip.tenant_id = %s AND {match} "
        f"AND ip.vrf_id IS NOT DISTINCT FROM {table}.vrf_id)"
    )
    return list(
        model.objects.filter(tenant_id=tenant_id)
        .extra(where=[sql], params=[str(value), str(tenant_id)])
        .values_list("pk", flat=True)
    )


def involvement_q(tenant_id, scope: str, value) -> Q:
    """Flows with an end at an address of ``scope`` (``ip``, ``device`` or
    ``vm``), or at a prefix or range that contains one."""
    column = _IP_SCOPES[scope]
    ips = list(
        IPAddress.objects.filter(tenant_id=tenant_id, **{column: value})
        .values_list("pk", flat=True)
    )
    if not ips:
        return Q(pk__in=[])
    prefixes = _containing(Prefix, "api_prefix", "ip.ip_address <<= api_prefix.cidr::inet",
                           tenant_id, column, value)
    ranges = _containing(
        IPRange, "api_iprange",
        "ip.ip_address BETWEEN api_iprange.start_address AND api_iprange.end_address",
        tenant_id, column, value,
    )
    return (
        Q(source_ip__in=ips) | Q(destination_ip__in=ips)
        | Q(source_prefix__in=prefixes) | Q(destination_prefix__in=prefixes)
        | Q(source_range__in=ranges) | Q(destination_range__in=ranges)
    )


class ApplicationFlowViewSet(BulkEditMixin, TenantScopedViewSet):
    queryset = (
        ApplicationFlow.objects.select_related(
            "application", "status", "service",
            "source_ip", "source_ip__assigned_device", "source_ip__assigned_vm",
            "destination_ip", "destination_ip__assigned_device", "destination_ip__assigned_vm",
            "source_range", "destination_range", "source_prefix", "destination_prefix",
            "requirement",
            "source_install__application", "source_install__device",
            "source_install__virtual_machine",
            "destination_install__application", "destination_install__device",
            "destination_install__virtual_machine",
        )
        .prefetch_related(TAGS)
        .order_by(natural("application__name"), natural("name"))
    )
    serializer_class = ApplicationFlowSerializer
    pagination_class = StandardPagination
    bulk_edit = BulkEditSpec(fields=("status_id", "direction", "description"))
    rbac_action_map = {**BulkEditMixin.rbac_action_map, "detach": "change",
                       "follow": "change"}

    def get_serializer_class(self):
        if self.action == "list" and self.request and \
                self.request.query_params.get("picker") == "1":
            return ApplicationFlowMiniSerializer
        return ApplicationFlowSerializer

    @extend_schema(parameters=[
        OpenApiParameter(k, OpenApiTypes.UUID, OpenApiParameter.QUERY)
        for k in ("application", "ip", "prefix", "range", "device", "vm", "status", "service")
    ] + [
        OpenApiParameter("protocol", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         enum=[c for c, _ in ApplicationFlow.PROTOCOL_CHOICES]),
        OpenApiParameter("direction", OpenApiTypes.STR, OpenApiParameter.QUERY,
                         enum=[c for c, _ in ApplicationFlow.DIRECTION_CHOICES]),
        OpenApiParameter("search", OpenApiTypes.STR, OpenApiParameter.QUERY),
        OpenApiParameter("picker", OpenApiTypes.STR, OpenApiParameter.QUERY),
    ])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        params = self.request.query_params
        for key, field in (("application", "application_id"), ("status", "status_id"),
                           ("service", "service_id")):
            v = _uuid_param(params, key)
            if v:
                qs = qs.filter(**{field: v})
        for key in ("prefix", "range"):
            v = _uuid_param(params, key)
            if v:
                qs = qs.filter(Q(**{f"source_{key}_id": v}) | Q(**{f"destination_{key}_id": v}))
        tenant = _get_active_tenant(self.request)
        for key in ("ip", "device", "vm"):
            v = _uuid_param(params, key)
            if v:
                qs = qs.filter(involvement_q(tenant.pk if tenant else None, key, v))
        for key, choices in (("protocol", ApplicationFlow.PROTOCOL_CHOICES),
                             ("direction", ApplicationFlow.DIRECTION_CHOICES)):
            v = params.get(key)
            if v:
                if v not in {c for c, _ in choices}:
                    raise ValidationError({key: "Unknown value."})
                qs = qs.filter(**{key: v})
        req = _uuid_param(params, "requirement")
        if req:
            qs = qs.filter(requirement_id=req)
        gen = params.get("generated")
        if gen in ("true", "1"):
            qs = qs.filter(generated=True)
        elif gen in ("false", "0"):
            qs = qs.filter(generated=False)
        elif gen:
            raise ValidationError({"generated": "true or false."})
        s = params.get("search", "").strip()
        if s:
            ends = Q()
            for side in SIDES:
                for kind, field in (("ip", "ip_address"), ("prefix", "cidr")):
                    ends |= self._visible_end_q(tenant, f"{side}_{kind}", END_SLUGS[kind],
                                                f"__{field}__icontains", s)
            # A generated row's name names the hosts at its ends; it matches
            # only while the caller may view both (#453).
            named = Q(name__icontains=s) & FlowNames(self.request.user, tenant).visible_q()
            qs = qs.filter(
                named | Q(description__icontains=s)
                | Q(application__name__icontains=s) | Q(ports__icontains=s)
                | ends
                | cf_text_q(qs.model, s)
            )
        return qs

    def _visible_end_q(self, tenant, field: str, slug: str, lookup: str, value) -> Q:
        """``field<lookup>=value``, matched only on an end the caller may
        view: a search never answers for a hidden end (#453)."""
        from auth_api import rbac

        match = Q(**{f"{field}{lookup}": value})
        user = self.request.user
        if tenant is None or getattr(user, "is_superuser", False):
            return match
        f = rbac.row_filter(user, tenant, slug, "view")
        if f is True:
            return match
        if f is None:
            return Q(pk__in=[])
        from auth_api.object_types import model_for

        visible = model_for(slug)._default_manager.filter(f).values("pk")
        return match & Q(**{f"{field}__in": visible})

    def perform_create(self, serializer):
        if "status" not in serializer.validated_data:
            tenant = self._tenant_or_403()
            serializer.validated_data["status"] = Status.objects.filter(
                tenant=tenant, default_for__contains=["applicationflow"],
            ).first()
        super().perform_create(serializer)

    def perform_destroy(self, instance):
        """Deleting a generated flow excludes its pair from the requirement,
        so the next resolution does not make it again."""
        if instance.generated and instance.requirement_id:
            from .flow_requirements_api import exclude_pair

            exclude_pair(instance.requirement, instance.binding_key, instance.name,
                         self.request.user)
            return
        super().perform_destroy(instance)

    def bulk_row_updates(self, rows: list, updates: dict) -> dict:
        """A bulk status or direction edit on a generated row is an
        override, as the edit form's is."""
        names = {"status_id": "status", "direction": "direction"}
        out = {}
        for r in rows:
            if not r.generated:
                continue
            frozen = set(r.overridden_fields or [])
            for key, name in names.items():
                if key in updates and str(getattr(r, key) or "") != str(updates[key] or ""):
                    frozen.add(name)
            if frozen != set(r.overridden_fields or []):
                out[r.pk] = {"overridden_fields": sorted(frozen)}
        return out

    @extend_schema(request=None, responses={200: ApplicationFlowSerializer})
    @action(detail=True, methods=["post"], url_path="detach")
    def detach(self, request, pk=None):
        """Make a generated flow hand-made: it keeps its ends and fields,
        and its pair is excluded from the requirement so it is not made
        twice."""
        from .flow_requirements_api import exclude_pair
        from .models import ApplicationFlowRequirementExclusion

        flow = self.get_object()
        if not flow.generated:
            raise ValidationError({"detail": "This flow is already hand-made."})
        req, key = flow.requirement, flow.binding_key
        with transaction.atomic():
            flow.requirement = None
            flow.generated = False
            flow.binding_key = ""
            flow.source_install = None
            flow.destination_install = None
            flow.overridden_fields = []
            flow.save(update_fields=["requirement", "generated", "binding_key",
                                     "source_install", "destination_install",
                                     "overridden_fields", "updated_at"])
            if req is not None and key and not ApplicationFlowRequirementExclusion.objects \
                    .filter(requirement=req, binding_key=key).exists():
                exclude_pair(req, key, flow.name, request.user, verb="Detached")
        return Response(self.get_serializer(self.get_queryset().get(pk=flow.pk)).data)

    @extend_schema(request=None, responses={200: ApplicationFlowSerializer})
    @action(detail=True, methods=["post"], url_path="follow")
    def follow(self, request, pk=None):
        """Drop a generated flow's overrides: it follows its requirement
        again."""
        from . import flow_requirements as fr

        flow = self.get_object()
        if not flow.generated or flow.requirement is None:
            raise ValidationError({"detail": "Only a generated flow follows a requirement."})
        flow.overridden_fields = []
        flow.save(update_fields=["overridden_fields", "updated_at"])
        fr.resolve(flow.requirement, reason=f"{flow.name} follows it again")
        return Response(self.get_serializer(self.get_queryset().get(pk=flow.pk)).data)
