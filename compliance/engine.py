"""Evaluate compliance rules against current data → violations (computed)."""
from __future__ import annotations

from contextlib import contextmanager

import regex

from core.expressions import compile_q, leaves
from core.tags import TAGS, tags_of

from .models import OBJECT_TYPES, ComplianceRule

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


#: Each rule's query runs under this statement timeout. A rule that runs
#: out of it shows an error instead of passing.
RULE_TIMEOUT_MS = 5000

#: Violations listed per run (the counts are whole past it).
LIST_CAP = 5000


def type_label(types) -> str:
    return ", ".join(OBJECT_TYPES.get(t, t) for t in types)


class Plan:
    """What an evaluation reads once for all its rules: the field registry,
    which referenced rows still exist in the tenant (one query per catalog),
    and the profile tree for "has profile P" to include P's children."""

    def __init__(self, tenant, rules):
        from .fields import REF_MODELS, Registry, ref_model

        self.tenant = tenant
        self.registry = Registry(tenant)
        self._children = None
        wanted: dict[str, set[str]] = {}
        for rule in rules:
            for _path, node, field in self._ref_leaves(rule):
                wanted.setdefault(field.ref, set()).update(node.get("values") or ())
        self.existing: dict[str, set[str]] = {}
        for ref, ids in wanted.items():
            model = ref_model(ref)
            ids = [i for i in ids if valid_pk(model, i)]
            qs = model.objects.filter(pk__in=ids)
            if REF_MODELS[ref].shared_null_tenant:
                from django.db.models import Q

                qs = qs.filter(Q(tenant=tenant) | Q(tenant__isnull=True))
            else:
                qs = qs.filter(tenant=tenant)
            self.existing[ref] = {str(pk) for pk in qs.values_list("pk", flat=True)}

    def asts(self, rule):
        out = []
        if rule.scope:
            out.append(rule.scope)
        if rule.check_type == "expression" and rule.condition:
            out.append(rule.condition)
        return out

    def _ref_leaves(self, rule):
        union = self.registry.union(rule.types)
        for ast in self.asts(rule):
            for path, node in leaves(ast):
                hit = union.get(node.get("field"))
                if hit and hit[0].ref and node.get("cmp") in ("in", "not_in"):
                    yield path, node, hit[0]

    def error(self, rule) -> str | None:
        """Why the rule cannot be judged ("Broken"), or None. A reference
        that no longer exists never reads as "matches nothing": the rule
        would pass silently."""
        from .fields import REF_MODELS

        if rule.check_type == "expression" and not rule.condition:
            return "The rule has no conditions."
        union = self.registry.union(rule.types)
        for ast in self.asts(rule):
            for _path, node in leaves(ast):
                key = node.get("field")
                if key not in union:
                    return f"The field {key} no longer exists on these object types."
        for _path, node, field in self._ref_leaves(rule):
            have = self.existing.get(field.ref, set())
            if any(v not in have for v in node.get("values") or ()):
                return f"A referenced {REF_MODELS[field.ref].noun} no longer exists."
        return None

    def expand(self, ref: str, ids: list) -> list:
        if ref != "deviceprofile":
            return ids
        if self._children is None:
            from profiles.models import DeviceProfile

            self._children = {}
            for pk, parent in DeviceProfile.objects.filter(tenant=self.tenant).values_list(
                "id", "parent_id"
            ):
                if parent is not None:
                    self._children.setdefault(str(parent), []).append(str(pk))
        out, todo = [], [str(i) for i in ids]
        while todo:
            pk = todo.pop()
            if pk in out:
                continue
            out.append(pk)
            todo.extend(self._children.get(pk, ()))
        return out

    def q(self, ast, rule, object_type):
        return compile_q(ast, self.registry.field_on(object_type), object_type, self.expand)

    def scope_q(self, rule, object_type):
        return self.q(rule.scope, rule, object_type) if rule.scope else None

    def condition_q(self, rule, object_type):
        return self.q(rule.condition, rule, object_type)


