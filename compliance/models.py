"""Compliance / data-policy rules.

User-defined rules that assert a property over a model's rows (e.g. "every
active prefix must have a description", "prod IPs must carry the `monitored`
tag"). Evaluated on demand by ``compliance.engine``; violations are computed,
not stored, so rules always reflect current data.

Zero-pre-filled-data: ships the model + check types, never any rules.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.contrib.postgres.fields import ArrayField
from django.db import models

from core.models import Tenant, TimestampedModel

from .eol_sources import CUSTOM


class CheckType(models.TextChoices):
    REQUIRED = "required", "Field must be set"
    FORBIDDEN = "forbidden", "Field must be empty"
    REGEX = "regex", "Field must match a pattern"
    REQUIRED_TAG = "required_tag", "Must carry a tag"
    REQUIRED_CF = "required_cf", "Custom field must be set"
    EOL_STATUS = "eol_status", "End-of-life status"
    COVERAGE = "coverage", "Support coverage"
    SOFTWARE_TARGET = "software_target", "Software target"
    EXPRESSION = "expression", "Conditions"


#: The single-field checks from before conditions. They keep working; the
#: rule form offers to convert them to conditions.
LEGACY_CHECKS = ("required", "forbidden", "regex", "required_tag", "required_cf")


class EolFailOn(models.TextChoices):
    """What an ``eol_status`` rule fails on (#8)."""

    EOL = "eol", "End of life"
    ENDING = "ending", "Support ending or ended"
    UNKNOWN = "unknown", "No end-of-life data"


class CoverageFailOn(models.TextChoices):
    """What a ``coverage`` rule fails on (#421)."""

    EXPIRED = "expired", "Expired or not covered"
    EXPIRING = "expiring", "Expiring, expired or not covered"


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

# Object types a ``coverage`` rule can target: devices carry support coverage
# (#421).
COVERAGE_OBJECT_TYPES = ("device",)

# Object types a ``software_target`` rule can target: the ones that carry a
# software version and a platform (#395).
SOFTWARE_TARGET_OBJECT_TYPES = ("device", "virtualmachine")


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

    #: The types the rule applies to, in the order picked.
    object_types = ArrayField(
        models.CharField(max_length=20), default=list, blank=True,
        db_default=models.Value([], ArrayField(models.CharField(max_length=20))),
    )
    #: ``object_types[0]``, kept for ordering and older API readers.
    object_type = models.CharField(
        max_length=20, help_text="Which model the rule applies to."
    )
    #: Which objects the rule judges (``core.expressions`` AST); null = all
    #: of its types.
    scope = models.JSONField(null=True, blank=True)
    #: What an ``expression`` check requires of each object in scope.
    condition = models.JSONField(null=True, blank=True)
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
    #   coverage                      → {"coverage_fail_on": "expired",
    #                                    "tag": optional - only devices with it}
    coverage_fail_on = models.CharField(
        max_length=8, choices=CoverageFailOn.choices, blank=True, default="",
        db_default="",
    )
    #   software_target               → {"fail_on_unknown": false} - a blank
    #                                    software version fails too (#395)
    fail_on_unknown = models.BooleanField(default=False, db_default=False)
    #   eol_status                    → {"include_software": false} - a device
    #                                    or VM also fails on its installed
    #                                    software (#436)
    include_software = models.BooleanField(default=False, db_default=False)

    class Meta:
        ordering = ["object_type", "name"]
        indexes = [models.Index(fields=["tenant", "enabled"])]

    def __str__(self) -> str:
        return f"{self.name} ({self.object_type})"

    def save(self, *args, **kwargs):
        # The two type columns agree: a write naming only the old single type
        # gets the list, and the list's first type is the single one.
        if not self.object_types and self.object_type:
            self.object_types = [self.object_type]
        if self.object_types:
            self.object_type = self.object_types[0]
        super().save(*args, **kwargs)

    @property
    def types(self) -> list[str]:
        """The rule's object types; a row from before 0009 reads its one."""
        return list(self.object_types or ([self.object_type] if self.object_type else []))


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


#: ``EolProduct.source`` of a product a tenant entered by hand.
CUSTOM_SOURCE = CUSTOM


class EolProduct(TimestampedModel):
    """One product with its release cycles. A source's product (``tenant``
    NULL) is the catalog as last fetched or imported, deployment-wide: the
    catalog is public data. A custom product (``source="custom"``) belongs
    to one tenant, is entered by hand, and no refresh or import touches it."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    #: NULL for a source's product; the owner of a custom one.
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="eol_products",
        null=True, blank=True,
    )
    source = models.CharField(max_length=32)
    name = models.CharField(max_length=128)
    label = models.CharField(max_length=200, blank=True, default="")
    category = models.CharField(max_length=64, blank=True, default="")
    aliases = models.JSONField(default=list, blank=True)
    #: Normalised cycles, newest first: ``{name, label, release_date,
    #: support_until, eol_date, extended_until, eol, lts, latest}``.
    releases = models.JSONField(default=list, blank=True)
    #: A custom product's page and notes.
    link = models.URLField(max_length=500, blank=True, default="", db_default="")
    notes = models.TextField(blank=True, default="", db_default="")

    class Meta:
        ordering = ["source", "name"]
        verbose_name = "end-of-life product"
        constraints = [
            models.UniqueConstraint(
                fields=["source", "name"], condition=models.Q(tenant__isnull=True),
                name="uniq_eolproduct_catalog_source_name",
            ),
            models.UniqueConstraint(
                fields=["tenant", "name"],
                condition=models.Q(tenant__isnull=False),
                name="uniq_eolproduct_tenant_name",
            ),
            models.CheckConstraint(
                condition=(
                    (models.Q(tenant__isnull=True) & ~models.Q(source=CUSTOM_SOURCE))
                    | models.Q(tenant__isnull=False, source=CUSTOM_SOURCE)
                ),
                name="eolproduct_custom_has_tenant",
            ),
        ]

    def __str__(self) -> str:
        return self.label or self.name


class EolMapping(TimestampedModel):
    """A platform's or an application's end-of-life product and cycle, with
    the cycle's facts as of the last refresh. Scoped like its subject: same
    tenant. A platform has one; an application has one per cycle its installs
    run (#436), made and dropped with the installs."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="eol_mappings"
    )
    platform = models.OneToOneField(
        "api.Platform", on_delete=models.CASCADE, related_name="eol_mapping",
        null=True, blank=True,
    )
    application = models.ForeignKey(
        "api.Application", on_delete=models.CASCADE, related_name="eol_mappings",
        null=True, blank=True,
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
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(platform__isnull=False, application__isnull=True)
                    | models.Q(platform__isnull=True, application__isnull=False)
                ),
                name="eolmapping_one_subject",
            ),
            models.UniqueConstraint(
                fields=["application", "cycle"], name="uniq_eolmapping_application_cycle"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.product} {self.cycle}"


