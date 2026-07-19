"""Compliance rule CRUD + on-demand evaluation for the SPA."""
from __future__ import annotations

from rest_framework import serializers
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet
from api.views import _get_active_tenant
from auth_api import rbac

from .engine import evaluate
from .models import OBJECT_TYPES, ComplianceRule


def _type_registry():
    """object_type slug → (model, serializer class). Imported lazily to avoid a
    circular import at module load (api.serializers imports from api.viewsets)."""
    from api import models as m
    from api import serializers as s

    return {
        "prefix": (m.Prefix, s.PrefixSerializer),
        "ipaddress": (m.IPAddress, s.IPAddressSerializer),
        "device": (m.Device, s.DeviceSerializer),
        "vlan": (m.VLAN, s.VLANSerializer),
        "vrf": (m.VRF, s.VRFSerializer),
        "site": (m.Site, s.SiteSerializer),
    }


def _serialize_violating_objects(rule, violations, request):
    """The failing rows for one rule, serialized with the type's real
    serializer, in violation order. Empty list if the type has no serializer."""
    entry = _type_registry().get(rule.object_type)
    if entry is None:
        return []
    model, serializer_cls = entry
    ids = [v["object_id"] for v in violations]
    if not ids:
        return []
    by_id = {
        str(obj.pk): obj
        for obj in model.objects.filter(tenant=rule.tenant, pk__in=ids)
    }
    ordered = [by_id[i] for i in ids if i in by_id]
    return serializer_cls(ordered, many=True, context={"request": request}).data


class ComplianceRuleSerializer(serializers.ModelSerializer):
    object_type_label = serializers.SerializerMethodField()
    check_type_display = serializers.CharField(
        source="get_check_type_display", read_only=True
    )

    class Meta:
        model = ComplianceRule
        fields = [
            "id", "name", "description", "enabled", "severity",
            "object_type", "object_type_label", "check_type",
            "check_type_display", "field", "pattern", "tag", "cf_key",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]

    def get_object_type_label(self, obj) -> str:
        return OBJECT_TYPES.get(obj.object_type, obj.object_type)

    def validate_object_type(self, value):
        if value not in OBJECT_TYPES:
            raise serializers.ValidationError(
                f"Unknown object type. Pick one of: {', '.join(OBJECT_TYPES)}."
            )
        return value

    def validate(self, attrs):
        ct = attrs.get("check_type", getattr(self.instance, "check_type", None))
        get = lambda k: attrs.get(k, getattr(self.instance, k, ""))  # noqa: E731
        if ct in ("required", "forbidden", "regex") and not get("field"):
            raise serializers.ValidationError({"field": "A field name is required."})
        if ct == "regex":
            pat = get("pattern")
            if not pat:
                raise serializers.ValidationError(
                    {"pattern": "A regex pattern is required."}
                )
            # Reject an uncompilable pattern at save time rather than silently
            # failing (returning "no violation") for every object at eval time.
            import re as _re

            try:
                _re.compile(pat)
            except _re.error as exc:
                raise serializers.ValidationError(
                    {"pattern": f"Invalid regular expression: {exc}"}
                )
        if ct == "required_tag" and not get("tag"):
            raise serializers.ValidationError({"tag": "A tag slug is required."})
        if ct == "required_cf" and not get("cf_key"):
            raise serializers.ValidationError({"cf_key": "A custom-field key is required."})
        return attrs


class ComplianceRuleViewSet(TenantScopedViewSet):
    queryset = ComplianceRule.objects.all().order_by("object_type", "name")
    serializer_class = ComplianceRuleSerializer

    @action(detail=True, methods=["get"], url_path="violations")
    def violations(self, request, pk=None):
        """Evaluate just this rule → the objects it currently fails.

        Powers the rule detail page's affected-objects table. Reuses the same
        live engine as the global evaluate, scoped to one rule (and the active
        tenant via the queryset)."""
        rule = self.get_object()
        result = evaluate(rule.tenant, rules=[rule])
        summary = next(iter(result["rules"]), None)
        # Serialize the failing objects with their *real* type serializer so the
        # detail page can render the genuine per-type table (all its columns),
        # not just an id + repr. One rule targets one object_type → homogeneous.
        objects = _serialize_violating_objects(
            rule, result["violations"], request
        )
        return Response({
            "rule": {
                "id": str(rule.id),
                "name": rule.name,
                "severity": rule.severity,
                "object_type": rule.object_type,
                "object_type_label": OBJECT_TYPES.get(
                    rule.object_type, rule.object_type
                ),
                "enabled": rule.enabled,
            },
            "violations": result["violations"],
            "objects": objects,
            "total": summary["violations"] if summary else 0,
        })


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def compliance_evaluate(request):
    """Evaluate enabled rules against current data → violations."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"rules": [], "violations": [], "total_violations": 0})
    if not rbac.has_action(request.user, tenant, "compliancerule", "view"):
        return Response({"detail": "compliancerule.view required."}, status=403)
    result = evaluate(tenant)
    _append_config_drift(result, tenant)
    return Response(result)


# Synthetic rule id for IaC config drift — not a real ComplianceRule. The
# frontend recognises it to route the badge/link to the Config-drift page.
CONFIG_DRIFT_RULE_ID = "config-drift"


def _append_config_drift(result: dict, tenant) -> None:
    """Surface drifted devices as synthetic compliance violations so a drifted
    device gets the same ⚠ marker (and Compliance-page row) as a rule violation.

    Naturally opt-in: only devices a runner has reported as drifted appear, so
    tenants that don't use IaC drift see nothing. Best-effort — never breaks the
    evaluation if the integrations app/table isn't there.
    """
    try:
        from integrations.models import DeviceConfigState
    except Exception:  # noqa: BLE001
        return
    drifted = (
        DeviceConfigState.objects.filter(tenant=tenant, status="drift")
        .select_related("device")
    )
    rows = [
        {
            "rule_id": CONFIG_DRIFT_RULE_ID,
            "rule_name": "Config drift",
            "severity": "warning",
            "object_type": "device",
            "object_type_label": OBJECT_TYPES.get("device", "Devices"),
            "object_route": "/devices",
            "object_id": str(s.device_id),
            "object_repr": (s.device.name or str(s.device_id))[:120],
        }
        for s in drifted
    ]
    if not rows:
        return
    result["violations"].extend(rows)
    result["rules"].append(
        {
            "id": CONFIG_DRIFT_RULE_ID,
            "name": "Config drift",
            "object_type": "device",
            "severity": "warning",
            "violations": len(rows),
        }
    )
    result["total_violations"] = result.get("total_violations", 0) + len(rows)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def compliance_object_types(request):
    """The object types + their available simple fields, for the rule form."""
    return Response(
        {"object_types": [{"value": k, "label": v} for k, v in OBJECT_TYPES.items()]}
    )
