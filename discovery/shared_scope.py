"""The monitoring policy scopes a discovery profile can take (#451).

A profile names sites, prefixes, devices and VMs of its own (resolved in
``discovery.scope`` and ``discovery.services`` as before). On top of those it
can name the wider kinds a monitoring policy has - region, VRF, platform,
device type, device role - and, as an explicit choice, everything in the
tenant. Those are not resolved here: each named object becomes a stand-in
policy of that scope and :func:`monitoring.resolver.policy_match` decides,
per address, the same way it decides for a real policy. A role profile and a
role policy therefore cannot disagree about which devices hold the role.

What is matched is the address discovery would contact: a host's primary
address (a device's OOB address when it has none) for package inventory,
each IPAM address for a service scan. The host stands in for the address's
device, so the device-shaped kinds (platform, type, role) never match a VM -
as they never match one for a policy. A host with no address is reached only
by being named, by its site, or by the global choice.

Candidates are first narrowed by a database filter that keeps at least every
row the resolver could accept; the resolver then makes the decision.
"""
from __future__ import annotations

from django.db.models import Q

from monitoring import policy_scopes

#: Monitoring scope → the profile's many-to-many field, for the kinds the
#: monitoring resolver answers.
RESOLVED_FIELDS: dict[str, str] = {
    "region": "regions",
    "vrf": "vrfs",
    "platform": "platforms",
    "device_type": "device_types",
    "device_role": "device_roles",
}
#: Monitoring scope → the profile field that already held that kind, resolved
#: by discovery's own rules (a site's hosts, a prefix's addresses).
OWN_FIELDS: dict[str, str] = {"site": "sites", "prefix": "prefixes", "device": "devices"}
GLOBAL = "global"

#: Every scope of the registry, and the profile field it lands in when a
#: policy's scope is copied (None = the global switch).
COPY_FIELDS: dict[str, str | None] = {GLOBAL: None, **OWN_FIELDS, **RESOLVED_FIELDS}

#: The kinds that are not tied to one site: a person whose view of devices
#: is limited to some sites cannot add them (a region is the exception when
#: every site in it is theirs).
WIDE_KINDS = (GLOBAL, *RESOLVED_FIELDS)


class StandIn:
    """A policy-shaped object for one scope member: the scope, its target id,
    every other target null, target "all IPs" and no filters."""

    target = "all"
    match_tags: list = []
    match_name = ""
    match_interface = ""
    match_hardware = ""

    def __init__(self, scope: str, target_id=None):
        self.scope = scope
        for field in policy_scopes.TARGET_FIELDS:
            setattr(self, f"{field}_id", None)
        spec = policy_scopes.BY_VALUE[scope]
        if spec.field:
            setattr(self, f"{spec.field}_id", target_id)


def stand_ins(profile) -> list[StandIn]:
    out = [StandIn(GLOBAL)] if profile.scope_global else []
    for scope, field in RESOLVED_FIELDS.items():
        out += [StandIn(scope, pk) for pk in getattr(profile, field).values_list("pk", flat=True)]
    return out


def covers(standins, ip, device) -> bool:
    """Whether the monitoring resolver puts this address in any of them."""
    from monitoring.resolver import policy_match

    if ip is None:
        return False
    return any(policy_match(s, ip, device, [], lambda: set(), lambda: set()) is not None
               for s in standins)


def region_site_ids(tenant, region_ids) -> list:
    """Sites in the regions or any region below them - the superset the
    region candidates are narrowed to."""
    from api.models import Region, Site

    parent = dict(Region.objects.filter(tenant=tenant).values_list("pk", "parent_id"))
    wanted = set(region_ids)
    inside = set()
    for pk in parent:
        seen, cur = set(), pk
        while cur and cur not in seen and len(seen) < 32:
            if cur in wanted:
                inside.add(pk)
                break
            seen.add(cur)
            cur = parent.get(cur)
    return list(Site.objects.filter(tenant=tenant, region_id__in=inside)
                .values_list("pk", flat=True))


def _ids(standins, scope) -> list:
    field = policy_scopes.BY_VALUE[scope].field
    return [getattr(s, f"{field}_id") for s in standins if s.scope == scope]


def host_ids(profile, devices, vms) -> tuple[list, list] | None:
    """Device and VM ids the wider kinds put in scope, from querysets already
    limited to the tenant (and the caller). ``None`` = every host (global)."""
    standins = stand_ins(profile)
    if not standins:
        return [], []
    if profile.scope_global:
        return None
    tenant = profile.tenant
    dev_q, vm_q = Q(pk__in=[]), Q(pk__in=[])
    for field in ("platform", "device_type", "device_role"):
        ids = _ids(standins, field)
        if ids:
            dev_q |= Q(**{f"{'role' if field == 'device_role' else field}_id__in": ids})
    vrfs = _ids(standins, "vrf")
    if vrfs:
        for f in ("primary_ip", "oob_ip"):
            dev_q |= Q(**{f"{f}__vrf_id__in": vrfs})
        vm_q |= Q(primary_ip__vrf_id__in=vrfs)
    regions = _ids(standins, "region")
    if regions:
        sites = region_site_ids(tenant, regions)
        dev_q |= Q(site_id__in=sites)
        for f in ("primary_ip", "oob_ip"):
            dev_q |= (Q(**{f"{f}__site_id__in": sites})
                      | Q(**{f"{f}__prefix__site_id__in": sites}))
        vm_q |= Q(primary_ip__site_id__in=sites) | Q(primary_ip__prefix__site_id__in=sites)
    dev_ids = [d.pk for d in devices.filter(dev_q).select_related(
        "primary_ip", "oob_ip", "primary_ip__prefix", "oob_ip__prefix")
        if covers(standins, d.primary_ip or d.oob_ip, d)]
    vm_ids = [v.pk for v in vms.filter(vm_q).select_related(
        "primary_ip", "primary_ip__prefix") if covers(standins, v.primary_ip, None)]
    return dev_ids, vm_ids


def address_ids(profile, ips) -> list | None:
    """IPAM address ids the wider kinds put in scope, from a queryset already
    limited to the tenant (and the caller). ``None`` = every address."""
    standins = stand_ins(profile)
    if not standins:
        return []
    if profile.scope_global:
        return None
    q = Q(pk__in=[])
    for field in ("platform", "device_type", "device_role"):
        ids = _ids(standins, field)
        if ids:
            q |= Q(**{f"assigned_device__{'role' if field == 'device_role' else field}_id__in":
                      ids})
    vrfs = _ids(standins, "vrf")
    if vrfs:
        q |= Q(vrf_id__in=vrfs)
    regions = _ids(standins, "region")
    if regions:
        sites = region_site_ids(profile.tenant, regions)
        q |= (Q(site_id__in=sites) | Q(assigned_device__site_id__in=sites)
              | Q(prefix__site_id__in=sites))
    return [ip.pk for ip in ips.filter(q).select_related("prefix", "assigned_device")
            if covers(standins, ip, ip.assigned_device)]


def covered_by_policy_q(policy) -> Q | None:
    """Profiles whose own scope names the object ``policy`` is about (a
    global policy: profiles scoped to everything). ``None`` when the policy
    has nothing a profile can name (a VRF policy on the Global VRF)."""
    if policy.scope == GLOBAL:
        return Q(scope_global=True)
    field = COPY_FIELDS.get(policy.scope)
    spec = policy_scopes.BY_VALUE.get(policy.scope)
    if not field or spec is None:
        return None
    target = getattr(policy, f"{spec.field}_id")
    if target is None:
        return None
    return Q(**{field: target})
