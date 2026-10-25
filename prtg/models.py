"""One PRTG core server Danbyte reads from.

The connection is tenant-owned, like a Zabbix connection: it says how to reach
the server, nothing about which devices it answers for. Pairing PRTG devices
with Danbyte devices and reading sensor states come later, on top of this row.
"""
from __future__ import annotations

import uuid
from urllib.parse import urlsplit

from django.db import models

from core.models import Tenant, TimestampedModel
from monitoring.secrets import EncryptedJSONField


class PrtgConnection(TimestampedModel):
    #: The floor Danbyte reads from. API keys are what Danbyte authenticates
    #: with; older servers only take a username and passhash.
    MIN_VERSION = (24, 1)

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="prtg_connections"
    )
    name = models.CharField(max_length=120)
    #: The classic web interface, e.g. https://prtg.example.com. The classic
    #: API lives under ``/api/`` on it.
    url = models.CharField(max_length=255)
    #: API v2 base. Blank derives it from ``url``: the application server
    #: listens on 1616 (HTTPS) or 1615 (HTTP) on the same host.
    api_v2_url = models.CharField(max_length=255, blank=True, default="", db_default="")
    #: {"api_key": …}. An API key from the PRTG user's account settings.
    #: Write-only through the API; ``api_key_set`` says whether one is stored.
    credentials = EncryptedJSONField(default=dict, blank=True, db_default="")
    verify_tls = models.BooleanField(default=True, db_default=True)
    enabled = models.BooleanField(default=True, db_default=True)
    #: How often the sensors table is read once status reading exists.
    status_interval_seconds = models.PositiveIntegerField(default=120, db_default=120)

    #: Which devices Danbyte keeps in PRTG once provisioning exists.
    #: ``policies`` by default: provisioning PRTG means "the policies decide
    #: what PRTG has"; a PRTG check is a read concern.
    SCOPE_CHECKS, SCOPE_POLICIES = "checks", "policies"
    PROVISION_SCOPE_CHOICES = [
        (SCOPE_CHECKS, "Devices with a PRTG check"),
        (SCOPE_POLICIES, "Every device the policies match"),
    ]
    provision_scope = models.CharField(
        max_length=8, choices=PROVISION_SCOPE_CHOICES,
        default=SCOPE_POLICIES, db_default=SCOPE_POLICIES,
    )

    # ── what the last connection test learned ──────────────────────────
    version = models.CharField(max_length=32, blank=True, default="", db_default="")
    #: Whether API v2 answered the last probe. Null until a test has run.
    v2_available = models.BooleanField(null=True, blank=True)
    last_checked_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="", db_default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_prtg_conn_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name

    @property
    def api_key(self) -> str:
        return (self.credentials or {}).get("api_key", "")

    @property
    def api_key_set(self) -> bool:
        return bool(self.api_key)

    @property
    def v2_base(self) -> str:
        """Where API v2 answers: the stored URL, or the default port on the
        classic interface's host."""
        if self.api_v2_url:
            return self.api_v2_url.rstrip("/")
        parts = urlsplit(self.url or "")
        host = parts.hostname or ""
        if ":" in host:  # IPv6 literal
            host = f"[{host}]"
        if parts.scheme == "http":
            return f"http://{host}:1615/api/v2"
        return f"https://{host}:1616/api/v2"

    def version_tuple(self) -> tuple[int, ...]:
        try:
            return tuple(int(p) for p in self.version.split(".")[:2])
        except ValueError:
            return ()

    @property
    def supported(self) -> bool:
        """False when the server is below the floor - or has never answered."""
        v = self.version_tuple()
        return bool(v) and v >= self.MIN_VERSION
