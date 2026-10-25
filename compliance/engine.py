"""Evaluate compliance rules against current data → violations (computed)."""
from __future__ import annotations

import regex

from core.tags import TAGS, tags_of

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
    "virtualmachine": "virtual-machines",
}


def _models():
    from api.models import VLAN, VRF, Device, IPAddress, Prefix, Site, VirtualMachine

    return {
        "prefix": Prefix,
        "ipaddress": IPAddress,
        "device": Device,
        "vlan": VLAN,
        "vrf": VRF,
        "site": Site,
        "virtualmachine": VirtualMachine,
    }


def _empty(v) -> bool:
    return v is None or v == "" or v == [] or v == {}


def _eol_violates(rule: ComplianceRule, obj, eol_cfg) -> bool:
    """An ``eol_status`` rule (#8) on the object's platform. While the feature
    is off there is no end-of-life data to judge, so nothing fails."""
    from .eol import mapping_of, status_of

    if eol_cfg is None or not eol_cfg.enabled:
        return False
    status = status_of(mapping_of(getattr(obj, "platform", None)), eol_cfg.warning_days)
    failing = {"eol": ("eol",), "ending": ("ending", "eol"),
               "unknown": ("unknown",)}.get(rule.eol_fail_on, ())
    if status in failing:
        return True
    if rule.include_software and rule.eol_fail_on in ("eol", "ending"):
        return any(s in failing for s in _software_statuses(obj, eol_cfg))
    return False


def _software_statuses(obj, eol_cfg) -> list[str]:
    """The end-of-life status of each application installed on ``obj``
    (#436): dates entered on the install win, else its mapping. Read from the
    prefetch when the caller made one."""
    from .eol import date_status, effective_dates

    out = []
    for sw in obj.installed_software.all():
        e = effective_dates(sw.release_date, sw.end_of_support, sw.eol_mapping, True)
        out.append(date_status(e.end, eol_cfg.warning_days, eol_reached=e.eol_reached))
    return out


def _software_detail(rule: ComplianceRule, obj, cfg=None) -> str:
    """The installs that fail an ``eol_status`` rule with ``include_software``."""
    from .eol import date_status, effective_dates, load_config

    cfg = cfg or load_config()
    failing = ("eol",) if rule.eol_fail_on == "eol" else ("ending", "eol")
    names = []
    for sw in obj.installed_software.all():
        e = effective_dates(sw.release_date, sw.end_of_support, sw.eol_mapping, True)
        if date_status(e.end, cfg.warning_days, eol_reached=e.eol_reached) in failing:
            names.append(str(sw))
    return ", ".join(sorted(names))


def _coverage_violates(rule: ComplianceRule, obj, tag_slugs, warning_days) -> bool:
    """A ``coverage`` rule (#421) on a device's support coverage. A rule with
    a tag judges only the devices that carry it."""
    from api.support_coverage import device_end, status_for

    if rule.tag and rule.tag not in tag_slugs:
        return False
    status = status_for(device_end(obj), warning_days)
    if rule.coverage_fail_on == "expired":
        return status in ("expired", "none")
    if rule.coverage_fail_on == "expiring":
        return status in ("expiring", "expired", "none")
    return False


def _software_target_violates(rule: ComplianceRule, obj) -> bool:
    """A ``software_target`` rule (#395): the object's software version
    against its platform's target. No target is nothing to judge; a blank
    version fails only with ``fail_on_unknown``."""
    from api.software_target import target_of

    if not target_of(obj):
        return False
    version = getattr(obj, "software_version", "") or ""
    if not version:
        return rule.fail_on_unknown
    return version != target_of(obj)


def detail_for(rule: ComplianceRule, obj, eol_cfg=None) -> str:
    """A one-line reason for a violation, where the check has one."""
    if rule.check_type == "software_target":
        from api.software_target import describe

        return describe(obj)
    if (rule.check_type == "eol_status" and rule.include_software
            and rule.eol_fail_on in ("eol", "ending")):
        return _software_detail(rule, obj, eol_cfg)
    return ""


