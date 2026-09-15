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
import re
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
        ("interface", "Interface"),
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
        # An interface route points out of a port with no address - the
        # point-to-point and dial-up shape some platforms want written that way.
        if self.kind == "interface":
            if not self.next_hop_interface_id:
                raise ValidationError(
                    {"next_hop_interface": "An interface route needs an interface."}
                )
            if self.next_hop:
                raise ValidationError(
                    {"next_hop": "An interface route has no next-hop address."}
                )
        if self.kind in ("blackhole", "reject") and (self.next_hop or self.next_hop_interface_id):
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


# ─── BGP ─────────────────────────────────────────────────────────────────────

AFI_SAFI_CHOICES = [
    ("ipv4-unicast", "IPv4 unicast"),
    ("ipv6-unicast", "IPv6 unicast"),
    ("vpnv4-unicast", "VPNv4 unicast"),
    ("vpnv6-unicast", "VPNv6 unicast"),
    ("l2vpn-evpn", "L2VPN EVPN"),
    ("ipv4-labeled-unicast", "IPv4 labeled unicast"),
]
AFI_SAFI_VALUES = {v for v, _ in AFI_SAFI_CHOICES}

REMOTE_ASN_MODE_CHOICES = [
    ("asn", "Number"),
    ("external", "External (any other AS)"),
    ("internal", "Internal (own AS)"),
]
SEND_COMMUNITY_CHOICES = [
    ("none", "None"),
    ("standard", "Standard"),
    ("extended", "Extended"),
    ("both", "Standard and extended"),
    ("large", "Large"),
]
REDISTRIBUTE_SOURCE_CHOICES = [
    ("connected", "Connected"),
    ("static", "Static"),
    ("bgp", "BGP"),
    ("ospf", "OSPF"),
    ("isis", "IS-IS"),
    ("kernel", "Kernel"),
]


def validate_address_families(value, field="address_families"):
    if value in (None, ""):
        return []
    if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
        raise ValidationError({field: "Expected a list of address-family names."})
    bad = [v for v in value if v not in AFI_SAFI_VALUES]
    if bad:
        raise ValidationError(
            {field: f"Unknown address family: {', '.join(bad)}. "
                    f"Choose from {', '.join(sorted(AFI_SAFI_VALUES))}."}
        )
    return list(dict.fromkeys(value))


def normalize_address_or_blank(value, field):
    return normalize_address(value, field) if value else ""


class _DeviceInstance(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A routing process on one device, in one table."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="routing_%(class)ss"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="%(class)ss"
    )
    #: NULL = the global table.
    vrf = models.ForeignKey(
        "api.VRF", on_delete=models.CASCADE, null=True, blank=True,
        related_name="%(class)ss",
    )
    router_id = models.CharField(max_length=64, blank=True, default="")
    bfd = models.BooleanField(default=False)
    status = models.ForeignKey(
        "api.Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="%(class)ss",
    )
    description = models.CharField(max_length=255, blank=True, default="")
    #: Vendor knobs Danbyte does not model, reachable in a template as
    #: ``instance.extra.foo``.
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        abstract = True

    def clean(self):
        self.router_id = normalize_address_or_blank(self.router_id, "router_id")


class BGPInstance(_DeviceInstance):
    """``router bgp <asn>`` on a device - one per VRF, the way the box has it."""

    asn = models.ForeignKey(
        "api.ASN", on_delete=models.PROTECT, related_name="bgp_instances"
    )
    cluster_id = models.CharField(max_length=64, blank=True, default="")
    graceful_restart = models.BooleanField(default=False)

    class Meta:
        ordering = ["device__name", "vrf__name"]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "vrf"], name="uniq_bgpinstance_device_vrf",
                nulls_distinct=False,
            )
        ]

    def __str__(self) -> str:
        table = self.vrf.name if self.vrf_id else "global"
        return f"{self.device.name} · AS{self.asn.asn} · {table}"


