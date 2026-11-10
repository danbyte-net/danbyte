"""Known vulnerabilities (#451).

Deployment-wide, with no tenant column (decision 3): public data and
deployment configuration - the vulnerability records as fetched or uploaded,
the product index that lets a mapping find its candidates, the per-product
sync cursor and the sync runs.

Tenant-scoped: what a tenant maps (``ProductMapping``), its priority
thresholds (``VulnerabilityPolicy``), what matches its inventory
(``VulnerabilityMatch``) and its decisions about records
(``VulnerabilityException``).

Nothing is seeded: the catalog is filled only by an update a deployment admin
runs, mappings are made by users, and the settings and policy rows are
created on first read with column defaults.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from django.conf import settings
from django.db import models

from api.models import NumIdMixin
from core.models import TimestampedModel
from monitoring.secrets import EncryptedJSONField

UPDATE_SOURCES = [
    ("upload", "Upload"),
    ("server", "Server"),
    ("browser", "Browser"),
]
CVSS_VERSIONS = [("4.0", "4.0"), ("3.1", "3.1"), ("3.0", "3.0"), ("2.0", "2.0")]
SEVERITIES = [
    ("critical", "Critical"),
    ("high", "High"),
    ("medium", "Medium"),
    ("low", "Low"),
    ("none", "None"),
]
ATTACK_VECTORS = [
    ("network", "Network"),
    ("adjacent", "Adjacent"),
    ("local", "Local"),
    ("physical", "Physical"),
]
#: Where a record's NVD part came from; ``osv`` = only OSV data so far.
RECORD_SOURCES = [
    ("nvd_api", "NVD API"),
    ("nvd_feed", "NVD feed"),
    ("browser", "Browser"),
    ("osv", "OSV"),
]
NVD_SOURCES = ("nvd_api", "nvd_feed", "browser")
CPE_PARTS = [("o", "Operating system"), ("a", "Application"), ("h", "Hardware")]
PRODUCT_KINDS = [("cpe", "CPE"), ("purl", "Package URL")]
RUN_VIAS = UPDATE_SOURCES
RUN_STATUSES = [
    ("running", "Running"),
    ("ok", "OK"),
    ("failed", "Failed"),
    ("abandoned", "Abandoned"),
]


def _default_notify_on() -> list[str]:
    return ["fix_first", "critical", "kev"]


class VulnerabilitySettings(TimestampedModel):
    """Deployment-wide vulnerability data settings (singleton, ``pk=1``).
    Off by default; nothing is fetched until a deployment admin turns it on
    and picks an update source (decision 2: ``upload`` until then)."""

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)
    enabled = models.BooleanField(default=False, db_default=False)
    update_source = models.CharField(
        max_length=8, choices=UPDATE_SOURCES, default="upload", db_default="upload")
    #: Blank = the public service; a mirror or proxy goes here (https only).
    nvd_url = models.CharField(max_length=255, blank=True, default="", db_default="")
    epss_url = models.CharField(max_length=255, blank=True, default="", db_default="")
    kev_url = models.CharField(max_length=255, blank=True, default="", db_default="")
    osv_url = models.CharField(max_length=255, blank=True, default="", db_default="")
    sync_epss = models.BooleanField(default=True, db_default=True)
    sync_kev = models.BooleanField(default=True, db_default=True)
    #: ``{"nvd_api_key": ...}``, Fernet-encrypted, write-only over the API.
    secrets = EncryptedJSONField(default=dict, blank=True, db_default="")
    # Run bookkeeping, written by UPDATE so it stays out of the change log.
    last_sync_at = models.DateTimeField(null=True, blank=True)
    #: "" · running · ok · failed
    last_sync_status = models.CharField(max_length=10, blank=True, default="", db_default="")
    last_sync_error = models.TextField(blank=True, default="", db_default="")
    #: server · browser · upload
    last_sync_via = models.CharField(max_length=8, blank=True, default="", db_default="")

    class Meta:
        verbose_name = "vulnerability settings"
        verbose_name_plural = "vulnerability settings"

    @classmethod
    def load(cls) -> VulnerabilitySettings:
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def __str__(self) -> str:
        return "Vulnerability settings"


class Cve(models.Model):
    """One vulnerability record: an NVD CVE, or an OSV advisory without a
    CVE id. OSV advisories that alias a CVE are merged into that CVE's row
    (``aliases`` holds their ids, ``osv`` their affected packages). Public
    data, deployment-wide; written in bulk by imports, never audited."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    #: ``CVE-2023-20198``, or an OSV id (``GHSA-…``, ``PYSEC-…``).
    vuln_id = models.CharField(max_length=64, unique=True)
    aliases = models.JSONField(default=list, blank=True, db_default=[])
    summary = models.TextField(blank=True, default="", db_default="")
    published = models.DateTimeField(null=True, blank=True)
    #: NVD's ``lastModified`` (or OSV's ``modified`` for an OSV-only row);
    #: an older or equal record never overwrites a newer one.
    last_modified = models.DateTimeField(null=True, blank=True)
    vuln_status = models.CharField(max_length=32, blank=True, default="", db_default="")
    rejected = models.BooleanField(default=False, db_default=False)
    cvss_version = models.CharField(
        max_length=3, choices=CVSS_VERSIONS, blank=True, default="", db_default="")
    cvss_score = models.DecimalField(max_digits=3, decimal_places=1, null=True, blank=True)
    cvss_severity = models.CharField(
        max_length=8, choices=SEVERITIES, blank=True, default="", db_default="")
    cvss_vector = models.CharField(max_length=200, blank=True, default="", db_default="")
    attack_vector = models.CharField(
        max_length=8, choices=ATTACK_VECTORS, blank=True, default="", db_default="")
    #: The score was recomputed from the vector and agreed (CVSS 3.x).
    cvss_verified = models.BooleanField(default=False, db_default=False)
    cwes = models.JSONField(default=list, blank=True, db_default=[])
    #: First 50 ``{url, tags}``.
    references = models.JSONField(default=list, blank=True, db_default=[])
    #: NVD configuration nodes, the keys matching reads only, capped 512 KB.
    configurations = models.JSONField(default=list, blank=True, db_default=[])
    #: ``[{part, vendor, product, version}]`` from ``versionEndExcluding``.
    fixed_in = models.JSONField(default=list, blank=True, db_default=[])
    #: ``{osv id: {modified, affected, fixed_in}}`` per OSV advisory filed here.
    osv = models.JSONField(default=dict, blank=True, db_default={})
    kev_added = models.DateField(null=True, blank=True)
    kev_due = models.DateField(null=True, blank=True)
    kev_action = models.TextField(blank=True, default="", db_default="")
    #: CISA's knownRansomwareCampaignUse (``known`` / ``unknown``).
    kev_ransomware = models.CharField(max_length=16, blank=True, default="", db_default="")
    epss = models.DecimalField(max_digits=6, decimal_places=5, null=True, blank=True)
    epss_percentile = models.DecimalField(
        max_digits=6, decimal_places=5, null=True, blank=True)
    epss_date = models.DateField(null=True, blank=True)
    source = models.CharField(
        max_length=8, choices=RECORD_SOURCES, blank=True, default="", db_default="")
    fetched_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-published", "vuln_id"]
        verbose_name = "vulnerability"
        indexes = [
            models.Index(fields=["kev_added"], name="vuln_cve_kev_added"),
            models.Index(fields=["cvss_severity"], name="vuln_cve_severity"),
        ]

    def __str__(self) -> str:
        return self.vuln_id


