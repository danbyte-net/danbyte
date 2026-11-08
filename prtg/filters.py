"""``?prtg=`` on the device list.

``linked`` / ``unlinked`` - whether any enabled PRTG connection has the
device; ``up`` / ``degraded`` / ``down`` / ``unknown`` - the roll-up of its
PRTG sensors. The links are the device's own rows, so the device list's
tenant and site scoping already covers them.
"""
from __future__ import annotations

from rest_framework.exceptions import ValidationError

STATES = ("up", "degraded", "down", "unknown")
VALUES = ("linked", "unlinked", *STATES)


def apply_device_filter(qs, request):
    value = (request.query_params.get("prtg") or "").strip().lower()
    if not value:
        return qs
    if value not in VALUES:
        raise ValidationError({"prtg": f"One of {', '.join(VALUES)}."})
    from .models import PrtgDeviceLink

    links = PrtgDeviceLink.objects.filter(connection__enabled=True)
    if value == "unlinked":
        return qs.exclude(id__in=links.values("device_id"))
    if value != "linked":
        links = links.filter(state=value)
    return qs.filter(id__in=links.values("device_id"))
