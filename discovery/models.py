"""Built-in discovery (#451, phase B2): authenticated package inventory.

Tenant-scoped throughout. Configuration is audited (``DiscoverySettings``,
``InventoryProfile``); what a run reads is machine data written in bulk and
never change-logged (``InventoryRun`` bookkeeping, ``InventoryHostResult``,
``HostOsFact``, ``HostPackage``) - the same split as vulnerability matches.

Nothing is seeded. Discovery is off until a deployment admin allows it
(``discovery.gate``) **and** a tenant admin turns the Discovery
integration on; a profile then runs only once someone has recorded who
authorised it (decision 11).

B3 adds the service scan: a profile of kind ``service_scan`` (the same
model, gates and runs), :class:`ObservedService` rows (machine data) and
:class:`FindingDecision` (what a person ignored in the review queue).
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from api.models import NumIdMixin
from core.models import TimestampedModel

RUN_STATUSES = [
    ("queued", "Queued"),
    ("running", "Running"),
    ("ok", "OK"),
    ("partial", "Partial"),
    ("failed", "Failed"),
    ("skipped", "Skipped"),
    #: Every host was left alone before a login (no credential, no accepted
    #: host key, exempt, …): nothing failed, nothing was read.
    ("nothing_read", "Nothing read"),
]
RUN_TRIGGERS = [("manual", "Run now"), ("schedule", "Schedule")]
#: What a profile does: read packages over SSH/WinRM, or scan TCP ports.
PROFILE_KINDS = [("inventory", "Package inventory"), ("service_scan", "Service scan")]
#: Service-scan connections per second, per profile; the deployment cap
#: ``DANBYTE_DISCOVERY_SCAN_MAX_RATE`` is the ceiling.
SCAN_RATE_DEFAULT = 20
SCAN_ENGINES = [("builtin", "Built-in"), ("nmap", "nmap")]
#: Per-host outcomes. The first block comes from the collector
#: (``danbyte_checks.inventory``), the rest from the scope checks that run
#: before any connection is made.
HOST_STATUSES = [
    ("ok", "OK"),
    ("auth_failed", "Login refused"),
    ("host_key_refused", "Host key not accepted"),
    ("tls_refused", "Certificate not trusted"),
    ("unreachable", "Unreachable"),
    ("timeout", "Timed out"),
    ("unsupported", "Unsupported"),
    ("failed", "Failed"),
    ("no_credential", "No credential"),
    ("no_address", "No address"),
    ("exempt", "Exempt"),
    ("denied", "Deny subnet"),
    ("maintenance", "In maintenance"),
    ("blocked", "Blocked target"),
    # A run on Outposts: why a host was not handed to one.
    ("no_outpost", "No Outpost"),
    ("outpost_offline", "Outpost offline"),
    ("outpost_unsupported", "Outpost cannot run it"),
]
#: Host results that say an Outpost was the reason, not the host.
OUTPOST_STATUSES = ("no_outpost", "outpost_offline", "outpost_unsupported")
#: Where a profile runs: the server's workers, one named Outpost, or the
#: Outpost each host is bound to (the monitoring engine binding rules).
RUNS_ON = [("server", "Server"), ("outpost", "An Outpost"), ("host", "The host's Outpost")]
WORK_STATUSES = [("pending", "Pending"), ("claimed", "Claimed"), ("done", "Done"),
                 ("expired", "Expired")]
#: How a host was read, most secure first. ``ssh`` is a run from before the
#: transports were told apart.
TRANSPORTS = [
    ("ssh_key", "SSH key"),
    ("ssh_password", "SSH password"),
    ("winrm", "WinRM HTTPS"),
    ("ssh", "SSH"),
]
#: ``generic``: a Windows program from the Uninstall keys - inventory only,
#: never matched against OSV (no reliable product identity).
PACKAGE_TYPES = [("deb", "deb"), ("rpm", "rpm"), ("apk", "apk"), ("generic", "generic")]
#: The package types vulnerability matching reads.
MATCHED_TYPES = ("deb", "rpm", "apk")


class DiscoverySettings(TimestampedModel):
    """A tenant's discovery settings beyond the on/off switch, which is the
    Discovery integration toggle (``IntegrationSettings.discovery_enabled``).
    Created on first read with the column defaults. Audited."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.OneToOneField(
        "core.Tenant", on_delete=models.CASCADE, related_name="discovery_settings")
    #: CIDRs nothing in this tenant's discovery ever contacts, in any VRF.
    #: The monitoring deny subnets apply as well.
    deny_subnets = models.JSONField(default=list, blank=True, db_default=[])
    #: The transports discovery may log in with, tried in this order per
    #: host (most secure first). The password switch governs every password
    #: login - Linux and Windows, host and shared credentials. WinRM is off
    #: by default and can be forbidden for the whole deployment
    #: (``DANBYTE_DISCOVERY_WINRM_ALLOWED``).
    ssh_key_enabled = models.BooleanField(default=True, db_default=True)
    ssh_password_enabled = models.BooleanField(default=True, db_default=True)
    winrm_enabled = models.BooleanField(default=False, db_default=False)
    #: Service scans may use nmap (B4): only while the server finds an nmap
    #: binary and the deployment allows it (``discovery.nmap``). Off by
    #: default.
    nmap_enabled = models.BooleanField(default=False, db_default=False)

    class Meta:
        verbose_name = "discovery settings"
        verbose_name_plural = "discovery settings"

    def __str__(self) -> str:
        return "Discovery settings"

    @classmethod
    def for_tenant(cls, tenant) -> DiscoverySettings:
        obj, _ = cls.objects.get_or_create(tenant=tenant)
        return obj


