"""Webhooks admin API — tenant-scoped CRUD + a synchronous test-fire."""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet

from .models import DeviceConfigSnapshot, DeviceConfigState, Webhook
from .webhooks import deliver_webhook


class WebhookSerializer(serializers.ModelSerializer):
    # Write-only signing secret; reads expose a boolean instead.
    secret = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    secret_set = serializers.SerializerMethodField()

    def get_secret_set(self, obj) -> bool:
        return bool(obj.secret)

    def validate_object_types(self, value):
        if not isinstance(value, list) or not value:
            raise serializers.ValidationError("Pick at least one object type.")
        return value

    def update(self, instance, validated):
        # A blank secret on update leaves the stored one untouched.
        if validated.get("secret", None) == "":
            validated.pop("secret", None)
        return super().update(instance, validated)

    class Meta:
        model = Webhook
        fields = ["id", "name", "enabled", "object_types", "on_create",
                  "on_update", "on_delete", "payload_url", "http_method",
                  "http_content_type", "secret", "secret_set",
                  "additional_headers", "ssl_verification",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "secret_set", "created_at", "updated_at"]


class WebhookViewSet(TenantScopedViewSet):
    queryset = Webhook.objects.all().order_by("name")
    serializer_class = WebhookSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(payload_url__icontains=s)
        return qs

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Fire a sample delivery synchronously and return the result."""
        hook = self.get_object()
        result = deliver_webhook(
            str(hook.id),
            "test",
            "webhook",
            str(hook.id),
            {"message": "This is a test delivery from Danbyte."},
        )
        return Response(result)


# ─── Automation targets + deploy runs (Phase 2) ──────────────────────────────
from .models import AutomationTarget, DeployRun  # noqa: E402


class AutomationTargetSerializer(serializers.ModelSerializer):
    token = serializers.CharField(
        write_only=True, required=False, allow_blank=True, trim_whitespace=False
    )
    token_set = serializers.SerializerMethodField()
    kind_display = serializers.CharField(source="get_kind_display", read_only=True)
    # A plain CharField (not the model's ChoiceField) so plugin-registered
    # automation kinds validate; the built-ins awx/webhook are registered too.
    kind = serializers.CharField()

    def get_token_set(self, obj) -> bool:
        return bool(obj.token)

    def validate_kind(self, value):
        from .providers import automation_kinds, automation_provider

        if automation_provider(value) is None:
            raise serializers.ValidationError(
                f"Unknown automation kind '{value}'. Available: "
                f"{', '.join(automation_kinds()) or '(none registered)'}."
            )
        return value

    def update(self, instance, validated):
        if validated.get("token", None) == "":
            validated.pop("token", None)  # blank = keep existing
        return super().update(instance, validated)

    class Meta:
        model = AutomationTarget
        fields = ["id", "name", "kind", "kind_display", "enabled", "base_url",
                  "job_template_id", "token", "token_set", "ssl_verify",
                  "extra_vars", "auto_on_change", "object_types",
                  "created_at", "updated_at"]
        read_only_fields = ["id", "kind_display", "token_set",
                            "created_at", "updated_at"]


class AutomationTargetViewSet(TenantScopedViewSet):
    queryset = AutomationTarget.objects.all().order_by("name")
    serializer_class = AutomationTargetSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request:
            s = self.request.query_params.get("search", "").strip()
            if s:
                qs = qs.filter(name__icontains=s) | qs.filter(base_url__icontains=s)
        return qs

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Reachability check — AWX /api/v2/ping/, or a HEAD to the webhook URL."""
        from core.ssrf import safe_get, safe_request

        t = self.get_object()
        try:
            if t.kind == "awx":
                r = safe_get(
                    t.base_url.rstrip("/") + "/api/v2/ping/",
                    headers={"Authorization": f"Bearer {t.token}"}
                    if t.token else {},
                    timeout=10, verify=t.ssl_verify,
                )
                ok = r.status_code == 200
                return Response({"ok": ok, "status_code": r.status_code})
            r = safe_request("HEAD", t.base_url, timeout=10, verify=t.ssl_verify)
            return Response({"ok": r.status_code < 500, "status_code": r.status_code})
        except Exception as exc:  # noqa: BLE001
            return Response({"ok": False, "error": str(exc)}, status=502)

    @action(detail=True, methods=["post"])
    def deploy(self, request, pk=None):
        """Bulk deploy: dispatch the given devices to this target in one run.

        Body: {"device_ids": ["<uuid>", ...]}. Device ids are validated against
        the caller's row/site view scope for `device` (not just the target's
        tenant) — otherwise a Site-A operator could enqueue a deploy / AWX job
        against Site-B devices they can't see.
        """
        from api.models import Device
        from auth_api import rbac

        target = self.get_object()
        if not target.enabled:
            return Response({"detail": "Target is disabled."}, status=400)
        ids = (request.data or {}).get("device_ids") or []
        if not isinstance(ids, list) or not ids:
            return Response({"detail": "device_ids must be a non-empty list."},
                            status=400)
        valid = list(
            rbac.restrict_queryset(
                Device.objects.filter(tenant=target.tenant, id__in=ids),
                request.user, target.tenant, "device", "view",
            ).values_list("id", flat=True)
        )
        if not valid:
            return Response(
                {"detail": "No matching devices in this tenant."}, status=400
            )
        from .dispatch import enqueue_deploy

        run = enqueue_deploy(target, valid, event="bulk")
        return Response(DeployRunSerializer(run).data, status=202)


