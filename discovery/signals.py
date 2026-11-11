"""Turning Discovery on or off re-matches the tenant.

Package matches exist only while Discovery is on for the tenant
(``vulnerabilities.matching``); flipping the integration toggle queues one
recompute when the transaction commits, so they appear or resolve at once.

Changing an application's package names queues a tenant-wide install sync
(``discovery.software``), so its installs follow without waiting for the
next read.
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


_PKG_SNAP = "_discovery_package_names"


def _app_init(sender, instance, **kwargs):
    setattr(instance, _PKG_SNAP, instance.__dict__.get("package_names"))


def _app_saved(sender, instance, created, raw=False, **kwargs):
    if raw:
        return
    before = getattr(instance, _PKG_SNAP, None)
    after = instance.package_names or []
    setattr(instance, _PKG_SNAP, after)
    if (before or []) == after:
        return
    from .gate import active

    if not active(instance.tenant):
        return
    from .software import enqueue_sync

    enqueue_sync(instance.tenant_id)


def connect() -> None:
    from api.models import Application
    from integrations.models import IntegrationSettings

    post_init.connect(_init, sender=IntegrationSettings, dispatch_uid="discovery-init-int")
    post_save.connect(_saved, sender=IntegrationSettings, dispatch_uid="discovery-save-int")
    post_init.connect(_app_init, sender=Application, dispatch_uid="discovery-init-app")
    post_save.connect(_app_saved, sender=Application, dispatch_uid="discovery-save-app")
