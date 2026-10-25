"""Compliance rule CRUD + on-demand evaluation for the SPA."""
from __future__ import annotations

from types import SimpleNamespace

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

from .engine import detail_for, evaluate, evaluate_for_object
from .models import (
    COVERAGE_OBJECT_TYPES,
    EOL_OBJECT_TYPES,
    OBJECT_TYPES,
    SOFTWARE_TARGET_OBJECT_TYPES,
    ComplianceRule,
)


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
        "virtualmachine": (m.VirtualMachine, s.VirtualMachineSerializer),
    }


def _list_queryset(model):
    """The type's own list queryset - its joins and per-page annotations - so
    a page of violating rows costs what a page of that list costs."""
    from api.api_urls import router

    for _prefix, viewset, _basename in router.registry:
        qs = getattr(viewset, "queryset", None)
        if qs is not None and qs.model is model:
            return qs.all()
    return model.objects.all()


def _serialize_violating_objects(rule, violations, request):
    """The failing rows for one rule, serialized with the type's real
    serializer as its list serializes them, in violation order.

    A compliance grant says which rules fail, not what the failing objects
    hold: the rows are cut to what the caller may view of that type, and a
    caller who cannot view it gets none. Empty list if the type has no
    serializer."""
    entry = _type_registry().get(rule.object_type)
    if entry is None:
        return []
    model, serializer_cls = entry
    ids = [v["object_id"] for v in violations]
    if not ids:
        return []
    slug = model._meta.model_name
    if not rbac.has_action(request.user, rule.tenant, slug, "view"):
        return []
    qs = rbac.restrict_queryset(
        _list_queryset(model).filter(tenant=rule.tenant, pk__in=ids),
        request.user, rule.tenant, slug, "view",
    )
    by_id = {str(obj.pk): obj for obj in qs}
    ordered = [by_id[i] for i in ids if i in by_id]
    # A list context, so the detail-only tab counts are skipped exactly as
    # on the type's own list page.
    view = SimpleNamespace(action="list", request=request)
    return serializer_cls(
        ordered, many=True, context={"request": request, "view": view}
    ).data


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
            "eol_fail_on", "coverage_fail_on", "fail_on_unknown", "include_software",
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
        attrs = super().validate(attrs)
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
        if ct == "eol_status":
            ot = attrs.get("object_type", getattr(self.instance, "object_type", None))
            if ot not in EOL_OBJECT_TYPES:
                raise serializers.ValidationError({
                    "object_type": "An end-of-life check applies to devices or "
                                   "virtual machines."
                })
            if not get("eol_fail_on"):
                raise serializers.ValidationError(
                    {"eol_fail_on": "Pick what the check fails on."}
                )
            if get("include_software") and get("eol_fail_on") == "unknown":
                raise serializers.ValidationError({
                    "include_software": "Installed software counts when the check "
                                        "fails on end of life or support ending."
                })
        elif attrs.get("include_software"):
            raise serializers.ValidationError(
                {"include_software": "Only an end-of-life check reads installed software."}
            )
        if ct == "coverage":
            ot = attrs.get("object_type", getattr(self.instance, "object_type", None))
            if ot not in COVERAGE_OBJECT_TYPES:
                raise serializers.ValidationError(
                    {"object_type": "A support coverage check applies to devices."}
                )
            if not get("coverage_fail_on"):
                raise serializers.ValidationError(
                    {"coverage_fail_on": "Pick what the check fails on."}
                )
        if ct == "software_target":
            ot = attrs.get("object_type", getattr(self.instance, "object_type", None))
            if ot not in SOFTWARE_TARGET_OBJECT_TYPES:
                raise serializers.ValidationError({
                    "object_type": "A software target check applies to devices or "
                                   "virtual machines."
                })
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
        result = evaluate(rule.tenant, rules=[rule], scope=_view_scope(request, rule.tenant))
        result.pop("failing_objects", None)
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
            # The rule's whole counts, triage included, and when they were taken.
            "result": summary,
            "evaluated_at": result["evaluated_at"],
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
        OpenApiParameter(
            name="site",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Comma-separated site ids; 'none' for objects without a site.",
        ),
        OpenApiParameter(
            name="tag",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Comma-separated tag slugs; an object with any of them.",
        ),
        OpenApiParameter(
            name="state",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Comma-separated triage states (open,acknowledged,snoozed).",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Per-rule summary, flat violations list, total_violations, "
            "objects_in_violation and facets."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def compliance_evaluate(request):
    """Evaluate enabled rules against current data → violations.

    Optional query params narrow the flat ``violations`` list (the per-rule
    ``rules`` summary and ``total_violations`` always reflect the full,
    unfiltered evaluation):

    - ``severity``    - comma-separated severities (critical,warning,info)
    - ``object_type`` - comma-separated object types (device,prefix,…)
    - ``rule``        - a rule id (or ``config-drift``)
    - ``object``      - an object id (e.g. one device)
    - ``q``           - case-insensitive substring over object repr + rule name
    """
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"rules": [], "violations": [], "total_violations": 0})
    if not rbac.has_action(request.user, tenant, "compliancerule", "view"):
        return Response({"detail": "compliancerule.view required."}, status=403)
    scope = _view_scope(request, tenant)
    result = evaluate(tenant, scope=scope)
    _append_config_drift(result, tenant, scope)
    result["objects_in_violation"] = len(result.pop("failing_objects"))
    result["facets"] = _facets(result["violations"], result.pop("tags"))
    result["violations"] = _filter_violations(result["violations"], request)
    return Response(result)


