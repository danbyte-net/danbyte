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

import hashlib
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
    TLS_CERT = "tls_cert", "TLS certificate"


def check_kinds() -> list[tuple[str, str]]:
    """All selectable check kinds — the built-in enum plus any plugin-registered
    checker kinds (label falls back to the kind slug). The checker registry is
    the source of truth for what can actually run; this merges human labels in.
    """
    from monitoring.checkers import CHECKER_REGISTRY

    labels = dict(CheckKind.choices)
    out = list(CheckKind.choices)
    for kind in sorted(CHECKER_REGISTRY):
        if kind not in labels:
            out.append((kind, kind))
    return out


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
    kind = models.CharField(max_length=32, choices=CheckKind.choices)

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
    kind = models.CharField(max_length=32, choices=CheckKind.choices)

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
    kind = models.CharField(max_length=32, choices=CheckKind.choices)

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

    # ─── certificate expiry alerting (X2) ────────────────────────────────
    # Thresholds for the expiry alerts raised over certificate *bindings*
    # (endpoints), not certificate rows — see ``monitoring.cert_expiry``.
    # A tenant with no settings row still alerts, on the defaults below.
    cert_expiry_alerts_enabled = models.BooleanField(
        default=True,
        help_text="Raise alerts for endpoints serving a certificate that is "
        "close to expiry or already expired.",
    )
    cert_expiry_warning_days = models.PositiveSmallIntegerField(
        default=30,
        help_text="Days before expiry a warning alert opens. Must be above your "
        "certificates' renewal lead time, or a freshly renewed short-lived "
        "certificate re-opens the alert immediately.",
    )
    cert_expiry_critical_days = models.PositiveSmallIntegerField(
        default=7,
        help_text="Days before expiry the alert becomes critical. An already "
        "expired certificate is a separate, worse state again.",
    )
    cert_binding_stale_days = models.PositiveSmallIntegerField(
        default=7,
        help_text="Days without observing an endpoint before its binding counts "
        "as stale. A stale binding stops alerting — nobody is served by a "
        "certificate we can no longer see — but is never deleted.",
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
    # ── raw status-change notifications (independent of alert rules) ─────────
    # Opt-in: email/post every status change for matching IPs, without needing
    # an AlertRule. Either instantly (coalesced per check batch) or as a
    # periodic mini-digest every ``status_change_interval_minutes``.
    class StatusChangeMode(models.TextChoices):
        INSTANT = "instant", "Instant"
        BATCHED = "batched", "Batched (mini-digest)"

    send_status_changes = models.BooleanField(
        default=False,
        help_text="Send every status change for matching IPs, independent of "
        "alert rules.",
    )
    status_change_mode = models.CharField(
        max_length=8, choices=StatusChangeMode.choices,
        default=StatusChangeMode.BATCHED,
    )
    status_change_interval_minutes = models.PositiveIntegerField(
        default=30,
        help_text="Batched mode: how often to send the mini-digest.",
    )
    status_change_last_run = models.DateTimeField(null=True, blank=True)
    match_prefix = models.ForeignKey(
        "api.Prefix",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="notification_channels",
        help_text="Only status changes for IPs inside this subnet; blank = all.",
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
    kind = models.CharField(max_length=32, choices=CheckKind.choices)

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
    kind = models.CharField(max_length=32, choices=CheckKind.choices)

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
    fdb = models.JSONField(
        default=list, blank=True,
        help_text="MAC-address table: [{mac, if_index}] from the bridge "
        "forwarding table (dot1dTpFdbPort + dot1dBasePortIfIndex).",
    )
    sensors = models.JSONField(
        default=list, blank=True,
        help_text="Last custom-sensor readings: [{sensor, name, raw, status}].",
    )
    reachable = models.BooleanField(null=True, blank=True)
    error = models.TextField(blank=True, default="")
    polled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-polled_at"]

    def __str__(self) -> str:
        return f"SNMP({self.device_id})"


class SnmpSensor(TimestampedModel):
    """A reusable, user-defined SNMP reading that maps to hardware health.

    SNMP has no standard disk/PSU/fan health MIB — every vendor uses its own
    OIDs (Dell OpenManage, HPE, Supermicro, Synology…). This is the escape
    hatch: define an ``oid``, whether to WALK it (a table column, one value
    per component) or GET it (a single scalar), a ``value_map`` from the raw
    SNMP value to a status slug, and which inventory ``item_kind`` /
    ``name_template`` the readings describe. Bound to a ``device_type`` (or
    all types), it flips the matching inventory items' statuses on every poll
    — using the device's own SNMP profile, so no extra credentials.
    """

    KIND_CHOICES = [
        ("disk", "Disk"), ("cpu", "CPU"), ("ram", "RAM"), ("psu", "PSU"),
        ("fan", "Fan"), ("gpu", "GPU"), ("controller", "Controller"),
        ("other", "Other"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="snmp_sensors"
    )
    name = models.CharField(max_length=120)
    slug = models.SlugField(max_length=120)
    description = models.CharField(max_length=255, blank=True, default="")
    device_type = models.ForeignKey(
        "api.DeviceType", on_delete=models.CASCADE, null=True, blank=True,
        related_name="snmp_sensors",
        help_text="Limit to one device type; blank applies to all.",
    )
    oid = models.CharField(
        max_length=255,
        help_text="Numeric OID — a table column base to WALK, or a scalar to GET.",
    )
    walk = models.BooleanField(
        default=True,
        help_text="Walk a table column (one reading per component) vs GET a "
        "single scalar.",
    )
    item_kind = models.CharField(
        max_length=16, choices=KIND_CHOICES, default="disk"
    )
    name_template = models.CharField(
        max_length=128, default="{kind} {index}",
        help_text="How each reading names/matches its inventory item; "
        "{index} = the walk index, {kind} = the item kind.",
    )
    value_map = models.JSONField(
        default=dict, blank=True,
        help_text='Raw SNMP value → status slug, e.g. {"3": "active", '
        '"4": "failed"}. Unmapped values leave the status unchanged.',
    )
    absent_status = models.CharField(
        max_length=64, blank=True, default="",
        help_text="Status slug for items this sensor covers but the agent never "
        "reported — the empty bays a chassis template stamped. Blank leaves "
        "them alone. Only applied after a poll that actually returned readings, "
        "so a timeout can't mark real hardware missing.",
    )
    APPLY_DRIFT = "drift"
    APPLY_AUTO = "auto"
    APPLY_CHOICES = [
        (APPLY_DRIFT, "Surface as drift — you accept it"),
        (APPLY_AUTO, "Apply automatically"),
    ]
    apply_mode = models.CharField(
        max_length=8, choices=APPLY_CHOICES, default=APPLY_DRIFT,
        help_text="What a reading does to the source of truth. 'drift' keeps "
        "readings observed-only and lists the difference for review — Danbyte's "
        "normal contract, and the only mode that can't overwrite a status you "
        "set. 'auto' writes straight through, for health you want acted on with "
        "no one watching.",
    )
    enabled = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_snmpsensor_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class RedfishEndpoint(TimestampedModel):
    """A device's BMC, reachable over Redfish (DMTF's management REST API —
    what iDRAC, iLO, XClarity, Supermicro and UCS all speak). Config + the
    last observed inventory in one per-device row.

    The collector reads Systems → Storage → Drives, Processors, Memory and
    Chassis → Power/Thermal, then reconciles the parts into the device's
    inventory items (create/update by serial, health → lifecycle status).
    Observed facts never overwrite user intent beyond the documented
    reconcile rules.

    Security: BMCs live on management (RFC1918) networks, which the outbound
    SSRF guard rightly blocks for user-supplied URLs. A Redfish endpoint is
    ADMIN-CONFIGURED (device change permission), pinned to this one host, and
    fetched with redirects disabled — that is the deliberate, scoped
    private-IP allowance. Loopback/link-local stay blocked.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="redfish_endpoints"
    )
    device = models.OneToOneField(
        "api.Device", on_delete=models.CASCADE, related_name="redfish"
    )
    host = models.CharField(
        max_length=255, help_text="BMC address (IP or hostname)."
    )
    port = models.PositiveIntegerField(default=443)
    verify_tls = models.BooleanField(
        default=False,
        help_text="BMCs almost always present self-signed certificates; "
        "enable only when yours carry a trusted chain.",
    )
    secret_params = EncryptedJSONField(
        help_text="BMC credentials: {username, password}. Encrypted at rest; "
        "never returned by the API.",
    )
    enabled = models.BooleanField(default=True)
    timeout_ms = models.PositiveIntegerField(default=8000)

    # Last observed state (the collector writes these).
    data = models.JSONField(
        default=dict, blank=True,
        help_text="Observed hardware: {drives: [...], processors: [...], "
        "memory: [...], psus: [...], fans: [...], system: {...}}.",
    )
    reachable = models.BooleanField(null=True, blank=True)
    error = models.TextField(blank=True, default="")
    polled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["device__name"]

    def __str__(self) -> str:
        return f"Redfish({self.device_id} @ {self.host})"


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
    target = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Poll this address instead of the device's own IPs (device "
        "scope only) — e.g. a BMC or a management address the agent listens "
        "on. Blank resolves management IP → primary IP → resolvable name.",
    )

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


# ─── Certificate inventory ────────────────────────────────────────────────


# Markers for every PEM/OpenSSH private-key envelope. A certificate inventory
# stores public data only; these exist so the rule is enforced, not just stated.
_PRIVATE_KEY_MARKERS = (
    "PRIVATE KEY-----",
    "BEGIN OPENSSH PRIVATE KEY",
    "BEGIN PGP PRIVATE KEY",
    "BEGIN SSH2 ENCRYPTED PRIVATE KEY",
)


def contains_private_key_material(value) -> bool:
    """Whether ``value`` (a string, or a list/dict of them) looks like a key."""
    if isinstance(value, str):
        upper = value.upper()
        return any(marker in upper for marker in _PRIVATE_KEY_MARKERS)
    if isinstance(value, (list, tuple)):
        return any(contains_private_key_material(v) for v in value)
    if isinstance(value, dict):
        return any(
            contains_private_key_material(k) or contains_private_key_material(v)
            for k, v in value.items()
        )
    return False


class PublicKeyAlgorithm(models.TextChoices):
    RSA = "rsa", "RSA"
    EC = "ec", "ECDSA"
    ED25519 = "ed25519", "Ed25519"
    ED448 = "ed448", "Ed448"
    DSA = "dsa", "DSA"
    UNKNOWN = "unknown", "Unknown"


class Certificate(TimestampedModel):
    """One observed X.509 certificate — **public data only**.

    Every field here is a value the server broadcasts to every client that
    completes a handshake: subject, issuer, SANs, serial, fingerprint, validity
    window, key algorithm/size, signature algorithm. That is what makes a
    certificate inventory safe by construction where a credential store was not.

    **A private key is never stored, requested, or accepted.** There is
    deliberately no PEM/blob/notes/custom-fields column that could hold one:
    a field that *could* carry key material is the design error, so none exists.
    :meth:`save` additionally scans what it is about to write and refuses key
    material outright, whatever the write path (collector, shell, future import).

    Identity is the **SHA-256 fingerprint of the DER**, scoped to the tenant:

    * The same certificate served by ten endpoints is **one row**, not ten —
      the fingerprint is over the exact bytes, so equality is exact.
    * Uniqueness is ``(tenant, fingerprint_sha256)`` rather than a global
      unique fingerprint: tenant isolation is a hard boundary, so two tenants
      that legitimately observe the same public certificate each own their own
      row, and one tenant can never read or delete another's.
    * **Renewal creates a new row.** A renewed certificate has a new validity
      window (and usually a new serial and key), so different DER, so a
      different fingerprint. The previous row is never overwritten or deleted —
      it stays as history, which is what makes "what were we serving when that
      outage happened?" answerable.

    Everything stored here is **intrinsic** — a property of those exact DER
    bytes, so it cannot legitimately change while the fingerprint stays the
    same. Facts that depend on *where* the certificate was seen (how deep in
    the presented chain, whether that chain verified) belong to
    :class:`CertificateBinding`, because the same certificate can sit at depth 1
    on one host and be absent from another host's chain entirely.

    ``last_seen`` is the one deliberate exception: it is the roll-up across
    every binding — "is this certificate still in service *anywhere*?" — and it
    is refreshed on observation, never used to derive validity.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="certificates"
    )

    fingerprint_sha256 = models.CharField(
        max_length=64,
        help_text="SHA-256 of the DER encoding, lowercase hex. The identity of "
        "the certificate — the same cert seen anywhere is this same row.",
    )
    subject = models.CharField(max_length=1024, blank=True, default="")
    subject_cn = models.CharField(max_length=255, blank=True, default="")
    issuer = models.CharField(max_length=1024, blank=True, default="")
    issuer_cn = models.CharField(max_length=255, blank=True, default="")
    serial = models.CharField(
        max_length=128, blank=True, default="",
        help_text="Certificate serial number, lowercase hex.",
    )
    san_dns = models.JSONField(
        default=list, blank=True,
        help_text="dNSName subject alternative names, e.g. "
        '["example.com", "*.example.com"].',
    )
    san_ip = models.JSONField(
        default=list, blank=True,
        help_text="iPAddress subject alternative names, as strings.",
    )
    not_before = models.DateTimeField()
    not_after = models.DateTimeField(db_index=True)
    public_key_algorithm = models.CharField(
        max_length=16,
        choices=PublicKeyAlgorithm.choices,
        default=PublicKeyAlgorithm.UNKNOWN,
    )
    public_key_bits = models.PositiveIntegerField(null=True, blank=True)
    signature_algorithm = models.CharField(max_length=64, blank=True, default="")
    self_signed = models.BooleanField(default=False)

    # ─── CA modelling: is this a CA, and how it links to its issuer ───────
    # All still public DER facts. ``is_ca`` = basicConstraints CA:TRUE.
    # ``subject_key_id`` / ``authority_key_id`` are the RFC 5280 key
    # identifiers; a leaf's AKI equals its issuer's SKI, which is how the chain
    # graph is built without trusting DN strings. ``issuer_certificate`` is the
    # resolved parent in *this tenant's* inventory (nullable — the issuer may
    # not be known yet), letting the UI walk leaf → intermediate → root.
    is_ca = models.BooleanField(default=False, db_index=True)
    subject_key_id = models.CharField(max_length=128, blank=True, default="", db_index=True)
    authority_key_id = models.CharField(max_length=128, blank=True, default="")
    issuer_certificate = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="issued_certificates",
        help_text="The parent CA certificate in this tenant's inventory, if known.",
    )

    last_seen = models.DateTimeField(
        null=True, blank=True,
        help_text="Most recent observation. ``created_at`` is the first.",
    )

    # ─── Origin: observed on the wire, declared by a human, or both ───────
    # The fingerprint is the identity, so a certificate that was uploaded and is
    # later served (or vice-versa) is the *same row* — these two flags record
    # that convergence rather than duplicating it. "The cert I declared is the
    # one being served" is then simply ``uploaded and observed`` on one row.
    observed = models.BooleanField(
        default=False,
        help_text="Seen being served by a TLS endpoint (the collector wrote it).",
    )
    uploaded = models.BooleanField(
        default=False,
        help_text="Declared by an operator via the upload API (public PEM stored).",
    )
    # The public certificate PEM, stored **only** for uploaded certs. A public
    # X.509 certificate is broadcast to every client, so it is not a secret; a
    # private key is, and the upload path + save() guard both refuse one.
    pem = models.TextField(
        blank=True, default="",
        help_text="Public certificate PEM (uploaded certs only). Never a key.",
    )
    # Authored metadata — editable for any row, meaningful for uploaded ones.
    # The intrinsic facts (subject/issuer/serial/fingerprint/validity/key) are
    # never editable: they come from the DER bytes the fingerprint covers.
    name = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Operator-chosen label for this certificate.",
    )
    notes = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["not_after", "subject_cn"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "fingerprint_sha256"],
                name="uniq_certificate_tenant_fingerprint",
            )
        ]
        indexes = [
            models.Index(fields=["tenant", "not_after"]),
            models.Index(fields=["tenant", "subject_cn"]),
        ]

    def __str__(self) -> str:
        return f"{self.subject_cn or self.subject or self.fingerprint_sha256[:16]}"

    @property
    def origin(self) -> str:
        """How this row came to exist: ``observed``, ``uploaded``, ``both`` (the
        declared cert is the one being served), or ``unknown`` (neither flag —
        shouldn't happen for a persisted row)."""
        if self.uploaded and self.observed:
            return "both"
        if self.uploaded:
            return "uploaded"
        if self.observed:
            return "observed"
        return "unknown"

    @property
    def is_expired(self) -> bool:
        return self.not_after <= timezone.now()

    @property
    def days_until_expiry(self) -> float:
        return round((self.not_after - timezone.now()).total_seconds() / 86400, 2)

    def _assert_public_only(self) -> None:
        """Refuse to persist anything that looks like private key material.

        Belt and braces on top of "there is no field for it": the guarantee is
        that no write path — collector, management command, shell, a future
        import — can smuggle a key into a certificate row.
        """
        from django.core.exceptions import ValidationError

        for field in self._meta.fields:
            if contains_private_key_material(getattr(self, field.attname, None)):
                raise ValidationError({
                    field.name: "Private key material must never be stored on a "
                    "certificate. Certificates hold public data only."
                })

    def save(self, *args, **kwargs):
        self._assert_public_only()
        return super().save(*args, **kwargs)


