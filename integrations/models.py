"""Outbound webhooks — POST a payload to an external URL when objects change.

Tenant-scoped: each tenant configures its own webhooks. Delivery is fired from
post_save / post_delete signals (see ``webhooks.py``) and runs off the request
path on the RQ ``low`` queue, so a delivery failure can never break a save.
"""
from __future__ import annotations

import uuid

from django.db import models

from core.models import TimestampedModel
from monitoring.secrets import EncryptedJSONField


class Webhook(TimestampedModel):
    HTTP_METHOD_CHOICES = [
        ("POST", "POST"),
        ("PUT", "PUT"),
        ("PATCH", "PATCH"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="webhooks"
    )
    name = models.CharField(max_length=128)
    enabled = models.BooleanField(default=True)
    object_types = models.JSONField(
        default=list,
        help_text="Object-type slugs this fires for (see the RBAC registry), "
                  "or [\"*\"] for every type.",
    )
    on_create = models.BooleanField(default=True)
    on_update = models.BooleanField(default=True)
    on_delete = models.BooleanField(default=False)

    payload_url = models.URLField(max_length=512)
    http_method = models.CharField(
        max_length=8, choices=HTTP_METHOD_CHOICES, default="POST"
    )
    http_content_type = models.CharField(
        max_length=100, default="application/json"
    )
    # Encrypted at rest (same Fernet backend as SMTP/SNMP secrets). Reads
    # round-trip the plain string; empty decrypts to a falsy value.
    secret = EncryptedJSONField(
        blank=True, default="",
        help_text="When set, payloads are signed: the hex HMAC-SHA512 of the "
                  "body is sent in the X-Danbyte-Signature header.",
    )
    additional_headers = models.TextField(
        blank=True, default="",
        help_text="Extra request headers, one 'Name: value' per line.",
    )
    ssl_verification = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_webhook_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name

    def matches(self, slug: str, event: str) -> bool:
        """Does this webhook fire for ``slug`` on ``event`` (created/updated/
        deleted)?"""
        if not self.enabled:
            return False
        types = self.object_types or []
        if "*" not in types and slug not in types:
            return False
        return {
            "created": self.on_create,
            "updated": self.on_update,
            "deleted": self.on_delete,
        }.get(event, False)


class AutomationTarget(TimestampedModel):
    """A runner Danbyte can dispatch a deploy to — an Ansible AWX/AAP job
    template, or a generic signed webhook (Jenkins/GitLab/Rundeck). Danbyte fires
    the trigger; the runner holds device creds and does the push."""

    import uuid as _uuid

    KIND_CHOICES = [
        ("awx", "Ansible AWX / AAP"),
        ("webhook", "Generic webhook"),
    ]

    id = models.UUIDField(primary_key=True, default=_uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="automation_targets"
    )
    name = models.CharField(max_length=128)
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, default="awx")
    enabled = models.BooleanField(default=True)
    base_url = models.URLField(
        max_length=512,
        help_text="AWX/AAP controller URL (e.g. https://awx.example.com) or, for "
                  "a generic webhook, the full POST URL.",
    )
    job_template_id = models.CharField(
        max_length=64, blank=True, default="",
        help_text="AWX job-template id to launch (AWX kind only).",
    )
    # Encrypted at rest — an AWX bearer token is lateral movement into the
    # automation platform if the DB leaks.
    token = EncryptedJSONField(
        blank=True, default="",
        help_text="AWX bearer token / webhook signing secret. Write-only.",
    )
    ssl_verify = models.BooleanField(default=True)
    extra_vars = models.JSONField(
        default=dict, blank=True,
        help_text="Extra vars merged into the AWX launch / webhook payload.",
    )
    # Optional opt-in: auto-dispatch when a matching object changes (P2.5).
    auto_on_change = models.BooleanField(default=False)
    object_types = models.JSONField(
        default=list,
        help_text="Object-type slugs this target can deploy (default: device).",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_automationtarget_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class DeployRun(TimestampedModel):
    """A record of one dispatch to an AutomationTarget (P2.6)."""

    import uuid as _uuid

    STATUS_CHOICES = [
        ("queued", "Queued"),
        ("launched", "Launched"),
        ("failed", "Failed"),
    ]

    id = models.UUIDField(primary_key=True, default=_uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="deploy_runs"
    )
    target = models.ForeignKey(
        AutomationTarget, on_delete=models.SET_NULL, null=True,
        related_name="runs",
    )
    target_name = models.CharField(max_length=128)
    event = models.CharField(max_length=32, default="manual")
    device_ids = models.JSONField(default=list)
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default="queued"
    )
    detail = models.TextField(blank=True, default="")
    # When the dispatch reached a terminal state (launched/failed). ``created_at``
    # is the enqueue time, so ``finished_at - created_at`` is the dispatch latency.
    finished_at = models.DateTimeField(null=True, blank=True)
    # Retry bookkeeping: ``attempt`` is 1 for the first run, +1 per retry;
    # ``retry_of`` points at the original run so a chain stays linkable.
    attempt = models.PositiveSmallIntegerField(default=1)
    retry_of = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="retries",
    )

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.target_name} · {self.status}"