class BGPAddressFamily(models.Model):
    """One ``address-family`` block of an instance."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    instance = models.ForeignKey(
        BGPInstance, on_delete=models.CASCADE, related_name="address_families"
    )
    afi_safi = models.CharField(max_length=24, choices=AFI_SAFI_CHOICES)
    #: Networks originated here, as CIDR text.
    networks = models.JSONField(default=list, blank=True)
    maximum_paths = models.PositiveSmallIntegerField(null=True, blank=True)
    maximum_paths_ibgp = models.PositiveSmallIntegerField(null=True, blank=True)
    import_policy = models.ForeignKey(
        RoutingPolicy, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bgp_af_imports",
    )
    export_policy = models.ForeignKey(
        RoutingPolicy, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bgp_af_exports",
    )
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["afi_safi"]
        constraints = [
            models.UniqueConstraint(
                fields=["instance", "afi_safi"], name="uniq_bgpaf_instance_afi"
            )
        ]

    def __str__(self) -> str:
        return self.afi_safi

    def clean(self):
        nets = self.networks or []
        if not isinstance(nets, list):
            raise ValidationError({"networks": "Expected a list of networks."})
        self.networks = [normalize_network(n, "networks") for n in nets]


class Redistribution(models.Model):
    """``redistribute <source> route-map <policy>`` under one address family
    or IGP instance - exactly one parent."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    bgp_af = models.ForeignKey(
        BGPAddressFamily, on_delete=models.CASCADE, null=True, blank=True,
        related_name="redistributions",
    )
    ospf_instance = models.ForeignKey(
        "OSPFInstance", on_delete=models.CASCADE, null=True, blank=True,
        related_name="redistributions",
    )
    isis_instance = models.ForeignKey(
        "ISISInstance", on_delete=models.CASCADE, null=True, blank=True,
        related_name="redistributions",
    )
    source = models.CharField(max_length=12, choices=REDISTRIBUTE_SOURCE_CHOICES)
    policy = models.ForeignKey(
        RoutingPolicy, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="redistributions",
    )
    metric = models.PositiveIntegerField(null=True, blank=True)
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["source"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(bgp_af__isnull=False, ospf_instance__isnull=True, isis_instance__isnull=True)
                    | models.Q(bgp_af__isnull=True, ospf_instance__isnull=False, isis_instance__isnull=True)
                    | models.Q(bgp_af__isnull=True, ospf_instance__isnull=True, isis_instance__isnull=False)
                ),
                name="redistribution_one_parent",
            ),
        ]

    def __str__(self) -> str:
        return self.source


class _PeerKnobs(models.Model):
    """The per-neighbour settings a session and a peer group share. Nullable
    on purpose: on a session, null means "as the group says"; on a group,
    null means the platform default."""

    address_families = models.JSONField(default=list, blank=True)
    import_policy = models.ForeignKey(
        RoutingPolicy, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="%(class)s_imports",
    )
    export_policy = models.ForeignKey(
        RoutingPolicy, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="%(class)s_exports",
    )
    bfd = models.BooleanField(null=True, blank=True)
    #: TTL; null = off.
    ebgp_multihop = models.PositiveSmallIntegerField(null=True, blank=True)
    next_hop_self = models.BooleanField(null=True, blank=True)
    route_reflector_client = models.BooleanField(null=True, blank=True)
    send_community = models.CharField(
        max_length=8, choices=SEND_COMMUNITY_CHOICES, blank=True, default=""
    )
    keepalive = models.PositiveSmallIntegerField(null=True, blank=True)
    hold_time = models.PositiveSmallIntegerField(null=True, blank=True)
    keychain = models.ForeignKey(
        RoutingKeychain, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="%(class)ss",
    )
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        abstract = True

    def clean(self):
        self.address_families = validate_address_families(self.address_families)