class InventoryProfile(NumIdMixin, TimestampedModel):
    """What to read packages from, when, and who authorised it.

    Scope is the union of the named sites, prefixes, devices and VMs, the
    monitoring policy kinds (regions, VRFs, platforms, device types and
    roles, resolved as a policy of that scope would be) and, when
    ``scope_global`` is set, everything in the tenant; a host is in scope
    when it is named, sits at a named site, its primary address lies in a
    named prefix, or the monitoring resolver puts it in a named kind. A profile runs (on schedule or Run now)
    only while it is enabled, Discovery is on and ``authorised_at`` is set;
    changing the scope clears the authorisation. Audited."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="inventory_profiles")
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default="", db_default="")
    enabled = models.BooleanField(default=False, db_default=False)
    sites = models.ManyToManyField("api.Site", blank=True, related_name="+")
    prefixes = models.ManyToManyField("api.Prefix", blank=True, related_name="+")
    devices = models.ManyToManyField("api.Device", blank=True, related_name="+")
    virtual_machines = models.ManyToManyField("api.VirtualMachine", blank=True,
                                              related_name="+")
    #: The monitoring policy scope kinds (``discovery.shared_scope``),
    #: resolved by the monitoring resolver. Union with the four above.
    regions = models.ManyToManyField("api.Region", blank=True, related_name="+")
    vrfs = models.ManyToManyField("api.VRF", blank=True, related_name="+")
    platforms = models.ManyToManyField("api.Platform", blank=True, related_name="+")
    device_types = models.ManyToManyField("api.DeviceType", blank=True, related_name="+")
    device_roles = models.ManyToManyField("api.DeviceRole", blank=True, related_name="+")
    #: Everything in the tenant. Only ever set on purpose (the API wants a
    #: confirmation); an empty scope reads nothing.
    scope_global = models.BooleanField(default=False, db_default=False)
    #: Hours between scheduled runs; 0 = Run now only.
    interval_hours = models.PositiveIntegerField(default=24, db_default=24)
    #: Daily window (server time) runs may start in; both blank = any time.
    #: An end before the start spans midnight.
    window_start = models.TimeField(null=True, blank=True)
    window_end = models.TimeField(null=True, blank=True)
    max_concurrency = models.PositiveSmallIntegerField(default=4, db_default=4)
    timeout_seconds = models.PositiveSmallIntegerField(default=60, db_default=60)
    #: The recorded authorisation: what was authorised, by whom, when.
    authorisation = models.TextField(blank=True, default="", db_default="")
    authorised_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+")
    authorised_by_name = models.CharField(max_length=150, blank=True, default="",
                                          db_default="")
    authorised_at = models.DateTimeField(null=True, blank=True)
    #: A shared credential tried for every host of this profile right
    #: after the host's own credential, before the shared credentials whose
    #: scope matches (``monitoring.credentials``).
    shared_credential = models.ForeignKey(
        "monitoring.SharedCredential", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+")
    #: ``inventory`` (packages) or ``service_scan`` (TCP ports). Fixed once
    #: created.
    kind = models.CharField(max_length=16, choices=PROFILE_KINDS, default="inventory",
                            db_default="inventory")
    #: Service scan: ports and ``"a-b"`` ranges; empty = the default list
    #: (``danbyte_checks.service_scan.DEFAULT_PORTS``). At most 1,024 ports.
    ports = models.JSONField(default=list, blank=True, db_default=[])
    #: Service scan: new connections per second across the run.
    connects_per_second = models.PositiveSmallIntegerField(default=SCAN_RATE_DEFAULT,
                                                           db_default=SCAN_RATE_DEFAULT)
    #: Service scan engine: Danbyte's own, or an nmap the admin installed
    #: (B4). Both write the same observed services.
    scan_engine = models.CharField(max_length=8, choices=SCAN_ENGINES, default="builtin",
                                   db_default="builtin")
    #: nmap only: ``--version-intensity`` (0-5) and the timing template
    #: ``-T2``-``-T4``.
    nmap_version_intensity = models.PositiveSmallIntegerField(default=2, db_default=2)
    nmap_timing = models.PositiveSmallIntegerField(default=3, db_default=3)
    #: Where it runs. ``server`` (the default) is the core's own workers;
    #: ``outpost`` the one in :attr:`outpost`; ``host`` the Outpost each
    #: host is bound to. A run on Outposts never falls back to the server:
    #: a host whose Outpost cannot take the work is left alone and says why.
    runs_on = models.CharField(max_length=8, choices=RUNS_ON, default="server",
                               db_default="server")
    outpost = models.ForeignKey("monitoring.MonitoringEngine", on_delete=models.SET_NULL,
                                null=True, blank=True, related_name="+")
    #: Bookkeeping, by UPDATE (out of the change log).
    last_run_at = models.DateTimeField(null=True, blank=True, editable=False)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["tenant", "name"],
                                    name="uniq_inventoryprofile_tenant_name"),
        ]

    def __str__(self) -> str:
        return self.name

    @property
    def authorised(self) -> bool:
        return self.authorised_at is not None and bool(self.authorisation.strip())


class InventoryRun(TimestampedModel):
    """One run of a profile. Created when queued; counts and status are
    written by UPDATE as it goes. ``errors`` holds the first 50 messages,
    never a secret."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="inventory_runs")
    profile = models.ForeignKey(InventoryProfile, on_delete=models.CASCADE,
                                related_name="runs")
    trigger = models.CharField(max_length=10, choices=RUN_TRIGGERS, default="manual",
                               db_default="manual")
    #: The profile's kind when the run was queued.
    kind = models.CharField(max_length=16, choices=PROFILE_KINDS, default="inventory",
                            db_default="inventory")
    started_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+")
    started_by_name = models.CharField(max_length=150, blank=True, default="",
                                       db_default="")
    #: Where it ran: ``server`` (the core's own workers) today.
    engine = models.CharField(max_length=64, default="server", db_default="server")
    status = models.CharField(max_length=16, choices=RUN_STATUSES, default="queued",
                              db_default="queued")
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    #: ``{hosts, ok, auth_failed, host_key_refused, unsupported, skipped,
    #: packages, changed, …}``
    #: Run now with "Accept new host keys" ticked: a host with no accepted
    #: key has the key it presents on this run accepted on first use. Never
    #: set on a scheduled run.
    accept_new_host_keys = models.BooleanField(default=False, db_default=False)
    counts = models.JSONField(default=dict, blank=True, db_default={})
    errors = models.JSONField(default=list, blank=True, db_default=[])

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["tenant", "profile", "-created_at"],
                                name="disc_run_profile")]

    def __str__(self) -> str:
        return f"{self.profile_id} run {self.created_at:%Y-%m-%d %H:%M}"


