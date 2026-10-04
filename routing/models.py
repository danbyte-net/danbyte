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


# ─── BFD profiles ────────────────────────────────────────────────────────────

class BFDProfile(_Catalog):
    """BFD timers named once and applied wherever BFD is on - a session, a
    peer group, an instance or an enrolled interface. The same shape FRR's
    ``bfd profile`` and NX-OS's ``bfd-template`` have."""

    min_tx = models.PositiveIntegerField(default=300, help_text="ms")
    min_rx = models.PositiveIntegerField(default=300, help_text="ms")
    multiplier = models.PositiveSmallIntegerField(default=3)
    echo = models.BooleanField(default=False)

    class Meta(_Catalog.Meta):
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_bfdprofile_tenant_name"
            )
        ]

    def clean(self):
        if not self.min_tx or not self.min_rx:
            raise ValidationError({"min_tx": "Intervals are milliseconds, at least 1."})
        if not self.multiplier:
            raise ValidationError({"multiplier": "The detect multiplier is at least 1."})


def _bfd_profile_field():
    return models.ForeignKey(
        BFDProfile, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="%(class)ss",
    )


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

def _owner_check(name: str) -> models.CheckConstraint:
    """A routing row belongs to a device or to a virtual machine (#217)."""
    return models.CheckConstraint(
        condition=(
            models.Q(device__isnull=False, virtual_machine__isnull=True)
            | models.Q(device__isnull=True, virtual_machine__isnull=False)
        ),
        name=name,
    )


def _on_device(**kw) -> models.Q:
    return models.Q(device__isnull=False, **kw)


def _on_vm(**kw) -> models.Q:
    return models.Q(virtual_machine__isnull=False, **kw)


class _Owned:
    """The device or virtual machine a routing row belongs to."""

    @property
    def owner(self):
        return self.device if self.device_id else getattr(self, "virtual_machine", None)

    @property
    def owner_name(self) -> str:
        o = self.owner
        return o.name if o is not None else "?"


class StaticRoute(_Owned, NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """``ip route vrf X 10.0.0.0/8 10.1.1.1`` on one device or VM."""

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
        "api.Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="static_routes",
    )
    #: A virtual router or a routing VM (#217); exactly one of the two is set.
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, null=True, blank=True,
        related_name="static_routes",
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
    #: The same, on a VM.
    next_hop_vm_interface = models.ForeignKey(
        "api.VMInterface", on_delete=models.SET_NULL, null=True, blank=True,
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
                nulls_distinct=False, condition=_on_device(),
            ),
            models.UniqueConstraint(
                fields=["virtual_machine", "vrf", "prefix", "next_hop",
                        "next_hop_vm_interface"],
                name="uniq_staticroute_vm_path",
                nulls_distinct=False, condition=_on_vm(),
            ),
            _owner_check("staticroute_device_xor_vm"),
        ]

    @property
    def via_interface(self):
        return self.next_hop_interface if self.next_hop_interface_id else (
            self.next_hop_vm_interface if self.next_hop_vm_interface_id else None)

    def __str__(self) -> str:
        iface = self.via_interface
        via = self.next_hop or (iface.name if iface is not None else self.kind)
        return f"{self.prefix} via {via}"

    def clean(self):
        self.prefix = normalize_network(self.prefix)
        if self.next_hop:
            self.next_hop = normalize_address(self.next_hop)
        if bool(self.device_id) == bool(self.virtual_machine_id):
            raise ValidationError({"device": "A route belongs to a device or to a VM."})
        if self.next_hop_interface_id and self.virtual_machine_id:
            raise ValidationError({"next_hop_interface": "Pick one of the VM's interfaces."})
        if self.next_hop_vm_interface_id and self.device_id:
            raise ValidationError({"next_hop_vm_interface": "Pick one of the device's "
                                                            "interfaces."})
        has_iface = self.via_interface is not None
        if self.kind == "nexthop" and not self.next_hop and not has_iface:
            raise ValidationError(
                {"next_hop": "A next-hop route needs an address or an interface."}
            )
        # An interface route points out of a port with no address - the
        # point-to-point and dial-up shape some platforms want written that way.
        if self.kind == "interface":
            if not has_iface:
                raise ValidationError(
                    {"next_hop_interface": "An interface route needs an interface."}
                )
            if self.next_hop:
                raise ValidationError(
                    {"next_hop": "An interface route has no next-hop address."}
                )
        if self.kind in ("blackhole", "reject") and (self.next_hop or has_iface):
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
        if (
            self.next_hop_vm_interface_id and self.virtual_machine_id
            and self.next_hop_vm_interface.vm_id != self.virtual_machine_id
        ):
            raise ValidationError(
                {"next_hop_vm_interface": "That interface is on another VM."}
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
    ("eigrp", "EIGRP"),
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


class _DeviceInstance(_Owned, NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A routing process on one device or VM, in one table."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="routing_%(class)ss"
    )
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="%(class)ss",
    )
    #: A virtual router or a routing VM (#217); exactly one of the two is set.
    virtual_machine = models.ForeignKey(
        "api.VirtualMachine", on_delete=models.CASCADE, null=True, blank=True,
        related_name="%(class)ss",
    )
    #: NULL = the global table.
    vrf = models.ForeignKey(
        "api.VRF", on_delete=models.CASCADE, null=True, blank=True,
        related_name="%(class)ss",
    )
    router_id = models.CharField(max_length=64, blank=True, default="")
    bfd = models.BooleanField(default=False)
    #: The timers BFD runs with when on; null = the platform default.
    bfd_profile = _bfd_profile_field()
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
        if bool(self.device_id) == bool(getattr(self, "virtual_machine_id", None)):
            raise ValidationError({"device": "An instance runs on a device or on a VM."})
        self.router_id = normalize_address_or_blank(self.router_id, "router_id")

    def owns_interface(self, interface=None, vm_interface=None) -> bool:
        """Is this port on the same box as the instance?"""
        if interface is not None:
            return self.device_id is not None and interface.device_id == self.device_id
        if vm_interface is not None:
            return (self.virtual_machine_id is not None
                    and vm_interface.vm_id == self.virtual_machine_id)
        return True


