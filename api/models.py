import ipaddress
import re
import uuid

from django.contrib.contenttypes.fields import GenericForeignKey
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models, transaction
from django.utils import timezone

from .dcim_choices import (
    AUX_PORT_TYPE_CHOICES,
    CABLE_TYPE_CHOICES,
    CONSOLE_PORT_TYPE_CHOICES,
    INTERFACE_TYPE_CHOICES,
    POWER_OUTLET_TYPE_CHOICES,
    POWER_PORT_TYPE_CHOICES,
)
from core.models import (
    CustomFieldsMixin,
    Organization,
    TaggableMixin,
    Tenant,
    TimestampedModel,
)


# ─── Human-readable per-tenant object numbers (numid) ──────────────────────
#
# Every object keeps its UUID PK (load-bearing — FKs + tenant isolation depend
# on it). ``numid`` is a *separate*, human-facing sequential number assigned on
# create, namespaced per (tenant, object-type): tenant A's cable #30 and tenant
# B's cable #30 are different objects, and each tenant counts from 1. This is
# the NetBox-migration affordance — a cable physically tagged "27" can map to
# cable #27 — see issue #82.


class NumIdSequence(models.Model):
    """Per-(tenant, model) monotonic counter backing ``NumIdMixin``.

    One row per (tenant, ``app.model``); ``next_value`` increments it under a
    row lock so concurrent creates never collide. This is the allocator that
    makes numid unique within a tenant without a UUID-style global space.
    """

    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="numid_sequences"
    )
    model_label = models.CharField(max_length=100)
    last_value = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "model_label"], name="uniq_numidseq_tenant_model"
            )
        ]

    def __str__(self) -> str:
        return f"{self.model_label} @ {self.tenant_id}: {self.last_value}"

    @classmethod
    def next_value(cls, tenant_id, model_label: str) -> int:
        """Allocate and return the next numid for ``(tenant_id, model_label)``."""
        with transaction.atomic():
            # Ensure the counter row exists (get_or_create swallows the race on
            # first concurrent create), then lock it for the read-modify-write.
            cls.objects.get_or_create(tenant_id=tenant_id, model_label=model_label)
            row = cls.objects.select_for_update().get(
                tenant_id=tenant_id, model_label=model_label
            )
            row.last_value = (row.last_value or 0) + 1
            row.save(update_fields=["last_value"])
            return row.last_value


class NumIdMixin(models.Model):
    """Adds a per-tenant ``numid`` to a tenant-scoped model.

    The field is nullable: it's assigned on first save once a tenant is set, and
    pre-existing rows are backfilled by ``manage.py assign_numids``. Uniqueness
    per (tenant, object-type) is guaranteed by ``NumIdSequence`` (the allocator),
    not a DB constraint — so this mixin contributes only a field and inherits
    cleanly even when the concrete model defines its own ``Meta``.

    Bulk paths that bypass ``save()`` (``bulk_create``) leave numid null until
    the next ``assign_numids`` run — intentional, to keep bulk inserts cheap.
    """

    numid = models.PositiveIntegerField(
        null=True, blank=True, editable=False, db_index=True,
        help_text="Per-tenant human-readable number (see NumIdSequence).",
    )

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if self.numid is None and getattr(self, "tenant_id", None) is not None:
            self.numid = NumIdSequence.next_value(self.tenant_id, self._meta.label_lower)
            # A caller that scoped the write with update_fields (e.g.
            # ip.save(update_fields=["role"])) on a still-null row would otherwise
            # burn the sequence value without persisting numid — leaving it NULL
            # and advancing the counter on every such edit. Persist it too.
            update_fields = kwargs.get("update_fields")
            if update_fields is not None:
                kwargs["update_fields"] = {*update_fields, "numid"}
        super().save(*args, **kwargs)


# Largest network whose individual hosts we'll enumerate (next-available list,
# "show available" rows, ICMP discovery sweep). Family-agnostic: a /116 v6
# (4096 addrs) is enumerable, a /64 is not. Single source so the cap can't
# drift between the API, the frontend gate, and the discovery worker.
ENUMERABLE_HOST_CAP = 4096


def is_enumerable(net, cap: int = ENUMERABLE_HOST_CAP) -> bool:
    """Whether ``net`` (an ``ipaddress`` network) is small enough to enumerate
    host-by-host. ``None`` → False."""
    return net is not None and net.num_addresses <= cap


# ─── VRF (Virtual Routing and Forwarding) ─────────────────────────────────