def _needs_tags(rule: ComplianceRule) -> bool:
    return rule.check_type == "required_tag" or (
        rule.check_type == "coverage" and bool(rule.tag)
    )


def _violates(rule: ComplianceRule, obj, tag_slugs, eol_cfg=None,
              coverage_days=None) -> bool:
    ct = rule.check_type
    if ct == "eol_status":
        return _eol_violates(rule, obj, eol_cfg)
    if ct == "coverage":
        if coverage_days is None:
            return False
        return _coverage_violates(rule, obj, tag_slugs, coverage_days)
    if ct == "software_target":
        return _software_target_violates(rule, obj)
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
    eol_cfg = None
    coverage_days = None
    failed = []
    for rule in rules:
        if _needs_tags(rule) and tag_slugs is None:
            tag_slugs = {t.slug for t in tags_of(obj)}
        if rule.check_type == "eol_status" and eol_cfg is None:
            from .eol import load_config

            eol_cfg = load_config()
        if rule.check_type == "coverage" and coverage_days is None:
            from core.effective_settings import coverage_warning_days

            coverage_days = coverage_warning_days(tenant)
        if _violates(rule, obj, tag_slugs or set(), eol_cfg, coverage_days):
            failed.append(rule)
    return failed


#: Triage states a violation can be in.
OPEN, ACKNOWLEDGED, SNOOZED = "open", "acknowledged", "snoozed"

_OPEN_TRIAGE = {
    "state": OPEN,
    "acknowledged_at": None,
    "acknowledged_by": "",
    "snoozed_until": None,
    "note": "",
}


def triage_index(tenant, now=None) -> dict[tuple[str, str], dict]:
    """``{(rule id, object id): triage fields}`` for the tenant, in one query.

    Acknowledged wins over snoozed; a snooze whose time has passed reads as
    open, though the row (and its note) stays until someone clears it."""
    from django.utils import timezone

    from .models import ComplianceTriage

    now = now or timezone.now()
    out = {}
    rows = ComplianceTriage.objects.filter(tenant=tenant).select_related(
        "acknowledged_by"
    )
    for t in rows:
        snoozed = t.snoozed_until is not None and t.snoozed_until > now
        state = ACKNOWLEDGED if t.acknowledged_at else SNOOZED if snoozed else OPEN
        out[(str(t.rule_id), str(t.object_id))] = {
            "state": state,
            "acknowledged_at": t.acknowledged_at.isoformat() if t.acknowledged_at else None,
            "acknowledged_by": (
                t.acknowledged_by.get_username() if t.acknowledged_by else ""
            ),
            "snoozed_until": t.snoozed_until.isoformat() if snoozed else None,
            "note": t.note,
        }
    return out


def _site_of(object_type: str, obj) -> tuple[str | None, str]:
    """The site a violation's object belongs to, for the Site facet."""
    if object_type == "site":
        return str(obj.pk), str(obj)
    site_id = getattr(obj, "site_id", None)
    if site_id is None:
        return None, ""
    return str(site_id), str(obj.site)


