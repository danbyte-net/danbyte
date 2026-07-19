"""Monitoring / check-engine data model.

A configurable, multi-protocol status/health-check engine for IPs and prefixes.
Users define reusable ``CheckTemplate`` rows, attach them to a target (an
``IPAddress`` or a ``Prefix``) via ``CheckAssignment``, and a scheduler runs
them as background jobs, recording ``CheckResult`` time-series, rolling the
current status up into ``CheckState``, and logging every change as a
``StateTransition``.

Design notes:

* **PK choice.** Config + roll-up rows (``CheckTemplate``, ``CheckAssignment``,
  ``CheckState``) keep the project-wide UUID convention. The two append-only,
  high-volume tables (``CheckResult``, ``StateTransition``) use ``BigAutoField``
  — they are written far more than they are referenced by id, a monotonic
  integer indexes better, and a time-range partition plan (see
  ``CheckResult.Meta``) is cleaner on an integer PK.
* **Target binding.** A check targets exactly one of {IPAddress, Prefix},
  modelled as two nullable FKs guarded by a ``CheckConstraint`` — the same
  "exactly one of N nullable FKs" pattern ``CableTermination`` already uses,
  preferred over a generic ``content_type`` so the FKs cascade and filter
  natively.
* **Secrets.** Public, inspectable config lives in ``params`` (JSONB). SNMP/SSH/
  Telnet credentials live in ``secret_params`` (``EncryptedJSONField``) and are
  never serialised back out of the API.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone

from core.models import (
    CustomFieldsMixin,
    TaggableMixin,
    Tenant,
    TimestampedModel,
)

from .secrets import EncryptedJSONField


# ─── Choices ──────────────────────────────────────────────────────────────


class CheckKind(models.TextChoices):
    ICMP = "icmp", "ICMP (ping)"
    TCP = "tcp", "TCP port"
    UDP = "udp", "UDP port"
    HTTP = "http", "HTTP(S)"
    SNMP = "snmp", "SNMP"
    SSH = "ssh", "SSH"
    TELNET = "telnet", "Telnet"
    EXEC = "exec", "Script / exec"


class CheckStatus(models.TextChoices):
    UP = "up", "Up"
    DOWN = "down", "Down"
    DEGRADED = "degraded", "Degraded"
    UNKNOWN = "unknown", "Unknown"
    STALE = "stale", "Stale"
    SKIPPED = "skipped", "Skipped"


class ScheduleMode(models.TextChoices):
    FOLLOW_GLOBAL = "follow_global", "Follow global schedule"
    CUSTOM_ON = "custom_on", "Custom — always on"
    CUSTOM_OFF = "custom_off", "Custom — off"


# Named intervals mirror a common ping-monitor default. ``interval_seconds``
# on the template is the source of truth; this map powers a friendly picker and
# round-trips a chosen seconds value back to its label when one matches.
NAMED_INTERVALS: list[tuple[str, int]] = [
    ("5m", 300),
    ("15m", 900),
    ("30m", 1800),
    ("hourly", 3600),
    ("6h", 21600),
    ("12h", 43200),
    ("daily", 86400),
    ("weekly", 604800),
]


# ─── Templates & assignments ──────────────────────────────────────────────


class CheckTemplate(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A reusable check definition: what to run and how to judge the result.

    ``params`` holds kind-specific, non-secret config (port, oid, http path,
    expected status set, latency/degraded thresholds, …) validated per-kind by
    the checker's ``validate_params``. Credentials go in ``secret_params``,
    which is encrypted at rest and write-only over the API.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="check_templates"
    )
    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=120)
    kind = models.CharField(max_length=8, choices=CheckKind.choices)

    params = models.JSONField(
        default=dict,
        blank=True,
        help_text="Kind-specific, non-secret config (port, oid, path, "
        "expected_status, thresholds…). Validated per-kind.",
    )
    secret_params = EncryptedJSONField(
        help_text="Credentials (SNMP/SSH/Telnet). Encrypted at rest; never "
        "returned by the API.",
    )

    interval_seconds = models.PositiveIntegerField(
        default=300, help_text="How often the check runs, in seconds."
    )
    timeout_ms = models.PositiveIntegerField(
        default=2000, help_text="Per-attempt timeout in milliseconds."
    )
    retries = models.PositiveSmallIntegerField(
        default=0,
        help_text="Immediate retries on a failed attempt before recording a "
        "failure for this run.",
    )
    rise = models.PositiveSmallIntegerField(
        default=1, help_text="Consecutive successes required to transition to UP."
    )
    fall = models.PositiveSmallIntegerField(
        default=3, help_text="Consecutive failures required to transition to DOWN."
    )
    degraded_enabled = models.BooleanField(
        default=False,
        help_text="Evaluate the kind's degraded criteria (latency threshold, "
        "value mismatch, unexpected HTTP code) when reachable.",
    )
    enabled = models.BooleanField(default=True)

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_check_templates",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_checktemplate_tenant_slug"
            )
        ]
        indexes = [models.Index(fields=["tenant", "kind"])]

    def __str__(self) -> str:
        return f"{self.name} ({self.kind})"


class CheckAssignment(TimestampedModel):
    """Binds a ``CheckTemplate`` to one target — an IP or a prefix.

    Prefix assignments inherit down the prefix-containment tree to child IPs
    (``apply_to_children``), minus any IPs in ``exclusions``. A per-IP
    assignment overrides an inherited one of the same template, and an IP
    assignment with ``enabled=False`` disables an inherited check. See
    ``monitoring.resolver.resolve_effective_checks``.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="check_assignments"
    )
    template = models.ForeignKey(
        CheckTemplate, on_delete=models.CASCADE, related_name="assignments"
    )

    ip_address = models.ForeignKey(
        "api.IPAddress",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="check_assignments",
    )
    prefix = models.ForeignKey(
        "api.Prefix",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="check_assignments",
    )
    service = models.ForeignKey(
        "api.Service",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="check_assignments",
        help_text="Set when this assignment was spawned by a monitored Service, "
        "so it can be reconciled/torn down with the service. NULL = a manual "
        "assignment, never auto-removed.",
    )

    schedule_mode = models.CharField(
        max_length=16,
        choices=ScheduleMode.choices,
        default=ScheduleMode.FOLLOW_GLOBAL,
    )
    overrides = models.JSONField(
        default=dict,
        blank=True,
        help_text="Per-assignment overrides of the template — recognised keys: "
        "interval_seconds, timeout_ms, rise, fall, params (shallow-merged).",
    )
    enabled = models.BooleanField(default=True)

    apply_to_children = models.BooleanField(
        default=True,
        help_text="Prefix assignments only: also apply to child IPs in the "
        "prefix's containment tree.",
    )
    exclusions = models.ManyToManyField(
        "api.IPAddress",
        blank=True,
        related_name="check_assignment_exclusions",
        help_text="Child IPs to skip for a prefix assignment.",
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_check_assignments",
    )

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                name="checkassignment_exactly_one_target",
                condition=(
                    models.Q(ip_address__isnull=False, prefix__isnull=True)
                    | models.Q(ip_address__isnull=True, prefix__isnull=False)
                ),
            ),
            models.UniqueConstraint(
                fields=["template", "ip_address"],
                name="uniq_assignment_template_ip",
                condition=models.Q(ip_address__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["template", "prefix"],
                name="uniq_assignment_template_prefix",
                condition=models.Q(prefix__isnull=False),
            ),
        ]
        indexes = [
            models.Index(fields=["tenant"]),
            models.Index(fields=["ip_address"]),
            models.Index(fields=["prefix"]),
        ]

    def __str__(self) -> str:
        target = self.ip_address_id or self.prefix_id
        return f"{self.template_id} → {target}"