class BGPInstance(_DeviceInstance):
    """``router bgp <asn>`` on a device - one per VRF, the way the box has it."""

    asn = models.ForeignKey(
        "api.ASN", on_delete=models.PROTECT, related_name="bgp_instances"
    )
    cluster_id = models.CharField(max_length=64, blank=True, default="")
    graceful_restart = models.BooleanField(default=False)
    #: ``distance bgp <ebgp> <ibgp> <local>`` - all three or none.
    distance_ebgp = models.PositiveSmallIntegerField(null=True, blank=True)
    distance_ibgp = models.PositiveSmallIntegerField(null=True, blank=True)
    distance_local = models.PositiveSmallIntegerField(null=True, blank=True)
    #: ``bgp bestpath as-path multipath-relax`` - ECMP across differing paths
    #: of equal length, which every leaf-spine fabric turns on.
    bestpath_multipath_relax = models.BooleanField(default=False)
    # ── MPLS L3VPN, on a per-VRF instance. The VRF carries the RD and route
    # targets; these say whether and how this table is leaked into the VPN
    # family (``rd vpn export``, ``rt vpn import/export`` come from the VRF).
    vpn_export = models.BooleanField(default=False)
    vpn_import = models.BooleanField(default=False)
    #: ``label vpn export auto`` or a fixed label number. Blank = not set.
    vpn_label_export = models.CharField(max_length=8, blank=True, default="")
    #: ``nexthop vpn export <address>``. Blank = not set.
    vpn_nexthop_export = models.CharField(max_length=45, blank=True, default="")

    class Meta:
        ordering = ["device__name", "vrf__name"]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "vrf"], name="uniq_bgpinstance_device_vrf",
                nulls_distinct=False, condition=_on_device(),
            ),
            models.UniqueConstraint(
                fields=["virtual_machine", "vrf"], name="uniq_bgpinstance_vm_vrf",
                nulls_distinct=False, condition=_on_vm(),
            ),
            _owner_check("bgpinstance_device_xor_vm"),
        ]

    def __str__(self) -> str:
        table = self.vrf.name if self.vrf_id else "global"
        return f"{self.owner_name} · AS{self.asn.asn} · {table}"

    def clean(self):
        super().clean()
        label = (self.vpn_label_export or "").strip().lower()
        if label and label != "auto" and not label.isdigit():
            raise ValidationError(
                {"vpn_label_export": "'auto' or a label number."}
            )
        self.vpn_label_export = label
        if self.vpn_nexthop_export:
            self.vpn_nexthop_export = normalize_address(
                self.vpn_nexthop_export, "vpn_nexthop_export"
            )


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
    # EVPN only: leak the VRF's unicast routes into EVPN as type-5.
    advertise_ipv4_unicast = models.BooleanField(default=False)
    advertise_ipv6_unicast = models.BooleanField(default=False)
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
    eigrp_instance = models.ForeignKey(
        "EIGRPInstance", on_delete=models.CASCADE, null=True, blank=True,
        related_name="redistributions",
    )
    source = models.CharField(max_length=12, choices=REDISTRIBUTE_SOURCE_CHOICES)
    policy = models.ForeignKey(
        RoutingPolicy, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="redistributions",
    )
    metric = models.PositiveIntegerField(null=True, blank=True)
    #: IS-IS only: ``redistribute <family> <source> level-<n>``. Blank = the
    #: instance's own level and IPv4.
    level = models.CharField(max_length=3, blank=True, default="")
    family = models.CharField(
        max_length=4, choices=FAMILY_CHOICES, blank=True, default=""
    )
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["source"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(bgp_af__isnull=False, ospf_instance__isnull=True,
                             isis_instance__isnull=True, eigrp_instance__isnull=True)
                    | models.Q(bgp_af__isnull=True, ospf_instance__isnull=False,
                               isis_instance__isnull=True, eigrp_instance__isnull=True)
                    | models.Q(bgp_af__isnull=True, ospf_instance__isnull=True,
                               isis_instance__isnull=False, eigrp_instance__isnull=True)
                    | models.Q(bgp_af__isnull=True, ospf_instance__isnull=True,
                               isis_instance__isnull=True, eigrp_instance__isnull=False)
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
    bfd_profile = _bfd_profile_field()
    #: TTL; null = off.
    ebgp_multihop = models.PositiveSmallIntegerField(null=True, blank=True)
    next_hop_self = models.BooleanField(null=True, blank=True)
    route_reflector_client = models.BooleanField(null=True, blank=True)
    send_community = models.CharField(
        max_length=8, choices=SEND_COMMUNITY_CHOICES, blank=True, default=""
    )
    keepalive = models.PositiveSmallIntegerField(null=True, blank=True)
    hold_time = models.PositiveSmallIntegerField(null=True, blank=True)
    #: ``neighbor X default-originate``.
    default_originate = models.BooleanField(null=True, blank=True)
    #: ``neighbor X default-originate route-map <policy>``.
    default_originate_policy = models.ForeignKey(
        RoutingPolicy, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="%(class)s_default_originates",
    )
    #: RFC 5549 - IPv4 routes over an IPv6 next hop. Every unnumbered EVPN
    #: fabric session carries it.
    capability_extended_nexthop = models.BooleanField(null=True, blank=True)
    #: GTSM (RFC 5082) hop count; null = off.
    ttl_security_hops = models.PositiveSmallIntegerField(null=True, blank=True)
    #: ``neighbor X maximum-prefix N`` - the session drops past it.
    maximum_prefix = models.PositiveIntegerField(null=True, blank=True)
    #: ``neighbor X allowas-in N`` - times the local AS may appear in a path.
    allowas_in = models.PositiveSmallIntegerField(null=True, blank=True)
    as_override = models.BooleanField(null=True, blank=True)
    remove_private_as = models.BooleanField(null=True, blank=True)
    #: ``soft-reconfiguration inbound``.
    soft_reconfiguration = models.BooleanField(null=True, blank=True)
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
    "address_families", "import_policy", "export_policy", "bfd", "bfd_profile",
    "ebgp_multihop", "next_hop_self", "route_reflector_client", "send_community",
    "keepalive", "hold_time", "keychain", "default_originate",
    "default_originate_policy", "maximum_prefix",
    "allowas_in", "as_override", "remove_private_as", "soft_reconfiguration",
    "capability_extended_nexthop", "ttl_security_hops",
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
    #: Unnumbered peering out of a VM's port (#217).
    vm_interface = models.ForeignKey(
        "api.VMInterface", on_delete=models.SET_NULL, null=True, blank=True,
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
        ordering = ["instance__device__name", "instance__virtual_machine__name",
                    "remote_address", "interface__name"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(remote_address="", interface__isnull=False,
                             vm_interface__isnull=True)
                    | models.Q(remote_address="", interface__isnull=True,
                               vm_interface__isnull=False)
                    | ~models.Q(remote_address="") & models.Q(interface__isnull=True,
                                                              vm_interface__isnull=True)
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
            models.UniqueConstraint(
                fields=["instance", "vm_interface"],
                condition=models.Q(vm_interface__isnull=False),
                name="uniq_bgpsession_instance_vm_interface",
            ),
        ]

    @property
    def port(self):
        """The unnumbered port, on a device or a VM."""
        if self.interface_id:
            return self.interface
        return self.vm_interface if self.vm_interface_id else None

    def __str__(self) -> str:
        port = self.port
        far = self.remote_address or (port.name if port is not None else "?")
        return self.name or far

    @property
    def device_id(self):
        return self.instance.device_id

    def clean(self):
        _PeerKnobs.clean(self)
        self.remote_address = normalize_address_or_blank(self.remote_address, "remote_address")
        if self.interface_id and self.vm_interface_id:
            raise ValidationError({"interface": "One interface, not two."})
        if bool(self.remote_address) == (self.port is not None):
            raise ValidationError(
                {"remote_address": "Give the far end as an address or as an "
                                   "interface (unnumbered), not both and not neither."}
            )
        inst = self.instance if self.instance_id else None
        if inst is not None:
            if self.interface_id and not inst.owns_interface(interface=self.interface):
                raise ValidationError({"interface": "That interface is on another device."})
            if self.vm_interface_id and not inst.owns_interface(
                vm_interface=self.vm_interface
            ):
                raise ValidationError({"vm_interface": "That interface is on another VM."})
            if self.local_address_id:
                la = self.local_address
                on_box = (la.assigned_vm_id == inst.virtual_machine_id
                          if inst.virtual_machine_id
                          else la.assigned_device_id == inst.device_id)
                if not on_box:
                    raise ValidationError(
                        {"local_address": "That address is not on this "
                                          + ("VM." if inst.virtual_machine_id else "device.")}
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
            if f == "bfd_profile" and val is None:
                val = self.instance.bfd_profile
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
                condition=_on_device(),
            ),
            models.UniqueConstraint(
                fields=["virtual_machine", "vrf", "version", "process_id"],
                name="uniq_ospfinstance_vm_process", nulls_distinct=False,
                condition=_on_vm(),
            ),
            _owner_check("ospfinstance_device_xor_vm"),
        ]

    def __str__(self) -> str:
        return f"{self.owner_name} · OSPF{'v3' if self.version == 3 else ''} {self.process_id}".rstrip()


class _IGPInterface(models.Model):
    """An interface enrolled in an IGP instance."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    interface = models.ForeignKey(
        "api.Interface", on_delete=models.CASCADE, null=True, blank=True,
        related_name="%(class)ss",
    )
    #: The port on a VM-owned instance (#217); exactly one of the two is set.
    vm_interface = models.ForeignKey(
        "api.VMInterface", on_delete=models.CASCADE, null=True, blank=True,
        related_name="%(class)ss",
    )
    #: Null = the instance's ``passive_by_default``.
    passive = models.BooleanField(null=True, blank=True)
    bfd = models.BooleanField(default=False)
    #: Null = the instance's profile, else the platform default.
    bfd_profile = _bfd_profile_field()
    keychain = models.ForeignKey(
        RoutingKeychain, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="%(class)ss",
    )
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        abstract = True

    @property
    def port(self):
        return self.interface if self.interface_id else self.vm_interface

    def __str__(self) -> str:
        port = self.port
        return port.name if port is not None else "?"

    def _check_device(self):
        if bool(self.interface_id) == bool(self.vm_interface_id):
            raise ValidationError({"interface": "Pick one interface."})
        if not self.instance_id:
            return
        inst = self.instance
        if self.interface_id and not inst.owns_interface(interface=self.interface):
            raise ValidationError({"interface": "That interface is on another device."})
        if self.vm_interface_id and not inst.owns_interface(vm_interface=self.vm_interface):
            raise ValidationError({"vm_interface": "That interface is on another VM."})


def _igp_port_constraints(prefix: str) -> list:
    return [
        models.UniqueConstraint(
            fields=["instance", "interface"], name=f"uniq_{prefix}_instance_iface",
            condition=models.Q(interface__isnull=False),
        ),
        models.UniqueConstraint(
            fields=["instance", "vm_interface"], name=f"uniq_{prefix}_instance_vm_iface",
            condition=models.Q(vm_interface__isnull=False),
        ),
        models.CheckConstraint(
            condition=(
                models.Q(interface__isnull=False, vm_interface__isnull=True)
                | models.Q(interface__isnull=True, vm_interface__isnull=False)
            ),
            name=f"{prefix}_iface_xor_vm_iface",
        ),
    ]


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
        ordering = ["interface__name", "vm_interface__name"]
        constraints = _igp_port_constraints("ospfinterface")

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
    # ── Timers and LSP settings. Null = the platform default, and a template
    # prints nothing, so a stanza only carries what an operator set.
    lsp_gen_interval = models.PositiveSmallIntegerField(null=True, blank=True)
    spf_interval = models.PositiveSmallIntegerField(null=True, blank=True)
    lsp_mtu = models.PositiveIntegerField(null=True, blank=True)
    #: ``spf-delay-ietf init-delay A short-delay B long-delay C holddown D
    #: time-to-learn E`` - five values that only make sense together; the
    #: render context folds them into one object.
    spf_init_delay = models.PositiveIntegerField(null=True, blank=True)
    spf_short_delay = models.PositiveIntegerField(null=True, blank=True)
    spf_long_delay = models.PositiveIntegerField(null=True, blank=True)
    spf_holddown = models.PositiveIntegerField(null=True, blank=True)
    spf_time_to_learn = models.PositiveIntegerField(null=True, blank=True)
    log_adjacency_changes = models.BooleanField(default=False)
    #: ``default-information originate <family> <level> [always]``.
    DEFAULT_ORIGINATE_CHOICES = [
        ("", "No"),
        ("on", "When a default exists"),
        ("always", "Always"),
    ]
    default_originate_ipv4 = models.CharField(
        max_length=6, choices=DEFAULT_ORIGINATE_CHOICES, blank=True, default=""
    )
    default_originate_ipv6 = models.CharField(
        max_length=6, choices=DEFAULT_ORIGINATE_CHOICES, blank=True, default=""
    )

    #: The words FRR uses for each level, for a template that prints them.
    LEVEL_FRR = {"1": "level-1", "2": "level-2-only", "1-2": "level-1-2"}

    class Meta:
        ordering = ["device__name", "process"]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "process"], name="uniq_isisinstance_device_process",
                condition=_on_device(),
            ),
            models.UniqueConstraint(
                fields=["virtual_machine", "process"], name="uniq_isisinstance_vm_process",
                condition=_on_vm(),
            ),
            _owner_check("isisinstance_device_xor_vm"),
        ]

    def __str__(self) -> str:
        return f"{self.owner_name} · IS-IS {self.process}".rstrip()

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
        ordering = ["interface__name", "vm_interface__name"]
        constraints = _igp_port_constraints("isisinterface")

    def clean(self):
        self._check_device()
        fams = self.families or []
        if not isinstance(fams, list) or any(f not in ("ipv4", "ipv6") for f in fams):
            raise ValidationError({"families": 'Families are "ipv4" and/or "ipv6".'})
        self.families = list(dict.fromkeys(fams)) or ["ipv4"]
        if self.authentication != "none" and not self.keychain_id:
            raise ValidationError({"keychain": "Authentication needs a keychain."})


# ─── EIGRP ───────────────────────────────────────────────────────────────────

class EIGRPInstance(_DeviceInstance):
    """``router eigrp <asn>`` on a device - classic mode by AS number, named
    mode when ``name`` is set (``router eigrp NAME`` with the AS under its
    address family)."""

    asn = models.PositiveIntegerField(help_text="1…65535")
    name = models.CharField(max_length=64, blank=True, default="", help_text="Named mode")
    #: ``K1 K2 K3 K4 K5`` - blank is the platform default (1 0 1 0 0).
    k_values = models.CharField(max_length=32, blank=True, default="")
    variance = models.PositiveSmallIntegerField(null=True, blank=True)
    maximum_paths = models.PositiveSmallIntegerField(null=True, blank=True)
    passive_by_default = models.BooleanField(default=False)
    stub = models.BooleanField(default=False)

    class Meta:
        ordering = ["device__name", "vrf__name", "asn"]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "vrf", "asn"],
                name="uniq_eigrpinstance_asn", nulls_distinct=False,
                condition=_on_device(),
            ),
            models.UniqueConstraint(
                fields=["virtual_machine", "vrf", "asn"],
                name="uniq_eigrpinstance_vm_asn", nulls_distinct=False,
                condition=_on_vm(),
            ),
            _owner_check("eigrpinstance_device_xor_vm"),
        ]

    def __str__(self) -> str:
        return f"{self.owner_name} · EIGRP {self.asn}"

    def clean(self):
        super().clean()
        if not 1 <= (self.asn or 0) <= 65535:
            raise ValidationError({"asn": "An EIGRP AS number is 1 to 65535."})
        k = (self.k_values or "").split()
        if k:
            if len(k) != 5 or any(not v.isdigit() or int(v) > 255 for v in k):
                raise ValidationError(
                    {"k_values": "Five values 0-255, K1 to K5 - for example 1 0 1 0 0."}
                )
            self.k_values = " ".join(str(int(v)) for v in k)


class EIGRPInterface(_IGPInterface):
    AUTH_CHOICES = [
        ("none", "None"),
        ("md5", "MD5"),
        ("hmac-sha-256", "HMAC-SHA-256"),
    ]

    instance = models.ForeignKey(
        EIGRPInstance, on_delete=models.CASCADE, related_name="interfaces"
    )
    hello_interval = models.PositiveSmallIntegerField(null=True, blank=True)
    hold_time = models.PositiveSmallIntegerField(null=True, blank=True)
    bandwidth_percent = models.PositiveSmallIntegerField(null=True, blank=True)
    #: Null = the platform default (on).
    split_horizon = models.BooleanField(null=True, blank=True)
    #: ``ip summary-address eigrp`` networks announced out of this port.
    summary_addresses = models.JSONField(default=list, blank=True)
    authentication = models.CharField(max_length=12, choices=AUTH_CHOICES, default="none")

    class Meta:
        ordering = ["interface__name", "vm_interface__name"]
        constraints = _igp_port_constraints("eigrpinterface")

    def clean(self):
        self._check_device()
        if self.authentication != "none" and not self.keychain_id:
            raise ValidationError({"keychain": "Authentication needs a keychain."})
        nets = self.summary_addresses or []
        if not isinstance(nets, list) or any(not isinstance(n, str) for n in nets):
            raise ValidationError({"summary_addresses": "Expected a list of networks."})
        self.summary_addresses = [normalize_network(n, "summary_addresses") for n in nets]


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


# ─── EVPN multihoming ────────────────────────────────────────────────────────

_MAC_RE = re.compile(r"^([0-9a-f]{2}:){5}[0-9a-f]{2}$")
_ESI_RE = re.compile(r"^([0-9a-f]{2}:){9}[0-9a-f]{2}$")


def normalize_mac(value: str, field: str) -> str:
    raw = (value or "").strip().lower().replace("-", ":").replace(".", "")
    if raw and ":" not in raw and len(raw) == 12:
        raw = ":".join(raw[i:i + 2] for i in range(0, 12, 2))
    if raw and not _MAC_RE.match(raw):
        raise ValidationError({field: "A MAC address, like 44:38:39:ff:00:01."})
    return raw


class EthernetSegment(_Catalog):
    """One EVPN Ethernet segment: the LAG on each of two or more leaves that
    a multihomed server plugs into.

    FRR names a segment either by a full 10-byte ESI (type 0) or by a type-3
    pair of ``es-id`` + ``es-sys-mac``; a segment stores one or the other.
    The interfaces that share it live on different devices, which is the
    whole point - the segment is the thing the reviewer looks at to see that
    leaf1 swp5 and leaf2 swp5 are the same server.
    """

    #: Type-0: the full ESI, ten octets. Blank when es_id + sys_mac is used.
    esi = models.CharField(max_length=32, blank=True, default="")
    #: Type-3: ``evpn mh es-id N`` and ``evpn mh es-sys-mac``.
    es_id = models.PositiveIntegerField(null=True, blank=True)
    sys_mac = models.CharField(max_length=17, blank=True, default="")
    #: ``evpn mh es-df-pref``: who forwards BUM traffic for the segment.
    df_preference = models.PositiveIntegerField(null=True, blank=True)
    interfaces = models.ManyToManyField(
        "api.Interface", blank=True, related_name="ethernet_segments"
    )

    class Meta(_Catalog.Meta):
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_ethernetsegment_tenant_name"
            ),
        ]

    def clean(self):
        self.esi = (self.esi or "").strip().lower()
        if self.esi and not _ESI_RE.match(self.esi):
            raise ValidationError(
                {"esi": "Ten colon-separated octets, like 00:11:22:33:44:55:66:77:88:99."}
            )
        self.sys_mac = normalize_mac(self.sys_mac, "sys_mac")
        typed = self.es_id is not None or bool(self.sys_mac)
        if self.esi and typed:
            raise ValidationError(
                {"esi": "Give either a full ESI or an es-id with a system MAC, not both."}
            )
        if not self.esi and not (self.es_id is not None and self.sys_mac):
            raise ValidationError(
                {"es_id": "A segment needs a full ESI, or both an es-id and a system MAC."}
            )
        if self.es_id is not None and not 1 <= self.es_id <= 16777215:
            raise ValidationError({"es_id": "1 to 16777215."})


# ─── MPLS / LDP ──────────────────────────────────────────────────────────────


class LDPInstance(_DeviceInstance):
    """``mpls ldp`` on a provider router - one per device.

    LDP has no VRF: labels are for the global table, and the VPN side of an
    L3VPN lives on the per-VRF BGP instance (``vpn_export`` and friends).
    """

    LABEL_CHOICES = [
        ("all", "All routes"),
        ("host-routes", "Host routes only"),
    ]

    #: ``discovery transport-address``. Blank = the router-id.
    transport_address = models.CharField(max_length=45, blank=True, default="")
    #: ``label local allocate host-routes``: only /32s get a label, which is
    #: all an L3VPN needs and keeps the label table small.
    label_allocation = models.CharField(
        max_length=12, choices=LABEL_CHOICES, default="host-routes"
    )
    interfaces = models.ManyToManyField(
        "api.Interface", blank=True, related_name="ldp_instances"
    )
    #: LDP stays on devices: label switching is a provider-router job.
    device = models.ForeignKey(
        "api.Device", on_delete=models.CASCADE, related_name="ldpinstances"
    )
    virtual_machine = None
    #: The abstract parent's descriptor would otherwise answer, and fail.
    virtual_machine_id = None

    class Meta:
        ordering = ["device__name"]
        constraints = [
            models.UniqueConstraint(
                fields=["device"], name="uniq_ldpinstance_device"
            )
        ]

    def __str__(self) -> str:
        return f"{self.device.name} · LDP"

    def clean(self):
        super().clean()
        if self.vrf_id:
            raise ValidationError({"vrf": "LDP runs in the global table."})
        if self.transport_address:
            self.transport_address = normalize_address(
                self.transport_address, "transport_address"
            )
