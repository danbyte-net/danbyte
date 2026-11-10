"""Turning Discovery on or off re-matches the tenant.

Package matches exist only while Discovery is on for the tenant
(``vulnerabilities.matching``); flipping the integration toggle queues one
recompute when the transaction commits, so they appear or resolve at once.
"""
from __future__ import annotations

from django.db import transaction
from django.db.models.signals import post_init, post_save

_SNAP = "_discovery_was"


def _init(sender, instance, **kwargs):
    setattr(instance, _SNAP, instance.__dict__.get("discovery_enabled"))


def _saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    before = getattr(instance, _SNAP, None)
    after = instance.discovery_enabled
    setattr(instance, _SNAP, after)
    if (created and not after) or before == after:
        return
    tenant_id = instance.tenant_id

    def go():
        from vulnerabilities import jobs
        from vulnerabilities.models import VulnerabilitySettings

        if VulnerabilitySettings.objects.filter(pk=1, enabled=True).exists():
            jobs.enqueue_recompute(tenant_id)

    transaction.on_commit(go)


def connect() -> None:
    from integrations.models import IntegrationSettings

    post_init.connect(_init, sender=IntegrationSettings, dispatch_uid="discovery-init-int")
    post_save.connect(_saved, sender=IntegrationSettings, dispatch_uid="discovery-save-int")