class RouteTarget(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A BGP MPLS-VPN route target (RT) — used to control which VRFs import
    and export each other's prefixes.

    Names look like ``65000:100`` (ASN:value) and are tenant-unique. VRFs
    refer to them via the ``import_targets`` and ``export_targets`` M2Ms; a
    typical VPN has one RT exported by each VRF in the topology, with each
    importing the others'.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="route_targets"
    )
    name = models.CharField(
        max_length=21,
        help_text="ASN:value, e.g. 65000:100 or 192.0.2.1:42.",
    )
    description = models.TextField(blank=True)
    owning_site = models.ForeignKey(
        "Site", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Set = local to that site (enhanced site separation); "
        "empty = global to the tenant.",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_rt_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class VRF(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A routing context inside a tenant.

    Two prefixes with identical CIDR in different VRFs are valid and distinct
    — that's the whole point of L3VPN-style separation. The conventional
    "Global" VRF is modelled as ``vrf=NULL`` on Prefix/IPAddress so we don't
    need a special seeded row.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="vrfs"
    )
    name = models.CharField(max_length=100)
    rd = models.CharField(
        max_length=21, blank=True, default="", help_text="Route Distinguisher, e.g. 65001:100"
    )
    description = models.TextField(blank=True)
    enforce_unique = models.BooleanField(
        default=True,
        help_text="Reject overlapping child prefixes within this VRF.",
    )
    color = models.CharField(
        max_length=7, blank=True, default="",
        help_text="Optional 7-char hex used as the section header accent.",
    )
    import_targets = models.ManyToManyField(
        RouteTarget,
        related_name="importing_vrfs",
        blank=True,
        help_text=("Route targets this VRF accepts routes from. "
                   "In a hub-and-spoke VPN the hub imports each spoke's RT."),
    )
    export_targets = models.ManyToManyField(
        RouteTarget,
        related_name="exporting_vrfs",
        blank=True,
        help_text=("Route targets this VRF tags its own routes with. "
                   "Other VRFs importing this RT will receive those routes."),
    )
    owning_site = models.ForeignKey(
        "Site", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Set = local to that site (enhanced site separation); "
        "empty = global to the tenant.",
    )

    class Meta:
        ordering = ["name"]
        unique_together = ("tenant", "name")

    def __str__(self) -> str:
        return self.name


# ─── Sites / device types / VLANs ─────────────────────────────────────────


class Site(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """Data center, branch office, or other physical location."""

    GATEWAY_POLICY_CHOICES = [
        ("first", "First usable address"),
        ("last", "Last usable address"),
        ("none", "No automatic gateway"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="sites"
    )
    name = models.CharField(max_length=255)
    region = models.ForeignKey(
        "Region", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="sites",
        help_text="Structured geographic/organisational region this site sits in.",
    )
    # Free-text address line (legacy). The structured within-site hierarchy is
    # the separate Location model.
    location = models.CharField(max_length=255, blank=True)
    # Where the site sits on the world map (the Site map page). Set by
    # dragging/placing the marker there, or typed into the site form.
    latitude = models.DecimalField(
        max_digits=9, decimal_places=6, null=True, blank=True,
        help_text="GPS latitude (decimal degrees).",
    )
    longitude = models.DecimalField(
        max_digits=9, decimal_places=6, null=True, blank=True,
        help_text="GPS longitude (decimal degrees).",
    )
    description = models.TextField(blank=True)
    gateway_policy = models.CharField(
        max_length=8,
        choices=GATEWAY_POLICY_CHOICES,
        default="first",
        help_text=(
            "When a new prefix is created at this site, automatically register "
            "an IP with role=gateway at the first or last usable address."
        ),
    )
    default_prefix = models.ForeignKey(
        "Prefix",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="default_for_sites",
        help_text=(
            "The prefix new addresses at this site come from by default — so "
            "staff working at one site don't have to hunt for the right subnet. "
            "A hint, not a constraint: the picker still offers every prefix."
        ),
    )
    vrfs = models.ManyToManyField(
        VRF,
        blank=True,
        related_name="sites",
        help_text="Which VRFs operate at this site. Documentation only — not enforced.",
    )

    class Meta:
        unique_together = ("tenant", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class Manufacturer(NumIdMixin, TimestampedModel):
    """Maker of a device (Dell, Cisco, Juniper, …)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="manufacturers"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    url = models.URLField(blank=True, default="")
    description = models.TextField(blank=True)
    owning_site = models.ForeignKey(
        "Site", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Set = local to that site (enhanced site separation); "
        "empty = global to the tenant.",
    )

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(fields=["tenant", "slug"],
                                    name="uniq_mfr_tenant_slug"),
        ]

    def __str__(self) -> str:
        return self.name


# Shared by DeviceType (hardware default) and Device (per-box override).
AIRFLOW_CHOICES = [
    ("front-to-rear", "Front to rear"),
    ("rear-to-front", "Rear to front"),
    ("left-to-right", "Left to right"),
    ("right-to-left", "Right to left"),
    ("passive", "Passive"),
    ("mixed", "Mixed"),
]


class LifecycleMixin(models.Model):
    """Vendor lifecycle window for a catalog item (hardware type, OS
    platform). All dates are user-entered — nothing ships pre-filled — and
    everything renders from them: the lifetime progress bar runs
    ``release_date`` → ``end_of_support``, and ``lifecycle_state`` is the
    most severe passed milestone."""

    release_date = models.DateField(
        null=True, blank=True,
        help_text="GA / first-ship date — the start of the lifetime bar.",
    )
    end_of_sale = models.DateField(
        null=True, blank=True,
        help_text="Vendor stops selling it (EoS).",
    )
    end_of_security_updates = models.DateField(
        null=True, blank=True,
        help_text="Last security / vulnerability fixes.",
    )
    end_of_support = models.DateField(
        null=True, blank=True,
        help_text="End of life — vendor support and maintenance ends.",
    )
    lifecycle_url = models.URLField(
        blank=True, default="",
        help_text="Vendor end-of-life notice.",
    )

    class Meta:
        abstract = True

    @property
    def lifecycle_state(self) -> str:
        """'' (no dates) · supported · eos · security_ended · eol —
        the most severe milestone that has passed wins."""
        today = timezone.localdate()
        if self.end_of_support and self.end_of_support <= today:
            return "eol"
        if (self.end_of_security_updates
                and self.end_of_security_updates <= today):
            return "security_ended"
        if self.end_of_sale and self.end_of_sale <= today:
            return "eos"
        if any((self.release_date, self.end_of_sale,
                self.end_of_security_updates, self.end_of_support)):
            return "supported"
        return ""


class DeviceType(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin,
                 LifecycleMixin):
    """User-defined device type / template (e.g. ``Dell R650``, ``Cisco C9300``).

    DeviceType is the *template* — manufacturer + model + part number + slot
    counts. Concrete ``Device`` instances inherit from this template.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="device_types"
    )
    name = models.CharField(max_length=255)
    manufacturer = models.ForeignKey(
        Manufacturer,
        on_delete=models.PROTECT,
        related_name="device_types",
        null=True, blank=True,
    )
    model = models.CharField(max_length=255, blank=True,
                             help_text="Vendor part / model identifier.")
    part_number = models.CharField(max_length=128, blank=True)
    platform = models.ForeignKey(
        "Platform", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="device_types",
        help_text="Default OS platform for devices of this type. A device "
        "without its own platform inherits it (its effective platform).",
    )
    u_height = models.PositiveSmallIntegerField(
        default=1,
        help_text="Height in rack units. 0 for non-rack devices.",
    )
    RACK_WIDTH_CHOICES = [("full", "Full width"), ("half", "Half width")]
    rack_width = models.CharField(
        max_length=4, choices=RACK_WIDTH_CHOICES, default="full",
        help_text=("Horizontal footprint in the rack. Half-width gear (e.g. a "
                   "half-U ToR switch like the Mellanox SN2010) mounts two "
                   "side-by-side in the same U."),
    )
    front_image = models.ImageField(
        upload_to="device-type-images/", blank=True, null=True,
        help_text="Front rack-face image, rendered in rack elevations.",
    )
    rear_image = models.ImageField(
        upload_to="device-type-images/", blank=True, null=True,
        help_text="Rear rack-face image, rendered in rack elevations.",
    )
    faceplate = models.JSONField(
        null=True, blank=True, default=None,
        help_text=("Saved front-panel layout (v1 doc: groups of port slots "
                   "referencing component-template names). Null = automatic "
                   "layout computed from the device's interfaces."),
    )
    is_full_depth = models.BooleanField(
        default=True,
        help_text=("Occupies both the front and rear rack faces. Full-depth "
                   "devices show hatched on the opposite face in elevations."),
    )
    airflow = models.CharField(
        max_length=50, choices=AIRFLOW_CHOICES, blank=True, default="",
        help_text="Default cooling airflow direction for this hardware.",
    )
    WEIGHT_UNIT_CHOICES = [
        ("kg", "kg"), ("g", "g"), ("lb", "lb"), ("oz", "oz"),
    ]
    SUBDEVICE_ROLE_CHOICES = [("parent", "Parent"), ("child", "Child")]
    subdevice_role = models.CharField(
        max_length=8, choices=SUBDEVICE_ROLE_CHOICES, blank=True, default="",
        help_text="Parent = chassis with device bays; child = installs into "
        "a parent's bay (blade / FEX). Blank for ordinary hardware.",
    )
    exclude_from_utilization = models.BooleanField(
        default=False,
        help_text="Don't count devices of this type toward rack space "
        "utilisation (blanking panels, cable management).",
    )
    weight = models.DecimalField(
        max_digits=8, decimal_places=2, null=True, blank=True,
        help_text="Chassis weight (see weight_unit).",
    )
    weight_unit = models.CharField(
        max_length=8, choices=WEIGHT_UNIT_CHOICES, blank=True, default="",
    )
    description = models.TextField(blank=True)
    owning_site = models.ForeignKey(
        "Site", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Set = local to that site (enhanced site separation); "
        "empty = global to the tenant.",
    )

    class Meta:
        unique_together = ("tenant", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


# ─── Device-type component templates ─────────────────────────────────────────
#
# A DeviceType owns a set of component *templates* — the ports the hardware
# ships with. Creating a Device of that type materialises every template into
# a concrete component (Interface, ConsolePort, …) on the device, so a
# "C9300-48P" stamps out its 48 interfaces + console + 2 PSU inlets each time.
# Matches NetBox's *template semantics (and the community devicetype-library),
# so imported device types carry their components over. Templates hold no
# per-device state — they're part of the type definition, and per the
# zero-pre-filled-data rule none ship by default.

class _ComponentTemplate(TimestampedModel):
    """Shared shape for per-device-type component templates. Tenant scope is
    inherited via device_type."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=64)
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        abstract = True

    def __str__(self) -> str:
        return f"{self.device_type.name}:{self.name}"


class InterfaceTemplate(_ComponentTemplate):
    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE, related_name="interface_templates"
    )
    type = models.CharField(
        max_length=64, blank=True, default="", choices=INTERFACE_TYPE_CHOICES,
        help_text="Physical/logical media type, e.g. 10gbase-x-sfpp.",
    )
    enabled = models.BooleanField(default=True)
    poe_mode = models.CharField(max_length=8, blank=True, default="")
    poe_type = models.CharField(max_length=32, blank=True, default="")
    mgmt_only = models.BooleanField(
        default=False, help_text="A dedicated management interface."
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


class ConsolePortTemplate(_ComponentTemplate):
    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="console_port_templates",
    )
    type = models.CharField(
        max_length=32, blank=True, default="", choices=CONSOLE_PORT_TYPE_CHOICES
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


class ConsoleServerPortTemplate(_ComponentTemplate):
    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="console_server_port_templates",
    )
    type = models.CharField(
        max_length=32, blank=True, default="", choices=CONSOLE_PORT_TYPE_CHOICES
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


class AuxPortTemplate(_ComponentTemplate):
    """Template for an aux port — USB / video / card slot / grounding, the
    connectors no other component type models."""

    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="aux_port_templates",
    )
    type = models.CharField(
        max_length=32, blank=True, default="", choices=AUX_PORT_TYPE_CHOICES
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


class PowerPortTemplate(_ComponentTemplate):
    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="power_port_templates",
    )
    type = models.CharField(
        max_length=32, blank=True, default="", choices=POWER_PORT_TYPE_CHOICES
    )
    maximum_draw = models.PositiveIntegerField(
        null=True, blank=True, help_text="Maximum draw, watts."
    )
    allocated_draw = models.PositiveIntegerField(
        null=True, blank=True, help_text="Allocated draw, watts."
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


class PowerOutletTemplate(_ComponentTemplate):
    FEED_LEG_CHOICES = [("A", "A"), ("B", "B"), ("C", "C")]

    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="power_outlet_templates",
    )
    type = models.CharField(
        max_length=32, blank=True, default="", choices=POWER_OUTLET_TYPE_CHOICES
    )
    power_port_template = models.ForeignKey(
        PowerPortTemplate, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="outlet_templates",
        help_text="The inlet on this type that feeds the outlet (same type).",
    )
    feed_leg = models.CharField(
        max_length=1, choices=FEED_LEG_CHOICES, blank=True, default="",
        help_text="Which phase leg feeds this outlet, on three-phase gear.",
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


class RearPortTemplate(_ComponentTemplate):
    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="rear_port_templates",
    )
    type = models.CharField(max_length=64, blank=True, default="")
    positions = models.PositiveSmallIntegerField(
        default=1, help_text="Number of strands / front-port positions."
    )
    is_splitter = models.BooleanField(
        default=False,
        help_text="Optical splitter: every front port fans out from "
        "position 1 and carries the same signal (PON). Requires positions=1.",
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


class FrontPortTemplate(_ComponentTemplate):
    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="front_port_templates",
    )
    type = models.CharField(max_length=64, blank=True, default="")
    rear_port_template = models.ForeignKey(
        RearPortTemplate, on_delete=models.CASCADE,
        related_name="front_port_templates",
    )
    rear_port_position = models.PositiveSmallIntegerField(default=1)
    positions = models.PositiveSmallIntegerField(
        default=1, help_text="Fibre strands the connector carries."
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]
        # A connector spans a range of positions; overlap isn't a DB constraint.


class ModuleBayTemplate(_ComponentTemplate):
    """A slot the hardware ships with (e.g. a C9300's "Network Module") that
    accepts a pluggable :class:`ModuleType`. ``position`` is the value the
    installed module's ``{module}`` port-name token resolves to."""

    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="module_bay_templates",
    )
    position = models.CharField(
        max_length=32, blank=True, default="",
        help_text="Value {module} resolves to in installed port names (e.g. 1).",
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


class DeviceBayTemplate(_ComponentTemplate):
    """A slot in a parent chassis that holds a whole child Device (blade
    server, FEX) — unlike a module bay, whose occupant is not an independent
    device."""

    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="device_bay_templates",
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


class InventoryItemTemplate(_ComponentTemplate):
    """A physical part the hardware ships with that isn't a connectable
    component — PSU, fan tray, CPU, factory-fitted transceiver."""

    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE,
        related_name="inventory_item_templates",
    )
    manufacturer = models.ForeignKey(
        Manufacturer, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="inventory_item_templates",
    )
    part_id = models.CharField(max_length=128, blank=True, default="")

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


# ─── Module types (pluggable line cards / network modules) ───────────────────

class ModuleType(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A pluggable hardware model — line card, uplink module, PSU sled. Like a
    DeviceType but installed *into* a device's module bay rather than a rack.
    Carries its own interface templates whose names may use ``{module}``."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="module_types"
    )
    manufacturer = models.ForeignKey(
        Manufacturer, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="module_types",
    )
    name = models.CharField(max_length=255)
    part_number = models.CharField(max_length=128, blank=True, default="")
    description = models.TextField(blank=True)
    faceplate = models.JSONField(
        null=True, blank=True,
        help_text="Saved faceplate layout for this module (FaceplateDoc v1); "
        "null → automatic layout. Composed into the host device's render at "
        "the bay it's installed in.",
    )

    class Meta:
        unique_together = ("tenant", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


class ModuleInterfaceTemplate(_ComponentTemplate):
    """Interface a module type contributes to its host device when installed.
    Names may carry ``{module}`` (→ the bay's position) and ``{position}``
    (→ the device's stack member)."""

    module_type = models.ForeignKey(
        ModuleType, on_delete=models.CASCADE,
        related_name="interface_templates",
    )
    type = models.CharField(
        max_length=64, blank=True, default="", choices=INTERFACE_TYPE_CHOICES,
        help_text="Media type slug, e.g. 10gbase-x-sfpp.",
    )
    enabled = models.BooleanField(default=True)
    poe_mode = models.CharField(max_length=8, blank=True, default="")
    poe_type = models.CharField(max_length=32, blank=True, default="")
    mgmt_only = models.BooleanField(default=False)

    class Meta:
        unique_together = ("module_type", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.module_type.name}:{self.name}"


# ─── Position-aware component names ─────────────────────────────────────────
#
# Template names may carry a ``{position}`` token that resolves to the
# device's stack member number (``Device.vc_position``) when components are
# stamped — so a "Catalyst 9300-24P" template named
# ``GigabitEthernet{position}/0/1`` materialises as ``…1/0/1`` on member 1 and
# ``…2/0/1`` on member 2. Standalone devices resolve the token to 1; vendors
# that count from 0 (Juniper ``ge-0/0/0``) write ``{position:0}`` to set the
# standalone default. The token can sit anywhere in the name, so any vendor
# prefix style works: ``ge-{position}/0/0``, ``{position}/1/1``, ….

POSITION_TOKEN_RE = re.compile(r"\{position(?::(\d+))?\}")


def render_component_name(name: str, position: int | None) -> str:
    """Resolve ``{position}`` / ``{position:N}`` in a template name. Uses the
    device's stack position when it has one, else the token's standalone
    default (``N``, or 1)."""

    def _sub(m: re.Match) -> str:
        default = int(m.group(1)) if m.group(1) is not None else 1
        return str(position if position is not None else default)

    return POSITION_TOKEN_RE.sub(_sub, name)


# ``{module}`` resolves to the module BAY's position when a module's
# interfaces are stamped onto the host device (``Te1/{module}/1`` in bay
# position "1" → ``Te1/1/1``). No standalone default: an unresolved token is
# left literal so the gap is visible rather than silently renamed.
MODULE_TOKEN_RE = re.compile(r"\{module\}")


def render_module_name(name: str, module_position: str) -> str:
    if not module_position:
        return name
    return MODULE_TOKEN_RE.sub(module_position, name)


def sync_positional_interface_names(device, old_position, new_position) -> int:
    """Rename this device's interfaces after a stack-membership change.

    For every interface template of the device's type that carries a
    ``{position}`` token, the template is rendered at the *old* effective
    position to find the interface, then renamed to the *new* rendering —
    so joining, moving within, or leaving a stack keeps port names truthful
    (``2/0/24`` really is member 2). Name clashes are skipped, never
    clobbered. Returns how many interfaces were renamed."""

    dt = device.device_type
    if dt is None or old_position == new_position:
        return 0
    by_name = {i.name: i for i in device.interfaces.all()}
    renames: list[tuple[object, str]] = []
    for t in dt.interface_templates.all():
        if not POSITION_TOKEN_RE.search(t.name):
            continue
        old_name = render_component_name(t.name, old_position)
        new_name = render_component_name(t.name, new_position)
        if old_name == new_name:
            continue
        iface = by_name.get(old_name)
        # Skip: nothing to rename, or the target name is already taken by a
        # different interface (hand-made or conflicting) — never clobber.
        if iface is None or (new_name in by_name and by_name[new_name] is not iface):
            continue
        renames.append((iface, new_name))
    for iface, new_name in renames:
        iface.name = new_name
    if renames:
        from django.db import transaction as _tx

        with _tx.atomic():
            for iface, new_name in renames:
                iface.save(update_fields=["name"])
    return len(renames)


@transaction.atomic
def materialize_device_components(device) -> dict[str, int]:
    """Stamp a device's components out of its device type's templates —
    called when a Device is created with a device_type. Skips any name the
    device already has (idempotent, and safe for imports that pre-create
    ports). Returns {component_kind: created_count} for reporting.

    Ordering matters: rear ports before front ports, power ports before
    outlets — the latter FK the former."""

    dt = device.device_type
    if dt is None:
        return {}
    created: dict[str, int] = {}

    def _names(manager) -> set[str]:
        return set(manager.values_list("name", flat=True))

    pos = device.vc_position

    have = _names(device.interfaces)
    made = [
        Interface(device=device, name=n, type=t.type, enabled=t.enabled,
                  mgmt_only=t.mgmt_only, poe_mode=t.poe_mode,
                  poe_type=t.poe_type)
        for t in dt.interface_templates.all()
        if (n := render_component_name(t.name, pos)) not in have
    ]
    Interface.objects.bulk_create(made)
    created["interfaces"] = len(made)

    have = _names(device.console_ports)
    made = [
        ConsolePort(device=device, name=n, type=t.type,
                    description=t.description)
        for t in dt.console_port_templates.all()
        if (n := render_component_name(t.name, pos)) not in have
    ]
    ConsolePort.objects.bulk_create(made)
    created["console_ports"] = len(made)

    have = _names(device.console_server_ports)
    made = [
        ConsoleServerPort(device=device, name=n, type=t.type,
                          description=t.description)
        for t in dt.console_server_port_templates.all()
        if (n := render_component_name(t.name, pos)) not in have
    ]
    ConsoleServerPort.objects.bulk_create(made)
    created["console_server_ports"] = len(made)

    have = _names(device.power_ports)
    made = [
        PowerPort(device=device, name=n, type=t.type,
                  maximum_draw=t.maximum_draw, allocated_draw=t.allocated_draw,
                  description=t.description)
        for t in dt.power_port_templates.all()
        if (n := render_component_name(t.name, pos)) not in have
    ]
    PowerPort.objects.bulk_create(made)
    created["power_ports"] = len(made)

    # Outlets after ports: resolve each outlet's feeding inlet by name.
    ports_by_name = {p.name: p for p in device.power_ports.all()}
    have = _names(device.power_outlets)
    made = [
        PowerOutlet(
            device=device, name=n, type=t.type, feed_leg=t.feed_leg,
            power_port=(
                ports_by_name.get(
                    render_component_name(t.power_port_template.name, pos)
                )
                if t.power_port_template_id else None
            ),
            description=t.description,
        )
        for t in dt.power_outlet_templates.all()
        if (n := render_component_name(t.name, pos)) not in have
    ]
    PowerOutlet.objects.bulk_create(made)
    created["power_outlets"] = len(made)

    # Rear ports before front ports (front ports map onto rear positions).
    have = _names(device.rear_ports)
    made = [
        RearPort(device=device, name=n, type=t.type, positions=t.positions,
                 is_splitter=t.is_splitter)
        for t in dt.rear_port_templates.all()
        if (n := render_component_name(t.name, pos)) not in have
    ]
    RearPort.objects.bulk_create(made)
    created["rear_ports"] = len(made)

    rears_by_name = {r.name: r for r in device.rear_ports.all()}
    have = _names(device.front_ports)
    made = [
        FrontPort(
            device=device, name=n, type=t.type,
            rear_port=rears_by_name[
                render_component_name(t.rear_port_template.name, pos)
            ],
            rear_port_position=t.rear_port_position,
            positions=t.positions,
        )
        for t in dt.front_port_templates.select_related("rear_port_template")
        if (n := render_component_name(t.name, pos)) not in have
        and render_component_name(t.rear_port_template.name, pos) in rears_by_name
    ]
    FrontPort.objects.bulk_create(made)
    created["front_ports"] = len(made)

    have = _names(device.aux_ports)
    made = [
        AuxPort(device=device, name=n, type=t.type, description=t.description)
        for t in dt.aux_port_templates.all()
        if (n := render_component_name(t.name, pos)) not in have
    ]
    AuxPort.objects.bulk_create(made)
    created["aux_ports"] = len(made)

    have = _names(device.inventory_items)
    made = [
        InventoryItem(
            device=device, name=n, manufacturer=t.manufacturer,
            part_id=t.part_id, description=t.description,
        )
        for t in dt.inventory_item_templates.select_related("manufacturer")
        if (n := render_component_name(t.name, pos)) not in have
    ]
    InventoryItem.objects.bulk_create(made)
    created["inventory_items"] = len(made)

    have = _names(device.device_bays)
    made = [
        DeviceBay(device=device, name=n, description=t.description)
        for t in dt.device_bay_templates.all()
        if (n := render_component_name(t.name, pos)) not in have
    ]
    DeviceBay.objects.bulk_create(made)
    created["device_bays"] = len(made)

    have = _names(device.module_bays)
    made = [
        ModuleBay(device=device, name=n, position=t.position,
                  description=t.description)
        for t in dt.module_bay_templates.all()
        if (n := render_component_name(t.name, pos)) not in have
    ]
    ModuleBay.objects.bulk_create(made)
    created["module_bays"] = len(made)

    # Services aren't positional — plain name, carries protocol/ports/monitored.
    have = _names(device.services)
    made = [
        Service(tenant=device.tenant, device=device, name=t.name,
                protocol=t.protocol, ports=list(t.ports or []),
                monitored=t.monitor, description=t.description)
        for t in dt.service_templates.all()
        if t.name not in have
    ]
    Service.objects.bulk_create(made)
    created["services"] = len(made)
    # Wire up any monitored ones. No-ops on a fresh device with no IP yet; the
    # checks activate when a primary IP appears (DeviceViewSet.perform_update).
    if made:
        from monitoring.service_checks import sync_service_checks

        for svc in made:
            if svc.monitored:
                sync_service_checks(svc)

    return created


# Component kinds that a device inherits from its type, for the "sync from
# type" diff/apply. (device manager attr, device-type template relation,
# positional?). Front/rear + outlet/inlet ordering is handled on removal.
_SYNC_KINDS = [
    ("interfaces", "interface_templates", True),
    ("console_ports", "console_port_templates", True),
    ("console_server_ports", "console_server_port_templates", True),
    ("power_ports", "power_port_templates", True),
    ("power_outlets", "power_outlet_templates", True),
    ("rear_ports", "rear_port_templates", True),
    ("front_ports", "front_port_templates", True),
    ("aux_ports", "aux_port_templates", True),
    ("inventory_items", "inventory_item_templates", True),
    ("device_bays", "device_bay_templates", True),
    ("module_bays", "module_bay_templates", True),
    ("services", "service_templates", False),
]


def diff_device_components(device) -> dict[str, dict[str, list[str]]]:
    """Name-level diff of a device's components against what its type's
    templates would produce now. Returns ``{kind: {"add": [...], "extra":
    [...]}}`` — *add* = template names the device is missing, *extra* = device
    components with no matching template (candidates for removal). Only kinds
    with a difference are included. Empty dict if the device has no type."""
    dt = device.device_type
    if dt is None:
        return {}
    pos = device.vc_position
    out: dict[str, dict[str, list[str]]] = {}
    for dev_rel, tmpl_rel, positional in _SYNC_KINDS:
        expected = {
            render_component_name(t.name, pos) if positional else t.name
            for t in getattr(dt, tmpl_rel).all()
        }
        actual = set(getattr(device, dev_rel).values_list("name", flat=True))
        add = sorted(expected - actual)
        extra = sorted(actual - expected)
        if add or extra:
            out[dev_rel] = {"add": add, "extra": extra}
    return out


def sync_device_components(device, *, remove_extra: bool = False) -> dict:
    """Bring a device in line with its type's current templates. Always
    *adds* missing components (via ``materialize_device_components`` — idempotent
    and relational-aware). When ``remove_extra`` is set, also **deletes**
    components the type no longer defines (cascading their cabling / IP links —
    destructive, hence opt-in). Returns ``{"added": {...}, "removed": {...}}``.
    """
    diff = diff_device_components(device)
    added = materialize_device_components(device)
    removed: dict[str, int] = {}
    if remove_extra:
        # Dependents before their targets: front ports FK rear ports, outlets
        # FK inlets — remove the referencing side first to avoid FK errors.
        order = [
            "front_ports", "power_outlets", "services", "interfaces",
            "console_ports", "console_server_ports", "aux_ports",
            "inventory_items", "device_bays", "module_bays",
            "rear_ports", "power_ports",
        ]
        for dev_rel in order:
            names = diff.get(dev_rel, {}).get("extra", [])
            if names:
                getattr(device, dev_rel).filter(name__in=names).delete()
                removed[dev_rel] = len(names)
    return {"added": {k: v for k, v in added.items() if v}, "removed": removed}


def _module_interface_names(module) -> list[str]:
    """The concrete interface names a module contributes to its host device —
    ``{module}`` → the bay's position, then ``{position}`` → the device's
    stack member. Used by both install and uninstall so they always agree."""
    bay = module.module_bay
    pos = module.device.vc_position
    return [
        render_component_name(render_module_name(t.name, bay.position), pos)
        for t in module.module_type.interface_templates.all()
    ]


def install_module(module) -> int:
    """Stamp the module type's interfaces onto the host device. Idempotent —
    names the device already has are skipped. Returns the created count."""
    names = _module_interface_names(module)
    types = {  # rendered name → template, for type/enabled/mgmt flags
        n: t
        for n, t in zip(names, module.module_type.interface_templates.all())
    }
    have = set(module.device.interfaces.values_list("name", flat=True))
    made = [
        Interface(device=module.device, name=n, type=t.type,
                  enabled=t.enabled, mgmt_only=t.mgmt_only)
        for n, t in types.items()
        if n not in have
    ]
    Interface.objects.bulk_create(made)
    return len(made)


def uninstall_module(module) -> int:
    """Remove the interfaces this module contributed (matched by rendered
    name). Returns the deleted count."""
    names = _module_interface_names(module)
    deleted, _ = module.device.interfaces.filter(name__in=names).delete()
    return deleted


class Device(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A physical device.

    IPs are linked back to a Device via the ``IPAddress.assigned_device``
    foreign key, so ``device.ip_addresses.all()`` returns everything bound
    to this device without needing an Interface model in between (we'll
    add Interfaces in a later phase for L1 / port-level detail).
    """


    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="devices"
    )
    name = models.CharField(max_length=255)
    device_type = models.ForeignKey(
        DeviceType, on_delete=models.SET_NULL, null=True, blank=True
    )
    role = models.ForeignKey(
        "DeviceRole", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="devices",
    )
    platform = models.ForeignKey(
        "Platform", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="devices",
    )
    site = models.ForeignKey(
        Site, on_delete=models.SET_NULL, null=True, blank=True
    )
    # ── Rack placement ───────────────────────────────────────────────────
    FACE_CHOICES = [("front", "Front"), ("rear", "Rear")]
    rack = models.ForeignKey(
        "Rack", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="devices",
    )
    position = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Lowest rack unit (U) this device occupies.",
    )
    face = models.CharField(
        max_length=5, choices=FACE_CHOICES, blank=True, default="",
    )
    SIDE_CHOICES = [("left", "Left"), ("right", "Right")]
    rack_side = models.CharField(
        max_length=5, choices=SIDE_CHOICES, blank=True, default="",
        help_text=("Which half of the U a half-width device occupies (the "
                   "device type's rack_width must be 'half'). Blank for "
                   "full-width devices."),
    )
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="devices",
    )
    serial_number = models.CharField(max_length=255, blank=True)
    asset_tag = models.CharField(max_length=128, blank=True)
    description = models.TextField(blank=True)
    primary_ip = models.ForeignKey(
        "IPAddress",
        on_delete=models.SET_NULL,
        related_name="primary_for",
        null=True, blank=True,
        help_text=("The IP used to reach this device for management. Pick from "
                   "IPs already assigned to this device."),
    )
    secondary_ip = models.ForeignKey(
        "IPAddress",
        on_delete=models.SET_NULL,
        related_name="secondary_for",
        null=True, blank=True,
        help_text=("Secondary IP for this device. Pick from IPs already "
                   "assigned to this device."),
    )
    oob_ip = models.ForeignKey(
        "IPAddress",
        on_delete=models.SET_NULL,
        related_name="oob_for",
        null=True, blank=True,
        help_text=("Out-of-band / management IP for this device. Pick from "
                   "IPs already assigned to this device."),
    )
    # ── Placement / context ──────────────────────────────────────────────
    location = models.ForeignKey(
        "Location", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="devices",
        help_text="Physical location within the site (building / floor / room).",
    )
    cluster = models.ForeignKey(
        "Cluster", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="devices",
        help_text="Compute / virtualisation cluster this device belongs to.",
    )
    # ── Virtual chassis (switch-stack) membership ────────────────────────
    virtual_chassis = models.ForeignKey(
        "VirtualChassis", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="members",
        help_text="The switch stack this device is a member of.",
    )
    vc_position = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Member id within the stack (0–255, unique per chassis).",
    )
    vc_priority = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Master-election priority within the stack.",
    )
    # ── Intended-config rendering ────────────────────────────────────────
    config_template = models.ForeignKey(
        "ExportTemplate", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Config template for this device. Falls back to the "
                  "role's, then the platform's, when unset.",
    )
    # ── Physical attributes ──────────────────────────────────────────────
    # Kept as a class attribute for backwards references; the list itself is
    # module-level (shared with DeviceType).
    AIRFLOW_CHOICES = AIRFLOW_CHOICES
    airflow = models.CharField(
        max_length=50, choices=AIRFLOW_CHOICES, blank=True, default="",
        help_text="Direction of cooling airflow through the chassis.",
    )
    # ── Geolocation ──────────────────────────────────────────────────────
    latitude = models.DecimalField(
        max_digits=9, decimal_places=6, null=True, blank=True,
        help_text="GPS latitude (decimal degrees).",
    )
    longitude = models.DecimalField(
        max_digits=9, decimal_places=6, null=True, blank=True,
        help_text="GPS longitude (decimal degrees).",
    )
    # Geographic camera coverage (the Site map's analog of a floor-plan
    # tile's cone). Stored regardless of role; the UI offers the editor only
    # when the device's role has ``has_fov``. Distance in meters.
    fov_direction = models.PositiveSmallIntegerField(null=True, blank=True)
    fov_deg = models.PositiveSmallIntegerField(null=True, blank=True)
    fov_distance_m = models.PositiveIntegerField(null=True, blank=True)
    fov_ptz = models.BooleanField(default=False)
    comments = models.TextField(
        blank=True, default="",
        help_text="Long-form notes (separate from the short description).",
    )

    class Meta:
        unique_together = ("tenant", "name")
        ordering = ["name"]
        indexes = [
            models.Index(fields=["tenant", "name"]),
            models.Index(fields=["tenant", "device_type"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["virtual_chassis", "vc_position"],
                condition=models.Q(virtual_chassis__isnull=False,
                                   vc_position__isnull=False),
                name="uniq_device_vc_position",
            ),
        ]

    def __str__(self) -> str:
        return self.name


class ImageAttachment(TimestampedModel):
    """A user-uploaded image pinned to any object that makes sense to
    photograph — devices, racks, sites, locations (NetBox's ``ImageAttachment``).

    Generic-FK so one model + one upload flow covers every object type. Scoped
    to the parent's tenant, so the same tenant isolation applies; managed
    through each parent's own ``images`` nested endpoint (writes map to
    "change <parent>" via RBAC, so no separate image resource/permission).
    ``object_id`` is a UUID because every attachable model uses a UUID pk."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="image_attachments"
    )
    content_type = models.ForeignKey(
        "contenttypes.ContentType", on_delete=models.CASCADE
    )
    object_id = models.UUIDField()
    parent = GenericForeignKey("content_type", "object_id")
    image = models.ImageField(upload_to="image-attachments/")
    name = models.CharField(
        max_length=128, blank=True, default="",
        help_text="Optional caption shown under the image.",
    )
    sort_order = models.PositiveSmallIntegerField(
        default=0, help_text="Display order; lower sorts first."
    )

    class Meta:
        ordering = ["sort_order", "created_at"]
        indexes = [
            models.Index(fields=["content_type", "object_id", "sort_order"]),
        ]

    def __str__(self) -> str:
        return self.name or f"Image {self.pk}"


class VirtualChassis(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A switch stack (Cisco StackWise, Juniper VC, Aruba VSF, …): several
    physical devices acting as one logical chassis. Each member stays an
    individual Device (own serial, rack position, interfaces) and points back
    here via ``Device.virtual_chassis`` + ``vc_position``/``vc_priority``;
    deleting the chassis nulls the memberships, never the devices."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="virtual_chassis"
    )
    name = models.CharField(max_length=128)
    domain = models.CharField(
        max_length=64, blank=True, default="",
        help_text="Stack/VC domain identifier, where the platform has one.",
    )
    master = models.ForeignKey(
        Device, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="The member acting as stack master, if designated.",
    )
    description = models.CharField(max_length=255, blank=True, default="")
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        verbose_name_plural = "virtual chassis"
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_virtualchassis_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class VLAN(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """User-defined VLAN. Not VRF-scoped — VLAN IDs are an L2 namespace."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="vlans"
    )
    vlan_id = models.IntegerField()  # 1-4094
    name = models.CharField(max_length=255)
    site = models.ForeignKey(
        Site, on_delete=models.SET_NULL, null=True, blank=True
    )
    group = models.ForeignKey(
        "VLANGroup",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="vlans",
        help_text="Optional VLAN group — scopes VID uniqueness.",
    )
    zone = models.ForeignKey(
        "Zone",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="vlans",
        help_text="Security zone this segment belongs to (zone-based firewalling).",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["vlan_id"]
        constraints = [
            # VID is unique within a group; ungrouped VLANs (NULL group) are
            # unique per tenant. nulls_distinct=False makes the NULL-group
            # bucket behave like a real value for uniqueness.
            models.UniqueConstraint(
                fields=["tenant", "group", "vlan_id"],
                nulls_distinct=False,
                name="uniq_vlan_tenant_group_vid",
            )
        ]

    def __str__(self) -> str:
        return f"VLAN {self.vlan_id}: {self.name}"


# ─── Prefix / IPAddress (VRF-scoped) ──────────────────────────────────────


class Prefix(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """An IP prefix (CIDR), scoped to a (tenant, VRF) pair.

    Same CIDR is allowed in different VRFs — that's the whole point. The
    unique constraint uses ``nulls_distinct=False`` so a NULL vrf (= Global)
    behaves like a real value for uniqueness, not as "anything goes".
    """


    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="prefixes"
    )
    vrf = models.ForeignKey(
        VRF,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="prefixes",
        help_text="Routing context. NULL = Global VRF.",
    )
    cidr = models.CharField(
        max_length=43, help_text="e.g. 10.0.10.0/24 or 2001:db8:1::/64"
    )
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="prefixes",
    )
    gateway = models.GenericIPAddressField(blank=True, null=True)
    vlan = models.ForeignKey(
        VLAN, on_delete=models.SET_NULL, null=True, blank=True, related_name="prefixes"
    )
    site = models.ForeignKey(
        Site, on_delete=models.SET_NULL, null=True, blank=True, related_name="prefixes"
    )
    location = models.ForeignKey(
        "Location", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="prefixes",
        help_text="Location this range belongs to. Sets the prefix's site to the "
        "location's site automatically.",
    )
    auto_assign_site = models.BooleanField(
        default=False,
        help_text="When on, IPs created in this prefix inherit the prefix's site "
        "(so site-scoped users/filters pick them up).",
    )
    description = models.TextField(blank=True)
    auto_discover = models.BooleanField(
        default=False,
        help_text="Opt in to periodic ICMP discovery — responders not yet "
        "recorded are auto-created as IPs (see monitoring settings).",
    )
    last_discovered_at = models.DateTimeField(
        null=True, blank=True,
        help_text="Last time discovery swept this prefix. Engine-set; gates the "
        "discovery interval.",
    )

    class Meta:
        ordering = ["cidr"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "vrf", "cidr"],
                nulls_distinct=False,
                name="uniq_prefix_tenant_vrf_cidr",
            )
        ]
        indexes = [
            models.Index(fields=["tenant", "status"]),
            models.Index(fields=["tenant", "site"]),
            models.Index(fields=["tenant", "vrf"]),
        ]

    def __str__(self) -> str:
        return self.cidr

    def save(self, *args, **kwargs):
        # A location implies its site — keep the prefix's site in sync so
        # site-scoped queries (and auto_assign_site) have a single source.
        if self.location_id and self.location.site_id:
            self.site_id = self.location.site_id
        super().save(*args, **kwargs)

    @property
    def network(self):
        try:
            return ipaddress.ip_network(self.cidr, strict=False)
        except (ValueError, TypeError):
            return None

    @property
    def family(self):
        n = self.network
        return n.version if n else None

    @property
    def is_enumerable(self) -> bool:
        """Cheap+meaningful to enumerate this prefix's hosts (≤ the cap)."""
        return is_enumerable(self.network)

    @property
    def utilisation_pct(self):
        # ``status`` is a Status FK (post-0047), not the old enum string — compare
        # the slug. The bare ``== "container"`` here was always False after the
        # migration, so container prefixes reported a bogus utilisation %.
        if self.status_id and self.status.slug == "container":
            return None
        n = self.network
        if n is None:
            return None
        # IPv6 % is only meaningful for small (enumerable) prefixes — a /64 is
        # forever ~0%, which is noise, so leave it blank (UI shows nothing).
        if n.version == 6 and not is_enumerable(n):
            return None
        if n.num_addresses <= 2:
            capacity = n.num_addresses
        else:
            capacity = n.num_addresses - 2
        if capacity == 0:
            return None
        used = self.ip_addresses.count()
        return min(100, int(round(100 * used / capacity)))


class IPAddress(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """An individual IP address.

    ``vrf`` is denormalised from the parent prefix so the unique constraint
    can be enforced at the DB level: same IP can exist in different VRFs.

    ``status`` and ``role`` are tenant-managed catalogs — see Status and
    IPRole. Gateway semantics use ``role.is_gateway`` so users can rename
    the role to match their org's vocabulary without losing behaviour.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="ip_addresses"
    )
    vrf = models.ForeignKey(
        VRF,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="ip_addresses",
    )
    ip_address = models.GenericIPAddressField()
    prefix = models.ForeignKey(
        Prefix, on_delete=models.CASCADE, related_name="ip_addresses"
    )
    site = models.ForeignKey(
        Site, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="ip_addresses",
        help_text="Site this IP belongs to. Auto-filled from the prefix when the "
        "prefix has 'assign IPs to site' on; otherwise set/cleared by hand.",
    )
    status = models.ForeignKey(
        "Status",
        on_delete=models.PROTECT,
        related_name="ips",
        null=True,
        blank=False,
        help_text="Operational status — pick from your tenant's status catalog.",
    )
    role = models.ForeignKey(
        "IPRole",
        on_delete=models.SET_NULL,
        related_name="ips",
        null=True,
        blank=True,
        help_text="Optional functional role (gateway, VIP, loopback, …).",
    )
    description = models.TextField(blank=True)
    reservation_note = models.CharField(
        max_length=200,
        blank=True,
        default="",
        help_text=("Short free-text note shown on hover. Statuses with "
                   "``requires_note=True`` (e.g. Reserved) demand this."),
    )
    assigned_device = models.ForeignKey(
        "Device",
        on_delete=models.SET_NULL,
        related_name="ip_addresses",
        null=True, blank=True,
        help_text=("Device this IP lives on. Setting it makes the IP show up "
                   "on the device detail page and lets the device pick this "
                   "IP as its primary management address."),
    )
    assigned_interface = models.ForeignKey(
        "Interface",
        on_delete=models.SET_NULL,
        related_name="ip_addresses",
        null=True, blank=True,
        help_text=("Specific interface this IP is bound to. Setting it also "
                   "keeps assigned_device in sync with the interface's device."),
    )
    # Virtual-machine assignment — the VM analogue of assigned_device/interface.
    assigned_vm = models.ForeignKey(
        "VirtualMachine",
        on_delete=models.SET_NULL,
        related_name="ip_addresses",
        null=True, blank=True,
    )
    assigned_vm_interface = models.ForeignKey(
        "VMInterface",
        on_delete=models.SET_NULL,
        related_name="ip_addresses",
        null=True, blank=True,
        help_text="Specific VM interface this IP is bound to.",
    )
    mac_address = models.CharField(
        max_length=17, blank=True,
        help_text=("Hardware address paired with this IP — e.g. a DHCP "
                   "reservation. Independent of the interface's own MAC."),
    )
    dns_name = models.CharField(
        max_length=255, blank=True, default="",
        help_text=("Hostname / DNS name for this address (its PTR record). "
                   "Auto-filled by reverse-DNS monitoring when enabled."),
    )
    last_seen = models.DateTimeField(
        null=True, blank=True,
        help_text=("Last time monitoring observed this IP reachable (up or "
                   "degraded). Set by the check engine; read-only in the UI."),
    )
    discovered = models.BooleanField(
        default=False,
        help_text=("Auto-created by subnet discovery (vs. entered by a user). "
                   "Only discovered IPs are eligible for stale auto-cleanup."),
    )
    flap_exclude = models.BooleanField(
        default=False,
        help_text=("Exclude this IP from the flapping monitor — for a known "
                   "noisy host you don't want flagged."),
    )

    class Meta:
        ordering = ["ip_address"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "vrf", "ip_address"],
                nulls_distinct=False,
                name="uniq_ip_tenant_vrf_addr",
            )
        ]

    def __str__(self) -> str:
        return self.ip_address

    def save(self, *args, **kwargs):
        # Always keep vrf in sync with the parent prefix
        if self.prefix_id and self.vrf_id != self.prefix.vrf_id:
            self.vrf_id = self.prefix.vrf_id
        if self.prefix_id and self.tenant_id != self.prefix.tenant_id:
            self.tenant_id = self.prefix.tenant_id
        # Binding to an interface implies its device.
        if self.assigned_interface_id:
            self.assigned_device_id = self.assigned_interface.device_id
        # Auto-assign site from the prefix when the prefix opts in and the IP
        # doesn't already carry an explicit site.
        if (
            self.site_id is None
            and self.prefix_id
            and self.prefix.auto_assign_site
            and self.prefix.site_id
        ):
            self.site_id = self.prefix.site_id
        super().save(*args, **kwargs)


# ─── IP roles + statuses (user-managed, tenant-scoped) ───────────────────


class _LabeledChoice(TimestampedModel):
    """Shared base for tenant-managed labelled-choice catalogs.

    IPRole and Status both follow the same shape — an operator-defined
    list of values per tenant, each with a color + ordering weight. The
    class is abstract so each child gets its own table + uniqueness scope.

    Honouring CLAUDE.md's "zero pre-filled data" rule: Danbyte ships these
    *tables* but populates them per-tenant in the migration with only the
    rows that tenant's existing IPs were actually using.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE)
    name = models.CharField(max_length=64)
    slug = models.SlugField(max_length=80)
    color = models.CharField(max_length=7, blank=True, default="")
    description = models.TextField(blank=True)
    weight = models.PositiveIntegerField(
        default=100,
        help_text="Lower weights sort first in dropdowns and lists.",
    )
    owning_site = models.ForeignKey(
        "Site", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Set = local to that site (enhanced site separation); "
        "empty = global to the tenant.",
    )

    class Meta:
        abstract = True
        ordering = ["weight", "name"]

    def __str__(self) -> str:
        return self.name

    @property
    def text_color(self) -> str:
        """Black or white text picked from sRGB luminance — same helper Tag uses."""
        if not self.color:
            return ""
        h = self.color.lstrip("#")
        if len(h) != 6:
            return "#fff"
        try:
            r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        except ValueError:
            return "#fff"
        luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        return "#000" if luminance > 0.6 else "#fff"


class IPRole(_LabeledChoice):
    """User-defined functional role for an IPAddress.

    ``is_gateway`` flags the role that drives the prefix gateway autospawn
    flow. At most one role per tenant should be flagged.

    ``is_virtual`` flags VIPs / shared addresses (HSRP / VRRP standby groups,
    anycast). The pattern: 2 physical interface IPs (real, often coloured
    amber) + 1 shared VIP (virtual, often coloured emerald). Marking a role
    virtual lets the UI hint at this triplet visually.
    """

    is_gateway = models.BooleanField(
        default=False,
        help_text=("Mark IPs with this role as the parent prefix's gateway, "
                   "and use it for the gateway autospawn flow on prefix create."),
    )
    is_virtual = models.BooleanField(
        default=False,
        help_text=("Flag this role as a virtual / shared address "
                   "(HSRP / VRRP VIP, anycast). UI hints distinguish virtual "
                   "VIPs from physical interface IPs."),
    )
    icon = models.CharField(
        max_length=64,
        blank=True,
        default="",
        help_text=("Lucide-style icon name shown inside the role chip. "
                   "Pick from the registry (crown, router, shield-check, …); "
                   "unknown names are silently ignored."),
    )

    class Meta(_LabeledChoice.Meta):
        constraints = [
            models.UniqueConstraint(fields=["tenant", "slug"],
                                    name="uniq_iprole_tenant_slug"),
        ]


class Status(_LabeledChoice):
    """User-defined operational status, shared across object types.

    One catalog of coloured statuses per tenant. ``available_to`` lists the
    object-type slugs a status can be used on (validated against
    ``STATUSABLE_MODEL_VALUES``), and ``default_for`` lists the slugs for which
    this status is the default applied on create (≤1 default per type). So a
    single "Active" row can serve IPs, devices, prefixes, … with one colour.

    IP-specific flags: ``is_available`` counts the status as "free to assign"
    in per-prefix utilisation accounting; ``requires_note`` makes the IP form
    force a ``reservation_note`` when picked. They're harmless on other types.
    """

    available_to = models.JSONField(
        default=list,
        blank=True,
        help_text="Object-type slugs this status can be used on (see STATUSABLE_MODELS).",
    )
    default_for = models.JSONField(
        default=list,
        blank=True,
        help_text="Object-type slugs for which this status is the default (≤1 per type).",
    )
    is_available = models.BooleanField(
        default=False,
        help_text=("Counts this status as 'free' in utilisation maths and the "
                   "Show-available toggle (IP addresses)."),
    )
    requires_note = models.BooleanField(
        default=False,
        help_text=("Picking this status on an IP forces the operator to fill "
                   "in the reservation_note field — used so e.g. 'Reserved' "
                   "always carries the who/why on hover."),
    )

    class Meta(_LabeledChoice.Meta):
        verbose_name_plural = "statuses"
        constraints = [
            models.UniqueConstraint(fields=["tenant", "slug"],
                                    name="uniq_status_tenant_slug"),
        ]

    def clean(self):
        super().clean()
        from .status_registry import STATUSABLE_MODEL_VALUES

        from django.core.exceptions import ValidationError

        bad = [m for m in (self.available_to or []) if m not in STATUSABLE_MODEL_VALUES]
        if bad:
            raise ValidationError(
                {"available_to": f"Unknown object type(s): {', '.join(bad)}"}
            )
        not_in = [m for m in (self.default_for or []) if m not in (self.available_to or [])]
        if not_in:
            raise ValidationError(
                {"default_for": f"Must be a subset of available_to: {', '.join(not_in)}"}
            )


class Zone(_LabeledChoice, CustomFieldsMixin, TaggableMixin):
    """A security zone — models zone-based firewalling (Palo Alto style).

    User-defined per tenant, zero pre-filled. A VLAN may link to a zone
    (``VLAN.zone``) so "which zone is this segment in?" is answerable from the
    VLAN itself; firewall policy modelling can build on the same rows later.
    Inherits name/slug/color/weight (+ owning_site for enhanced site
    separation) from the labelled-choice base.
    """

    class Meta(_LabeledChoice.Meta):
        constraints = [
            models.UniqueConstraint(fields=["tenant", "slug"],
                                    name="uniq_zone_tenant_slug"),
        ]


# ─── Interface / Cable (not VRF-scoped) ───────────────────────────────────


class Interface(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A network interface on a device. Tenant scope is inherited via device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="interfaces"
    )
    name = models.CharField(max_length=64)
    type = models.CharField(
        max_length=64, blank=True, default="", choices=INTERFACE_TYPE_CHOICES,
        help_text="Physical/logical media type, e.g. 10gbase-x-sfpp.",
    )
    speed = models.CharField(max_length=64, blank=True)
    mtu = models.IntegerField(blank=True, null=True)
    enabled = models.BooleanField(default=True)
    poe_mode = models.CharField(max_length=8, blank=True, default="")
    poe_type = models.CharField(max_length=32, blank=True, default="")
    mgmt_only = models.BooleanField(
        default=False, help_text="Out-of-band management interface."
    )
    DUPLEX_CHOICES = [("half", "Half"), ("full", "Full"), ("auto", "Auto")]
    duplex = models.CharField(
        max_length=8, choices=DUPLEX_CHOICES, blank=True, default=""
    )
    POE_MODE_CHOICES = [("pd", "PD (powered device)"), ("pse", "PSE (supplying)")]
    poe_mode = models.CharField(
        max_length=8, choices=POE_MODE_CHOICES, blank=True, default=""
    )
    poe_type = models.CharField(
        max_length=32, blank=True, default="",
        help_text="IEEE standard / passive type, e.g. type2-ieee802.3at.",
    )
    wwn = models.CharField(
        max_length=32, blank=True, default="",
        help_text="World Wide Name (Fibre Channel), colon-separated hex.",
    )
    mac_address = models.CharField(
        max_length=17, blank=True,
        help_text="Layer-2 hardware address, e.g. 00:1b:44:11:3a:b7.",
    )
    # ─── L2: 802.1Q switching ────────────────────────────────────────────
    # `vlan` is the **untagged / access (native)** VLAN. `mode` says how the
    # port behaves; `tagged_vlans` are the trunk VLANs when tagged.
    vlan = models.ForeignKey(
        VLAN, on_delete=models.SET_NULL, null=True, blank=True,
        help_text="Untagged / access (native) VLAN.",
    )
    mode = models.CharField(
        max_length=16, blank=True, default="",
        choices=[
            ("access", "Access"),
            ("tagged", "Tagged (trunk)"),
            ("tagged-all", "Tagged (all VLANs)"),
        ],
        help_text="802.1Q mode. Access = untagged only; Tagged = a trunk "
                  "carrying tagged_vlans (+ the untagged native VLAN).",
    )
    tagged_vlans = models.ManyToManyField(
        VLAN, blank=True, related_name="tagged_interfaces",
        help_text="Tagged VLANs carried on a trunk (mode = tagged).",
    )
    # ─── L3: routing context ─────────────────────────────────────────────
    vrf = models.ForeignKey(
        "VRF", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="interfaces",
        help_text="The VRF this interface routes in. Lets the same IP exist on "
                  "interfaces in different VRFs without colliding.",
    )
    # ─── Virtual / sub-interfaces ────────────────────────────────────────
    virtual = models.BooleanField(
        default=False,
        help_text="A logical interface with no physical port — sub-interface, "
                  "LAG/aggregate, loopback, tunnel, VLAN interface.",
    )
    parent = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="children",
        help_text="The interface this one nests under (e.g. a sub-interface "
                  "ae1.100 → ae1). Must be on the same device.",
    )
    # LAG / aggregation: members point `lag` at the aggregate
    # interface. The aggregate is whatever interface is referenced here.
    lag = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="lag_members",
        help_text="The link-aggregation (LAG/aggregate) interface this one is a "
                  "member of, e.g. a physical port → ae1. Same device.",
    )
    # Bridge group: members point `bridge` at the bridge.
    bridge = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="bridge_members",
        help_text="The bridge interface this one belongs to. Same device.",
    )

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class MACAddress(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A first-class MAC address. Assigned to an interface, it carries its own
    description / tags / custom fields and a stable identity — so a MAC is a real
    object you can click, annotate, and track across interfaces, not just a
    string. An interface's ``mac_addresses`` are all the MACs it bears; the one
    matching ``Interface.mac_address`` is its primary.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="mac_addresses"
    )
    mac_address = models.CharField(
        max_length=17, help_text="48-bit MAC, colon-separated lowercase."
    )
    assigned_interface = models.ForeignKey(
        "Interface", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="mac_addresses",
        help_text="The interface that bears this MAC, if known.",
    )
    description = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["mac_address"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "mac_address", "assigned_interface"],
                name="uniq_macaddress_tenant_addr_iface",
                nulls_distinct=False,
            )
        ]

    def save(self, *args, **kwargs):
        if self.mac_address:
            self.mac_address = self.mac_address.strip().lower()
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return self.mac_address


class RearPort(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """The trunk side of a patch panel — ``positions`` strands, each one a
    position a FrontPort maps onto. Tenant scope inherited via device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="rear_ports"
    )
    name = models.CharField(max_length=64)
    positions = models.PositiveSmallIntegerField(
        default=1, help_text="Number of strands / front-port positions."
    )
    is_splitter = models.BooleanField(
        default=False,
        help_text="Optical splitter: every front port fans out from "
        "position 1 and carries the same signal (PON). Requires positions=1.",
    )
    type = models.CharField(max_length=64, blank=True)

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def clean(self):
        """A splitter broadcasts one input to all outputs — the front→rear
        direction stays deterministic only with a single input position."""
        from django.core.exceptions import ValidationError

        if self.is_splitter and (self.positions or 1) != 1:
            raise ValidationError(
                {"positions": "A splitter has exactly 1 input position — "
                 "its front ports are the outputs."}
            )

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class FrontPort(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """The front jack of a patch panel, mapped to one position of a RearPort.
    A cable on the front passes through to that rear strand (and onward)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="front_ports"
    )
    name = models.CharField(max_length=64)
    rear_port = models.ForeignKey(
        RearPort, on_delete=models.CASCADE, related_name="front_ports"
    )
    rear_port_position = models.PositiveSmallIntegerField(
        default=1, help_text="First rear-port position (strand) this maps onto."
    )
    positions = models.PositiveSmallIntegerField(
        default=1,
        help_text="Fibre strands this connector carries "
        "(LC=1, LC-duplex=2, MPO=8–24). Claims that many consecutive "
        "rear-port positions from the start.",
    )
    type = models.CharField(max_length=64, blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["device", "name"], name="uniq_frontport_device_name"
            ),
            # No (rear_port, rear_port_position) unique constraint: a connector
            # spans a RANGE of positions now, so overlap is checked in clean().
        ]

    def clean(self):
        """A front port occupies rear positions [start … start+positions−1];
        the range must fit the rear port and not overlap a sibling."""
        from django.core.exceptions import ValidationError

        lo = self.rear_port_position or 1
        hi = lo + (self.positions or 1) - 1
        if lo < 1:
            raise ValidationError(
                {"rear_port_position": "Start position must be ≥ 1."}
            )
        if self.rear_port_id and hi > self.rear_port.positions:
            raise ValidationError(
                {"positions": f"Positions {lo}–{hi} exceed the rear port's "
                 f"{self.rear_port.positions} positions."}
            )
        if self.rear_port_id and self.rear_port.is_splitter:
            # Splitter outputs all share position 1 by design — no overlap
            # check; the range-fit check above already pinned lo=hi=1.
            return
        if self.rear_port_id:
            siblings = FrontPort.objects.filter(
                rear_port_id=self.rear_port_id
            ).exclude(pk=self.pk)
            for s in siblings:
                slo = s.rear_port_position or 1
                shi = slo + (s.positions or 1) - 1
                if lo <= shi and slo <= hi:
                    raise ValidationError(
                        {"rear_port_position": f"Positions {lo}–{hi} overlap "
                         f"{s.name} (positions {slo}–{shi})."}
                    )

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class ConsolePort(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A device's serial/management console jack — the out-of-band path.
    Cable-terminable (usually to a ConsoleServerPort). Tenant scope inherited
    via device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="console_ports"
    )
    name = models.CharField(max_length=64)
    type = models.CharField(
        max_length=32, blank=True, default="", choices=CONSOLE_PORT_TYPE_CHOICES
    )
    speed = models.PositiveIntegerField(
        null=True, blank=True, help_text="Port speed in baud (e.g. 9600, 115200)."
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class ConsoleServerPort(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """One port on a console/terminal server — the far end a ConsolePort
    patches into. Tenant scope inherited via device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="console_server_ports"
    )
    name = models.CharField(max_length=64)
    type = models.CharField(
        max_length=32, blank=True, default="", choices=CONSOLE_PORT_TYPE_CHOICES
    )
    speed = models.PositiveIntegerField(
        null=True, blank=True, help_text="Port speed in baud (e.g. 9600, 115200)."
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class InventoryItem(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A serial-tracked physical part on a device — PSU, fan, CPU, discrete
    SFP. Self-nesting (a card can contain sub-parts). Roles are tags, per the
    zero-pre-filled-data rule. Tenant scope inherited via device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="inventory_items"
    )
    parent = models.ForeignKey(
        "self", on_delete=models.CASCADE, null=True, blank=True,
        related_name="children",
    )
    name = models.CharField(max_length=128)
    manufacturer = models.ForeignKey(
        Manufacturer, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="inventory_items",
    )
    part_id = models.CharField(max_length=128, blank=True, default="")
    serial_number = models.CharField(max_length=255, blank=True, default="")
    asset_tag = models.CharField(max_length=128, blank=True, default="")
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class DeviceBay(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A concrete chassis slot on a parent device; holds at most one whole
    child Device. Tenant scope inherited via device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="device_bays"
    )
    name = models.CharField(max_length=64)
    installed_device = models.OneToOneField(
        Device, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="parent_bay",
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class ModuleBay(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A concrete module slot on a device, stamped from the type's
    ModuleBayTemplates. Holds at most one installed Module. Tenant scope
    inherited via device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="module_bays"
    )
    name = models.CharField(max_length=64)
    position = models.CharField(
        max_length=32, blank=True, default="",
        help_text="Value {module} resolves to in installed port names.",
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class Module(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A module type installed in a device's bay. Creating one stamps the
    module type's interfaces onto the host device ({module} → bay position);
    deleting it removes them again. Tenant scope inherited via device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="modules"
    )
    module_bay = models.OneToOneField(
        ModuleBay, on_delete=models.CASCADE, related_name="module"
    )
    module_type = models.ForeignKey(
        ModuleType, on_delete=models.PROTECT, related_name="modules"
    )
    serial_number = models.CharField(max_length=255, blank=True, default="")
    asset_tag = models.CharField(max_length=128, blank=True, default="")
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["module_bay__name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.module_bay.name} ({self.module_type.name})"


class AuxPort(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """An auxiliary physical connector on a device — USB data ports, video
    outputs (HDMI/VGA/DP), card slots, grounding lugs: everything no other
    component type models. Not cable-terminable (yet). Tenant scope inherited
    via device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="aux_ports"
    )
    name = models.CharField(max_length=64)
    type = models.CharField(
        max_length=32, blank=True, default="", choices=AUX_PORT_TYPE_CHOICES
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class PowerPort(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A device's power **inlet** — where the device draws power. Completes
    the chain PowerPanel → PowerFeed → (PDU) PowerOutlet → PowerPort. A rack
    PDU is a Device whose PowerPort cables to a PowerFeed and whose
    PowerOutlets feed downstream PowerPorts. Tenant scope inherited via
    device."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="power_ports"
    )
    name = models.CharField(max_length=64)
    type = models.CharField(
        max_length=32, blank=True, default="", choices=POWER_PORT_TYPE_CHOICES
    )
    maximum_draw = models.PositiveIntegerField(
        null=True, blank=True, help_text="Maximum draw, watts."
    )
    allocated_draw = models.PositiveIntegerField(
        null=True, blank=True, help_text="Allocated draw, watts."
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class PowerOutlet(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A power **outlet** on a device (a PDU's sockets) that downstream power
    ports plug into. `power_port` names the inlet on the same device that
    feeds it, so per-inlet load can roll up. Tenant scope inherited via
    device."""

    FEED_LEG_CHOICES = [("A", "A"), ("B", "B"), ("C", "C")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    device = models.ForeignKey(
        Device, on_delete=models.CASCADE, related_name="power_outlets"
    )
    name = models.CharField(max_length=64)
    type = models.CharField(
        max_length=32, blank=True, default="", choices=POWER_OUTLET_TYPE_CHOICES
    )
    power_port = models.ForeignKey(
        PowerPort, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="outlets",
        help_text="The inlet on this device that feeds the outlet.",
    )
    feed_leg = models.CharField(
        max_length=1, choices=FEED_LEG_CHOICES, blank=True, default="",
        help_text="Which phase leg feeds this outlet, on three-phase gear.",
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        unique_together = ("device", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.device.name}:{self.name}"


class Cable(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A physical cable. It terminates on a set of ports per end (A / B) via
    CableTermination, so it models 1:1, breakout 1:N, and M:N links."""

    LENGTH_UNITS = [
        ("m", "Meters"), ("cm", "Centimeters"), ("ft", "Feet"), ("in", "Inches"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="cables"
    )
    type = models.CharField(
        max_length=64, blank=True, choices=CABLE_TYPE_CHOICES,
        help_text="Cable medium, e.g. cat6 / dac-passive / smf-os2 / mmf-om4.",
    )
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="cables",
    )
    length = models.DecimalField(
        max_digits=8, decimal_places=2, null=True, blank=True
    )
    length_unit = models.CharField(
        max_length=2, choices=LENGTH_UNITS, default="m", blank=True
    )
    color = models.CharField(
        max_length=7, blank=True, default="",
        help_text="Optional 7-char hex — the physical cable's color.",
    )
    label = models.CharField(
        max_length=255, blank=True, default="",
        help_text="Free-form physical label (matches NetBox's cable label) — "
        "what's printed on the cable's tag.",
    )
    description = models.TextField(blank=True)
    # ── Optical fibre strands (only meaningful for smf/mmf types) ──────────
    fiber_count = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Number of fibre strands in the cable (2, 12, 24, 48…).",
    )
    # Sparse per-strand annotations, keyed by 1-based position (as a string):
    # {"7": {"label": "Cust-A pri", "status": "in-use"}}. Colours are DERIVED
    # from position + the tenant's palette, never stored. No entry = un-annotated.
    strands = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        # Prefer the human label, then the per-tenant number, then the UUID —
        # so a cable never renders as a bare UUID in the UI / logs.
        if self.label:
            return self.label
        if self.numid:
            return f"Cable #{self.numid}"
        return f"Cable {self.id}"


class CableTermination(TimestampedModel):
    """One endpoint of a cable, on the A side or B side. Exactly one of the
    point FKs (interface / front_port / rear_port / console_port /
    console_server_port / power_port / power_outlet / power_feed) is set;
    a port is cabled at most once."""

    END_CHOICES = [("A", "A"), ("B", "B")]

    # Every terminable endpoint type, in `point` resolution order. The check
    # constraint, the per-point unique rules, and the serializer's kind map
    # are all derived from this one list.
    POINT_FIELDS = [
        "interface", "front_port", "rear_port", "console_port",
        "console_server_port", "power_port", "power_outlet", "power_feed",
        "aux_port",
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    cable = models.ForeignKey(
        Cable, on_delete=models.CASCADE, related_name="terminations"
    )
    end = models.CharField(max_length=1, choices=END_CHOICES)
    interface = models.ForeignKey(
        Interface, on_delete=models.CASCADE, null=True, blank=True,
        related_name="terminations",
    )
    front_port = models.ForeignKey(
        FrontPort, on_delete=models.CASCADE, null=True, blank=True,
        related_name="terminations",
    )
    rear_port = models.ForeignKey(
        RearPort, on_delete=models.CASCADE, null=True, blank=True,
        related_name="terminations",
    )
    console_port = models.ForeignKey(
        ConsolePort, on_delete=models.CASCADE, null=True, blank=True,
        related_name="terminations",
    )
    console_server_port = models.ForeignKey(
        ConsoleServerPort, on_delete=models.CASCADE, null=True, blank=True,
        related_name="terminations",
    )
    power_port = models.ForeignKey(
        PowerPort, on_delete=models.CASCADE, null=True, blank=True,
        related_name="terminations",
    )
    power_outlet = models.ForeignKey(
        PowerOutlet, on_delete=models.CASCADE, null=True, blank=True,
        related_name="terminations",
    )
    # Site-level power: a feed cables straight into a (PDU) power port.
    power_feed = models.ForeignKey(
        "PowerFeed", on_delete=models.CASCADE, null=True, blank=True,
        related_name="terminations",
    )
    aux_port = models.ForeignKey(
        AuxPort, on_delete=models.CASCADE, null=True, blank=True,
        related_name="terminations",
    )

    class Meta:
        ordering = ["end"]
        constraints = [
            models.CheckConstraint(
                name="cabletermination_exactly_one_point",
                # Exactly one point FK set: one Q arm per field, each requiring
                # that field non-null and every other field null.
                check=models.Q(
                    *[
                        models.Q(**{
                            f"{set_field}__isnull": False,
                            **{
                                f"{other}__isnull": True
                                for other in [
                                    "interface", "front_port", "rear_port",
                                    "console_port", "console_server_port",
                                    "power_port", "power_outlet", "power_feed",
                                    "aux_port",
                                ]
                                if other != set_field
                            },
                        })
                        for set_field in [
                            "interface", "front_port", "rear_port",
                            "console_port", "console_server_port",
                            "power_port", "power_outlet", "power_feed",
                            "aux_port",
                        ]
                    ],
                    _connector=models.Q.OR,
                ),
            ),
            models.UniqueConstraint(
                fields=["interface"], condition=models.Q(interface__isnull=False),
                name="uniq_termination_interface",
            ),
            models.UniqueConstraint(
                fields=["front_port"], condition=models.Q(front_port__isnull=False),
                name="uniq_termination_front_port",
            ),
            models.UniqueConstraint(
                fields=["rear_port"], condition=models.Q(rear_port__isnull=False),
                name="uniq_termination_rear_port",
            ),
            models.UniqueConstraint(
                fields=["console_port"],
                condition=models.Q(console_port__isnull=False),
                name="uniq_termination_console_port",
            ),
            models.UniqueConstraint(
                fields=["console_server_port"],
                condition=models.Q(console_server_port__isnull=False),
                name="uniq_termination_console_server_port",
            ),
            models.UniqueConstraint(
                fields=["power_port"],
                condition=models.Q(power_port__isnull=False),
                name="uniq_termination_power_port",
            ),
            models.UniqueConstraint(
                fields=["power_outlet"],
                condition=models.Q(power_outlet__isnull=False),
                name="uniq_termination_power_outlet",
            ),
            models.UniqueConstraint(
                fields=["power_feed"],
                condition=models.Q(power_feed__isnull=False),
                name="uniq_termination_power_feed",
            ),
            models.UniqueConstraint(
                fields=["aux_port"],
                condition=models.Q(aux_port__isnull=False),
                name="uniq_termination_aux_port",
            ),
        ]
        indexes = [models.Index(fields=["cable", "end"])]

    @property
    def point(self):
        for f in self.POINT_FIELDS:
            obj = getattr(self, f)
            if obj is not None:
                return obj
        return None

    def __str__(self) -> str:
        return f"{self.cable_id}/{self.end}: {self.point}"


class FiberSettings(TimestampedModel):
    """Per-tenant fibre-strand colour palette. One row per tenant, created on
    demand with the TIA-598-C default (see ``api/fiber_colors.py``). Editable on
    the Fibre settings page — a tenant can reorder / recolour the 12 entries."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.OneToOneField(
        Tenant, on_delete=models.CASCADE, related_name="fiber_settings"
    )
    # List of {"name": str, "hex": "#RRGGBB"} in strand-position order.
    colors = models.JSONField(default=list, blank=True)
    # How deeply this tenant models fibres — drives how much fibre UI appears.
    #   off      — a cable is just a cable; no fibre prompts.
    #   count    — fibre_count + coloured/labelled strands (straight-through).
    #   accurate — multi-fibre connectors + per-termination strand maps.
    STRAND_MODELLING = [
        ("off", "Off"),
        ("count", "Count + colours"),
        ("accurate", "Strand-accurate"),
    ]
    strand_modelling = models.CharField(
        max_length=8, choices=STRAND_MODELLING, default="count"
    )

    class Meta:
        verbose_name = "fibre settings"
        verbose_name_plural = "fibre settings"

    def __str__(self) -> str:
        return f"Fibre settings ({self.tenant_id})"

    @classmethod
    def for_tenant(cls, tenant):
        from .fiber_colors import TIA_598C

        obj, _ = cls.objects.get_or_create(
            tenant=tenant, defaults={"colors": TIA_598C}
        )
        if not obj.colors:
            obj.colors = TIA_598C
            obj.save(update_fields=["colors"])
        return obj


# ─── Virtualization ──────────────────────────────────────────────────────────
class ClusterType(NumIdMixin, TimestampedModel):
    """Virtualization platform of a cluster (VMware vSphere, Proxmox, …)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="cluster_types"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_clustertype_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class ClusterGroup(NumIdMixin, TimestampedModel):
    """Optional organisational grouping of clusters (region, BU, …)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="cluster_groups"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_clustergroup_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class Cluster(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A group of hosts that run virtual machines."""


    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="clusters"
    )
    name = models.CharField(max_length=255)
    type = models.ForeignKey(
        ClusterType, on_delete=models.PROTECT, related_name="clusters"
    )
    group = models.ForeignKey(
        ClusterGroup,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="clusters",
    )
    site = models.ForeignKey(
        Site,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="clusters",
    )
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="clusters",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_cluster_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class VirtualMachine(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A virtual machine running on a cluster (optionally pinned to a host
    device). Gets IPs from IPAM and can be swept by the monitoring engine."""


    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="virtual_machines"
    )
    name = models.CharField(max_length=255)
    cluster = models.ForeignKey(
        Cluster, on_delete=models.PROTECT, related_name="virtual_machines"
    )
    role = models.ForeignKey(
        "DeviceRole", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="virtual_machines",
    )
    platform = models.ForeignKey(
        "Platform", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="virtual_machines",
    )
    # Optional physical host within the cluster.
    device = models.ForeignKey(
        Device,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="virtual_machines",
    )
    site = models.ForeignKey(
        Site,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="virtual_machines",
    )
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="virtual_machines",
    )
    vcpus = models.PositiveSmallIntegerField(null=True, blank=True)
    memory_mb = models.PositiveIntegerField(
        null=True, blank=True, help_text="Memory in MB."
    )
    disk_gb = models.PositiveIntegerField(
        null=True, blank=True, help_text="Disk in GB."
    )
    primary_ip = models.ForeignKey(
        IPAddress,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="primary_ip_for_vms",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_vm_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class VMInterface(TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A virtual network interface on a VM — the VM analogue of Interface.
    IPs attach to it via ``IPAddress.assigned_vm_interface``. Carries the same
    L2 (802.1Q) and L3 (VRF) context as a device Interface, so VLAN-trunked /
    VRF-scoped VM NICs import from NetBox without data loss."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    vm = models.ForeignKey(
        VirtualMachine, on_delete=models.CASCADE, related_name="interfaces"
    )
    name = models.CharField(max_length=64)
    enabled = models.BooleanField(default=True)
    mac_address = models.CharField(max_length=17, blank=True)
    mtu = models.IntegerField(null=True, blank=True)
    # ─── L2: 802.1Q switching (mirrors Interface) ────────────────────────
    vlan = models.ForeignKey(
        VLAN, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="vm_interfaces",
        help_text="Untagged / access (native) VLAN.",
    )
    mode = models.CharField(
        max_length=16, blank=True, default="",
        choices=[
            ("access", "Access"),
            ("tagged", "Tagged (trunk)"),
            ("tagged-all", "Tagged (all VLANs)"),
        ],
        help_text="802.1Q mode. Access = untagged only; Tagged = a trunk "
                  "carrying tagged_vlans (+ the untagged native VLAN).",
    )
    tagged_vlans = models.ManyToManyField(
        VLAN, blank=True, related_name="tagged_vm_interfaces",
        help_text="Tagged VLANs carried on a trunk (mode = tagged).",
    )
    # ─── L3: routing context (mirrors Interface) ─────────────────────────
    vrf = models.ForeignKey(
        "VRF", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="vm_interfaces",
        help_text="The VRF this interface routes in.",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["vm", "name"], name="uniq_vminterface_vm_name"
            )
        ]

    def __str__(self) -> str:
        return f"{self.vm.name}/{self.name}"


# ─── Racks ───────────────────────────────────────────────────────────────────
class RackRole(NumIdMixin, TimestampedModel):
    """Functional role of a rack (compute, network, storage, …). Coloured."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="rack_roles"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    color = models.CharField(max_length=7, blank=True, default="")
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_rackrole_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class TopologyView(NumIdMixin, TimestampedModel):
    """A saved topology-map view: the filter set plus hand-tuned node
    positions, so a curated diagram survives reloads and re-layouts."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="topology_views"
    )
    name = models.CharField(max_length=128)
    # {"filters": {site, role, status, tag, collapse, color_mode, …},
    #  "positions": {"dev:<uuid>": [x, y], …}}
    state = models.JSONField(default=dict, blank=True)

    class Meta:
        unique_together = ("tenant", "name")
        ordering = ["name"]

    def __str__(self) -> str:
        return self.name


# Device-type weights are stored in vendor units; budgets compare in kg.
WEIGHT_TO_KG = {"kg": 1, "g": 0.001, "lb": 0.45359237, "oz": 0.028349523125}


def weight_kg(value, unit) -> float | None:
    if value is None or unit not in WEIGHT_TO_KG:
        return None
    return float(value) * WEIGHT_TO_KG[unit]


class Rack(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A physical equipment rack at a site. Devices occupy unit positions."""

    WIDTH_CHOICES = [(10, '10"'), (19, '19"'), (21, '21"'), (23, '23"')]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="racks"
    )
    name = models.CharField(max_length=128)
    facility_id = models.CharField(
        max_length=64, blank=True, default="",
        help_text="The rack's ID in the facility (e.g. row/position label).",
    )
    site = models.ForeignKey(
        Site, on_delete=models.PROTECT, related_name="racks"
    )
    role = models.ForeignKey(
        RackRole, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="racks",
    )
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="racks",
    )
    location = models.ForeignKey(
        "Location", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="racks",
        help_text="Physical location within the site (building / floor / room).",
    )
    width = models.PositiveSmallIntegerField(
        choices=WIDTH_CHOICES, default=19, help_text="Rail-to-rail width, inches."
    )
    max_weight = models.DecimalField(
        max_digits=8, decimal_places=2, null=True, blank=True,
        help_text="Load budget (see max_weight_unit) — what the rack/floor is "
        "rated to carry. Devices sum against it via their type's weight.",
    )
    max_weight_unit = models.CharField(
        max_length=8, choices=DeviceType.WEIGHT_UNIT_CHOICES,
        blank=True, default="",
    )
    u_height = models.PositiveSmallIntegerField(
        default=42, help_text="Height in rack units (U)."
    )
    starting_unit = models.PositiveSmallIntegerField(
        default=1, help_text="Number of the bottom unit."
    )
    desc_units = models.BooleanField(
        default=False, help_text="Number units top-to-bottom instead of bottom-up.",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["site__name", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["site", "name"], name="uniq_rack_site_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


# ─── Device roles + platforms (shared by Device + VirtualMachine) ────────────
class DeviceRole(NumIdMixin, TimestampedModel, CustomFieldsMixin):
    """Functional role of a device or VM (core switch, hypervisor, …). Coloured."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="device_roles"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    color = models.CharField(max_length=7, blank=True, default="")
    has_fov = models.BooleanField(
        default=False,
        help_text="Floor-plan tiles typed by this role get camera "
                  "field-of-view controls (e.g. a CCTV role).",
    )
    is_patch_panel = models.BooleanField(
        default=False,
        help_text="Devices with this role are passive patch panels — hidden "
        "in topology by default and kept out of the level tiers.",
    )
    config_template = models.ForeignKey(
        "ExportTemplate", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Default config template for devices with this role.",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_devicerole_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class PlatformGroup(NumIdMixin, TimestampedModel):
    """A grouping of platforms (Windows, Linux, network NOS, …).
    Self-nesting, so OS families can carry sub-families."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="platform_groups"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    parent = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="children",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_platformgroup_tenant_slug"
            )
        ]

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


class Platform(NumIdMixin, TimestampedModel, LifecycleMixin):
    """An OS / software platform (Cisco IOS-XE, Ubuntu 22.04, VMware ESXi)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="platforms"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    group = models.ForeignKey(
        PlatformGroup, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="platforms",
    )
    manufacturer = models.ForeignKey(
        Manufacturer, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="platforms",
    )
    config_template = models.ForeignKey(
        "ExportTemplate", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
        help_text="Default config template for devices on this platform.",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_platform_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class Service(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A network service exposed by a device or VM — a name + protocol + one or
    more ports. Can spawn a monitoring check on its port (the Danbyte twist)."""

    PROTOCOL_CHOICES = [("tcp", "TCP"), ("udp", "UDP")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="services"
    )
    name = models.CharField(max_length=128)
    protocol = models.CharField(
        max_length=4, choices=PROTOCOL_CHOICES, default="tcp"
    )
    ports = models.JSONField(default=list, help_text="List of port numbers.")
    device = models.ForeignKey(
        "Device", on_delete=models.CASCADE, null=True, blank=True,
        related_name="services",
    )
    virtual_machine = models.ForeignKey(
        "VirtualMachine", on_delete=models.CASCADE, null=True, blank=True,
        related_name="services",
    )
    # Optional specific IP the service answers on; defaults to the parent's
    # primary IP for the monitoring hook.
    ip_address = models.ForeignKey(
        "IPAddress", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="services",
    )
    monitored = models.BooleanField(
        default=False,
        help_text="When on, each port is watched by a TCP/UDP check against the "
        "service's target IP (its own IP, else the parent's primary IP). "
        "Reconciled by monitoring.service_checks.sync_service_checks.",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]

    def __str__(self) -> str:
        return f"{self.name} ({self.protocol}/{','.join(map(str, self.ports or []))})"


class ServiceTemplate(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A reusable service definition (e.g. "HTTPS — TCP 443"). Define a
    name + protocol + ports once, then reuse it when creating Services."""

    PROTOCOL_CHOICES = Service.PROTOCOL_CHOICES

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="service_templates"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    protocol = models.CharField(
        max_length=4, choices=PROTOCOL_CHOICES, default="tcp"
    )
    ports = models.JSONField(default=list, help_text="List of port numbers.")
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_servicetemplate_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class DeviceTypeService(_ComponentTemplate):
    """A service template on a device type — like an interface/port template,
    but for a network service. Materialises a ``Service`` onto every new device
    of the type (see ``materialize_device_components``). ``monitor`` carries
    through to the materialised service's ``monitored`` flag so a whole fleet is
    watched from one place. Tenant scope is inherited via ``device_type``."""

    PROTOCOL_CHOICES = Service.PROTOCOL_CHOICES

    device_type = models.ForeignKey(
        DeviceType, on_delete=models.CASCADE, related_name="service_templates"
    )
    protocol = models.CharField(
        max_length=4, choices=PROTOCOL_CHOICES, default="tcp"
    )
    ports = models.JSONField(default=list, help_text="List of port numbers.")
    monitor = models.BooleanField(
        default=False,
        help_text="Materialised services start monitored.",
    )

    class Meta:
        unique_together = ("device_type", "name")
        ordering = ["name"]


# ─── IP ranges (a contiguous span of addresses, VRF-scoped) ──────────────────
class IPRange(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A contiguous range of IP addresses ``start_address``…``end_address``.

    Unlike a Prefix (a CIDR block), a range is an arbitrary inclusive span —
    handy for DHCP pools or carve-outs that don't align to a subnet boundary.
    VRF-scoped like Prefix/IPAddress so the same span can exist per routing
    context. ``role`` reuses the tenant's IPRole catalog.
    """


    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="ip_ranges"
    )
    vrf = models.ForeignKey(
        VRF,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="ip_ranges",
        help_text="Routing context. NULL = Global VRF.",
    )
    prefix = models.ForeignKey(
        Prefix,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="ip_ranges",
        help_text="Optional parent prefix this range carves out of.",
    )
    start_address = models.GenericIPAddressField()
    end_address = models.GenericIPAddressField()
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="ip_ranges",
    )
    role = models.ForeignKey(
        "IPRole",
        on_delete=models.SET_NULL,
        related_name="ip_ranges",
        null=True,
        blank=True,
        help_text="Optional functional role (DHCP pool, NAT, …).",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["start_address"]
        indexes = [
            models.Index(fields=["tenant", "status"]),
            models.Index(fields=["tenant", "vrf"]),
        ]

    def __str__(self) -> str:
        return f"{self.start_address}–{self.end_address}"

    @property
    def _start_ip(self):
        try:
            return ipaddress.ip_address(self.start_address)
        except (ValueError, TypeError):
            return None

    @property
    def _end_ip(self):
        try:
            return ipaddress.ip_address(self.end_address)
        except (ValueError, TypeError):
            return None

    @property
    def family(self):
        ip = self._start_ip
        return ip.version if ip else None

    @property
    def size(self):
        """Inclusive count of addresses in the span, or None if malformed."""
        s, e = self._start_ip, self._end_ip
        if s is None or e is None or s.version != e.version or int(e) < int(s):
            return None
        return int(e) - int(s) + 1


# ─── RIRs + Aggregates (top of the IP-space hierarchy) ───────────────────────
class RIR(NumIdMixin, TimestampedModel):
    """A Regional Internet Registry (or RFC1918/private space). Aggregates
    declare which RIR allocated them. ``is_private`` flags non-globally-routed
    space (RFC1918, ULA, …) so the UI can separate public from private."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="rirs"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    is_private = models.BooleanField(
        default=False,
        help_text="Private / non-globally-routed space (RFC1918, ULA, …).",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_rir_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class Aggregate(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A top-level block of IP space allocated from a RIR. Prefixes live
    *under* aggregates; utilisation rolls up the child prefixes' coverage."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="aggregates"
    )
    prefix = models.CharField(
        max_length=43, help_text="e.g. 10.0.0.0/8 or 2001:db8::/32"
    )
    rir = models.ForeignKey(
        RIR, on_delete=models.PROTECT, related_name="aggregates"
    )
    date_added = models.DateField(null=True, blank=True)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["prefix"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "prefix"], name="uniq_aggregate_tenant_prefix"
            )
        ]
        indexes = [models.Index(fields=["tenant", "rir"])]

    def __str__(self) -> str:
        return self.prefix

    @property
    def network(self):
        try:
            return ipaddress.ip_network(self.prefix, strict=False)
        except (ValueError, TypeError):
            return None

    @property
    def family(self):
        n = self.network
        return n.version if n else None

    @property
    def utilisation_pct(self):
        """Share of the aggregate's space covered by child prefixes (those that
        are subnets of it, same tenant). IPv4 only — IPv6 spaces are too large
        to express as a meaningful percentage."""
        net = self.network
        if net is None or net.version == 6:
            return None
        total = net.num_addresses
        if total == 0:
            return None
        covered = 0
        for p in (
            Prefix.objects.filter(tenant_id=self.tenant_id).only("cidr")
        ):
            pn = p.network
            if pn is None or pn.version != 4:
                continue
            try:
                if pn.subnet_of(net):
                    covered += pn.num_addresses
            except (TypeError, ValueError):
                continue
        return min(100, int(round(100 * covered / total)))


# ─── ASNs (Autonomous System Numbers) ────────────────────────────────────────
class ASN(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """An Autonomous System Number. 32-bit (1…4294967295); can be tied to a RIR
    and associated with one or more sites."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="asns"
    )
    asn = models.PositiveBigIntegerField(help_text="1…4294967295 (32-bit).")
    rir = models.ForeignKey(
        RIR, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="asns",
    )
    sites = models.ManyToManyField(Site, blank=True, related_name="asns")
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["asn"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "asn"], name="uniq_asn_tenant_asn"
            )
        ]

    def __str__(self) -> str:
        return f"AS{self.asn}"