class DeviceConfigState(TimestampedModel):
    """Latest intended-vs-actual config drift for a device (P3, drift ingest).

    A runner renders intended config from Danbyte, reads the actual running
    config off the box, and POSTs the actual (and optionally the intended) back.
    Danbyte diffs them and stores the result so the device's drift is visible in
    the UI — the read-half of the IaC loop (Golden-Config / Assurance style).
    One row per device (latest wins); history can come later.
    """

    import uuid as _uuid

    STATUS_CHOICES = [
        ("in_sync", "In sync"),
        ("drift", "Drift"),
        ("unknown", "Unknown"),
        ("error", "Error"),
    ]

    id = models.UUIDField(primary_key=True, default=_uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="config_states"
    )
    device = models.OneToOneField(
        "api.Device", on_delete=models.CASCADE, related_name="config_state"
    )
    template = models.ForeignKey(
        "api.ExportTemplate", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default="unknown"
    )
    intended_config = models.TextField(blank=True, default="")
    actual_config = models.TextField(blank=True, default="")
    diff = models.TextField(blank=True, default="")
    source = models.CharField(
        max_length=64, blank=True, default="",
        help_text="Who reported the actual config (e.g. 'ansible', 'nornir').",
    )
    reported_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-reported_at"]

    def __str__(self) -> str:
        return f"{self.device_id} · {self.status}"


class DeviceConfigSnapshot(TimestampedModel):
    """An append-only history of config-drift *transitions* for a device (P3.2).

    A row is written only when the device's drift status or diff actually
    changes (see the signal in ``drift_history.py``) — so the table is an event
    log ("drifted at T1, back in sync at T2"), not one row per heartbeat. Keeps
    the diff for context; the full intended/actual blobs stay on the latest
    ``DeviceConfigState`` only.
    """

    import uuid as _uuid

    id = models.UUIDField(primary_key=True, default=_uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="config_snapshots"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="config_snapshots"
    )
    status = models.CharField(max_length=16)
    diff = models.TextField(blank=True, default="")
    source = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["device", "-created_at"])]

    def __str__(self) -> str:
        return f"{self.device_id} · {self.status} @ {self.created_at:%Y-%m-%d %H:%M}"


class NetBoxImportRun(TimestampedModel):
    """One NetBox → Danbyte import, run off the RQ ``low`` queue so the UI can
    poll its progress. Mirrors ``DeployRun``'s job-record shape.

    The NetBox API token is write-only (Fernet-encrypted in ``secrets``) and
    cleared when the run reaches a terminal state — a migration credential
    should not outlive the migration.
    """

    import uuid as _uuid

    STATUS_CHOICES = [
        ("queued", "Queued"),
        ("running", "Running"),
        ("success", "Success"),
        ("failed", "Failed"),
    ]

    id = models.UUIDField(primary_key=True, default=_uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="netbox_imports"
    )
    url = models.CharField(max_length=512)
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default="queued"
    )
    dry_run = models.BooleanField(default=True)
    update_existing = models.BooleanField(default=False)
    # Skip TLS verification (self-signed NetBox). Must be persisted: the run
    # executes on a worker, and "test connection worked but the run failed on
    # the cert" was exactly the bug when it wasn't.
    insecure = models.BooleanField(default=False)
    only = models.JSONField(default=list, blank=True)
    skip = models.JSONField(default=list, blank=True)
    # Live progress written by the importer's on_progress hook:
    # {step, total, key, pct, totals:{fetched,created,existed,updated,failed}}.
    progress = models.JSONField(default=dict, blank=True)
    # The importer's final report() dict once finished.
    report = models.JSONField(default=dict, blank=True)
    error = models.TextField(blank=True, default="")
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    created_by = models.ForeignKey(
        "auth.User", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    # Fernet-encrypted {"token": "..."} — cleared on finish.
    secrets = EncryptedJSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["tenant", "-created_at"])]

    def __str__(self) -> str:
        return f"NetBox import {self.url} → {self.tenant_id} ({self.status})"
