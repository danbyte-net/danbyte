"""Port-utilization alerts - warn when a device's port fill crosses a rule.

Evaluated by the same danbyte-utilization.timer sweep as prefix utilization,
and fired the same way: ``notify_event`` to the tenant's channels with cache
hysteresis, so a rule doesn't re-page every tick. A device re-arms when its
condition stops holding (or the rule/device disappears - the cache flag
self-expires).

Conditions: used% at-or-above / at-or-below a threshold, or "no ports at
all". Scope per rule: a specific device, a device type, and/or a role
(AND of whatever is set; nothing set = every device in the tenant).
"""
from __future__ import annotations

import logging

from django.core.cache import cache

from .notify import notify_event

log = logging.getLogger("monitoring.port_utilization")

_TTL = 7 * 24 * 3600


def _key(rule_id, device_id) -> str:
    return f"monitoring:portutil_alerted:{rule_id}:{device_id}"


def _matches(rule, row: dict | None) -> tuple[bool, int | None]:
    """Does the rule fire for this device's counts? Returns (fired, pct)."""
    from api.port_utilization import used_pct

    if rule.condition == "no_ports":
        return row is None, None
    if row is None:
        return False, None
    pct = used_pct(row)
    if rule.condition == "above":
        return pct >= rule.threshold_pct, pct
    return pct <= rule.threshold_pct, pct


def _describe(rule, device, pct: int | None, row: dict | None) -> tuple[str, str]:
    if rule.condition == "no_ports":
        subject = f"[Danbyte] {device.name} has no ports"
        body = (
            f"Device {device.name} has no interfaces, front ports or rear "
            f"ports (rule: {rule.name}).\n"
        )
    else:
        word = "reached" if rule.condition == "above" else "dropped to"
        subject = f"[Danbyte] {device.name} port utilization {word} {pct}%"
        used = row["connected"] + row["reserved"]
        body = (
            f"Device {device.name} uses {used} of {row['total']} ports "
            f"({pct}%), {rule.get_condition_display().lower()} "
            f"{rule.threshold_pct}% (rule: {rule.name}).\n"
        )
    return subject, body


def evaluate_port_rules(tenant=None) -> dict:
    from api.models import Device
    from api.port_utilization import device_port_counts

    from .models import PortUtilizationRule

    rules = PortUtilizationRule.objects.filter(enabled=True).select_related(
        "tenant"
    )
    if tenant is not None:
        rules = rules.filter(tenant=tenant)

    fired = 0
    rearmed = 0
    for rule in rules:
        devices = Device.objects.filter(tenant_id=rule.tenant_id)
        if rule.device_id:
            devices = devices.filter(pk=rule.device_id)
        if rule.device_type_id:
            devices = devices.filter(device_type_id=rule.device_type_id)
        if rule.role_id:
            devices = devices.filter(role_id=rule.role_id)

        counts = device_port_counts(devices)
        for device in devices.only("id", "name", "site_id"):
            row = counts.get(device.id)
            hit, pct = _matches(rule, row)
            key = _key(rule.id, device.id)
            already = cache.get(key)
            if hit and not already:
                cache.set(key, pct if pct is not None else 0, _TTL)
                fired += 1
                subject, body = _describe(rule, device, pct, row)
                notify_event(
                    rule.tenant_id,
                    subject,
                    body,
                    {
                        "type": "port_utilization",
                        "rule_id": str(rule.id),
                        "rule_name": rule.name,
                        "condition": rule.condition,
                        "threshold_pct": rule.threshold_pct,
                        "device_id": str(device.id),
                        "device_name": device.name,
                        "used_pct": pct,
                        **(row or {}),
                    },
                    site_id=device.site_id,
                )
            elif not hit and already:
                cache.delete(key)  # re-arm for the next crossing
                rearmed += 1

    return {"fired": fired, "rearmed": rearmed, "rules": rules.count()}
