"""Evaluate compliance rules against current data → violations (computed)."""
from __future__ import annotations

import regex

from .models import ComplianceRule, OBJECT_TYPES

# Cap the string a regex rule is matched against. Compliance patterns are
# tenant-admin authored and could contain catastrophic-backtracking constructs
# (e.g. ``(a+)+$``); a huge field value would let that hang the RQ worker for
# the whole run. A generous cap bounds the worst-case input size cheaply.
# Follow-up: swap ``re`` for a linear-time engine (google-re2) to remove the
# backtracking risk entirely, then this cap can go.
_REGEX_VALUE_CAP = 10_000
_REGEX_TIMEOUT = 0.2  # seconds per match

# object_type → (model, detail-route key for the SPA).
_ROUTES = {
    "prefix": "prefixes",
    "ipaddress": "ips",
    "device": "devices",
    "vlan": "vlans",
    "vrf": "vrfs",
    "site": "sites",
}


def _models():
    from api.models import Device, IPAddress, Prefix, Site, VLAN, VRF

    return {
        "prefix": Prefix,
        "ipaddress": IPAddress,
        "device": Device,
        "vlan": VLAN,
        "vrf": VRF,
        "site": Site,
    }


def _empty(v) -> bool:
    return v is None or v == "" or v == [] or v == {}


def _violates(rule: ComplianceRule, obj, tag_slugs) -> bool:
    ct = rule.check_type
    if ct == "required_tag":
        return rule.tag not in tag_slugs
    if ct == "required_cf":
        cf = getattr(obj, "custom_fields", {}) or {}
        return _empty(cf.get(rule.cf_key))
    value = getattr(obj, rule.field, None)
    if ct == "required":
        return _empty(value)
    if ct == "forbidden":
        return not _empty(value)
    if ct == "regex":
        if _empty(value):
            return False  # presence is a separate (required) check
        try:
            # A user pattern under a deadline: a pathological one stops
            # after the timeout instead of holding the request (#202).
            return regex.search(
                rule.pattern, str(value)[:_REGEX_VALUE_CAP], timeout=_REGEX_TIMEOUT
            ) is None
        except (regex.error, TimeoutError):
            return False
    return False


def evaluate_for_object(tenant, object_type: str, obj) -> list[ComplianceRule]:
    """The enabled rules of ``object_type`` that ``obj`` currently fails.

    Single-object companion to :func:`evaluate` - powers the per-device
    compliance status endpoint without scanning the whole tenant. One rule
    fails one object at most once, so the failed rules *are* the violations.
    """
    rules = ComplianceRule.objects.filter(
        tenant=tenant, enabled=True, object_type=object_type
    )
    tag_slugs: set[str] | None = None
    failed = []
    for rule in rules:
        if rule.check_type == "required_tag" and tag_slugs is None:
            tag_slugs = {t.slug for t in obj.tags.all()}
        if _violates(rule, obj, tag_slugs or set()):
            failed.append(rule)
    return failed


def evaluate(tenant, rules=None, cap: int = 5000) -> dict:
    """Return per-rule violation counts + a flat violation list."""
    if rules is None:
        rules = list(
            ComplianceRule.objects.filter(tenant=tenant, enabled=True)
        )
    models = _models()
    rule_rows = []
    violations = []

    # One scan per object type, every rule of that type applied to each row
    # as it goes by - ten rules on addresses read the addresses once (#200).
    by_type: dict[str, list] = {}
    for rule in rules:
        if rule.object_type in models:
            by_type.setdefault(rule.object_type, []).append(rule)
    counts = {rule.id: 0 for rule in rules}
    for object_type, type_rules in by_type.items():
        model = models[object_type]
        qs = model.objects.filter(tenant=tenant)
        needs_tags = any(r.check_type == "required_tag" for r in type_rules)
        if needs_tags:
            qs = qs.prefetch_related("tags")
        for obj in qs[:cap]:
            tag_slugs = (
                {t.slug for t in obj.tags.all()} if needs_tags else set()
            )
            for rule in type_rules:
                if not _violates(rule, obj, tag_slugs):
                    continue
                counts[rule.id] += 1
                # Bound the flat list, but keep it generous: per-object UI
                # markers (the violation badge) rely on object_ids being
                # present here, not just the aggregate per-rule counts.
                if len(violations) < 5000:
                    violations.append(
                        {
                            "rule_id": str(rule.id),
                            "rule_name": rule.name,
                            "severity": rule.severity,
                            "object_type": rule.object_type,
                            "object_type_label": OBJECT_TYPES.get(
                                rule.object_type, rule.object_type
                            ),
                            "object_route": _ROUTES.get(rule.object_type),
                            "object_id": str(obj.pk),
                            "object_repr": str(obj)[:120],
                        }
                    )
    for rule in rules:
        if rule.object_type not in models:
            continue
        count = counts[rule.id]
        rule_rows.append(
            {
                "id": str(rule.id),
                "name": rule.name,
                "object_type": rule.object_type,
                "severity": rule.severity,
                "violations": count,
            }
        )

    rule_rows.sort(key=lambda r: -r["violations"])
    return {
        "rules": rule_rows,
        "violations": violations,
        "total_violations": sum(r["violations"] for r in rule_rows),
    }