def _view_scope(request, tenant):
    """The ``scope`` for :func:`evaluate`: each type's rows cut to what the
    caller may view of it, None when that is every row. A compliance grant
    says which rules fail, not which objects fail them."""
    def scope(object_type, qs):
        slug = qs.model._meta.model_name
        if rbac.row_filter(request.user, tenant, slug, "view") is True:
            return None
        return rbac.restrict_queryset(qs, request.user, tenant, slug, "view")

    return scope


def _csv(value: str | None) -> set[str]:
    return {v for v in (value or "").split(",") if v}


def _filter_violations(violations: list[dict], request) -> list[dict]:
    """Apply the evaluate endpoint's optional query-param filters. Values
    within one parameter are ORed; parameters are ANDed."""
    p = request.query_params
    severities = _csv(p.get("severity"))
    types = _csv(p.get("object_type"))
    rule_ids = _csv(p.get("rule"))
    object_id = p.get("object") or ""
    sites = _csv(p.get("site"))
    tags = _csv(p.get("tag"))
    states = _csv(p.get("state"))
    needle = (p.get("q") or "").strip().lower()

    def keep(v: dict) -> bool:
        if severities and v["severity"] not in severities:
            return False
        if types and v["object_type"] not in types:
            return False
        if rule_ids and v["rule_id"] not in rule_ids:
            return False
        if object_id and v["object_id"] != object_id:
            return False
        if sites and (v.get("site_id") or "none") not in sites:
            return False
        if tags and not tags.intersection(v.get("tags") or ()):
            return False
        if states and v.get("state", "open") not in states:
            return False
        if needle and needle not in v["object_repr"].lower() \
                and needle not in v["rule_name"].lower():
            return False
        return True

    if not (severities or types or rule_ids or object_id or sites or tags
            or states or needle):
        return violations
    return [v for v in violations if keep(v)]


_SEVERITY_ORDER = ("critical", "warning", "info")
_STATE_LABELS = {"open": "Open", "acknowledged": "Acknowledged", "snoozed": "Snoozed"}


def _facets(violations: list[dict], tag_info: dict) -> dict:
    """Value counts over the violations the caller may see, for the
    Violations tab's filter rail: one list of ``{value, label, count}`` per
    facet, most frequent first (severity and state in their own order)."""
    from collections import Counter

    rule = Counter()
    rule_label = {}
    sev = Counter()
    otype = Counter()
    otype_label = {}
    site = Counter()
    site_label = {}
    tag = Counter()
    state = Counter()
    for v in violations:
        rule[v["rule_id"]] += 1
        rule_label[v["rule_id"]] = v["rule_name"]
        sev[v["severity"]] += 1
        otype[v["object_type"]] += 1
        otype_label[v["object_type"]] = v["object_type_label"]
        sid = v.get("site_id") or "none"
        site[sid] += 1
        site_label[sid] = v.get("site_name") or "No site"
        for t in v.get("tags") or ():
            tag[t] += 1
        state[v.get("state", "open")] += 1

    def ranked(counter, labels):
        return [
            {"value": k, "label": labels.get(k, k), "count": n}
            for k, n in sorted(counter.items(), key=lambda kv: (-kv[1], labels.get(kv[0], kv[0])))
        ]

    return {
        "severity": [
            {"value": s, "label": s.capitalize(), "count": sev[s]}
            for s in _SEVERITY_ORDER if sev[s]
        ],
        "state": [
            {"value": s, "label": label, "count": state[s]}
            for s, label in _STATE_LABELS.items() if state[s]
        ],
        "rule": ranked(rule, rule_label),
        "object_type": ranked(otype, otype_label),
        "site": ranked(site, site_label),
        "tag": [
            {
                **row,
                "id": tag_info.get(row["value"], {}).get("id"),
                "color": tag_info.get(row["value"], {}).get("color", ""),
                "text_color": tag_info.get(row["value"], {}).get("text_color", ""),
            }
            for row in ranked(tag, {k: i["name"] for k, i in tag_info.items()})
        ],
    }


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
    device itself - a device outside the caller's constraints 404s
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
            "eol_fail_on": rule.eol_fail_on,
            "detail": detail_for(rule, device),
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


