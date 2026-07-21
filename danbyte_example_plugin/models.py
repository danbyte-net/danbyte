"""Example plugin domain model.

``Widget`` is a minimal tenant-scoped object that opts into the cross-cutting
core features via mixins — custom fields (``CustomFieldsMixin``) and tags
(``TaggableMixin``) — exactly as a real plugin model would. UUID primary key
and tenant FK follow the Danbyte domain-model conventions.
"""
from __future__ import annotations

import uuid

from django.db import models

from core.models import CustomFieldsMixin, TaggableMixin, TimestampedModel, Tenant


class Widget(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="example_widgets"
    )
    name = models.CharField(max_length=128)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_example_widget_tenant_name"
            ),
        ]

    def __str__(self) -> str:
        return self.name
