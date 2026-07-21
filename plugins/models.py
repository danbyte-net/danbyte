"""Per-tenant plugin enablement.

Install is deployment-wide (a package in ``PLUGINS``); *enablement* is layered on
top with a cascade — a tenant row overrides the deployment default, which
overrides the plugin's own ``default_enabled``. A ``PluginConfig`` row with a
NULL tenant is the deployment default; a row with a tenant is that tenant's
override. ``config`` holds per-scope settings overrides (JSON).
"""
from __future__ import annotations

import uuid

from django.db import models

from core.models import TimestampedModel


class PluginConfig(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # NULL tenant = the deployment-wide default for this plugin.
    tenant = models.ForeignKey(
        "core.Tenant",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="plugin_configs",
    )
    plugin_slug = models.CharField(max_length=100)
    enabled = models.BooleanField(default=True)
    config = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            # One row per (tenant, plugin). nulls_distinct=False so there is at
            # most ONE deployment-default (NULL tenant) row per plugin.
            models.UniqueConstraint(
                fields=["tenant", "plugin_slug"],
                name="uniq_pluginconfig_tenant_slug",
                nulls_distinct=False,
            ),
        ]

    def __str__(self) -> str:
        scope = self.tenant_id or "deployment"
        return f"{self.plugin_slug}@{scope}={'on' if self.enabled else 'off'}"
