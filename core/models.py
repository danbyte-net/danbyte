import re
import uuid

from django.core.exceptions import ValidationError
from django.db import models
from taggit.managers import TaggableManager
from taggit.models import GenericUUIDTaggedItemBase, TagBase

from monitoring.secrets import EncryptedJSONField


HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def validate_hex_color(value):
    if value in (None, ""):
        return
    if not HEX_COLOR_RE.match(value):
        raise ValidationError(f"'{value}' must be a 7-char hex like #10b981")


class Tag(TagBase):
    """User-defined tag, optionally colored — and tenant-scoped.

    Colorless tags render as neutral zinc badges. Colored tags render as solid
    badges with white or black text picked from the color's perceived luminance.

    ``tenant`` scopes the tag: taggit's TagBase is one global table, which
    leaked every tenant's tag names to every other tenant. NULL tenant =
    legacy/deployment-global (visible to all, writable by superusers only).
    ``name``/``slug`` are therefore unique per tenant, not globally —
    TagBase's slug-collision retry keys off IntegrityError, so it keeps
    working against the composite constraints. ``owning_site`` makes a tag
    local to one site under enhanced site separation (NULL = tenant-global).
    """

    # Override TagBase's globally-unique columns; uniqueness moves to the
    # per-tenant constraints below.
    name = models.CharField(max_length=100, unique=False)
    slug = models.SlugField(max_length=100, unique=False)
    tenant = models.ForeignKey(
        "core.Tenant",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="tags",
    )
    owning_site = models.ForeignKey(
        "api.Site", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Set = local to that site (enhanced site separation); "
        "empty = global to the tenant.",
    )
    color = models.CharField(
        max_length=7,
        blank=True,
        default="",
        validators=[validate_hex_color],
        help_text="Optional 7-char hex like #10b981. Leave empty for an uncolored tag.",
    )

    class Meta:
        verbose_name = "Tag"
        verbose_name_plural = "Tags"
        ordering = ["name"]
        constraints = [
            # nulls_distinct=False so the NULL-tenant (legacy/global) bucket
            # also enforces unique slugs/names.
            models.UniqueConstraint(
                fields=["tenant", "slug"], nulls_distinct=False,
                name="uniq_tag_tenant_slug",
            ),
            models.UniqueConstraint(
                fields=["tenant", "name"], nulls_distinct=False,
                name="uniq_tag_tenant_name",
            ),
        ]

    @property
    def text_color(self) -> str:
        """Black or white text for the badge — chosen by sRGB luminance.

        Returns '' for colorless tags (caller decides). Empty / malformed
        ``color`` is treated as colorless.
        """
        if not self.color:
            return ""
        h = self.color.lstrip("#")
        if len(h) != 6:
            return "#fff"
        try:
            r = int(h[0:2], 16)
            g = int(h[2:4], 16)
            b = int(h[4:6], 16)
        except ValueError:
            return "#fff"
        # Perceived luminance, sRGB approximation. Threshold biases slightly
        # toward white text since most palette colors are reasonably saturated.
        luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        return "#000" if luminance > 0.6 else "#fff"


class TaggedItem(GenericUUIDTaggedItemBase):
    """All Danbyte models use UUID PKs, so ``object_id`` must be a UUIDField
    (taggit's default ``GenericTaggedItemBase`` uses IntegerField and overflows
    on SQLite when the UUID is cast to int).
    """

    tag = models.ForeignKey(
        Tag,
        on_delete=models.CASCADE,
        related_name="tagged_items",
    )


class TimestampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class CustomFieldsMixin(models.Model):
    """Adds a JSONB ``custom_fields`` dict for user-defined attributes."""

    custom_fields = models.JSONField(
        default=dict,
        blank=True,
        help_text="User-defined custom fields",
    )

    class Meta:
        abstract = True


class TaggableMixin(models.Model):
    """Adds tags via the custom Tag/TaggedItem models (color-aware)."""

    tags = TaggableManager(blank=True, through=TaggedItem)

    class Meta:
        abstract = True


