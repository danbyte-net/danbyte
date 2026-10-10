"""Device configuration backups read from an Oxidized server (#35).

Oxidized is the store. Danbyte keeps how to reach the server and which node
is which device - never the configuration text itself. A config is fetched on
demand when someone with ``device.view_config`` opens it, and at most held in
Redis for a minute or two.
"""
from __future__ import annotations

import uuid

from django.db import models

from core.models import Tenant, TimestampedModel
from monitoring.secrets import EncryptedJSONField


class OxidizedConnection(TimestampedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="oxidized_connections"
    )
    name = models.CharField(max_length=120)
    #: Where oxidized-web answers, e.g. https://oxidized.example.com. The REST
    #: paths (/nodes.json, /node/fetch/…) are appended to it.
    url = models.CharField(max_length=255)
    #: Basic auth, for an oxidized-web behind a reverse proxy that asks for
    #: it. The username is not a secret; the password lives in ``credentials``
    #: ({"password": …}) and is write-only through the API.
    username = models.CharField(max_length=150, blank=True, default="")
    credentials = EncryptedJSONField(default=dict, blank=True)
    verify_tls = models.BooleanField(default=True)
    enabled = models.BooleanField(default=True)

    #: How a node is paired with a device when no one has pinned it by hand.
    MATCH_ADDRESS_NAME, MATCH_ADDRESS, MATCH_NAME = "address_name", "address", "name"
    MATCH_CHOICES = [
        (MATCH_ADDRESS_NAME, "Address, then name"),
        (MATCH_ADDRESS, "Address only"),
        (MATCH_NAME, "Name only"),
    ]
    match_by = models.CharField(
        max_length=16, choices=MATCH_CHOICES, default=MATCH_ADDRESS_NAME
    )

    # ── what the last test and node sync learned ──────────────────────
    last_checked_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")
    node_count = models.PositiveIntegerField(null=True, blank=True)
    last_sync_at = models.DateTimeField(null=True, blank=True)
    #: Counts plus the nodes no device matched, so the mapping page can list
    #: them without asking Oxidized again.
    last_sync_summary = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_oxidized_conn_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name

    @property
    def password_set(self) -> bool:
        return bool((self.credentials or {}).get("password"))

    @property
    def auth(self):
        if not self.username:
            return None
        return (self.username, (self.credentials or {}).get("password", ""))


class OxidizedNodeLink(TimestampedModel):
    """Which Oxidized node holds a device's configuration.

    Made by the node sync from the connection's matching rule, or pinned by an
    admin. A pinned link survives every sync; a matched one is re-decided on
    each pass and goes away when its node does.
    """

    HOW_ADDRESS, HOW_NAME, HOW_MANUAL = "address", "name", "manual"
    HOW_CHOICES = [
        (HOW_ADDRESS, "Address"),
        (HOW_NAME, "Name"),
        (HOW_MANUAL, "Manual"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="oxidized_links"
    )
    connection = models.ForeignKey(
        OxidizedConnection, on_delete=models.CASCADE, related_name="links"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="oxidized_links"
    )
    #: Oxidized's own identity for the node: ``group/name``, or ``name`` when
    #: the node has no group.
    full_name = models.CharField(max_length=255)
    node_name = models.CharField(max_length=255)
    node_group = models.CharField(max_length=255, blank=True, default="")
    node_ip = models.CharField(max_length=64, blank=True, default="")
    node_model = models.CharField(max_length=64, blank=True, default="")
    matched_by = models.CharField(max_length=8, choices=HOW_CHOICES)
    #: When the node sync last saw this node. A pinned link whose node has
    #: gone stays, with this falling behind, so the admin can see it.
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["full_name"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "device"], name="uniq_oxidized_link_conn_device"
            ),
            models.UniqueConstraint(
                fields=["connection", "full_name"], name="uniq_oxidized_link_conn_node"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.device_id} -> {self.full_name}"
