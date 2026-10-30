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

from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api import rbac
from core.expressions import ExpressionError, leaves, regex_error
from core.expressions import validate as validate_expression

from .engine import (
    detail_for,
    evaluate,
    evaluate_for_object,
    preview_rule,
    type_label,
    valid_pk,
)
from .fields import REF_MODELS, ref_model
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


def _serialize_violating_objects(rule, violations, request) -> dict[str, list]:
    """The failing rows for one rule, per object type, each serialized with
    its type's real serializer as its list serializes them, in violation
    order.

    A compliance grant says which rules fail, not what the failing objects
    hold: the rows are cut to what the caller may view of each type, and a
    caller who cannot view a type gets none of it."""
    registry = _type_registry()
    ids_by_type: dict[str, list[str]] = {}
    for v in violations:
        ids_by_type.setdefault(v["object_type"], []).append(v["object_id"])
    out: dict[str, list] = {}
    for object_type in rule.types:
        entry = registry.get(object_type)
        ids = ids_by_type.get(object_type) or []
        if entry is None or not ids:
            out[object_type] = []
            continue
        model, serializer_cls = entry
        slug = model._meta.model_name
        if not rbac.has_action(request.user, rule.tenant, slug, "view"):
            out[object_type] = []
            continue
        qs = rbac.restrict_queryset(
            _list_queryset(model).filter(tenant=rule.tenant, pk__in=ids),
            request.user, rule.tenant, slug, "view",
        )
        by_id = {str(obj.pk): obj for obj in qs}
        ordered = [by_id[i] for i in ids if i in by_id]
        # A list context, so the detail-only tab counts are skipped exactly as
        # on the type's own list page.
        view = SimpleNamespace(action="list", request=request)
        out[object_type] = serializer_cls(
            ordered, many=True, context={"request": request, "view": view}
        ).data
    return out


# ─── Scope and conditions ────────────────────────────────────────────────────


def _ast_refs(ast, field_for) -> list[tuple[str, str, str]]:
    """``(path, ref model key, id)`` for every reference value in ``ast``."""
    out = []
    for path, node in leaves(ast):
        field = field_for(node.get("field"))
        if field is None or not field.ref or node.get("cmp") not in ("in", "not_in"):
            continue
        for i, v in enumerate(node.get("values") or ()):
            out.append((f"{path}.values.{i}" if path else f"values.{i}", field.ref, v))
    return out


def _tenant_rows(ref: str, tenant, ids):
    from django.db.models import Q

    model = ref_model(ref)
    qs = model.objects.filter(pk__in=list(ids))
    if REF_MODELS[ref].shared_null_tenant:
        return qs.filter(Q(tenant=tenant) | Q(tenant__isnull=True))
    return qs.filter(tenant=tenant)


def _ref_errors(ast, field_for, tenant, user) -> list[dict]:
    """Every reference in ``ast`` must be the tenant's - and, for a catalog
    bound to sites, one the writer may view. One query per catalog."""
    from auth_api.site_paths import site_path_for

    by_ref: dict[str, list[tuple[str, str]]] = {}
    for path, ref, value in _ast_refs(ast, field_for):
        by_ref.setdefault(ref, []).append((path, value))
    errors = []
    for ref, items in by_ref.items():
        qs = _tenant_rows(ref, tenant, {v for _p, v in items})
        slug = qs.model._meta.model_name
        if user is not None and site_path_for(slug, tenant) is not None:
            qs = rbac.restrict_queryset(qs, user, tenant, slug, "view")
        found = {str(pk) for pk in qs.values_list("pk", flat=True)}
        noun = REF_MODELS[ref].noun
        for path, value in items:
            if value not in found:
                errors.append({"path": path, "detail": f"Not one of this tenant's {noun}s."})
    return errors


def _regex_errors(ast) -> list[dict]:
    errors = []
    for path, node in leaves(ast):
        if node.get("cmp") in ("matches", "not_matches"):
            problem = regex_error(node.get("value") or "")
            if problem:
                errors.append({"path": f"{path}.value" if path else "value",
                               "detail": problem})
    return errors