PEER_KNOBS = (
    "address_families", "import_policy", "export_policy", "bfd", "ebgp_multihop",
    "next_hop_self", "route_reflector_client", "send_community", "keepalive",
    "hold_time", "keychain",
)


class BGPPeerGroup(_PeerKnobs, _Catalog):
    """A named set of neighbour settings - the same ``SPINES`` group applies
    on every leaf."""

    remote_asn = models.PositiveBigIntegerField(null=True, blank=True)
    remote_asn_mode = models.CharField(
        max_length=8, choices=REMOTE_ASN_MODE_CHOICES, default="asn"
    )
    local_asn = models.ForeignKey(
        "api.ASN", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bgp_peer_groups_local",
    )
    #: A hint the template prints (``update-source loopback0``) - the source
    #: interface differs per device, so the group can only name it.
    update_source = models.CharField(max_length=64, blank=True, default="")

    class Meta(_Catalog.Meta):
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_bgppeergroup_tenant_name"
            )
        ]

    def clean(self):
        _PeerKnobs.clean(self)


class BGPSession(_PeerKnobs, NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """One ``neighbor`` line and its settings. A field left null inherits from
    the peer group, then the instance; ``effective()`` resolves them."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="bgp_sessions"
    )
    instance = models.ForeignKey(
        BGPInstance, on_delete=models.CASCADE, related_name="sessions"
    )
    name = models.CharField(max_length=128, blank=True, default="")
    peer_group = models.ForeignKey(
        BGPPeerGroup, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="sessions",
    )
    remote_asn = models.PositiveBigIntegerField(null=True, blank=True)
    remote_asn_mode = models.CharField(
        max_length=8, choices=REMOTE_ASN_MODE_CHOICES, blank=True, default=""
    )
    local_asn = models.ForeignKey(
        "api.ASN", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bgp_sessions_local",
    )
    local_address = models.ForeignKey(
        "api.IPAddress", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bgp_sessions_local",
    )
    #: The far end: an address, or an interface for unnumbered peering.
    remote_address = models.CharField(max_length=64, blank=True, default="")
    interface = models.ForeignKey(
        "api.Interface", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bgp_sessions",
    )
    #: The IPAM row for the far address, when Danbyte has it.
    remote_address_obj = models.ForeignKey(
        "api.IPAddress", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bgp_sessions_remote",
    )
    peer_device = models.ForeignKey(
        "api.Device", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bgp_peer_sessions",
    )
    peer_session = models.OneToOneField(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="peer_of",
    )
    status = models.ForeignKey(
        "api.Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="bgp_sessions",
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["instance__device__name", "remote_address", "interface__name"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(remote_address="", interface__isnull=False)
                    | ~models.Q(remote_address="") & models.Q(interface__isnull=True)
                ),
                name="bgpsession_address_xor_interface",
            ),
            models.UniqueConstraint(
                fields=["instance", "remote_address"],
                condition=~models.Q(remote_address=""),
                name="uniq_bgpsession_instance_address",
            ),
            models.UniqueConstraint(
                fields=["instance", "interface"],
                condition=models.Q(interface__isnull=False),
                name="uniq_bgpsession_instance_interface",
            ),
        ]

    def __str__(self) -> str:
        far = self.remote_address or (self.interface.name if self.interface_id else "?")
        return self.name or far

    @property
    def device_id(self):
        return self.instance.device_id

    def clean(self):
        _PeerKnobs.clean(self)
        self.remote_address = normalize_address_or_blank(self.remote_address, "remote_address")
        if bool(self.remote_address) == bool(self.interface_id):
            raise ValidationError(
                {"remote_address": "Give the far end as an address or as an "
                                   "interface (unnumbered), not both and not neither."}
            )
        inst = self.instance if self.instance_id else None
        if inst is not None:
            if self.interface_id and self.interface.device_id != inst.device_id:
                raise ValidationError({"interface": "That interface is on another device."})
            if self.local_address_id:
                la = self.local_address
                if la.assigned_device_id != inst.device_id:
                    raise ValidationError(
                        {"local_address": "That address is not on this device."}
                    )
                if la.vrf_id != inst.vrf_id:
                    raise ValidationError(
                        {"local_address": "That address sits in another table than "
                                          "the instance."}
                    )
        mode = self.remote_asn_mode or (self.peer_group.remote_asn_mode if self.peer_group_id else "asn")
        if mode == "asn":
            asn = self.remote_asn
            if asn is None and self.peer_group_id:
                asn = self.peer_group.remote_asn
            if asn is None:
                raise ValidationError(
                    {"remote_asn": "A remote AS is needed - on the session or its peer group."}
                )

    def effective(self) -> dict:
        """The settings the box ends up with: session → peer group → instance."""
        group = self.peer_group if self.peer_group_id else None
        out = {}
        for f in PEER_KNOBS:
            own = getattr(self, f)
            unset = own in (None, "", []) or own == {}
            gv = getattr(group, f) if group is not None else None
            val = gv if unset else own
            if f == "bfd" and val is None:
                val = self.instance.bfd
            out[f] = val
        extra = dict(group.extra or {}) if group is not None else {}
        extra.update(self.extra or {})
        out["extra"] = extra
        out["remote_asn_mode"] = self.remote_asn_mode or (
            group.remote_asn_mode if group is not None else "asn"
        )
        out["remote_asn"] = (
            self.remote_asn if self.remote_asn is not None
            else (group.remote_asn if group is not None else None)
        )
        local = self.local_asn or (group.local_asn if group is not None else None)
        out["local_asn"] = local.asn if local is not None else self.instance.asn.asn
        out["update_source"] = (
            self.local_address.assigned_interface.name
            if self.local_address_id and self.local_address.assigned_interface_id
            else (group.update_source if group is not None else "")
        )
        # iBGP or eBGP is a fact of the two AS numbers, not a setting: the
        # same AS on both ends is internal, anything else external.
        mode = out["remote_asn_mode"]
        if mode == "internal":
            out["kind"] = "ibgp"
        elif mode == "external":
            out["kind"] = "ebgp"
        elif out["remote_asn"] is not None:
            out["kind"] = "ibgp" if out["remote_asn"] == out["local_asn"] else "ebgp"
        else:
            out["kind"] = None
        return out


# ─── OSPF ────────────────────────────────────────────────────────────────────

NET_RE = re.compile(r"^[0-9a-fA-F]{2}(\.[0-9a-fA-F]{4}){3,9}\.00$")


def normalize_area_id(value: str) -> str:
    """``0`` and ``0.0.0.0`` are the same area; keep the dotted form the box
    prints unless the user wrote a plain number, which stays a number."""
    v = (value or "").strip()
    if v.isdigit():
        return str(int(v))
    try:
        return str(ipaddress.IPv4Address(v))
    except ValueError as exc:
        raise ValidationError({"area_id": "An area is a number or a dotted quad."}) from exc


class OSPFArea(_Catalog):
    KIND_CHOICES = [
        ("normal", "Normal"),
        ("stub", "Stub"),
        ("totally-stub", "Totally stubby"),
        ("nssa", "NSSA"),
        ("totally-nssa", "Totally NSSA"),
    ]

    area_id = models.CharField(max_length=15, help_text="0 or 0.0.0.0")
    kind = models.CharField(max_length=13, choices=KIND_CHOICES, default="normal")

    class Meta(_Catalog.Meta):
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_ospfarea_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.area_id})"

    def clean(self):
        self.area_id = normalize_area_id(self.area_id)


class OSPFInstance(_DeviceInstance):
    """``router ospf <process>`` on a device, in one table."""

    VERSION_CHOICES = [(2, "OSPFv2"), (3, "OSPFv3")]

    #: A number on IOS, a name on NX-OS and FRR - text carries both.
    process_id = models.CharField(max_length=32, blank=True, default="")
    version = models.PositiveSmallIntegerField(choices=VERSION_CHOICES, default=2)
    reference_bandwidth = models.PositiveIntegerField(
        null=True, blank=True, help_text="Mbit/s"
    )
    passive_by_default = models.BooleanField(default=False)
    default_originate = models.BooleanField(default=False)

    class Meta:
        ordering = ["device__name", "vrf__name", "process_id"]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "vrf", "version", "process_id"],
                name="uniq_ospfinstance_process", nulls_distinct=False,
            )
        ]

    def __str__(self) -> str:
        return f"{self.device.name} · OSPF{'v3' if self.version == 3 else ''} {self.process_id}".rstrip()


class _IGPInterface(models.Model):
    """An interface enrolled in an IGP instance."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    interface = models.ForeignKey(
        "api.Interface", on_delete=models.CASCADE, related_name="%(class)ss"
    )
    #: Null = the instance's ``passive_by_default``.
    passive = models.BooleanField(null=True, blank=True)
    bfd = models.BooleanField(default=False)
    keychain = models.ForeignKey(
        RoutingKeychain, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="%(class)ss",
    )
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        abstract = True

    def __str__(self) -> str:
        return self.interface.name

    def _check_device(self):
        if (
            self.interface_id and self.instance_id
            and self.interface.device_id != self.instance.device_id
        ):
            raise ValidationError({"interface": "That interface is on another device."})


