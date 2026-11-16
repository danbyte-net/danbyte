"""Patch priority of a vulnerability (#451, decision 12).

``fix_first``  in CISA KEV (when the policy says so), or EPSS and CVSS both
               at or over their fix-first thresholds;
``high``       CVSS at or over the high threshold, or CVSS at or over the
               lower EPSS-backed threshold with EPSS at or over its own;
``medium``     CVSS at or over the medium threshold;
``low``        everything else, including a record without a score.

The thresholds are per tenant (``VulnerabilityPolicy``); a tenant without a
policy row gets the column defaults. An exception (Phase 8) never changes the
level; it marks the match excepted.
"""
from __future__ import annotations

from decimal import Decimal

LEVELS = ("fix_first", "high", "medium", "low")
#: Worst first, for ordering and "worst priority" aggregates.
RANK = {name: i for i, name in enumerate(LEVELS)}

DEFAULTS = {
    "kev_is_fix_first": True,
    "fix_first_epss": Decimal("0.5"),
    "fix_first_cvss": Decimal("9.0"),
    "high_cvss": Decimal("9.0"),
    "high_epss": Decimal("0.1"),
    "high_epss_cvss": Decimal("7.0"),
    "medium_cvss": Decimal("4.0"),
}


def _get(policy, name):
    if policy is None:
        return DEFAULTS[name]
    if isinstance(policy, dict):
        return policy.get(name, DEFAULTS[name])
    return getattr(policy, name)


def _ge(value, threshold) -> bool:
    return value is not None and Decimal(str(value)) >= Decimal(str(threshold))


def level(cvss_score, epss, kev: bool, policy=None) -> str:
    """The priority of one record under ``policy`` (a model row, a dict of
    thresholds, or None for the defaults)."""
    if kev and _get(policy, "kev_is_fix_first"):
        return "fix_first"
    if _ge(epss, _get(policy, "fix_first_epss")) and _ge(cvss_score, _get(policy, "fix_first_cvss")):
        return "fix_first"
    if _ge(cvss_score, _get(policy, "high_cvss")):
        return "high"
    if _ge(cvss_score, _get(policy, "high_epss_cvss")) and _ge(epss, _get(policy, "high_epss")):
        return "high"
    if _ge(cvss_score, _get(policy, "medium_cvss")):
        return "medium"
    return "low"


def of_cve(cve, policy=None) -> str:
    return level(cve.cvss_score, cve.epss, cve.kev_added is not None, policy)