class MonitoringProfile(TimestampedModel):
    """Named bundle of check templates used by monitoring policies."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="monitoring_profiles"
    )
    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=120)
    description = models.TextField(blank=True)
    templates = models.ManyToManyField(
        CheckTemplate, blank=True, related_name="monitoring_profiles"
    )
    enabled = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_monitoringprofile_tenant_slug"
            ),
        ]

    def __str__(self) -> str:
        return self.name


class MonitoringPolicy(TimestampedModel):
    """Inherited monitoring configuration for global, VRF, type/role, device,
    and prefix scopes. Existing explicit CheckAssignment rows still win."""

    SCOPE_GLOBAL = "global"
    SCOPE_VRF = "vrf"
    SCOPE_DEVICE_TYPE = "device_type"
    SCOPE_DEVICE_ROLE = "device_role"
    SCOPE_DEVICE = "device"
    SCOPE_PREFIX = "prefix"
    SCOPE_CHOICES = [
        (SCOPE_GLOBAL, "Global"),
        (SCOPE_VRF, "VRF"),
        (SCOPE_DEVICE_TYPE, "Device type"),
        (SCOPE_DEVICE_ROLE, "Device role"),
        (SCOPE_DEVICE, "Device"),
        (SCOPE_PREFIX, "Prefix"),
    ]

    # Which of a device's IPs a device/type/role policy applies to. Ignored for
    # global/vrf/prefix scopes (those already target every IP in their scope).
    TARGET_ALL = "all"
    TARGET_INTERFACES = "interfaces"
    TARGET_PRIMARY = "primary"
    TARGET_OOB = "oob"
    TARGET_CHOICES = [
        (TARGET_ALL, "All IPs"),
        (TARGET_INTERFACES, "Interface IPs"),
        (TARGET_PRIMARY, "Primary IP"),
        (TARGET_OOB, "OOB / management IP"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="monitoring_policies"
    )
    scope = models.CharField(max_length=24, choices=SCOPE_CHOICES)
    vrf = models.ForeignKey(
        "api.VRF", on_delete=models.CASCADE, null=True, blank=True,
        related_name="monitoring_policies",
    )
    device_type = models.ForeignKey(
        "api.DeviceType", on_delete=models.CASCADE, null=True, blank=True,
        related_name="monitoring_policies",
    )
    device_role = models.ForeignKey(
        "api.DeviceRole", on_delete=models.CASCADE, null=True, blank=True,
        related_name="monitoring_policies",
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="monitoring_policies",
    )
    prefix = models.ForeignKey(
        "api.Prefix", on_delete=models.CASCADE, null=True, blank=True,
        related_name="monitoring_policies",
    )
    enabled = models.BooleanField(default=True)
    inherit = models.BooleanField(default=True)
    target = models.CharField(
        max_length=16,
        choices=TARGET_CHOICES,
        default=TARGET_ALL,
        help_text="For device/type/role scopes: which of the device's IPs the "
        "policy's checks run against. Ignored for global/vrf/prefix scopes.",
    )
    interval_seconds = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="Per-scope check frequency override, in seconds. Null = use "
        "the tenant's global default interval. The most-specific policy that "
        "sets it wins (a prefix beats the VRF beats global).",
    )
    profiles = models.ManyToManyField(
        MonitoringProfile, blank=True, related_name="policies"
    )
    templates = models.ManyToManyField(
        CheckTemplate, blank=True, related_name="monitoring_policies"
    )

    class Meta:
        ordering = ["scope", "created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "scope", "vrf"],
                name="uniq_monitoringpolicy_vrf",
                condition=models.Q(vrf__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["tenant", "scope", "device_type"],
                name="uniq_monitoringpolicy_device_type",
                condition=models.Q(device_type__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["tenant", "scope", "device_role"],
                name="uniq_monitoringpolicy_device_role",
                condition=models.Q(device_role__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["tenant", "scope", "device"],
                name="uniq_monitoringpolicy_device",
                condition=models.Q(device__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["tenant", "scope", "prefix"],
                name="uniq_monitoringpolicy_prefix",
                condition=models.Q(prefix__isnull=False),
            ),
        ]

    def __str__(self) -> str:
        return f"{self.scope} policy"


class MonitoringDenySubnet(TimestampedModel):
    """VRF-scoped CIDR block excluded from monitoring policy materialisation and
    discovery surfaces."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="monitoring_deny_subnets"
    )
    vrf = models.ForeignKey(
        "api.VRF", on_delete=models.CASCADE, null=True, blank=True,
        related_name="monitoring_deny_subnets",
    )
    cidr = models.CharField(max_length=64)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["cidr"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "vrf", "cidr"], name="uniq_monitoringdeny_vrf_cidr"
            ),
        ]

    def clean(self):
        import ipaddress

        ipaddress.ip_network(self.cidr, strict=False)

    def __str__(self) -> str:
        return self.cidr

    @property
    def target_kind(self) -> str:
        return "ip" if self.ip_address_id else "prefix"


