"""Compliance rule CRUD + on-demand evaluation for the SPA."""
from __future__ import annotations

from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
)
from rest_framework import serializers
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.viewsets import TenantScopedViewSet
from api.views import _get_active_tenant
from auth_api import rbac

from .engine import evaluate, evaluate_for_object
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
            "id", "name", "description", "remediation", "enabled", "severity",
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


@extend_schema(
    summary="Evaluate enabled compliance rules against current data",
    tags=["compliance"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="severity",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Comma-separated severities (critical,warning,info).",
        ),
        OpenApiParameter(
            name="object_type",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Comma-separated object types (device,prefix,…).",
        ),
        OpenApiParameter(
            name="rule",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="A rule id (or 'config-drift').",
        ),
        OpenApiParameter(
            name="object",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="An object id (e.g. one device).",
        ),
        OpenApiParameter(
            name="q",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Case-insensitive substring over object repr + rule name.",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="Per-rule summary, flat violations list, and total_violations.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def compliance_evaluate(request):
    """Evaluate enabled rules against current data → violations.

    Optional query params narrow the flat ``violations`` list (the per-rule
    ``rules`` summary and ``total_violations`` always reflect the full,
    unfiltered evaluation):

    - ``severity``    — comma-separated severities (critical,warning,info)
    - ``object_type`` — comma-separated object types (device,prefix,…)
    - ``rule``        — a rule id (or ``config-drift``)
    - ``object``      — an object id (e.g. one device)
    - ``q``           — case-insensitive substring over object repr + rule name
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"rules": [], "violations": [], "total_violations": 0})
    if not rbac.has_action(request.user, tenant, "compliancerule", "view"):
        return Response({"detail": "compliancerule.view required."}, status=403)
    result = evaluate(tenant)
    _append_config_drift(result, tenant)
    result["violations"] = _filter_violations(result["violations"], request)
    return Response(result)


def _filter_violations(violations: list[dict], request) -> list[dict]:
    """Apply the evaluate endpoint's optional query-param filters."""
    p = request.query_params
    severities = {s for s in (p.get("severity") or "").split(",") if s}
    types = {t for t in (p.get("object_type") or "").split(",") if t}
    rule_id = p.get("rule") or ""
    object_id = p.get("object") or ""
    needle = (p.get("q") or "").strip().lower()

    def keep(v: dict) -> bool:
        if severities and v["severity"] not in severities:
            return False
        if types and v["object_type"] not in types:
            return False
        if rule_id and v["rule_id"] != rule_id:
            return False
        if object_id and v["object_id"] != object_id:
            return False
        if needle and needle not in v["object_repr"].lower() \
                and needle not in v["rule_name"].lower():
            return False
        return True

    if not (severities or types or rule_id or object_id or needle):
        return violations
    return [v for v in violations if keep(v)]


@extend_schema(
    summary="One device's compliance status (failing rules or all-clear)",
    tags=["compliance"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "The device, an all_clear flag, total, and the failed rules with "
            "their remediation guides."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def compliance_device_status(request, device_id):
    """One device's compliance status: the rules it currently fails (with
    their remediation guides), or an all-clear flag.

    RBAC: requires ``compliancerule.view`` plus row-scoped visibility of the
    device itself — a device outside the caller's constraints 404s
    (non-leaking), the same contract as the rest of the app.
    """
    from api.models import Device

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant selected."}, status=403)
    if not rbac.has_action(request.user, tenant, "compliancerule", "view"):
        return Response({"detail": "compliancerule.view required."}, status=403)
    qs = Device.objects.filter(tenant=tenant)
    qs = rbac.restrict_queryset(qs, request.user, tenant, "device", "view")
    device = qs.filter(pk=device_id).first()
    if device is None:
        return Response({"detail": "Not found."}, status=404)

    failed = evaluate_for_object(tenant, "device", device)
    violations = [
        {
            "rule_id": str(rule.id),
            "rule_name": rule.name,
            "severity": rule.severity,
            "description": rule.description,
            "remediation": rule.remediation,
            "check_type": rule.check_type,
            "field": rule.field,
            "pattern": rule.pattern,
            "tag": rule.tag,
            "cf_key": rule.cf_key,
        }
        for rule in failed
    ]
    if _device_has_config_drift(tenant, device):
        violations.append(
            {
                "rule_id": CONFIG_DRIFT_RULE_ID,
                "rule_name": "Config drift",
                "severity": "warning",
                "description": "The device's live configuration has drifted "
                               "from its intended (IaC) configuration.",
                "remediation": "",
                "check_type": "",
                "field": "",
                "pattern": "",
                "tag": "",
                "cf_key": "",
            }
        )
    return Response(
        {
            "device": {"id": str(device.pk), "name": device.name or str(device.pk)},
            "all_clear": not violations,
            "total": len(violations),
            "violations": violations,
        }
    )


def _device_has_config_drift(tenant, device) -> bool:
    """Mirror of :func:`_append_config_drift` for a single device."""
    try:
        from integrations.models import DeviceConfigState
    except Exception:  # noqa: BLE001
        return False
    return DeviceConfigState.objects.filter(
        tenant=tenant, device=device, status="drift"
    ).exists()


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


@extend_schema(
    summary="Object types and their simple fields, for the rule form",
    tags=["compliance"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="An object_types list of {value, label} entries.",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def compliance_object_types(request):
    """The object types + their available simple fields, for the rule form."""
    return Response(
        {"object_types": [{"value": k, "label": v} for k, v in OBJECT_TYPES.items()]}
    )
