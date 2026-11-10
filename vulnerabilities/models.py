"""Known vulnerabilities (#451): the deployment-wide data store.

Everything here is public data or deployment configuration, with no tenant
column (decision 3): the vulnerability records as fetched or uploaded, the
product index that lets a mapping find its candidates, the per-product sync
cursor and the sync runs. What a tenant maps, matches and excepts is
tenant-scoped and lives in later phases.

Nothing is seeded: the catalog is filled only by an update a deployment admin
runs, and the settings row is created on first read with column defaults.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

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