# ─── VLAN groups ─────────────────────────────────────────────────────────────
class VLANGroup(NumIdMixin, TimestampedModel):
    """A named grouping of VLANs that scopes VID uniqueness, optionally bound to
    a site or cluster and constrained to a VID range."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="vlan_groups"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    # Optional scope — a group usually belongs to a site or a cluster.
    site = models.ForeignKey(
        Site, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="vlan_groups",
    )
    cluster = models.ForeignKey(
        "Cluster", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="vlan_groups",
    )
    min_vid = models.PositiveSmallIntegerField(
        default=1, help_text="Lowest VID allowed in this group (1–4094)."
    )
    max_vid = models.PositiveSmallIntegerField(
        default=4094, help_text="Highest VID allowed in this group (1–4094)."
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_vlangroup_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


# ─── FHRP groups (VRRP / HSRP / GLBP / CARP) ─────────────────────────────────
class FHRPGroup(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A First-Hop Redundancy Protocol group — VRRP/HSRP/GLBP/CARP — that shares
    a virtual IP across the interfaces assigned to it."""

    PROTOCOL_CHOICES = [
        ("vrrp2", "VRRPv2"),
        ("vrrp3", "VRRPv3"),
        ("hsrp", "HSRP"),
        ("glbp", "GLBP"),
        ("carp", "CARP"),
    ]
    AUTH_CHOICES = [
        ("", "None"),
        ("plaintext", "Plaintext"),
        ("md5", "MD5"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="fhrp_groups"
    )
    name = models.CharField(max_length=128, blank=True, default="")
    protocol = models.CharField(max_length=8, choices=PROTOCOL_CHOICES)
    group_id = models.PositiveSmallIntegerField(
        help_text="Group / VRID number (0–255 for VRRP/HSRP)."
    )
    auth_type = models.CharField(
        max_length=16, choices=AUTH_CHOICES, blank=True, default=""
    )
    auth_key = models.CharField(max_length=255, blank=True, default="")
    virtual_ip = models.ForeignKey(
        IPAddress,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="fhrp_groups",
        help_text="The shared virtual IP this group answers on.",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["protocol", "group_id"]

    def __str__(self) -> str:
        return f"{self.get_protocol_display()} {self.group_id}"


class FHRPGroupAssignment(TimestampedModel):
    """Binds an FHRP group to a device interface (or VM interface) with a
    priority — the per-member election weight."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    fhrp_group = models.ForeignKey(
        FHRPGroup, on_delete=models.CASCADE, related_name="assignments"
    )
    interface = models.ForeignKey(
        Interface, on_delete=models.CASCADE, null=True, blank=True,
        related_name="fhrp_assignments",
    )
    vm_interface = models.ForeignKey(
        VMInterface, on_delete=models.CASCADE, null=True, blank=True,
        related_name="fhrp_assignments",
    )
    priority = models.PositiveSmallIntegerField(
        default=100, help_text="Election priority (higher wins)."
    )

    class Meta:
        ordering = ["-priority"]
        constraints = [
            models.CheckConstraint(
                name="fhrp_assignment_exactly_one_target",
                check=(
                    models.Q(interface__isnull=False, vm_interface__isnull=True)
                    | models.Q(interface__isnull=True, vm_interface__isnull=False)
                ),
            ),
            models.UniqueConstraint(
                fields=["fhrp_group", "interface"],
                name="uniq_fhrp_group_interface",
            ),
            models.UniqueConstraint(
                fields=["fhrp_group", "vm_interface"],
                name="uniq_fhrp_group_vm_interface",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.fhrp_group} → {self.interface or self.vm_interface}"


# ─── Contacts (people / teams attachable to any object) ──────────────────────
# Object types a contact can be assigned to. Uses the same ``app.model`` label
# convention as journals/changelog so the detail-page panels share one key.
CONTACTABLE_TYPES = {
    "api.site": "Site",
    "api.device": "Device",
    "api.virtualmachine": "Virtual machine",
    "api.cluster": "Cluster",
    "api.rack": "Rack",
    "api.prefix": "Prefix",
    "api.circuit": "Circuit",
    "core.tenant": "Tenant",
}


class ContactGroup(NumIdMixin, TimestampedModel):
    """An organisational grouping of contacts (a team, a department, …).
    Self-nesting, so NetBox contact-group trees import losslessly."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="contact_groups"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    parent = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="children",
    )
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_contactgroup_tenant_slug"
            )
        ]

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


