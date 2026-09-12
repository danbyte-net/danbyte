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
    #: The monitoring engines that read through this connection.
    #:
    #: Explicit, because the alternative was matching on the engine's *name*
    #: and falling back to whichever connection sorted first - so a renamed
    #: engine, or a second Zabbix server, read somebody else's hosts with no
    #: error to say so. An engine with no connection is simply not usable,
    #: which is the honest answer rather than a guess.
    #:
    #: Lives here rather than on the engine because ``monitoring`` must not
    #: depend on ``zabbix`` - the same direction every other integration link
    #: points.
    engines = models.ManyToManyField(
        "monitoring.MonitoringEngine",
        related_name="zabbix_connections",
        blank=True,
    )
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
    #: Which devices get a host. Two honest answers, and they suit different
    #: deployments:
    #:
    #: ``checks`` - the devices with a Zabbix check, i.e. the ones an operator
    #: asked Zabbix to *watch*. Zabbix is the monitoring engine for them.
    #:
    #: ``rules`` - every device the provisioning rules below match, whether or
    #: not Zabbix watches it. This is for the estate where Danbyte does the
    #: pinging, discovery and TLS checks and Zabbix is fed from Danbyte as the
    #: source of truth. Without it a rule saying "every device" could only ever
    #: mean "every device somebody had already bound to Zabbix by hand", which
    #: is not what the rule says.
    SCOPE_CHECKS, SCOPE_RULES = "checks", "rules"
    PROVISION_SCOPE_CHOICES = [
        (SCOPE_CHECKS, "Devices with a Zabbix check"),
        (SCOPE_RULES, "Every device the rules match"),
    ]
    #: Defaults to ``checks`` so no existing connection changes what it writes.
    provision_scope = models.CharField(
        max_length=8, choices=PROVISION_SCOPE_CHOICES, default=SCOPE_CHECKS
    )
    #: Run the sync pass on a timer. Separate from ``provision_mode`` on
    #: purpose: *when it runs* and *what it does with what it finds* are two
    #: decisions. Auto-sync with review mode keeps the queue fresh for someone
    #: to approve; with auto mode it is hands-off.
    auto_sync = models.BooleanField(default=False)
    sync_interval_minutes = models.PositiveIntegerField(default=60)
    last_sync_at = models.DateTimeField(null=True, blank=True)
    last_sync_summary = models.JSONField(default=dict, blank=True)

    #: Delete a Zabbix host Danbyte created and no longer sees a reason for.
    #: Off, like everywhere else - Danbyte does not delete records it did not
    #: get asked to delete, least of all in somebody else's system.
    prune_hosts = models.BooleanField(default=False)
    #: How long a host must stay unwanted before pruning acts, so one bad pass
    #: cannot empty a monitoring system.
    prune_after_days = models.PositiveSmallIntegerField(default=7)

    #: Write the device's resolved SNMP credentials into Zabbix as host
    #: macros. **Off by default, and deliberately its own switch**: creating a
    #: host is inventory, handing over a community string is handing a
    #: credential to another system, and one is not the other. Only ever set on
    #: a host Danbyte is creating - after that the macro is Zabbix's.
    send_snmp_credentials = models.BooleanField(default=False)

    #: Zabbix trigger severity (0-5, as a string key) -> Danbyte status.
    #: Editable because where an estate draws the line between "worth a colour"
    #: and "worth a page" is an operational decision. Empty = the defaults in
    #: :mod:`zabbix.severity`.
    severity_map = models.JSONField(default=dict, blank=True)

    # ── what the last connection test learned ──────────────────────────
    version = models.CharField(max_length=32, blank=True, default="")
    last_checked_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")

    # ── two-way (#162 phase 5) ─────────────────────────────────────────
    #: Mirror Danbyte's maintenance and outage windows as Zabbix maintenance
    #: periods, for the hosts this connection has linked. Its own switch,
    #: independent of provisioning: scheduling a window is a different act
    #: from creating hosts, and an estate that Zabbix owns entirely may still
    #: want Danbyte's calendar to be the one that quiets it.
    sync_maintenance = models.BooleanField(default=False)
    last_maintenance_sync_at = models.DateTimeField(null=True, blank=True)
    #: Acknowledging a Danbyte alert acknowledges the Zabbix problems behind
    #: it, with the operator's name and note. Off by default like every write.
    write_acknowledgements = models.BooleanField(default=False)

    # ── adoption (#162 phase 6) ────────────────────────────────────────
    #: Propose a Danbyte device for every Zabbix host Danbyte has no device
    #: for - an existing Zabbix as the way into Danbyte. Off: reading a host
    #: list is one thing, minting inventory rows from it is another.
    adopt_hosts = models.BooleanField(default=False)
    #: Record what Zabbix's host inventory says about a linked device, so a
    #: disagreement shows in the device's drift inbox. Free - it rides the host
    #: read the provisioning pass already makes - but it puts rows in front of
    #: an operator, so it is theirs to ask for.
    read_inventory = models.BooleanField(default=False)
    #: Where an adopted device lands when no host group names one of the
    #: tenant's sites, and what it is when the inventory does not say. All
    #: three are needed for a proposal to be applicable; a proposal without
    #: them waits, and says what it is waiting for.
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

    def sync_due(self, now) -> bool:
        """Whether the beat should run this connection now.

        Every gate in one place, so the timer and the button cannot disagree
        about what "due" means.
        """
        if not (self.enabled and self.auto_sync):
            return False
        if self.provision_mode == self.OFF:
            return False
        if self.last_sync_at is None:
            return True
        from datetime import timedelta

        return now - self.last_sync_at >= timedelta(
            minutes=max(self.sync_interval_minutes, 1)
        )

    def maintenance_due(self, now) -> bool:
        """Whether the periodic reconcile should run - same cadence as the
        provisioning pass, its own stamp, so it runs with provisioning off."""
        if not self.sync_maintenance:
            return False
        if self.last_maintenance_sync_at is None:
            return True
        from datetime import timedelta

        return now - self.last_maintenance_sync_at >= timedelta(
            minutes=max(self.sync_interval_minutes, 1)
        )

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
    #: Templates a rule says the host should carry and does not. Its own kind
    #: rather than an update: it is a different API call, and "link two
    #: templates" is a different thing to agree to than "rename a host".
    TEMPLATE = "link_template"
    AMBIGUOUS = "ambiguous"
    PRUNE = "prune_host"
    #: The other direction: a Zabbix host Danbyte has no device for becomes
    #: one. Keyed by ``detail.hostid`` rather than a device, since the device
    #: is what applying it makes.
    ADOPT = "adopt_host"
    #: Every label names the system that changes. "Create host" beside a host
    #: group called "Danbyte estate" read as creating something in Danbyte,
    #: which is the opposite of what it does.
    KIND_CHOICES = [
        (CREATE, "Create in Zabbix"),
        (UPDATE, "Update in Zabbix"),
        (TEMPLATE, "Link in Zabbix"),
        (AMBIGUOUS, "Needs a decision"),
        (PRUNE, "Remove from Zabbix"),
        (ADOPT, "Adopt into Danbyte"),
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


class ZabbixProvisionRule(TimestampedModel):
    """What a device Danbyte provisions should carry in Zabbix.

    A host with no template is an empty host: Zabbix shows it, and it collects
    nothing. Danbyte already knows what a device *is* - its role, its platform,
    its model, who made it - and that is exactly the question a template
    answers, so the mapping belongs here rather than in somebody's head.

    Rules **stack**. Every rule that matches contributes its templates, so
    "everything gets ICMP Ping", "switches also get Generic SNMP" and "Cisco
    also gets Cisco IOS by SNMP" are three rules, not one combinatorial list.
    Duplicates collapse.

    Templates are named, not referenced by id: a Zabbix template id means
    nothing on the next server, and the name is what the operator reads. A
    name Zabbix does not have is reported, never invented.

    Scoped by ``scope`` + ``object_id`` rather than four nullable foreign keys
    - the same shape :class:`monitoring.models.SnmpProfileBinding` uses, and
    for the same reason: ``zabbix`` referencing ``api`` ids by value keeps the
    dependency pointing one way.
    """

    SCOPE_TENANT = "tenant"
    SCOPE_SITE = "site"
    SCOPE_ROLE = "role"
    SCOPE_PLATFORM = "platform"
    SCOPE_TYPE = "device_type"
    SCOPE_MANUFACTURER = "manufacturer"
    SCOPE_CHOICES = [
        (SCOPE_TENANT, "Every device"),
        (SCOPE_SITE, "Site"),
        (SCOPE_ROLE, "Device role"),
        (SCOPE_PLATFORM, "Platform"),
        (SCOPE_TYPE, "Device type"),
        (SCOPE_MANUFACTURER, "Manufacturer"),
    ]
    #: For the one thing a host has exactly one of - its proxy - the most
    #: specific matching rule wins rather than stacking. A site is the whole
    #: point of a proxy, so it ranks first.
    PROXY_PRECEDENCE = (
        SCOPE_SITE, SCOPE_ROLE, SCOPE_PLATFORM, SCOPE_TYPE,
        SCOPE_MANUFACTURER, SCOPE_TENANT,
    )

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="zabbix_provision_rules"
    )
    connection = models.ForeignKey(
        ZabbixConnection, on_delete=models.CASCADE, related_name="provision_rules"
    )
    scope = models.CharField(max_length=16, choices=SCOPE_CHOICES)
    #: The role / platform / type / manufacturer this rule is about. Null for
    #: the tenant-wide rule, which is the only scope that has no object.
    object_id = models.UUIDField(null=True, blank=True)
    #: Zabbix template names, e.g. ["ICMP Ping", "Cisco IOS by SNMP"].
    templates = models.JSONField(default=list, blank=True)
    #: Zabbix host group names. Groups are how Zabbix scopes permissions,
    #: dashboards and actions, so which groups a host belongs in is the same
    #: kind of question a template is - and it was the one thing here still
    #: hard-coded, to the device's site name. Empty leaves that default alone.
    groups = models.JSONField(default=list, blank=True)
    #: The Zabbix proxy the host is monitored through, by name. Blank = no
    #: opinion. Unlike templates and groups this does not stack - a host has
    #: one - so the most specific rule that names one wins, and Danbyte only
    #: ever sets it on a host that is on the server: moving a host between
    #: proxies is somebody's decision, not a rule's.
    proxy = models.CharField(max_length=128, blank=True, default="")
    enabled = models.BooleanField(default=True)

    class Meta:
        ordering = ["scope", "-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "scope", "object_id"],
                name="uniq_zbx_tplrule_conn_scope_object",
                nulls_distinct=False,
            )
        ]

    def __str__(self) -> str:
        return f"{self.scope}:{self.object_id or '*'}"