# ─── Time-series + roll-up ────────────────────────────────────────────────


class CheckResult(models.Model):
    """One executed check attempt — append-only time-series.

    High write volume: indexed on ``(target_ip, timestamp)`` for the per-target
    history queries and sparklines. A native PostgreSQL RANGE partition by
    ``timestamp`` (monthly) is the planned scaling step; the retention/pruning
    job (milestone 5) deletes or downsamples old rows.
    """

    id = models.BigAutoField(primary_key=True)
    # db_index=False on tenant/target_ip: both are covered as prefixes of the
    # composite Meta indexes below — the auto FK btrees were pure write
    # amplification on a ~600k-inserts/day table and were never scanned.
    tenant = models.ForeignKey(
        Tenant,
        on_delete=models.CASCADE,
        related_name="check_results",
        db_index=False,
    )
    target_ip = models.ForeignKey(
        "api.IPAddress",
        on_delete=models.CASCADE,
        related_name="check_results",
        db_index=False,
    )
    template = models.ForeignKey(
        CheckTemplate,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="results",
    )
    assignment = models.ForeignKey(
        CheckAssignment,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="results",
    )
    kind = models.CharField(max_length=8, choices=CheckKind.choices)

    timestamp = models.DateTimeField(default=timezone.now, db_index=True)
    status = models.CharField(max_length=8, choices=CheckStatus.choices)
    latency_ms = models.FloatField(null=True, blank=True)
    detail = models.JSONField(
        default=dict,
        blank=True,
        help_text="Protocol-specific payload (rtt, snmp oid/value, http code, "
        "banner, error string).",
    )

    class Meta:
        ordering = ["-timestamp"]
        # Deliberately minimal for a high-write table (issue #155):
        # (target_ip, -timestamp) serves the history endpoint directly and the
        # sparkline query via its prefix (template is a cheap post-filter over
        # the handful of interleaved templates per IP); (tenant, -timestamp)
        # serves the dashboard hourly buckets and the tenant-cascade delete.
        # The former (target_ip, template, -timestamp) index cost 1GB at 10M
        # rows and had never been scanned.
        indexes = [
            models.Index(fields=["target_ip", "-timestamp"]),
            models.Index(fields=["tenant", "-timestamp"]),
        ]

    def __str__(self) -> str:
        return f"{self.target_ip_id} {self.kind} {self.status} @ {self.timestamp:%Y-%m-%d %H:%M}"