class CveProduct(models.Model):
    """A product a record names as vulnerable: a CPE ``part:vendor:product``
    (``kind="cpe"``) or a package (``kind="purl"``: ``vendor`` = purl type,
    ``product`` = ``namespace/name``). Rebuilt from the record on every
    store; lets a mapping find its candidate records with one indexed query."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    cve = models.ForeignKey(Cve, on_delete=models.CASCADE, related_name="products")
    kind = models.CharField(max_length=4, choices=PRODUCT_KINDS, default="cpe",
                            db_default="cpe")
    #: o / a / h for a CPE; blank for a package.
    part = models.CharField(max_length=1, blank=True, default="", db_default="")
    vendor = models.CharField(max_length=128)
    product = models.CharField(max_length=255)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["cve", "kind", "part", "vendor", "product"],
                                    name="uniq_vuln_cveproduct"),
        ]
        indexes = [models.Index(fields=["kind", "vendor", "product"],
                                name="vuln_cveproduct_lookup")]

    def __str__(self) -> str:
        return f"{self.cve_id} {self.kind}:{self.part}:{self.vendor}:{self.product}"


class CpeProductSync(models.Model):
    """The incremental cursor per CPE product for server and browser sync:
    when it was last fetched and how that went."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    part = models.CharField(max_length=1, choices=CPE_PARTS)
    vendor = models.CharField(max_length=128)
    product = models.CharField(max_length=255)
    last_synced_at = models.DateTimeField(null=True, blank=True)
    last_status = models.CharField(max_length=10, blank=True, default="", db_default="")
    cve_count = models.PositiveIntegerField(default=0, db_default=0)

    class Meta:
        ordering = ["vendor", "product", "part"]
        constraints = [
            models.UniqueConstraint(fields=["part", "vendor", "product"],
                                    name="uniq_vuln_cpeproductsync"),
        ]

    def __str__(self) -> str:
        return f"cpe:2.3:{self.part}:{self.vendor}:{self.product}"


