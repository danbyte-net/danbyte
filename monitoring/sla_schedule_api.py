"""Scheduled SLA reports - the API.

A schedule sends the whole report (every member, the service credit), like
an agreement's own report recipients, so writing one needs
``slaagreement.change`` on the agreement, ``view_credits`` and a view of every
member that is not limited to sites or by constraints. The overview schedule
(no agreement) needs the same, across the tenant.
"""
from __future__ import annotations

from django.utils import timezone
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet
from auth_api import rbac

from . import sla_schedule
from .models import SlaAgreement, SlaReportSchedule
from .sla_api import SlaAgreementSerializer, _same_tenant, _sees_every_member, _tenant_of


def _may_send_whole_reports(user, tenant) -> bool:
    return (rbac.has_action(user, tenant, "slaagreement", "view_credits")
            and _sees_every_member(user, tenant))


class SlaReportScheduleSerializer(serializers.ModelSerializer):
    next_at = serializers.SerializerMethodField()
    agreement_name = serializers.CharField(source="agreement.name", read_only=True, default=None)

    class Meta:
        model = SlaReportSchedule
        fields = ["id", "agreement", "agreement_name", "frequency", "weekday", "day_of_month",
                  "hour", "period", "recipients", "report_format", "enabled",
                  "report_sent_at", "last_error", "last_attempt_at", "failures", "next_at",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "report_sent_at", "last_error", "last_attempt_at",
                            "failures", "created_at", "updated_at"]

    def get_next_at(self, obj):
        if not obj.enabled:
            return None
        try:
            return sla_schedule.next_slot(obj, timezone.now()).isoformat()
        except Exception:  # noqa: BLE001 - a broken timezone shows no next send
            return None

    def validate_recipients(self, value):
        value = SlaAgreementSerializer().validate_report_recipients(value)
        if not value:
            raise serializers.ValidationError("At least one address.")
        return value

    def validate(self, attrs):
        tenant = _tenant_of(self)
        request = self.context["request"]
        if self.instance is not None and "agreement" in attrs and (
            attrs["agreement"] != self.instance.agreement
        ):
            raise ValidationError({"agreement": "Fixed once written."})
        agreement = attrs.get("agreement", getattr(self.instance, "agreement", None))
        _same_tenant(tenant, agreement=agreement)
        if agreement is not None and not rbac.can_act_on(
            request.user, tenant, "slaagreement", "change", agreement
        ):
            raise PermissionDenied("slaagreement:change required on this agreement.")
        if not _may_send_whole_reports(request.user, tenant):
            raise PermissionDenied(
                "A scheduled report is the whole report, service credit included: it "
                "needs view_credits and access to every member."
            )
        return attrs


class SlaReportScheduleViewSet(TenantScopedViewSet):
    """``?agreement=<id>`` for one agreement's schedules, ``?overview=1`` for
    the overview's."""

    queryset = SlaReportSchedule.objects.select_related("agreement")
    serializer_class = SlaReportScheduleSerializer
    rbac_object_type = "slaagreement"
    rbac_action_map = {"create": "change", "destroy": "change", "send_now": "change"}

    def get_queryset(self):
        qs = super().get_queryset()
        tenant = self._tenant_or_403()
        visible = rbac.restrict_queryset(
            SlaAgreement.objects.filter(tenant=tenant), self.request.user, tenant,
            "slaagreement", "view",
        )
        qs = qs.filter(agreement__isnull=True) | qs.filter(agreement__in=visible)
        p = self.request.query_params
        if p.get("agreement"):
            qs = qs.filter(agreement_id=p["agreement"])
        elif p.get("overview"):
            qs = qs.filter(agreement__isnull=True)
        return qs.order_by("frequency", "created_at")

    def perform_create(self, serializer):
        serializer.save(tenant=self._tenant_or_403(), created_by=self.request.user)

    def perform_destroy(self, instance):
        tenant = self._tenant_or_403()
        if instance.agreement is not None and not rbac.can_act_on(
            self.request.user, tenant, "slaagreement", "change", instance.agreement
        ):
            raise PermissionDenied("slaagreement:change required on this agreement.")
        super().perform_destroy(instance)

    @action(detail=True, methods=["post"], url_path="send-now")
    def send_now(self, request, pk=None):
        """Send the report now. Does not move the schedule's next send."""
        s = self.get_object()
        tenant = self._tenant_or_403()
        if s.agreement is not None and not rbac.can_act_on(
            request.user, tenant, "slaagreement", "change", s.agreement
        ):
            raise PermissionDenied("slaagreement:change required on this agreement.")
        if not _may_send_whole_reports(request.user, tenant):
            raise PermissionDenied("Needs view_credits and access to every member.")
        prev = s.report_sent_at
        try:
            if not sla_schedule.send_now(s):
                raise ValidationError({"detail": "Being sent by another run."})
        except ValidationError:
            raise
        except Exception as e:  # noqa: BLE001 - the error is the answer
            raise ValidationError({"detail": f"Not sent: {e}"}) from None
        # Sending by hand leaves the schedule's own stamp where it was.
        SlaReportSchedule.objects.filter(pk=s.pk).update(report_sent_at=prev)
        return Response({"sent": True})