class CheckState(TimestampedModel):
    """Current rolled-up status for one (target IP, template) pair.

    Denormalised so sortable status columns and detail badges never scan the
    history table. Also carries the scheduler bookkeeping (``next_run`` /
    ``in_flight``) used by the dispatcher to pick due checks without re-walking
    the prefix tree every tick.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="check_states"
    )
    target_ip = models.ForeignKey(
        "api.IPAddress", on_delete=models.CASCADE, related_name="check_states"
    )
    template = models.ForeignKey(
        CheckTemplate, on_delete=models.CASCADE, related_name="states"
    )
    assignment = models.ForeignKey(
        CheckAssignment,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="states",
        help_text="The assignment that produced this effective check (may be "
        "inherited from a prefix).",
    )
    engine = models.ForeignKey(
        "MonitoringEngine",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="check_states",
        help_text="Which engine runs this check — resolved from the target's "
        "site/location at materialise time (null = the tenant's local engine).",
    )
    kind = models.CharField(max_length=8, choices=CheckKind.choices)

    interval_seconds = models.PositiveIntegerField(
        null=True,
        blank=True,
        help_text="Resolved per-target frequency override for policy-sourced "
        "checks (from the most-specific MonitoringPolicy that sets one). Null "
        "= use the tenant's global default. Assignment-sourced checks ignore "
        "this and follow their own schedule.",
    )

    status = models.CharField(
        max_length=8, choices=CheckStatus.choices, default=CheckStatus.UNKNOWN
    )
    since = models.DateTimeField(
        null=True, blank=True, help_text="When the current status began."
    )
    last_checked = models.DateTimeField(null=True, blank=True)
    last_latency_ms = models.FloatField(null=True, blank=True)
    consecutive_success = models.PositiveIntegerField(default=0)
    consecutive_fail = models.PositiveIntegerField(default=0)

    next_run = models.DateTimeField(
        null=True, blank=True, db_index=True, help_text="Dispatcher: due when <= now."
    )
    in_flight = models.BooleanField(
        default=False, help_text="Dispatcher: a run is currently enqueued/executing."
    )
    in_flight_since = models.DateTimeField(
        null=True,
        blank=True,
        help_text="When the current run was claimed. Lets the reaper reclaim "
        "states orphaned by a dead/restarted worker.",
    )

    class Meta:
        ordering = ["target_ip", "kind"]
        constraints = [
            models.UniqueConstraint(
                fields=["target_ip", "template"], name="uniq_checkstate_target_template"
            )
        ]
        indexes = [
            models.Index(fields=["tenant", "status"]),
            models.Index(fields=["next_run", "in_flight"]),
        ]

    def __str__(self) -> str:
        return f"{self.target_ip_id} {self.kind} = {self.status}"


class MonitoringSettings(TimestampedModel):
    """Per-tenant monitoring defaults and policy.

    One row per tenant (``for_tenant`` get-or-creates it). Holds the global
    schedule switch, the default interval new checks inherit, the **stale**
    thresholds (how long an IP stays down before it's flagged chronic), and the
    **skip** policy (IPs whose status is in ``skip_ip_statuses`` are not checked
    — e.g. *reserved* addresses).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.OneToOneField(
        Tenant, on_delete=models.CASCADE, related_name="monitoring_settings"
    )

    global_enabled = models.BooleanField(
        default=True,
        help_text="Master switch that 'follow global' assignments obey.",
    )
    default_interval_seconds = models.PositiveIntegerField(
        default=300, help_text="Interval new checks inherit by default."
    )

    stale_after_scans = models.PositiveSmallIntegerField(
        default=10,
        help_text="Consecutive failed checks before a down IP is marked stale "
        "(0 = never by scan count).",
    )
    stale_after_days = models.PositiveSmallIntegerField(
        default=0,
        help_text="Days continuously down before a down IP is marked stale "
        "(0 = never by time).",
    )

    skip_ip_statuses = models.ManyToManyField(
        "api.Status",
        blank=True,
        related_name="monitoring_skip_settings",
        help_text="IPs whose status is one of these are skipped (not checked).",
    )

    # Reverse-DNS enrichment: resolve each monitored IP's PTR and write it to
    # IPAddress.dns_name.
    dns_sync_enabled = models.BooleanField(
        default=False,
        help_text="Resolve reverse DNS (PTR) for monitored IPs and store it as "
        "the IP's dns_name.",
    )
    dns_clear_on_missing = models.BooleanField(
        default=False,
        help_text="Clear dns_name when the PTR lookup returns nothing.",
    )
    dns_preserve_if_alive = models.BooleanField(
        default=True,
        help_text="Keep the existing dns_name on a failed lookup if the IP is "
        "currently up (transient DNS blip vs. a real removal).",
    )

    # ─── alerting policy (A5) ────────────────────────────────────────────
    # Re-page still-firing alerts that nobody has acked/silenced/resolved.
    renotify_enabled = models.BooleanField(
        default=False,
        help_text="Re-send a reminder for alerts still firing and unacknowledged.",
    )
    renotify_interval_minutes = models.PositiveIntegerField(
        default=60, help_text="Minutes between renotifications of a firing alert."
    )
    # Escalate an alert left firing + unacked too long (bumps it to critical).
    escalate_enabled = models.BooleanField(default=False)
    escalate_after_minutes = models.PositiveIntegerField(
        default=120,
        help_text="Minutes a firing, unacked alert waits before escalating to critical.",
    )
    # Flap dampening: an alert whose condition opens repeatedly in a short window
    # is marked flapping and excluded from renotify until it settles.
    flap_threshold = models.PositiveSmallIntegerField(
        default=5,
        help_text="Opens within the flap window before an alert is marked flapping "
        "(0 = disable flap detection).",
    )
    flap_window_minutes = models.PositiveIntegerField(
        default=30, help_text="Window for counting flaps."
    )
    # Grouping: when one batch opens many alerts (e.g. a switch dies), send one
    # digest per channel instead of a storm of individual messages.
    group_notifications = models.BooleanField(
        default=True,
        help_text="Coalesce a burst of new alerts into one grouped notification.",
    )
    group_threshold = models.PositiveSmallIntegerField(
        default=3,
        help_text="New alerts in one scan batch before they're grouped into a digest.",
    )

    # ─── discovery (M12) ─────────────────────────────────────────────────
    # Opt-in subnet discovery: periodically ICMP-sweep prefixes flagged
    # ``auto_discover`` and create IPs for responders not yet recorded.
    discovery_enabled = models.BooleanField(
        default=False,
        help_text="Master switch for periodic subnet discovery (per-prefix opt-in).",
    )
    discovery_min_prefix_length = models.PositiveSmallIntegerField(
        default=22,
        help_text="Smallest prefix length (largest subnet) discovery will sweep. "
        "22 = up to /22 (~1k hosts); guards against scanning huge ranges.",
    )
    discovery_interval_minutes = models.PositiveIntegerField(
        default=30,
        help_text="How often each auto-discover prefix is re-swept, in minutes.",
    )
    discovery_all_prefixes = models.BooleanField(
        default=False,
        help_text="Auto-discover every prefix by default (no per-prefix opt-in "
        "needed). Per-prefix auto_discover still enrols a subnet + its children.",
    )

    # ─── stale auto-cleanup (M13) ────────────────────────────────────────
    # Opt-in: delete *discovered* IPs that have been unreachable for longer
    # than the threshold. Never touches user-created IPs.
    cleanup_enabled = models.BooleanField(
        default=False,
        help_text="Delete discovered IPs unreachable for longer than the grace period.",
    )
    cleanup_after_days = models.PositiveSmallIntegerField(
        default=30,
        help_text="Days a discovered IP must be unseen before cleanup removes it.",
    )

    # ─── flapping monitor (M22) ──────────────────────────────────────────
    # IPs with one of these statuses are excluded from the "flapping a lot"
    # surface — e.g. a DHCP-scope status where churn is expected and noisy.
    flap_exclude_ip_statuses = models.ManyToManyField(
        "api.Status",
        blank=True,
        related_name="monitoring_flap_exclude_settings",
        help_text="IPs with these statuses are never flagged as flapping "
        "(e.g. DHCP scopes).",
    )

    # ─── distributed engines ─────────────────────────────────────────────
    # Tenant-wide default engine — used when a target's site/location doesn't
    # pin one. Null falls back to the tenant's built-in local engine.
    default_engine = models.ForeignKey(
        "MonitoringEngine",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="default_for_settings",
        help_text="Default monitoring engine for targets with no site/location "
        "engine assigned (null = the local built-in engine).",
    )
    # The Outpost agent's git repo — set once, then pick versions from a dropdown
    # in the package store (Danbyte fetches the CI-built binary of a release).
    outpost_repo_url = models.CharField(
        max_length=512, blank=True,
        help_text="GitHub repo of the Outpost agent, e.g. "
        "https://github.com/danbyte-net/danbyte-outpost.",
    )
    outpost_repo_token = EncryptedJSONField(
        help_text="Optional GitHub token for a private Outpost repo; {} if none.",
    )

    class Meta:
        verbose_name = "Monitoring settings"
        verbose_name_plural = "Monitoring settings"

    def __str__(self) -> str:
        return f"Monitoring settings for {self.tenant_id}"

    @classmethod
    def for_tenant(cls, tenant) -> "MonitoringSettings":
        obj, _ = cls.objects.get_or_create(tenant=tenant)
        return obj


class MonitoringEngine(TimestampedModel):
    """Where checks for a scope actually run.

    * ``local`` — the core server's RQ workers. One built-in, un-deletable row
      per tenant (``local_for``). Unassigned targets resolve here, so nothing
      changes for deployments that never install an Outpost.
    * ``remote`` — a **Danbyte Outpost**: an agent installed at a site that has
      no direct path to the core. It runs the same check code as the core and
      exchanges work/results over one of two **transports** (per engine):

        - ``pull`` — the Outpost dials **out** to Danbyte over HTTPS (443) and
          pulls work / pushes results, authenticating with ``token``. For NAT'd
          sites that can reach out but can't be reached in.
        - ``ssh`` — Danbyte dials **out** to the Outpost over SSH (22) and drives
          it, for locked-down sites where only ``Danbyte → host`` is permitted.
          (SSH connection fields + driver land in Phase 1.)

    Assigned to a Site/Location (their ``monitoring_engine`` FK) or set as the
    tenant default (``MonitoringSettings.default_engine``); resolution order lives
    in ``monitoring/engines.py``.
    """

    LOCAL = "local"
    REMOTE = "remote"
    KIND_CHOICES = [(LOCAL, "Local (built-in)"), (REMOTE, "Outpost")]

    PULL = "pull"
    SSH = "ssh"
    TRANSPORT_CHOICES = [
        (PULL, "Outpost dials out (HTTPS 443)"),
        (SSH, "Danbyte dials in (SSH 22)"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="monitoring_engines"
    )
    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=120)
    # How the core and this Outpost exchange work/results (see class docstring).
    transport = models.CharField(
        max_length=8, choices=TRANSPORT_CHOICES, default=PULL
    )
    description = models.TextField(blank=True)
    kind = models.CharField(max_length=6, choices=KIND_CHOICES, default=REMOTE)
    enabled = models.BooleanField(default=True)
    # Bearer secret the Outpost authenticates with, stored as {"secret": …}.
    # Write-only — the API exposes only whether it's set, never the value.
    token = EncryptedJSONField(
        help_text="Outpost auth token (remote engines); {} until enrolled."
    )
    poll_interval_seconds = models.PositiveIntegerField(
        default=15, help_text="How often the Outpost polls the core for work."
    )
    # When on, the agent self-updates to the default ("golden") release whenever
    # its version differs — pull-transport binary Outposts only.
    auto_update = models.BooleanField(default=False)
    # Set by the "Discover now" button so this Outpost sweeps its due prefixes on
    # its *next* poll instead of waiting for the periodic cycle; cleared when it
    # pulls sweep-work.
    sweep_requested_at = models.DateTimeField(null=True, blank=True)
    # SSH-transport connection — how Danbyte dials *in* to the Outpost host.
    ssh_host = models.CharField(max_length=255, blank=True)
    ssh_port = models.PositiveIntegerField(default=22)
    ssh_user = models.CharField(max_length=64, blank=True)
    # Encrypted at rest, never serialised out. {"private_key": …} or
    # {"password": …} — how Danbyte authenticates to the host.
    ssh_credential = EncryptedJSONField(
        help_text="SSH key/password for the SSH transport; {} until set."
    )
    # The host's expected public key ("ssh-ed25519 AAAA…"), pinned so Danbyte
    # verifies the server it connects to. Blank = trust-on-first-use (a warning
    # is logged). Not secret — it's the host's public key.
    ssh_host_key = models.TextField(blank=True)
    # Heartbeat / agent facts — updated each time the Outpost checks in.
    last_seen_at = models.DateTimeField(null=True, blank=True)
    # Set by the dispatcher's health sweep when a remote engine with assigned
    # checks goes unreachable (no poll within ~3× its interval); cleared on
    # recovery. Null = healthy. Drives the UI banner + channel notifications.
    stale_since = models.DateTimeField(null=True, blank=True)
    agent_version = models.CharField(max_length=40, blank=True)
    agent_hostname = models.CharField(max_length=255, blank=True)
    agent_ip = models.CharField(max_length=45, blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"],
                name="uniq_monitoringengine_tenant_slug",
            ),
            # Exactly one built-in local engine per tenant.
            models.UniqueConstraint(
                fields=["tenant"],
                condition=models.Q(kind="local"),
                name="uniq_local_engine_per_tenant",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.kind})"

    @property
    def is_local(self) -> bool:
        return self.kind == self.LOCAL

    @property
    def token_set(self) -> bool:
        return bool((self.token or {}).get("secret"))

    @property
    def ssh_configured(self) -> bool:
        cred = self.ssh_credential or {}
        return bool(self.ssh_host and self.ssh_user and (cred.get("private_key") or cred.get("password")))

    @classmethod
    def local_for(cls, tenant) -> "MonitoringEngine":
        """The tenant's built-in local engine — created on first access."""
        obj, _ = cls.objects.get_or_create(
            tenant=tenant,
            kind=cls.LOCAL,
            defaults={"name": "Local (built-in)", "slug": "local"},
        )
        return obj


