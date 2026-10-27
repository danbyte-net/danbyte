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

    # ── registration (what PRTG should have) ───────────────────────────
    #: Register every device and VM of the tenant, less the usual exclusions
    #: (retired statuses, objects already linked, objects set to "Exclude
    #: from PRTG", primary addresses excluded from monitoring).
    register_all = models.BooleanField(default=False, db_default=False)
    #: What "register all" - and an object set to "Monitor in PRTG" that no
    #: policy matches - gets: a sensor profile and a PRTG group or probe.
    register_profile = models.ForeignKey(
        "prtg.PrtgSensorProfile", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    register_group_id = models.CharField(
        max_length=16, blank=True, default="", db_default=""
    )
    register_group_path = models.CharField(
        max_length=255, blank=True, default="", db_default=""
    )
    #: PRTG's groups and probes as the last read saw them: ``[{objid, name,
    #: kind, path, probe, parent_id}]``. What the group pickers offer and
    #: what the planning pass checks a target against.
    groups_cache = models.JSONField(
        default=list, blank=True, db_default=models.Value([], models.JSONField()),
    )
    groups_read_at = models.DateTimeField(null=True, blank=True)
    #: What PRTG offers to add by hand, read at most once a day:
    #: ``{"kinds": {"read_at", "rows"}, "templates": {"read_at", "rows"}}``
    #: (:mod:`prtg.manual`).
    sensor_catalog = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )
    #: The last planning pass and its counts.
    last_plan_at = models.DateTimeField(null=True, blank=True)
    last_plan_summary = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )

    # ── writing to PRTG ──────────────────────────────────────────────────
    #: An empty, paused PRTG device the operator made once, with one sensor
    #: of each kind Danbyte may need. Where PRTG cannot create objects
    #: through API v2, new devices and sensors are copies of it.
    seed_device_objid = models.CharField(
        max_length=16, blank=True, default="", db_default=""
    )
    #: Write the SNMP and Windows credentials Danbyte holds onto a device it
    #: creates in PRTG, as device properties with inheritance off.
    send_credentials = models.BooleanField(default=False, db_default=False)
    #: Give a device and the sensors Danbyte creates in PRTG the Danbyte
    #: object's own tags as PRTG tags, and keep them in step.
    send_tags = models.BooleanField(default=True, db_default=True)
    #: Also ``site-<slug>`` and ``role-<slug>`` when tags are sent.
    tag_site_role = models.BooleanField(default=False, db_default=False)
    #: Let the beat apply planned creates, sensors and moves itself.
    #: Removals always wait for a person.
    auto_apply_registration = models.BooleanField(default=False, db_default=False)
    #: Propose removing a PRTG device Danbyte created once its object no
    #: longer belongs in PRTG. Devices Danbyte did not create are never
    #: proposed.
    prune_devices = models.BooleanField(default=False, db_default=False)
    #: How this PRTG can be written: ``v2`` (API v2 creates objects),
    #: ``seed`` (copies of the seed device), ``none``, or "" before a check.
    WRITE_V2, WRITE_SEED, WRITE_NONE = "v2", "seed", "none"
    write_mode = models.CharField(max_length=8, blank=True, default="", db_default="")
    write_detail = models.CharField(max_length=255, blank=True, default="", db_default="")
    write_checked_at = models.DateTimeField(null=True, blank=True)
    #: The last apply of planned changes, by a person or the beat.
    last_apply_at = models.DateTimeField(null=True, blank=True)
    last_apply_summary = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )

    # ── two-way ─────────────────────────────────────────────────────────
    #: Acknowledgements travel both ways: acknowledging a Danbyte alert that a
    #: PRTG check raised acknowledges the Down sensors behind it in PRTG, and
    #: a sensor acknowledged in PRTG acknowledges the Danbyte alert. On by
    #: default: an acknowledgement is a note, not a change to what is
    #: monitored.
    write_acknowledgements = models.BooleanField(default=True, db_default=True)
    #: Pause each linked PRTG device for the length of a confirmed Danbyte
    #: maintenance or outage window that covers it. Off by default, like every
    #: write that changes what PRTG measures.
    sync_maintenance = models.BooleanField(default=False, db_default=False)
    last_maintenance_sync_at = models.DateTimeField(null=True, blank=True)

    # ── adoption and inventory ──────────────────────────────────────────
    #: Propose a Danbyte device for every PRTG device no Danbyte device or VM
    #: answers to. Off: reading a device list is one thing, minting inventory
    #: rows from it is another.
    adopt_devices = models.BooleanField(default=False, db_default=False)
    #: The last-resort placement for an adopted device; a rule, or a PRTG
    #: group named like a site, decides first.
    adopt_site = models.ForeignKey(
        "api.Site", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    adopt_role = models.ForeignKey(
        "api.DeviceRole", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    adopt_device_type = models.ForeignKey(
        "api.DeviceType", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    #: Read the system information PRTG holds for each linked device and
    #: offer its name and serial to the device's drift inbox.
    read_inventory = models.BooleanField(default=False, db_default=False)
    last_inventory_at = models.DateTimeField(null=True, blank=True)

    # ── what the last connection test learned ──────────────────────────
    version = models.CharField(max_length=32, blank=True, default="", db_default="")
    #: Whether API v2 answered the last probe. Null until a test has run.
    v2_available = models.BooleanField(null=True, blank=True)
    last_checked_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="", db_default="")
    #: Minutes the PRTG server's clock (as its API user sees it) is ahead of
    #: UTC, from ``getstatus.htm``'s ``Clock``. ``historicdata`` takes its
    #: window in that local time. Null until learned.
    server_utc_offset_minutes = models.SmallIntegerField(null=True, blank=True)

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

    def maintenance_due(self, now) -> bool:
        """Whether the maintenance reconcile should run: on the status
        cadence, so a window that opens is mirrored within one interval."""
        if not (self.enabled and self.sync_maintenance and self.api_key_set):
            return False
        if self.last_maintenance_sync_at is None:
            return True
        return now - self.last_maintenance_sync_at >= timedelta(
            seconds=max(self.status_interval_seconds, 60)
        )

    def auto_apply_due(self, now) -> bool:
        """Whether the beat should apply ready planned rows: auto apply is
        on and a planning pass has run since the last apply."""
        if not (self.enabled and self.auto_apply_registration and self.api_key_set):
            return False
        if self.last_plan_at is None:
            return False
        return self.last_apply_at is None or self.last_apply_at < self.last_plan_at

    #: How often the inventory pass runs. Each pass reads a batch of the
    #: links whose system information is oldest.
    INVENTORY_EVERY = timedelta(hours=1)

    def inventory_due(self, now) -> bool:
        if not (self.enabled and self.read_inventory and self.api_key_set):
            return False
        if self.last_inventory_at is None:
            return True
        return now - self.last_inventory_at >= self.INVENTORY_EVERY

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

    def sensor_url(self, objid) -> str:
        """The PRTG sensor page."""
        return f"{self.url.rstrip('/')}/sensor.htm?id={objid}"

    @property
    def cache_seconds(self) -> int:
        """How long a channel or history read is reused: one status
        interval, never under a minute."""
        return max(int(self.status_interval_seconds or 0), 60)


def _one_parent(name: str) -> models.CheckConstraint:
    """A row belongs to a device or to a virtual machine - exactly one."""
    return models.CheckConstraint(
        condition=(
            models.Q(device__isnull=False, virtual_machine__isnull=True)
            | models.Q(device__isnull=True, virtual_machine__isnull=False)
        ),
        name=name,
    )


class PrtgDeviceLink(ExternalLinkBase):
    """The pairing between a Danbyte device - or virtual machine - and a PRTG
    device.

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
        "api.Device", on_delete=models.CASCADE, related_name="prtg_links",
        null=True, blank=True,
    )
    #: The other kind of parent: a PRTG device that watches a VM.
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, related_name="prtg_links",
        null=True, blank=True,
    )
    #: PRTG object id, as a string like every remote id Danbyte keeps.
    objid = models.CharField(max_length=16)
    #: What PRTG called it at the last read - to notice a rename, not follow it.
    name = models.CharField(max_length=255, blank=True, default="", db_default="")
    #: PRTG's "IPv4 address/DNS name" field.
    host = models.CharField(max_length=255, blank=True, default="", db_default="")
    #: Which rule chose ``host`` when Danbyte created the device or last
    #: updated its host (:data:`prtg.provision.HOST_SOURCES`); "" otherwise.
    host_source = models.CharField(max_length=16, blank=True, default="", db_default="")
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
    #: The sensors Danbyte created on this device, by the ``danbyte-def-``
    #: tag that wanted them: ``{tag: {"objid", "name", "created_at"}}``.
    #: Kept after PRTG loses one, so one deleted by hand is proposed again;
    #: and the only sensors Danbyte will ever remove.
    created_sensors = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )
    #: The last write Danbyte made for this device: ``{at, kind, ok, detail,
    #: result}``.
    last_apply = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )
    #: The Danbyte tags last written onto the PRTG device - the only tags
    #: Danbyte adds or removes there; an operator's own tags stay.
    sent_tags = models.JSONField(
        default=list, blank=True, db_default=models.Value([], models.JSONField()),
    )
    #: A keyed hash of the credentials last written to the PRTG device -
    #: never the credentials.
    credentials_hash = models.CharField(
        max_length=64, blank=True, default="", db_default=""
    )
    status_read_at = models.DateTimeField(null=True, blank=True)

    # ── what the maintenance mirror did to the PRTG device ─────────────
    #: When Danbyte paused the PRTG device for a maintenance window, and the
    #: end it paused it until. Null when Danbyte has not paused it: a resume
    #: is only ever sent for a pause recorded here, so a device somebody
    #: paused by hand in PRTG is never resumed by Danbyte.
    maintenance_paused_at = models.DateTimeField(null=True, blank=True)
    maintenance_paused_until = models.DateTimeField(null=True, blank=True)
    #: ``[{"id", "name"}]`` of the Danbyte windows the pause covers.
    maintenance_events = models.JSONField(
        default=list, blank=True, db_default=models.Value([], models.JSONField()),
    )
    #: Why the last reconcile left the device alone, or what it could not do.
    maintenance_note = models.CharField(
        max_length=255, blank=True, default="", db_default=""
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "device"], name="uniq_prtg_link_conn_device"
            ),
            models.UniqueConstraint(
                fields=["connection", "objid"], name="uniq_prtg_link_conn_objid"
            ),
            models.UniqueConstraint(
                fields=["connection", "virtual_machine"], name="uniq_prtg_link_conn_vm"
            ),
            _one_parent("prtg_link_one_parent"),
        ]

    def __str__(self) -> str:
        return f"{self.device_id or self.virtual_machine_id} -> {self.objid}"

    @property
    def parent(self):
        """The device or VM this link is for."""
        return self.device if self.device_id else self.virtual_machine

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
        "api.Device", on_delete=models.CASCADE, related_name="prtg_sensors",
        null=True, blank=True,
    )
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, related_name="prtg_sensors",
        null=True, blank=True,
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

    # ── the primary value and the record, from the sensors table ──────
    #: The primary channel's value as PRTG formats it ("12 msec", "81 %").
    last_value = models.CharField(max_length=255, blank=True, default="", db_default="")
    last_value_raw = models.FloatField(null=True, blank=True)
    unit = models.CharField(max_length=32, blank=True, default="", db_default="")
    interval_seconds = models.PositiveIntegerField(null=True, blank=True)
    uptime_pct = models.FloatField(null=True, blank=True)
    downtime_pct = models.FloatField(null=True, blank=True)
    #: PRTG's 1-5 stars.
    priority = models.SmallIntegerField(null=True, blank=True)
    last_up_at = models.DateTimeField(null=True, blank=True)
    last_down_at = models.DateTimeField(null=True, blank=True)
    probe_name = models.CharField(max_length=255, blank=True, default="", db_default="")
    group_path = models.CharField(max_length=255, blank=True, default="", db_default="")

    # ── read on demand, for the sensor panel ──────────────────────────
    #: ``{fetched_at, summary, rows: [...]}`` - see :mod:`prtg.channels`.
    #: Empty until somebody opens the sensor; reused for one interval.
    channels = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )
    #: ``{range: {fetched_at, avg, series: {channel id: [{t, v}]}}}``.
    history = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )

    # ── what the sensor watches, resolved by every read (prtg.objects) ──
    #: The address PRTG reaches the device on: the link's host, matched to
    #: one of the device's or VM's addresses.
    ip_address = models.ForeignKey(
        "api.IPAddress", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="prtg_sensors",
    )
    #: The port an SNMP traffic sensor measures: a device interface or a VM
    #: interface, never both.
    interface = models.ForeignKey(
        "api.Interface", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="prtg_sensors",
    )
    vm_interface = models.ForeignKey(
        "api.VMInterface", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="prtg_sensors",
    )
    #: The service an HTTP or SSL sensor checks, by its port.
    service = models.ForeignKey(
        "api.Service", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="prtg_sensors",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "objid"], name="uniq_prtg_sensor_conn_objid"
            ),
            _one_parent("prtg_sensor_one_parent"),
            models.CheckConstraint(
                condition=models.Q(interface__isnull=True) | models.Q(vm_interface__isnull=True),
                name="prtg_sensor_one_interface",
            ),
        ]
        indexes = [
            models.Index(fields=["tenant", "device"], name="prtg_sensor_tenant_device"),
            models.Index(fields=["tenant", "virtual_machine"], name="prtg_sensor_tenant_vm"),
            models.Index(fields=["connection", "state"], name="prtg_sensor_conn_state"),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.objid})"

    @property
    def paused(self) -> bool:
        from .status import PAUSED

        return self.status_raw in PAUSED

    @property
    def acknowledged(self) -> bool:
        from .status import DOWN_ACKNOWLEDGED

        return self.status_raw == DOWN_ACKNOWLEDGED


class PrtgChange(ExternalChangeBase):
    """One proposal waiting for a person. ``detail``, ``ignored`` and the
    propose / drop-stale behaviour come from the shared base.

    Every label names the system that changes.
    """

    #: Pair a Danbyte device with a PRTG device. Danbyte bookkeeping - nothing
    #: is written to PRTG.
    LINK = "link_device"
    #: Make a Danbyte device for a PRTG device nothing answers to. Keyed by
    #: the PRTG object id; it has no device until it is applied.
    ADOPT = "adopt"
    AMBIGUOUS = ExternalChangeBase.AMBIGUOUS
    #: What the planning pass wants PRTG to have, written by
    #: :mod:`prtg.writer` when applied.
    CREATE_DEVICE = "create_device"
    ADD_SENSOR = "add_sensor"
    REMOVE_SENSOR = "remove_sensor"
    MOVE_DEVICE = "move_device"
    #: A device Danbyte created on a fallback host whose object now has a
    #: stronger one (a primary address set later).
    UPDATE_HOST = "update_host"
    #: A device Danbyte created whose object no longer belongs in PRTG.
    REMOVE_DEVICE = "remove_device"
    PLANNED = (CREATE_DEVICE, ADD_SENSOR, REMOVE_SENSOR, MOVE_DEVICE, UPDATE_HOST,
               REMOVE_DEVICE)
    #: Deletions: applied one at a time by a person, never by "apply all"
    #: or the beat.
    DESTRUCTIVE = (REMOVE_SENSOR, REMOVE_DEVICE)
    KIND_CHOICES = [
        (LINK, "Link in Danbyte"),
        (ADOPT, "Adopt into Danbyte"),
        (AMBIGUOUS, "Needs a decision"),
        (CREATE_DEVICE, "Create in PRTG"),
        (ADD_SENSOR, "Add sensor in PRTG"),
        (REMOVE_SENSOR, "Remove from PRTG"),
        (MOVE_DEVICE, "Move in PRTG"),
        (UPDATE_HOST, "Update host in PRTG"),
        (REMOVE_DEVICE, "Remove device from PRTG"),
    ]

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="prtg_changes")
    connection = models.ForeignKey(
        PrtgConnection, on_delete=models.CASCADE, related_name="changes"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="prtg_changes",
    )
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, null=True, blank=True,
        related_name="prtg_changes",
    )
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    #: The PRTG object a proposal is about, or "" for a device-level one.
    key = models.CharField(max_length=64, blank=True, default="", db_default="")

    class Meta:
        ordering = ["kind", "-created_at"]
        constraints = [
            # Adoption rows have no device; without nulls_distinct=False
            # Postgres would let their duplicates through.
            models.UniqueConstraint(
                fields=["connection", "device", "virtual_machine", "kind", "key"],
                name="uniq_prtg_change_conn_parent_kind_key",
                nulls_distinct=False,
            )
        ]

    def __str__(self) -> str:
        return f"{self.kind} {self.device_id or self.virtual_machine_id or ''}".strip()

    @classmethod
    def unattended_skip(cls) -> tuple:
        # "Apply all" and the beat never decide an ambiguity or delete
        # anything in PRTG: a removal is confirmed row by row.
        return (cls.AMBIGUOUS, *cls.DESTRUCTIVE)

    @property
    def planned(self) -> bool:
        return self.kind in self.PLANNED


class PrtgAdoptionRule(ExternalAdoptionRuleBase):
    """Where an adopted PRTG device lands, by its name, group, probe or
    address (:mod:`prtg.adopt`); ``pattern``,
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


class PrtgHostFacts(TimestampedModel):
    """What PRTG's system information says about a linked device or VM.

    Shaped like :class:`~monitoring.models.DeviceSnmp` - ``data``,
    ``interfaces``, ``polled_at``, ``reachable`` - so it reaches the drift
    inbox through :mod:`monitoring.observations` as source ``prtg``, below
    Danbyte's own poll. One row per link; never the source of truth: nothing
    here reaches a device until somebody accepts the drift item it raises.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="prtg_facts")
    connection = models.ForeignKey(
        PrtgConnection, on_delete=models.CASCADE, related_name="facts"
    )
    link = models.OneToOneField(
        PrtgDeviceLink, on_delete=models.CASCADE, related_name="facts"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="prtg_facts",
        null=True, blank=True,
    )
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, related_name="prtg_facts",
        null=True, blank=True,
    )
    #: Under the keys the drift engine reads - ``sys_name``, ``serial`` - plus
    #: ``vendor``, ``model`` and ``os`` for context, when PRTG has them.
    data = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )
    #: Interface presence is not read from PRTG. Empty means "not looked
    #: at", never "no interfaces".
    interfaces = models.JSONField(
        default=list, blank=True, db_default=models.Value([], models.JSONField()),
    )
    polled_at = models.DateTimeField(null=True, blank=True)
    #: False while the PRTG device is paused: what it said last is not an
    #: observation of now.
    reachable = models.BooleanField(null=True, blank=True)

    class Meta:
        ordering = ["-polled_at"]
        constraints = [_one_parent("prtg_facts_one_parent")]

    def __str__(self) -> str:
        return f"{self.device_id or self.virtual_machine_id} facts"


class PrtgSensorProfile(TimestampedModel):
    """A named list of sensors a device or VM should carry in PRTG.

    A policy names one; an object several policies match gets the union of
    their profiles' definitions. Nothing is seeded: the starter profile is a
    button that makes an ordinary, editable profile.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="prtg_sensor_profiles"
    )
    connection = models.ForeignKey(
        PrtgConnection, on_delete=models.CASCADE, related_name="sensor_profiles"
    )
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="", db_default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "name"], name="uniq_prtg_profile_conn_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class PrtgSensorDefinition(TimestampedModel):
    """One sensor a profile asks for: its kind, the kind's parameters, the
    scanning interval, the tags to set and whether its absence is drift.

    ``kind`` is one of Danbyte's kinds (:mod:`prtg.sensor_kinds`, its
    ``params`` typed there) or any PRTG kind id from the connection's
    sensor list, whose ``params`` are PRTG's create form as
    ``section.field`` keys, checked against PRTG's schema for the kind. A
    per-interface kind expands to one sensor per matching interface.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    profile = models.ForeignKey(
        PrtgSensorProfile, on_delete=models.CASCADE, related_name="definitions"
    )
    position = models.PositiveSmallIntegerField(default=0, db_default=0)
    kind = models.CharField(max_length=120)
    #: Blank names the sensor after its kind; ``{interface}`` is replaced by
    #: the interface name for a per-interface kind.
    name = models.CharField(max_length=120, blank=True, default="", db_default="")
    params = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, models.JSONField()),
    )
    #: Seconds between scans; null keeps what PRTG inherits.
    interval_seconds = models.PositiveIntegerField(null=True, blank=True)
    #: A required sensor a linked device lacks is proposed; an optional one
    #: is only part of what a new device gets.
    required = models.BooleanField(default=True, db_default=True)
    #: Tags to set on the sensor in PRTG, beside Danbyte's own.
    tags = models.JSONField(
        default=list, blank=True, db_default=models.Value([], models.JSONField()),
    )

    class Meta:
        ordering = ["profile", "position", "created_at"]

    def __str__(self) -> str:
        return f"{self.profile_id}:{self.kind}"

    @property
    def tenant_id(self):
        """The profile's tenant - what the change log files an edit under."""
        return self.profile.tenant_id if self.profile_id else None