class InventoryHostResult(models.Model):
    """What a run did with one host. Machine data."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey("core.Tenant", on_delete=models.CASCADE, related_name="+")
    run = models.ForeignKey(InventoryRun, on_delete=models.CASCADE,
                            related_name="host_results")
    device = models.ForeignKey("api.Device", on_delete=models.CASCADE, null=True,
                               blank=True, related_name="+")
    virtual_machine = models.ForeignKey("api.VirtualMachine", on_delete=models.CASCADE,
                                        null=True, blank=True, related_name="+")
    #: Service scan: the address scanned (an address need not have a host).
    ip_address = models.ForeignKey("api.IPAddress", on_delete=models.CASCADE, null=True,
                                   blank=True, related_name="+")
    address = models.CharField(max_length=64, blank=True, default="", db_default="")
    status = models.CharField(max_length=20, choices=HOST_STATUSES)
    #: Which transport read it; blank when nothing was contacted.
    transport = models.CharField(max_length=16, choices=TRANSPORTS, blank=True, default="",
                                 db_default="")
    #: Each transport considered for the host, in order:
    #: ``[{transport, outcome, reason}]`` - why one was skipped or what it
    #: answered. Never a secret.
    attempts = models.JSONField(default=list, blank=True, db_default=[])
    #: Whose login was used: ``host`` (its own device credential) or
    #: ``shared: <name>``. Never the secret.
    credential_source = models.CharField(max_length=140, blank=True, default="",
                                         db_default="")
    #: The host's key was accepted on first use by this run.
    key_first_use = models.BooleanField(default=False, db_default=False)
    message = models.CharField(max_length=300, blank=True, default="", db_default="")
    packages = models.PositiveIntegerField(default=0, db_default=0)
    added = models.PositiveIntegerField(default=0, db_default=0)
    removed = models.PositiveIntegerField(default=0, db_default=0)
    updated = models.PositiveIntegerField(default=0, db_default=0)
    #: Service scan: open ports found, and connections made.
    services = models.PositiveIntegerField(default=0, db_default=0)
    connects = models.PositiveIntegerField(default=0, db_default=0)
    #: What read it: ``server``, or ``outpost: <name>``.
    engine = models.CharField(max_length=64, blank=True, default="server",
                              db_default="server")
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["status", "address"]
        constraints = [
            models.CheckConstraint(
                condition=(models.Q(device__isnull=False, virtual_machine__isnull=True)
                           | models.Q(device__isnull=True, virtual_machine__isnull=False)
                           | models.Q(device__isnull=True, virtual_machine__isnull=True,
                                      ip_address__isnull=False)),
                name="disc_hostresult_one_host"),
        ]


class HostOsFact(models.Model):
    """The distro a host reported (``/etc/os-release``) at its last read.
    One row per host; machine data."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey("core.Tenant", on_delete=models.CASCADE, related_name="+")
    device = models.OneToOneField("api.Device", on_delete=models.CASCADE, null=True,
                                  blank=True, related_name="os_fact")
    virtual_machine = models.OneToOneField("api.VirtualMachine", on_delete=models.CASCADE,
                                           null=True, blank=True, related_name="os_fact")
    os_id = models.CharField(max_length=64)
    id_like = models.JSONField(default=list, blank=True, db_default=[])
    version_id = models.CharField(max_length=32, blank=True, default="", db_default="")
    codename = models.CharField(max_length=32, blank=True, default="", db_default="")
    pretty_name = models.CharField(max_length=128, blank=True, default="", db_default="")
    #: The OSV ecosystem its packages are advised under (``Debian:12``,
    #: ``Ubuntu:24.04:LTS``, ``Alpine:v3.22``); blank when unknown.
    ecosystem = models.CharField(max_length=64, blank=True, default="", db_default="")
    package_manager = models.CharField(max_length=8, blank=True, default="", db_default="")
    #: Windows (B2-win): the build and UBR from the CurrentVersion key
    #: (``version_id`` holds the full ``10.0.<build>.<ubr>``), edition,
    #: release (``21H2``), the installed hotfixes ``[{id, description,
    #: installed_on}]`` and the server roles and features.
    build = models.CharField(max_length=16, blank=True, default="", db_default="")
    ubr = models.PositiveIntegerField(null=True, blank=True)
    edition = models.CharField(max_length=64, blank=True, default="", db_default="")
    display_version = models.CharField(max_length=16, blank=True, default="", db_default="")
    hotfixes = models.JSONField(default=list, blank=True, db_default=[])
    features = models.JSONField(default=list, blank=True, db_default=[])
    #: Windows: the registry's ``InstallationType`` as the host wrote it
    #: (``Server`` is Desktop Experience, ``Server Core``, ``Client``) and
    #: the OS architecture in the product table's spelling (``x64``,
    #: ``arm64``, ``x86``); blank when not known.
    installation_type = models.CharField(max_length=32, blank=True, default="",
                                         db_default="")
    architecture = models.CharField(max_length=8, blank=True, default="", db_default="")
    #: How it was read (an InventoryHostResult transport).
    transport = models.CharField(max_length=16, blank=True, default="", db_default="")
    collected_at = models.DateTimeField()
    run = models.ForeignKey(InventoryRun, on_delete=models.SET_NULL, null=True, blank=True,
                            related_name="+")

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(models.Q(device__isnull=False, virtual_machine__isnull=True)
                           | models.Q(device__isnull=True, virtual_machine__isnull=False)),
                name="disc_osfact_one_host"),
        ]