class MonitoringEngineBinding(TimestampedModel):
    """Assigns a monitoring engine to a Site or Location.

    Kept on the monitoring side (referencing api ids by ``object_id``) so the
    ``api`` app never depends on ``monitoring`` — the same pattern as
    ``SnmpProfileBinding``. One engine per (tenant, scope, object). Location
    beats Site when both are set (see ``monitoring/engines.py``).
    """

    SCOPE_SITE = "site"
    SCOPE_LOCATION = "location"
    SCOPE_PREFIX = "prefix"
    SCOPE_CHOICES = [
        (SCOPE_SITE, "Site"),
        (SCOPE_LOCATION, "Location"),
        (SCOPE_PREFIX, "Prefix"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="engine_bindings"
    )
    engine = models.ForeignKey(
        MonitoringEngine, on_delete=models.CASCADE, related_name="bindings"
    )
    scope = models.CharField(max_length=16, choices=SCOPE_CHOICES)
    object_id = models.UUIDField(help_text="id of the site / location.")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "scope", "object_id"],
                name="uniq_enginebinding_scope_object",
            ),
        ]
        indexes = [models.Index(fields=["tenant", "scope", "object_id"])]

    def __str__(self) -> str:
        return f"{self.engine.name} → {self.scope}:{self.object_id}"