class DeployRunSerializer(serializers.ModelSerializer):
    can_retry = serializers.SerializerMethodField()
    duration_ms = serializers.SerializerMethodField()

    def get_can_retry(self, obj) -> bool:
        # A failed run can be re-fired only while its target still exists + is on.
        return bool(
            obj.status == "failed" and obj.target_id and obj.target
            and obj.target.enabled
        )

    def get_duration_ms(self, obj):
        if obj.finished_at and obj.created_at:
            return int((obj.finished_at - obj.created_at).total_seconds() * 1000)
        return None

    class Meta:
        model = DeployRun
        fields = ["id", "target_name", "event", "device_ids", "status",
                  "detail", "created_at", "finished_at", "attempt", "retry_of",
                  "can_retry", "duration_ms"]
        read_only_fields = fields


class DeployRunViewSet(TenantScopedViewSet):
    queryset = DeployRun.objects.select_related("target").order_by("-created_at")
    serializer_class = DeployRunSerializer
    # POST is enabled only for the `retry` detail action — the collection stays
    # read-only (create() below 405s so the generic ModelViewSet write that
    # enabling "post" would otherwise expose can't mint blank runs).
    http_method_names = ["get", "post"]

    def create(self, request, *args, **kwargs):
        from rest_framework.exceptions import MethodNotAllowed

        raise MethodNotAllowed("POST")

    def get_queryset(self):
        qs = super().get_queryset()
        # ?device=<id> → runs that targeted that device (device_ids is JSON).
        device = self.request.query_params.get("device")
        if device:
            qs = qs.filter(device_ids__contains=device)
        status_ = self.request.query_params.get("status")
        if status_:
            qs = qs.filter(status=status_)
        return qs

    @action(detail=True, methods=["post"])
    def retry(self, request, pk=None):
        """Re-fire a failed run against the same target + devices as a new run,
        linked back via ``retry_of`` and ``attempt``."""
        run = self.get_object()
        # Re-firing a deploy needs the same authority as launching one. DeployRun
        # isn't an RBAC-registered type (so it'd default open) — gate on the
        # automation target's `change` permission instead.
        from auth_api import rbac

        if not (
            request.user.is_superuser
            or rbac.has_action(
                request.user, self._tenant_or_403(), "automationtarget", "change"
            )
        ):
            return Response(
                {"detail": "You don't have permission to launch deploys."},
                status=403,
            )
        if run.status != "failed":
            return Response(
                {"detail": "Only failed runs can be retried."}, status=400
            )
        target = run.target
        if target is None or not target.enabled:
            return Response(
                {"detail": "Target is missing or disabled."}, status=400
            )
        from api.models import Device

        valid = list(
            rbac.restrict_queryset(
                Device.objects.filter(
                    tenant=target.tenant, id__in=run.device_ids
                ),
                request.user, target.tenant, "device", "view",
            ).values_list("id", flat=True)
        )
        if not valid:
            return Response(
                {"detail": "No matching devices in this tenant."}, status=400
            )
        from .dispatch import enqueue_deploy

        new = enqueue_deploy(
            target, valid, event=run.event,
            attempt=run.attempt + 1, retry_of=run.retry_of or run,
        )
        return Response(DeployRunSerializer(new).data, status=202)


class DeviceConfigStateSerializer(serializers.ModelSerializer):
    template_name = serializers.CharField(
        source="template.name", read_only=True, default=None
    )

    class Meta:
        from .models import DeviceConfigState

        model = DeviceConfigState
        fields = ["id", "device", "status", "intended_config", "actual_config",
                  "diff", "source", "template", "template_name", "reported_at",
                  "updated_at"]
        read_only_fields = ["id", "status", "diff", "template_name",
                            "reported_at", "updated_at"]


class DeviceConfigStateListSerializer(serializers.ModelSerializer):
    """Light row for the tenant-wide drift list — omits the big config blobs,
    keeps just what a table needs (device name/id + status + when)."""

    device_name = serializers.CharField(source="device.name", read_only=True)
    template_name = serializers.CharField(
        source="template.name", read_only=True, default=None
    )

    class Meta:
        model = DeviceConfigState
        fields = ["id", "device", "device_name", "status", "source",
                  "template_name", "reported_at"]
        read_only_fields = fields


class DeviceConfigStateViewSet(TenantScopedViewSet):
    """Read-only tenant-wide config-drift list. Per-device read/report stays on
    the device endpoint (/api/devices/<id>/config-state/)."""

    queryset = (
        DeviceConfigState.objects.select_related("device", "template")
        .all()
        .order_by("-reported_at")
    )
    serializer_class = DeviceConfigStateListSerializer
    http_method_names = ["get"]

    def get_queryset(self):
        qs = super().get_queryset()
        status_ = self.request.query_params.get("status")
        if status_:
            qs = qs.filter(status=status_)
        return qs


class DeviceConfigSnapshotSerializer(serializers.ModelSerializer):
    class Meta:
        model = DeviceConfigSnapshot
        fields = ["id", "device", "status", "diff", "source", "created_at"]
        read_only_fields = fields


class DeviceConfigSnapshotViewSet(TenantScopedViewSet):
    """Read-only drift-transition history. Filter to one device with ?device=."""

    queryset = DeviceConfigSnapshot.objects.all().order_by("-created_at")
    serializer_class = DeviceConfigSnapshotSerializer
    http_method_names = ["get"]

    def get_queryset(self):
        qs = super().get_queryset()
        device = self.request.query_params.get("device")
        if device:
            qs = qs.filter(device_id=device)
        return qs