class ContactRole(NumIdMixin, TimestampedModel):
    """The capacity a contact acts in for an assignment (technical, billing …)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="contact_roles"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    description = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_contactrole_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class Contact(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A person or team. Attached to objects via ContactAssignment."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="contacts"
    )
    group = models.ForeignKey(
        ContactGroup, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="contacts",
    )
    name = models.CharField(max_length=128)
    title = models.CharField(max_length=128, blank=True, default="")
    phone = models.CharField(max_length=64, blank=True, default="")
    email = models.EmailField(blank=True, default="")
    address = models.TextField(blank=True, default="")
    link = models.URLField(blank=True, default="")
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_contact_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class ContactAssignment(NumIdMixin, TimestampedModel):
    """Binds a contact to any object (by ``object_type`` label + ``object_id``),
    in a role, at a priority. Mirrors the journal/changelog generic-ref shape."""

    PRIORITY_CHOICES = [
        ("primary", "Primary"),
        ("secondary", "Secondary"),
        ("tertiary", "Tertiary"),
        ("inactive", "Inactive"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="contact_assignments"
    )
    contact = models.ForeignKey(
        Contact, on_delete=models.CASCADE, related_name="assignments"
    )
    role = models.ForeignKey(
        ContactRole, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="assignments",
    )
    object_type = models.CharField(
        max_length=64, help_text="e.g. api.device, api.site, core.tenant."
    )
    object_id = models.CharField(max_length=64)
    priority = models.CharField(
        max_length=16, choices=PRIORITY_CHOICES, default="primary"
    )

    class Meta:
        ordering = ["priority", "contact__name"]
        constraints = [
            models.UniqueConstraint(
                fields=["object_type", "object_id", "contact", "role"],
                name="uniq_contact_assignment",
            )
        ]
        indexes = [models.Index(fields=["object_type", "object_id"])]

    def __str__(self) -> str:
        return f"{self.contact} ({self.priority}) → {self.object_type} {self.object_id}"


# ─── Circuits ────────────────────────────────────────────────────────────────
class Provider(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A telecommunications/transit provider that supplies circuits (an ISP,
    transit provider, dark-fibre vendor, …)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="providers"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    account = models.CharField(
        max_length=64, blank=True, default="",
        help_text="Account number with this provider.",
    )
    portal_url = models.URLField(blank=True, default="")
    noc_email = models.EmailField(blank=True, default="")
    noc_phone = models.CharField(max_length=64, blank=True, default="")
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_provider_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class ProviderNetwork(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """The far side of a circuit that isn't one of your own sites — a
    provider's cloud, an internet exchange fabric, another carrier's network.
    Exists so a CircuitTermination has something to point at when the Z end
    isn't a Site."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="provider_networks"
    )
    provider = models.ForeignKey(
        Provider, on_delete=models.PROTECT, related_name="networks"
    )
    name = models.CharField(max_length=128)
    service_id = models.CharField(
        max_length=128, blank=True, default="",
        help_text="The provider's identifier for this network/service.",
    )
    description = models.CharField(max_length=255, blank=True, default="")
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "provider", "name"],
                name="uniq_providernetwork_tenant_provider_name",
            )
        ]

    def __str__(self) -> str:
        return self.name