class OutpostRelease(TimestampedModel):
    """A named Outpost build the Danbyte instance stores + serves.

    Deployment-wide (not tenant-scoped) — it's software, not tenant data, and is
    managed by deployment admins. Two sources:

    * ``file`` — an uploaded build (binary / tarball) served straight from
      Danbyte, so **airgapped** hosts that can only reach Danbyte can still
      install it.
    * ``git`` — a git URL + ref; the generated installer does a source install
      (``pip install git+url@ref``), for hosts with internet access.

    An Outpost is installed with the one-liner Danbyte generates for a chosen
    version (``/outpost/install.sh?v=…``), so versions can be pinned per site and
    rolled out centrally.
    """

    FILE = "file"
    GIT = "git"
    SOURCE_CHOICES = [(FILE, "Uploaded file"), (GIT, "Git repository")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    version = models.CharField(max_length=64, unique=True)
    source = models.CharField(max_length=4, choices=SOURCE_CHOICES, default=FILE)
    artifact = models.FileField(upload_to="outpost-releases/", blank=True)
    git_url = models.CharField(max_length=512, blank=True)
    git_ref = models.CharField(max_length=128, blank=True)
    description = models.TextField(blank=True)
    is_default = models.BooleanField(default=False)
    size_bytes = models.PositiveBigIntegerField(default=0)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"Outpost {self.version}"

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        if self.is_default:
            OutpostRelease.objects.exclude(pk=self.pk).filter(
                is_default=True
            ).update(is_default=False)

    @classmethod
    def default(cls) -> "OutpostRelease | None":
        return cls.objects.filter(is_default=True).first() or cls.objects.first()


class NotificationChannel(TimestampedModel):
    """Where to send a status-change notification — one row per destination.

    ``kind`` selects the transport; ``config`` holds its target
    (``{"url": …}`` for webhook, ``{"recipients": […]}`` for email).
    ``on_statuses`` optionally filters to transitions *into* the listed statuses
    (e.g. only ``["down", "degraded"]``); empty = every change.
    """

    class Kind(models.TextChoices):
        WEBHOOK = "webhook", "Webhook"
        EMAIL = "email", "Email"
        SLACK = "slack", "Slack"
        TEAMS = "teams", "Microsoft Teams"
        DISCORD = "discord", "Discord"
        PAGERDUTY = "pagerduty", "PagerDuty"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="notification_channels"
    )
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=12, choices=Kind.choices)
    config = models.JSONField(default=dict, blank=True)
    on_statuses = models.JSONField(
        default=list,
        blank=True,
        help_text="Only notify on alerts in these check statuses; empty = all.",
    )
    min_severity = models.CharField(
        max_length=8,
        choices=[("critical", "Critical"), ("warning", "Warning"), ("info", "Info")],
        default="info",
        help_text="Only alerts at or above this severity reach this channel.",
    )
    enabled = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_notification_channels",
    )

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["tenant", "enabled"])]

    def __str__(self) -> str:
        return f"{self.name} ({self.kind})"


class AlertSeverity(models.TextChoices):
    CRITICAL = "critical", "Critical"
    WARNING = "warning", "Warning"
    INFO = "info", "Info"


class AlertStatus(models.TextChoices):
    FIRING = "firing", "Firing"
    RESOLVED = "resolved", "Resolved"