def _value_check(field, value) -> str | None:
    if field.ref and not valid_pk(ref_model(field.ref), value):
        return "Not a valid id."
    return None


def _is_blank_ast(ast) -> bool:
    return ast in (None, {}, []) or (
        isinstance(ast, dict) and ast.get("kind") == "group" and not ast.get("terms")
    )


def refs_for(rules, tenant, user) -> dict:
    """``{rule id: {ref id: {model, name, color, missing[, hidden]}}}`` for the
    references in each rule's scope and conditions, so a page draws their
    badges without a lookup per value. One query per catalog for the rows,
    and one more where the reader may view only some of them. A row the
    reader may not view reads as ``{"name": None, "hidden": True}``."""
    from .fields import Registry

    registry = Registry(tenant)
    per_rule: dict = {}
    wanted: dict[str, set[str]] = {}
    for rule in rules:
        found = []
        field_for = registry.field_for(rule.types)
        for ast in (rule.scope, rule.condition):
            if ast:
                found += [(ref, v) for _p, ref, v in _ast_refs(ast, field_for)]
        per_rule[rule.id] = found
        for ref, v in found:
            wanted.setdefault(ref, set()).add(v)
    rows: dict[str, dict] = {}
    for ref, ids in wanted.items():
        ids = {i for i in ids if valid_pk(ref_model(ref), i)}
        qs = _tenant_rows(ref, tenant, ids)
        slug = qs.model._meta.model_name
        decision = rbac.row_filter(user, tenant, slug, "view") if user is not None else True
        if decision is None:
            visible = set()
        elif decision is True:
            visible = None
        else:
            try:
                visible = {str(pk) for pk in qs.filter(decision).values_list("pk", flat=True)}
            except Exception:  # noqa: BLE001 - a constraint that doesn't fit: show nothing
                visible = set()
        for obj in qs:
            key = str(obj.pk)
            if visible is not None and key not in visible:
                rows[key] = {"model": ref, "name": None, "color": "", "missing": False,
                             "hidden": True}
            else:
                rows[key] = {"model": ref, "name": str(obj),
                             "color": getattr(obj, "color", "") or "", "missing": False}
    out = {}
    for rule in rules:
        out[str(rule.id)] = {
            v: rows.get(v, {"model": ref, "name": None, "color": "", "missing": True})
            for ref, v in per_rule[rule.id]
        }
    return out


class _RuleListSerializer(serializers.ListSerializer):
    """Reads the references of a whole page of rules at once."""

    def to_representation(self, data):
        from django.db.models import Manager

        items = list(data.all() if isinstance(data, Manager) else data)
        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request is not None else None
        if tenant is not None:
            self.context["refs_cache"] = refs_for(items, tenant, request.user)
        return [self.child.to_representation(item) for item in items]


