"""Routing: the policy objects every protocol shares, static routes, and
(in later migrations) the BGP / OSPF / IS-IS instances a device runs.

Catalogs (prefix lists, communities, policies, keychains) are tenant-wide and
unique by name - the name is what a template prints. Rule rows belong to
their list and carry no tenant of their own, the way an interface belongs to
its device. Device-bound rows (static routes, protocol instances) are
site-scoped through the device.
"""
from __future__ import annotations

import ipaddress
import uuid

from django.core.exceptions import ValidationError
from django.db import models

from api.models import NumIdMixin, SecretBackedPSK
from core.models import CustomFieldsMixin, TaggableMixin, Tenant, TimestampedModel

ACTION_CHOICES = [("permit", "Permit"), ("deny", "Deny")]
FAMILY_CHOICES = [("ipv4", "IPv4"), ("ipv6", "IPv6")]


def normalize_network(value: str, field: str = "prefix") -> str:
    """``10.0.0.0/8`` as the box would print it. Host bits set are an error,
    not silently masked - the person meant a network and typed a host."""
    try:
        return str(ipaddress.ip_network((value or "").strip(), strict=True))
    except ValueError as exc:
        raise ValidationError({field: f"Not a valid network: {exc}"}) from exc


def normalize_address(value: str, field: str = "next_hop") -> str:
    try:
        return str(ipaddress.ip_address((value or "").strip()))
    except ValueError as exc:
        raise ValidationError({field: f"Not a valid address: {exc}"}) from exc


class _Catalog(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A named, tenant-wide routing object."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="routing_%(class)ss"
    )
    name = models.CharField(max_length=128)
    description = models.TextField(blank=True, default="")

    class Meta:
        abstract = True
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


# ─── Prefix lists ────────────────────────────────────────────────────────────

class PrefixList(_Catalog):
    family = models.CharField(max_length=4, choices=FAMILY_CHOICES, default="ipv4")

    class Meta(_Catalog.Meta):
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_prefixlist_tenant_name"
            )
        ]


