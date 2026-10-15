"""Support contracts and their device coverage over the API (#421).

* ``/api/support-contracts/`` - CRUD, ``?state=active|expiring|expired``,
  ``?manufacturer=``, ``?device=``, ``?search=``.
* ``/api/support-coverage/`` - the contract ↔ device rows: list, create,
  delete; ``bulk-add`` (device ids and/or pasted serial numbers) and
  ``bulk-remove``.
* ``/api/devices/<id>/coverage/`` and ``/api/devices/coverage-summary/`` are
  device actions; their bodies live here.

Contracts are tenant-wide. A coverage row belongs to its device's site
(``SITE_PATHS["supportcoverage"]``), so a site editor covers the devices of
their own sites only.
"""
from __future__ import annotations

import uuid

from django.db import transaction
from django.db.models import Count, OuterRef, Q, Subquery
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    extend_schema,
    extend_schema_field,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from auth_api import rbac
from core.hidden_fields import PermissionHiddenFieldsMixin
from core.models import Tag
from core.tags import TAGS
from monitoring.models import NotificationChannel

from . import support_coverage as cov
from .bulk_delete import SafeBulkDeleteMixin
from .cf_search import cf_text_q
from .models import Device, Manufacturer, SupportContract, SupportCoverage
from .natural import natural
from .serializers import (
    CustomFieldsSerializerMixin,
    ManufacturerMiniSerializer,
    NumIdModelSerializer,
    ObjectPermsSerializerMixin,
    TaggableSerializerMixin,
    TagSerializer,
    TenantScopedPrimaryKeyRelatedField,
)
from .views import _get_active_tenant
from .viewsets import StandardPagination, TenantScopedViewSet

_STATE_PARAM = OpenApiParameter(
    "state", OpenApiTypes.STR, OpenApiParameter.QUERY,
    description="Comma-separated: active, expiring, expired.",
)


def _device_count_subquery():
    return Coalesce(
        Subquery(
            SupportCoverage.objects.filter(contract=OuterRef("pk"))
            .order_by()
            .values("contract")
            .annotate(n=Count("pk"))
            .values("n")
        ),
        0,
    )


# ─── serializers ─────────────────────────────────────────────────────────────

#: A contract's money: shown and changed with ``supportcontract.view_cost``.
COST_FIELDS = ("cost", "currency")


def may_see_cost(request, tenant) -> bool:
    """Whether the caller may see and change contract cost in ``tenant``.
    No request (a job, the shell) is not a viewer and is not narrowed."""
    return request is None or rbac.has_action(
        request.user, tenant, "supportcontract", "view_cost")


