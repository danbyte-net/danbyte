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
    #: Honours ``MonitoringPolicy.target`` and needs the address to belong to a
    #: device.
    device_shaped: bool = False
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
        value="vrf", label="VRF", field="vrf", rbac_slug="vrf", rank=10,
        # NULL == NULL on purpose: a VRF policy with no VRF is the Global VRF.
        match=lambda policy, ip, device: policy.vrf_id == ip.vrf_id,
    ),
    PolicyScope(
        value="device_type", label="Device type", field="device_type",
        rbac_slug="devicetype", rank=20, device_shaped=True,
        match=lambda policy, ip, device: (
            policy.device_type_id == device.device_type_id
        ),
    ),
    PolicyScope(
        value="device_role", label="Device role", field="device_role",
        rbac_slug="devicerole", rank=21, device_shaped=True,
        # The policy field is `device_role`; the Device field is `role`.
        match=lambda policy, ip, device: policy.device_role_id == device.role_id,
    ),
    PolicyScope(
        value="device", label="Device", field="device", rbac_slug="device",
        rank=128, device_shaped=True,
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