class AlertRule(TimestampedModel):
    """A policy deciding *which* check failures become alerts, and at what
    severity.

    Matchers are ANDed; an empty matcher field means "any". A failing check is
    evaluated against enabled rules in ``weight`` order; the first match sets the
    alert's severity. If a tenant has **no** enabled rules, the engine falls back
    to a sensible default (down/stale → critical, degraded → warning) so
    alerting works out of the box.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="alert_rules"
    )
    name = models.CharField(max_length=120)
    enabled = models.BooleanField(default=True)
    weight = models.PositiveIntegerField(
        default=100, help_text="Lower weights match first."
    )

    # Matchers — empty list / null = match anything.
    match_kinds = models.JSONField(
        default=list, blank=True, help_text="Check kinds this rule covers."
    )
    match_statuses = models.JSONField(
        default=list,
        blank=True,
        help_text="Bad statuses that trigger this rule (down/stale/degraded).",
    )
    match_tag_slugs = models.JSONField(
        default=list,
        blank=True,
        help_text="Only IPs carrying any of these tag slugs.",
    )
    match_prefix = models.ForeignKey(
        "api.Prefix",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="alert_rules",
        help_text="Only IPs inside this prefix.",
    )

    severity = models.CharField(
        max_length=8, choices=AlertSeverity.choices, default=AlertSeverity.WARNING
    )

    class Meta:
        ordering = ["weight", "name"]
        indexes = [models.Index(fields=["tenant", "enabled", "weight"])]

    def __str__(self) -> str:
        return f"{self.name} → {self.severity}"


class Alert(TimestampedModel):
    """An open (or resolved) alerting condition — an *incident*, distinct from
    the raw transition log.

    One **firing** alert exists per ``dedup_key`` (the (IP, check) pair): a check
    going bad opens it, recovery resolves it. This is the stateful layer the
    Alerts page, ack/silence, and routing build on. The default severity comes
    from the bad status; alert rules (A2) refine it.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="alerts"
    )
    target_ip = models.ForeignKey(
        "api.IPAddress", on_delete=models.CASCADE, related_name="alerts"
    )
    template = models.ForeignKey(
        CheckTemplate,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="alerts",
    )
    rule = models.ForeignKey(
        "AlertRule",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="alerts",
        help_text="The rule that set this alert's severity (null = default policy).",
    )
    kind = models.CharField(max_length=8, choices=CheckKind.choices)

    dedup_key = models.CharField(
        max_length=120,
        help_text="Stable key for the alerting condition — (IP, check). One "
        "firing alert per key.",
    )
    severity = models.CharField(
        max_length=8, choices=AlertSeverity.choices, default=AlertSeverity.WARNING
    )
    status = models.CharField(
        max_length=8, choices=AlertStatus.choices, default=AlertStatus.FIRING
    )
    check_status = models.CharField(
        max_length=8,
        choices=CheckStatus.choices,
        help_text="The bad status that opened/sustains this alert.",
    )

    opened_at = models.DateTimeField(default=timezone.now)
    last_status_at = models.DateTimeField(default=timezone.now)
    resolved_at = models.DateTimeField(null=True, blank=True)
    last_notified_at = models.DateTimeField(null=True, blank=True)
    detail = models.JSONField(default=dict, blank=True)

    # ─── acknowledgement (A4) ────────────────────────────────────────────
    # A firing alert can be acked so the team knows someone owns it. Acked
    # alerts stay firing but are excluded from re-notification.
    acknowledged_at = models.DateTimeField(null=True, blank=True)
    acknowledged_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="acknowledged_alerts",
    )
    ack_note = models.CharField(max_length=255, blank=True, default="")

    # ─── notification lifecycle (A5) ─────────────────────────────────────
    notify_count = models.PositiveIntegerField(
        default=0, help_text="How many times this alert has been notified."
    )
    flapping = models.BooleanField(
        default=False,
        help_text="Condition is opening/clearing repeatedly — renotify is paused.",
    )
    escalated = models.BooleanField(
        default=False,
        help_text="Bumped to critical after firing unacked past the threshold.",
    )

    class Meta:
        ordering = ["-opened_at"]
        indexes = [
            models.Index(fields=["tenant", "status"]),
            models.Index(fields=["tenant", "severity", "status"]),
            models.Index(fields=["dedup_key", "status"]),
        ]
        constraints = [
            # At most one firing alert per condition.
            models.UniqueConstraint(
                fields=["tenant", "dedup_key"],
                condition=models.Q(status="firing"),
                name="uniq_firing_alert_per_key",
            )
        ]

    def __str__(self) -> str:
        return f"{self.severity} {self.target_ip_id} {self.check_status} ({self.status})"