class SyncRun(TimestampedModel):
    """One update of the store: an upload, a server fetch or a browser sync.
    At most one runs at a time per deployment."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    via = models.CharField(max_length=8, choices=RUN_VIAS)
    started_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+")
    started_at = models.DateTimeField()
    finished_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=RUN_STATUSES, default="running",
                              db_default="running")
    #: What the run covers: for an upload ``{kind, filename, size}``; for a
    #: fetch, the products and EPSS batches.
    plan = models.JSONField(default=dict, blank=True, db_default={})
    #: How far it got (per product ``startIndex`` done for a sync).
    progress = models.JSONField(default=dict, blank=True, db_default={})
    counts = models.JSONField(default=dict, blank=True, db_default={})
    error = models.TextField(blank=True, default="", db_default="")

    class Meta:
        ordering = ["-started_at"]
        constraints = [
            # One running run per deployment.
            models.UniqueConstraint(fields=["status"], condition=models.Q(status="running"),
                                    name="uniq_vuln_syncrun_running"),
        ]

    def __str__(self) -> str:
        return f"{self.via} run {self.started_at:%Y-%m-%d %H:%M}"


# ─── Tenant side: mappings, policy, matches ──────────────────────────────────

VERSION_SCHEMES = [
    ("auto", "Automatic"),
    ("cisco_ios", "Cisco IOS"),
    ("cisco_iosxe", "Cisco IOS XE"),
    ("cisco_nxos", "Cisco NX-OS"),
    ("junos", "Juniper Junos"),
    ("arista_eos", "Arista EOS"),
    ("semver", "Semantic versioning"),
    ("pep440", "Python (PEP 440)"),
    ("dpkg", "Debian package"),
    ("apk", "Alpine package"),
    ("generic", "Exact only"),
]
MATCH_VIAS = [("platform", "Platform"), ("application", "Application"),
              ("package", "Package")]
CONFIDENCES = [("exact", "Exact"), ("range", "Range"), ("partial", "Partial")]
PRIORITIES = [
    ("fix_first", "Fix first"),
    ("high", "High"),
    ("medium", "Medium"),
    ("low", "Low"),
]


class ProductMapping(NumIdMixin, TimestampedModel):
    """Which public product a tenant's platform, device type or application
    is: a CPE 2.3 ``part:vendor:product`` (``kind="cpe"``) or a package URL
    (``kind="purl"``: ``vendor`` = the purl type, ``product`` =
    namespace/name). Several per subject. A device type carries hardware
    CPEs, used only as the context of a platform match (decision 9). Scoped
    like its subject: edits need ``change`` on it, reads ``view``."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="vulnerability_mappings")
    platform = models.ForeignKey(
        "api.Platform", on_delete=models.CASCADE, null=True, blank=True,
        related_name="product_mappings")
    device_type = models.ForeignKey(
        "api.DeviceType", on_delete=models.CASCADE, null=True, blank=True,
        related_name="product_mappings")
    application = models.ForeignKey(
        "api.Application", on_delete=models.CASCADE, null=True, blank=True,
        related_name="product_mappings")
    kind = models.CharField(max_length=4, choices=PRODUCT_KINDS, default="cpe",
                            db_default="cpe")
    #: o / a / h for a CPE; blank for a package.
    part = models.CharField(max_length=1, blank=True, default="", db_default="")
    vendor = models.CharField(max_length=128)
    product = models.CharField(max_length=255)
    version_scheme = models.CharField(max_length=12, choices=VERSION_SCHEMES,
                                      default="auto", db_default="auto")
    enabled = models.BooleanField(default=True, db_default=True)
    #: What the last full recompute found in the records, written by UPDATE
    #: (bookkeeping, out of the change log): candidates, unparsed_bounds,
    #: range_not_understood, version_not_understood, release_unknown.
    coverage = models.JSONField(default=dict, blank=True, db_default={}, editable=False)
    matched_at = models.DateTimeField(null=True, blank=True, editable=False)

    class Meta:
        ordering = ["vendor", "product"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(platform__isnull=False, device_type__isnull=True,
                             application__isnull=True)
                    | models.Q(platform__isnull=True, device_type__isnull=False,
                               application__isnull=True)
                    | models.Q(platform__isnull=True, device_type__isnull=True,
                               application__isnull=False)
                ),
                name="productmapping_one_subject",
            ),
            models.UniqueConstraint(
                fields=["platform", "device_type", "application", "kind", "part",
                        "vendor", "product"],
                name="uniq_productmapping_subject_product",
                nulls_distinct=False,
            ),
        ]
        indexes = [models.Index(fields=["kind", "vendor", "product"],
                                name="vuln_mapping_product")]

    def __str__(self) -> str:
        return self.identifier

    @property
    def subject(self):
        return self.platform or self.device_type or self.application

    @property
    def subject_type(self) -> str:
        if self.platform_id:
            return "platform"
        return "devicetype" if self.device_type_id else "application"

    @property
    def identifier(self) -> str:
        if self.kind == "purl":
            return f"pkg:{self.vendor}/{self.product}"
        return f"cpe:2.3:{self.part}:{self.vendor}:{self.product}"

    @property
    def product_key(self) -> tuple[str, str, str, str]:
        return (self.kind, self.part, self.vendor, self.product)

    @property
    def scheme(self) -> str:
        """The version scheme in force: ``auto`` resolved from the product."""
        from .versions import resolve_scheme

        return resolve_scheme(self.version_scheme, self.kind, self.part, self.vendor,
                              self.product)


