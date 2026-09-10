"""One Zabbix server Danbyte reads from (#162).

Deliberately separate from :class:`~monitoring.models.MonitoringEngine`: the
engine says *which scope* Zabbix answers for and can be bound to a site or a
location like an Outpost, while this row is *how to reach the server*. Several
engines can share one connection - a multi-site Zabbix is one server - and a
connection with no engine yet is a perfectly good half-configured state.
"""
from __future__ import annotations

import uuid

from django.db import models

from core.models import Tenant, TimestampedModel
from monitoring.secrets import EncryptedJSONField


class ZabbixConnection(TimestampedModel):
    #: Below this, the API differs enough that Danbyte would be guessing.
    #: 6.0 is the oldest LTS with named API tokens, which is what Danbyte uses.
    MIN_VERSION = (6, 0)

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="zabbix_connections"
    )
    name = models.CharField(max_length=120)
    url = models.CharField(
        max_length=255,
        help_text="Frontend URL, e.g. https://zabbix.example.com - the API "
        "endpoint is derived from it.",
    )
    #: {"token": …}. A named Zabbix API token, never a username/password:
    #: tokens carry an expiry, can be revoked on their own, and are what the
    #: vendor's own guidance points at.
    credentials = EncryptedJSONField(default=dict, blank=True)
    verify_tls = models.BooleanField(default=True)
    enabled = models.BooleanField(default=True)
    #: Zabbix trigger severity (0-5, as a string key) -> Danbyte status.
    #: Editable because where an estate draws the line between "worth a colour"
    #: and "worth a page" is an operational decision. Empty = the defaults in
    #: :mod:`zabbix.severity`.
    severity_map = models.JSONField(default=dict, blank=True)

    # ── what the last connection test learned ──────────────────────────
    version = models.CharField(max_length=32, blank=True, default="")
    last_checked_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_zabbix_conn_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name

    @property
    def api_url(self) -> str:
        return f"{self.url.rstrip('/')}/api_jsonrpc.php"

    @property
    def token_set(self) -> bool:
        return bool((self.credentials or {}).get("token"))

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
