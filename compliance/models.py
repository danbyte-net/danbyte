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
    EOL_STATUS = "eol_status", "End-of-life status"


class EolFailOn(models.TextChoices):
    """What an ``eol_status`` rule fails on (#8)."""

    EOL = "eol", "End of life"
    ENDING = "ending", "Support ending or ended"
    UNKNOWN = "unknown", "No end-of-life data"


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
    "virtualmachine": "Virtual machine",
}

# Object types an ``eol_status`` rule can target: the ones that carry a
# platform. The status is their platform's end-of-life mapping (#8).
EOL_OBJECT_TYPES = ("device", "virtualmachine")


class ComplianceRule(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="compliance_rules"
    )
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="")
    # Operator-authored Markdown "how to fix" guide, rendered wherever the
    # rule's violations are shown (rule detail, per-device compliance page).
    remediation = models.TextField(
        blank=True,
        default="",
        help_text="Markdown remediation guide shown alongside violations.",
    )
    enabled = models.BooleanField(default=True)
    severity = models.CharField(
        max_length=8, choices=Severity.choices, default=Severity.WARNING
    )

    object_type = models.CharField(
        max_length=20, help_text="Which model the rule applies to."
    )
    check_type = models.CharField(max_length=16, choices=CheckType.choices)

    # Check params - interpreted by the engine per check_type:
    #   required / forbidden / regex  → {"field": "description", "pattern": "..."}
    #   required_tag                  → {"tag": "monitored"}
    #   required_cf                   → {"cf_key": "owner"}
    field = models.CharField(max_length=64, blank=True, default="")
    pattern = models.CharField(max_length=255, blank=True, default="")
    tag = models.CharField(max_length=100, blank=True, default="")
    cf_key = models.CharField(max_length=64, blank=True, default="")
    #   eol_status                    → {"eol_fail_on": "ending"}
    eol_fail_on = models.CharField(
        max_length=8, choices=EolFailOn.choices, blank=True, default="",
        db_default="",
    )

    class Meta:
        ordering = ["object_type", "name"]
        indexes = [models.Index(fields=["tenant", "enabled"])]

    def __str__(self) -> str:
        return f"{self.name} ({self.object_type})"


# ─── End-of-life data (#8) ───────────────────────────────────────────────────
# Opt-in, deployment-wide. A deployment admin switches it on and picks the
# sources; the fetched catalog (EolProduct) is cached data, not seed data, and
# nothing maps a platform until someone picks the product and cycle for it.


class EolSettings(TimestampedModel):
    """Deployment-wide end-of-life settings (singleton, ``pk=1``)."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    enabled = models.BooleanField(default=False)
    #: Source keys (``compliance.eol_sources``) a refresh fetches.
    sources = models.JSONField(default=list, blank=True)
    #: ``{source key: base URL}``. Blank uses the source's public URL; a
    #: mirror or proxy goes here.
    source_urls = models.JSONField(default=dict, blank=True)
    warning_days = models.PositiveSmallIntegerField(
        default=180,
        help_text="End of life within this many days reads as Support ending.",
    )
    last_refresh_at = models.DateTimeField(null=True, blank=True)
    #: "" · queued · running · ok · failed
    last_refresh_status = models.CharField(max_length=8, blank=True, default="")
    last_refresh_error = models.TextField(blank=True, default="")
    #: online · import
    last_refresh_via = models.CharField(max_length=8, blank=True, default="")

    class Meta:
        verbose_name = "end-of-life settings"
        verbose_name_plural = "end-of-life settings"

    @classmethod
    def load(cls) -> EolSettings:
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def __str__(self) -> str:
        return "End-of-life settings"


class EolProduct(TimestampedModel):
    """One product of a source's catalog with its release cycles, as last
    fetched or imported. Deployment-wide: the catalog is public data."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source = models.CharField(max_length=32)
    name = models.CharField(max_length=128)
    label = models.CharField(max_length=200, blank=True, default="")
    category = models.CharField(max_length=64, blank=True, default="")
    aliases = models.JSONField(default=list, blank=True)
    #: Normalised cycles, newest first: ``{name, label, release_date,
    #: support_until, eol_date, eol, lts, latest}``.
    releases = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["source", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["source", "name"], name="uniq_eolproduct_source_name"
            )
        ]

    def __str__(self) -> str:
        return self.label or self.name


class EolMapping(TimestampedModel):
    """A platform's end-of-life product and cycle, with the cycle's facts as
    of the last refresh. Scoped like the platform: same tenant."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="eol_mappings"
    )
    platform = models.OneToOneField(
        "api.Platform", on_delete=models.CASCADE, related_name="eol_mapping"
    )
    source = models.CharField(max_length=32)
    product = models.CharField(max_length=128)
    cycle = models.CharField(max_length=64)
    release_date = models.DateField(null=True, blank=True)
    #: End of active support (bug fixes).
    support_until = models.DateField(null=True, blank=True)
    #: End of life - security fixes stop.
    eol_date = models.DateField(null=True, blank=True)
    #: The source's own end-of-life flag, for a cycle without a date.
    eol_reached = models.BooleanField(null=True, blank=True)
    lts = models.BooleanField(default=False)
    latest_version = models.CharField(max_length=64, blank=True, default="")
    #: When the facts were last taken from the catalog. Null = never.
    synced_at = models.DateTimeField(null=True, blank=True)
    #: The product or cycle is no longer in the catalog.
    missing = models.BooleanField(default=False)

    class Meta:
        ordering = ["product", "cycle"]
        indexes = [models.Index(fields=["source", "product"])]

    def __str__(self) -> str:
        return f"{self.product} {self.cycle}"