class SupportContractSerializer(
    PermissionHiddenFieldsMixin, CustomFieldsSerializerMixin, TaggableSerializerMixin,
    ObjectPermsSerializerMixin, NumIdModelSerializer,
):
    cf_model = "supportcontract"

    manufacturer = ManufacturerMiniSerializer(read_only=True)
    manufacturer_id = TenantScopedPrimaryKeyRelatedField(
        source="manufacturer", queryset=Manufacturer.objects.all(), write_only=True,
    )
    tags = TagSerializer(many=True, read_only=True)
    tag_ids = TenantScopedPrimaryKeyRelatedField(
        source="tags", queryset=Tag.objects.all(),
        write_only=True, required=False, many=True,
    )
    notify_channels = serializers.SerializerMethodField()
    notify_channel_ids = TenantScopedPrimaryKeyRelatedField(
        source="notify_channels", queryset=NotificationChannel.objects.all(),
        write_only=True, required=False, many=True,
    )
    cost = serializers.DecimalField(
        max_digits=12, decimal_places=2, min_value=0, coerce_to_string=False,
        required=False, allow_null=True,
    )
    state = serializers.SerializerMethodField()
    device_count = serializers.SerializerMethodField()

    class Meta:
        model = SupportContract
        fields = [
            "id", "manufacturer", "manufacturer_id", "contract_number",
            "service_level", "start_date", "end_date", "state", "reseller",
            "cost", "currency", "portal_url", "renewal_notes", "description",
            "notify_channels", "notify_channel_ids", "device_count",
            "tags", "tag_ids", "custom_fields", "permissions",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def hidden_fields(self, obj) -> set[str]:
        # Cost is commercial data: the API and the export leave it out
        # without view_cost.
        memo = self.context.setdefault("_may_see_cost", {})
        key = getattr(obj, "tenant_id", None)
        if key not in memo:
            memo[key] = may_see_cost(self.context.get("request"), getattr(obj, "tenant", None))
        return set() if memo[key] else set(COST_FIELDS)

    @extend_schema_field(serializers.ChoiceField(choices=cov.CONTRACT_STATES))
    def get_state(self, obj) -> str:
        return cov.contract_state(
            obj.end_date, cov.warning_days_for(self.context.get("request"), obj.tenant_id)
        )

    def get_device_count(self, obj) -> int:
        n = getattr(obj, "device_count_annotated", None)
        return n if n is not None else obj.coverage.count()

    @extend_schema_field(inline_serializer("SupportContractChannel", {
        "id": serializers.UUIDField(), "name": serializers.CharField(),
    }, many=True))
    def get_notify_channels(self, obj):
        return [{"id": str(c.id), "name": c.name} for c in obj.notify_channels.all()]

    def validate_contract_number(self, value):
        value = (value or "").strip()
        if not value:
            raise serializers.ValidationError("A contract number is required.")
        return value

    def validate_currency(self, value):
        value = (value or "").strip().upper()
        if value and (len(value) != 3 or not value.isalpha()):
            raise serializers.ValidationError("A three-letter code, like EUR.")
        return value

    def _check_cost(self, attrs):
        """Without view_cost a write may not set or change the cost; a body
        that leaves it out, or repeats the stored value, keeps it."""
        request = self.context.get("request")
        if request is None or not any(f in attrs for f in COST_FIELDS):
            return
        tenant = getattr(self.instance, "tenant", None) or _get_active_tenant(request)
        if may_see_cost(request, tenant):
            return
        errors = {}
        for f in COST_FIELDS:
            if f not in attrs:
                continue
            now = (getattr(self.instance, f) if self.instance is not None
                   else SupportContract._meta.get_field(f).get_default())
            if attrs[f] != now:
                errors[f] = "Setting the cost needs view cost."
        if errors:
            raise serializers.ValidationError(errors)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        self._check_cost(attrs)
        get = lambda k: attrs.get(k, getattr(self.instance, k, None))  # noqa: E731
        start, end = get("start_date"), get("end_date")
        if start and end and end < start:
            raise serializers.ValidationError({"end_date": "Ends before it starts."})
        if get("cost") is not None and not get("currency"):
            raise serializers.ValidationError({"currency": "Give the cost a currency."})
        # One number per manufacturer: answered as a field error, not a 500.
        mfr, number = get("manufacturer"), get("contract_number")
        if mfr is not None and number:
            clash = SupportContract.objects.filter(
                tenant_id=mfr.tenant_id, manufacturer=mfr, contract_number__iexact=number
            )
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError(
                    {"contract_number": "This manufacturer already has that contract."}
                )
        return attrs


class SupportCoverageSerializer(NumIdModelSerializer):
    contract = serializers.SerializerMethodField()
    contract_id = TenantScopedPrimaryKeyRelatedField(
        source="contract", queryset=SupportContract.objects.all(), write_only=True,
    )
    device = serializers.SerializerMethodField()
    device_id = TenantScopedPrimaryKeyRelatedField(
        source="device", queryset=Device.objects.all(), write_only=True,
    )

    class Meta:
        model = SupportCoverage
        fields = ["id", "contract", "contract_id", "device", "device_id",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]
        validators = []  # the pair is checked in validate() with a field error

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_contract(self, obj):
        c = obj.contract
        return {"id": str(c.id), "contract_number": c.contract_number,
                "end_date": c.end_date}

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_device(self, obj):
        d = obj.device
        return {"id": str(d.id), "name": d.name, "serial_number": d.serial_number}

    def validate(self, attrs):
        attrs = super().validate(attrs)
        request = self.context.get("request")
        if request is not None:
            # Linking needs sight of the contract, not only its id.
            tenant = _get_active_tenant(request)
            if not rbac.restrict_queryset(
                SupportContract.objects.filter(pk=attrs["contract"].pk),
                request.user, tenant, "supportcontract", "view",
            ).exists():
                raise serializers.ValidationError({"contract_id": "No such contract."})
        if SupportCoverage.objects.filter(
            contract=attrs["contract"], device=attrs["device"]
        ).exists():
            raise serializers.ValidationError(
                {"device_id": "Already covered by this contract."}
            )
        return attrs


# ─── viewsets ────────────────────────────────────────────────────────────────


class SupportContractViewSet(SafeBulkDeleteMixin, TenantScopedViewSet):
    rbac_action_map = {"bulk_delete": "delete"}
    queryset = (
        SupportContract.objects.select_related("manufacturer")
        .prefetch_related(TAGS, "notify_channels")
        .annotate(device_count_annotated=_device_count_subquery())
        .order_by(Coalesce("end_date", cov.OPEN_ENDED), natural("contract_number"))
    )
    serializer_class = SupportContractSerializer
    pagination_class = StandardPagination

    @extend_schema(parameters=[
        _STATE_PARAM,
        OpenApiParameter("manufacturer", OpenApiTypes.UUID, OpenApiParameter.QUERY),
        OpenApiParameter("device", OpenApiTypes.UUID, OpenApiParameter.QUERY,
                         description="Contracts covering this device."),
        OpenApiParameter("search", OpenApiTypes.STR, OpenApiParameter.QUERY),
    ])
    def list(self, request, *args, **kwargs):
        return super().list(request, *args, **kwargs)

    def get_queryset(self):
        qs = super().get_queryset()
        if not self.request:
            return qs
        params = self.request.query_params
        s = params.get("search", "").strip()
        if s:
            qs = qs.filter(
                Q(contract_number__icontains=s) | Q(description__icontains=s)
                | Q(reseller__icontains=s) | Q(service_level__icontains=s)
                | Q(manufacturer__name__icontains=s) | cf_text_q(qs.model, s)
            )
        for key, field in (("manufacturer", "manufacturer_id"),
                           ("device", "coverage__device_id")):
            v = params.get(key)
            if v:
                try:
                    uuid.UUID(v)
                except ValueError:
                    raise ValidationError({key: "A valid UUID."}) from None
                qs = qs.filter(**{field: v})
        states = cov.parse_statuses(params.get("state"), cov.CONTRACT_STATES, "state")
        if states:
            days = cov.warning_days_for(self.request)
            q = Q()
            for st in states:
                q |= cov.contract_state_q(st, days)
            qs = qs.filter(q)
        return qs


class SupportCoverageViewSet(TenantScopedViewSet):
    """The contract ↔ device rows. No update: a row is added or removed."""

    http_method_names = ["get", "post", "delete", "head", "options"]
    rbac_action_map = {"bulk_add": "add", "bulk_remove": "delete"}
    queryset = (
        SupportCoverage.objects.select_related("contract", "device")
        .order_by("contract__contract_number", natural("device__name"))
    )
    serializer_class = SupportCoverageSerializer
    pagination_class = StandardPagination

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            for key in ("contract", "device"):
                v = self.request.query_params.get(key)
                if v:
                    try:
                        uuid.UUID(v)
                    except ValueError:
                        raise ValidationError({key: "A valid UUID."}) from None
                    qs = qs.filter(**{f"{key}_id": v})
        return qs

    # ── bulk ────────────────────────────────────────────────────────────
    def _contract(self, request, tenant):
        cid = request.data.get("contract_id")
        try:
            uuid.UUID(str(cid))
        except ValueError:
            raise ValidationError({"contract_id": "A valid UUID."}) from None
        qs = rbac.restrict_queryset(
            SupportContract.objects.filter(tenant=tenant, pk=cid),
            request.user, tenant, "supportcontract", "view",
        )
        contract = qs.first()
        if contract is None:
            raise NotFound("No such contract.")
        return contract

    def _device_ids(self, request) -> list[str]:
        raw = request.data.get("device_ids") or []
        if not isinstance(raw, list):
            raise ValidationError({"device_ids": "A list of device ids."})
        ids = []
        for v in raw:
            try:
                ids.append(str(uuid.UUID(str(v))))
            except ValueError:
                raise ValidationError({"device_ids": f"Not a device id: {v}"}) from None
        if len(ids) > cov.MAX_SERIALS:
            raise ValidationError({"device_ids": f"At most {cov.MAX_SERIALS} at a time."})
        return list(dict.fromkeys(ids))

    def _writable_devices(self, request, tenant, action):
        """The tenant's devices the caller may see and whose coverage rows
        they may ``action`` - the coverage row's site is the device's."""
        devices = rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant), request.user, tenant, "device", "view"
        )
        sites = rbac.site_scope(request.user, tenant, "supportcoverage", action)
        if sites is not None:
            devices = devices.filter(site_id__in=sites)
        return devices

    @extend_schema(
        summary="Cover devices by a contract, by id and/or serial number",
        request=inline_serializer("SupportCoverageBulkAdd", {
            "contract_id": serializers.UUIDField(),
            "device_ids": serializers.ListField(child=serializers.UUIDField(), required=False),
            "serials": serializers.CharField(
                required=False,
                help_text="Serial numbers, one per line or separated by commas, "
                          "semicolons or spaces. Matched without case.",
            ),
        }),
        responses={200: inline_serializer("SupportCoverageBulkAddResult", {
            "created": serializers.IntegerField(),
            "existing": serializers.IntegerField(),
            "matched": serializers.IntegerField(),
            "unmatched": serializers.ListField(child=serializers.CharField()),
            "ambiguous": serializers.ListField(child=serializers.CharField()),
        })},
    )
    @action(detail=False, methods=["post"], url_path="bulk-add")
    def bulk_add(self, request):
        tenant = self._tenant_or_403()
        contract = self._contract(request, tenant)
        ids = self._device_ids(request)
        serials = cov.parse_serials(request.data.get("serials") or "")
        if len(serials) > cov.MAX_SERIALS:
            raise ValidationError({"serials": f"At most {cov.MAX_SERIALS} at a time."})
        if not ids and not serials:
            raise ValidationError({"device_ids": "Pick devices or paste serial numbers."})

        devices = self._writable_devices(request, tenant, "add")
        chosen: dict = {}
        if ids:
            found = {str(d.pk): d for d in devices.filter(pk__in=ids)}
            missing = [i for i in ids if i not in found]
            if missing:
                raise ValidationError(
                    {"device_ids": f"{len(missing)} device(s) not found or not yours to cover."}
                )
            chosen.update(found)
        match = cov.match_serials(devices, serials)
        for d in match["devices"]:
            chosen[str(d.pk)] = d

        have = set(
            SupportCoverage.objects.filter(contract=contract, device_id__in=list(chosen))
            .values_list("device_id", flat=True)
        )
        new = [d for pk, d in chosen.items() if uuid.UUID(pk) not in have]
        with transaction.atomic():
            # One row at a time so each lands in the change log.
            created = [
                SupportCoverage.objects.create(tenant=tenant, contract=contract, device=d)
                for d in new
            ]
            if created and not request.user.is_superuser:
                allowed = rbac.restrict_queryset(
                    SupportCoverage.objects.filter(pk__in=[c.pk for c in created]),
                    request.user, tenant, "supportcoverage", "add",
                ).count()
                if allowed != len(created):
                    raise PermissionDenied("Some of these devices are outside your scope.")
        return Response({
            "created": len(created),
            "existing": len(chosen) - len(new),
            "matched": len(match["devices"]),
            "unmatched": match["unmatched"],
            "ambiguous": match["ambiguous"],
        })

    @extend_schema(
        summary="Remove devices from a contract",
        request=inline_serializer("SupportCoverageBulkRemove", {
            "contract_id": serializers.UUIDField(),
            "device_ids": serializers.ListField(child=serializers.UUIDField()),
        }),
        responses={200: inline_serializer("SupportCoverageBulkRemoveResult", {
            "removed": serializers.IntegerField(),
        })},
    )
    @action(detail=False, methods=["post"], url_path="bulk-remove")
    def bulk_remove(self, request):
        tenant = self._tenant_or_403()
        contract = self._contract(request, tenant)
        ids = self._device_ids(request)
        if not ids:
            raise ValidationError({"device_ids": "Pick devices to remove."})
        rows = rbac.restrict_queryset(
            SupportCoverage.objects.filter(
                tenant=tenant, contract=contract, device_id__in=ids
            ),
            request.user, tenant, "supportcoverage", "delete",
        )
        removed = 0
        with transaction.atomic():
            for row in rows:
                row.delete()
                removed += 1
        return Response({"removed": removed})


