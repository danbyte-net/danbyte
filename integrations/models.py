"""Outbound webhooks - POST a payload to an external URL when objects change.

Tenant-scoped: each tenant configures its own webhooks. Delivery is fired from
post_save / post_delete signals (see ``webhooks.py``) and runs off the request
path on the RQ ``low`` queue, so a delivery failure can never break a save.
"""
from __future__ import annotations

import uuid

from django.db import models

from api.vrf_placement import PINNED, VRF_MODE_CHOICES
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
    """A runner Danbyte can dispatch a deploy to - an Ansible AWX/AAP job
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
    # Encrypted at rest - an AWX bearer token is lateral movement into the
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
    the UI - the read-half of the IaC loop (Golden-Config / Assurance style).
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
    changes (see the signal in ``drift_history.py``) - so the table is an event
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
    cleared when the run reaches a terminal state - a migration credential
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
    # Download device-type front/rear + floor-plan images from NetBox media.
    # Off by default: it fetches binary files over the same session and adds
    # time, so it's opt-in per run.
    with_images = models.BooleanField(default=False)
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
    # Fernet-encrypted {"token": "..."} - cleared on finish.
    secrets = EncryptedJSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["tenant", "-created_at"])]

    def __str__(self) -> str:
        return f"NetBox import {self.url} → {self.tenant_id} ({self.status})"


# ─── External system connections (Windows DHCP/DNS + virtualization) ─────────


class IntegrationSettings(TimestampedModel):
    """Per-tenant master toggles for the external-sync integrations.

    Everything ships OFF: no nav, no endpoints, no scheduled jobs until the
    operator opts in on Settings → Integrations. Enforcement lives in
    ``integrations.toggles`` (viewset mixin + job-time re-check), not the UI.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.OneToOneField(
        "core.Tenant", on_delete=models.CASCADE, related_name="integration_settings"
    )
    dhcp_sync_enabled = models.BooleanField(default=False)
    dns_sync_enabled = models.BooleanField(default=False)
    virtualization_enabled = models.BooleanField(default=False)

    class Meta:
        verbose_name_plural = "integration settings"

    def __str__(self) -> str:
        return f"Integration settings · {self.tenant_id}"


class AddressPlacementMixin(models.Model):
    """Where the addresses a connection discovers are allowed to land.

    A sync records an address only when a containing prefix already exists, and
    it used to look for that prefix in the Global VRF alone - so a prefix moved
    into a VRF made its addresses vanish from sync entirely. These two fields
    say which VRF to look in; ``api.vrf_placement`` does the looking.

    The default (``pinned`` + no VRF = Global) is exactly the behaviour that
    shipped before, so an upgrade changes nothing until an operator chooses.
    """

    class Meta:
        abstract = True

    vrf_mode = models.CharField(
        max_length=8, choices=VRF_MODE_CHOICES, default=PINNED,
        help_text="Whether to look outside the chosen VRF when nothing there "
                  "contains a discovered address.",
    )
    vrf = models.ForeignKey(
        "api.VRF",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
        help_text="Routing context for addresses this connection discovers. "
                  "NULL = Global VRF.",
    )
    #: What the last run saw but couldn't record - an address with no
    #: containing prefix, a host with no matching site. Not errors: the sync
    #: succeeded. Bounded on write, since a scheduled run has no toast.
    last_sync_skipped = models.JSONField(default=list, blank=True)

    def record_skipped(self, warnings, *, summary="", cap: int = 20) -> list[str]:
        """Trim a run's skipped notes to something a badge can hold.

        A cluster with no prefixes modelled yet can produce hundreds of these,
        and hundreds of near-identical lines carry no more information than a
        handful. So: the ``summary`` states the count and the remedy once,
        then a deduplicated sample of the individual addresses follows.
        """
        seen: list[str] = []
        for w in warnings:
            if w and w not in seen:
                seen.append(w)
        if len(seen) > cap:
            seen = seen[:cap] + [f"… and {len(seen) - cap} more"]
        self.last_sync_skipped = ([summary] if summary else []) + seen
        return self.last_sync_skipped