def certificate_endpoint_key(target_ip_id, port: int, server_name: str) -> str:
    """The stable identity of a TLS **endpoint**: ``(IP, port, SNI)``.

    Deliberately *not* the certificate. A renewal replaces the certificate on an
    endpoint but the endpoint is the same thing it was yesterday, so anything
    that must survive a renewal — an expiry alert above all — has to key off
    this, not off a :class:`Certificate` row.

    The SNI is hashed rather than embedded so the key stays inside the
    ``Alert.dedup_key`` length budget for any hostname; the readable value is
    always available on the binding itself.
    """
    digest = hashlib.blake2s(
        (server_name or "").strip().lower().encode("utf-8"), digest_size=8
    ).hexdigest()
    return f"{target_ip_id}:{int(port)}:{digest}"


class CertificateBinding(TimestampedModel):
    """One endpoint served one certificate — the row that makes the inventory
    answer *what breaks when it expires*.

    A :class:`Certificate` alone is a floating fact. The binding joins it to the
    endpoint that presented it, so a wildcard certificate on twelve hosts is
    **one certificate row and twelve bindings** — which is the whole reason the
    fingerprint, not the hostname, is the certificate's identity.

    **The anchor is (IPAddress, port, server name).** That is exactly what the
    collector dialled and what the check engine already targets, so every
    observation can produce one; an ``api.Service`` anchor would have silently
    dropped every endpoint nobody had happened to author a Service row for.

    **Per-endpoint facts live here, not on the certificate.** ``chain_depth``
    and ``chain_verified`` describe *this handshake*: the same intermediate is
    depth 1 where the server sends a full chain and missing where it doesn't,
    and a certificate can verify from one endpoint and fail from another. On the
    certificate they would have been the last writer's opinion.

    **Bindings are never deleted when an endpoint stops serving a certificate.**
    A stale ``last_seen`` is the signal; deleting the row would destroy the
    answer to "what *used* to serve this?".
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="certificate_bindings"
    )
    certificate = models.ForeignKey(
        Certificate, on_delete=models.CASCADE, related_name="bindings"
    )
    target_ip = models.ForeignKey(
        "api.IPAddress", on_delete=models.CASCADE, related_name="certificate_bindings"
    )
    port = models.PositiveIntegerField(default=443)
    server_name = models.CharField(
        max_length=255, blank=True, default="",
        help_text="The SNI / hostname requested when the certificate was read. "
        "Part of the endpoint's identity: one IP:port can legitimately serve a "
        "different certificate per name.",
    )
    endpoint_key = models.CharField(
        max_length=80, db_index=True,
        help_text="Denormalised (IP, port, SNI) identity — stable across "
        "renewals, which is what expiry alerts are keyed on.",
    )

    chain_depth = models.PositiveSmallIntegerField(
        default=0,
        help_text="Position in the chain *this endpoint* presented — 0 is the "
        "end-entity (leaf) certificate, 1 its issuer, and so on.",
    )
    chain_verified = models.BooleanField(
        null=True, blank=True,
        help_text="Did the chain *this endpoint* presented validate against the "
        "trust store? NULL = not known. Recorded, never enforced.",
    )

    first_seen = models.DateTimeField(
        help_text="First time this endpoint was observed serving this certificate."
    )
    last_seen = models.DateTimeField(
        db_index=True,
        help_text="Most recent observation. Going stale — not being deleted — is "
        "how an endpoint that stopped serving this certificate is recorded.",
    )

    class Meta:
        ordering = ["-last_seen"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "certificate", "target_ip", "port", "server_name"],
                name="uniq_certificate_binding_endpoint",
            )
        ]
        indexes = [
            models.Index(fields=["tenant", "endpoint_key", "-last_seen"]),
            models.Index(fields=["certificate", "-last_seen"]),
            models.Index(fields=["tenant", "chain_depth", "-last_seen"]),
        ]

    def __str__(self) -> str:
        return f"{self.target_ip_id}:{self.port} → {self.certificate_id}"

    @property
    def endpoint_label(self) -> str:
        """Human-readable endpoint, e.g. ``192.0.2.10:443 (www.example.com)``."""
        base = f"{self.target_ip.ip_address}:{self.port}"
        return f"{base} ({self.server_name})" if self.server_name else base

    def _assert_single_tenant(self) -> None:
        """A binding may never join objects from two tenants.

        The queryset filters already hide cross-tenant rows; this is the write
        side of the same boundary, on the only path that creates bindings.
        """
        from django.core.exceptions import ValidationError

        if self.certificate.tenant_id != self.tenant_id:
            raise ValidationError({
                "certificate": "A binding may not join a certificate from "
                "another tenant."
            })
        if self.target_ip.tenant_id != self.tenant_id:
            raise ValidationError({
                "target_ip": "A binding may not join an IP address from "
                "another tenant."
            })

    def save(self, *args, **kwargs):
        self._assert_single_tenant()
        if not self.endpoint_key:
            self.endpoint_key = certificate_endpoint_key(
                self.target_ip_id, self.port, self.server_name
            )
        return super().save(*args, **kwargs)


class SSHHostKey(TimestampedModel):
    """An SSH host key a device presents on port 22 — **public key only**.

    A device's host key is its cryptographic identity to every SSH client.
    Recording the expected key and comparing it to what's actually presented
    catches key rotation, reinstalls, and — the security case — a MITM. Same
    observe → source-of-truth → drift shape as :class:`Certificate`, scoped to a
    device rather than a freely-assigned endpoint.

    **A private key is never stored, requested, or accepted** — there is no
    field for one and :meth:`save` refuses key material outright.

    Identity is the OpenSSH ``SHA256:…`` fingerprint, scoped to the **device**,
    so an uploaded key later observed on the wire is the **same row** (the
    ``observed`` / ``uploaded`` flags record that convergence), while two devices
    that happen to share a key (cloned/templated VMs that didn't regenerate it)
    each keep their own row. During rotation the old and new keys coexist as
    separate rows, which is what makes the mismatch visible.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="ssh_host_keys"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="ssh_host_keys"
    )
    key_type = models.CharField(
        max_length=64,
        help_text="OpenSSH algorithm name, e.g. ssh-ed25519, ssh-rsa, "
        "ecdsa-sha2-nistp256.",
    )
    public_key = models.TextField(
        help_text="The base64 public-key blob (the middle field of an OpenSSH "
        "line). Public data only — never a private key.",
    )
    fingerprint_sha256 = models.CharField(
        max_length=64,
        help_text="OpenSSH SHA256:… fingerprint. The identity of the key — the "
        "same key seen anywhere is this same row.",
    )
    comment = models.CharField(max_length=255, blank=True, default="")
    bits = models.PositiveIntegerField(null=True, blank=True)
    observed = models.BooleanField(
        default=False,
        help_text="Seen being presented by the device (the collector wrote it).",
    )
    uploaded = models.BooleanField(
        default=False,
        help_text="Declared by an operator as the expected host key.",
    )
    first_seen = models.DateTimeField(null=True, blank=True)
    last_seen = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "device", "fingerprint_sha256"],
                name="uniq_ssh_host_key_device_fp",
            )
        ]
        indexes = [
            models.Index(fields=["tenant", "device"]),
            models.Index(fields=["device", "key_type"]),
        ]
        ordering = ["device_id", "key_type"]

    def __str__(self) -> str:
        return f"{self.key_type} {self.fingerprint_sha256}"

    @property
    def origin(self) -> str:
        if self.observed and self.uploaded:
            return "both"
        return "uploaded" if self.uploaded else "observed"

    def _assert_public_only(self) -> None:
        from django.core.exceptions import ValidationError

        for field in self._meta.fields:
            if contains_private_key_material(getattr(self, field.attname, None)):
                raise ValidationError({
                    field.name: "Private key material must never be stored on a "
                    "host key. Only the public key is held."
                })

    def save(self, *args, **kwargs):
        self._assert_public_only()
        return super().save(*args, **kwargs)