def evaluate(tenant, rules=None, cap: int = 5000, scope=None, triage=None) -> dict:
    """Return per-rule violation counts + a flat violation list.

    ``scope(object_type, queryset)`` returns the rows of ``queryset`` the
    caller may view, or None for all of them: the flat list then names only
    those. The per-rule counts stay whole - a compliance grant says how many
    objects fail a rule, not which.

    ``triage`` is a :func:`triage_index`; read here when not given. Each
    violation carries its state, and each rule how many of its failures are
    open, acknowledged and snoozed."""
    from django.utils import timezone

    if rules is None:
        rules = list(
            ComplianceRule.objects.filter(tenant=tenant, enabled=True)
        )
    if triage is None:
        triage = triage_index(tenant)
    models = _models()
    rule_rows = []
    violations = []
    tag_info: dict[str, dict] = {}
    failing_objects: set[tuple[str, str]] = set()

    # One scan per object type, every rule of that type applied to each row
    # as it goes by - ten rules on addresses read the addresses once (#200).
    by_type: dict[str, list] = {}
    for rule in rules:
        if rule.object_type in models:
            by_type.setdefault(rule.object_type, []).append(rule)
    counts = {rule.id: 0 for rule in rules}
    states = {rule.id: {ACKNOWLEDGED: 0, SNOOZED: 0} for rule in rules}
    for object_type, type_rules in by_type.items():
        model = models[object_type]
        qs = model.objects.filter(tenant=tenant)
        shown = None
        if scope is not None:
            viewable = scope(object_type, qs)
            if viewable is not None:
                shown = set(viewable.values_list("pk", flat=True))
        # Tags ride every row: a required-tag check reads them, and the
        # Violations tab facets on them.
        qs = qs.prefetch_related(TAGS)
        if object_type != "site" and any(
            f.name == "site" for f in model._meta.get_fields()
        ):
            qs = qs.select_related("site")
        coverage_days = None
        if any(r.check_type == "coverage" for r in type_rules):
            from api.support_coverage import annotate_devices
            from core.effective_settings import coverage_warning_days

            coverage_days = coverage_warning_days(tenant)
            # The coverage end rides the row: no query per device.
            qs = annotate_devices(qs)
        eol_cfg = None
        if any(r.check_type == "eol_status" for r in type_rules):
            from .eol import load_config

            eol_cfg = load_config()
            # The platform's mapping rides the row: no query per object.
            qs = qs.select_related("platform__eol_mapping")
            if any(r.check_type == "eol_status" and r.include_software for r in type_rules):
                # The installs and their mappings: one query for every row.
                qs = qs.prefetch_related("installed_software__eol_mapping",
                                         "installed_software__application")
        if any(r.check_type == "software_target" for r in type_rules):
            # The target rides the row: the platform, and a device's type's.
            qs = qs.select_related(
                "platform",
                *(("device_type__platform",) if object_type == "device" else ()),
            )
        for obj in qs[:cap]:
            tags = tags_of(obj)
            tag_slugs = {t.slug for t in tags}
            failed_any = False
            for rule in type_rules:
                if not _violates(rule, obj, tag_slugs, eol_cfg, coverage_days):
                    continue
                failed_any = True
                counts[rule.id] += 1
                tri = triage.get((str(rule.id), str(obj.pk)), _OPEN_TRIAGE)
                if tri["state"] != OPEN:
                    states[rule.id][tri["state"]] += 1
                if shown is not None and obj.pk not in shown:
                    continue
                # Bound the flat list, but keep it generous: per-object UI
                # markers (the violation badge) rely on object_ids being
                # present here, not just the aggregate per-rule counts.
                if len(violations) < 5000:
                    site_id, site_name = _site_of(object_type, obj)
                    for t in tags:
                        tag_info.setdefault(
                            t.slug, {"id": t.pk, "name": t.name, "color": t.color,
                 "text_color": t.text_color}
                        )
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
                            "detail": detail_for(rule, obj, eol_cfg),
                            "site_id": site_id,
                            "site_name": site_name,
                            "tags": sorted(tag_slugs),
                            **tri,
                        }
                    )
            if failed_any:
                failing_objects.add((object_type, str(obj.pk)))
    for rule in rules:
        if rule.object_type not in models:
            continue
        count = counts[rule.id]
        acked = states[rule.id][ACKNOWLEDGED]
        snoozed = states[rule.id][SNOOZED]
        rule_rows.append(
            {
                "id": str(rule.id),
                "name": rule.name,
                "object_type": rule.object_type,
                "object_type_label": OBJECT_TYPES.get(
                    rule.object_type, rule.object_type
                ),
                "severity": rule.severity,
                "violations": count,
                "open": count - acked - snoozed,
                "acknowledged": acked,
                "snoozed": snoozed,
            }
        )

    rule_rows.sort(key=lambda r: -r["violations"])
    return {
        "evaluated_at": timezone.now().isoformat(),
        "rules": rule_rows,
        "violations": violations,
        "total_violations": sum(r["violations"] for r in rule_rows),
        # Distinct objects failing at least one rule, counted whole like the
        # per-rule counts. Not serialised: callers pop it.
        "failing_objects": failing_objects,
        "tags": tag_info,
    }