class PrefixListRule(models.Model):
    """One ``seq N permit 10.0.0.0/8 ge 24 le 32`` line."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    prefix_list = models.ForeignKey(
        PrefixList, on_delete=models.CASCADE, related_name="rules"
    )
    sequence = models.PositiveIntegerField()
    action = models.CharField(max_length=6, choices=ACTION_CHOICES, default="permit")
    prefix = models.CharField(max_length=64)
    #: The IPAM prefix this line names, when it names one; the text stays
    #: authoritative so a list can match networks Danbyte does not manage.
    prefix_obj = models.ForeignKey(
        "api.Prefix", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="prefix_list_rules",
    )
    ge = models.PositiveSmallIntegerField(null=True, blank=True)
    le = models.PositiveSmallIntegerField(null=True, blank=True)
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(
                fields=["prefix_list", "sequence"], name="uniq_prefixlistrule_seq"
            )
        ]

    def __str__(self) -> str:
        return f"{self.sequence} {self.action} {self.prefix}"

    def clean(self):
        self.prefix = normalize_network(self.prefix)
        net = ipaddress.ip_network(self.prefix)
        family = "ipv4" if net.version == 4 else "ipv6"
        if self.prefix_list_id and self.prefix_list.family != family:
            raise ValidationError(
                {"prefix": f"{self.prefix} is {family}; the list is "
                           f"{self.prefix_list.family}."}
            )
        maxlen = 32 if net.version == 4 else 128
        for name in ("ge", "le"):
            v = getattr(self, name)
            if v is not None and not (net.prefixlen <= v <= maxlen):
                raise ValidationError(
                    {name: f"Must be between {net.prefixlen} and {maxlen}."}
                )
        if self.ge is not None and self.le is not None and self.ge > self.le:
            raise ValidationError({"le": "le must be at least ge."})


# ─── Communities ─────────────────────────────────────────────────────────────

class Community(_Catalog):
    """A BGP community value with a name, so ``65000:100`` reads as
    ``CUSTOMER-ROUTES`` everywhere it is set or matched."""

    KIND_CHOICES = [
        ("standard", "Standard"),
        ("large", "Large"),
        ("extended", "Extended"),
    ]

    value = models.CharField(max_length=64, help_text='e.g. "65000:100"')
    kind = models.CharField(max_length=8, choices=KIND_CHOICES, default="standard")

    class Meta(_Catalog.Meta):
        verbose_name_plural = "communities"
        ordering = ["value"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "value"], name="uniq_community_tenant_value"
            )
        ]

    def __str__(self) -> str:
        return self.name or self.value


class CommunityList(_Catalog):
    KIND_CHOICES = [
        ("standard", "Standard"),
        ("expanded", "Expanded (regex)"),
        ("large", "Large"),
        ("extended", "Extended"),
    ]

    kind = models.CharField(max_length=8, choices=KIND_CHOICES, default="standard")

    class Meta(_Catalog.Meta):
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_communitylist_tenant_name"
            )
        ]


class CommunityListRule(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    community_list = models.ForeignKey(
        CommunityList, on_delete=models.CASCADE, related_name="rules"
    )
    sequence = models.PositiveIntegerField()
    action = models.CharField(max_length=6, choices=ACTION_CHOICES, default="permit")
    communities = models.ManyToManyField(
        Community, blank=True, related_name="community_list_rules"
    )
    #: Expanded lists match a pattern instead of named values.
    regex = models.CharField(max_length=255, blank=True, default="")
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(
                fields=["community_list", "sequence"],
                name="uniq_communitylistrule_seq",
            )
        ]

    def __str__(self) -> str:
        return f"{self.sequence} {self.action}"


# ─── AS-path lists ───────────────────────────────────────────────────────────

class ASPathList(_Catalog):
    class Meta(_Catalog.Meta):
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_aspathlist_tenant_name"
            )
        ]


class ASPathListRule(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    as_path_list = models.ForeignKey(
        ASPathList, on_delete=models.CASCADE, related_name="rules"
    )
    sequence = models.PositiveIntegerField()
    action = models.CharField(max_length=6, choices=ACTION_CHOICES, default="permit")
    regex = models.CharField(max_length=255, help_text='e.g. "^65010_"')
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(
                fields=["as_path_list", "sequence"], name="uniq_aspathlistrule_seq"
            )
        ]

    def __str__(self) -> str:
        return f"{self.sequence} {self.action} {self.regex}"


# ─── Routing policies (route maps) ──────────────────────────────────────────

class RoutingPolicy(_Catalog):
    """A route map: ordered rules that match and set."""

    class Meta(_Catalog.Meta):
        verbose_name_plural = "routing policies"
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_routingpolicy_tenant_name"
            )
        ]


class RoutingPolicyRule(models.Model):
    ORIGIN_CHOICES = [("igp", "IGP"), ("egp", "EGP"), ("incomplete", "Incomplete")]
    METRIC_TYPE_CHOICES = [(1, "Type 1"), (2, "Type 2")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    policy = models.ForeignKey(
        RoutingPolicy, on_delete=models.CASCADE, related_name="rules"
    )
    sequence = models.PositiveIntegerField()
    action = models.CharField(max_length=6, choices=ACTION_CHOICES, default="permit")
    description = models.CharField(max_length=255, blank=True, default="")

    # ── match ──────────────────────────────────────────────────────────
    match_prefix_lists = models.ManyToManyField(
        PrefixList, blank=True, related_name="matched_by"
    )
    match_community_lists = models.ManyToManyField(
        CommunityList, blank=True, related_name="matched_by"
    )
    match_as_path_lists = models.ManyToManyField(
        ASPathList, blank=True, related_name="matched_by"
    )
    match_next_hop = models.ForeignKey(
        PrefixList, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="matched_as_next_hop_by",
    )
    #: Vendor matches Danbyte does not model, e.g. {"tag": 100}.
    match_extra = models.JSONField(default=dict, blank=True)

    # ── set ────────────────────────────────────────────────────────────
    set_local_pref = models.PositiveIntegerField(null=True, blank=True)
    set_med = models.PositiveIntegerField(null=True, blank=True)
    set_weight = models.PositiveIntegerField(null=True, blank=True)
    set_origin = models.CharField(
        max_length=10, choices=ORIGIN_CHOICES, blank=True, default=""
    )
    set_next_hop = models.CharField(max_length=64, blank=True, default="")
    set_as_path_prepend = models.CharField(
        max_length=255, blank=True, default="", help_text='e.g. "65001 65001"'
    )
    set_communities = models.ManyToManyField(
        Community, blank=True, related_name="set_by"
    )
    set_communities_additive = models.BooleanField(default=False)
    set_metric_type = models.PositiveSmallIntegerField(
        choices=METRIC_TYPE_CHOICES, null=True, blank=True
    )
    set_extra = models.JSONField(default=dict, blank=True)
    #: Jump to another sequence after this one matches.
    continue_seq = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        ordering = ["sequence"]
        constraints = [
            models.UniqueConstraint(
                fields=["policy", "sequence"], name="uniq_routingpolicyrule_seq"
            )
        ]

    def __str__(self) -> str:
        return f"{self.sequence} {self.action}"

    def clean(self):
        if self.set_next_hop:
            self.set_next_hop = normalize_address(self.set_next_hop, "set_next_hop")


# ─── Keychains ───────────────────────────────────────────────────────────────

class RoutingKeychain(SecretBackedPSK, _Catalog):
    """The one secret-bearing routing object. BGP passwords and OSPF / IS-IS
    authentication reference a keychain; the key itself lives in the secret
    store, never in the row."""

    psk_secret_prefix = "routing-keychains"

    ALGORITHM_CHOICES = [
        ("md5", "MD5"),
        ("sha1", "SHA-1"),
        ("sha256", "SHA-256"),
        ("hmac-sha-256", "HMAC-SHA-256"),
    ]

    algorithm = models.CharField(
        max_length=16, choices=ALGORITHM_CHOICES, default="md5"
    )

    class Meta(_Catalog.Meta):
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_routingkeychain_tenant_name"
            )
        ]


# ─── Static routes ───────────────────────────────────────────────────────────

class StaticRoute(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """``ip route vrf X 10.0.0.0/8 10.1.1.1`` on one device."""

    KIND_CHOICES = [
        ("nexthop", "Next hop"),
        ("blackhole", "Blackhole"),
        ("reject", "Reject"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="static_routes"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="static_routes"
    )
    #: NULL = the global table.
    vrf = models.ForeignKey(
        "api.VRF", on_delete=models.CASCADE, null=True, blank=True,
        related_name="static_routes",
    )
    prefix = models.CharField(max_length=64)
    prefix_obj = models.ForeignKey(
        "api.Prefix", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="static_routes",
    )
    kind = models.CharField(max_length=10, choices=KIND_CHOICES, default="nexthop")
    next_hop = models.CharField(max_length=64, blank=True, default="")
    next_hop_interface = models.ForeignKey(
        "api.Interface", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="static_routes",
    )
    #: Route leaking: the table the next hop is looked up in.
    next_hop_vrf = models.ForeignKey(
        "api.VRF", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="leaked_static_routes",
    )
    distance = models.PositiveSmallIntegerField(null=True, blank=True)
    metric = models.PositiveIntegerField(null=True, blank=True)
    tag = models.PositiveIntegerField(null=True, blank=True)
    bfd = models.BooleanField(default=False)
    status = models.ForeignKey(
        "api.Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="static_routes",
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["device__name", "vrf__name", "prefix"]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "vrf", "prefix", "next_hop", "next_hop_interface"],
                name="uniq_staticroute_path",
                nulls_distinct=False,
            )
        ]

    def __str__(self) -> str:
        via = self.next_hop or (
            self.next_hop_interface.name if self.next_hop_interface_id else self.kind
        )
        return f"{self.prefix} via {via}"

    def clean(self):
        self.prefix = normalize_network(self.prefix)
        if self.next_hop:
            self.next_hop = normalize_address(self.next_hop)
        if self.kind == "nexthop" and not self.next_hop and not self.next_hop_interface_id:
            raise ValidationError(
                {"next_hop": "A next-hop route needs an address or an interface."}
            )
        if self.kind != "nexthop" and (self.next_hop or self.next_hop_interface_id):
            raise ValidationError(
                {"kind": f"A {self.kind} route has no next hop."}
            )
        if (
            self.next_hop_interface_id and self.device_id
            and self.next_hop_interface.device_id != self.device_id
        ):
            raise ValidationError(
                {"next_hop_interface": "That interface is on another device."}
            )