class DeviceCredential(TimestampedModel):
    """A named login for a device that points at an **externally-authored**
    secret — Danbyte stores only a *reference*, never the secret value.

    The credential records *how* to connect (kind, username, port, scheme) and
    *where the secret lives* (``secret_provider`` + ``secret_path``), so the
    later Connect / reveal flows can fetch the password or key from the operator's
    secret store at use-time. There is deliberately **no field for the secret
    itself**: the value lives in the ``local`` (``StoredSecret``) or ``vault``
    store under ``secret_path`` and is only ever read by :meth:`resolve_secret`,
    which the ``reveal`` action (and, later, Connect) call — never list/detail
    serialization.
    """

    class Kind(models.TextChoices):
        SSH_PASSWORD = "ssh_password", "SSH password"
        SSH_KEY = "ssh_key", "SSH key"
        HTTPS_LOGIN = "https_login", "HTTPS login"

    class Provider(models.TextChoices):
        LOCAL = "local", "Local"
        VAULT = "vault", "Vault"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="device_credentials"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="credentials"
    )
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    username = models.CharField(max_length=255, blank=True, default="")
    port = models.PositiveIntegerField(null=True, blank=True)
    scheme = models.CharField(
        max_length=8, blank=True, default="",
        help_text="For https_login: http or https. Ignored for SSH kinds.",
    )
    secret_provider = models.CharField(
        max_length=8, choices=Provider.choices, blank=True, default="",
        help_text="Which secret store holds the value. For a managed credential "
        "this is stamped with the active provider at write-time.",
    )
    secret_managed = models.BooleanField(
        default=True,
        help_text="True: Danbyte stores the secret in the active store under its "
        "own namespace (the operator types the value once). False: the operator "
        "references an existing external path they manage themselves.",
    )
    secret_path = models.CharField(
        max_length=200, blank=True, default="",
        help_text="For a managed credential, the auto-assigned ref Danbyte wrote "
        "to. For an external credential, the operator-managed path to read. The "
        "secret value itself is never stored on this row.",
    )
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "device", "name"],
                name="uniq_device_credential_tenant_device_name",
            )
        ]
        indexes = [models.Index(fields=["tenant", "device"])]

    def __str__(self) -> str:
        return self.name

    def resolve_secret(self) -> dict:
        """Fetch the referenced secret from the active store at use-time.

        Fail-closed: raises :class:`SecretStoreDisabled` when no store is
        enabled, and :class:`SecretStoreError` when the store is reachable but
        nothing lives at ``secret_path``. Only the ``reveal`` action (and, later,
        Connect) call this — never list/detail serialization."""
        from .secret_store import SecretStoreError, require_secret_store

        store = require_secret_store()
        # Managed: our own {tenant}/{ref} namespace (get). External: the
        # operator's own path (get_at_path). Both are tenant-scoped.
        if self.secret_managed:
            value = store.get(self.tenant_id, self.secret_path)
        else:
            value = store.get_at_path(self.tenant_id, self.secret_path)
        if value is None:
            raise SecretStoreError(
                f"No secret found at '{self.secret_path}' in the configured store."
            )
        return value

    def store_managed_secret(self, value: dict) -> None:
        """Write a managed credential's secret into the active store under an
        auto-assigned ref (``device-credentials/<id>``), stamping the provider.
        Only for managed credentials; external ones reference a path instead."""
        from core.models import DeploymentSettings

        from .secret_store import require_secret_store

        store = require_secret_store()
        if not self.secret_path:
            self.secret_path = f"device-credentials/{self.id}"
        self.secret_provider = (
            DeploymentSettings.load().secrets_provider or ""
        ).strip()
        store.put(self.tenant_id, self.secret_path, value or {})