class CircuitType(NumIdMixin, TimestampedModel):
    """A user-defined classification for circuits (Internet, Transit, MPLS,
    Dark Fibre, …). Zero pre-filled data — operators create their own."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="circuit_types"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    color = models.CharField(max_length=7, blank=True, default="")
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_circuittype_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class Circuit(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A data circuit leased from a provider, optionally terminated at sites on
    its A and Z ends."""


    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="circuits"
    )
    cid = models.CharField(max_length=128, help_text="Circuit ID from the provider.")
    provider = models.ForeignKey(
        Provider, on_delete=models.PROTECT, related_name="circuits"
    )
    type = models.ForeignKey(
        CircuitType, on_delete=models.PROTECT, null=True, blank=True,
        related_name="circuits",
    )
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="circuits",
    )
    install_date = models.DateField(null=True, blank=True)
    termination_date = models.DateField(null=True, blank=True)
    commit_rate_kbps = models.PositiveIntegerField(
        null=True, blank=True, help_text="Committed information rate, in kbps."
    )
    # A/Z endpoints live in CircuitTermination rows (circuit.terminations) —
    # each end carries its own speeds / xconnect / patch-panel info and can
    # land on a Site or a ProviderNetwork.
    description = models.CharField(max_length=255, blank=True, default="")
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["cid"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "provider", "cid"],
                name="uniq_circuit_tenant_provider_cid",
            )
        ]

    def __str__(self) -> str:
        return self.cid