class PrtgPolicy(TimestampedModel):
    """Which devices and VMs PRTG should have, with which sensors, where.

    The scope fields are named as on :class:`~monitoring.models.MonitoringPolicy`
    so the shared device matcher (:mod:`monitoring.external.policy`) answers
    for a device unchanged; ``location`` is PRTG's own addition. Policies
    stack: every matching policy adds its profile, and the matching policy
    with the lowest ``priority`` decides the PRTG group.
    """

    SCOPE_CHOICES = [
        ("global", "Every device and VM"),
        ("region", "Region"),
        ("site", "Site"),
        ("location", "Location"),
        ("platform", "Platform"),
        ("device_type", "Device type"),
        ("device_role", "Role"),
    ]
    #: The field each scope's target lives in.
    TARGET_FIELDS = {
        "region": "region", "site": "target_site", "location": "location",
        "platform": "platform", "device_type": "device_type",
        "device_role": "device_role",
    }

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="prtg_policies")
    connection = models.ForeignKey(
        PrtgConnection, on_delete=models.CASCADE, related_name="policies"
    )
    name = models.CharField(max_length=120)
    enabled = models.BooleanField(default=True, db_default=True)
    #: Lower first. The first matching policy decides the group.
    priority = models.PositiveSmallIntegerField(default=100, db_default=100)
    scope = models.CharField(
        max_length=16, choices=SCOPE_CHOICES, default="global", db_default="global"
    )
    region = models.ForeignKey(
        "api.Region", on_delete=models.CASCADE, null=True, blank=True, related_name="+"
    )
    target_site = models.ForeignKey(
        "api.Site", on_delete=models.CASCADE, null=True, blank=True, related_name="+"
    )
    location = models.ForeignKey(
        "api.Location", on_delete=models.CASCADE, null=True, blank=True, related_name="+"
    )
    platform = models.ForeignKey(
        "api.Platform", on_delete=models.CASCADE, null=True, blank=True, related_name="+"
    )
    device_type = models.ForeignKey(
        "api.DeviceType", on_delete=models.CASCADE, null=True, blank=True, related_name="+"
    )
    device_role = models.ForeignKey(
        "api.DeviceRole", on_delete=models.CASCADE, null=True, blank=True, related_name="+"
    )
    #: Filters, as on a monitoring policy: they narrow, never widen.
    match_tags = models.JSONField(
        default=list, blank=True, db_default=models.Value([], models.JSONField()),
    )
    match_name = models.CharField(max_length=255, blank=True, default="", db_default="")
    match_hardware = models.CharField(
        max_length=255, blank=True, default="", db_default=""
    )
    applies_to_devices = models.BooleanField(default=True, db_default=True)
    applies_to_vms = models.BooleanField(default=True, db_default=True)
    profile = models.ForeignKey(
        PrtgSensorProfile, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="policies",
    )
    #: The PRTG group or probe new devices go under, by object id, and its
    #: path when it was picked - for reading, and for naming a group that
    #: has gone.
    group_id = models.CharField(max_length=16, blank=True, default="", db_default="")
    group_path = models.CharField(max_length=255, blank=True, default="", db_default="")

    class Meta:
        ordering = ["priority", "name"]
        indexes = [
            models.Index(fields=["connection", "enabled"], name="prtg_policy_conn_enabled"),
        ]

    def __str__(self) -> str:
        return self.name