class ConnectProtocol(TimestampedModel):
    """A user-defined way to *reach* a device — a launch template a Connect menu
    turns into a URL the operator's browser hands to the OS.

    Danbyte does not hard-code a fixed set of access methods. An operator defines
    their own (``ssh://``, ``telnet://``, ``rdp://``, ``https://``, or any custom
    scheme they have registered as an OS protocol handler), so the same device
    can offer a native SSH client, a web UI, an RDP session, etc. The template is
    a plain string with ``{placeholders}`` — ``{host}``, ``{username}``,
    ``{port}``, ``{name}`` — filled from the device (and an optionally chosen
    credential's username) **client-side** at launch. No secret is ever part of
    the template or the produced URL; the value stays server-side and is only
    reachable through :meth:`DeviceCredential.resolve_secret`.

    Tenant-scoped catalog: each tenant curates its own protocols, editable and
    removable, so this is a customizable catalog rather than a fixed enum.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="connect_protocols"
    )
    name = models.CharField(max_length=80)
    url_template = models.CharField(
        max_length=500,
        help_text="Launch URL with {placeholders}: {host}, {username}, {port}, "
        "{name}. E.g. ssh://{username}@{host} or telnet://{host}:{port}. The "
        "browser hands the resulting URL to the OS protocol handler.",
    )
    icon = models.CharField(
        max_length=32, blank=True, default="",
        help_text="Optional Lucide icon name for the menu entry.",
    )
    default_port = models.PositiveIntegerField(
        null=True, blank=True,
        help_text="Substituted for {port} when the device has no explicit port.",
    )
    weight = models.PositiveSmallIntegerField(
        default=1000, help_text="Lower sorts first in the Connect menu."
    )
    enabled = models.BooleanField(default=True)
    description = models.TextField(blank=True, default="")
    # Optional targeting: restrict which devices offer this protocol. Empty =
    # every device. A device matches when its device_type is in `device_types`
    # (if any are set) OR its role is in `roles` (if any are set) — a union, so a
    # protocol can target a set of types plus a set of roles. Untargeted
    # protocols always show.
    device_types = models.ManyToManyField(
        "api.DeviceType", blank=True, related_name="connect_protocols"
    )
    roles = models.ManyToManyField(
        "api.DeviceRole", blank=True, related_name="connect_protocols"
    )

    class Meta:
        ordering = ["weight", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"],
                name="uniq_connect_protocol_tenant_name",
            )
        ]
        indexes = [models.Index(fields=["tenant", "enabled"])]

    def __str__(self) -> str:
        return self.name


class CertificateAssignment(TimestampedModel):
    """Intent: *this certificate should be presented by that object* — the
    source-of-truth half a drift check compares against.

    A generic reference (``object_type`` label + ``object_id``) rather than typed
    FKs, mirroring :class:`api.ContactAssignment`: a certificate can be declared
    on a device, an IP address, a virtual machine or a service without a column
    per kind, and the generic ref is the established "attach X to anything" shape.
    Because the reference is by label, this model needs no import of the ``api``
    models it points at — tenant isolation of the target is enforced in the
    viewset, exactly as ``ContactAssignment`` does.

    One certificate can be assigned to many objects (a wildcard on every host it
    covers); one object can carry several certificates (a device running several
    services). Uniqueness is therefore on the *triple* ``(certificate,
    object_type, object_id)`` — declaring the same certificate on the same object
    twice is the only thing forbidden.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="certificate_assignments"
    )
    certificate = models.ForeignKey(
        Certificate, on_delete=models.CASCADE, related_name="assignments"
    )
    object_type = models.CharField(
        max_length=64,
        help_text="e.g. api.device, api.ipaddress, api.virtualmachine, api.service.",
    )
    object_id = models.CharField(max_length=64)
    notes = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["object_type", "object_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["certificate", "object_type", "object_id"],
                name="uniq_certificate_assignment",
            )
        ]
        indexes = [
            models.Index(fields=["tenant", "object_type", "object_id"]),
            models.Index(fields=["certificate"]),
        ]

    def __str__(self) -> str:
        return f"{self.certificate_id} → {self.object_type} {self.object_id}"

    def _assert_single_tenant(self) -> None:
        """An assignment may never join a certificate from another tenant.

        The target object's tenancy is validated in the viewset (it lives in the
        ``api`` app and is resolved by label); this covers the one FK we own.
        """
        from django.core.exceptions import ValidationError

        if self.certificate_id and self.certificate.tenant_id != self.tenant_id:
            raise ValidationError({
                "certificate": "An assignment may not reference a certificate "
                "from another tenant."
            })

    def save(self, *args, **kwargs):
        self._assert_single_tenant()
        return super().save(*args, **kwargs)