class VulnerabilityPolicy(TimestampedModel):
    """A tenant's priority thresholds (decision 12). Created on first read
    with the column defaults; edited by tenant admins."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.OneToOneField(
        "core.Tenant", on_delete=models.CASCADE, related_name="vulnerability_policy")
    kev_is_fix_first = models.BooleanField(default=True, db_default=True)
    fix_first_epss = models.DecimalField(max_digits=6, decimal_places=5,
                                         default=Decimal("0.5"), db_default=Decimal("0.5"))
    fix_first_cvss = models.DecimalField(max_digits=3, decimal_places=1,
                                         default=Decimal("9.0"), db_default=Decimal("9.0"))
    high_cvss = models.DecimalField(max_digits=3, decimal_places=1,
                                    default=Decimal("9.0"), db_default=Decimal("9.0"))
    high_epss = models.DecimalField(max_digits=6, decimal_places=5,
                                    default=Decimal("0.1"), db_default=Decimal("0.1"))
    high_epss_cvss = models.DecimalField(max_digits=3, decimal_places=1,
                                         default=Decimal("7.0"), db_default=Decimal("7.0"))
    medium_cvss = models.DecimalField(max_digits=3, decimal_places=1,
                                      default=Decimal("4.0"), db_default=Decimal("4.0"))
    #: Which new matches notify (Phase 8): fix_first / critical / kev.
    notify_on = models.JSONField(default=_default_notify_on, blank=True,
                                 db_default=["fix_first", "critical", "kev"])
    notify_enabled = models.BooleanField(default=True, db_default=True)

    class Meta:
        verbose_name = "vulnerability policy"
        verbose_name_plural = "vulnerability policies"

    def __str__(self) -> str:
        return "Vulnerability policy"

    @classmethod
    def for_tenant(cls, tenant) -> VulnerabilityPolicy:
        obj, _ = cls.objects.get_or_create(tenant=tenant)
        return obj


EXCEPTION_STATUSES = [
    ("not_applicable", "Not applicable"),
    ("risk_accepted", "Risk accepted"),
]
#: Days a risk acceptance may run at most (decision 13).
MAX_RISK_DAYS = 365
#: CycloneDX 1.5 ``analysis`` vocabulary, so a VEX export carries the
#: exception as written (addendum C).
ANALYSIS_STATES = [
    ("not_affected", "Not affected"),
    ("false_positive", "False positive"),
    ("exploitable", "Exploitable"),
]
ANALYSIS_JUSTIFICATIONS = [
    ("code_not_present", "Code not present"),
    ("code_not_reachable", "Code not reachable"),
    ("requires_configuration", "Requires configuration"),
    ("requires_dependency", "Requires dependency"),
    ("requires_environment", "Requires environment"),
    ("protected_by_compiler", "Protected by compiler"),
    ("protected_at_runtime", "Protected at runtime"),
    ("protected_at_perimeter", "Protected at perimeter"),
    ("protected_by_mitigating_control", "Protected by mitigating control"),
]
ANALYSIS_RESPONSES = [
    ("can_not_fix", "Can not fix"),
    ("will_not_fix", "Will not fix"),
    ("update", "Update"),
    ("rollback", "Rollback"),
    ("workaround_available", "Workaround available"),
]
#: The analysis states each status may carry; the first is the default.
STATUS_STATES = {
    "not_applicable": ("not_affected", "false_positive"),
    "risk_accepted": ("exploitable",),
}
EXCEPTION_SCOPES = ("device", "virtual_machine", "platform", "application")


class VulnerabilityException(NumIdMixin, TimestampedModel):
    """A decision about one record in a tenant (decision 13): it does not
    apply (``not_applicable``) or the risk is accepted until a date
    (``risk_accepted``). Scoped to one device, VM, platform or application,
    or with none of them to the whole tenant. Matches it covers are marked
    ``excepted`` and drop out of counts, priority lists, the compliance rule
    and notifications; they stay listed with a filter.

    An expired row stays as history and stops applying; the daily job
    reopens its matches and tells the owner once. Change-logged."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="vulnerability_exceptions")
    cve = models.ForeignKey(Cve, on_delete=models.PROTECT, related_name="exceptions")
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="vulnerability_exceptions")
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, null=True, blank=True,
        related_name="vulnerability_exceptions")
    platform = models.ForeignKey(
        "api.Platform", on_delete=models.CASCADE, null=True, blank=True,
        related_name="vulnerability_exceptions")
    application = models.ForeignKey(
        "api.Application", on_delete=models.CASCADE, null=True, blank=True,
        related_name="vulnerability_exceptions")
    status = models.CharField(max_length=16, choices=EXCEPTION_STATUSES)
    reason = models.TextField()
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+")
    #: The owner's name when it was set, kept after the account goes.
    owner_name = models.CharField(max_length=150, blank=True, default="", db_default="")
    #: The last day it applies. Required for a risk acceptance.
    expires_on = models.DateField(null=True, blank=True)
    analysis_state = models.CharField(
        max_length=16, choices=ANALYSIS_STATES, blank=True, default="", db_default="")
    analysis_justification = models.CharField(
        max_length=32, choices=ANALYSIS_JUSTIFICATIONS, blank=True, default="",
        db_default="")
    analysis_response = models.JSONField(default=list, blank=True, db_default=[])
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+")
    #: When the expiry job reopened its matches and told the owner;
    #: bookkeeping by UPDATE, out of the change log.
    expiry_notified_at = models.DateTimeField(null=True, blank=True, editable=False)

    class Meta:
        ordering = ["-created_at"]
        verbose_name = "vulnerability exception"
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(virtual_machine__isnull=True, platform__isnull=True,
                             application__isnull=True)
                    | models.Q(device__isnull=True, platform__isnull=True,
                               application__isnull=True)
                    | models.Q(device__isnull=True, virtual_machine__isnull=True,
                               application__isnull=True)
                    | models.Q(device__isnull=True, virtual_machine__isnull=True,
                               platform__isnull=True)
                ),
                name="vulnexception_one_scope",
            ),
            models.CheckConstraint(
                condition=~models.Q(status="risk_accepted", expires_on__isnull=True),
                name="vulnexception_risk_expires",
            ),
        ]
        indexes = [
            models.Index(fields=["tenant", "cve"], name="vuln_exception_cve"),
            models.Index(fields=["tenant", "expires_on"], name="vuln_exception_expiry"),
        ]

    def __str__(self) -> str:
        return f"{self.cve.vuln_id if self.cve_id else '?'} {self.get_status_display().lower()}"

    @property
    def scope(self) -> str:
        """``device`` / ``virtual_machine`` / ``platform`` / ``application``,
        or ``tenant`` when it names none of them."""
        for name in EXCEPTION_SCOPES:
            if getattr(self, f"{name}_id"):
                return name
        return "tenant"

    @property
    def subject(self):
        return (self.device or self.virtual_machine or self.platform or self.application
                or None)

    def is_active(self, today=None) -> bool:
        from django.utils import timezone

        today = today or timezone.localdate()
        return self.expires_on is None or self.expires_on >= today


