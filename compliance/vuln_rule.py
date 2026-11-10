"""The ``vulnerabilities`` rule (#451): a device or VM fails while it has an
open vulnerability match no exception covers, of a record that meets the
rule's ``vuln_fail_on``:

``kev``        the record is in CISA KEV;
``fix_first``  the match's priority is fix first;
``high``       priority high or fix first;
``cvss``       the record's CVSS score is at or over ``cvss_min``.

While vulnerability data is off there is nothing to judge, so nothing fails
(as the end-of-life rule). One query per rule and object type reads the
failing hosts with their records, worst first, so judging a thousand
devices costs no more than judging one.
"""
from __future__ import annotations

from django.db.models import Case, F, IntegerField, Q, Value, When

DETAIL_TOP = 3

_HOST_FIELD = {"device": "device_id", "virtualmachine": "virtual_machine_id"}


def condition_q(rule) -> Q | None:
    on = rule.vuln_fail_on
    if on == "kev":
        return Q(cve__kev_added__isnull=False)
    if on == "fix_first":
        return Q(priority="fix_first")
    if on == "high":
        return Q(priority__in=("fix_first", "high"))
    if on == "cvss" and rule.cvss_min is not None:
        return Q(cve__cvss_score__gte=rule.cvss_min)
    return None


def _enabled() -> bool:
    from vulnerabilities.models import VulnerabilitySettings

    return VulnerabilitySettings.load().enabled


class VulnIndex:
    """Per evaluation: which hosts fail each ``vulnerabilities`` rule, and
    the records that make them fail. ``hosts`` narrows the reads to some
    objects (one device's compliance page)."""

    def __init__(self, tenant, hosts=None):
        self.tenant = tenant
        self.hosts = None if hosts is None else [h for h in hosts]
        self._on: bool | None = None
        self._failing: dict = {}

    @property
    def on(self) -> bool:
        if self._on is None:
            self._on = _enabled()
        return self._on

    def _load(self, rule, object_type: str) -> dict:
        key = (rule.pk, rule.vuln_fail_on, rule.cvss_min, object_type)
        if key in self._failing:
            return self._failing[key]
        from vulnerabilities.models import VulnerabilityMatch
        from vulnerabilities.priority import RANK

        out: dict = {}
        cond = condition_q(rule)
        field = _HOST_FIELD.get(object_type)
        if self.on and cond is not None and field is not None:
            qs = VulnerabilityMatch.objects.filter(
                cond, tenant=self.tenant, resolved_at__isnull=True, excepted__isnull=True,
                **{f"{field}__isnull": False})
            if self.hosts is not None:
                qs = qs.filter(**{f"{field}__in": self.hosts})
            rank = Case(*[When(priority=k, then=Value(v)) for k, v in RANK.items()],
                        default=Value(9), output_field=IntegerField())
            rows = (qs.annotate(rank=rank)
                    .order_by(field, "rank", F("cve__cvss_score").desc(nulls_last=True),
                              "cve__vuln_id")
                    .values_list(field, "cve__vuln_id", "cve__kev_added"))
            for host, vuln_id, kev in rows:
                seen = out.setdefault(host, {})
                if vuln_id not in seen:
                    seen[vuln_id] = kev is not None
        self._failing[key] = out
        return out

    @staticmethod
    def _type(obj) -> str:
        return obj._meta.model_name

    def fails(self, rule, obj) -> bool:
        return obj.pk in self._load(rule, self._type(obj))

    def detail(self, rule, obj) -> str:
        """``CVE-2023-20198 (KEV), CVE-2024-1 and 4 more``."""
        records = self._load(rule, self._type(obj)).get(obj.pk) or {}
        if not records:
            return ""
        names = [f"{v} (KEV)" if kev else v for v, kev in list(records.items())[:DETAIL_TOP]]
        more = len(records) - DETAIL_TOP
        text = ", ".join(names)
        return f"{text} and {more} more" if more > 0 else text


def link_for(object_type: str, obj) -> str:
    """The object's vulnerabilities in the SPA."""
    route = {"device": "devices", "virtualmachine": "virtual-machines"}.get(object_type)
    return f"/{route}/{obj.pk}?tab=vulnerabilities" if route else ""
