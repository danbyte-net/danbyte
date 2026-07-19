"""User accounts + role-based permissions.

Django's built-in ``User`` carries identity (username, password, email);
``UserProfile`` extends it with the things Danbyte needs:

  * ``role`` — one of ``reader`` / ``admin`` / ``custom``.
  * ``permissions`` — explicit perm slug list, used when role == "custom".
  * ``current_tenant`` — last-used tenant in the sidebar switcher, persisted
    so the user lands on the same tenant after re-login.

The permission registry lives in :mod:`auth_api.permissions`. Reader gets
view-only perms; admin gets everything; custom gets whatever sits in
``permissions``.
"""
from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models

from core.models import TimestampedModel
from monitoring.secrets import EncryptedJSONField


class UserProfile(TimestampedModel):
    ROLE_CHOICES = [
        ("reader", "Reader — view only"),
        ("admin", "Admin — full access"),
        ("custom", "Custom — pick permissions"),
    ]

    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="profile",
    )
    role = models.CharField(
        max_length=16, choices=ROLE_CHOICES, default="reader",
        help_text=("Reader can only view data. Admin can do everything. "
                   "Custom uses the per-permission list below."),
    )
    permissions = models.JSONField(
        default=list, blank=True,
        help_text="Permission slugs granted to this user when role = custom.",
    )
    current_tenant = models.ForeignKey(
        "core.Tenant",
        on_delete=models.SET_NULL,
        null=True, blank=True,
        related_name="active_users",
    )
    tenants = models.ManyToManyField(
        "core.Tenant",
        blank=True,
        related_name="users",
        help_text=("Tenants this user can switch to and operate within. "
                   "Admins and superusers ignore this list — they see every "
                   "tenant. Empty list on a reader/custom user means no "
                   "tenant access at all."),
    )
    prefs = models.JSONField(
        default=dict, blank=True,
        help_text=("Free-form user preferences blob (theme, density, default "
                   "page size, confirm-before-delete, etc.). The settings page "
                   "writes here; UI code reads via auth_api.user_prefs.get()."),
    )

    # ─── Auth source + MFA ──────────────────────────────────────────────
    AUTH_SOURCE_CHOICES = [("local", "Local"), ("ldap", "LDAP")]
    auth_source = models.CharField(
        max_length=8, choices=AUTH_SOURCE_CHOICES, default="local",
        help_text="Where this account authenticates. LDAP accounts are "
                  "auto-provisioned on first login.",
    )
    # Ownership anchor for per-tenant directories: the tenant whose directory
    # this LDAP account belongs to. NULL = deployment directory (or a local
    # account). A tenant directory may only ever bind accounts it owns — the
    # guard that stops a tenant-configured directory impersonating local,
    # deployment-LDAP, or other-tenant users (see auth_api/ldap.py).
    ldap_source_tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.SET_NULL,
        null=True, blank=True, related_name="+",
    )
    require_mfa = models.BooleanField(
        default=False,
        help_text="Force a second factor (email code or authenticator) at login.",
    )
    mfa_email = models.BooleanField(
        default=True,
        help_text="Allow email one-time codes as a second factor.",
    )
    mfa_totp_confirmed = models.BooleanField(
        default=False,
        help_text="The user has set up and verified an authenticator app.",
    )
    # TOTP secret lives in a separate encrypted column.
    secrets = EncryptedJSONField(
        default=dict, blank=True,
        help_text="Encrypted-at-rest blob — currently the TOTP secret.",
    )

    class Meta:
        ordering = ["user__username"]

    def __str__(self) -> str:
        return self.user.get_username()


class GroupProfile(TimestampedModel):
    """Sidecar for Django ``auth.Group`` — a description + a built-in flag so the
    seeded Administrator / Operator / Read-only groups can't be deleted."""

    group = models.OneToOneField(
        "auth.Group", on_delete=models.CASCADE, related_name="profile"
    )
    description = models.TextField(blank=True, default="")
    built_in = models.BooleanField(default=False)

    class Meta:
        ordering = ["group__name"]

    def __str__(self) -> str:
        return self.group.name