class CircuitTermination(TimestampedModel):
    """One end (A or Z) of a circuit. Lands on **either** one of your sites or
    a provider network (exactly one), and carries the per-side physical
    details — speeds, cross-connect ID, patch-panel info. Tenant scope is
    inherited via circuit."""

    SIDE_CHOICES = [("A", "A"), ("Z", "Z")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    circuit = models.ForeignKey(
        Circuit, on_delete=models.CASCADE, related_name="terminations"
    )
    term_side = models.CharField(max_length=1, choices=SIDE_CHOICES)
    site = models.ForeignKey(
        Site, on_delete=models.PROTECT, null=True, blank=True,
        related_name="circuit_terminations",
    )
    provider_network = models.ForeignKey(
        ProviderNetwork, on_delete=models.PROTECT, null=True, blank=True,
        related_name="circuit_terminations",
    )
    port_speed_kbps = models.PositiveIntegerField(
        null=True, blank=True, help_text="Physical port speed, in kbps."
    )
    upstream_speed_kbps = models.PositiveIntegerField(
        null=True, blank=True,
        help_text="Upstream speed if asymmetric (e.g. DOCSIS/DSL), in kbps.",
    )
    xconnect_id = models.CharField(
        max_length=128, blank=True, default="",
        help_text="Cross-connect ID at the facility.",
    )
    pp_info = models.CharField(
        max_length=128, blank=True, default="",
        help_text="Patch-panel / port assignment details.",
    )
    description = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        ordering = ["term_side"]
        constraints = [
            models.UniqueConstraint(
                fields=["circuit", "term_side"],
                name="uniq_circuittermination_circuit_side",
            ),
            models.CheckConstraint(
                name="circuittermination_exactly_one_endpoint",
                check=(
                    models.Q(site__isnull=False, provider_network__isnull=True)
                    | models.Q(site__isnull=True, provider_network__isnull=False)
                ),
            ),
        ]

    @property
    def endpoint(self):
        return self.site or self.provider_network

    def __str__(self) -> str:
        return f"{self.circuit.cid}/{self.term_side}: {self.endpoint}"


# ─── Power ───────────────────────────────────────────────────────────────────
class PowerPanel(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """An electrical distribution panel within a site — the source that power
    feeds draw from."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="power_panels"
    )
    site = models.ForeignKey(
        Site, on_delete=models.PROTECT, related_name="power_panels"
    )
    name = models.CharField(max_length=128)
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "site", "name"],
                name="uniq_powerpanel_tenant_site_name",
            )
        ]

    def __str__(self) -> str:
        return self.name


class PowerFeed(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A power feed from a panel, optionally delivered to a rack — carries the
    electrical characteristics and a utilisation ceiling."""

    TYPE_CHOICES = [("primary", "Primary"), ("redundant", "Redundant")]
    SUPPLY_CHOICES = [("ac", "AC"), ("dc", "DC")]
    PHASE_CHOICES = [("single", "Single phase"), ("three", "Three phase")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="power_feeds"
    )
    power_panel = models.ForeignKey(
        PowerPanel, on_delete=models.PROTECT, related_name="power_feeds"
    )
    rack = models.ForeignKey(
        Rack, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="power_feeds",
    )
    name = models.CharField(max_length=128)
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="power_feeds",
    )
    type = models.CharField(max_length=16, choices=TYPE_CHOICES, default="primary")
    supply = models.CharField(max_length=4, choices=SUPPLY_CHOICES, default="ac")
    phase = models.CharField(
        max_length=8, choices=PHASE_CHOICES, default="single"
    )
    voltage = models.IntegerField(null=True, blank=True, help_text="Volts.")
    amperage = models.PositiveIntegerField(null=True, blank=True, help_text="Amps.")
    max_utilization = models.PositiveSmallIntegerField(
        default=80, help_text="Maximum draw before over-utilised, as a percent."
    )
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "power_panel", "name"],
                name="uniq_powerfeed_tenant_panel_name",
            )
        ]

    def __str__(self) -> str:
        return self.name