class WindowsServerConnection(AddressPlacementMixin, TimestampedModel):
    """One Windows server reached agentlessly over WinRM.

    A single connection can serve both the DHCP and DNS roles (they usually
    live on the same box). The password is Fernet-encrypted at rest and
    write-only through the API. Outbound connects go through the same
    deployment SSRF allowlist as the NetBox importer - an internal host must
    be allow-listed under Settings → Deployment before Danbyte will talk to it.
    """

    AUTH_CHOICES = [("ntlm", "NTLM"), ("kerberos", "Kerberos")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="windows_connections"
    )
    name = models.CharField(max_length=200)
    host = models.CharField(max_length=255)
    port = models.PositiveIntegerField(default=5985)
    use_tls = models.BooleanField(default=False)
    # Most WinRM-over-HTTPS deployments run self-signed certs; strict
    # verification is the opt-in, mirroring the issue's recommendation.
    verify_ssl = models.BooleanField(default=False)
    auth_mode = models.CharField(max_length=16, choices=AUTH_CHOICES, default="ntlm")
    username = models.CharField(max_length=255)
    # Fernet-encrypted {"password": "..."} - write-only in serializers.
    credentials = EncryptedJSONField(default=dict, blank=True)

    dhcp_enabled = models.BooleanField(default=False)
    dns_enabled = models.BooleanField(default=False)
    poll_interval_minutes = models.PositiveIntegerField(default=5)
    enabled = models.BooleanField(default=True)

    last_sync_at = models.DateTimeField(null=True, blank=True)
    last_sync_status = models.CharField(max_length=16, blank=True, default="")
    last_sync_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_winconn_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.host})"


class VirtualizationSource(AddressPlacementMixin, TimestampedModel):
    """A hypervisor/cluster API Danbyte syncs virtual machines from.

    ``kind`` picks the client; Proxmox is the first implementation and vCenter
    slots in behind the same model later. Credentials are kind-shaped -
    Proxmox: ``{"token_id": "user@realm!name", "secret": "..."}`` - and
    write-only through the API.
    """

    KIND_CHOICES = [("proxmox", "Proxmox VE"), ("vcenter", "VMware vCenter")]

    #: How discovered changes reach the inventory. ``auto`` mirrors the
    #: hypervisor (it becomes the source of truth); ``review`` and ``manual``
    #: keep Danbyte the source of truth - nothing changes without a human
    #: accepting it. ``review`` still polls on a schedule to *detect*; ``manual``
    #: only detects when you run a sync by hand.
    MODE_CHOICES = [
        ("auto", "Automatic (mirror)"),
        ("review", "Review (scheduled detect, apply on accept)"),
        ("manual", "Manual (detect on demand, apply on accept)"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="virtualization_sources"
    )
    name = models.CharField(max_length=200)
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, default="proxmox")
    host = models.CharField(max_length=255)
    port = models.PositiveIntegerField(default=8006)
    verify_ssl = models.BooleanField(default=False)
    credentials = EncryptedJSONField(default=dict, blank=True)

    # Default to review: a fresh connection shouldn't silently reshape the
    # inventory before an operator has seen what it would do.
    sync_mode = models.CharField(max_length=8, choices=MODE_CHOICES, default="review")
    poll_interval_minutes = models.PositiveIntegerField(default=10)
    enabled = models.BooleanField(default=True)

    # Granular sync scope (under the tenant's virtualization master toggle).
    #: Per-disk inventory (VirtualDisk rows) in addition to aggregate disk_gb.
    sync_disks = models.BooleanField(default=True)
    #: Virtual switches + networks (port-groups/bridges → VLANs).
    sync_networks = models.BooleanField(default=False)
    #: Create the hypervisor's own nodes/hosts as Devices. Off by default:
    #: this writes into the physical inventory, which is the operator's
    #: territory. The site comes from placement rules when they resolve one;
    #: the device type stays theirs - nothing on the wire says what it is.
    sync_hosts = models.BooleanField(default=False)

    last_sync_at = models.DateTimeField(null=True, blank=True)
    last_sync_status = models.CharField(max_length=16, blank=True, default="")
    last_sync_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_virtsource_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.get_kind_display()})"