class VulnerabilityMatch(models.Model):
    """One record affecting one device or VM through one mapping: its
    platform's (``via="platform"``, the host's running version) or an
    installed application's (``via="application"``, the install's version)
    - or through a package discovery read from the host (``via="package"``,
    ``host_package`` set and no mapping, #451 B2).

    Machine-computed and written in bulk by the recompute, never change-
    logged. A match whose version moved off the record keeps its row with
    ``resolved_at`` (decision 14); at most one open row per key."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="vulnerability_matches")
    cve = models.ForeignKey(Cve, on_delete=models.CASCADE, related_name="matches")
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="vulnerability_matches")
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, null=True, blank=True,
        related_name="vulnerability_matches")
    via = models.CharField(max_length=12, choices=MATCH_VIAS)
    mapping = models.ForeignKey(ProductMapping, on_delete=models.CASCADE,
                                related_name="matches", null=True, blank=True)
    #: The inventoried package that matched (``via="package"``).
    host_package = models.ForeignKey(
        "discovery.HostPackage", on_delete=models.CASCADE, null=True, blank=True,
        related_name="vulnerability_matches")
    installed_software = models.ForeignKey(
        "api.InstalledSoftware", on_delete=models.CASCADE, null=True, blank=True,
        related_name="vulnerability_matches")
    #: The version string that matched.
    version = models.CharField(max_length=128, blank=True, default="", db_default="")
    confidence = models.CharField(max_length=8, choices=CONFIDENCES)
    priority = models.CharField(max_length=10, choices=PRIORITIES)
    #: The exception that covers it now (the most specific active one), or
    #: null. Kept by the recompute, by every exception save or delete and by
    #: the daily expiry job.
    excepted = models.ForeignKey(
        VulnerabilityException, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="matches")
    first_seen_at = models.DateTimeField()
    last_seen_at = models.DateTimeField()
    resolved_at = models.DateTimeField(null=True, blank=True)
    #: When a notification named it; ``notified_kev`` whether it was in KEV
    #: then, so a match that joins KEV later is named once more.
    notified_at = models.DateTimeField(null=True, blank=True)
    notified_kev = models.BooleanField(default=False, db_default=False)

    class Meta:
        ordering = ["-first_seen_at"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(device__isnull=False, virtual_machine__isnull=True)
                    | models.Q(device__isnull=True, virtual_machine__isnull=False)
                ),
                name="vulnmatch_one_host",
            ),
            # A mapping, or an inventoried package - never both or neither.
            models.CheckConstraint(
                condition=(
                    models.Q(mapping__isnull=False, host_package__isnull=True)
                    | models.Q(mapping__isnull=True, host_package__isnull=False)
                ),
                name="vulnmatch_one_source",
            ),
            models.UniqueConstraint(
                fields=["cve", "device", "virtual_machine", "mapping", "installed_software",
                        "host_package"],
                condition=models.Q(resolved_at__isnull=True),
                name="uniq_vulnmatch_open_v2",
                nulls_distinct=False,
            ),
        ]
        indexes = [
            models.Index(fields=["tenant", "priority", "resolved_at"],
                         name="vuln_match_priority"),
            models.Index(fields=["tenant", "cve"], name="vuln_match_cve"),
            models.Index(fields=["resolved_at"], name="vuln_match_resolved",
                         condition=models.Q(resolved_at__isnull=False)),
        ]

    def __str__(self) -> str:
        return f"{self.cve_id} on {self.device_id or self.virtual_machine_id}"