# ─── device actions ──────────────────────────────────────────────────────────

def device_coverage(request, device) -> dict:
    """The device page's coverage card: status, every contract the caller may
    see (best first), how many they may not, and the lifecycle flags."""
    tenant = _get_active_tenant(request)
    days = cov.warning_days_for(request, tenant)
    rows = list(
        SupportContract.objects.filter(tenant=device.tenant_id, coverage__device=device)
        .select_related("manufacturer")
        .order_by(Coalesce("end_date", cov.OPEN_ENDED).desc())
    )
    visible = rbac.restrict_queryset(
        SupportContract.objects.filter(pk__in=[c.pk for c in rows]),
        request.user, tenant, "supportcontract", "view",
    ).values_list("pk", flat=True)
    visible = set(visible)
    ends = [c.end_date or cov.OPEN_ENDED for c in rows]
    contract_end = max(ends) if ends else None
    end = max([e for e in (contract_end, device.warranty_end) if e], default=None)
    today = timezone.localdate()
    active = any(e >= today for e in ends)
    return {
        "status": cov.status_for(end, days, today),
        "end": cov.public_end(end),
        "warranty_end": device.warranty_end,
        "warning_days": days,
        "contracts": [
            {
                "id": str(c.id),
                "contract_number": c.contract_number,
                "manufacturer": {"id": str(c.manufacturer_id), "name": c.manufacturer.name},
                "service_level": c.service_level,
                "start_date": c.start_date,
                "end_date": c.end_date,
                "state": cov.contract_state(c.end_date, days, today),
            }
            for c in rows if c.pk in visible
        ],
        "hidden_contracts": sum(1 for c in rows if c.pk not in visible),
        "flags": cov.lifecycle_flags(device, contract_end, active, today),
    }