class Organization(TimestampedModel):
    """SaaS-level account (the Danbyte install owner). One per deployment for
    self-hosted installs; many for an MSP. Tenants live under an Organization.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=255, unique=True)
    slug = models.SlugField(unique=True)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class DeploymentSettings(TimestampedModel):
    """Deployment-wide notification + outbound-delivery settings (singleton).

    Self-hosted installs configure a single SMTP server and outbound-delivery
    options here, from the Admin → Email & Delivery page (``users.manage``
    only). These are infrastructure shared by the whole install — not
    tenant-scoped — so there is exactly one row (``pk=1``). The SMTP password
    lives in ``secrets`` (Fernet-encrypted), never returned in clear text.
    """

    SECURITY_CHOICES = [
        ("none", "None"),
        ("starttls", "STARTTLS"),
        ("ssl", "SSL/TLS"),
    ]

    id = models.PositiveSmallIntegerField(primary_key=True, default=1, editable=False)

    # ─── email / SMTP transport ──────────────────────────────────────────
    email_enabled = models.BooleanField(
        default=False,
        help_text="When off, email channels are skipped (other transports unaffected).",
    )
    smtp_host = models.CharField(max_length=255, blank=True, default="")
    smtp_port = models.PositiveIntegerField(default=587)
    smtp_security = models.CharField(
        max_length=8, choices=SECURITY_CHOICES, default="starttls"
    )
    smtp_username = models.CharField(max_length=255, blank=True, default="")
    # Fernet-encrypted {"password": "..."}.
    secrets = EncryptedJSONField(default=dict, blank=True)
    email_from = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text='From header, e.g. "Danbyte Alerts <alerts@acme.com>".',
    )

    # ─── outbound delivery (all transports) ──────────────────────────────
    public_base_url = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Public URL of this install, used to deep-link alerts in messages.",
    )
    webhook_timeout = models.PositiveSmallIntegerField(
        default=5, help_text="Seconds to wait for Slack/Teams/PagerDuty/webhook POSTs."
    )
    outbound_proxy = models.CharField(
        max_length=255,
        blank=True,
        default="",
        help_text="Optional HTTP(S) proxy for outbound webhooks, e.g. http://proxy:3128.",
    )

    # ─── LDAP / Active Directory (optional, off by default) ──────────────
    LDAP_GROUP_TYPE_CHOICES = [
        ("ad", "Active Directory (nested)"),
        ("group_of_names", "groupOfNames (OpenLDAP)"),
        ("posix", "POSIX groups"),
    ]
    ldap_enabled = models.BooleanField(
        default=False,
        help_text="When on, users can authenticate against the directory below.",
    )
    ldap_server_uri = models.CharField(
        max_length=255, blank=True, default="",
        help_text="e.g. ldaps://dc01.acme.local or ldap://dc01.acme.local",
    )
    ldap_start_tls = models.BooleanField(
        default=False, help_text="Upgrade a plain ldap:// connection with StartTLS."
    )
    ldap_ignore_cert = models.BooleanField(
        default=False, help_text="Skip TLS certificate validation (lab use only)."
    )
    ldap_bind_dn = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Service account that may search the directory, e.g. "
                  "CN=danbyte,OU=Service,DC=acme,DC=local.",
    )
    # Bind password is Fernet-encrypted in `secrets["ldap_bind_password"]`.
    ldap_user_search_base = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Base DN to search for users, e.g. OU=Users,DC=acme,DC=local.",
    )
    ldap_user_search_filter = models.CharField(
        max_length=255, blank=True, default="(sAMAccountName=%(user)s)",
        help_text="%(user)s is replaced with the login name.",
    )
    ldap_attr_first_name = models.CharField(
        max_length=64, blank=True, default="givenName"
    )
    ldap_attr_last_name = models.CharField(max_length=64, blank=True, default="sn")
    ldap_attr_email = models.CharField(max_length=64, blank=True, default="mail")
    ldap_group_search_base = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Base DN to search for groups, e.g. OU=Groups,DC=acme,DC=local.",
    )
    ldap_group_type = models.CharField(
        max_length=16, choices=LDAP_GROUP_TYPE_CHOICES, default="ad"
    )
    ldap_require_group = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Optional group DN a user must belong to in order to sign in.",
    )

    # ─── general ─────────────────────────────────────────────────────────
    deployment_name = models.CharField(
        max_length=100,
        blank=True,
        default="",
        help_text='Display name for this install — the app name shown in the '
        'sidebar header, the browser tab title, and the login page. '
        'Blank = "Danbyte".',
    )
    changelog_retention_days = models.PositiveSmallIntegerField(
        default=730,
        help_text="Days to keep change-log / audit entries before pruning. "
        "0 = keep forever.",
    )
    favicon = models.ImageField(
        upload_to="branding/",
        null=True,
        blank=True,
        help_text="Custom browser-tab icon for this install. Blank = the "
        "default Danbyte icon. A small square PNG/ICO works best.",
    )

    # ─── optional built-in device fields (admin-controlled visibility) ─────
    device_field_visibility = models.JSONField(
        default=dict,
        blank=True,
        help_text="Maps optional built-in device field keys → bool. Controls "
        "whether each optional field is shown on the device form/detail. "
        "Unset keys fall back to server-side defaults.",
    )

    # ─── floor-plan tile popover ──────────────────────────────────────────
    floorplan_popover_fields = models.JSONField(
        default=list,
        blank=True,
        help_text="Ordered field keys shown in the floor-plan tile popover. "
        "Empty = the server-side default set.",
    )
    floorplan_popover_tile_overrides = models.JSONField(
        default=dict,
        blank=True,
        help_text="Per-tile-type popover field lists, keyed by tile-type slug. "
        "A slug that is ABSENT inherits floorplan_popover_fields — only store a "
        "list for types that genuinely differ.",
    )

    # ─── outbound-connection allowlist (SSRF guard exceptions) ────────────
    # CIDRs/hosts the SSRF guard permits despite resolving to private space —
    # e.g. an internal NetBox for the importer, or an internal SMTP relay.
    # DEPLOYMENT tier on purpose: a tenant admin must never be able to widen
    # the guard that exists to contain tenant admins. Merged with the
    # DANBYTE_SSRF_ALLOWLIST env var.
    ssrf_allowlist = models.JSONField(default=list, blank=True)

    # ─── site map tiles ──────────────────────────────────────────────────
    # Blank = OpenStreetMap's donated tile servers (light use only, per
    # https://operations.osmfoundation.org/policies/tiles/ — which also asks
    # apps NOT to hard-code the URL, hence this setting). Heavy or offline
    # deployments point this at their own raster tile server.
    map_tile_url = models.URLField(
        blank=True, default="",
        help_text="Raster tile URL template with {z}/{x}/{y} placeholders. "
        "Blank = OpenStreetMap's standard tiles.",
    )
    map_tile_attribution = models.CharField(
        max_length=512, blank=True, default="",
        help_text="Attribution HTML shown on the map (required by most tile "
        "providers). Blank = the OpenStreetMap attribution.",
    )
    # Satellite basemap (the map's "Satellite" toggle). Blank = Esri World
    # Imagery, which permits free use with attribution.
    map_satellite_url = models.URLField(
        blank=True, default="",
        help_text="Satellite tile URL template ({z}/{x}/{y} or {z}/{y}/{x}). "
        "Blank = Esri World Imagery.",
    )
    map_satellite_attribution = models.CharField(
        max_length=512, blank=True, default="",
    )

    # ─── site separation (opt-in, off by default) ────────────────────────
    # Its own override group on TenantSettings (like the floor-plan popover):
    # flipping separation must not force a tenant to fork its sharing policy.
    enhanced_site_separation = models.BooleanField(
        default=False,
        help_text="When on, each site behaves like a mini-tenant for "
        "site-scoped users: pickers only offer their sites, new objects "
        "default there, and catalog entries they create are local to their "
        "site. Cross-site users and admins are unaffected.",
    )
    allow_site_settings = models.BooleanField(
        default=False,
        help_text="When on, site admins (site editors, or holders of a "
        "sitesettings grant) may manage their own site's settings — e.g. "
        "email delivery.",
    )

    # ─── sharing & delegation (opt-in, off by default) ───────────────────
    allow_site_editor_delegation = models.BooleanField(
        default=False,
        help_text="When on, a site editor (local IT) may invite their own "
        "viewers to the site(s) they edit — without a global admin.",
    )

    # ─── scheduled config-drift dispatch (opt-in, off by default) ─────────
    config_drift_enabled = models.BooleanField(
        default=False,
        help_text="When on, Danbyte periodically dispatches a config-drift run "
        "to every enabled automation target.",
    )
    config_drift_interval_minutes = models.PositiveIntegerField(
        default=60,
        help_text="Minimum minutes between scheduled config-drift dispatches.",
    )
    config_drift_last_run = models.DateTimeField(
        null=True,
        blank=True,
        help_text="Timestamp of the last scheduled config-drift dispatch.",
    )

    # ─── date & time display ──────────────────────────────────────────────
    # Deployment-wide defaults for how the UI renders dates and times. A
    # tenant may override the group (TenantSettings.override_datetime); a
    # user may override the tenant via the "auto"-valued prefs keys in
    # auth_api.user_prefs. Resolution: user → tenant → deployment.
    DATE_FORMAT_CHOICES = [
        ("YYYY-MM-DD", "2026-01-31 (ISO)"),
        ("DD.MM.YYYY", "31.01.2026"),
        ("DD/MM/YYYY", "31/01/2026"),
        ("MM/DD/YYYY", "01/31/2026"),
        ("DD MMM YYYY", "31 Jan 2026"),
    ]
    TIME_STYLE_CHOICES = [
        ("24h", "24-hour (14:30)"),
        ("12h", "12-hour (2:30 PM)"),
    ]
    date_format = models.CharField(
        max_length=16,
        choices=DATE_FORMAT_CHOICES,
        default="YYYY-MM-DD",
        help_text="How the UI renders calendar dates by default.",
    )
    time_style = models.CharField(
        max_length=4,
        choices=TIME_STYLE_CHOICES,
        default="24h",
        help_text="24-hour or 12-hour AM/PM clock for rendered times.",
    )
    display_timezone = models.CharField(
        max_length=64,
        blank=True,
        default="",
        help_text="IANA timezone (e.g. Europe/Copenhagen) the UI renders "
        "times in. Blank = the server's TIME_ZONE.",
    )

    # ─── human-readable object numbers (numid) ───────────────────────────
    human_ids_enabled = models.BooleanField(
        default=True,
        help_text="When on, objects expose a short per-tenant sequential number "
        "(numid) alongside their UUID — e.g. so a cable physically tagged '27' "
        "maps to cable #27. Numbers are namespaced per tenant, so each tenant "
        "counts from 1 independently.",
    )

    # ─── in-app updates ──────────────────────────────────────────────────
    # Release repo Danbyte checks for updates. Blank = the official repo. The
    # token (private repos) lives in ``secrets["release_repo_token"]``.
    release_repo_url = models.CharField(max_length=512, blank=True, default="")
    # Airgapped installs: skip every outbound update-check (the version fetch
    # from the release repo) and disable auto-update. Bundles are still uploaded
    # and applied manually. When on, upgrade.py / auto_upgrade.py short-circuit
    # before any network call.
    disable_update_check = models.BooleanField(default=False)
    auto_update_enabled = models.BooleanField(default=False)
    update_channel = models.CharField(
        max_length=8,
        choices=[("stable", "Stable only"), ("any", "Any (incl. prerelease)")],
        default="stable",
    )
    # Optional maintenance window for auto-update (local time); blank = anytime.
    update_window_days = models.CharField(max_length=32, blank=True, default="")
    update_window_start = models.CharField(max_length=5, blank=True, default="")
    update_window_end = models.CharField(max_length=5, blank=True, default="")

    class Meta:
        verbose_name = "deployment settings"
        verbose_name_plural = "deployment settings"

    def __str__(self) -> str:
        return "Deployment settings"

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    @classmethod
    def load(cls) -> "DeploymentSettings":
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


class BookmarkFolder(TimestampedModel):
    """A per-user folder for saved page links. Folders are self-nesting so the
    sidebar can present a compact favourites tree without tenant coupling."""

    from django.conf import settings as _settings

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        _settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="bookmark_folders",
    )
    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="children",
    )
    name = models.CharField(max_length=120)
    weight = models.IntegerField(default=0)

    class Meta:
        ordering = ["weight", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "parent", "name"],
                name="uniq_user_bookmark_folder_name",
            ),
        ]

    def __str__(self) -> str:
        return self.name


class Bookmark(TimestampedModel):
    """A per-user saved page link, surfaced on the dashboard. Stores the SPA
    path (with query string) so a filtered view can be saved verbatim. Scoped
    to the user, not the tenant — bookmarks follow the person."""

    from django.conf import settings as _settings

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        _settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="bookmarks",
    )
    folder = models.ForeignKey(
        BookmarkFolder,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="bookmarks",
    )
    label = models.CharField(max_length=120)
    url = models.CharField(max_length=500, help_text="SPA path, e.g. /prefixes?status=active")
    weight = models.IntegerField(default=0)

    class Meta:
        ordering = ["folder__weight", "folder__name", "weight", "label"]
        constraints = [
            models.UniqueConstraint(fields=["user", "url"], name="uniq_user_bookmark_url")
        ]

    def __str__(self) -> str:
        return f"{self.label} ({self.url})"


class TenantGroup(TimestampedModel):
    """A self-nesting grouping of tenants (region → business unit → customer),
    org-scoped like the tenants it organises. Matches NetBox's tenantgroup so
    tenant hierarchies import losslessly. Zero pre-filled data."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="tenant_groups"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    parent = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="children",
    )
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        unique_together = [("org", "slug")]

    def clean(self):
        # Cycle guard — a group can't be its own ancestor.
        seen, node = {self.pk}, self.parent
        while node is not None:
            if node.pk in seen:
                from django.core.exceptions import ValidationError

                raise ValidationError({"parent": "This would create a cycle."})
            seen.add(node.pk)
            node = node.parent

    def __str__(self) -> str:
        return self.name