class VirtPlacementRule(TimestampedModel):
    """Which Site a synced host or VM belongs to, decided by where it sits.

    Operators asked for this as a config string keyed on management IP
    (``192.168.110.* = UA``). Two problems with that: a host's address isn't in
    the sync payload at all, and a site name in a string is a name Danbyte has
    to trust. So a rule matches the hypervisor's own **structure** - datacenter,
    folder, cluster or host name - and points at a real :class:`api.Site`, which
    makes "never invent a Site" a property of the schema rather than a check
    someone has to remember.

    Resolution is **nearest wins**: host beats folder beats cluster beats
    datacenter, and for folders the closest matching ancestor wins, so a rule on
    ``Test site`` covers ``Test site / Linux`` without a rule per subfolder.
    ``weight`` only breaks ties within one level - nobody should have to reason
    about global ordering to override a single machine.
    """

    #: Ordered outermost → innermost. The index is the specificity, so
    #: `SCOPE_ORDER.index(scope)` ranks two matches against each other.
    SCOPE_ORDER = ["datacenter", "cluster", "folder", "host"]
    SCOPE_CHOICES = [
        ("datacenter", "Datacenter"),
        ("cluster", "Cluster"),
        ("folder", "Folder"),
        ("host", "Host"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source = models.ForeignKey(
        VirtualizationSource, on_delete=models.CASCADE,
        related_name="placement_rules",
    )
    scope = models.CharField(max_length=12, choices=SCOPE_CHOICES)
    #: Glob by default (``Lab*``, ``*-DR``) because that is what operators
    #: write; a ``regex:`` prefix opts into a regular expression for the cases
    #: a glob can't express. A folder pattern may match the folder's own name
    #: or its ``/``-joined path.
    pattern = models.CharField(
        max_length=255,
        help_text="Glob such as Lab* or *-DR. Prefix with regex: for a regular "
                  "expression. Folder patterns match the name or the full path.",
    )
    site = models.ForeignKey(
        "api.Site", on_delete=models.CASCADE, related_name="virt_placement_rules"
    )
    location = models.ForeignKey(
        "api.Location", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="virt_placement_rules",
        help_text="Optional. Ignored unless it belongs to the site above.",
    )
    #: Tie-break within one scope only.
    weight = models.PositiveSmallIntegerField(default=100)

    class Meta:
        ordering = ["weight", "pattern"]
        indexes = [models.Index(fields=["source", "scope"])]

    def __str__(self) -> str:
        return f"{self.get_scope_display()} {self.pattern} → {self.site_id}"


# ─── Windows DHCP sync state ──────────────────────────────────────────────────


class DhcpScope(TimestampedModel):
    """Mirror of one Windows DHCP scope, linked to the Prefix it syncs into.

    The IPAM objects (Prefix / IPRange / IPAddress) stay clean: everything
    DHCP-specific - scope identity, options, lease-sync opt-in - lives here,
    so a synced prefix is an ordinary prefix that happens to have a scope row
    pointing at it.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    # Null connection = a **local** scope: authored and owned by Danbyte, with
    # no DHCP server behind it (documentation of DHCP space for deployments
    # that don't sync a Windows server). Local scopes carry `tenant` directly;
    # synced scopes ride their connection's tenant.
    connection = models.ForeignKey(
        WindowsServerConnection, on_delete=models.CASCADE,
        related_name="dhcp_scopes", null=True, blank=True,
    )
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="dhcp_scopes",
        null=True, blank=True,
    )
    scope_id = models.CharField(max_length=64)  # Windows scope id, e.g. "10.77.0.0"
    name = models.CharField(max_length=255, blank=True, default="")
    description = models.TextField(blank=True, default="")
    state = models.CharField(max_length=32, blank=True, default="")
    start_range = models.GenericIPAddressField(null=True, blank=True)
    end_range = models.GenericIPAddressField(null=True, blank=True)
    subnet_mask = models.GenericIPAddressField(null=True, blank=True)
    lease_duration = models.CharField(max_length=64, blank=True, default="")
    # [{"option_id": 3, "name": "Router", "value": ["10.77.0.1"]}, …] - kept
    # structured (not flattened) so scope options stay inspectable.
    options = models.JSONField(default=list, blank=True)
    prefix = models.ForeignKey(
        "api.Prefix", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="dhcp_scopes",
    )
    # Lease sync is opt-in per scope: leases churn, and syncing them all by
    # default would flood the DB for large scopes.
    lease_sync = models.BooleanField(default=False)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["scope_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "scope_id"], name="uniq_dhcpscope_conn_scope"
            ),
            # Local scopes have no connection - dedupe them per tenant instead
            # (NULL connections are distinct, so the pair above can't).
            models.UniqueConstraint(
                fields=["tenant", "scope_id"],
                condition=models.Q(connection__isnull=True),
                name="uniq_dhcpscope_local_tenant_scope",
            ),
        ]

    @property
    def is_local(self) -> bool:
        return self.connection_id is None

    def __str__(self) -> str:
        return f"{self.scope_id} ({self.name})"


class DhcpExclusion(TimestampedModel):
    """One exclusion range of a scope, linked to the IPRange it created."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scope = models.ForeignKey(
        DhcpScope, on_delete=models.CASCADE, related_name="exclusions"
    )
    start_address = models.GenericIPAddressField()
    end_address = models.GenericIPAddressField()
    ip_range = models.ForeignKey(
        "api.IPRange", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="dhcp_exclusions",
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["scope", "start_address", "end_address"],
                name="uniq_dhcpexcl_scope_range",
            )
        ]

    def __str__(self) -> str:
        return f"{self.start_address}–{self.end_address}"