class OSPFInterface(_IGPInterface):
    NETWORK_TYPE_CHOICES = [
        ("broadcast", "Broadcast"),
        ("point-to-point", "Point-to-point"),
        ("nbma", "NBMA"),
        ("point-to-multipoint", "Point-to-multipoint"),
    ]
    AUTH_CHOICES = [
        ("none", "None"),
        ("simple", "Simple"),
        ("md5", "MD5"),
        ("sha", "SHA"),
    ]

    instance = models.ForeignKey(
        OSPFInstance, on_delete=models.CASCADE, related_name="interfaces"
    )
    area = models.ForeignKey(OSPFArea, on_delete=models.PROTECT, related_name="interfaces")
    cost = models.PositiveIntegerField(null=True, blank=True)
    network_type = models.CharField(
        max_length=20, choices=NETWORK_TYPE_CHOICES, blank=True, default=""
    )
    priority = models.PositiveSmallIntegerField(null=True, blank=True)
    hello = models.PositiveSmallIntegerField(null=True, blank=True)
    dead = models.PositiveSmallIntegerField(null=True, blank=True)
    mtu_ignore = models.BooleanField(default=False)
    authentication = models.CharField(max_length=6, choices=AUTH_CHOICES, default="none")

    class Meta:
        ordering = ["interface__name"]
        constraints = [
            models.UniqueConstraint(
                fields=["instance", "interface"], name="uniq_ospfinterface_instance_iface"
            )
        ]

    def clean(self):
        self._check_device()
        if self.authentication != "none" and not self.keychain_id:
            raise ValidationError({"keychain": "Authentication needs a keychain."})


