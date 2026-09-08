"""Backup and restore records (#27) - deployment tier, all audited.

A :class:`Backup` is one run *and* the artifact it produced; the archive
itself lives on a :class:`BackupTarget`. :class:`BackupSchedule` says when
to make one and how many to keep; :class:`RestoreRun` records a restore.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

from core.models import TimestampedModel
from monitoring.secrets import EncryptedJSONField

COMPONENTS = ("db", "media", "config")

STATUS_CHOICES = [
    ("queued", "Queued"),
    ("running", "Running"),
    ("success", "Success"),
    ("failed", "Failed"),
]


class BackupTarget(TimestampedModel):
    """Where archives are stored: a local directory or an S3 bucket."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120, unique=True)
    kind = models.CharField(max_length=16, default="local")
    #: Kind-specific, non-secret settings (local: path; s3: bucket, prefix, …).
    config = models.JSONField(default=dict, blank=True)
    #: Kind-specific secrets (s3: access_key, secret_key), encrypted at rest.
    credentials = EncryptedJSONField(blank=True, default=dict)
    is_default = models.BooleanField(default=False)
    enabled = models.BooleanField(default=True)
    last_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-is_default", "name"]

    def __str__(self) -> str:
        return self.name

    @property
    def location(self) -> str:
        if self.kind == "local":
            return str(self.config.get("path") or "")
        if self.kind == "s3":
            b, p = self.config.get("bucket", ""), self.config.get("prefix", "")
            return f"s3://{b}/{p}".rstrip("/")
        return ""

    def backend(self):
        from .storage import backend_for

        return backend_for(self.kind, self.config, self.credentials or {})


class BackupSchedule(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    components = models.JSONField(default=list)
    target = models.ForeignKey(BackupTarget, on_delete=models.PROTECT, related_name="schedules")
    #: core.cadence.Cadence.to_dict()
    cadence = models.JSONField(default=dict)
    #: core.cadence.Retention.to_dict()
    retention = models.JSONField(default=dict, blank=True)
    notify_channels = models.ManyToManyField(
        "monitoring.NotificationChannel", blank=True, related_name="backup_schedules"
    )
    enabled = models.BooleanField(default=True)
    last_run_at = models.DateTimeField(null=True, blank=True)
    last_backup = models.ForeignKey(
        "Backup", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class Backup(TimestampedModel):
    KIND_CHOICES = [
        ("manual", "Manual"),
        ("scheduled", "Scheduled"),
        ("pre_upgrade", "Before upgrade"),
        ("pre_restore", "Before restore"),
        ("uploaded", "Uploaded"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, default="manual")
    schedule = models.ForeignKey(
        BackupSchedule, on_delete=models.SET_NULL, null=True, blank=True, related_name="backups"
    )
    target = models.ForeignKey(BackupTarget, on_delete=models.PROTECT, related_name="backups")
    components = models.JSONField(default=list)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="queued")
    #: [{"name", "status", "started_at", "finished_at", "detail"}]
    steps = models.JSONField(default=list, blank=True)
    filename = models.CharField(max_length=255, blank=True, default="")
    location = models.CharField(max_length=512, blank=True, default="")
    size = models.BigIntegerField(null=True, blank=True)
    checksum = models.CharField(max_length=64, blank=True, default="")
    manifest = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True, default="")
    #: Never pruned by retention.
    protected = models.BooleanField(default=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["status", "-created_at"])]

    def __str__(self) -> str:
        return self.filename or f"backup {self.id}"

    # ─── step bookkeeping ─────────────────────────────────────────────────
    def step_start(self, name: str) -> None:
        self.steps = [*self.steps, {
            "name": name, "status": "running",
            "started_at": timezone.now().isoformat(), "finished_at": None, "detail": "",
        }]
        self.save(update_fields=["steps", "updated_at"])

    def step_end(self, status: str = "success", detail: str = "") -> None:
        steps = list(self.steps)
        if steps:
            steps[-1] = {**steps[-1], "status": status,
                         "finished_at": timezone.now().isoformat(), "detail": detail[:500]}
        self.steps = steps
        self.save(update_fields=["steps", "updated_at"])


class RestoreRun(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    backup = models.ForeignKey(Backup, on_delete=models.PROTECT, related_name="restores")
    components = models.JSONField(default=list)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="queued")
    steps = models.JSONField(default=list, blank=True)
    safety_backup = models.ForeignKey(
        Backup, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    error = models.TextField(blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"restore of {self.backup_id}"

    def mirror(self) -> None:
        from . import maintenance

        maintenance.set_progress(str(self.id), {
            "id": str(self.id), "backup": str(self.backup_id), "components": list(self.components),
            "status": self.status, "steps": list(self.steps), "error": self.error,
            "safety_backup": str(self.safety_backup_id) if self.safety_backup_id else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "finished_at": self.finished_at.isoformat() if self.finished_at else None,
        })

    def step_start(self, name: str) -> None:
        Backup.step_start(self, name)
        self.mirror()

    def step_end(self, status: str = "success", detail: str = "") -> None:
        Backup.step_end(self, status, detail)
        self.mirror()
