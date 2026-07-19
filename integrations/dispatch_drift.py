"""Scheduled config-drift dispatch.

Danbyte never runs Ansible itself — a "scheduled drift" run simply dispatches a
drift event to every configured automation target via
``integrations.dispatch.enqueue_deploy``. The accompanying management command
(``manage.py drift_dispatch``) is fired every minute by a systemd timer; the
work here self-throttles to the interval configured in DeploymentSettings, so
the timer can stay coarse.

No request context — we iterate active tenants explicitly.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.utils import timezone

logger = logging.getLogger("danbyte.deploy")


def run_scheduled_drift_dispatch() -> dict:
    """Dispatch a drift run to every enabled automation target, throttled to the
    configured interval. Returns a small result dict describing what happened."""
    from api.models import Device
    from core.models import DeploymentSettings, Tenant

    from .dispatch import enqueue_deploy
    from .models import AutomationTarget

    ds = DeploymentSettings.load()
    if not ds.config_drift_enabled:
        return {"enabled": False}

    now = timezone.now()
    interval = timedelta(minutes=ds.config_drift_interval_minutes)
    if ds.config_drift_last_run and now - ds.config_drift_last_run < interval:
        return {"skipped": "throttled"}

    tenants = 0
    targets = 0
    runs = 0
    for tenant in Tenant.objects.filter(is_active=True):
        tenants += 1
        device_ids = list(
            Device.objects.filter(tenant=tenant).values_list("id", flat=True)
        )
        for target in AutomationTarget.objects.filter(tenant=tenant, enabled=True):
            targets += 1
            enqueue_deploy(target, device_ids, event="drift")
            runs += 1

    ds.config_drift_last_run = now
    ds.save(update_fields=["config_drift_last_run"])

    return {"tenants": tenants, "targets": targets, "runs": runs}