class DhcpReservation(TimestampedModel):
    """One DHCP reservation, mirrored from - or pushed to - the server.

    ``managed`` marks rows Danbyte owns (created/edited here and pushed out);
    on those, a change made directly in the Windows console is recorded as
    ``drift`` for review instead of being silently adopted or overwritten.
    """

    DRIFT_CHOICES = [
        ("", "In sync"),
        ("modified", "Modified on server"),
        ("missing", "Missing on server"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scope = models.ForeignKey(
        DhcpScope, on_delete=models.CASCADE, related_name="reservations"
    )
    ip = models.GenericIPAddressField()
    mac = models.CharField(max_length=64, blank=True, default="")
    name = models.CharField(max_length=255, blank=True, default="")
    description = models.TextField(blank=True, default="")
    ip_address = models.ForeignKey(
        "api.IPAddress", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="dhcp_reservations",
    )
    managed = models.BooleanField(default=False)
    drift = models.CharField(
        max_length=16, choices=DRIFT_CHOICES, blank=True, default=""
    )
    # {"field": {"danbyte": …, "server": …}} for the drift-review UI.
    drift_detail = models.JSONField(default=dict, blank=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["ip"]
        constraints = [
            models.UniqueConstraint(
                fields=["scope", "ip"], name="uniq_dhcpres_scope_ip"
            )
        ]

    def __str__(self) -> str:
        return f"{self.ip} → {self.mac}"


class DhcpLease(TimestampedModel):
    """A synced lease (only for scopes with lease sync switched on)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    scope = models.ForeignKey(
        DhcpScope, on_delete=models.CASCADE, related_name="leases"
    )
    ip = models.GenericIPAddressField()
    mac = models.CharField(max_length=64, blank=True, default="")
    hostname = models.CharField(max_length=255, blank=True, default="")
    address_state = models.CharField(max_length=32, blank=True, default="")
    expires_at = models.DateTimeField(null=True, blank=True)
    ip_address = models.ForeignKey(
        "api.IPAddress", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="dhcp_leases",
    )
    # True when the sync created the IPAddress row itself - only those are
    # cleaned up again when the lease disappears; rows an operator already had
    # (or has since edited) are never deleted by lease churn.
    created_ip = models.BooleanField(default=False)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["ip"]
        constraints = [
            models.UniqueConstraint(
                fields=["scope", "ip"], name="uniq_dhcplease_scope_ip"
            )
        ]

    def __str__(self) -> str:
        return f"{self.ip} lease → {self.mac}"


# ─── Windows DNS sync state ───────────────────────────────────────────────────


class DnsZone(TimestampedModel):
    """One zone on a Windows DNS server. Zones are always *listed*; record
    reconciliation is opt-in per zone via ``sync`` (AD deployments carry
    system zones nobody wants reconciled)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    connection = models.ForeignKey(
        WindowsServerConnection, on_delete=models.CASCADE, related_name="dns_zones"
    )
    name = models.CharField(max_length=255)
    zone_type = models.CharField(max_length=32, blank=True, default="")
    is_reverse = models.BooleanField(default=False)
    sync = models.BooleanField(default=False)
    # Opt-in: when reconciling, create an IPAddress for any record whose
    # address isn't in IPAM yet (only where a containing prefix exists). Off by
    # default - zero-prefilled-data means importing is a deliberate choice.
    auto_create = models.BooleanField(default=False)
    # Authored in Danbyte (not mirrored from a server). Managed zones are never
    # pruned by sync - Danbyte is their source of truth. Mirrors DnsRecord.managed.
    managed = models.BooleanField(default=False)
    record_count = models.PositiveIntegerField(default=0)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "name"], name="uniq_dnszone_conn_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class DnsDrift(TimestampedModel):
    """A disagreement between a zone's records and an IP's DNS name.

    ``mismatch``: the record for this IP names something else than the IP's
    ``dns_name``. ``missing_record``: the IP carries a name inside this zone
    but the zone has no record for it. Rows are recomputed on every sync and
    resolved by the operator (accept the server / push Danbyte's version) -
    never auto-applied.
    """

    KIND_CHOICES = [
        ("mismatch", "Name differs"),
        ("missing_record", "No record on server"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    zone = models.ForeignKey(DnsZone, on_delete=models.CASCADE, related_name="drifts")
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    record_type = models.CharField(max_length=8, blank=True, default="")  # A/AAAA/PTR
    ip = models.GenericIPAddressField()
    ip_address = models.ForeignKey(
        "api.IPAddress", on_delete=models.CASCADE, related_name="dns_drifts"
    )
    danbyte_name = models.CharField(max_length=255, blank=True, default="")
    server_name = models.CharField(max_length=255, blank=True, default="")
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["ip"]
        constraints = [
            models.UniqueConstraint(
                fields=["zone", "ip", "record_type"], name="uniq_dnsdrift_zone_ip_type"
            )
        ]

    def __str__(self) -> str:
        return f"{self.ip}: {self.danbyte_name!r} vs {self.server_name!r}"


# ─── Virtualization sync state ────────────────────────────────────────────────


class VirtGuest(TimestampedModel):
    """One hypervisor guest, linked to the VirtualMachine it syncs into.

    ``created_vm`` marks VMs the sync minted itself - only those are removed
    again when the guest disappears from the hypervisor; VMs an operator
    already had are adopted and never deleted by sync.
    """

    KIND_CHOICES = [("qemu", "QEMU"), ("lxc", "LXC"), ("vmware", "VMware VM")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source = models.ForeignKey(
        VirtualizationSource, on_delete=models.CASCADE, related_name="guests"
    )
    # Proxmox: the integer VMID. vCenter: the numeric part of the VM MoRef
    # (``vm-1023`` → ``1023``), which is stable for the VM's lifetime.
    vmid = models.PositiveIntegerField()
    node = models.CharField(max_length=128, blank=True, default="")
    kind = models.CharField(max_length=8, choices=KIND_CHOICES, default="qemu")
    vm = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="virt_guests",
    )
    created_vm = models.BooleanField(default=False)
    power_state = models.CharField(max_length=16, blank=True, default="")
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["vmid"]
        constraints = [
            models.UniqueConstraint(
                fields=["source", "vmid"], name="uniq_virtguest_source_vmid"
            )
        ]

    def __str__(self) -> str:
        return f"{self.kind}/{self.vmid} on {self.node}"


class VirtChange(TimestampedModel):
    """A discovered difference between the hypervisor and Danbyte's inventory,
    awaiting a human decision (review/manual modes) - the review inbox.

    In ``auto`` mode changes are applied straight away and no rows land here.
    In ``review``/``manual`` mode each detected difference is recorded once and
    resolved by **accept** (apply it) or **ignore** (dismiss until it changes
    again), so Danbyte stays the source of truth.
    """

    KIND_CHOICES = [
        ("new_guest", "New VM on hypervisor"),
        ("spec_change", "Specs changed"),
        ("removed_guest", "VM removed from hypervisor"),
        ("iface_extra", "Interface not on hypervisor"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source = models.ForeignKey(
        VirtualizationSource, on_delete=models.CASCADE, related_name="changes"
    )
    guest = models.ForeignKey(
        VirtGuest, on_delete=models.CASCADE, related_name="changes"
    )
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)
    vm = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="virt_changes",
    )
    # For new_guest: the proposed VM attributes. For spec_change:
    # {field: {"danbyte": …, "hypervisor": …}}. For removed_guest: {}.
    detail = models.JSONField(default=dict, blank=True)
    # Dismissed by the operator: kept (so detection doesn't re-raise it) but
    # hidden from the default inbox until it's accepted or the guest goes away.
    ignored = models.BooleanField(default=False)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["kind", "guest__vmid"]
        constraints = [
            models.UniqueConstraint(
                fields=["guest", "kind"], name="uniq_virtchange_guest_kind"
            )
        ]

    def __str__(self) -> str:
        return f"{self.kind} · {self.guest_id}"


class VirtNetwork(TimestampedModel):
    """Maps one hypervisor network - a vCenter port-group or a Proxmox bridge
    (optionally with a VLAN tag) - to the :class:`api.VLAN` it reconciles into,
    mirroring how :class:`DhcpScope` links to a Prefix. Danbyte's VLAN stays the
    source of truth; ``created_vlan`` marks VLANs the sync minted so only those
    are pruned. Optionally records the owning virtual switch."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    source = models.ForeignKey(
        VirtualizationSource, on_delete=models.CASCADE, related_name="networks"
    )
    # Stable key: port-group MoRef (vCenter) or "bridge[:tag]" (Proxmox).
    ext_key = models.CharField(max_length=255)
    name = models.CharField(max_length=255, blank=True, default="")
    vlan = models.ForeignKey(
        "api.VLAN", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="virt_networks",
    )
    vswitch = models.ForeignKey(
        "api.VirtualSwitch", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="virt_networks",
    )
    # A vSwitch trunks many VLANs and the routing domain follows the segment,
    # so the port-group is the finer - and usually the correct - place to say
    # which VRF its addresses live in. NULL = follow the switch, then the
    # source. PROTECT (not SET_NULL like the links above) because this is
    # operator policy: silently reverting it to "follow the source" is the
    # class of quiet misplacement this whole feature exists to remove.
    vrf = models.ForeignKey(
        "api.VRF", on_delete=models.PROTECT, null=True, blank=True,
        related_name="virt_networks",
        help_text="Routing context for addresses on this network. Leave empty "
                  "to follow the virtual switch, then the sync source.",
    )
    created_vlan = models.BooleanField(default=False)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["name", "ext_key"]
        constraints = [
            models.UniqueConstraint(
                fields=["source", "ext_key"], name="uniq_virtnetwork_source_key"
            )
        ]

    def __str__(self) -> str:
        return self.name or self.ext_key


class DnsRecord(TimestampedModel):
    """An address record (A/AAAA/PTR) mirrored from a reconciled DNS zone,
    linked to the IPAddress it concerns.

    Persisted so DNS data is queryable from IPAM (the prefix and IP pages) and
    presentable as a real table - without a live WinRM call per view. Only
    reconciled (``sync=True``) zones populate records; the set is bounded and
    stable, and rows are pruned each sync like drift. High-churn, so it is
    RBAC-registered but deliberately **not** audited.
    """

    RTYPE_CHOICES = [
        ("A", "A"), ("AAAA", "AAAA"), ("CNAME", "CNAME"), ("MX", "MX"),
        ("TXT", "TXT"), ("NS", "NS"), ("SRV", "SRV"), ("PTR", "PTR"),
        ("CAA", "CAA"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    zone = models.ForeignKey(
        DnsZone, on_delete=models.CASCADE, related_name="records"
    )
    name = models.CharField(max_length=255)  # FQDN
    record_type = models.CharField(max_length=8, choices=RTYPE_CHOICES)
    data = models.CharField(max_length=255)  # value: IP, target, "10 mail…", text
    # Only address records (A/AAAA/PTR) carry an IP; nullable for other types.
    ip = models.GenericIPAddressField(null=True, blank=True)
    ip_address = models.ForeignKey(
        "api.IPAddress", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="dns_records",
    )
    ttl = models.CharField(max_length=32, blank=True, default="")
    # Authored in Danbyte (the source of truth) rather than mirrored from a
    # Windows server. Managed records are user-editable and are NEVER pruned by
    # the sync (which only owns the records it observed).
    managed = models.BooleanField(default=False)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["name"]
        indexes = [
            models.Index(fields=["zone", "ip"]),
            models.Index(fields=["ip_address"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["zone", "name", "record_type", "data"],
                name="uniq_dnsrecord_zone_name_type_data",
            )
        ]

    def __str__(self) -> str:
        return f"{self.name} {self.record_type} {self.data}"