# ─── IS-IS ───────────────────────────────────────────────────────────────────

class ISISInstance(_DeviceInstance):
    """``router isis <process>`` on a device."""

    LEVEL_CHOICES = [("1", "Level 1"), ("2", "Level 2"), ("1-2", "Level 1-2")]
    METRIC_STYLE_CHOICES = [
        ("wide", "Wide"),
        ("narrow", "Narrow"),
        ("transition", "Transition"),
    ]
    AUTH_CHOICES = [("none", "None"), ("text", "Clear text"), ("md5", "MD5")]

    process = models.CharField(max_length=32, blank=True, default="")
    net = models.CharField(max_length=64, help_text="49.0001.0000.0000.0001.00")
    level = models.CharField(max_length=3, choices=LEVEL_CHOICES, default="1-2")
    metric_style = models.CharField(max_length=10, choices=METRIC_STYLE_CHOICES, default="wide")
    #: Area / domain authentication; per-interface hello auth is on the rows.
    authentication = models.CharField(max_length=4, choices=AUTH_CHOICES, default="none")
    keychain = models.ForeignKey(
        RoutingKeychain, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="isis_instances",
    )

    class Meta:
        ordering = ["device__name", "process"]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "process"], name="uniq_isisinstance_device_process"
            )
        ]

    def __str__(self) -> str:
        return f"{self.device.name} · IS-IS {self.process}".rstrip()

    def clean(self):
        super().clean()
        self.net = (self.net or "").strip().lower()
        if not NET_RE.match(self.net):
            raise ValidationError(
                {"net": "A NET reads AA.BBBB.…​.SSSS.SSSS.SSSS.00 - "
                        "e.g. 49.0001.0000.0000.0001.00."}
            )
        if self.authentication != "none" and not self.keychain_id:
            raise ValidationError({"keychain": "Authentication needs a keychain."})