class StoredSecret(TimestampedModel):
    """A named secret in the **local** secret store, encrypted at rest.

    The store CSR/ACME use to stash private-key material under an opaque ``ref``
    so nothing else in the app holds the secret itself — only the reference. This
    is the ``local`` provider's backing table; the ``vault`` provider keeps the
    same values in an external Vault/OpenBao and this table stays empty. There is
    deliberately **no serializer, viewset, or audit registration** — a stored
    secret is never returned over the API or written to the change log.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="stored_secrets"
    )
    ref = models.CharField(
        max_length=200,
        help_text="Opaque reference the owning feature uses to fetch this secret.",
    )
    value = EncryptedJSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "ref"], name="uniq_stored_secret_tenant_ref"
            )
        ]

    def __str__(self) -> str:
        return f"secret:{self.ref}"


class CertificateRequest(TimestampedModel):
    """An operator's request for a new certificate — a CSR and its key.

    Danbyte generates the key pair and the CSR; the **public** CSR is stored on
    this row (a CSR is not secret), while the **private key** goes to the opt-in
    secret store under ``key_ref`` — never a column here, and never returned
    except to the operator who made the request. The request is a small state
    machine: ``generated`` (CSR ready to hand to a CA) → ``issued`` (the signed
    certificate came back and is linked) → or ``cancelled``.
    """

    class KeySpec(models.TextChoices):
        RSA_2048 = "rsa-2048", "RSA 2048"
        RSA_3072 = "rsa-3072", "RSA 3072"
        RSA_4096 = "rsa-4096", "RSA 4096"
        EC_P256 = "ec-p256", "ECDSA P-256"
        EC_P384 = "ec-p384", "ECDSA P-384"
        ED25519 = "ed25519", "Ed25519"

    class Status(models.TextChoices):
        GENERATED = "generated", "Generated"
        ISSUED = "issued", "Issued"
        CANCELLED = "cancelled", "Cancelled"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="certificate_requests"
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="certificate_requests",
    )

    # ─── subject (DN) — only common_name is required ──────────────────────
    common_name = models.CharField(max_length=255)
    organization = models.CharField(max_length=255, blank=True, default="")
    organizational_unit = models.CharField(max_length=255, blank=True, default="")
    country = models.CharField(max_length=2, blank=True, default="")
    state = models.CharField(max_length=128, blank=True, default="")
    locality = models.CharField(max_length=128, blank=True, default="")
    # ─── subjectAltName ───────────────────────────────────────────────────
    san_dns = models.JSONField(default=list, blank=True)
    san_ip = models.JSONField(default=list, blank=True)

    key_spec = models.CharField(
        max_length=16, choices=KeySpec.choices, default=KeySpec.RSA_2048
    )
    status = models.CharField(
        max_length=12, choices=Status.choices, default=Status.GENERATED, db_index=True
    )
    # The public CSR PEM (safe to store). The private key lives in the secret
    # store at ``key_ref``, never on this row.
    csr_pem = models.TextField(blank=True, default="")
    key_ref = models.CharField(max_length=200, blank=True, default="")
    issued_certificate = models.ForeignKey(
        "Certificate",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="certificate_requests",
    )
    notes = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["tenant", "status"])]

    def __str__(self) -> str:
        return f"CSR {self.common_name} ({self.status})"


class Issuer(TimestampedModel):
    """An external certificate authority Danbyte can request from — an ACME
    directory (public like Let's Encrypt, or internal like step-ca).

    The account **private key** lives in the secret store at ``account_ref``,
    never on this row; the EAB HMAC (a credential) is encrypted in ``secrets``.
    Deployment/tenant-admin configured, so the directory URL may be an internal
    host — reached directly like the Redfish/Vault endpoints, not via the tenant
    SSRF guard.
    """

    class Kind(models.TextChoices):
        ACME = "acme", "ACME"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="issuers"
    )
    name = models.CharField(max_length=120)
    kind = models.CharField(max_length=12, choices=Kind.choices, default=Kind.ACME)
    enabled = models.BooleanField(default=True)

    directory_url = models.URLField(
        help_text="ACME directory URL, e.g. https://acme-v02.api.letsencrypt.org/"
        "directory or https://stepca.danbyte.lan/acme/acme/directory.",
    )
    contact_email = models.CharField(max_length=255, blank=True, default="")
    # External Account Binding key id (public); the HMAC lives in ``secrets``.
    eab_kid = models.CharField(max_length=255, blank=True, default="")
    verify_tls = models.BooleanField(default=True)

    class DnsProvider(models.TextChoices):
        MANUAL = "", "Manual"
        RFC2136 = "rfc2136", "RFC2136 / TSIG"
        GSS_TSIG = "gss-tsig", "Windows AD DNS (GSS-TSIG)"

    # How DNS-01 challenges are published. "" = manual (the operator publishes
    # the TXT record); a provider auto-publishes it so orders self-validate.
    # Pluggable: RFC2136 (BIND, Samba AD, PowerDNS, Knot, …) and GSS-TSIG for
    # Windows AD DNS (Kerberos secure dynamic update, needs a service-account
    # keytab + the `gssapi` package).
    dns_provider = models.CharField(
        max_length=16, choices=DnsProvider.choices, blank=True, default=""
    )
    # Provider config (server, port, zone, key name/algorithm, ttl). The TSIG
    # secret is a credential and lives in ``secrets``, never here.
    dns_settings = models.JSONField(default=dict, blank=True)
    # Set once the ACME account is registered; the account key is in the secret
    # store at ``account_ref`` (never on this row).
    account_uri = models.CharField(max_length=512, blank=True, default="")
    account_ref = models.CharField(max_length=200, blank=True, default="")
    secrets = EncryptedJSONField(default=dict, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="issuers",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["tenant", "name"], name="uniq_issuer_name")
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.kind})"


class AcmeOrder(TimestampedModel):
    """One ACME issuance order — fulfilling a :class:`CertificateRequest`'s CSR
    against an :class:`Issuer`.

    Carries the challenge data the operator (or a DNS connector) must satisfy —
    DNS-01 TXT records or HTTP-01 tokens — and the order's lifecycle. On success
    the issued certificate is imported as a :class:`Certificate` and linked.
    """

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        READY = "ready", "Ready"
        PROCESSING = "processing", "Processing"
        VALID = "valid", "Valid"
        INVALID = "invalid", "Invalid"
        ERRORED = "errored", "Errored"

    class Challenge(models.TextChoices):
        DNS01 = "dns-01", "DNS-01"
        HTTP01 = "http-01", "HTTP-01"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="acme_orders"
    )
    issuer = models.ForeignKey(
        Issuer, on_delete=models.CASCADE, related_name="orders"
    )
    request = models.ForeignKey(
        CertificateRequest, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="acme_orders",
    )
    status = models.CharField(
        max_length=12, choices=Status.choices, default=Status.PENDING, db_index=True
    )
    challenge_type = models.CharField(
        max_length=8, choices=Challenge.choices, default=Challenge.DNS01
    )
    identifiers = models.JSONField(default=list, blank=True)
    order_url = models.CharField(max_length=512, blank=True, default="")
    # What the operator must publish to pass validation — a list of
    # {identifier, type, status, and the DNS record or HTTP token fields}.
    challenges = models.JSONField(default=list, blank=True)
    error = models.TextField(blank=True, default="")
    issued_certificate = models.ForeignKey(
        "Certificate", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="acme_orders",
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="acme_orders",
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["tenant", "status"])]

    def __str__(self) -> str:
        return f"ACME order {', '.join(self.identifiers or [])} ({self.status})"


class WatchedEndpoint(TimestampedModel):
    """A bare TLS endpoint (``host:port`` [+ SNI]) whose certificate Danbyte
    polls on a schedule, with **no device or IP modelled**. It reuses the
    ``tls_cert`` collector via :mod:`monitoring.watched_endpoints`; observed
    certificates land in the Certificates inventory like any other ``tls_cert``
    observation. Deliberately isolated from the IP-anchored check engine.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="watched_endpoints"
    )
    host = models.CharField(
        max_length=255, help_text="Hostname or IP to connect to."
    )
    port = models.PositiveIntegerField(default=443)
    server_name = models.CharField(
        max_length=255, blank=True, default="",
        help_text="SNI / server name to request; blank uses the host.",
    )
    interval_seconds = models.PositiveIntegerField(
        default=86400, help_text="How often to re-read the certificate."
    )
    enabled = models.BooleanField(default=True)
    allow_self_signed = models.BooleanField(
        default=False,
        help_text="Treat a self-signed certificate as healthy (up) instead of "
        "degraded — for endpoints that are self-signed by design. Expiry and "
        "not-yet-valid still degrade.",
    )
    last_run_at = models.DateTimeField(null=True, blank=True)
    last_status = models.CharField(max_length=12, blank=True, default="")
    last_detail = models.JSONField(default=dict, blank=True)
    last_certificate = models.ForeignKey(
        "Certificate", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )

    class Meta:
        ordering = ["host", "port"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "host", "port", "server_name"],
                name="uniq_watched_endpoint",
            )
        ]
        indexes = [models.Index(fields=["tenant", "enabled"])]

    def __str__(self) -> str:
        sni = f" ({self.server_name})" if self.server_name else ""
        return f"{self.host}:{self.port}{sni}"