class ComplianceRuleSerializer(serializers.ModelSerializer):
    object_type_label = serializers.SerializerMethodField()
    check_type_display = serializers.CharField(
        source="get_check_type_display", read_only=True
    )
    object_type = serializers.CharField(max_length=20, required=False)
    object_types = serializers.ListField(
        child=serializers.CharField(max_length=20), required=False,
    )
    scope = serializers.JSONField(required=False, allow_null=True)
    condition = serializers.JSONField(required=False, allow_null=True)
    refs = serializers.SerializerMethodField()

    class Meta:
        model = ComplianceRule
        list_serializer_class = _RuleListSerializer
        fields = [
            "id", "name", "description", "remediation", "enabled", "severity",
            "object_type", "object_types", "object_type_label", "scope", "condition",
            "refs", "check_type",
            "check_type_display", "field", "pattern", "tag", "cf_key",
            "eol_fail_on", "coverage_fail_on", "fail_on_unknown", "include_software",
            "created_at", "updated_at",
        ]
        read_only_fields = ["created_at", "updated_at"]

    def get_object_type_label(self, obj) -> str:
        return type_label(obj.types)

    def get_refs(self, obj) -> dict:
        cache = self.context.get("refs_cache")
        if cache is not None and str(obj.id) in cache:
            return cache[str(obj.id)]
        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request is not None else obj.tenant
        if tenant is None:
            return {}
        user = getattr(request, "user", None) if request is not None else None
        return refs_for([obj], tenant, user).get(str(obj.id), {})

    def validate_object_type(self, value):
        if value not in OBJECT_TYPES:
            raise serializers.ValidationError(
                f"Unknown object type. Pick one of: {', '.join(OBJECT_TYPES)}."
            )
        return value

    def validate_object_types(self, value):
        if not value:
            raise serializers.ValidationError("Pick at least one object type.")
        bad = [t for t in value if t not in OBJECT_TYPES]
        if bad:
            raise serializers.ValidationError(
                f"Unknown object type. Pick from: {', '.join(OBJECT_TYPES)}."
            )
        if len(set(value)) != len(value):
            raise serializers.ValidationError("Each object type once.")
        return value

    def _types(self, attrs) -> list[str]:
        if "object_types" in attrs:
            return list(attrs["object_types"])
        if "object_type" in attrs:
            return [attrs["object_type"]]
        if self.instance is not None:
            return self.instance.types
        raise serializers.ValidationError({"object_types": "Pick at least one object type."})

    def validate(self, attrs):
        attrs = super().validate(attrs)
        # A type error is reported on the key the caller wrote.
        type_key = "object_type" if "object_types" not in attrs and "object_type" in attrs \
            else "object_types"
        types = self._types(attrs)
        attrs["object_types"] = types
        attrs["object_type"] = types[0]
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
                ) from None
        if ct == "required_tag" and not get("tag"):
            raise serializers.ValidationError({"tag": "A tag slug is required."})
        if ct == "required_cf" and not get("cf_key"):
            raise serializers.ValidationError({"cf_key": "A custom-field key is required."})
        if ct == "eol_status":
            if not set(types) <= set(EOL_OBJECT_TYPES):
                raise serializers.ValidationError({
                    type_key: "An end-of-life check applies to devices or "
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
            if not set(types) <= set(COVERAGE_OBJECT_TYPES):
                raise serializers.ValidationError(
                    {type_key: "A support coverage check applies to devices."}
                )
            if not get("coverage_fail_on"):
                raise serializers.ValidationError(
                    {"coverage_fail_on": "Pick what the check fails on."}
                )
        if ct == "software_target":
            if not set(types) <= set(SOFTWARE_TARGET_OBJECT_TYPES):
                raise serializers.ValidationError({
                    type_key: "A software target check applies to devices or "
                                    "virtual machines."
                })
        self._validate_expressions(attrs, types, ct)
        return attrs

    def _validate_expressions(self, attrs, types, ct):
        """Scope and conditions: known fields of the chosen types, operators
        their kinds take, typed values, references the tenant owns, patterns
        PostgreSQL compiles, inside the size limits. Errors carry the path of
        the offending node."""
        from .fields import Registry

        request = self.context.get("request")
        tenant = _get_active_tenant(request) if request is not None else None
        if tenant is None and self.instance is not None:
            tenant = self.instance.tenant
        user = getattr(request, "user", None) if request is not None else None
        registry = Registry(tenant)
        field_for = registry.field_for(types)
        errors = {}
        for key in ("scope", "condition"):
            ast = attrs[key] if key in attrs else getattr(self.instance, key, None)
            if key == "condition" and ct != "expression":
                attrs["condition"] = None
                continue
            if _is_blank_ast(ast):
                if key == "condition":
                    errors[key] = [{"path": "", "detail": "Add a condition."}]
                attrs[key] = None
                continue
            try:
                clean = validate_expression(ast, field_for, _value_check)
            except ExpressionError as exc:
                errors[key] = exc.errors
                continue
            # The references and patterns are checked when written: an edit
            # that leaves the tree alone (a description, the severity) is not
            # refused over a site the editor cannot see.
            problems = (
                _ref_errors(clean, field_for, tenant, user) + _regex_errors(clean)
                if key in attrs or self.instance is None else []
            )
            if problems:
                errors[key] = problems
                continue
            attrs[key] = clean
        if errors:
            raise serializers.ValidationError(errors)

    def update(self, instance, validated_data):
        """A type taken off the rule takes its triage rows with it, each
        deleted through the model so the change log records it."""
        from .models import ComplianceTriage

        before = set(instance.types)
        rule = super().update(instance, validated_data)
        removed = before - set(rule.types)
        if removed:
            ComplianceTriage.objects.filter(rule=rule, object_type__in=removed).delete()
        return rule


class ComplianceRuleViewSet(TenantScopedViewSet):
    queryset = ComplianceRule.objects.all().order_by("object_type", "name")
    serializer_class = ComplianceRuleSerializer
    # The preview checks add-or-change itself: it saves nothing, so the gate
    # only asks that the caller sees rules at all.
    rbac_action_map = {"preview": "view"}

    @action(detail=True, methods=["get"], url_path="violations")
    def violations(self, request, pk=None):
        """Evaluate just this rule → the objects it currently fails.

        Powers the rule detail page's Results tab. Reuses the same live engine
        as the global evaluate, scoped to one rule (and the active tenant via
        the queryset)."""
        rule = self.get_object()
        result = evaluate(rule.tenant, rules=[rule], scope=_view_scope(request, rule.tenant))
        result.pop("failing_objects", None)
        summary = next(iter(result["rules"]), None)
        # Each type's failing rows with its *real* serializer, so the page
        # draws the genuine per-type table (all its columns), not an id + repr.
        by_type = _serialize_violating_objects(rule, result["violations"], request)
        types = rule.types
        return Response({
            "rule": {
                "id": str(rule.id),
                "name": rule.name,
                "severity": rule.severity,
                "object_type": rule.object_type,
                "object_types": types,
                "object_type_label": type_label(types),
                "enabled": rule.enabled,
            },
            "violations": result["violations"],
            "objects": by_type.get(types[0], []) if len(types) == 1 else [],
            "objects_by_type": by_type,
            "total": summary["violations"] if summary else 0,
            # The rule's whole counts, triage included, and when they were taken.
            "result": summary,
            "evaluated_at": result["evaluated_at"],
        })

    @extend_schema(
        summary="Try a rule before saving it: counts and a sample per type",
        tags=["compliance"],
        request=ComplianceRuleSerializer,
        responses=OpenApiResponse(
            response=OpenApiTypes.OBJECT,
            description="by_type: {type: {in_scope, failing, sample}}, and error.",
        ),
    )
    @action(detail=False, methods=["post"], url_path="preview")
    def preview(self, request):
        """The rule in the body (name optional), judged against what the
        caller may view - never more, or an expression would count hidden
        rows. Needs ``compliancerule.add`` or ``change``."""
        tenant = self._tenant_or_403()
        if not (rbac.has_action(request.user, tenant, "compliancerule", "add")
                or rbac.has_action(request.user, tenant, "compliancerule", "change")):
            return Response(
                {"detail": "compliancerule.add or compliancerule.change required."},
                status=403,
            )
        data = dict(request.data.items())
        data["name"] = data.get("name") or "Preview"
        ser = self.get_serializer(data=data)
        ser.is_valid(raise_exception=True)
        fields = {k: v for k, v in ser.validated_data.items()}
        rule = ComplianceRule(tenant=tenant, **fields)

        def universe(object_type, qs):
            return rbac.restrict_queryset(
                qs, request.user, tenant, qs.model._meta.model_name, "view"
            )

        return Response(preview_rule(tenant, rule, universe))


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
    refs = refs_for(failed, tenant, request.user) if failed else {}
    violations = [
        {
            "rule_id": str(rule.id),
            "rule_name": rule.name,
            "severity": rule.severity,
            "description": rule.description,
            "remediation": rule.remediation,
            **_check_fields(rule, refs),
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


def _check_fields(rule, refs: dict) -> dict:
    """What a page needs to put a rule's check into words."""
    return {
        "check_type": rule.check_type,
        "field": rule.field,
        "pattern": rule.pattern,
        "tag": rule.tag,
        "cf_key": rule.cf_key,
        "eol_fail_on": rule.eol_fail_on,
        "coverage_fail_on": rule.coverage_fail_on,
        "fail_on_unknown": rule.fail_on_unknown,
        "object_types": rule.types,
        "scope": rule.scope,
        "condition": rule.condition,
        "refs": refs.get(str(rule.id), {}),
    }


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
            "object_types": ["device"],
            "object_type_label": OBJECT_TYPES["device"],
            "severity": "warning",
            "violations": total,
            "open": total,
            "acknowledged": 0,
            "snoozed": 0,
            "by_type": {"device": total},
            "error": None,
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


@extend_schema(
    summary="The fields a rule's scope and conditions can name",
    tags=["compliance"],
    request=None,
    parameters=[
        OpenApiParameter(
            name="object_types",
            type=OpenApiTypes.STR,
            location=OpenApiParameter.QUERY,
            description="Comma-separated object types (device,virtualmachine,…).",
        ),
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description="fields: [{key, label, kind, types, ops, ref, choices}].",
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def compliance_fields(request):
    """The fields of the chosen types, for the rule builder: each with the
    types that have it, the operators its kind takes, the catalog its values
    come from and its choices. Names and shapes only - never a row's data."""
    from .fields import Registry, payload

    tenant = _get_active_tenant(request)
    if tenant is None:
        return Response({"detail": "No active tenant selected."}, status=403)
    if not rbac.has_action(request.user, tenant, "compliancerule", "view"):
        return Response({"detail": "compliancerule.view required."}, status=403)
    types = [t for t in (request.query_params.get("object_types") or "").split(",") if t]
    bad = [t for t in types if t not in OBJECT_TYPES]
    if bad or len(set(types)) != len(types):
        return Response({"object_types": f"Pick from: {', '.join(OBJECT_TYPES)}."}, status=400)
    if not types:
        types = list(OBJECT_TYPES)
    return Response({"fields": payload(Registry(tenant), types)})


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

    refs = refs_for(enabled, tenant, request.user) if enabled else {}
    rows = []
    for row in result["rules"]:
        rule = by_id.get(row["id"])
        if rule is not None:
            rows.append({**row, **_check_fields(rule, refs)})
        else:
            rows.append({
                **row, "check_type": "", "field": "", "pattern": "", "tag": "",
                "cf_key": "", "eol_fail_on": "", "coverage_fail_on": "",
                "fail_on_unknown": False, "scope": None, "condition": None, "refs": {},
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

    # Each object must be the tenant's, of one of its rule's types, and one
    # the caller may view - looked for per object type, one query each, before
    # anything is written. Object ids are unique across the tables, so an id
    # names one object whichever type finds it.
    registry = _type_registry()
    objects = {}
    found_type: dict[str, str] = {}
    wanted: dict[str, set[str]] = {}
    for rid, oid in items:
        for object_type in rules[rid].types:
            if object_type in registry:
                wanted.setdefault(object_type, set()).add(oid)
    for object_type, ids in wanted.items():
        model = registry[object_type][0]
        qs = rbac.restrict_queryset(
            model.objects.filter(tenant=tenant, pk__in=ids),
            request.user, tenant, model._meta.model_name, "view",
        )
        for o in qs:
            objects[str(o.pk)] = o
            found_type[str(o.pk)] = object_type
    for rid, oid in items:
        if found_type.get(oid) not in rules[rid].types:
            raise serializers.ValidationError({"items": "Unknown object."})

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
                        tenant=tenant, rule=rule, object_type=found_type[oid],
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
