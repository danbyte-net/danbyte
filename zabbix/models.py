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
    # ── provisioning (#162 phase 2) ────────────────────────────────────
    OFF, REVIEW, AUTO = "off", "review", "auto"
    PROVISION_CHOICES = [
        (OFF, "Off - Danbyte writes nothing"),
        (REVIEW, "Review - propose changes for approval"),
        (AUTO, "Auto - apply changes"),
    ]
    #: Whether Danbyte may create or update hosts in Zabbix. **Off by
    #: default**: reading somebody's monitoring is one decision, writing to it
    #: is another, and the second is never implied by the first.
    provision_mode = models.CharField(
        max_length=8, choices=PROVISION_CHOICES, default=OFF
    )
    #: Delete a Zabbix host Danbyte created and no longer sees a reason for.
    #: Off, like everywhere else - Danbyte does not delete records it did not
    #: get asked to delete, least of all in somebody else's system.
    prune_hosts = models.BooleanField(default=False)
    #: How long a host must stay unwanted before pruning acts, so one bad pass
    #: cannot empty a monitoring system.
    prune_after_days = models.PositiveSmallIntegerField(default=7)

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


class ZabbixHostLink(TimestampedModel):
    """The durable link between a Danbyte device and a Zabbix host.

    Stored rather than re-derived every pass, because every other way of
    matching - address, serial, name - is a guess that a rename or a
    re-addressing breaks. Once a pairing is established it survives both.

    ``created_here`` is what makes pruning safe: Danbyte will only ever
    consider removing a host it made itself.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="zabbix_links"
    )
    connection = models.ForeignKey(
        ZabbixConnection, on_delete=models.CASCADE, related_name="links"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="zabbix_links"
    )
    hostid = models.CharField(max_length=32)
    #: The Zabbix visible name at the time of linking - for the UI, and to
    #: notice a rename rather than silently following it.
    host_name = models.CharField(max_length=255, blank=True, default="")
    #: How the pairing was first made: link | address | serial | name | created.
    matched_by = models.CharField(max_length=16, blank=True, default="")
    #: Danbyte created this host, so Danbyte may remove it.
    created_here = models.BooleanField(default=False)
    last_seen_at = models.DateTimeField(null=True, blank=True)
    #: First pass that found no reason for this host any more. Cleared the
    #: moment there is one again.
    unwanted_since = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["host_name"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "device"], name="uniq_zbx_link_conn_device"
            ),
            models.UniqueConstraint(
                fields=["connection", "hostid"], name="uniq_zbx_link_conn_hostid"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.device_id} -> {self.hostid}"


class ZabbixChange(TimestampedModel):
    """One proposed write, waiting for a person.

    Its own model rather than the virtualization sync's ``VirtChange``, which
    is built around a guest and a VM and cannot describe "create a host" for
    anything else.

    A change is a **proposal**, never a record of something done: applying one
    deletes it.
    """

    CREATE = "create_host"
    UPDATE = "update_host"
    AMBIGUOUS = "ambiguous"
    PRUNE = "prune_host"
    KIND_CHOICES = [
        (CREATE, "Create host"),
        (UPDATE, "Update host"),
        (AMBIGUOUS, "Needs a decision"),
        (PRUNE, "Remove host"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="zabbix_changes"
    )
    connection = models.ForeignKey(
        ZabbixConnection, on_delete=models.CASCADE, related_name="changes"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="zabbix_changes",
    )
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    #: What would be written, and why - rendered for the operator to read
    #: before they agree to it.
    detail = models.JSONField(default=dict, blank=True)
    #: Dismissed: kept so detection does not re-raise it every pass.
    ignored = models.BooleanField(default=False)

    class Meta:
        ordering = ["kind", "-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "device", "kind"],
                name="uniq_zbx_change_conn_device_kind",
            )
        ]

    def __str__(self) -> str:
        return f"{self.kind} {self.device_id or ''}".strip()