class Silence(TimestampedModel):
    """A time-bounded mute over matching alerts — also the maintenance-window
    primitive (a silence whose window is in the future is planned downtime).

    While a silence is *active* (``starts_at`` ≤ now < ``ends_at``) and its
    matchers cover an alert, that alert is still opened/tracked but **no
    notifications are sent** for it. Matchers mirror ``AlertRule`` (kinds /
    statuses / tag slugs / prefix) plus an optional single target IP; empty
    matchers = "everything" (a blanket maintenance window).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="silences"
    )
    reason = models.CharField(max_length=255, blank=True, default="")

    # Matchers — empty list / null = match anything.
    match_kinds = models.JSONField(default=list, blank=True)
    match_statuses = models.JSONField(default=list, blank=True)
    match_tag_slugs = models.JSONField(default=list, blank=True)
    match_prefix = models.ForeignKey(
        "api.Prefix",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="silences",
    )
    match_ip = models.ForeignKey(
        "api.IPAddress",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="silences",
    )

    starts_at = models.DateTimeField(default=timezone.now)
    ends_at = models.DateTimeField()
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_silences",
    )

    class Meta:
        ordering = ["-starts_at"]
        indexes = [models.Index(fields=["tenant", "starts_at", "ends_at"])]

    def __str__(self) -> str:
        return f"silence {self.reason or self.id} [{self.starts_at}–{self.ends_at}]"

    def is_active(self, now=None) -> bool:
        now = now or timezone.now()
        return self.starts_at <= now < self.ends_at


class StateTransition(models.Model):
    """Append-only log of status changes — drives the history timeline and
    transition notifications (Up→Down etc.)."""

    id = models.BigAutoField(primary_key=True)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="check_transitions"
    )
    target_ip = models.ForeignKey(
        "api.IPAddress", on_delete=models.CASCADE, related_name="check_transitions"
    )
    template = models.ForeignKey(
        CheckTemplate,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="transitions",
    )
    kind = models.CharField(max_length=8, choices=CheckKind.choices)

    from_status = models.CharField(max_length=8, choices=CheckStatus.choices)
    to_status = models.CharField(max_length=8, choices=CheckStatus.choices)
    at = models.DateTimeField(default=timezone.now, db_index=True)
    detail = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-at"]
        indexes = [
            models.Index(fields=["target_ip", "-at"]),
            models.Index(fields=["tenant", "-at"]),
        ]

    def __str__(self) -> str:
        return f"{self.target_ip_id} {self.from_status}→{self.to_status} @ {self.at:%Y-%m-%d %H:%M}"


# ─── SNMP profiles + observed device facts (discovery, issue #84) ───────────


class SnmpProfile(TimestampedModel):
    """Reusable SNMP credentials (v1/v2c/v3), named per tenant and selected when
    polling a device for observed facts. Mirrors ``CheckTemplate``'s
    ``params`` / ``secret_params`` split — secrets are encrypted at rest and
    never returned by the API.
    """

    VERSION_CHOICES = [("v1", "v1"), ("v2c", "v2c"), ("v3", "v3")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="snmp_profiles"
    )
    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=120)
    version = models.CharField(max_length=4, default="v2c", choices=VERSION_CHOICES)
    params = models.JSONField(
        default=dict,
        blank=True,
        help_text="Non-secret SNMP config: port, and for v3 username / "
        "auth_proto / priv_proto.",
    )
    secret_params = EncryptedJSONField(
        help_text="Credentials — v2c community, or v3 auth_key / priv_key. "
        "Encrypted at rest; never returned by the API.",
    )
    timeout_ms = models.PositiveIntegerField(default=2000)
    is_default = models.BooleanField(
        default=False,
        help_text="Used when a device poll does not name a profile.",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_snmpprofile_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)
        # At most one default per tenant: marking this profile default demotes any
        # previous one, so switching the default actually switches it (resolution
        # picks .filter(is_default=True).first(), which would otherwise be stuck
        # on whichever sorted first).
        if self.is_default:
            SnmpProfile.objects.filter(tenant=self.tenant, is_default=True).exclude(
                pk=self.pk
            ).update(is_default=False)


class DeviceSnmp(TimestampedModel):
    """Per-device *observed* SNMP state: the read-only system facts last polled
    from the device. Stored separately from the ``api.Device`` source-of-truth
    fields — discovery never overwrites intent (reconciliation is a later
    phase; see issue #84).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="device_snmp"
    )
    device = models.OneToOneField(
        "api.Device", on_delete=models.CASCADE, related_name="snmp"
    )
    profile = models.ForeignKey(
        SnmpProfile, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="device_states",
    )
    data = models.JSONField(
        default=dict, blank=True,
        help_text="Observed system facts (sys_name, sys_descr, sys_uptime, …).",
    )
    interfaces = models.JSONField(
        default=list, blank=True,
        help_text="Observed interfaces from ifTable/ifXTable (per-ifIndex dicts).",
    )
    neighbors = models.JSONField(
        default=list, blank=True,
        help_text="LLDP neighbours: [{local_port, remote_device, remote_port}].",
    )
    arp = models.JSONField(
        default=list, blank=True,
        help_text="ARP table: [{ip, mac, if_index}] from ipNetToMediaTable.",
    )
    reachable = models.BooleanField(null=True, blank=True)
    error = models.TextField(blank=True, default="")
    polled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-polled_at"]

    def __str__(self) -> str:
        return f"SNMP({self.device_id})"


class SnmpProfileBinding(TimestampedModel):
    """Assigns an ``SnmpProfile`` at a level of the device hierarchy. When a
    device is polled the effective profile resolves most-specific first:
    **device → device role → device type → location (→ parents) → site →
    tenant default**. The location/site levels let an Outpost at a site poll its
    local devices with site-scoped credentials.

    Kept on the monitoring side (referencing api ids by ``object_id``) so the
    ``api`` app never depends on ``monitoring`` — same direction as every other
    monitoring↔api link.
    """

    SCOPE_DEVICE = "device"
    SCOPE_ROLE = "device_role"
    SCOPE_TYPE = "device_type"
    SCOPE_LOCATION = "location"
    SCOPE_SITE = "site"
    SCOPE_CHOICES = [
        (SCOPE_DEVICE, "Device"),
        (SCOPE_ROLE, "Device role"),
        (SCOPE_TYPE, "Device type"),
        (SCOPE_LOCATION, "Location"),
        (SCOPE_SITE, "Site"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="snmp_bindings"
    )
    profile = models.ForeignKey(
        SnmpProfile, on_delete=models.CASCADE, related_name="bindings"
    )
    scope = models.CharField(max_length=16, choices=SCOPE_CHOICES)
    object_id = models.UUIDField(help_text="id of the device / role / type.")

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "scope", "object_id"],
                name="uniq_snmpbinding_scope_object",
            )
        ]
        indexes = [models.Index(fields=["tenant", "scope", "object_id"])]

    def __str__(self) -> str:
        return f"{self.scope}:{self.object_id} → {self.profile_id}"


class SnmpInterfaceSample(TimestampedModel):
    """A point-in-time read of an interface's HC octet counters, for computing
    utilisation over time (rate = Δoctets / Δt). Written on every poll; the
    series drives the per-interface sparklines (#84, Phase 2)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="snmp_samples"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="snmp_samples"
    )
    if_index = models.CharField(max_length=32)
    # ifHCInOctets/ifHCOutOctets are SNMP Counter64 — unsigned 64-bit (up to
    # 1.8e19), which overflows a signed Postgres bigint (max 9.2e18). Store as a
    # 20-digit integer-valued decimal so a large counter can't crash the poll.
    in_octets = models.DecimalField(max_digits=20, decimal_places=0, default=0)
    out_octets = models.DecimalField(max_digits=20, decimal_places=0, default=0)
    speed_mbps = models.PositiveIntegerField(default=0)
    sampled_at = models.DateTimeField()

    class Meta:
        ordering = ["sampled_at"]
        indexes = [models.Index(fields=["device", "if_index", "sampled_at"])]

    def __str__(self) -> str:
        return f"{self.device_id}/{self.if_index} @ {self.sampled_at:%H:%M}"