# ─── Wireless ────────────────────────────────────────────────────────────────
class WirelessLANGroup(NumIdMixin, TimestampedModel):
    """An organisational grouping of wireless LANs (a campus, a tenant-zone…).
    Zero pre-filled data — operators create their own."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="wireless_lan_groups"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_wlangroup_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class WirelessLAN(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A wireless network (SSID), optionally grouped and bridged to a VLAN."""

    AUTH_TYPE_CHOICES = [
        ("open", "Open"),
        ("wep", "WEP"),
        ("wpa-personal", "WPA Personal (PSK)"),
        ("wpa-enterprise", "WPA Enterprise"),
    ]
    AUTH_CIPHER_CHOICES = [
        ("auto", "Auto"),
        ("tkip", "TKIP"),
        ("aes", "AES"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="wireless_lans"
    )
    ssid = models.CharField(max_length=64)
    group = models.ForeignKey(
        WirelessLANGroup, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="wireless_lans",
    )
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="wireless_lans",
    )
    vlan = models.ForeignKey(
        VLAN, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="wireless_lans",
    )
    auth_type = models.CharField(
        max_length=16, choices=AUTH_TYPE_CHOICES, blank=True, default=""
    )
    auth_cipher = models.CharField(
        max_length=8, choices=AUTH_CIPHER_CHOICES, blank=True, default=""
    )
    description = models.CharField(max_length=255, blank=True, default="")
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["ssid"]

    def __str__(self) -> str:
        return self.ssid


# ─── VPN ─────────────────────────────────────────────────────────────────────
class TunnelGroup(NumIdMixin, TimestampedModel):
    """An organisational grouping of VPN tunnels. Zero pre-filled data."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="tunnel_groups"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_tunnelgroup_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class IPSecProfile(NumIdMixin, TimestampedModel):
    """A reusable IKE/IPSec crypto profile that tunnels reference — flattens the
    common IKE + IPSec policy parameters into one named record."""

    IKE_VERSION_CHOICES = [(1, "IKEv1"), (2, "IKEv2")]
    ENCRYPTION_CHOICES = [
        ("aes-128-cbc", "AES-128-CBC"),
        ("aes-192-cbc", "AES-192-CBC"),
        ("aes-256-cbc", "AES-256-CBC"),
        ("aes-128-gcm", "AES-128-GCM"),
        ("aes-256-gcm", "AES-256-GCM"),
        ("3des-cbc", "3DES-CBC"),
    ]
    AUTH_CHOICES = [
        ("hmac-sha1", "HMAC-SHA1"),
        ("hmac-sha256", "HMAC-SHA256"),
        ("hmac-sha384", "HMAC-SHA384"),
        ("hmac-sha512", "HMAC-SHA512"),
        ("hmac-md5", "HMAC-MD5"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="ipsec_profiles"
    )
    name = models.CharField(max_length=128)
    ike_version = models.PositiveSmallIntegerField(
        choices=IKE_VERSION_CHOICES, default=2
    )
    encryption = models.CharField(
        max_length=16, choices=ENCRYPTION_CHOICES, default="aes-256-cbc"
    )
    authentication = models.CharField(
        max_length=16, choices=AUTH_CHOICES, default="hmac-sha256"
    )
    dh_group = models.PositiveSmallIntegerField(
        default=14, help_text="Diffie-Hellman group number (e.g. 14, 19, 20)."
    )
    pfs_group = models.PositiveSmallIntegerField(
        null=True, blank=True,
        help_text="Perfect-forward-secrecy DH group; blank to disable.",
    )
    sa_lifetime = models.PositiveIntegerField(
        null=True, blank=True, help_text="Security-association lifetime, seconds."
    )
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_ipsecprofile_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class Tunnel(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """A VPN tunnel, optionally grouped and secured by an IPSec profile."""

    ENCAP_CHOICES = [
        ("ipsec-tunnel", "IPSec — Tunnel"),
        ("ipsec-transport", "IPSec — Transport"),
        ("gre", "GRE"),
        ("ip-ip", "IP-in-IP"),
        ("wireguard", "WireGuard"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="tunnels"
    )
    name = models.CharField(max_length=128)
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="tunnels",
    )
    encapsulation = models.CharField(
        max_length=20, choices=ENCAP_CHOICES, default="ipsec-tunnel"
    )
    tunnel_id = models.PositiveIntegerField(null=True, blank=True)
    group = models.ForeignKey(
        TunnelGroup, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="tunnels",
    )
    ipsec_profile = models.ForeignKey(
        IPSecProfile, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="tunnels",
    )
    description = models.CharField(max_length=255, blank=True, default="")
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_tunnel_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


class TunnelTermination(TimestampedModel):
    """One end of a tunnel, bound to a device interface **or** a VM interface
    (exactly one — same explicit-FK pattern as CableTermination). ``role``
    says what this end is in the topology; ``outside_ip`` is the underlay /
    public address the tunnel rides on. The tunnel's *inside* IPs attach to
    the terminating interface normally. Tenant scope inherited via tunnel."""

    ROLE_CHOICES = [("peer", "Peer"), ("hub", "Hub"), ("spoke", "Spoke")]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tunnel = models.ForeignKey(
        Tunnel, on_delete=models.CASCADE, related_name="terminations"
    )
    role = models.CharField(max_length=8, choices=ROLE_CHOICES, default="peer")
    interface = models.ForeignKey(
        Interface, on_delete=models.CASCADE, null=True, blank=True,
        related_name="tunnel_terminations",
    )
    vm_interface = models.ForeignKey(
        VMInterface, on_delete=models.CASCADE, null=True, blank=True,
        related_name="tunnel_terminations",
    )
    outside_ip = models.ForeignKey(
        IPAddress, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="tunnel_terminations",
        help_text="The underlay / public IP this tunnel end rides on.",
    )

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.CheckConstraint(
                name="tunneltermination_exactly_one_interface",
                check=(
                    models.Q(interface__isnull=False, vm_interface__isnull=True)
                    | models.Q(interface__isnull=True, vm_interface__isnull=False)
                ),
            ),
        ]

    @property
    def point(self):
        return self.interface or self.vm_interface

    def __str__(self) -> str:
        return f"{self.tunnel.name}: {self.point}"


class L2VPN(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """An L2 overlay service (EVPN / VXLAN / VPWS / VPLS …) riding the
    network. Carries the overlay identifier (VNI / VC-ID) and BGP import /
    export route targets; terminations attach it to VLANs and interfaces."""

    TYPE_CHOICES = [
        ("vxlan", "VXLAN"),
        ("vxlan-evpn", "VXLAN-EVPN"),
        ("mpls-evpn", "MPLS-EVPN"),
        ("pbb-evpn", "PBB-EVPN"),
        ("vpws", "VPWS"),
        ("vpls", "VPLS"),
        ("epl", "EPL"),
        ("evpl", "EVPL"),
        ("spb", "SPB"),
        ("trill", "TRILL"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="l2vpns"
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    type = models.CharField(max_length=16, choices=TYPE_CHOICES)
    identifier = models.BigIntegerField(
        null=True, blank=True, help_text="Overlay identifier — VNI / VC-ID."
    )
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="l2vpns",
    )
    import_targets = models.ManyToManyField(
        RouteTarget, blank=True, related_name="importing_l2vpns"
    )
    export_targets = models.ManyToManyField(
        RouteTarget, blank=True, related_name="exporting_l2vpns"
    )
    description = models.CharField(max_length=255, blank=True, default="")
    comments = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        verbose_name = "L2VPN"
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_l2vpn_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class L2VPNTermination(TimestampedModel):
    """Attaches an L2VPN to the thing carrying its traffic — a VLAN, a device
    interface, or a VM interface. Exactly one endpoint per termination; an
    endpoint terminates at most one L2VPN. Tenant scope inherited via the
    l2vpn."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    l2vpn = models.ForeignKey(
        L2VPN, on_delete=models.CASCADE, related_name="terminations"
    )
    vlan = models.ForeignKey(
        VLAN, on_delete=models.CASCADE, null=True, blank=True,
        related_name="l2vpn_terminations",
    )
    interface = models.ForeignKey(
        Interface, on_delete=models.CASCADE, null=True, blank=True,
        related_name="l2vpn_terminations",
    )
    vm_interface = models.ForeignKey(
        VMInterface, on_delete=models.CASCADE, null=True, blank=True,
        related_name="l2vpn_terminations",
    )

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                name="l2vpntermination_exactly_one_endpoint",
                check=(
                    models.Q(vlan__isnull=False, interface__isnull=True, vm_interface__isnull=True)
                    | models.Q(vlan__isnull=True, interface__isnull=False, vm_interface__isnull=True)
                    | models.Q(vlan__isnull=True, interface__isnull=True, vm_interface__isnull=False)
                ),
            ),
            models.UniqueConstraint(
                fields=["vlan"], condition=models.Q(vlan__isnull=False),
                name="uniq_l2vpntermination_vlan",
            ),
            models.UniqueConstraint(
                fields=["interface"], condition=models.Q(interface__isnull=False),
                name="uniq_l2vpntermination_interface",
            ),
            models.UniqueConstraint(
                fields=["vm_interface"],
                condition=models.Q(vm_interface__isnull=False),
                name="uniq_l2vpntermination_vm_interface",
            ),
        ]

    @property
    def endpoint(self):
        return self.vlan or self.interface or self.vm_interface

    def __str__(self) -> str:
        return f"{self.l2vpn}: {self.endpoint}"


