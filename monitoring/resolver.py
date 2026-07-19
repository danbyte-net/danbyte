"""Effective-check resolution.

``resolve_effective_checks(ip)`` answers: *which checks actually run against
this IP, and with what parameters?* It unions the checks assigned directly to
the IP with those inherited from every enclosing prefix, then resolves
conflicts.

Rules (see acceptance criteria in the build brief):

* A check assigned to a prefix applies to every child IP in its
  containment tree (``apply_to_children=True``), unless the IP is in that
  assignment's ``exclusions``.
* **Most-specific wins.** For a given template, the applicable assignment from
  the longest-prefix-length scope wins; a *direct* IP assignment is more
  specific than any prefix.
* The winning assignment decides whether the check runs: ``enabled=False`` on
  it (or the IP being excluded by it) disables the check — i.e. a per-IP
  disable removes an inherited check.
* Routing context matters: a prefix only encloses an IP when their VRFs match
  (both NULL = the Global VRF).

Prefixes form a tree by CIDR containment (there is no parent FK), so enclosing
prefixes are found with the ``ipaddress`` module rather than a pointer walk.
"""
from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from functools import cached_property
from typing import TYPE_CHECKING

from .models import CheckAssignment, MonitoringDenySubnet, MonitoringPolicy

if TYPE_CHECKING:  # pragma: no cover
    from api.models import IPAddress, Prefix

    from .models import CheckTemplate


# A direct IP assignment beats any prefix. IPv6 host masks top out at 128, so
# 129 sits above every real prefix length in the most-specific ordering.
_DIRECT_SPECIFICITY = 129

# Stable slug for the per-tenant fallback reachability check. Created on demand
# the first time an empty-but-enabled policy needs it.
_DEFAULT_PING_SLUG = "default-reachability"


def default_ping_template(tenant_id):
    """The tenant's fallback ICMP reachability template, created on demand.

    An enabled MonitoringPolicy with no profiles/templates resolves to this so
    that "Monitor on" always produces at least a ping — instead of silently
    doing nothing. Idempotent (unique per tenant+slug)."""
    from .models import CheckKind, CheckTemplate

    obj, _ = CheckTemplate.objects.get_or_create(
        tenant_id=tenant_id,
        slug=_DEFAULT_PING_SLUG,
        defaults={"name": "Reachability (ping)", "kind": CheckKind.ICMP},
    )
    return obj


@dataclass
class ResolvedCheck:
    """One effective check for an IP — a template plus the assignment that won,
    with template values overlaid by that assignment's overrides."""

    template: "CheckTemplate"
    assignment: CheckAssignment | None
    source: str  # "direct" | "inherited" | "policy"
    prefix: "Prefix | None" = None  # origin prefix for inherited checks
    _overrides: dict = field(default_factory=dict, repr=False)

    @property
    def kind(self) -> str:
        return self.template.kind

    def _ov(self, key: str, default):
        val = self._overrides.get(key)
        return val if val is not None else default

    @property
    def interval_seconds(self) -> int:
        return int(self._ov("interval_seconds", self.template.interval_seconds))

    @property
    def timeout_ms(self) -> int:
        return int(self._ov("timeout_ms", self.template.timeout_ms))

    @property
    def rise(self) -> int:
        return int(self._ov("rise", self.template.rise))

    @property
    def fall(self) -> int:
        return int(self._ov("fall", self.template.fall))

    @property
    def degraded_enabled(self) -> bool:
        return bool(self._ov("degraded_enabled", self.template.degraded_enabled))

    @cached_property
    def params(self) -> dict:
        """Template params shallow-merged with the assignment's param overrides."""
        merged = dict(self.template.params or {})
        merged.update((self._overrides.get("params") or {}))
        return merged

    @property
    def secret_params(self) -> dict:
        return self.template.secret_params or {}


