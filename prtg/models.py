"""One PRTG core server Danbyte reads from.

The connection is tenant-owned, like a Zabbix connection: it says how to reach
the server and how to read it. The links pair PRTG devices with Danbyte
devices, the sensor rows hold the latest read, and the change queue holds what
needs a person.
"""
from __future__ import annotations

import uuid
from datetime import timedelta
from urllib.parse import urlsplit

from django.db import models

from core.models import Tenant, TimestampedModel
from monitoring.external.models import (
    ExternalAdoptionRuleBase,
    ExternalChangeBase,
    ExternalLinkBase,
)
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
    #: How often the devices and sensors tables are read.
    status_interval_seconds = models.PositiveIntegerField(default=120, db_default=120)
    #: The monitoring engines whose ``prtg`` checks this connection answers.
    #: Explicit, as for Zabbix: a second PRTG must never answer for the first.
    engines = models.ManyToManyField(
        "monitoring.MonitoringEngine", related_name="prtg_connections", blank=True,
    )
    #: PRTG status code (as a string) -> Danbyte state, for the six codes that
    #: carry a verdict. Empty = the defaults in :mod:`prtg.status`; paused,
    #: unknown, no probe and not licensed are fixed to unknown.
    state_map = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )

    #: What a match does. ``auto`` links an unambiguous match at once - a
    #: pairing is Danbyte bookkeeping and writes nothing to PRTG. ``review``
    #: proposes each one in the queue first.
    LINK_AUTO, LINK_REVIEW = "auto", "review"
    LINK_MODE_CHOICES = [
        (LINK_AUTO, "Link matches automatically"),
        (LINK_REVIEW, "Propose each link for review"),
    ]
    link_mode = models.CharField(
        max_length=8, choices=LINK_MODE_CHOICES,
        default=LINK_AUTO, db_default=LINK_AUTO,
    )
    #: The last status read, attempted or not - the beat's stamp.
    last_status_at = models.DateTimeField(null=True, blank=True)
    last_status_summary = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )

    #: Accept PRTG's "Execute HTTP Action" notification as a hint to re-read
    #: one device sooner. The payload is never trusted - only its ids are
    #: read, and PRTG is asked again.
    push_enabled = models.BooleanField(default=False, db_default=False)
    #: SHA-256 of the hook token. The token itself is shown once, when it is
    #: made, and never stored: it only has to be recognised.
    hook_token_hash = models.CharField(
        max_length=64, blank=True, default="", db_default="", db_index=True,
    )

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

    @property
    def hook_token_set(self) -> bool:
        return bool(self.hook_token_hash)

    def status_due(self, now) -> bool:
        """Whether the beat should read this connection's status now."""
        if not (self.enabled and self.api_key_set):
            return False
        if self.last_status_at is None:
            return True
        return now - self.last_status_at >= timedelta(
            seconds=max(self.status_interval_seconds, 60)
        )

    def status_fresh(self, now) -> bool:
        """Whether the last successful read is recent enough to answer checks
        from: three intervals, so one failed read does not blank everything."""
        if self.last_status_at is None or self.last_error:
            return False
        return now - self.last_status_at <= timedelta(
            seconds=3 * max(self.status_interval_seconds, 60)
        )

    def device_url(self, objid) -> str:
        """The PRTG device page."""
        return f"{self.url.rstrip('/')}/device.htm?id={objid}"


class PrtgDeviceLink(ExternalLinkBase):
    """The pairing between a Danbyte device and a PRTG device.

    Made by matching (:mod:`prtg.matching`), kept across renames and
    re-addressing on both sides, and read by the status pass and the ``prtg``
    check. ``matched_by``, ``created_here``, ``last_seen_at`` and
    ``unwanted_since`` come from the shared base.
    """

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="prtg_links")
    connection = models.ForeignKey(
        PrtgConnection, on_delete=models.CASCADE, related_name="links"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="prtg_links"
    )
    #: PRTG object id, as a string like every remote id Danbyte keeps.
    objid = models.CharField(max_length=16)
    #: What PRTG called it at the last read - to notice a rename, not follow it.
    name = models.CharField(max_length=255, blank=True, default="", db_default="")
    #: PRTG's "IPv4 address/DNS name" field.
    host = models.CharField(max_length=255, blank=True, default="", db_default="")
    probe_name = models.CharField(max_length=255, blank=True, default="", db_default="")
    group_path = models.CharField(max_length=255, blank=True, default="", db_default="")
    #: The PRTG device's own status code at the last read.
    status_raw = models.SmallIntegerField(null=True, blank=True)
    #: The roll-up of its sensors through the connection's map: worst wins,
    #: paused left out. Empty until a read has seen it.
    state = models.CharField(max_length=16, blank=True, default="", db_default="")
    #: Sensors per Danbyte state, plus ``paused`` and ``total``.
    sensor_counts = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )
    #: Whether Danbyte wrote the ``danbyte-<uuid>`` tag on the PRTG device.
    tagged = models.BooleanField(default=False, db_default=False)
    status_read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "device"], name="uniq_prtg_link_conn_device"
            ),
            models.UniqueConstraint(
                fields=["connection", "objid"], name="uniq_prtg_link_conn_objid"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.device_id} -> {self.objid}"

    @property
    def paused(self) -> bool:
        from .status import PAUSED

        return self.status_raw in PAUSED