class ObjectPermission(TimestampedModel):
    """A grant: a set of *actions* over a set of *object types*,
    optionally narrowed by *constraints* (a queryset filter) and scoped to
    specific *tenants*, assigned to *groups* and/or *users*.

    Semantics (grants only — there are no deny rules): a user's effective
    actions for an object type are the union across every enabled permission
    that applies to them (directly or via a group) in the active tenant. The
    ``constraints`` then limit *which rows* — multiple permissions OR together.
    """

    id = models.UUIDField(primary_key=True, editable=False, default=__import__("uuid").uuid4)
    name = models.CharField(max_length=128)
    description = models.TextField(blank=True, default="")
    enabled = models.BooleanField(default=True)

    object_types = models.JSONField(
        default=list,
        help_text="Object-type slugs this permission covers (see object_types registry).",
    )
    actions = models.JSONField(
        default=list, help_text="Subset of [view, add, change, delete]."
    )
    constraints = models.JSONField(
        null=True, blank=True,
        help_text="Queryset filter limiting which rows. A dict, or a list of "
                  "dicts OR'd together. Null/empty = all rows.",
    )

    tenants = models.ManyToManyField(
        "core.Tenant", blank=True, related_name="object_permissions",
        help_text="Tenants this permission applies within. Empty = every tenant "
                  "the user can access.",
    )
    sites = models.ManyToManyField(
        "api.Site", blank=True, related_name="object_permissions",
        help_text="Sites this permission is scoped to. Empty = all sites. Only "
                  "object types with a site (device, prefix, IP, rack, …) are "
                  "narrowed; types without a site ignore it.",
    )
    groups = models.ManyToManyField(
        "auth.Group", blank=True, related_name="object_permissions"
    )
    users = models.ManyToManyField(
        settings.AUTH_USER_MODEL, blank=True, related_name="object_permissions"
    )

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class UserPreference(TimestampedModel):
    """Per-user, per-table UI state — column order, hidden columns, ...

    A row with ``user=NULL`` is the *tenant default* that admins can publish
    for everyone. The lookup order in :func:`auth_api.column_prefs.get_pref`
    is:

      1. The signed-in user's row for ``(user, tenant, table_id)``.
      2. The tenant's default row for ``(NULL, tenant, table_id)``.
      3. Fall back to the JS's column-discovery (no overrides applied).

    ``data`` is a JSON blob — for the column manager it carries
    ``{"order": ["status", "tags", …], "hidden": ["created", …]}`` — but the
    same model can hold any other small per-table UI preference (sort, page
    size) later without a schema change.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="preferences",
        null=True, blank=True,
        help_text="NULL = this row is a tenant-wide default published by an admin.",
    )
    tenant = models.ForeignKey(
        "core.Tenant",
        on_delete=models.CASCADE,
        related_name="user_preferences",
    )
    table_id = models.CharField(
        max_length=64,
        help_text="The data-cols-table-id slug, e.g. 'prefix-ips'.",
    )
    data = models.JSONField(default=dict, blank=True)
    forced = models.BooleanField(
        default=False,
        help_text=("Only meaningful on a tenant-default row (user=NULL). When "
                   "True the layout is locked: users can't override it, their "
                   "own row is ignored, and the UI disables the column "
                   "controls. Ignored on a per-user row."),
    )

    class Meta:
        ordering = ["table_id", "user_id"]
        constraints = [
            # nulls_distinct=False so the unique applies to the tenant default
            # too — at most one default per (tenant, table_id).
            models.UniqueConstraint(
                fields=["user", "tenant", "table_id"],
                nulls_distinct=False,
                name="uniq_pref_user_tenant_table",
            ),
        ]

    def __str__(self) -> str:
        scope = self.user.get_username() if self.user_id else f"default·{self.tenant.slug}"
        return f"{scope}·{self.table_id}"


class LDAPGroupMapping(TimestampedModel):
    """Links a directory group (by DN) to a Danbyte ``auth.Group``. On each LDAP
    login a user's Danbyte group membership is re-synced from the directory
    groups they belong to, via these mappings — so all the existing
    ``ObjectPermission`` machinery (tenant scope, constraints, built-in roles)
    applies unchanged. Only *mapped* directory groups grant anything; unmapped
    ones are ignored, so the directory can't accidentally widen access."""

    ldap_group_dn = models.CharField(
        max_length=512,
        help_text="Full DN of the directory group, e.g. "
                  "CN=Network Admins,OU=Groups,DC=acme,DC=local.",
    )
    ldap_group_cn = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Common name, for display only.",
    )
    group = models.ForeignKey(
        "auth.Group", on_delete=models.CASCADE, related_name="ldap_mappings",
        help_text="The Danbyte group whose permissions members receive.",
    )
    # NULL = a deployment-directory mapping (today's behavior). Set = the
    # mapping belongs to that tenant's own directory and applies only to
    # logins routed through it (core.effective_settings.ldap_directory_chain).
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE,
        null=True, blank=True, related_name="ldap_group_mappings",
    )

    class Meta:
        ordering = ["ldap_group_cn", "ldap_group_dn"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "ldap_group_dn"],
                name="uniq_ldap_mapping_tenant_dn",
                nulls_distinct=False,
            )
        ]

    def __str__(self) -> str:
        return f"{self.ldap_group_cn or self.ldap_group_dn} → {self.group.name}"


class ApiToken(TimestampedModel):
    """A long-lived, revocable API key for non-interactive callers (Ansible/AWX,
    scripts). Authenticates as ``user`` and is scoped to one ``tenant``, so the
    runner reaches the inventory/render endpoints without a session cookie. Only
    the SHA-256 hash is stored — the full key is shown once at creation."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
        related_name="api_tokens",
    )
    tenant = models.ForeignKey(
        "core.Tenant", on_delete=models.CASCADE, related_name="api_tokens"
    )
    name = models.CharField(max_length=128)
    key_hash = models.CharField(max_length=64, unique=True, db_index=True)
    prefix = models.CharField(max_length=16, help_text="First chars, for display.")
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.name} ({self.prefix}…)"

    @property
    def is_expired(self) -> bool:
        from django.utils import timezone

        return bool(self.expires_at and self.expires_at < timezone.now())


def generate_api_key() -> str:
    import secrets

    return "dbt_" + secrets.token_hex(24)


def hash_api_key(key: str) -> str:
    import hashlib

    return hashlib.sha256(key.encode()).hexdigest()


# Public read-only share links (model lives in its own module for clarity).
