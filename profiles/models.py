"""Device profiles: a use case described once and given to devices and VMs.

A profile names what a device or virtual machine in one role should have -
the application groups it runs, the tags it carries, custom field values and
its platform. Assigning it writes those as ordinary rows; the ledger
(:class:`DeviceProfileItemLink`) remembers which row came from which
assignment, so unassigning takes back only what the profile made and nobody
changed. The engine is :mod:`profiles.engine`.

A profile may have one parent: lists (groups, tags) add up down the chain,
single values (platform, a custom field) come from the nearest profile that
sets them. No cycles, at most :data:`MAX_DEPTH` levels.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from api.models import NumIdMixin
from core.models import CustomFieldsMixin, TaggableMixin, Tenant, TimestampedModel

#: The longest parent chain, the profile itself included.
MAX_DEPTH = 4


class DeviceProfile(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A named use case - "RDS-Server-HR" - for devices and VMs. A tenant
    catalog like application groups: site roles read it, tenant-wide editors
    change it."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="device_profiles"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    description = models.TextField(blank=True, default="", db_default="")
    #: Hex colour for the profile's badge; blank = neutral.
    color = models.CharField(max_length=7, blank=True, default="", db_default="")
    parent = models.ForeignKey(
        "self", on_delete=models.PROTECT, null=True, blank=True, related_name="children",
    )
    applies_to_devices = models.BooleanField(default=True, db_default=True)
    applies_to_vms = models.BooleanField(default=True, db_default=True)
    #: Section: the platform an object gets while it has none.
    platform = models.ForeignKey(
        "api.Platform", on_delete=models.PROTECT, null=True, blank=True,
        related_name="device_profiles",
    )
    #: Section: notes and a runbook link, shown with the profile.
    runbook_url = models.URLField(max_length=500, blank=True, default="", db_default="")
    notes = models.TextField(blank=True, default="", db_default="")
    #: Section: tags every object with the profile carries.
    add_tags = models.ManyToManyField(
        "core.Tag", blank=True, related_name="device_profiles",
    )
    #: Section: ``{custom field key: value}`` filled on an object while blank.
    cf_values = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )
    custom_fields = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
        help_text="User-defined custom fields",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_deviceprofile_tenant_slug"
            ),
        ]

    def __str__(self) -> str:
        return self.name

    @property
    def protected_label(self) -> str:
        """How a refused delete of a referenced row names this profile."""
        return f"device profile {self.name}"

    def chain(self) -> list[DeviceProfile]:
        """The profile and its ancestors, root first. Stops at a loop or past
        the depth cap rather than walking forever on bad data."""
        out, seen, node = [], set(), self
        while node is not None and node.pk not in seen and len(out) <= MAX_DEPTH:
            seen.add(node.pk)
            out.append(node)
            node = node.parent
        return list(reversed(out))


class DeviceProfileApplicationGroup(models.Model):
    """Section row: one application group the profile assigns."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="+")
    profile = models.ForeignKey(
        DeviceProfile, on_delete=models.CASCADE, related_name="application_group_items",
    )
    group = models.ForeignKey(
        "api.ApplicationGroup", on_delete=models.PROTECT, related_name="device_profile_items",
    )
    position = models.PositiveIntegerField(default=0, db_default=0)

    class Meta:
        ordering = ["position"]
        verbose_name = "device profile application group"
        constraints = [
            models.UniqueConstraint(
                fields=["profile", "group"], name="uniq_deviceprofile_application_group"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.profile} - {self.group}"

    @property
    def protected_label(self) -> str:
        """How a refused delete of the group names this row."""
        return f"device profile {self.profile.name}"


class DeviceProfileAssignment(models.Model):
    """A profile on exactly one device or virtual machine, in order: the
    first assignment that sets a single value wins it."""

    STATE_OK, STATE_MISSING, STATE_EDITED, STATE_PENDING = "ok", "missing", "edited", "pending"
    STATE_CHOICES = [
        (STATE_OK, "In step"),
        (STATE_MISSING, "Missing items"),
        (STATE_EDITED, "Edited items"),
        (STATE_PENDING, "Pending"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="+")
    profile = models.ForeignKey(
        DeviceProfile, on_delete=models.PROTECT, related_name="assignments",
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="device_profile_assignments",
    )
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, null=True, blank=True,
        related_name="device_profile_assignments",
    )
    position = models.PositiveIntegerField(default=0, db_default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    state = models.CharField(
        max_length=8, choices=STATE_CHOICES, default=STATE_OK, db_default=STATE_OK,
    )
    missing_count = models.PositiveIntegerField(default=0, db_default=0)
    edited_count = models.PositiveIntegerField(default=0, db_default=0)
    reconciled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["position", "created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(device__isnull=False, virtual_machine__isnull=True)
                    | models.Q(device__isnull=True, virtual_machine__isnull=False)
                ),
                name="deviceprofileassignment_one_parent",
            ),
            models.UniqueConstraint(
                fields=["profile", "device", "virtual_machine"],
                name="uniq_deviceprofileassignment",
                nulls_distinct=False,
            ),
        ]

    def __str__(self) -> str:
        return f"{self.profile} on {self.parent}"

    @property
    def parent(self):
        return self.device if self.device_id else self.virtual_machine


class DeviceProfileItemLink(models.Model):
    """The ledger: one row an assignment wrote (or took over) on its object.

    ``item_kind`` + ``item_id`` name the profile item (``group:<id>``,
    ``tag:<id>``, ``cf:<key>``, ``platform``); ``object_type`` +
    ``object_id`` the row it stands for. ``baseline`` holds what was written
    and what was there before, which decides untouched or edited. A link
    whose row is gone is how *missing* is known."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="+")
    assignment = models.ForeignKey(
        DeviceProfileAssignment, on_delete=models.CASCADE, related_name="links",
    )
    item_kind = models.CharField(max_length=32)
    item_id = models.CharField(max_length=128)
    object_type = models.CharField(max_length=64)
    object_id = models.UUIDField()
    baseline = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["assignment", "item_kind", "item_id", "object_id"],
                name="uniq_deviceprofileitemlink",
            ),
        ]
        indexes = [
            models.Index(fields=["object_type", "object_id"], name="deviceprofilelink_object"),
        ]

    def __str__(self) -> str:
        return f"{self.item_kind} {self.item_id}"