class Tenant(TimestampedModel):
    """Hard isolation scope inside an organization.

    For an MSP, one tenant per customer. For a single-company deployment,
    one tenant. Tenants are never displayed together — the UI shows the
    currently-selected tenant only.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    org = models.ForeignKey(
        Organization, on_delete=models.CASCADE, related_name="tenants"
    )
    group = models.ForeignKey(
        TenantGroup, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="tenants",
        help_text="Optional grouping in the org's tenant-group tree.",
    )
    name = models.CharField(max_length=255)
    slug = models.SlugField()
    color = models.CharField(
        max_length=7,
        blank=True,
        default="",
        validators=[validate_hex_color],
        help_text="Optional 7-char hex. Used as a small indicator dot in the topbar.",
    )
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)
    prefs = models.JSONField(
        default=dict, blank=True,
        help_text=("Tenant-wide admin-set defaults: page size override, "
                   "default IP status / role, gateway role, etc. Users can "
                   "still override on their own UserProfile.prefs."),
    )

    class Meta:
        ordering = ["name"]
        unique_together = [("org", "slug"), ("org", "name")]

    def __str__(self) -> str:
        return self.name


class TenantSettings(TimestampedModel):
    """Per-tenant overrides of selected :class:`DeploymentSettings` groups.

    Each group carries an ``override_*`` toggle — off (the default, and the
    absence of a row) means the tenant inherits the deployment-wide value; on
    means this row's fields win. Field names deliberately **mirror**
    ``DeploymentSettings`` so the consumers (``build_email_connection``, the
    LDAP backend builder, the sharing gates) work unchanged with either object.
    Resolution lives in :mod:`core.effective_settings`. Secrets (SMTP password,
    LDAP bind password) are Fernet-encrypted in ``secrets``, never serialized.
    See ``docs/architecture/tenant-settings.md``.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.OneToOneField(
        Tenant, on_delete=models.CASCADE, related_name="settings"
    )

    # ─── per-group override toggles (off = inherit deployment default) ────
    override_email = models.BooleanField(default=False)
    override_ldap = models.BooleanField(default=False)
    override_ui = models.BooleanField(default=False)
    override_sharing = models.BooleanField(default=False)

    # ─── email / SMTP (mirrors DeploymentSettings) ─────────────────────────
    email_enabled = models.BooleanField(default=False)
    smtp_host = models.CharField(max_length=255, blank=True, default="")
    smtp_port = models.PositiveIntegerField(default=587)
    smtp_security = models.CharField(
        max_length=8, choices=DeploymentSettings.SECURITY_CHOICES, default="starttls"
    )
    smtp_username = models.CharField(max_length=255, blank=True, default="")
    email_from = models.CharField(max_length=255, blank=True, default="")

    # ─── UI policy (mirrors DeploymentSettings) ────────────────────────────
    device_field_visibility = models.JSONField(default=dict, blank=True)
    human_ids_enabled = models.BooleanField(default=True)

    # ─── floor-plan popover (its OWN override group) ───────────────────────
    # Deliberately not under `override_ui`: that group also carries device-field
    # visibility and human IDs, so riding it would force a tenant to override
    # those just to change the popover. Tenants genuinely differ here, so it
    # gets its own switch.
    override_floorplan_popover = models.BooleanField(default=False)
    floorplan_popover_fields = models.JSONField(default=list, blank=True)
    floorplan_popover_tile_overrides = models.JSONField(default=dict, blank=True)

    # ─── site separation (its OWN override group, mirrors DeploymentSettings)
    # Same reasoning as the popover group: a tenant flipping separation must
    # not be forced to fork the whole sharing group to do it.
    override_separation = models.BooleanField(default=False)
    enhanced_site_separation = models.BooleanField(default=False)
    allow_site_settings = models.BooleanField(default=False)

    # ─── sharing & delegation (mirrors DeploymentSettings) ─────────────────
    allow_site_editor_delegation = models.BooleanField(default=False)

    # ─── date & time display (its OWN override group, mirrors Deployment) ──
    # Same reasoning as separation/popover: changing the date format must not
    # force a tenant to fork the whole UI-policy group.
    override_datetime = models.BooleanField(default=False)
    date_format = models.CharField(
        max_length=16,
        choices=DeploymentSettings.DATE_FORMAT_CHOICES,
        default="YYYY-MM-DD",
    )
    time_style = models.CharField(
        max_length=4, choices=DeploymentSettings.TIME_STYLE_CHOICES, default="24h"
    )
    display_timezone = models.CharField(max_length=64, blank=True, default="")

    # ─── LDAP / Active Directory (mirrors DeploymentSettings) ──────────────
    ldap_enabled = models.BooleanField(default=False)
    ldap_server_uri = models.CharField(max_length=255, blank=True, default="")
    ldap_start_tls = models.BooleanField(default=False)
    ldap_ignore_cert = models.BooleanField(default=False)
    ldap_bind_dn = models.CharField(max_length=255, blank=True, default="")
    ldap_user_search_base = models.CharField(max_length=255, blank=True, default="")
    ldap_user_search_filter = models.CharField(
        max_length=255, blank=True, default="(sAMAccountName=%(user)s)"
    )
    ldap_attr_first_name = models.CharField(
        max_length=64, blank=True, default="givenName"
    )
    ldap_attr_last_name = models.CharField(max_length=64, blank=True, default="sn")
    ldap_attr_email = models.CharField(max_length=64, blank=True, default="mail")
    ldap_group_search_base = models.CharField(max_length=255, blank=True, default="")
    ldap_group_type = models.CharField(
        max_length=16,
        choices=DeploymentSettings.LDAP_GROUP_TYPE_CHOICES,
        default="ad",
    )
    ldap_require_group = models.CharField(max_length=255, blank=True, default="")
    # Email-style suffixes ("corp.com") — a "user@corp.com" login routes
    # straight (and only) to THIS tenant's directory, searched as "user"; the
    # Django username keeps the full user@domain form so it can't collide with
    # bare local/deployment usernames.
    ldap_login_domains = models.JSONField(default=list, blank=True)

    # Fernet-encrypted {"password": smtp, "ldap_bind_password": ...}.
    secrets = EncryptedJSONField(default=dict, blank=True)

    class Meta:
        verbose_name = "tenant settings"
        verbose_name_plural = "tenant settings"

    def __str__(self) -> str:
        return f"Settings for {self.tenant.name}"

    @classmethod
    def for_tenant(cls, tenant) -> "TenantSettings":
        obj, _ = cls.objects.get_or_create(tenant=tenant)
        return obj


