"""Compliance / data-policy rules.

User-defined rules that assert a property over a model's rows (e.g. "every
active prefix must have a description", "prod IPs must carry the `monitored`
tag"). Evaluated on demand by ``compliance.engine``; violations are computed,
not stored, so rules always reflect current data.

Zero-pre-filled-data: ships the model + check types, never any rules.
"""
from __future__ import annotations

import uuid

from django.db import models

from core.models import TimestampedModel, Tenant


class CheckType(models.TextChoices):
    REQUIRED = "required", "Field must be set"
    FORBIDDEN = "forbidden", "Field must be empty"
    REGEX = "regex", "Field must match a pattern"
    REQUIRED_TAG = "required_tag", "Must carry a tag"
    REQUIRED_CF = "required_cf", "Custom field must be set"


class Severity(models.TextChoices):
    CRITICAL = "critical", "Critical"
    WARNING = "warning", "Warning"
    INFO = "info", "Info"


# Object types a rule can target → the friendly label shown in the UI.
OBJECT_TYPES = {
    "prefix": "Prefix",
    "ipaddress": "IP address",
    "device": "Device",
    "vlan": "VLAN",
    "vrf": "VRF",
    "site": "Site",
}


class ComplianceRule(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="compliance_rules"
    )
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    enabled = models.BooleanField(default=True)
    severity = models.CharField(
        max_length=8, choices=Severity.choices, default=Severity.WARNING
    )

    object_type = models.CharField(
        max_length=20, help_text="Which model the rule applies to."
    )
    check_type = models.CharField(max_length=16, choices=CheckType.choices)

    # Check params — interpreted by the engine per check_type:
    #   required / forbidden / regex  → {"field": "description", "pattern": "..."}
    #   required_tag                  → {"tag": "monitored"}
    #   required_cf                   → {"cf_key": "owner"}
    field = models.CharField(max_length=64, blank=True, default="")
    pattern = models.CharField(max_length=255, blank=True, default="")
    tag = models.CharField(max_length=100, blank=True, default="")
    cf_key = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        ordering = ["object_type", "name"]
        indexes = [models.Index(fields=["tenant", "enabled"])]

    def __str__(self) -> str:
        return f"{self.name} ({self.object_type})"
