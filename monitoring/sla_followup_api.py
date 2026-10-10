"""SLA incident follow-up - the cause catalog and per-incident follow-up.

Causes are a tenant catalog with their own permission (``slaincidentcause``),
seeded empty. A follow-up belongs to an agreement and is written with
``slaagreement.change`` on that agreement; the incident it names must be one
the caller can see in a stored period, so a site-scoped user cannot annotate
a unit they are not shown.
"""
from __future__ import annotations

import re
from datetime import datetime

from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied, ValidationError

from api.viewsets import TenantScopedViewSet
from auth_api import rbac

from .models import SlaIncidentCause, SlaIncidentFollowUp, SlaPeriodResult
from .sla_api import _same_tenant, _sees_every_member, _tenant_of, _viewer_figures
from .sla_followup import serialize

_HEX = re.compile(r"#[0-9a-fA-F]{6}")


class SlaIncidentCauseSerializer(serializers.ModelSerializer):
    incident_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = SlaIncidentCause
        fields = ["id", "name", "description", "color", "incident_count",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Give the cause a name.")
        tenant = _tenant_of(self)
        if tenant is not None:
            clash = SlaIncidentCause.objects.filter(tenant=tenant, name__iexact=value)
            if self.instance is not None:
                clash = clash.exclude(pk=self.instance.pk)
            if clash.exists():
                raise serializers.ValidationError("A cause with this name exists.")
        return value

    def validate_color(self, value):
        if value and not _HEX.fullmatch(value):
            raise serializers.ValidationError(
                "Enter a 7-char hex colour like #10b981, or leave it empty.")
        return (value or "").lower()


class SlaIncidentCauseViewSet(TenantScopedViewSet):
    queryset = SlaIncidentCause.objects.all()
    serializer_class = SlaIncidentCauseSerializer

    def get_queryset(self):
        from django.db.models import Count

        return super().get_queryset().annotate(
            incident_count=Count("follow_ups")).order_by("name")


class SlaIncidentFollowUpSerializer(serializers.ModelSerializer):
    class Meta:
        model = SlaIncidentFollowUp
        fields = ["id", "agreement", "unit", "started_at", "cause", "ticket_url", "note",
                  "disputed", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate_ticket_url(self, value):
        value = (value or "").strip()
        if value and not value.lower().startswith(("https://", "http://")):
            raise serializers.ValidationError("An http or https link.")
        return value

    def validate(self, attrs):
        tenant = _tenant_of(self)
        if self.instance is not None:
            # Which incident it is never changes; make a new one instead.
            for f in ("agreement", "unit", "started_at"):
                if f in attrs and attrs[f] != getattr(self.instance, f):
                    raise ValidationError({f: "Fixed once written."})
        agreement = attrs.get("agreement", getattr(self.instance, "agreement", None))
        _same_tenant(tenant, agreement=agreement, cause=attrs.get("cause"))
        request = self.context.get("request")
        if not rbac.can_act_on(request.user, tenant, "slaagreement", "change", agreement):
            raise PermissionDenied("slaagreement:change required on this agreement.")
        if self.instance is None:
            unit, start = attrs["unit"], attrs["started_at"]
            if not _incident_visible(request, agreement, unit, start):
                raise ValidationError({"started_at": "No such incident in a stored period."})
            if SlaIncidentFollowUp.objects.filter(
                agreement=agreement, unit=unit, started_at=start
            ).exists():
                raise ValidationError({"started_at": "This incident already has follow-up."})
        return attrs

    def to_representation(self, instance):
        return {**serialize(instance), "agreement": str(instance.agreement_id),
                "unit": instance.unit, "started_at": instance.started_at.isoformat()}


def _incident_visible(request, agreement, unit: str, start) -> bool:
    """The incident is in a stored period of the agreement and on a unit the
    caller is shown."""
    for res in SlaPeriodResult.objects.filter(
        agreement=agreement, period_start__lte=start, period_end__gt=start,
    ):
        for i in _viewer_figures(request, agreement, res, full=True)["incidents"]:
            if i["unit"] == unit and datetime.fromisoformat(i["start"]) == start:
                return True
    return False


class SlaIncidentFollowUpViewSet(TenantScopedViewSet):
    """``?agreement=`` lists one agreement's follow-up. Writing needs
    ``slaagreement.change``: follow-up is part of operating the agreement."""

    queryset = SlaIncidentFollowUp.objects.select_related("cause", "updated_by")
    serializer_class = SlaIncidentFollowUpSerializer
    rbac_object_type = "slaagreement"
    rbac_action_map = {"create": "change", "destroy": "change"}

    def get_queryset(self):
        from .models import SlaAgreement

        qs = super().get_queryset()
        # Only follow-up on agreements the caller may view.
        visible = rbac.restrict_queryset(
            SlaAgreement.objects.filter(tenant=self._tenant_or_403()),
            self.request.user, self._tenant_or_403(), "slaagreement", "view",
        )
        qs = qs.filter(agreement__in=visible)
        if self.request.query_params.get("agreement"):
            qs = qs.filter(agreement_id=self.request.query_params["agreement"])
        if not _sees_every_member(self.request.user, self._tenant_or_403()):
            # A limited viewer gets follow-up only on incidents they are shown.
            keep = [fu.pk for fu in qs.select_related("agreement")[:2000]
                    if _incident_visible(self.request, fu.agreement, fu.unit, fu.started_at)]
            qs = qs.filter(pk__in=keep)
        return qs

    def perform_create(self, serializer):
        serializer.save(tenant=self._tenant_or_403(), updated_by=self.request.user)

    def perform_update(self, serializer):
        serializer.save(updated_by=self.request.user)

    def perform_destroy(self, instance):
        if not rbac.can_act_on(self.request.user, self._tenant_or_403(), "slaagreement",
                               "change", instance.agreement):
            raise PermissionDenied("slaagreement:change required on this agreement.")
        super().perform_destroy(instance)
