"""What a monitoring policy can be about, declared once.

A scope was spelled out in five places that had to agree: the model's choices,
the resolver's if/elif chain and its hard-coded rank, the serializer's
"required for this scope" check, the viewset's RBAC target map, and its query
filters. Five enumerations of the same fact is five chances to add a sixth
scope and get one of them wrong - and two of those failures are silent: the
RBAC filter hides every global policy from every non-superuser if a
non-nullable field joins its tuple, and the site-scoping helper swallows a bad
ORM path and returns nothing at all.

So: one row per scope, and everything else reads it.

**Rank is the ordering** the resolver uses, most-specific-wins. ``None`` means
the scope computes its own - only ``prefix`` does, from the mask length, which
is why a ``/24`` policy outranks a device-role one. That collision is recorded
in ``monitoring.tests_resolver_precedence`` rather than fixed here; this module
moves the numbers into one table so changing them is a single, visible edit.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class PolicyScope:
    #: The value stored in ``MonitoringPolicy.scope``.
    value: str
    label: str
    #: The model field naming this scope's target. ``None`` for ``global``,
    #: which is about everything and so has no target. Every other scope must
    #: have one: the RBAC visibility filter is built by asserting that a
    #: policy's *other* target fields are null, and a scope with no field of
    #: its own has no way to be told apart from a global policy.
    field: str | None
    #: ``auth_api.object_types`` slug used to filter targets the caller may
    #: see. ``None`` where the scope has no target.
    rbac_slug: str | None
    #: Fixed specificity. ``None`` = the scope computes it (prefix).
    rank: int | None
    #: Honours ``MonitoringPolicy.target`` - "the primary IP of everything at
    #: this site" is a thing to want, so this is not the same question as
    #: whether the scope needs a device.
    honours_target: bool = False
    #: Matches only an address that belongs to a device. A site policy does
    #: not: a site has addresses with no device on them, and they are still at
    #: the site.
    requires_device: bool = False
    #: ``(policy, ip, device) -> bool``, for the scopes that match on a plain
    #: comparison. ``None`` where the resolver handles it specially.
    match: Callable | None = None


#: In rank order, loosest first. The resolver walks this; nothing else decides
#: which scopes exist.
SCOPES: tuple[PolicyScope, ...] = (
    PolicyScope(
        value="global", label="Global", field=None, rbac_slug=None, rank=0,
        match=lambda policy, ip, device: True,
    ),
    PolicyScope(
        value="region", label="Region", field="region", rbac_slug="region",
        # Above site, and deliberately low: prefix policies rank by mask
        # length, and nothing realistic is a /4, so region cannot collide.
        rank=4, honours_target=True,
        match=lambda policy, ip, device: policy.region_id in _region_chain(
            address_site_id(ip, device)
        ),
    ),
    PolicyScope(
        # `field` is deliberately not the scope value: see the model.
        value="site", label="Site", field="target_site", rbac_slug="site",
        # Not device-shaped: a site has addresses with no device on them, and
        # they are still at the site.
        rank=6, honours_target=True,
        match=lambda policy, ip, device: (
            policy.target_site_id is not None
            and policy.target_site_id == address_site_id(ip, device)
        ),
    ),
    PolicyScope(
        value="vrf", label="VRF", field="vrf", rbac_slug="vrf", rank=10,
        # NULL == NULL on purpose: a VRF policy with no VRF is the Global VRF.
        match=lambda policy, ip, device: policy.vrf_id == ip.vrf_id,
    ),
    PolicyScope(
        value="platform", label="Platform", field="platform",
        rbac_slug="platform", rank=18,
        honours_target=True, requires_device=True,
        # Broader than a device type: one platform spans many models.
        match=lambda policy, ip, device: (
            policy.platform_id is not None
            and policy.platform_id == device.platform_id
        ),
    ),
    PolicyScope(
        value="device_type", label="Device type", field="device_type",
        rbac_slug="devicetype", rank=20,
        honours_target=True, requires_device=True,
        match=lambda policy, ip, device: (
            policy.device_type_id == device.device_type_id
        ),
    ),
    PolicyScope(
        value="device_role", label="Device role", field="device_role",
        rbac_slug="devicerole", rank=21,
        honours_target=True, requires_device=True,
        # The policy field is `device_role`; the Device field is `role`.
        match=lambda policy, ip, device: policy.device_role_id == device.role_id,
    ),
    PolicyScope(
        value="device", label="Device", field="device", rbac_slug="device",
        rank=128, honours_target=True, requires_device=True,
        match=lambda policy, ip, device: policy.device_id == device.id,
    ),
    PolicyScope(
        value="prefix", label="Prefix", field="prefix", rbac_slug="prefix",
        # Rank comes from the mask length, so the resolver handles it.
        rank=None, match=None,
    ),
)

BY_VALUE: dict[str, PolicyScope] = {s.value: s for s in SCOPES}

#: Model ``choices``.
CHOICES: list[tuple[str, str]] = [(s.value, s.label) for s in SCOPES]

#: Every target field, for the checks that need to assert the others are null.
TARGET_FIELDS: tuple[str, ...] = tuple(s.field for s in SCOPES if s.field)


def scope_for(value: str) -> PolicyScope | None:
    return BY_VALUE.get(value)


def target_field(value: str) -> str | None:
    """The field a policy of this scope must fill in, or None for global."""
    scope = BY_VALUE.get(value)
    return scope.field if scope is not None else None


def address_site_id(ip, device):
    """Which site an address is at.

    Its own, then its device's, then its prefix's - the same order the rest of
    Danbyte reads a site from an address, so a site policy and a site-bound
    engine agree about where something is.
    """
    site_id = getattr(ip, "site_id", None)
    if site_id:
        return site_id
    if device is not None and device.site_id:
        return device.site_id
    prefix = getattr(ip, "prefix", None)
    return getattr(prefix, "site_id", None) if prefix is not None else None


def _region_chain(site_id) -> set:
    """A site's region and every region above it.

    A policy on *Europe* has to reach a site in *Amsterdam*, so this walks up.
    Bounded and cycle-guarded: ``Region.parent`` is validated on save, but the
    resolver runs against whatever is in the table.
    """
    if not site_id:
        return set()
    from api.models import Region, Site

    region_id = (
        Site.objects.filter(pk=site_id).values_list("region_id", flat=True).first()
    )
    out: set = set()
    seen: set = set()
    current = region_id
    while current and current not in seen and len(seen) < 32:
        seen.add(current)
        out.add(current)
        current = (
            Region.objects.filter(pk=current)
            .values_list("parent_id", flat=True)
            .first()
        )
    return out


def filters_pass(policy, ip, device, device_tags=None) -> bool:
    """Whether a policy's filters admit this address.

    Filters narrow whatever the scope matched; they never widen it and never
    disable a check, so ANDing them is the whole semantics. A policy with no
    filters passes everything, which is what every policy written before they
    existed does.

    Both read from the **device**: a tag or a name belongs to a thing, and an
    address with nothing on it has neither. So a filtered policy simply does
    not reach an unassigned address - narrower, never wider, which is the safe
    direction for a rule that can only add monitoring.
    """
    tags = policy.match_tags or []
    pattern = (policy.match_name or "").strip()
    iface = (policy.match_interface or "").strip()
    if not tags and not pattern and not iface:
        return True
    if iface:
        # Reads the address's interface rather than the device: "only the
        # addresses on the uplinks" is a statement about ports, not hosts. An
        # address bound to nothing never matches, which is the narrow answer.
        from fnmatch import fnmatchcase

        name = getattr(getattr(ip, "assigned_interface", None), "name", "")
        if not name or not fnmatchcase(name.lower(), iface.lower()):
            return False
    if not tags and not pattern:
        return True
    if device is None:
        return False
    if pattern:
        from fnmatch import fnmatchcase

        # Case-insensitive: hostnames are, and an operator typing "CORE-*"
        # means the same thing as "core-*".
        if not fnmatchcase((device.name or "").lower(), pattern.lower()):
            return False
    if tags:
        # `device_tags` is read once per address by the caller. Reading it here
        # would be a query per policy per address, which is how the policy
        # prefetch got itself into trouble.
        have = device_tags if device_tags is not None else {
            t.slug for t in device.tags.all()
        }
        # All of them: filters narrow, so several tags is an intersection.
        if not set(tags) <= have:
            return False
    return True