# Synthetic rule id for IaC config drift - not a real ComplianceRule. The
# frontend recognises it to route the badge/link to the Config-drift page.
CONFIG_DRIFT_RULE_ID = "config-drift"


def _append_config_drift(result: dict, tenant, scope=None) -> None:
    """Surface drifted devices as synthetic compliance violations so a drifted
    device gets the same ⚠ marker (and Compliance-page row) as a rule violation.

    Naturally opt-in: only devices a runner has reported as drifted appear, so
    tenants that don't use IaC drift see nothing. Best-effort - never breaks the
    evaluation if the integrations app/table isn't there.
    """
    try:
        from integrations.models import DeviceConfigState
    except Exception:  # noqa: BLE001
        return
    from api.models import Device

    drifted = (
        DeviceConfigState.objects.filter(tenant=tenant, status="drift")
        .select_related("device__site")
        .prefetch_related("device__tags")
    )
    drifted_ids = list(drifted.values_list("device_id", flat=True))
    total = len(drifted_ids)
    viewable = (
        scope("device", Device.objects.filter(tenant=tenant)) if scope is not None else None
    )
    if viewable is not None:
        drifted = drifted.filter(device__in=viewable)
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
            "detail": "",
            "site_id": str(s.device.site_id) if s.device.site_id else None,
            "site_name": str(s.device.site) if s.device.site_id else "",
            "tags": sorted(t.slug for t in s.device.tags.all()),
            # Drift is the runner's to clear, not triage's: always open.
            "state": "open",
            "acknowledged_at": None,
            "acknowledged_by": "",
            "snoozed_until": None,
            "note": "",
        }
        for s in drifted
    ]
    if not total:
        return
    failing = result.get("failing_objects")
    if failing is not None:
        failing.update(("device", str(i)) for i in drifted_ids)
    for s in drifted:
        for t in s.device.tags.all():
            result.setdefault("tags", {}).setdefault(
                t.slug, {"id": t.pk, "name": t.name, "color": t.color,
                 "text_color": t.text_color}
            )
    result["violations"].extend(rows)
    # Counted whole, like a rule's count; the rows are the caller's own.
    result["rules"].append(
        {
            "id": CONFIG_DRIFT_RULE_ID,
            "name": "Config drift",
            "object_type": "device",
            "object_type_label": OBJECT_TYPES["device"],
            "severity": "warning",
            "violations": total,
            "open": total,
            "acknowledged": 0,
            "snoozed": 0,
        }
    )
    result["total_violations"] = result.get("total_violations", 0) + total


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


# ─── Summary (the Overview tab) ──────────────────────────────────────────────

_SEVERITY_RANK = {"critical": 3, "warning": 2, "info": 1}
_TOP_OFFENDERS = 10


def _empty_bucket() -> dict:
    return {"rules": 0, "failing_rules": 0, "violations": 0, "open": 0}