def valid_pk(model, value) -> bool:
    """Is ``value`` shaped like ``model``'s primary key? Tags count from 1;
    every other catalog has a UUID."""
    import uuid

    from django.db import models as m

    if isinstance(model._meta.pk, m.UUIDField):
        try:
            uuid.UUID(str(value))
        except ValueError:
            return False
        return True
    return str(value).isdigit()


@contextmanager
def statement_timeout(ms: int = RULE_TIMEOUT_MS):
    """Run the block in a savepoint whose statements stop after ``ms``. The
    previous timeout is put back when the block ends, so a caller already
    inside a transaction keeps its own."""
    from django.db import connection, transaction

    with transaction.atomic():
        with connection.cursor() as cur:
            cur.execute("SELECT current_setting('statement_timeout')")
            previous = cur.fetchone()[0]
            cur.execute("SELECT set_config('statement_timeout', %s, true)", [f"{int(ms)}ms"])
        yield
        with connection.cursor() as cur:
            cur.execute("SELECT set_config('statement_timeout', %s, true)", [previous])


def _query_error(exc) -> str:
    text = str(exc).lower()
    if "statement timeout" in text or "canceling statement" in text:
        return "The rule took too long to evaluate."
    return "The rule could not be evaluated."


def _failing_qs(base, scope_q, cond_q):
    """The rows in scope that fail the conditions: a NOT IN on the passing
    rows' ids, so a NULL never reads as passing."""
    qs = base.filter(scope_q) if scope_q is not None else base
    return qs.exclude(pk__in=base.filter(cond_q).values("pk"))


def failing_for_object(plan: Plan, rules, object_type: str, obj) -> tuple[set, set]:
    """For one object: the ids of the expression rules it fails and of the
    scoped rules it is out of scope of, read in one query."""
    from django.db.models import BooleanField, Case, Value, When

    exprs = {}
    for i, rule in enumerate(rules):
        if plan.error(rule):
            continue
        scope_q = plan.scope_q(rule, object_type)
        if rule.check_type == "expression":
            fails = Case(
                When(plan.condition_q(rule, object_type), then=Value(False)),
                default=Value(True), output_field=BooleanField(),
            )
            exprs[f"f{i}"] = (
                Case(When(scope_q, then=fails), default=Value(False),
                     output_field=BooleanField())
                if scope_q is not None else fails
            )
        elif scope_q is not None:
            exprs[f"s{i}"] = Case(When(scope_q, then=Value(True)), default=Value(False),
                                  output_field=BooleanField())
    if not exprs:
        return set(), set()
    row = type(obj).objects.filter(pk=obj.pk).values(**exprs).first() or {}
    failed = {rules[int(k[1:])].id for k, v in row.items() if k[0] == "f" and v}
    outside = {rules[int(k[1:])].id for k, v in row.items() if k[0] == "s" and not v}
    return failed, outside


def evaluate_for_object(tenant, object_type: str, obj) -> list[ComplianceRule]:
    """The enabled rules covering ``object_type`` that ``obj`` currently fails.

    Single-object companion to :func:`evaluate` - powers the per-device
    compliance status endpoint without scanning the whole tenant. One rule
    fails one object at most once, so the failed rules *are* the violations.
    The condition rules and every scope are answered in one query; a rule
    that cannot be judged (Broken) is left out.
    """
    from django.db.models import Q

    rules = list(
        ComplianceRule.objects.filter(tenant=tenant, enabled=True).filter(
            Q(object_types__contains=[object_type])
            | Q(object_types=[], object_type=object_type)
        )
    )
    plan = Plan(tenant, rules)
    failed_expr, outside = failing_for_object(plan, rules, object_type, obj)
    tag_slugs: set[str] | None = None
    eol_cfg = None
    coverage_days = None
    failed = []
    for rule in rules:
        if plan.error(rule) or rule.id in outside:
            continue
        if rule.check_type == "expression":
            if rule.id in failed_expr:
                failed.append(rule)
            continue
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


def _triage_rows(tenant) -> list:
    from .models import ComplianceTriage

    return list(
        ComplianceTriage.objects.filter(tenant=tenant).select_related("acknowledged_by")
    )


