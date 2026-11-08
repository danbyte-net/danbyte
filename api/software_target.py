"""Software target (#395): the version a device or VM runs against the version
its platform wants running.

``on``       the object's ``software_version`` equals the platform's
             ``target_version``;
``off``      both are set and they differ;
``unknown``  no version recorded, or the platform has no target (or there is
             no platform).

A device's platform is its effective platform: its own, else its device
type's. A VM has only its own.
"""
from __future__ import annotations

from django.db.models import Case, CharField, F, Q, Value, When
from django.db.models.functions import Coalesce

STATES = ("on", "off", "unknown")


def platform_of(obj):
    """The platform the object's version is judged against."""
    p = getattr(obj, "platform", None)
    if p is None and getattr(obj, "device_type_id", None):
        p = obj.device_type.platform
    return p


def target_of(obj) -> str:
    p = platform_of(obj)
    return (p.target_version if p else "") or ""


def state_of(obj) -> str:
    version = obj.software_version or ""
    target = target_of(obj)
    if not version or not target:
        return "unknown"
    return "on" if version == target else "off"


def describe(obj) -> str:
    """One line for a result: ``Running 17.9.4a, target 17.9.5``."""
    version = obj.software_version or ""
    target = target_of(obj)
    running = f"Running {version}" if version else "No version recorded"
    return f"{running}, target {target}" if target else f"{running}, no target"


def mark_manual(attrs, instance) -> None:
    """A person changing the version through the API makes it theirs: the
    integration stamp goes, so no sync overwrites it (#451 adds the source)."""
    from .software_versions import mark_manual as _mark

    _mark(attrs, instance)


def _target_expr(model):
    if model._meta.model_name == "device":
        # The device's own platform wins even when it has no target.
        return Case(
            When(platform__isnull=False, then=F("platform__target_version")),
            default=Coalesce(F("device_type__platform__target_version"), Value("")),
            output_field=CharField(),
        )
    return Coalesce(F("platform__target_version"), Value(""), output_field=CharField())


def state_q(state: str) -> Q:
    """A filter on a queryset annotated by :func:`annotate`."""
    known = ~Q(software_version="") & ~Q(_software_target="")
    if state == "on":
        return known & Q(software_version=F("_software_target"))
    if state == "off":
        return known & ~Q(software_version=F("_software_target"))
    if state == "unknown":
        return ~known
    raise ValueError(state)


def annotate(qs):
    return qs.annotate(_software_target=_target_expr(qs.model))


def apply_filter(qs, request):
    """``?software_target=on|off|unknown`` on a device or VM list; an unknown
    value is a 400."""
    raw = request.query_params.get("software_target") if request else None
    if not raw:
        return qs
    from rest_framework.exceptions import ValidationError

    if raw not in STATES:
        raise ValidationError({"software_target": f"One of {', '.join(STATES)}."})
    return annotate(qs).filter(state_q(raw))
