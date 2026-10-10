"""SLA templates - the API.

Templates have their own permission (``slatemplate``). Syncing writes to
agreements, so it also needs ``slaagreement.change`` on each one, and
``view_credits`` when the sync would change a service credit.
"""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet
from auth_api import rbac

from . import sla_template
from .models import SlaAgreement, SlaTemplate
from .sla_api import SlaAgreementSerializer, _same_tenant, _tenant_of

_A = SlaAgreementSerializer


def may_see_credits(request, tenant) -> bool:
    return request is None or rbac.has_action(
        request.user, tenant, "slaagreement", "view_credits")


class SlaTemplateSerializer(serializers.ModelSerializer):
    agreement_count = serializers.IntegerField(read_only=True, default=0)
    holiday_calendar_detail = serializers.SerializerMethodField()

    class Meta:
        model = SlaTemplate
        fields = [
            "id", "name", "description", "target_pct", "warning_pct", "period", "timezone",
            "service_hours", "holiday_calendar", "holiday_calendar_detail",
            "count_degraded_as", "count_stale_as", "count_unknown_as", "exclude_maintenance",
            "min_outage_seconds", "aggregation", "objectives", "objectives_in_state",
            "credit_tiers", "period_fee", "currency", "agreement_count",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    # The agreement's own checks: a template holds the same values.
    validate_target_pct = _A.validate_target_pct
    validate_timezone = _A.validate_timezone
    validate_service_hours = _A.validate_service_hours
    validate_objectives = _A.validate_objectives
    validate_credit_tiers = _A.validate_credit_tiers
    validate_currency = _A.validate_currency
    validate_period_fee = _A.validate_period_fee

    def get_holiday_calendar_detail(self, obj):
        c = obj.holiday_calendar
        return {"id": str(c.id), "name": c.name} if c else None

    def to_representation(self, obj):
        data = super().to_representation(obj)
        if not may_see_credits(self.context.get("request"), obj.tenant):
            for f in sla_template.CREDIT_FIELDS:
                data.pop(f, None)
        return data

    def validate_name(self, value):
        value = value.strip()
        tenant = _tenant_of(self)
        if tenant is not None:
            clash = SlaTemplate.objects.filter(tenant=tenant, name__iexact=value)
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError("A template with this name exists.")
        return value

    def validate(self, attrs):
        tenant = _tenant_of(self)
        request = self.context.get("request")
        _same_tenant(tenant, holiday_calendar=attrs.get("holiday_calendar"))
        if request is not None and not may_see_credits(request, tenant):
            for f in sla_template.CREDIT_FIELDS:
                now = (getattr(self.instance, f) if self.instance is not None
                       else SlaTemplate._meta.get_field(f).get_default())
                if f in attrs and attrs[f] != now:
                    raise PermissionDenied("Changing service credits needs view_credits.")
        target = attrs.get("target_pct", getattr(self.instance, "target_pct", None))
        warning = attrs.get("warning_pct", getattr(self.instance, "warning_pct", None))
        if warning is not None and target is not None and not target < warning <= 100:
            raise ValidationError({"warning_pct": "Above the target, at most 100."})
        return attrs


def _linked(view, template, action_="view"):
    """The template's agreements the caller may ``action_``."""
    tenant = view._tenant_or_403()
    return rbac.restrict_queryset(
        SlaAgreement.objects.filter(tenant=tenant, template=template),
        view.request.user, tenant, "slaagreement", action_,
    ).order_by("name")


def check_sync(request, tenant, agreement, template) -> None:
    """What the caller must pass to sync ``agreement``; raises otherwise."""
    if not rbac.can_act_on(request.user, tenant, "slaagreement", "change", agreement):
        raise PermissionDenied(f"slaagreement:change required on {agreement.name}.")
    changed = sla_template.differs(agreement, template)
    if not may_see_credits(request, tenant) and any(
        f in changed for f in sla_template.CREDIT_FIELDS
    ):
        raise PermissionDenied(
            f"Syncing {agreement.name} changes its service credits: that needs view_credits.")


class SlaTemplateViewSet(TenantScopedViewSet):
    queryset = SlaTemplate.objects.select_related("holiday_calendar", "tenant")
    serializer_class = SlaTemplateSerializer
    # Syncing reads the template; each agreement it writes is checked itself.
    rbac_action_map = {"agreements": "view", "sync": "view"}

    def get_queryset(self):
        from django.db.models import Count

        return super().get_queryset().annotate(
            agreement_count=Count("agreements")).order_by("name")

    @action(detail=True, methods=["get"])
    def agreements(self, request, pk=None):
        """The agreements made from this template that the caller can see,
        and the fields where each differs from it."""
        t = self.get_object()
        money = may_see_credits(request, t.tenant)
        out = []
        for a in _linked(self, t):
            diff = sla_template.differs(a, t)
            if not money:
                diff = [f for f in diff if f not in sla_template.CREDIT_FIELDS]
            out.append({"id": str(a.id), "name": a.name, "status": a.status,
                        "revision": a.revision, "differs": diff})
        return Response(out)

    @action(detail=True, methods=["post"])
    def sync(self, request, pk=None):
        """Copy the template into its agreements - ``agreements`` (ids), or
        every one the caller can see. Each changed agreement gets a new
        revision; closed and frozen periods keep theirs."""
        t = self.get_object()
        tenant = self._tenant_or_403()
        qs = _linked(self, t)
        ids = request.data.get("agreements")
        if ids is not None:
            if not isinstance(ids, list) or len(ids) > 1000:
                raise ValidationError({"agreements": "A list of agreement ids."})
            qs = qs.filter(pk__in=[str(i) for i in ids])
        agreements = list(qs)
        # Every check first: a refusal leaves all of them as they were.
        for a in agreements:
            check_sync(request, tenant, a, t)
        synced = sum(sla_template.sync(a, t, request.user) for a in agreements)
        unchanged = len(agreements) - synced
        return Response({"synced": synced, "unchanged": unchanged})
