"""RBAC scoping for cables, whose locality is derived from both endpoints."""

from __future__ import annotations

from django.core.exceptions import FieldError
from django.db.models import Exists, OuterRef, Q

from auth_api import rbac

from .models import Cable, CableTermination


_DEVICE_POINTS = (
    "interface",
    "front_port",
    "rear_port",
    "console_port",
    "console_server_port",
    "power_port",
    "power_outlet",
    "aux_port",
)


def _constraint_q(value) -> Q:
    if not value:
        return Q()
    if isinstance(value, dict):
        return Q(**value)
    if isinstance(value, list):
        out = Q(pk__in=[])
        for item in value:
            if isinstance(item, dict):
                out |= Q(**item)
        return out
    return Q(pk__in=[])


def _allowed_termination_q(site_ids: set, *, include_shared: bool) -> Q:
    out = Q(pk__in=[])
    for field in _DEVICE_POINTS:
        site_q = Q(**{f"{field}__device__site_id__in": site_ids})
        if include_shared:
            site_q |= Q(**{f"{field}__device__site_id__isnull": True})
        out |= Q(**{f"{field}__isnull": False}) & site_q

    feed_site_q = Q(power_feed__power_panel__site_id__in=site_ids)
    if include_shared:
        feed_site_q |= Q(power_feed__power_panel__site_id__isnull=True)
    return out | (Q(power_feed__isnull=False) & feed_site_q)


def restrict_cables(qs, user, tenant, action: str):
    """Compose each cable grant's constraints with all termination sites."""
    if getattr(user, "is_superuser", False):
        return qs

    clauses = Q(pk__in=[])
    annotations = {}
    matched = False
    for index, perm in enumerate(rbac.applicable_permissions(user, tenant)):
        types = perm.object_types or []
        if "cable" not in types and "*" not in types:
            continue
        if action not in (perm.actions or []):
            continue

        constraint = _constraint_q(perm.constraints)
        try:
            Cable.objects.filter(constraint)
        except FieldError:
            continue

        site_ids = {site.pk for site in perm.sites.all()}
        clause = constraint
        if not clause and not site_ids:
            return qs
        if site_ids:
            allowed = _allowed_termination_q(
                site_ids, include_shared=action == "view"
            )
            outside_name = f"_rbac_outside_{index}"
            terms_name = f"_rbac_terms_{index}"
            annotations[outside_name] = Exists(
                CableTermination.objects.filter(cable_id=OuterRef("pk")).exclude(
                    allowed
                )
            )
            annotations[terms_name] = Exists(
                CableTermination.objects.filter(cable_id=OuterRef("pk"))
            )
            clause &= Q(**{outside_name: False, terms_name: True})

        clauses |= clause
        matched = True

    if not matched:
        return qs.none()
    if annotations:
        qs = qs.annotate(**annotations)
    try:
        return qs.filter(clauses)
    except FieldError:
        return qs.none()


def can_act_on_cable(user, tenant, action: str, cable) -> bool:
    if cable is None:
        return False
    return restrict_cables(
        Cable.objects.filter(pk=cable.pk, tenant=tenant), user, tenant, action
    ).exists()
