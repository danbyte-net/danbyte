"""User-declared customization objects.

Today this is the ``CustomField`` definition — the schema that gives the
otherwise free-form ``custom_fields`` JSONB blob (on every domain model) a
label, a type, and validation. Definitions are **tenant-scoped**: each tenant
declares its own fields, in keeping with the platform's zero-pre-filled-data
rule (we ship the mechanism, never the fields).
"""
from __future__ import annotations

import uuid

from django.core.exceptions import ValidationError
from django.db import models

from core.models import TimestampedModel


# Field data types. The frontend mirrors this list in lib/custom-fields.ts —
# keep the two in sync.
CUSTOM_FIELD_TYPES = [
    ("text", "Text"),
    ("textarea", "Text (multi-line)"),
    ("integer", "Integer"),
    ("decimal", "Decimal"),
    ("boolean", "Boolean"),
    ("date", "Date"),
    ("url", "URL"),
    ("select", "Selection"),
    ("multiselect", "Multiple selection"),
    ("object", "Object reference"),
]
CUSTOM_FIELD_TYPE_VALUES = {t[0] for t in CUSTOM_FIELD_TYPES}
_CHOICE_TYPES = {"select", "multiselect"}

# What a custom field can attach to is no longer a hand-kept list — it's
# auto-derived from every model carrying ``CustomFieldsMixin`` (plus plugin
# registrations). See customization/object_registry.py.
from .object_registry import (  # noqa: E402
    customizable_model_values,
    customizable_models,
)


class CustomFieldGroup(TimestampedModel):
    """A named bucket that related custom fields can belong to, so forms and
    detail pages render them under a heading instead of one flat list.

    Smarter than a free-text group name (NetBox's approach): a real object means
    renaming/reordering happens in one place, typos can't split a group, and the
    group can carry a description + a collapse default. Tenant-scoped like every
    other customization object.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE,
        related_name="custom_field_groups",
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(
        max_length=64, help_text="Stable reference, unique within the tenant."
    )
    description = models.TextField(blank=True)
    weight = models.IntegerField(
        default=0, help_text="Section order, low → high."
    )
    collapsed = models.BooleanField(
        default=False, help_text="Start collapsed on detail pages."
    )
    owning_site = models.ForeignKey(
        "api.Site", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Set = local to that site (enhanced site separation); "
        "empty = global to the tenant.",
    )

    class Meta:
        ordering = ["weight", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_cfgroup_tenant_slug"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class CustomField(TimestampedModel):
    """A tenant-defined field that extends ``custom_fields`` on domain objects."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="custom_fields"
    )
    key = models.SlugField(
        max_length=64,
        help_text="The JSON key stored in custom_fields, e.g. owner_team.",
    )
    label = models.CharField(
        max_length=128, help_text="Human-friendly name shown in forms."
    )
    type = models.CharField(
        max_length=16, choices=CUSTOM_FIELD_TYPES, default="text"
    )
    applies_to = models.JSONField(
        default=list, blank=True,
        help_text="Model slugs this field attaches to (see CUSTOMIZABLE_MODELS).",
    )
    choices = models.JSONField(
        default=list, blank=True,
        help_text="Allowed options for select / multiselect fields.",
    )
    related_model = models.CharField(
        max_length=32, blank=True, default="",
        help_text="Object fields: the reference-model slug the value points "
        "at (see customization.object_registry).",
    )
    scope_rules = models.JSONField(
        default=dict,
        blank=True,
        help_text="Optional structured visibility/reference scope rules.",
    )
    required = models.BooleanField(default=False)
    default = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Default value, stored as text and coerced by type.",
    )
    description = models.TextField(blank=True)
    weight = models.IntegerField(default=0, help_text="Display order, low → high.")
    group = models.ForeignKey(
        CustomFieldGroup, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="fields",
        help_text="Optional section this field is shown under.",
    )
    owning_site = models.ForeignKey(
        "api.Site", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Set = local to that site (enhanced site separation); "
        "empty = global to the tenant.",
    )

    class Meta:
        ordering = ["weight", "label"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "key"], name="uniq_customfield_tenant_key"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.label} ({self.key})"

    def clean(self):
        if self.type in _CHOICE_TYPES and not self.choices:
            raise ValidationError(
                {"choices": "Provide at least one choice for a selection field."}
            )
        bad = [
            m for m in (self.applies_to or [])
            if m not in customizable_model_values()
        ]
        if bad:
            raise ValidationError(
                {"applies_to": f"Unknown model(s): {', '.join(bad)}"}
            )
        if self.type == "object":
            from .object_registry import reference_model

            if not self.related_model:
                raise ValidationError(
                    {"related_model": "Object fields must name a target model."}
                )
            if reference_model(self.related_model) is None:
                raise ValidationError(
                    {"related_model": f"Unknown model: {self.related_model}"}
                )