@extend_schema(
    summary="Compliance overview: totals, per-rule results and top offenders",
    tags=["compliance"],
    request=None,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "evaluated_at, totals, by_severity, rules (one row per enabled "
            "rule, worst first) and top_offenders."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def compliance_summary(request):
    """Everything the Overview tab draws, from one evaluation.

    One query reads every rule, one the triage rows, and one scan runs per
    object type the enabled rules cover - the cost does not grow with the
    number of rules. Counts are whole, like the evaluate endpoint's; the top
    offenders name only objects the caller may view."""
    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant selected."}, status=403)
    if not rbac.has_action(request.user, tenant, "compliancerule", "view"):
        return Response({"detail": "compliancerule.view required."}, status=403)

    all_rules = list(ComplianceRule.objects.filter(tenant=tenant))
    enabled = [r for r in all_rules if r.enabled]
    by_id = {str(r.id): r for r in enabled}
    scope = _view_scope(request, tenant)
    result = evaluate(tenant, rules=enabled, scope=scope)
    _append_config_drift(result, tenant, scope)

    rows = []
    for row in result["rules"]:
        rule = by_id.get(row["id"])
        rows.append({
            **row,
            "check_type": rule.check_type if rule else "",
            "field": rule.field if rule else "",
            "pattern": rule.pattern if rule else "",
            "tag": rule.tag if rule else "",
            "cf_key": rule.cf_key if rule else "",
            "eol_fail_on": rule.eol_fail_on if rule else "",
            "coverage_fail_on": rule.coverage_fail_on if rule else "",
            "fail_on_unknown": rule.fail_on_unknown if rule else False,
        })
    # Worst first: open failures by severity, then by how many, then name.
    rows.sort(key=lambda r: (
        -_SEVERITY_RANK.get(r["severity"], 0) if r["open"] else 0,
        -r["open"], -r["violations"], r["name"].lower(),
    ))

    by_severity = {s: _empty_bucket() for s in _SEVERITY_RANK}
    for r in rows:
        b = by_severity.setdefault(r["severity"], _empty_bucket())
        b["rules"] += 1
        b["failing_rules"] += 1 if r["violations"] else 0
        b["violations"] += r["violations"]
        b["open"] += r["open"]

    offenders: dict[tuple[str, str], dict] = {}
    for v in result["violations"]:
        key = (v["object_type"], v["object_id"])
        o = offenders.get(key)
        if o is None:
            o = offenders[key] = {
                "object_type": v["object_type"],
                "object_type_label": v["object_type_label"],
                "object_id": v["object_id"],
                "object_repr": v["object_repr"],
                "site_name": v.get("site_name", ""),
                "violations": 0,
                "open": 0,
                "worst_severity": v["severity"],
                "rules": [],
            }
        o["violations"] += 1
        o["open"] += 1 if v.get("state", "open") == "open" else 0
        if _SEVERITY_RANK.get(v["severity"], 0) > _SEVERITY_RANK.get(o["worst_severity"], 0):
            o["worst_severity"] = v["severity"]
        o["rules"].append(v["rule_name"])
    top = sorted(
        offenders.values(),
        key=lambda o: (-o["violations"], -_SEVERITY_RANK.get(o["worst_severity"], 0),
                       o["object_repr"].lower()),
    )[:_TOP_OFFENDERS]

    failing = sum(1 for r in rows if r["violations"])
    return Response({
        "evaluated_at": result["evaluated_at"],
        "totals": {
            "rules": len(rows),
            "disabled_rules": len(all_rules) - len(enabled),
            "passing": len(rows) - failing,
            "failing": failing,
            "violations": result["total_violations"],
            "open": sum(r["open"] for r in rows),
            "acknowledged": sum(r["acknowledged"] for r in rows),
            "snoozed": sum(r["snoozed"] for r in rows),
            "objects_in_violation": len(result["failing_objects"]),
        },
        "by_severity": by_severity,
        "rules": rows,
        "top_offenders": top,
    })


# ─── Triage: acknowledge / snooze ────────────────────────────────────────────

_TRIAGE_MAX_ITEMS = 1000
_SNOOZE_MAX_DAYS = 366


class _TriageItemSerializer(serializers.Serializer):
    rule_id = serializers.UUIDField()
    object_id = serializers.UUIDField()


class ComplianceTriageSerializer(serializers.Serializer):
    action = serializers.ChoiceField(choices=["acknowledge", "snooze", "clear"])
    items = _TriageItemSerializer(many=True, allow_empty=False)
    until = serializers.DateTimeField(required=False, allow_null=True)
    note = serializers.CharField(required=False, allow_blank=True, max_length=255)

    def validate_items(self, value):
        if len(value) > _TRIAGE_MAX_ITEMS:
            raise serializers.ValidationError(
                f"At most {_TRIAGE_MAX_ITEMS} violations at a time."
            )
        return value

    def validate(self, attrs):
        from datetime import timedelta

        from django.utils import timezone

        if attrs["action"] == "snooze":
            until = attrs.get("until")
            now = timezone.now()
            if until is None:
                raise serializers.ValidationError({"until": "Pick when the snooze ends."})
            if until <= now:
                raise serializers.ValidationError({"until": "Pick a time in the future."})
            if until > now + timedelta(days=_SNOOZE_MAX_DAYS):
                raise serializers.ValidationError(
                    {"until": f"A snooze lasts at most {_SNOOZE_MAX_DAYS} days."}
                )
        return attrs


_TRIAGE_VERB = {"acknowledge": "Acknowledged", "snooze": "Snoozed", "clear": "Cleared"}


@extend_schema(
    summary="Acknowledge, snooze or clear compliance violations",
    tags=["compliance"],
    request=ComplianceTriageSerializer,
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT, description="{updated: n}",
    ),
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def compliance_triage(request):
    """Record an operator's decision on violations (rule + object pairs).

    ``acknowledge`` marks them seen, ``snooze`` takes them out of the open
    count until ``until``, and ``clear`` returns them to open. Needs
    ``compliancetriage.change`` - its own grant, apart from editing rules;
    each rule must be the tenant's and each object one the caller may view. Every row is written through the model, so the
    change log records it, and each rule and object gets a journal note."""
    from django.db import transaction
    from django.utils import timezone

    from audit.models import JournalEntry, JournalKind
    from audit.site_capture import entry_site_id

    from .models import ComplianceTriage

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant selected."}, status=403)
    if not rbac.has_action(request.user, tenant, "compliancetriage", "change"):
        return Response({"detail": "compliancetriage.change required."}, status=403)
    ser = ComplianceTriageSerializer(data=request.data)
    ser.is_valid(raise_exception=True)
    action = ser.validated_data["action"]
    note = ser.validated_data.get("note", "")
    until = ser.validated_data.get("until")
    items = {(str(i["rule_id"]), str(i["object_id"])) for i in ser.validated_data["items"]}
    rule_ids = {rid for rid, _ in items}

    rules = {
        str(r.id): r
        for r in ComplianceRule.objects.filter(tenant=tenant, pk__in=rule_ids)
    }
    if len(rules) != len(rule_ids):
        raise serializers.ValidationError({"items": "Unknown rule."})

    # Each object must be the tenant's and one the caller may view - checked
    # per object type, one query each, before anything is written.
    registry = _type_registry()
    objects = {}
    wanted: dict[str, set[str]] = {}
    for rid, oid in items:
        wanted.setdefault(rules[rid].object_type, set()).add(oid)
    for object_type, ids in wanted.items():
        model = registry[object_type][0]
        qs = rbac.restrict_queryset(
            model.objects.filter(tenant=tenant, pk__in=ids),
            request.user, tenant, model._meta.model_name, "view",
        )
        found = {str(o.pk): o for o in qs}
        if len(found) != len(ids):
            raise serializers.ValidationError({"items": "Unknown object."})
        objects.update(found)

    user = request.user
    now = timezone.now()
    existing = {
        (str(t.rule_id), str(t.object_id)): t
        for t in ComplianceTriage.objects.filter(
            tenant=tenant, rule_id__in=rule_ids,
            object_id__in={oid for _, oid in items},
        ).select_related("rule")
    }
    verb = _TRIAGE_VERB[action]
    suffix = f" until {until:%Y-%m-%d %H:%M} UTC" if action == "snooze" else ""
    journal = []
    per_rule: dict[str, list[str]] = {}
    with transaction.atomic():
        for rid, oid in sorted(items):
            rule, obj = rules[rid], objects[oid]
            row = existing.get((rid, oid))
            if action == "clear":
                if row is None:
                    continue
                row.delete()
            else:
                if row is None:
                    row = ComplianceTriage(
                        tenant=tenant, rule=rule, object_type=rule.object_type,
                        object_id=obj.pk,
                    )
                row.object_repr = str(obj)[:120]
                if action == "acknowledge":
                    row.acknowledged_at = now
                    row.acknowledged_by = user
                else:
                    row.snoozed_until = until
                    row.snoozed_by = user
                if note:
                    row.note = note
                row.save()
            per_rule.setdefault(rid, []).append(str(obj)[:120])
            text = f"{verb} compliance violation of {rule.name}{suffix}."
            journal.append(JournalEntry(
                tenant=tenant, created_by=user, author_name=user.get_username(),
                object_type=obj._meta.label_lower, object_id=str(obj.pk),
                object_site_id=entry_site_id(obj), kind=JournalKind.INFO,
                comments=f"{text} {note}".strip(),
            ))
        for rid, names in per_rule.items():
            shown = ", ".join(names[:20])
            if len(names) > 20:
                shown += f" and {len(names) - 20} more"
            plural = "s" if len(names) != 1 else ""
            journal.append(JournalEntry(
                tenant=tenant, created_by=user, author_name=user.get_username(),
                object_type="compliance.compliancerule", object_id=rid,
                kind=JournalKind.INFO,
                comments=f"{verb} {len(names)} violation{plural}{suffix}: {shown}. "
                         f"{note}".strip(),
            ))
        JournalEntry.objects.bulk_create(journal)
    return Response({"updated": sum(len(n) for n in per_rule.values())})