# ─── Regions & Locations (org-tree nesting) ──────────────────────────────────
class Region(NumIdMixin, TimestampedModel):
    """A geographic/organisational region — a self-nesting tree above sites
    (e.g. Europe → Netherlands → Amsterdam). Zero pre-filled data."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="regions"
    )
    parent = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="children",
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_region_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name

    def clean(self):
        # Guard against parent cycles.
        from django.core.exceptions import ValidationError

        node = self.parent
        while node is not None:
            if node.pk == self.pk:
                raise ValidationError({"parent": "A region can't be its own ancestor."})
            node = node.parent


class Location(NumIdMixin, TimestampedModel):
    """A physical location *within a site* — a self-nesting tree (e.g.
    Building A → Floor 2 → Room 210). Racks/devices can hang off these."""


    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="locations"
    )
    site = models.ForeignKey(
        Site, on_delete=models.CASCADE, related_name="locations"
    )
    parent = models.ForeignKey(
        "self", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="children",
    )
    name = models.CharField(max_length=128)
    slug = models.SlugField(max_length=128)
    status = models.ForeignKey(
        "Status", on_delete=models.PROTECT, null=True, blank=True,
        related_name="locations",
    )
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["site__name", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "site", "slug"],
                name="uniq_location_tenant_site_slug",
            )
        ]

    def __str__(self) -> str:
        return self.name

    def clean(self):
        from django.core.exceptions import ValidationError

        if self.parent and self.parent.site_id != self.site_id:
            raise ValidationError(
                {"parent": "Parent location must be in the same site."}
            )
        node = self.parent
        while node is not None:
            if node.pk == self.pk:
                raise ValidationError(
                    {"parent": "A location can't be its own ancestor."}
                )
            node = node.parent


# ─── Config Contexts (layered JSON merged onto devices/VMs) ──────────────────
class ConfigContext(NumIdMixin, TimestampedModel):
    """A named blob of JSON data that is merged onto devices/VMs whose
    attributes match this context's criteria. Higher ``weight`` wins on
    conflicting keys. Empty criteria for a dimension = matches everything."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="config_contexts"
    )
    name = models.CharField(max_length=128)
    weight = models.PositiveIntegerField(
        default=1000, help_text="Merge order — higher weight wins on conflicts."
    )
    is_active = models.BooleanField(default=True)
    description = models.TextField(blank=True, default="")
    data = models.JSONField(default=dict, blank=True)

    # Assignment criteria (AND across dimensions, OR within one).
    regions = models.ManyToManyField(
        "Region", blank=True, related_name="config_contexts"
    )
    sites = models.ManyToManyField(
        Site, blank=True, related_name="config_contexts"
    )
    device_roles = models.ManyToManyField(
        "DeviceRole", blank=True, related_name="config_contexts"
    )
    platforms = models.ManyToManyField(
        "Platform", blank=True, related_name="config_contexts"
    )

    class Meta:
        ordering = ["weight", "name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_configcontext_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


# ─── Export templates (user-defined rendered exports) ────────────────────────
class ExportTemplate(NumIdMixin, TimestampedModel):
    """A Jinja2 template that renders all objects of one type to a text file
    (CSV, device config, a report, …). Rendered in a sandbox."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="export_templates"
    )
    name = models.CharField(max_length=128)
    object_type = models.CharField(
        max_length=64,
        help_text="Object-type slug this renders (see the RBAC registry).",
    )
    description = models.TextField(blank=True, default="")
    template_code = models.TextField(
        help_text="Jinja2 source. Context: `objects` (and `queryset`) — the "
                  "objects of this type in the active tenant.",
    )
    mime_type = models.CharField(max_length=64, blank=True, default="text/plain")
    file_extension = models.CharField(max_length=16, blank=True, default="txt")
    as_attachment = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "name"], name="uniq_exporttemplate_tenant_name"
            )
        ]

    def __str__(self) -> str:
        return self.name


def resolve_config_template(device):
    """The config template that renders this device's intended config —
    device's own, else its role's, else its platform's (NetBox's resolution
    order). None when nothing is bound anywhere."""
    if device.config_template_id:
        return device.config_template
    if device.role_id and device.role.config_template_id:
        return device.role.config_template
    if device.platform_id and device.platform.config_template_id:
        return device.platform.config_template
    return None


class FloorTileType(NumIdMixin, TimestampedModel):
    """A user-created floor-plan tile kind ("Rack", "Wall", "Cooling"…).

    The whole tile vocabulary is tenant data — there are no built-in kinds
    (zero-pre-filled-data). Behaviour never keys off the type; it derives
    from what a tile *links to*, so these stay purely visual/semantic."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="floor_tile_types"
    )
    name = models.CharField(max_length=64)
    slug = models.SlugField(max_length=64)
    color = models.CharField(max_length=7, blank=True, default="")
    icon = models.CharField(
        max_length=48,
        blank=True,
        default="",
        help_text="Lucide icon name (e.g. server, door-closed, wind, cctv).",
    )
    default_width = models.PositiveSmallIntegerField(
        default=1, validators=[MinValueValidator(1), MaxValueValidator(512)]
    )
    default_height = models.PositiveSmallIntegerField(
        default=1, validators=[MinValueValidator(1), MaxValueValidator(512)]
    )
    is_zone = models.BooleanField(
        default=False,
        help_text="Zone tiles paint the grid background (hot/cold aisles, "
                  "security areas) — they render under normal tiles and other "
                  "tiles may sit on top of them.",
    )
    has_fov = models.BooleanField(
        default=False,
        help_text="Tiles of this type get camera field-of-view controls "
                  "(direction / angle / distance cone).",
    )
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "slug"], name="uniq_floortiletype_tenant_slug"
            )
        ]

    def __str__(self) -> str:
        return self.name


class FloorPlan(NumIdMixin, TimestampedModel, CustomFieldsMixin, TaggableMixin):
    """The physical layout of a Location (a room/floor): a grid of placed
    tiles, optionally over an uploaded blueprint image."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="floor_plans"
    )
    location = models.ForeignKey(
        Location, on_delete=models.CASCADE, related_name="floor_plans"
    )
    name = models.CharField(max_length=128)
    grid_width = models.PositiveSmallIntegerField(
        default=24, validators=[MinValueValidator(1), MaxValueValidator(512)]
    )
    grid_height = models.PositiveSmallIntegerField(
        default=16, validators=[MinValueValidator(1), MaxValueValidator(512)]
    )
    background_image = models.ImageField(
        upload_to="floor-plans/",
        blank=True,
        null=True,
        help_text="Blueprint/photo scaled under the grid.",
    )
    background_opacity = models.PositiveSmallIntegerField(
        default=60, validators=[MaxValueValidator(100)], help_text="Percent."
    )
    # View prefs (default zoom/pan, overlay mode, grid on/off) — free schema,
    # same trick as TopologyView.state, so it evolves without migrations.
    state = models.JSONField(default=dict, blank=True)
    description = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["tenant", "location", "name"],
                name="uniq_floorplan_tenant_location_name",
            )
        ]

    def __str__(self) -> str:
        return self.name


class FloorPlanTile(TimestampedModel):
    """One tile placed on a floor plan's grid.

    No ``NumIdMixin``: tiles carry no tenant FK (they scope through their
    plan), so a per-tenant numid could never be assigned — and canvas cells
    aren't objects an operator refers to by number anyway.

    Its *type* (colour + icon) is exactly one of: a user-created
    FloorTileType, or a DeviceRole (roles double as tile types, reusing
    their colour). Its *behaviour* comes from its optional link — a tile
    linked to a rack gets the rack overlays whatever its type is called."""

    STATUS_CHOICES = [
        ("active", "Active"),
        ("planned", "Planned"),
        ("reserved", "Reserved"),
        ("decommissioning", "Decommissioning"),
    ]
    ORIENTATION_CHOICES = [(0, "0°"), (90, "90°"), (180, "180°"), (270, "270°")]
    # link_kind → FK field name; exactly the reference-kind approach the
    # topology map + CableSerializer use.
    LINK_FIELDS = {
        "rack": "rack",
        "device": "device",
        "powerpanel": "power_panel",
        "powerfeed": "power_feed",
        "floorplan": "linked_floor_plan",
    }

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    floor_plan = models.ForeignKey(
        FloorPlan, on_delete=models.CASCADE, related_name="tiles"
    )
    x = models.PositiveSmallIntegerField()
    y = models.PositiveSmallIntegerField()
    width = models.PositiveSmallIntegerField(
        default=1, validators=[MinValueValidator(1), MaxValueValidator(512)]
    )
    height = models.PositiveSmallIntegerField(
        default=1, validators=[MinValueValidator(1), MaxValueValidator(512)]
    )
    tile_type = models.ForeignKey(
        FloorTileType,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="tiles",
    )
    role_type = models.ForeignKey(
        DeviceRole,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="floor_tiles",
    )
    orientation = models.PositiveSmallIntegerField(
        choices=ORIENTATION_CHOICES, default=0
    )
    label = models.CharField(max_length=64, blank=True, default="")
    color = models.CharField(max_length=7, blank=True, default="")
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, blank=True, default=""
    )
    link_kind = models.CharField(max_length=16, blank=True, default="")
    rack = models.ForeignKey(
        Rack,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="floor_tiles",
    )
    device = models.ForeignKey(
        Device,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="floor_tiles",
    )
    power_panel = models.ForeignKey(
        PowerPanel,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="floor_tiles",
    )
    power_feed = models.ForeignKey(
        PowerFeed,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="floor_tiles",
    )
    linked_floor_plan = models.ForeignKey(
        FloorPlan,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="linked_from_tiles",
        help_text="Nested plan: clicking this tile navigates into it.",
    )
    # Camera field-of-view cone; any tile may carry these.
    FOV_ANCHOR_CHOICES = [
        ("", "Center"),
        ("tl", "Top left"),
        ("tr", "Top right"),
        ("bl", "Bottom left"),
        ("br", "Bottom right"),
    ]
    fov_deg = models.PositiveSmallIntegerField(null=True, blank=True)
    fov_distance = models.PositiveSmallIntegerField(null=True, blank=True)
    fov_direction = models.PositiveSmallIntegerField(null=True, blank=True)
    fov_anchor = models.CharField(
        max_length=2,
        blank=True,
        default="",
        choices=FOV_ANCHOR_CHOICES,
        help_text="Where on the tile the cone emits from ('' = center).",
    )
    fov_ptz = models.BooleanField(
        default=False,
        help_text="Pan-tilt-zoom: coverage renders as a full 360° ring "
                  "(radius = reach) instead of a fixed cone.",
    )

    class Meta:
        ordering = ["y", "x"]
        indexes = [models.Index(fields=["floor_plan"])]
        constraints = [
            models.CheckConstraint(
                name="floorplantile_exactly_one_type",
                # Exactly one of tile_type / role_type.
                check=(
                    models.Q(tile_type__isnull=False, role_type__isnull=True)
                    | models.Q(tile_type__isnull=True, role_type__isnull=False)
                ),
            ),
            models.CheckConstraint(
                name="floorplantile_at_most_one_link",
                # At most one link FK set: all null, or one Q arm per field
                # requiring that field non-null and every other field null.
                check=models.Q(
                    models.Q(
                        **{
                            f"{f}__isnull": True
                            for f in [
                                "rack",
                                "device",
                                "power_panel",
                                "power_feed",
                                "linked_floor_plan",
                            ]
                        }
                    ),
                    *[
                        models.Q(
                            **{
                                f"{set_field}__isnull": False,
                                **{
                                    f"{other}__isnull": True
                                    for other in [
                                        "rack",
                                        "device",
                                        "power_panel",
                                        "power_feed",
                                        "linked_floor_plan",
                                    ]
                                    if other != set_field
                                },
                            }
                        )
                        for set_field in [
                            "rack",
                            "device",
                            "power_panel",
                            "power_feed",
                            "linked_floor_plan",
                        ]
                    ],
                    _connector=models.Q.OR,
                ),
            ),
        ]

    @property
    def linked_object(self):
        for field in self.LINK_FIELDS.values():
            obj = getattr(self, field)
            if obj is not None:
                return obj
        return None

    def __str__(self) -> str:
        return self.label or f"tile @ ({self.x},{self.y})"


class SiteMarker(TimestampedModel):
    """A free-standing marker on the geographic Site map — the world-map
    analog of an unlinked floor-plan tile. Its type is exactly one of a
    user-created FloorTileType or a DeviceRole (reusing their color/icon),
    so the marker vocabulary stays tenant data (zero pre-filled). Camera-ish
    types (``has_fov``) get a geographic coverage cone."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="site_markers"
    )
    latitude = models.DecimalField(max_digits=9, decimal_places=6)
    longitude = models.DecimalField(max_digits=9, decimal_places=6)
    tile_type = models.ForeignKey(
        FloorTileType,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="site_markers",
    )
    role_type = models.ForeignKey(
        DeviceRole,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="site_markers",
    )
    # Optional link to a real device — a free marker can stand in for a
    # camera/AP that isn't itself placed, and the popover then offers a
    # jump-off to it.
    device = models.ForeignKey(
        "Device",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="site_markers",
    )
    label = models.CharField(max_length=64, blank=True, default="")
    description = models.CharField(max_length=255, blank=True, default="")
    # Same geographic cone as Device (meters).
    fov_direction = models.PositiveSmallIntegerField(null=True, blank=True)
    fov_deg = models.PositiveSmallIntegerField(null=True, blank=True)
    fov_distance_m = models.PositiveIntegerField(null=True, blank=True)
    fov_ptz = models.BooleanField(default=False)

    class Meta:
        ordering = ["label"]
        constraints = [
            models.CheckConstraint(
                name="sitemarker_exactly_one_type",
                check=(
                    models.Q(tile_type__isnull=False, role_type__isnull=True)
                    | models.Q(tile_type__isnull=True, role_type__isnull=False)
                ),
            ),
        ]

    @property
    def type_obj(self):
        return self.tile_type or self.role_type

    def __str__(self) -> str:
        return self.label or f"marker @ ({self.latitude},{self.longitude})"


class FloorPlanTray(TimestampedModel):
    """A cable tray / conduit run drawn on a floor plan: a named polyline of
    grid points that physical cables are assigned to follow. This is the
    buildable wiring layer — the thing you print and hand to contractors.

    Routing is manual in v1 (a cable belongs to the trays it runs through);
    auto-routing along the tray graph is a later phase."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    floor_plan = models.ForeignKey(
        FloorPlan, on_delete=models.CASCADE, related_name="trays"
    )
    name = models.CharField(max_length=64)
    # Free text on purpose (zero-pre-filled-data): "tray", "conduit",
    # "ladder", "underfloor"… whatever the shop calls it.
    kind = models.CharField(max_length=32, blank=True, default="")
    color = models.CharField(max_length=7, blank=True, default="")
    # [[x, y], …] in cell-corner coordinates (integers along grid lines).
    points = models.JSONField(default=list)
    description = models.TextField(blank=True, default="")
    cables = models.ManyToManyField(
        Cable, blank=True, related_name="trays",
        help_text="The physical cables routed through this tray.",
    )

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["floor_plan"])]

    def __str__(self) -> str:
        return self.name


class CableRoute(TimestampedModel):
    """A geographic cable run drawn on the site map: a named polyline of
    lat/lng waypoints that physical cables are assigned to follow — ducts,
    aerial spans, direct-bury trenches. The outside-plant sibling of
    FloorPlanTray; routing is manual in v1 (a cable belongs to the routes
    it runs through)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    tenant = models.ForeignKey(
        Tenant, on_delete=models.CASCADE, related_name="cable_routes"
    )
    name = models.CharField(max_length=64)
    # Free text on purpose (zero-pre-filled-data): "duct", "aerial",
    # "direct-bury", "submarine"… whatever the plant records call it.
    kind = models.CharField(max_length=32, blank=True, default="")
    color = models.CharField(max_length=7, blank=True, default="")
    # [[lat, lng], …] decimal degrees, 6 dp.
    waypoints = models.JSONField(default=list)
    description = models.TextField(blank=True, default="")
    cables = models.ManyToManyField(
        Cable, blank=True, related_name="routes",
        help_text="The physical cables routed along this run.",
    )

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["tenant"])]

    def __str__(self) -> str:
        return self.name
