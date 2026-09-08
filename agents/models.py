"""Agent access settings and the call log (#11).

The master switches live with the other integrations
(``IntegrationSettings.ai_access_enabled`` / ``ai_writes_enabled``); what
lives here is the narrowing an admin can apply once it is on, and a record
of every call an assistant made - which is how you answer "what has it
actually read".
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from core.models import TimestampedModel

DEFAULT_MAX_ROWS = 50
MAX_ROWS_CEILING = 500


class AgentSettings(TimestampedModel):
    """Per-tenant narrowing for agent access."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.OneToOneField(
        "core.Tenant", on_delete=models.CASCADE, related_name="agent_settings"
    )
    # Object-type slugs an assistant may touch. Empty = every type the
    # token's own permissions already allow.
    allowed_types = models.JSONField(default=list, blank=True)
    max_rows = models.PositiveIntegerField(default=DEFAULT_MAX_ROWS)
    # Keep the call log this long; 0 keeps it until the retention tick runs.
    log_retention_days = models.PositiveIntegerField(default=30)

    class Meta:
        verbose_name_plural = "agent settings"

    def __str__(self) -> str:
        return f"Agent settings · {self.tenant_id}"

    @property
    def effective_max_rows(self) -> int:
        return max(1, min(int(self.max_rows or DEFAULT_MAX_ROWS), MAX_ROWS_CEILING))


class AgentCall(TimestampedModel):
    """One tool call. Arguments are stored as given except for anything the
    secret classifier flags, so an admin can see what was asked."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="agent_calls"
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    token = models.ForeignKey(
        "auth_api.ApiToken", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    token_name = models.CharField(max_length=128, blank=True, default="")
    client = models.CharField(max_length=120, blank=True, default="")
    tool = models.CharField(max_length=64)
    object_type = models.CharField(max_length=64, blank=True, default="")
    arguments = models.JSONField(default=dict, blank=True)
    rows = models.IntegerField(default=0)
    wrote = models.BooleanField(default=False)
    ms = models.IntegerField(default=0)
    error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["tenant", "-created_at"]),
            models.Index(fields=["tool", "-created_at"]),
        ]

    def __str__(self) -> str:
        return f"{self.tool} ({self.rows} row(s))"