def triage_index(tenant, now=None, rows=None) -> dict[tuple[str, str], dict]:
    """``{(rule id, object id): triage fields}`` for the tenant, in one query
    (none when the ``rows`` are given).

    Acknowledged wins over snoozed; a snooze whose time has passed reads as
    open, though the row (and its note) stays until someone clears it."""
    from django.utils import timezone

    now = now or timezone.now()
    out = {}
    for t in _triage_rows(tenant) if rows is None else rows:
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


#: The name the change log and the journal give an acknowledgement the
#: evaluation cleared.
CLEARED_BY = "Compliance"


def _snoozed(t, now) -> bool:
    return t.snoozed_until is not None and t.snoozed_until > now


def clear_passed_acknowledgements(tenant, passed: list[tuple]) -> int:
    """Clear the acknowledgement of each ``(triage row, rule, object)`` whose
    object no longer fails the rule: an acknowledgement covers one occurrence
    of a violation, not the next. A row still snoozed keeps its snooze and
    its note; any other row goes.

    A fixed number of queries however many rows: one locking read, one
    delete, one update, one change-log write and one journal write, plus one
    read per object type whose site is more than one hop away. A row changed
    since it was read, or one another evaluation is clearing, is left alone.
    Returns how many rows were cleared."""
    from django.db import transaction
    from django.db.models import prefetch_related_objects
    from django.utils import timezone

    from audit.bulk import _entry
    from audit.context import current_request_id
    from audit.models import ChangeAction, ChangeLogEntry, JournalEntry, JournalKind
    from audit.signals import _field_dict, _ser
    from audit.site_capture import entry_site_id
    from auth_api.site_paths import alternatives, site_path_for

    from .models import ComplianceTriage

    if not passed:
        return 0
    seen = {row.pk: row.acknowledged_at for row, _rule, _obj in passed}
    now = timezone.now()
    rid = current_request_id()
    with transaction.atomic():
        live = {
            t.pk: t
            for t in ComplianceTriage.objects.select_for_update(skip_locked=True).filter(
                tenant=tenant, pk__in=list(seen), acknowledged_at__isnull=False
            )
            if t.acknowledged_at == seen[t.pk]
        }
        todo = [(live[row.pk], rule, obj) for row, rule, obj in passed if row.pk in live]
        if not todo:
            return 0
        # The rows' rule and tenant, and the objects' tenant, are in hand: the
        # reprs and the site lookups below read them without a query per row.
        for t, rule, obj in todo:
            t.rule = rule
            t.tenant = tenant
            if getattr(obj, "tenant_id", None) == tenant.pk:
                obj.tenant = tenant
        drop = [t for t, _r, _o in todo if not _snoozed(t, now)]
        keep = [t for t, _r, _o in todo if _snoozed(t, now)]

        log = []
        for t in drop:
            entry = _entry(t, ChangeAction.DELETE, {}, None, rid)
            entry.pre_change = _field_dict(t)
            log.append(entry)
        for t in keep:
            pre = _field_dict(t)
            changes = {
                "acknowledged_at": {"old": _ser(t.acknowledged_at), "new": None},
                "acknowledged_by": {"old": _ser(t.acknowledged_by_id), "new": None},
            }
            t.acknowledged_at = None
            t.acknowledged_by_id = None
            entry = _entry(t, ChangeAction.UPDATE, changes, None, rid)
            entry.pre_change = pre
            entry.post_change = _field_dict(t)
            log.append(entry)
        for entry in log:
            entry.user_name = CLEARED_BY
            entry.via = "system"

        # Logged above as the system's change. The delete is one statement
        # with no per-row signals: they would log it again under whoever
        # asked, and look up webhooks once per row. Nothing references a
        # triage row, so there is no cascade to collect.
        if drop:
            ComplianceTriage.objects.filter(pk__in=[t.pk for t in drop])._raw_delete(
                using=ComplianceTriage.objects.db
            )
        if keep:
            ComplianceTriage.objects.filter(pk__in=[t.pk for t in keep]).update(
                acknowledged_at=None, acknowledged_by=None, updated_at=now
            )
        ChangeLogEntry.objects.bulk_create(log)

        # The objects' sites for their notes: one read per type whose path
        # walks through another row (an address's prefix), none otherwise.
        by_model: dict = {}
        for _t, _r, obj in todo:
            by_model.setdefault(type(obj), []).append(obj)
        for model, objs in by_model.items():
            path = site_path_for(model._meta.model_name, tenant) or ""
            hops = {"__".join(a.split("__")[:-1]) for a in alternatives(path)} - {""}
            if path and path != "id" and hops:
                prefetch_related_objects(objs, *sorted(hops))

        journal = []
        per_rule: dict = {}
        for _t, rule, obj in todo:
            per_rule.setdefault(rule, []).append(str(obj)[:120])
            journal.append(JournalEntry(
                tenant=tenant, author_name=CLEARED_BY,
                object_type=obj._meta.label_lower, object_id=str(obj.pk),
                object_site_id=entry_site_id(obj), kind=JournalKind.INFO,
                comments=f"Cleared: the object passed {rule.name}, so its "
                         "acknowledgement is removed.",
            ))
        for rule, names in per_rule.items():
            shown = ", ".join(names[:20])
            if len(names) > 20:
                shown += f" and {len(names) - 20} more"
            plural = "s" if len(names) != 1 else ""
            journal.append(JournalEntry(
                tenant=tenant, author_name=CLEARED_BY,
                object_type="compliance.compliancerule", object_id=str(rule.pk),
                kind=JournalKind.INFO,
                comments=f"Cleared: {len(names)} acknowledged object{plural} passed, "
                         f"so the acknowledgement is removed: {shown}.",
            ))
        JournalEntry.objects.bulk_create(journal)
    return len(todo)