class PrtgSensor(TimestampedModel):
    """The latest summary of one sensor on a linked device.

    What the device roll-up and the ``prtg`` check read: one row per sensor,
    rewritten by every status read. A sensor gone from PRTG is deleted - it is
    PRTG's object, not Danbyte's.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="prtg_sensors")
    connection = models.ForeignKey(
        PrtgConnection, on_delete=models.CASCADE, related_name="sensors"
    )
    link = models.ForeignKey(PrtgDeviceLink, on_delete=models.CASCADE, related_name="sensors")
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="prtg_sensors"
    )
    objid = models.CharField(max_length=16)
    name = models.CharField(max_length=255, blank=True, default="", db_default="")
    #: PRTG's raw type ("ping", "snmptraffic", "paessler.http.http_sensor.51").
    kind = models.CharField(max_length=128, blank=True, default="", db_default="")
    #: Its display name ("Ping v2").
    kind_label = models.CharField(max_length=128, blank=True, default="", db_default="")
    status_raw = models.SmallIntegerField(null=True, blank=True)
    #: ``status_raw`` through the connection's map.
    state = models.CharField(max_length=16, blank=True, default="", db_default="")
    message = models.TextField(blank=True, default="", db_default="")
    tags = models.JSONField(
        default=list, blank=True, db_default=models.Value([], models.JSONField()),
    )
    active = models.BooleanField(default=True, db_default=True)
    last_check_at = models.DateTimeField(null=True, blank=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "objid"], name="uniq_prtg_sensor_conn_objid"
            ),
        ]
        indexes = [
            models.Index(fields=["tenant", "device"], name="prtg_sensor_tenant_device"),
            models.Index(fields=["connection", "state"], name="prtg_sensor_conn_state"),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.objid})"


class PrtgChange(ExternalChangeBase):
    """One proposal waiting for a person. ``detail``, ``ignored`` and the
    propose / drop-stale behaviour come from the shared base.

    Every label names the system that changes.
    """

    #: Pair a Danbyte device with a PRTG device. Danbyte bookkeeping - nothing
    #: is written to PRTG.
    LINK = "link_device"
    AMBIGUOUS = ExternalChangeBase.AMBIGUOUS
    KIND_CHOICES = [
        (LINK, "Link in Danbyte"),
        (AMBIGUOUS, "Needs a decision"),
    ]

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="prtg_changes")
    connection = models.ForeignKey(
        PrtgConnection, on_delete=models.CASCADE, related_name="changes"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="prtg_changes",
    )
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    #: The PRTG object a proposal is about, or "" for a device-level one.
    key = models.CharField(max_length=64, blank=True, default="", db_default="")

    class Meta:
        ordering = ["kind", "-created_at"]
        constraints = [
            # Adoption rows (later) have no device; without nulls_distinct=False
            # Postgres would let their duplicates through.
            models.UniqueConstraint(
                fields=["connection", "device", "kind", "key"],
                name="uniq_prtg_change_conn_device_kind_key",
                nulls_distinct=False,
            )
        ]

    def __str__(self) -> str:
        return f"{self.kind} {self.device_id or ''}".strip()


class PrtgAdoptionRule(ExternalAdoptionRuleBase):
    """Where an adopted PRTG device lands, by its name, group, probe or
    address. Adoption itself reads these once it exists; ``pattern``,
    ``role``, ``device_type``, ``weight`` and ``enabled`` come from the
    shared base."""

    SCOPE_NAME, SCOPE_GROUP, SCOPE_PROBE, SCOPE_IP = "name", "group", "probe", "ip"
    SCOPE_CHOICES = [
        (SCOPE_NAME, "Device name"),
        (SCOPE_GROUP, "Group"),
        (SCOPE_PROBE, "Probe"),
        (SCOPE_IP, "Address"),
    ]

    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="prtg_adoption_rules"
    )
    connection = models.ForeignKey(
        PrtgConnection, on_delete=models.CASCADE, related_name="adoption_rules"
    )
    scope = models.CharField(
        max_length=8, choices=SCOPE_CHOICES, default=SCOPE_NAME, db_default=SCOPE_NAME
    )
    site = models.ForeignKey(
        "api.Site", on_delete=models.CASCADE, related_name="prtg_adoption_rules"
    )

    class Meta:
        ordering = ["weight", "pattern"]
        indexes = [
            models.Index(fields=["connection", "enabled"], name="prtg_adopt_conn_enabled"),
        ]

    def __str__(self) -> str:
        return f"{self.get_scope_display()} {self.pattern} -> {self.site_id}"