class ZabbixMaintenance(TimestampedModel):
    """The Zabbix maintenance period a Danbyte window is mirrored as.

    Stored so an update or a cancellation addresses the *same* period rather
    than creating a second one, and so a window that left Zabbix's side (the
    event deleted, its status closed, its devices removed) can be taken back
    out. ``event`` is nullable on purpose: an event deleted in Danbyte leaves
    the row behind as an orphan the next pass deletes in Zabbix - a CASCADE
    would drop the id and strand the period.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="zabbix_maintenances"
    )
    connection = models.ForeignKey(
        ZabbixConnection, on_delete=models.CASCADE, related_name="maintenances"
    )
    event = models.ForeignKey(
        "monitoring.MaintenanceEvent",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="zabbix_maintenances",
    )
    maintenanceid = models.CharField(max_length=32)
    #: The name as written, so a rename on either side is visible.
    name = models.CharField(max_length=128)
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    #: Host ids the period covers, as last written.
    hostids = models.JSONField(default=list, blank=True)
    synced_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["-starts_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "event"],
                name="uniq_zbx_maintenance_conn_event",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} -> {self.maintenanceid}"


class ZabbixHostFacts(TimestampedModel):
    """What Zabbix knows about a linked device, as an *observed* store.

    Shaped like :class:`~monitoring.models.DeviceSnmp` on purpose - ``data``,
    ``interfaces``, ``polled_at`` and ``reachable`` are exactly the attributes
    the drift engine reads - so a Zabbix observation lands in the drift inbox
    an operator already reads instead of needing a second one.

    Separate from ``DeviceSnmp`` rather than written into it: that row is one
    per device and carries an SNMP profile, so a device both pollers see would
    flap between two observations and the profile would be a lie for half of
    them.

    Never the source of truth. Nothing here reaches a ``Device`` field until
    somebody accepts the drift item it raises.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="zabbix_facts"
    )
    connection = models.ForeignKey(
        ZabbixConnection, on_delete=models.CASCADE, related_name="facts"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="zabbix_facts"
    )
    #: System facts, under the keys the drift engine reads: ``sys_name``,
    #: ``serial``, plus what Zabbix's inventory carries for context.
    data = models.JSONField(default=dict, blank=True)
    #: Reserved for interface presence, which is a separate read and a
    #: separate switch. Empty means "not looked at", never "no interfaces".
    interfaces = models.JSONField(default=list, blank=True)
    polled_at = models.DateTimeField(null=True, blank=True)
    #: Whether Zabbix could reach the host when it last said. ``None`` while
    #: unknown - the drift engine treats a False as "no observation" rather
    #: than reading every field as changed.
    reachable = models.BooleanField(null=True, blank=True)

    class Meta:
        ordering = ["-polled_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["connection", "device"], name="uniq_zbx_facts_conn_device"
            )
        ]

    def __str__(self) -> str:
        return f"{self.device_id} facts"
