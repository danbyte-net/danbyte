"""Maintenance & outage events (issue #20) — serializers and viewsets.

Both are tenant-scoped and RBAC-gated like everything else. Impacts follow the
TaskLink rule: an ``object_type`` + ``object_id`` pair is attacker-set until the
exact row passes the caller's own view RBAC, and the resolved site is
denormalised onto the impact so site separation keeps working after the fact.
"""
from __future__ import annotations

from django.db import transaction
from django.db.models import Q
from rest_framework import serializers, status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from api.serializers import StatusSerializerMixin
from api.viewsets import TenantScopedViewSet

from .models import (
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


class MaintenanceEventSerializer(StatusSerializerMixin, serializers.ModelSerializer):
    """Status is a row from the tenant's /statuses catalog — nested on read,
    ``status_id`` on write, exactly like every other statusable model."""

    provider_name = serializers.CharField(
        source="provider.name", read_only=True, default=None
    )
    impacts = EventImpactSerializer(many=True, read_only=True)
    is_open = serializers.BooleanField(read_only=True)

    class Meta:
        model = MaintenanceEvent
        fields = [
            "id", "kind", "status", "status_id", "name", "description",
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

        if status is None:
            raise serializers.ValidationError(
                {"status_id": "An event needs a status from the catalog."}
            )
        if "maintenanceevent" not in (status.available_to or []):
            raise serializers.ValidationError(
                {"status_id": f"'{status.name}' is not available to maintenance "
                              "events — add the type on the status, or pick "
                              "another (Settings → Statuses)."}
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
        MaintenanceEvent.objects.select_related("provider", "status")
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
            # A catalog row's id, or its slug ("confirmed") for scripts.
            if _looks_like_uuid(p["status"]):
                qs = qs.filter(status_id=p["status"])
            else:
                qs = qs.filter(status__slug=p["status"])
        if p.get("provider"):
            qs = qs.filter(provider_id=p["provider"])
        if p.get("open") == "1":
            qs = qs.filter(status__is_closed=False)
        # Reverse lookup — "what maintenance touches this device/circuit?"
        # Powers the detail pages' upcoming-maintenance panel in one request.
        if p.get("object_type") and p.get("object_id"):
            from auth_api.object_types import label_for

            label = label_for(p["object_type"])
            if label is None:
                return qs.none()
            qs = qs.filter(
                impacts__object_type=label, impacts__object_id=p["object_id"]
            ).distinct()
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
        serializer.instance.sync_silence()

    def perform_update(self, serializer):
        super().perform_update(serializer)
        serializer.instance.sync_silence()

    def perform_destroy(self, instance):
        silence = instance.silence
        super().perform_destroy(instance)
        if silence:
            silence.delete()

    @action(detail=False, methods=["post"])
    def ingest(self, request):
        """Upsert an event from an external notification parser (issue #20).

        The netbox-notices pattern: parsing stays outside Danbyte; a parser
        POSTs the normalised event here with a scoped API token. The provider's
        ``external_ref`` is the identity — re-ingesting a revised notification
        updates the event instead of duplicating it. ``impacts``, when present,
        *replaces* the impact set: the parser owns its event's impacts.

        Requires add + change on maintenance events (an upsert is both).
        """
        from api.models import Provider
        from auth_api import rbac

        tenant = self._tenant_or_403()
        for verb in ("add", "change"):
            if not rbac.has_action(request.user, tenant, "maintenanceevent", verb):
                raise PermissionDenied(f"maintenanceevent:{verb} required.")

        data = dict(request.data)
        # Parsers speak workflow words ("confirmed"), not catalog UUIDs —
        # resolve against the tenant's own rows, refusing to invent any.
        raw_status = data.pop("status", None)
        if raw_status is not None:
            status_row = _resolve_event_status(tenant, raw_status)
            if status_row is None:
                raise ValidationError(
                    {"status": "Unknown status — ingestion does not invent "
                               "catalog rows. Add it under Settings → Statuses "
                               "(available to maintenance events) first."}
                )
            data["status_id"] = str(status_row.pk)
        provider_ref = data.pop("provider", None)
        provider = None
        if provider_ref:
            if _looks_like_uuid(provider_ref):
                provider = Provider.objects.filter(
                    tenant=tenant, pk=provider_ref
                ).first()
            else:
                provider = Provider.objects.filter(
                    tenant=tenant, slug=provider_ref
                ).first()
            if provider is None:
                raise ValidationError(
                    {"provider": "Unknown provider — ingestion does not invent catalog rows."}
                )
        external_ref = (data.get("external_ref") or "").strip()
        if not external_ref:
            raise ValidationError(
                {"external_ref": "Ingestion needs the provider's reference — "
                                 "it is what makes re-delivery an update."}
            )

        impacts = data.pop("impacts", None)
        existing = MaintenanceEvent.objects.filter(
            tenant=tenant, provider=provider, external_ref=external_ref
        ).first()
        serializer = self.get_serializer(existing, data=data, partial=existing is not None)
        serializer.is_valid(raise_exception=True)

        with transaction.atomic():
            event = serializer.save(
                tenant=tenant,
                provider=provider,
                **({} if existing else {"created_by": request.user}),
            )
            if impacts is not None:
                from audit.api import _can_view_object, _object_site_id
                from auth_api.object_types import label_for

                event.impacts.all().delete()
                for row in impacts:
                    label = label_for(str(row.get("object_type", "")))
                    oid = row.get("object_id")
                    if label is None or not oid:
                        raise ValidationError(
                            {"impacts": "Each impact needs object_type and object_id."}
                        )
                    if not _can_view_object(request, label, str(oid)):
                        raise PermissionDenied(
                            "Impact on an object this token cannot view."
                        )
                    EventImpact.objects.create(
                        tenant=tenant,
                        event=event,
                        object_type=label,
                        object_id=oid,
                        object_site_id=_object_site_id(label, str(oid)),
                        level=row.get("level", "outage"),
                        note=str(row.get("note", ""))[:255],
                    )
            event.sync_silence()

        return Response(
            self.get_serializer(event).data,
            status=status.HTTP_200_OK if existing else status.HTTP_201_CREATED,
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
        serializer.instance.event.sync_silence()

    def perform_destroy(self, instance):
        event = instance.event
        super().perform_destroy(instance)
        event.sync_silence()


def _looks_like_uuid(value) -> bool:
    import uuid

    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, AttributeError, TypeError):
        return False


def _resolve_event_status(tenant, value):
    """The tenant's maintenance-usable Status for an id, slug or name."""
    from api.models import Status

    qs = Status.objects.filter(
        tenant=tenant, available_to__contains=["maintenanceevent"]
    )
    if _looks_like_uuid(value):
        return qs.filter(pk=value).first()
    raw = str(value).strip()
    return (
        qs.filter(slug=raw.lower().replace(" ", "_")).first()
        or qs.filter(name__iexact=raw).first()
    )