@dataclass
class _Candidate:
    assignment: CheckAssignment | None
    template: "CheckTemplate | None"
    specificity: int  # prefix masklen, or 129 for a direct IP assignment
    source: str  # "direct" | "inherited" | "policy"
    prefix: "Prefix | None"
    excluded: bool  # IP sits in this assignment's exclusions
    _overrides: dict = field(default_factory=dict)  # policy-level, e.g. interval


def _enclosing_prefixes(ip: "IPAddress") -> list["Prefix"]:
    """Every prefix in the IP's tenant + VRF whose network contains the IP,
    most-specific first. Computed by CIDR containment (no parent FK)."""
    from api.models import Prefix

    try:
        addr = ipaddress.ip_address(ip.ip_address)
    except (ValueError, TypeError):
        return []

    candidates = Prefix.objects.filter(tenant_id=ip.tenant_id, vrf_id=ip.vrf_id)
    out: list[tuple[int, "Prefix"]] = []
    for pfx in candidates:
        net = pfx.network
        if net is None or net.version != addr.version:
            continue
        if addr in net:
            out.append((net.prefixlen, pfx))
    out.sort(key=lambda t: t[0], reverse=True)
    return [pfx for _, pfx in out]


def _in_policy_deny(ip: "IPAddress") -> bool:
    try:
        addr = ipaddress.ip_address(ip.ip_address)
    except (ValueError, TypeError):
        return False
    for row in MonitoringDenySubnet.objects.filter(
        tenant_id=ip.tenant_id, vrf_id=ip.vrf_id
    ):
        try:
            net = ipaddress.ip_network(row.cidr, strict=False)
        except ValueError:
            continue
        if addr.version == net.version and addr in net:
            return True
    return False


def _policy_templates(ip: "IPAddress", enclosing: list["Prefix"]) -> list[_Candidate]:
    if _in_policy_deny(ip):
        return []

    device = getattr(ip, "assigned_device", None)
    policies = (
        MonitoringPolicy.objects.filter(tenant_id=ip.tenant_id, enabled=True)
        .prefetch_related("templates", "profiles__templates")
    )
    candidates: list[_Candidate] = []
    # Frequency override for this IP = the interval_seconds of the most-specific
    # applicable policy that sets one (a prefix beats VRF beats global). Applied
    # to every policy-sourced check, regardless of which policy the template
    # itself came from — "this prefix polls every N".
    interval_by_spec: list[tuple[int, int]] = []

    def add(policy: MonitoringPolicy, specificity: int, prefix=None) -> None:
        if policy.interval_seconds:
            interval_by_spec.append((specificity, policy.interval_seconds))
        templates = list(policy.templates.filter(enabled=True))
        for profile in policy.profiles.filter(enabled=True).prefetch_related("templates"):
            templates.extend(list(profile.templates.filter(enabled=True)))
        if not templates:
            # A "Follow global" policy (inherit) contributes nothing of its own
            # — it just rides the broader-scope policies (and may still carry a
            # frequency override, recorded above). An explicit "Monitor on"
            # policy with nothing selected means "just monitor reachability" —
            # fall back to the tenant's default ICMP ping so the toggle always
            # produces a check.
            if policy.inherit:
                return
            templates = [default_ping_template(ip.tenant_id)]
        seen = set()
        for template in templates:
            if template.id in seen:
                continue
            seen.add(template.id)
            candidates.append(
                _Candidate(
                    assignment=None,
                    template=template,
                    specificity=specificity,
                    source="policy",
                    prefix=prefix,
                    excluded=False,
                )
            )

    def target_ok(policy) -> bool:
        """Device/type/role policies apply only to the device IPs their target
        selects (all IPs / interface IPs / primary / OOB)."""
        t = policy.target
        if t == MonitoringPolicy.TARGET_PRIMARY:
            return device.primary_ip_id == ip.id
        if t == MonitoringPolicy.TARGET_OOB:
            return device.oob_ip_id == ip.id
        if t == MonitoringPolicy.TARGET_INTERFACES:
            return ip.assigned_interface_id is not None
        return True  # TARGET_ALL

    for policy in policies:
        if policy.scope == MonitoringPolicy.SCOPE_GLOBAL:
            add(policy, 0)
        elif policy.scope == MonitoringPolicy.SCOPE_VRF and policy.vrf_id == ip.vrf_id:
            add(policy, 10)
        elif (
            device
            and policy.scope == MonitoringPolicy.SCOPE_DEVICE_TYPE
            and policy.device_type_id == device.device_type_id
            and target_ok(policy)
        ):
            add(policy, 20)
        elif (
            device
            and policy.scope == MonitoringPolicy.SCOPE_DEVICE_ROLE
            and policy.device_role_id == device.role_id
            and target_ok(policy)
        ):
            add(policy, 21)
        elif (
            device
            and policy.scope == MonitoringPolicy.SCOPE_DEVICE
            and policy.device_id == device.id
            and target_ok(policy)
        ):
            add(policy, 128)
        elif policy.scope == MonitoringPolicy.SCOPE_PREFIX and policy.prefix_id:
            pfx = next((p for p in enclosing if p.id == policy.prefix_id), None)
            if pfx is not None and pfx.network is not None:
                add(policy, pfx.network.prefixlen, pfx)

    # Stamp the winning frequency override onto every policy candidate so the
    # scheduler can persist it per check-state without re-resolving.
    if interval_by_spec:
        _, interval = max(interval_by_spec, key=lambda t: t[0])
        for c in candidates:
            c._overrides = {"interval_seconds": interval}
    return candidates