class HostPackage(models.Model):
    """One installed package on one device or VM, as its last full read saw
    it. Not an ``InstalledSoftware`` row (decision 13): thousands per host,
    machine data, never change-logged. A package gone from the next read
    gets ``removed_at`` and is deleted 30 days later; matching reads only
    current rows.

    ``match_name`` is the package OSV advises: Debian and Ubuntu write their
    advisories per *source* package, Alpine per origin, RPM distros per
    binary package. ``match_version`` is the version that goes with it."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey("core.Tenant", on_delete=models.CASCADE, related_name="+")
    device = models.ForeignKey("api.Device", on_delete=models.CASCADE, null=True,
                               blank=True, related_name="host_packages")
    virtual_machine = models.ForeignKey("api.VirtualMachine", on_delete=models.CASCADE,
                                        null=True, blank=True, related_name="host_packages")
    purl_type = models.CharField(max_length=8, choices=PACKAGE_TYPES)
    # (``generic`` rows are Windows programs: shown, never matched.)
    #: The distro namespace of its package URL (debian, ubuntu, alpine,
    #: rocky, almalinux, redhat, or the os-release ID).
    namespace = models.CharField(max_length=64)
    name = models.CharField(max_length=128)
    version = models.CharField(max_length=128)
    arch = models.CharField(max_length=32, blank=True, default="", db_default="")
    source_name = models.CharField(max_length=128, blank=True, default="", db_default="")
    source_version = models.CharField(max_length=128, blank=True, default="",
                                      db_default="")
    #: A Windows program's publisher.
    publisher = models.CharField(max_length=128, blank=True, default="", db_default="")
    ecosystem = models.CharField(max_length=64, blank=True, default="", db_default="")
    #: ``namespace/name`` of the package OSV advises (see the class doc).
    match_name = models.CharField(max_length=200)
    match_version = models.CharField(max_length=128)
    purl = models.CharField(max_length=512, blank=True, default="", db_default="")
    first_seen = models.DateTimeField()
    last_seen = models.DateTimeField()
    removed_at = models.DateTimeField(null=True, blank=True)
    run = models.ForeignKey(InventoryRun, on_delete=models.SET_NULL, null=True, blank=True,
                            related_name="+")

    class Meta:
        ordering = ["name", "arch"]
        constraints = [
            models.CheckConstraint(
                condition=(models.Q(device__isnull=False, virtual_machine__isnull=True)
                           | models.Q(device__isnull=True, virtual_machine__isnull=False)),
                name="disc_hostpackage_one_host"),
            models.UniqueConstraint(
                fields=["device", "virtual_machine", "purl_type", "name", "arch"],
                name="uniq_disc_hostpackage", nulls_distinct=False),
        ]
        indexes = [
            models.Index(fields=["purl_type", "match_name", "ecosystem"],
                         name="disc_pkg_match",
                         condition=models.Q(removed_at__isnull=True)),
            models.Index(fields=["tenant", "purl_type", "match_name"], name="disc_pkg_tenant"),
            models.Index(fields=["removed_at"], name="disc_pkg_removed",
                         condition=models.Q(removed_at__isnull=False)),
        ]

    def __str__(self) -> str:
        return f"{self.name} {self.version}"


SERVICE_SOURCES = [
    ("danbyte", "Danbyte rule"),
    ("recog", "Recog"),
    ("nmap", "nmap"),
    ("banner", "Banner"),
    ("port", "Port number"),
]
CONFIDENCES = [("high", "High"), ("medium", "Medium"), ("low", "Low")]


class ObservedService(models.Model):
    """One TCP port that answered on one address, and what a service scan
    made of it. Machine data, written in bulk, never change-logged; a person
    turns it into a Service, an install or a product mapping through the
    review queue (``discovery.findings``). It never creates a vulnerability
    match (decision 7).

    ``gone_at`` is set when a later scan of the address found the port
    closed; the row is current again when the port opens again."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey("core.Tenant", on_delete=models.CASCADE, related_name="+")
    ip_address = models.ForeignKey("api.IPAddress", on_delete=models.CASCADE,
                                   related_name="observed_services")
    #: The address's device or VM at the last scan (through its assignment).
    device = models.ForeignKey("api.Device", on_delete=models.SET_NULL, null=True,
                               blank=True, related_name="+")
    virtual_machine = models.ForeignKey("api.VirtualMachine", on_delete=models.SET_NULL,
                                        null=True, blank=True, related_name="+")
    address = models.CharField(max_length=64)
    port = models.PositiveIntegerField()
    protocol = models.CharField(max_length=4, default="tcp", db_default="tcp")
    service_name = models.CharField(max_length=40, blank=True, default="", db_default="")
    #: What the port sent, control characters stripped, at most 512.
    banner = models.CharField(max_length=512, blank=True, default="", db_default="")
    product = models.CharField(max_length=128, blank=True, default="", db_default="")
    vendor = models.CharField(max_length=128, blank=True, default="", db_default="")
    version = models.CharField(max_length=64, blank=True, default="", db_default="")
    #: A CPE 2.3 guess. Never matched against vulnerability data.
    cpe = models.CharField(max_length=255, blank=True, default="", db_default="")
    os_guess = models.CharField(max_length=128, blank=True, default="", db_default="")
    source = models.CharField(max_length=10, choices=SERVICE_SOURCES, default="port",
                              db_default="port")
    #: The fingerprint that matched (its description), for the evidence.
    rule = models.CharField(max_length=200, blank=True, default="", db_default="")
    confidence = models.CharField(max_length=8, choices=CONFIDENCES, default="low",
                                  db_default="low")
    #: ``{status, server, powered_by, location, title}`` from one GET /.
    http = models.JSONField(default=dict, blank=True, db_default={})
    #: The leaf certificate's public facts; ``certificate`` links it when
    #: the certificate inventory already holds it.
    tls = models.JSONField(default=dict, blank=True, db_default={})
    certificate = models.ForeignKey("monitoring.Certificate", on_delete=models.SET_NULL,
                                    null=True, blank=True, related_name="+")
    first_seen = models.DateTimeField()
    last_seen = models.DateTimeField()
    gone_at = models.DateTimeField(null=True, blank=True)
    run = models.ForeignKey(InventoryRun, on_delete=models.SET_NULL, null=True, blank=True,
                            related_name="+")

    class Meta:
        ordering = ["address", "port"]
        constraints = [
            models.UniqueConstraint(fields=["ip_address", "protocol", "port"],
                                    name="uniq_disc_observed_service"),
        ]
        indexes = [
            models.Index(fields=["tenant", "gone_at"], name="disc_obs_tenant"),
            models.Index(fields=["tenant", "product"], name="disc_obs_product"),
        ]

    def __str__(self) -> str:
        return f"{self.address}:{self.port}/{self.protocol}"

    def evidence_key(self) -> str:
        """What an Ignore is remembered against: a change to any of these
        brings the finding back."""
        return "|".join([self.service_name, self.product, self.version, self.cpe])[:400]