class ISISInterface(_IGPInterface):
    NETWORK_TYPE_CHOICES = [
        ("point-to-point", "Point-to-point"),
        ("broadcast", "Broadcast"),
    ]
    AUTH_CHOICES = ISISInstance.AUTH_CHOICES

    instance = models.ForeignKey(
        ISISInstance, on_delete=models.CASCADE, related_name="interfaces"
    )
    #: ``["ipv4", "ipv6"]`` - FRR needs ``ip router isis`` per family.
    families = models.JSONField(default=list, blank=True)
    level = models.CharField(
        max_length=3, choices=ISISInstance.LEVEL_CHOICES, blank=True, default=""
    )
    metric = models.PositiveIntegerField(null=True, blank=True)
    metric_l2 = models.PositiveIntegerField(null=True, blank=True)
    network_type = models.CharField(
        max_length=14, choices=NETWORK_TYPE_CHOICES, blank=True, default=""
    )
    hello_interval = models.PositiveSmallIntegerField(null=True, blank=True)
    hello_multiplier = models.PositiveSmallIntegerField(null=True, blank=True)
    authentication = models.CharField(max_length=4, choices=AUTH_CHOICES, default="none")

    class Meta:
        ordering = ["interface__name"]
        constraints = [
            models.UniqueConstraint(
                fields=["instance", "interface"], name="uniq_isisinterface_instance_iface"
            )
        ]

    def clean(self):
        self._check_device()
        fams = self.families or []
        if not isinstance(fams, list) or any(f not in ("ipv4", "ipv6") for f in fams):
            raise ValidationError({"families": 'Families are "ipv4" and/or "ipv6".'})
        self.families = list(dict.fromkeys(fams)) or ["ipv4"]
        if self.authentication != "none" and not self.keychain_id:
            raise ValidationError({"keychain": "Authentication needs a keychain."})


def link_remote_address(session: BGPSession) -> None:
    """Point ``remote_address_obj`` at the IPAM row for the far address, when
    Danbyte has one in the instance's table - so the peer's page can show
    who it peers with. Nothing is created; a peer outside IPAM stays text."""
    from api.models import IPAddress

    match = None
    if session.remote_address:
        match = (
            IPAddress.objects.filter(
                tenant_id=session.tenant_id, ip_address=session.remote_address,
                vrf_id=session.instance.vrf_id,
            )
            .select_related("assigned_device")
            .first()
        )
    changed = []
    if session.remote_address_obj_id != (match.id if match else None):
        session.remote_address_obj = match
        changed.append("remote_address_obj")
    if match is not None and match.assigned_device_id and not session.peer_device_id:
        session.peer_device_id = match.assigned_device_id
        changed.append("peer_device")
    if changed:
        session.save(update_fields=changed)


# ─── Overlay: VTEPs ──────────────────────────────────────────────────────────