def _site_of(object_type: str, obj) -> tuple[str | None, str]:
    """The site a violation's object belongs to, for the Site facet."""
    if object_type == "site":
        return str(obj.pk), str(obj)
    site_id = getattr(obj, "site_id", None)
    if site_id is None:
        return None, ""
    return str(site_id), str(obj.site)


def _row_qs(qs, model, object_type):
    """Tags ride every listed row (the Violations tab facets on them), and
    the site when the type has one."""
    qs = qs.prefetch_related(TAGS)
    if object_type != "site" and any(f.name == "site" for f in model._meta.get_fields()):
        qs = qs.select_related("site")
    return qs


def evaluate(tenant, rules=None, cap: int = 5000, scope=None, triage=None,
             universe=None, list_cap: int = LIST_CAP) -> dict:
    """Return per-rule violation counts + a flat violation list.

    ``scope(object_type, queryset)`` returns the rows of ``queryset`` the
    caller may view, or None for all of them: the flat list then names only
    those. The per-rule counts stay whole - a compliance grant says how many
    objects fail a rule, not which.

    ``universe(object_type, queryset)`` narrows the rows judged at all (the
    preview judges only what its caller may view); every row by default.

    ``triage`` is a :func:`triage_index`; read here when not given. Each
    violation carries its state, and each rule how many of its failures are
    open, acknowledged and snoozed.

    When the triage is read here, an acknowledged pair this run finds passing
    has its acknowledgement cleared (:func:`clear_passed_acknowledgements`):
    an acknowledgement follows one occurrence of a violation. Only the rules
    and rows this run judged count - a row past ``cap`` is left as it is.

    A condition rule (``expression``) runs as SQL, one query per (rule, type)
    for its failing ids plus one for the rows it lists, so its count is exact
    however many rows fail. The other checks run in Python over one scan per
    type, capped at ``cap`` rows; a rule's scope rides that scan as a column.
    """
    from django.db import DatabaseError
    from django.db.models import BooleanField, ExpressionWrapper
    from django.utils import timezone

    if rules is None:
        rules = list(
            ComplianceRule.objects.filter(tenant=tenant, enabled=True)
        )
    acked: dict = {}
    if triage is None:
        rows = _triage_rows(tenant)
        triage = triage_index(tenant, rows=rows)
        acked = {(str(t.rule_id), str(t.object_id)): t for t in rows if t.acknowledged_at}
    passed: list[tuple] = []
    models = _models()
    plan = Plan(tenant, rules)
    errors = {rule.id: plan.error(rule) for rule in rules}
    violations = []
    tag_info: dict[str, dict] = {}
    failing_objects: set[tuple[str, str]] = set()

    counts = {rule.id: 0 for rule in rules}
    per_type = {rule.id: {t: 0 for t in rule.types if t in models} for rule in rules}
    states = {rule.id: {ACKNOWLEDGED: 0, SNOOZED: 0} for rule in rules}

    def base_of(object_type):
        qs = models[object_type].objects.filter(tenant=tenant)
        return universe(object_type, qs) if universe is not None else qs

    shown_cache: dict[str, set | None] = {}

    def shown_of(object_type, qs):
        if object_type not in shown_cache:
            shown = None
            if scope is not None:
                viewable = scope(object_type, qs)
                if viewable is not None:
                    shown = set(viewable.values_list("pk", flat=True))
            shown_cache[object_type] = shown
        return shown_cache[object_type]

    def record(rule, object_type, obj, tags, eol_cfg=None):
        """List one failure, while the flat list has room."""
        if len(violations) >= list_cap:
            return
        tri = triage.get((str(rule.id), str(obj.pk)), _OPEN_TRIAGE)
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
                "object_type": object_type,
                "object_type_label": OBJECT_TYPES.get(object_type, object_type),
                "object_route": _ROUTES.get(object_type),
                "object_id": str(obj.pk),
                "object_repr": str(obj)[:120],
                "detail": detail_for(rule, obj, eol_cfg),
                "site_id": site_id,
                "site_name": site_name,
                "tags": sorted(t.slug for t in tags),
                **tri,
            }
        )

    def count(rule, object_type, oid):
        counts[rule.id] += 1
        per_type[rule.id][object_type] += 1
        tri = triage.get((str(rule.id), str(oid)), _OPEN_TRIAGE)
        if tri["state"] != OPEN:
            states[rule.id][tri["state"]] += 1
        failing_objects.add((object_type, str(oid)))

    # Python checks: one scan per object type, every rule of that type
    # applied to each row as it goes by - ten rules on addresses read the
    # addresses once (#200).
    by_type: dict[str, list] = {}
    sql_rules = []
    for rule in rules:
        if errors[rule.id]:
            continue
        if rule.check_type == "expression":
            sql_rules.append(rule)
            continue
        for t in rule.types:
            if t in models:
                by_type.setdefault(t, []).append(rule)
    for object_type, type_rules in by_type.items():
        model = models[object_type]
        qs = base_of(object_type)
        shown = shown_of(object_type, qs)
        qs = _row_qs(qs, model, object_type)
        # A rule's scope is one more column on the scan: no query of its own.
        in_scope = {}
        for i, rule in enumerate(type_rules):
            scope_q = plan.scope_q(rule, object_type)
            if scope_q is not None:
                in_scope[rule.id] = f"_in_scope_{i}"
                qs = qs.annotate(**{in_scope[rule.id]: ExpressionWrapper(
                    scope_q, output_field=BooleanField()
                )})
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
            for rule in type_rules:
                alias = in_scope.get(rule.id)
                # Out of scope reads as passing.
                fails = (not alias or bool(getattr(obj, alias))) and _violates(
                    rule, obj, tag_slugs, eol_cfg, coverage_days
                )
                if not fails:
                    if acked:
                        row = acked.get((str(rule.id), str(obj.pk)))
                        if row is not None:
                            passed.append((row, rule, obj))
                    continue
                count(rule, object_type, obj.pk)
                if shown is not None and obj.pk not in shown:
                    continue
                # Bound the flat list, but keep it generous: per-object UI
                # markers (the violation badge) rely on object_ids being
                # present here, not just the aggregate per-rule counts.
                record(rule, object_type, obj, tags, eol_cfg)

    # Condition rules: SQL per (rule, type), exact counts. A rule whose query
    # fails on any of its types reports the error and nothing else.
    for rule in sql_rules:
        results = []
        room = list_cap - len(violations)
        try:
            for object_type in rule.types:
                if object_type not in models:
                    continue
                model = models[object_type]
                base = base_of(object_type)
                failing = _failing_qs(
                    base, plan.scope_q(rule, object_type), plan.condition_q(rule, object_type)
                )
                with statement_timeout():
                    ids = list(failing.values_list("pk", flat=True))
                    listed = []
                    if ids and room > 0:
                        viewable = scope(object_type, failing) if scope is not None else None
                        listed = list(_row_qs(
                            viewable if viewable is not None else failing, model, object_type
                        )[:room])
                        room -= len(listed)
                results.append((object_type, model, ids, listed))
        except DatabaseError as exc:
            errors[rule.id] = _query_error(exc)
            continue
        for object_type, model, ids, listed in results:
            for oid in ids:
                count(rule, object_type, oid)
            for obj in listed:
                record(rule, object_type, obj, tags_of(obj))
            if acked:
                failing_ids = {str(i) for i in ids}
                gone = [
                    t.object_id for (rid, oid), t in acked.items()
                    if rid == str(rule.id) and t.object_type == object_type
                    and oid not in failing_ids
                ]
                if gone:
                    for obj in model.objects.filter(tenant=tenant, pk__in=gone):
                        passed.append((acked[(str(rule.id), str(obj.pk))], rule, obj))

    rule_rows = []
    for rule in rules:
        types = [t for t in rule.types if t in models]
        if not types:
            continue
        total = counts[rule.id]
        n_acked = states[rule.id][ACKNOWLEDGED]
        n_snoozed = states[rule.id][SNOOZED]
        rule_rows.append(
            {
                "id": str(rule.id),
                "name": rule.name,
                "object_type": types[0],
                "object_types": types,
                "object_type_label": type_label(types),
                "severity": rule.severity,
                "violations": total,
                "open": total - n_acked - n_snoozed,
                "acknowledged": n_acked,
                "snoozed": n_snoozed,
                "by_type": per_type[rule.id],
                "error": errors[rule.id],
            }
        )

    clear_passed_acknowledgements(tenant, passed)
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