def coverage_summary(request, devices) -> dict:
    """The dashboard widget: devices per status - ``devices`` is the caller's
    device list, already narrowed by ``?site=`` / ``?manufacturer=`` - and the
    contracts that end soonest. One aggregate query plus one for contracts."""
    tenant = _get_active_tenant(request)
    days = cov.warning_days_for(request, tenant)
    annotated = cov.annotate_devices(devices.order_by())
    agg = {
        s: Count("pk", filter=cov.status_q(s, days)) for s in cov.STATUSES
    }
    counts = annotated.aggregate(**agg)
    ending = []
    if rbac.has_action(request.user, tenant, "supportcontract", "view"):
        contracts = rbac.restrict_queryset(
            SupportContract.objects.filter(
                tenant=tenant, end_date__gte=timezone.localdate()
            ),
            request.user, tenant, "supportcontract", "view",
        )
        mfr = request.query_params.get("manufacturer")
        if mfr:
            contracts = contracts.filter(manufacturer_id=mfr)
        site = request.query_params.get("site")
        if site:
            contracts = contracts.filter(coverage__device__site_id=site).distinct()
        contracts = (
            contracts.select_related("manufacturer")
            .annotate(device_count_annotated=_device_count_subquery())
            .order_by("end_date", "contract_number")[:8]
        )
        ending = [
            {
                "id": str(c.id),
                "contract_number": c.contract_number,
                "manufacturer": {"id": str(c.manufacturer_id), "name": c.manufacturer.name},
                "end_date": c.end_date,
                "state": cov.contract_state(c.end_date, days),
                "device_count": c.device_count_annotated,
            }
            for c in contracts
        ]
    return {
        "warning_days": days,
        "total": sum(counts.values()),
        "counts": counts,
        "ending": ending,
    }