# ─── Triage (0.19) ───────────────────────────────────────────────────────────
# Violations are computed, never stored; what an operator decides about one is.
# One row per (rule, object): acknowledged, snoozed until a time, or both. The
# evaluation reads these back and marks each violation open, acknowledged or
# snoozed. Clearing the row returns the violation to open. An acknowledgement
# covers one occurrence: an evaluation that finds the object passing clears it
# (engine.clear_passed_acknowledgements); a snooze keeps to its date.


class ComplianceTriage(TimestampedModel):
    """An operator's decision about one rule failing one object."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="compliance_triage"
    )
    rule = models.ForeignKey(
        ComplianceRule, on_delete=models.CASCADE, related_name="triage"
    )
    object_type = models.CharField(max_length=20)
    object_id = models.UUIDField()
    object_repr = models.CharField(max_length=120, blank=True, default="")
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    acknowledged_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    snoozed_until = models.DateTimeField(null=True, blank=True)
    snoozed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    note = models.CharField(max_length=255, blank=True, default="", db_default="")

    class Meta:
        ordering = ["rule", "object_repr"]
        constraints = [
            models.UniqueConstraint(
                fields=["rule", "object_id"], name="uniq_compliancetriage_rule_object"
            )
        ]
        indexes = [models.Index(fields=["tenant", "rule"])]

    def __str__(self) -> str:
        return f"{self.object_repr or self.object_id} · {self.rule.name}"