FINDING_KINDS = [
    ("service", "Add service"),
    ("software", "Add installed software"),
    ("cpe", "Map product to CPE"),
]


class FindingDecision(models.Model):
    """An Ignore in the review queue: the finding stays hidden while the
    observation's evidence (``ObservedService.evidence_key``) is the same.
    Queue state, not change-logged."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey("core.Tenant", on_delete=models.CASCADE, related_name="+")
    observed = models.ForeignKey(ObservedService, on_delete=models.CASCADE,
                                 related_name="decisions")
    kind = models.CharField(max_length=10, choices=FINDING_KINDS)
    evidence = models.CharField(max_length=400)
    decided_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
                                   null=True, blank=True, related_name="+")
    decided_by_name = models.CharField(max_length=150, blank=True, default="", db_default="")
    decided_at = models.DateTimeField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["observed", "kind"],
                                    name="uniq_disc_finding_decision"),
        ]


class DiscoveryWorkItem(models.Model):
    """One host of a run on Outposts, waiting for or handed to its Outpost.

    Holds what the Outpost needs to know about the host *except* any
    secret: credentials are referenced by id and resolved from the secret
    store only when the Outpost claims the item, and go out in that one
    answer. An item is claimed once; one not claimed in time, or claimed and
    not reported, expires (``discovery.outposts.expire``). Machine data,
    never change-logged; deleted with its run."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey("core.Tenant", on_delete=models.CASCADE, related_name="+")
    run = models.ForeignKey(InventoryRun, on_delete=models.CASCADE, related_name="work_items")
    engine = models.ForeignKey("monitoring.MonitoringEngine", on_delete=models.CASCADE,
                               related_name="+")
    kind = models.CharField(max_length=16, choices=PROFILE_KINDS)
    status = models.CharField(max_length=8, choices=WORK_STATUSES, default="pending",
                              db_default="pending")
    address = models.CharField(max_length=64)
    device = models.ForeignKey("api.Device", on_delete=models.CASCADE, null=True, blank=True,
                               related_name="+")
    virtual_machine = models.ForeignKey("api.VirtualMachine", on_delete=models.CASCADE,
                                        null=True, blank=True, related_name="+")
    ip_address = models.ForeignKey("api.IPAddress", on_delete=models.CASCADE, null=True,
                                   blank=True, related_name="+")
    #: Never a secret: login references, accepted public keys, the port
    #: list and rates.
    payload = models.JSONField(default=dict, blank=True, db_default={})
    created_at = models.DateTimeField(auto_now_add=True)
    claimed_at = models.DateTimeField(null=True, blank=True)
    #: Pending: claim by then. Claimed: report by then.
    deadline = models.DateTimeField()

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["engine", "status", "created_at"], name="disc_work_engine"),
            models.Index(fields=["status", "deadline"], name="disc_work_deadline"),
        ]
