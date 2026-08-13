"""Maintenance & outage events (issue #20) — serializers and viewsets.

Both are tenant-scoped and RBAC-gated like everything else. Impacts follow the
TaskLink rule: an ``object_type`` + ``object_id`` pair is attacker-set until the
exact row passes the caller's own view RBAC, and the resolved site is
denormalised onto the impact so site separation keeps working after the fact.
"""
from __future__ import annotations

from django.db.models import Q
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied, ValidationError

from api.viewsets import TenantScopedViewSet

from .models import (
    MAINTENANCE_STATUSES,
    OUTAGE_STATUSES,
    EventImpact,
    MaintenanceEvent,
    MaintenanceEventKind,
)


class EventImpactSerializer(serializers.ModelSerializer):
    class Meta:
        model = EventImpact
        fields = [
            "id", "event", "object_type", "object_id", "object_site_id",
            "level", "note", "created_at",
        ]
        read_only_fields = ["id", "object_site_id", "created_at"]

    def validate_object_type(self, value):
        from auth_api.object_types import label_for

        label = label_for(value)
        if label is None:
            raise serializers.ValidationError("Unknown object type.")
        return label

    def validate(self, attrs):
        # Retargeting an impact would move it onto an object the caller was
        # never checked against — same rule as task links: delete and re-add.
        if self.instance is not None:
            for field in ("event", "object_type", "object_id"):
                if field in attrs and attrs[field] != getattr(self.instance, field):
                    raise serializers.ValidationError(
                        {field: "An impact can't be retargeted — remove and re-add."}
                    )
        return attrs


class MaintenanceEventSerializer(serializers.ModelSerializer):
    provider_name = serializers.CharField(
        source="provider.name", read_only=True, default=None
    )
    impacts = EventImpactSerializer(many=True, read_only=True)
    is_open = serializers.BooleanField(read_only=True)

    class Meta:
        model = MaintenanceEvent
        fields = [
            "id", "kind", "status", "name", "description",
            "provider", "provider_name", "external_ref",
            "starts_at", "ends_at", "etr",
            "raw_email", "impacts", "is_open",
            "created_at", "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def validate(self, attrs):
        current = self.instance
        kind = attrs.get("kind", getattr(current, "kind", None))
        status = attrs.get("status", getattr(current, "status", None))
        starts = attrs.get("starts_at", getattr(current, "starts_at", None))
        ends = attrs.get("ends_at", getattr(current, "ends_at", None))
        etr = attrs.get("etr", getattr(current, "etr", None))

        allowed = (
            MAINTENANCE_STATUSES
            if kind == MaintenanceEventKind.MAINTENANCE
            else OUTAGE_STATUSES
        )
        if status not in allowed:
            raise serializers.ValidationError(
                {"status": f"A {kind} event's status must be one of: "
                           f"{', '.join(allowed)}."}
            )
        if kind == MaintenanceEventKind.MAINTENANCE:
            # A maintenance window has a planned end; ETR is outage vocabulary.
            if ends is None:
                raise serializers.ValidationError(
                    {"ends_at": "A maintenance window needs an end."}
                )
            if etr is not None:
                raise serializers.ValidationError(
                    {"etr": "ETR belongs to outages; maintenance has ends_at."}
                )
        if ends is not None and starts is not None and ends <= starts:
            raise serializers.ValidationError({"ends_at": "Ends before it starts."})
        return attrs


class MaintenanceEventViewSet(TenantScopedViewSet):
    queryset = (
        MaintenanceEvent.objects.select_related("provider")
        .prefetch_related("impacts")
        .order_by("-starts_at")
    )
    serializer_class = MaintenanceEventSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("kind"):
            qs = qs.filter(kind=p["kind"])
        if p.get("status"):
            qs = qs.filter(status=p["status"])
        if p.get("provider"):
            qs = qs.filter(provider_id=p["provider"])
        if p.get("open") == "1":
            from .models import TERMINAL_STATUSES

            qs = qs.exclude(status__in=TERMINAL_STATUSES)
        # Everything touching a window — how the calendar and an object's
        # "upcoming maintenance" panel ask.
        if p.get("active_at"):
            # Window open at that moment: started, and either ends later or has
            # no end yet (an outage still being worked).
            now = p["active_at"]
            qs = qs.filter(starts_at__lte=now).filter(
                Q(ends_at__gte=now) | Q(ends_at__isnull=True)
            )
        return qs

    def perform_create(self, serializer):
        serializer.save(
            tenant=self._tenant_or_403(), created_by=self.request.user
        )


class EventImpactViewSet(TenantScopedViewSet):
    queryset = EventImpact.objects.select_related("event").order_by("created_at")
    serializer_class = EventImpactSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        p = self.request.query_params
        if p.get("event"):
            qs = qs.filter(event_id=p["event"])
        # Reverse lookup — "what maintenance touches this circuit?"
        if p.get("object_type") and p.get("object_id"):
            from auth_api.object_types import label_for

            label = label_for(p["object_type"])
            if label is None:
                return qs.none()
            qs = qs.filter(object_type=label, object_id=p["object_id"])
        return qs

    def perform_create(self, serializer):
        from audit.api import _can_view_object, _object_site_id

        tenant = self._tenant_or_403()
        event = serializer.validated_data.get("event")
        if event is None or event.tenant_id != tenant.id:
            raise ValidationError({"event": "Event is not in this tenant."})
        otype = serializer.validated_data.get("object_type")
        oid = serializer.validated_data.get("object_id")
        if not _can_view_object(self.request, otype, str(oid)):
            raise PermissionDenied("You can't mark impact on an object you can't view.")
        serializer.save(
            tenant=tenant, object_site_id=_object_site_id(otype, str(oid))
        )
