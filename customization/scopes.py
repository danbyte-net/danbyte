"""Custom-field visibility and object-reference scope helpers."""
from __future__ import annotations

import ipaddress
from typing import Any

from django.db.models import Q, QuerySet


RULE_KEYS = {
    "models",
    "device_types",
    "device_roles",
    "tags",
    "vlan_ranges",
    "ip_ranges",
    "prefix_ranges",
    "name_patterns",
}


def validate_scope_rules(rules: Any) -> dict:
    if rules in (None, ""):
        return {}
    if not isinstance(rules, dict):
        raise ValueError("Scope rules must be an object.")
    cleaned: dict[str, dict] = {}
    for key, raw in rules.items():
        if key not in RULE_KEYS:
            continue
        if not isinstance(raw, dict):
            raise ValueError(f"{key} must be an object.")
        include = _string_list(raw.get("include", []))
        exclude = _string_list(raw.get("exclude", []))
        if key in {"vlan_ranges", "ip_ranges", "prefix_ranges"}:
            _validate_ranges(key, include + exclude)
        if include or exclude:
            cleaned[key] = {"include": include, "exclude": exclude}
    return cleaned


def apply_scope_to_queryset(qs: QuerySet, model_slug: str, rules: dict) -> QuerySet:
    rules = validate_scope_rules(rules)
    if not rules:
        return qs
    if not _model_allowed(model_slug, rules):
        return qs.none()
    qs = _apply_id_rule(qs, "device", "device_type_id", rules.get("device_types"))
    qs = _apply_id_rule(qs, "device", "role_id", rules.get("device_roles"))
    qs = _apply_tag_rule(qs, rules.get("tags"))
    qs = _apply_name_rule(qs, rules.get("name_patterns"))
    qs = _apply_vlan_rule(qs, model_slug, rules.get("vlan_ranges"))
    qs = _apply_ip_rule(qs, model_slug, rules.get("ip_ranges") or rules.get("prefix_ranges"))
    return qs.distinct()


def object_matches_scope(obj, model_slug: str, rules: dict) -> bool:
    if not rules:
        return True
    qs = obj.__class__._default_manager.filter(pk=obj.pk)
    if hasattr(obj, "tenant_id"):
        qs = qs.filter(tenant_id=obj.tenant_id)
    return apply_scope_to_queryset(qs, model_slug, rules).exists()


def scope_summary(rules: dict) -> list[str]:
    rules = validate_scope_rules(rules)
    out: list[str] = []
    for key, rule in rules.items():
        if rule.get("include"):
            out.append(f"{key}: include {len(rule['include'])}")
        if rule.get("exclude"):
            out.append(f"{key}: exclude {len(rule['exclude'])}")
    return out


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()]


def _validate_ranges(key: str, values: list[str]) -> None:
    for value in values:
        if key == "vlan_ranges":
            _parse_vlan_range(value)
        else:
            ipaddress.ip_network(value, strict=False)


def _model_allowed(model_slug: str, rules: dict) -> bool:
    rule = rules.get("models") or {}
    include = set(rule.get("include") or [])
    exclude = set(rule.get("exclude") or [])
    if include and model_slug not in include:
        return False
    return model_slug not in exclude


def _apply_id_rule(qs: QuerySet, model_slug: str, field: str, rule: dict | None) -> QuerySet:
    if model_slug != "device" or not rule:
        return qs
    include = rule.get("include") or []
    exclude = rule.get("exclude") or []
    if include:
        qs = qs.filter(**{f"{field}__in": include})
    if exclude:
        qs = qs.exclude(**{f"{field}__in": exclude})
    return qs


def _apply_tag_rule(qs: QuerySet, rule: dict | None) -> QuerySet:
    if not rule or not hasattr(qs.model, "tags"):
        return qs
    include = rule.get("include") or []
    exclude = rule.get("exclude") or []
    if include:
        qs = qs.filter(tags__slug__in=include)
    if exclude:
        qs = qs.exclude(tags__slug__in=exclude)
    return qs


def _apply_name_rule(qs: QuerySet, rule: dict | None) -> QuerySet:
    if not rule:
        return qs
    fields = [f.name for f in qs.model._meta.fields]
    name_field = "name" if "name" in fields else "cidr" if "cidr" in fields else "ip_address" if "ip_address" in fields else None
    if name_field is None:
        return qs
    include = rule.get("include") or []
    exclude = rule.get("exclude") or []
    if include:
        q = Q()
        for pat in include:
            q |= Q(**{f"{name_field}__icontains": pat})
        qs = qs.filter(q)
    for pat in exclude:
        qs = qs.exclude(**{f"{name_field}__icontains": pat})
    return qs


def _apply_vlan_rule(qs: QuerySet, model_slug: str, rule: dict | None) -> QuerySet:
    if model_slug != "vlan" or not rule:
        return qs
    include = rule.get("include") or []
    exclude = rule.get("exclude") or []
    if include:
        q = Q()
        for lo, hi in map(_parse_vlan_range, include):
            q |= Q(vlan_id__gte=lo, vlan_id__lte=hi)
        qs = qs.filter(q)
    for lo, hi in map(_parse_vlan_range, exclude):
        qs = qs.exclude(vlan_id__gte=lo, vlan_id__lte=hi)
    return qs


def _apply_ip_rule(qs: QuerySet, model_slug: str, rule: dict | None) -> QuerySet:
    if model_slug not in {"ipaddress", "prefix"} or not rule:
        return qs
    include = [ipaddress.ip_network(v, strict=False) for v in rule.get("include") or []]
    exclude = [ipaddress.ip_network(v, strict=False) for v in rule.get("exclude") or []]
    if not include and not exclude:
        return qs
    ids = []
    for obj in qs.only("id", "ip_address" if model_slug == "ipaddress" else "cidr"):
        raw = obj.ip_address if model_slug == "ipaddress" else obj.cidr
        try:
            if model_slug == "prefix":
                net = ipaddress.ip_network(raw, strict=False)
            else:
                addr = ipaddress.ip_address(raw)
                host_mask = 32 if addr.version == 4 else 128
                net = ipaddress.ip_network(f"{raw}/{host_mask}", strict=False)
        except ValueError:
            continue
        if include and not any(net.subnet_of(parent) or net.overlaps(parent) for parent in include):
            continue
        if exclude and any(net.subnet_of(parent) or net.overlaps(parent) for parent in exclude):
            continue
        ids.append(obj.id)
    return qs.filter(id__in=ids)


def _parse_vlan_range(value: str) -> tuple[int, int]:
    if "-" in value:
        lo, hi = value.split("-", 1)
    else:
        lo = hi = value
    lo_i, hi_i = int(lo), int(hi)
    if not (1 <= lo_i <= hi_i <= 4094):
        raise ValueError(f"Invalid VLAN range: {value}")
    return lo_i, hi_i
