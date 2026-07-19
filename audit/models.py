"""Change log — an append-only audit trail of object create/update/delete.

Records are written by ``audit.signals`` (model signals) with the acting user
captured by ``audit.middleware`` from the request. Each entry
carries a field-level diff so you can see exactly what changed.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models


class ChangeAction(models.TextChoices):
    CREATE = "create", "Created"
    UPDATE = "update", "Updated"
    DELETE = "delete", "Deleted"


class ChangeLogEntry(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="changelog",
    )
    timestamp = models.DateTimeField(auto_now_add=True, db_index=True)

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="changelog",
    )
    # Denormalised so the trail survives the user being deleted.
    user_name = models.CharField(max_length=255, blank=True, default="")

    action = models.CharField(max_length=8, choices=ChangeAction.choices)
    object_type = models.CharField(
        max_length=64, help_text="Model label, e.g. api.prefix."
    )
    object_label = models.CharField(
        max_length=64, help_text="Human model name, e.g. Prefix."
    )
    object_id = models.CharField(max_length=64)
    object_repr = models.CharField(max_length=255)
    # Site of the object at write time, captured here so row/site RBAC on the
    # change log survives the object being deleted (a DELETE entry outlives its
    # row, so we can't re-derive the site later). NULL = the object has no site
    # (global catalogs) or its site couldn't be resolved. Plain UUID (not an FK)
    # so deleting a Site never rewrites history.
    object_site_id = models.UUIDField(null=True, blank=True, db_index=True)

    # {field: {"old": ..., "new": ...}} for updates; "{}" for create/delete.
    changes = models.JSONField(default=dict, blank=True)
    # Full field snapshots (NetBox-style): the whole row before the write
    # (update/delete) and after it (create/update). Null when not applicable —
    # a create has no pre state, a delete no post state.
    pre_change = models.JSONField(null=True, blank=True)
    post_change = models.JSONField(null=True, blank=True)
    # Groups every entry produced within a single request.
    request_id = models.CharField(max_length=36, blank=True, default="")

    class Meta:
        ordering = ["-timestamp"]
        verbose_name_plural = "change log entries"
        indexes = [
            models.Index(fields=["tenant", "-timestamp"]),
            models.Index(fields=["object_type", "object_id"]),
            models.Index(fields=["user", "-timestamp"]),
        ]

    def __str__(self) -> str:
        return f"{self.action} {self.object_label} {self.object_repr}"


class JournalKind(models.TextChoices):
    INFO = "info", "Info"
    SUCCESS = "success", "Success"
    WARNING = "warning", "Warning"
    DANGER = "danger", "Danger"


class JournalEntry(models.Model):
    """A free-form, user-authored note attached to an object (a journal
    entry). Distinct from the auto change log: humans write these to record
    context, decisions, and operational notes. Object is referenced the same
    way as a change-log entry (``object_type`` label + ``object_id``)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="journal",
    )
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="journal_entries",
    )
    # Denormalised so the note survives the author being deleted.
    author_name = models.CharField(max_length=255, blank=True, default="")

    object_type = models.CharField(
        max_length=64, help_text="Model label, e.g. api.prefix."
    )
    object_id = models.CharField(max_length=64)
    # Site of the target object at write time — row/site RBAC on notes without
    # re-fetching the (possibly deleted) object. NULL = no site / unresolved.
    object_site_id = models.UUIDField(null=True, blank=True, db_index=True)

    kind = models.CharField(
        max_length=8, choices=JournalKind.choices, default=JournalKind.INFO
    )
    comments = models.TextField()

    class Meta:
        ordering = ["-created_at"]
        verbose_name_plural = "journal entries"
        indexes = [
            models.Index(fields=["object_type", "object_id", "-created_at"]),
            models.Index(fields=["tenant", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"Journal {self.kind} on {self.object_type} {self.object_id}"