class SiteSettings(TimestampedModel):
    """Per-SITE settings overrides — the third layer (site → tenant →
    deployment), for orgs whose sites run their own IT.

    v1 carries only the email group. Field names mirror ``DeploymentSettings``
    exactly (like ``TenantSettings``) so ``build_email_connection`` accepts
    any of the three unchanged. Editing is gated by ``allow_site_settings``
    (the separation group) + site-admin qualification — see
    ``core.site_settings``.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    site = models.OneToOneField(
        "api.Site", on_delete=models.CASCADE, related_name="settings"
    )

    override_email = models.BooleanField(default=False)
    email_enabled = models.BooleanField(default=False)
    smtp_host = models.CharField(max_length=255, blank=True, default="")
    smtp_port = models.PositiveIntegerField(default=587)
    smtp_security = models.CharField(
        max_length=8, choices=DeploymentSettings.SECURITY_CHOICES, default="starttls"
    )
    smtp_username = models.CharField(max_length=255, blank=True, default="")
    email_from = models.CharField(max_length=255, blank=True, default="")

    # Fernet-encrypted {"password": smtp}.
    secrets = EncryptedJSONField(default=dict, blank=True)

    class Meta:
        verbose_name = "site settings"
        verbose_name_plural = "site settings"

    def __str__(self) -> str:
        return f"Settings for site {self.site.name}"

    @classmethod
    def for_site(cls, site) -> "SiteSettings":
        obj, _ = cls.objects.get_or_create(site=site)
        return obj