class VTEP(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """The VXLAN tunnel endpoint on one device: the loopback it sources
    from, the anycast gateway values, and - through memberships - the VNIs
    it serves. One per device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="vteps")
    device = models.OneToOneField(
        "api.Device", on_delete=models.CASCADE, related_name="vtep"
    )
    source_interface = models.ForeignKey(
        "api.Interface", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="vteps",
    )
    source_ip = models.ForeignKey(
        "api.IPAddress", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="vteps",
    )
    #: The shared VTEP address of an MLAG pair.
    anycast_ip = models.ForeignKey(
        "api.IPAddress", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="anycast_vteps",
    )
    #: The fabric-wide gateway MAC - repeated on every leaf, as the boxes have it.
    anycast_gateway_mac = models.CharField(max_length=17, blank=True, default="")
    arp_suppression = models.BooleanField(default=True)
    status = models.ForeignKey(
        "api.Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="vteps",
    )
    description = models.CharField(max_length=255, blank=True, default="")
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["device__name"]

    def __str__(self) -> str:
        return f"VTEP {self.device.name}"

    def clean(self):
        if self.source_interface_id and self.source_interface.device_id != self.device_id:
            raise ValidationError({"source_interface": "That interface is on another device."})
        for f in ("source_ip", "anycast_ip"):
            ip = getattr(self, f) if getattr(self, f"{f}_id") else None
            if ip is not None and ip.assigned_device_id not in (None, self.device_id):
                raise ValidationError({f: "That address is on another device."})
        mac = (self.anycast_gateway_mac or "").strip().lower()
        if mac and not re.match(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$", mac):
            raise ValidationError({"anycast_gateway_mac": "A MAC reads aa:bb:cc:dd:ee:ff."})
        self.anycast_gateway_mac = mac


class VTEPMembership(models.Model):
    """"This leaf serves VNI 10100" - a VTEP carrying one overlay, with the
    device-side choices the fabric-wide L2VPN cannot make."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    vtep = models.ForeignKey(VTEP, on_delete=models.CASCADE, related_name="memberships")
    l2vpn = models.ForeignKey(
        "api.L2VPN", on_delete=models.CASCADE, related_name="vtep_memberships"
    )
    #: The device-local VLAN the VNI maps to (NX-OS needs one for an L3VNI;
    #: a VNI stretched across sites has a termination VLAN per site).
    vlan = models.ForeignKey(
        "api.VLAN", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="vtep_memberships",
    )
    rd = models.CharField(max_length=32, blank=True, default="", help_text="Per-device RD override")
    ingress_replication = models.BooleanField(default=True)
    mcast_group = models.CharField(max_length=64, blank=True, default="")
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["l2vpn__identifier", "l2vpn__name"]
        constraints = [
            models.UniqueConstraint(fields=["vtep", "l2vpn"], name="uniq_vtepmembership_vtep_l2vpn")
        ]

    def __str__(self) -> str:
        return f"{self.vtep.device.name} · {self.l2vpn.name}"

    def clean(self):
        if self.l2vpn_id and self.l2vpn.type not in self.l2vpn.VXLAN_TYPES:
            raise ValidationError({"l2vpn": "A VTEP carries VXLAN overlays only."})
        if self.mcast_group:
            self.mcast_group = normalize_address(self.mcast_group, "mcast_group")


def resolve_membership_vlan(m: VTEPMembership):
    """The VLAN this leaf maps the VNI to: the membership's own choice, else
    the single termination VLAN at the device's site, else the sole
    termination anywhere, else none."""
    if m.vlan_id:
        return m.vlan
    terms = [t for t in m.l2vpn.terminations.all() if t.vlan_id]
    site_id = m.vtep.device.site_id
    local = [t.vlan for t in terms if t.vlan.site_id == site_id]
    if len(local) == 1:
        return local[0]
    if len(terms) == 1:
        return terms[0].vlan
    return None