def preview_rule(tenant, rule, universe, sample: int = 25) -> dict:
    """An unsaved rule's counts per type: how many objects are in scope and
    how many fail, with up to ``sample`` failing objects each. Only the rows
    ``universe(object_type, queryset)`` keeps are judged, so the counts are
    the caller's own. Nothing is written, triage included."""
    from django.db import DatabaseError

    models = _models()
    plan = Plan(tenant, [rule])
    error = plan.error(rule)
    if error:
        return {"by_type": {}, "error": error}
    types = [t for t in rule.types if t in models]
    by_type = {}
    try:
        for t in types:
            base = universe(t, models[t].objects.filter(tenant=tenant))
            scope_q = plan.scope_q(rule, t)
            with statement_timeout():
                n = (base.filter(scope_q) if scope_q is not None else base).count()
            by_type[t] = {"in_scope": n, "failing": 0, "sample": []}
    except DatabaseError as exc:
        return {"by_type": {}, "error": _query_error(exc)}
    for t in types:
        def only(object_type, qs, t=t):
            return universe(object_type, qs) if object_type == t else qs.none()

        result = evaluate(tenant, rules=[rule], triage={}, universe=only, list_cap=sample)
        row = result["rules"][0] if result["rules"] else None
        if row and row["error"]:
            return {"by_type": by_type, "error": row["error"]}
        by_type[t]["failing"] = row["violations"] if row else 0
        by_type[t]["sample"] = [
            {"id": v["object_id"], "repr": v["object_repr"], "site_name": v["site_name"]}
            for v in result["violations"] if v["object_type"] == t
        ]
    return {"by_type": by_type, "error": None}