def resolve_effective_checks(ip: "IPAddress") -> list[ResolvedCheck]:
    """The checks that should actually run against ``ip`` right now.

    Returns only *enabled* effective checks — disabled / excluded ones are
    resolved away, not returned. Deterministic order: by template name.
    """
    candidates: list[_Candidate] = []

    # Direct IP assignments — highest specificity.
    direct = CheckAssignment.objects.filter(ip_address=ip).select_related("template")
    for a in direct:
        if not a.template.enabled:
            continue
        candidates.append(
            _Candidate(a, None, _DIRECT_SPECIFICITY, "direct", None, excluded=False)
        )

    # Inherited from enclosing prefixes.
    enclosing = _enclosing_prefixes(ip)
    if enclosing:
        pfx_by_id = {p.id: p for p in enclosing}
        masklen = {p.id: p.network.prefixlen for p in enclosing}
        inherited = (
            CheckAssignment.objects.filter(prefix_id__in=pfx_by_id.keys())
            .select_related("template")
            .prefetch_related("exclusions")
        )
        for a in inherited:
            if not a.template.enabled or not a.apply_to_children:
                continue
            excluded = any(ex.id == ip.id for ex in a.exclusions.all())
            candidates.append(
                _Candidate(
                    a,
                    None,
                    masklen[a.prefix_id],
                    "inherited",
                    pfx_by_id[a.prefix_id],
                    excluded=excluded,
                )
            )

    candidates.extend(_policy_templates(ip, enclosing))

    # Most-specific applicable assignment/policy per template wins; the winner decides
    # whether the check runs (enabled flag + exclusion).
    winners: dict[str, _Candidate] = {}
    for c in candidates:
        template = c.template or c.assignment.template
        tid = template.id
        cur = winners.get(tid)
        if cur is None or c.specificity > cur.specificity:
            winners[tid] = c

    resolved: list[ResolvedCheck] = []
    for c in winners.values():
        if (c.assignment is not None and not c.assignment.enabled) or c.excluded:
            continue  # winner disables the check for this IP
        template = c.template or c.assignment.template
        resolved.append(
            ResolvedCheck(
                template=template,
                assignment=c.assignment,
                source=c.source,
                prefix=c.prefix,
                _overrides=(
                    (c.assignment.overrides if c.assignment else c._overrides) or {}
                ),
            )
        )

    resolved.sort(key=lambda r: (r.template.name, str(r.template.id)))
    return resolved
